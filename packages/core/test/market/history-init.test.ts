import { describe, expect, it } from 'vitest';

import type { DbAdapter } from '../../src/db/types';
import { EsiClient } from '../../src/esi/client';
import type { HttpClient, HttpGetRequest, HttpResponse } from '../../src/esi/http';
import { RequestScheduler } from '../../src/esi/scheduler';
import {
  HISTORY_BACKFILL_REGION_IDS,
  HISTORY_INIT_WRITE_BATCH_PAIRS,
  HistoryInitializer,
  historyRetentionCutoff,
  isBackfillInterrupted,
  readHistoryBackfillState,
  writeHistoryBackfillState,
  EMPTY_HISTORY_BACKFILL_STATE,
  type HistoryBackfillState,
} from '../../src/market';
import { countRows, createMigratedDb } from '../helpers/db';
import { createFakeClock, type FakeClock } from '../helpers/fake-clock';
import { createMockHttp, jsonResponse, type MockHttp } from '../helpers/mock-http';

/** 5 枢纽里的前两个 */
const HUB_A = HISTORY_BACKFILL_REGION_IDS[0];
const HUB_B = HISTORY_BACKFILL_REGION_IDS[1];
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** 固定基准时间：2026-09-27 02:00 UTC */
const T0 = Date.UTC(2026, 8, 27, 2, 0, 0);

type Db = Awaited<ReturnType<typeof createMigratedDb>>;

const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

async function setup(): Promise<{
  db: Db;
  http: MockHttp;
  clock: FakeClock;
  client: EsiClient;
  scheduler: RequestScheduler;
}> {
  const db = await createMigratedDb();
  const http = createMockHttp();
  const clock = createFakeClock(T0);
  const client = new EsiClient({ http });
  const scheduler = new RequestScheduler({
    clock,
    requestsPerSecond: 1000,
    burst: 1000,
    maxConcurrent: 8,
  });
  return { db, http, clock, client, scheduler };
}

/** 种一条 market_stats（清单筛选只看订单数） */
async function seedStats(db: Db, regionId: number, typeId: number): Promise<void> {
  await db.execute(
    `INSERT INTO market_stats
       (region_id, type_id, best_sell, best_buy, sell_volume, buy_volume,
        sell_orders, buy_orders, spread, p5_sell, p95_buy, updated_at)
     VALUES (?, ?, NULL, NULL, 0, 0, 10, 10, NULL, NULL, NULL, '2026-09-27T01:00:00Z')`,
    [regionId, typeId],
  );
}

/** 插入一行日线历史（可指定 fetched_at） */
async function insertHistory(
  db: Db,
  regionId: number,
  typeId: number,
  date: string,
  fetchedAt = '2026-01-01T00:00:00.000Z',
): Promise<void> {
  await db.execute(
    `INSERT INTO market_history_daily
       (region_id, type_id, date, average, highest, lowest, order_count, volume, fetched_at)
     VALUES (?, ?, ?, 4.2, 5, 3.8, 10, 100, ?)`,
    [regionId, typeId, date, fetchedAt],
  );
}

/** 构造一段日线响应 */
function historyResponse(dates: string[]): HttpResponse {
  return jsonResponse(
    200,
    dates.map((date) => ({
      date,
      average: 4.2,
      highest: 5,
      lowest: 3.8,
      order_count: 10,
      volume: 100,
    })),
  );
}

/** 约 400 天（[T0-399d, T0]）的完整窗口响应 */
function fullWindowResponse(anchor = T0): HttpResponse {
  const dates = Array.from({ length: 400 }, (_, index) => isoDate(anchor - (399 - index) * DAY_MS));
  return historyResponse(dates);
}

function stateOf(overrides: Partial<HistoryBackfillState>): HistoryBackfillState {
  return { ...EMPTY_HISTORY_BACKFILL_STATE, ...overrides };
}

function initOf(input: {
  db: Db;
  client: EsiClient;
  scheduler: RequestScheduler;
  clock: FakeClock;
  concurrency?: number;
  writeBatchPairs?: number;
  isAborted?: () => boolean;
}): HistoryInitializer {
  return new HistoryInitializer({
    db: input.db,
    client: input.client,
    scheduler: input.scheduler,
    clock: input.clock,
    concurrency: input.concurrency ?? 8,
    writeBatchPairs: input.writeBatchPairs ?? HISTORY_INIT_WRITE_BATCH_PAIRS,
    ...(input.isAborted === undefined ? {} : { isAborted: input.isAborted }),
  });
}

/** 包装 db：统计写事务次数，并断言其从不并发（串行写） */
function wrapDb(base: Db): { db: DbAdapter; stats: () => { transactions: number; maxActive: number } } {
  let active = 0;
  let maxActive = 0;
  let transactions = 0;
  const wrapped: DbAdapter = {
    execute: (sql, params) => base.execute(sql, params),
    select: (sql, params) => base.select(sql, params),
    async transaction(work) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      transactions += 1;
      try {
        return await base.transaction(work);
      } finally {
        active -= 1;
      }
    },
  };
  return { db: wrapped, stats: () => ({ transactions, maxActive }) };
}

/** 门控 HTTP：等齐 expected 个在途请求后同时放行（用于确定性验证并发与合批） */
interface GatedHttp extends HttpClient {
  readonly maxInFlight: number;
}

function createGatedHttp(expected: number, response: HttpResponse): GatedHttp {
  const gates: Array<() => void> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  return {
    async get(_request: HttpGetRequest): Promise<HttpResponse> {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => {
        gates.push(resolve);
        if (gates.length === expected) for (const gate of gates.splice(0)) gate();
      });
      inFlight -= 1;
      return response;
    },
    get maxInFlight(): number {
      return maxInFlight;
    },
  };
}

describe('历史全量初始化 HistoryInitializer', () => {
  it('首轮：窗口不足 → 整段 upsert，状态推进到全量成功', async () => {
    const { db, http, clock, client, scheduler } = await setup();
    await seedStats(db, HUB_A, 1);
    await seedStats(db, HUB_A, 2);
    http.enqueue(historyResponse(['2026-09-25', '2026-09-26']));
    http.enqueue(historyResponse(['2026-09-25', '2026-09-26']));

    const init = initOf({ db, clock, client, scheduler });
    const summary = await init.runInit();

    expect(summary.skipped).toBe(false);
    expect(summary.pairsTotal).toBe(2);
    expect(summary.pairsOk).toBe(2);
    expect(summary.pairsSkipped).toBe(0);
    expect(summary.pairsFailed).toBe(0);
    expect(summary.daysWritten).toBe(4);
    expect(http.calls).toHaveLength(2);
    expect(http.calls[0].url).toBe(
      `https://esi.evetech.net/latest/markets/${HUB_A}/history/?type_id=1`,
    );
    expect(await countRows(db, 'market_history_daily')).toBe(4);

    const state = await readHistoryBackfillState(db);
    expect(state.lastFullOkAt).not.toBeNull();
    expect(state.retryDueAt).toBeNull();
    expect(state.lastError).toBeNull();
  });

  it('窗口已满 → 只增量写入新增/当天行，不整段重写', async () => {
    const { db, http, clock, client, scheduler } = await setup();
    await seedStats(db, HUB_A, 1);
    // 本地已有完整窗口（最早日期远早于 cutoff 容差）→ 判为「窗口已满」
    await insertHistory(db, HUB_A, 1, isoDate(T0 - 399 * DAY_MS));
    await insertHistory(db, HUB_A, 1, isoDate(T0 - DAY_MS));
    const before = await countRows(db, 'market_history_daily');

    // 端点返回全窗口，但只有「>= 本地最新日期」的两天是新的
    http.enqueue(
      historyResponse([isoDate(T0 - 2 * DAY_MS), isoDate(T0 - DAY_MS), isoDate(T0)]),
    );

    const init = initOf({ db, clock, client, scheduler, concurrency: 1 });
    const summary = await init.runInit();

    expect(summary.pairsOk).toBe(1);
    expect(summary.daysWritten).toBe(2); // 只有 T0-1d（覆盖）与 T0（新增）
    expect(await countRows(db, 'market_history_daily')).toBe(before + 1);
  });

  it('同日重跑幂等：已补满窗口的 pair 零请求跳过', async () => {
    const { db, http, clock, client, scheduler } = await setup();
    await seedStats(db, HUB_A, 1);
    await seedStats(db, HUB_B, 2);
    http.enqueue(fullWindowResponse());
    http.enqueue(fullWindowResponse());

    const init = initOf({ db, clock, client, scheduler });
    await init.runInit();
    expect(http.calls).toHaveLength(2);

    // 同日再跑（推进时钟使本轮锚点晚于上一轮）：已补满窗口 → 全部跳过、零新增请求
    clock.advance(HOUR_MS);
    const second = await initOf({ db, clock, client, scheduler }).runInit();
    expect(second.pairsSkipped).toBe(2);
    expect(second.pairsOk).toBe(0);
    expect(http.calls).toHaveLength(2);
  });

  it('中断续跑：沿用本轮锚点，本轮已处理的 pair 跳过', async () => {
    const { db, http, clock, client, scheduler } = await setup();
    await seedStats(db, HUB_A, 1);
    await seedStats(db, HUB_A, 2);
    const anchor = new Date(T0 - HOUR_MS).toISOString();
    // 上一轮已处理 pair(1)：其 fetched_at 晚于本轮锚点
    await insertHistory(db, HUB_A, 1, '2026-09-26', new Date(T0 - 30 * 60_000).toISOString());
    await writeHistoryBackfillState(
      db,
      stateOf({ lastStartedAt: anchor, lastFinishedAt: null, pairsTotal: 2, pairsOk: 1, daysWritten: 1 }),
    );

    http.enqueue(fullWindowResponse());
    const summary = await initOf({ db, clock, client, scheduler }).runInit();

    expect(summary.pairsSkipped).toBe(1); // pair(1) 零请求跳过
    expect(summary.pairsOk).toBe(2); // 1（上一轮）+ 1（本轮）
    expect(http.calls).toHaveLength(1);
    const state = await readHistoryBackfillState(db);
    expect(state.lastStartedAt).toBe(anchor); // 锚点保持不变
    expect(isBackfillInterrupted(state)).toBe(false);
  });

  it('续跑耗时只累计活动时间，不含两段之间的空闲间隔', async () => {
    const { db, http, clock, client, scheduler } = await setup();
    await seedStats(db, HUB_A, 1);
    // 上一段在一个较早的锚点被打断，并留下累计耗时 1234ms
    const anchor = new Date(T0 - 5 * HOUR_MS).toISOString();
    await writeHistoryBackfillState(
      db,
      stateOf({ lastStartedAt: anchor, lastFinishedAt: null, pairsTotal: 1, elapsedMs: 1234 }),
    );
    http.enqueue(historyResponse(['2026-09-26']));

    const summary = await initOf({ db, clock, client, scheduler, concurrency: 1 }).runInit();

    // 假时钟不推进 → 本段耗时为 0；总耗时 = 1234 + 0（而不是 now - 5 小时锚点）
    expect(summary.elapsedMs).toBe(1234);
  });

  it('初始化不发条件请求：即便有 ETag 缓存也不带 If-None-Match（避免 304 阻断补满）', async () => {
    const { db, http, clock, client, scheduler } = await setup();
    await seedStats(db, HUB_A, 1);
    await db.execute('INSERT INTO market_etag_cache (scope, etag, updated_at) VALUES (?, ?, ?)', [
      `history:${HUB_A}:1`,
      'W/"cached-etag"',
      new Date(T0).toISOString(),
    ]);
    http.enqueue(historyResponse(['2026-09-26']));

    const summary = await initOf({ db, clock, client, scheduler, concurrency: 1 }).runInit();

    expect(summary.pairsOk).toBe(1);
    expect(http.calls[0].ifNoneMatch).toBeUndefined();
  });

  it('失败隔离：单 pair 失败不阻断其余，并记录错误与重试时刻', async () => {
    const { db, http, clock, client, scheduler } = await setup();
    await seedStats(db, HUB_A, 1);
    await seedStats(db, HUB_A, 2);
    http.enqueue(jsonResponse(404, { error: 'Type not found' }));
    http.enqueue(historyResponse(['2026-09-26']));

    const summary = await initOf({ db, clock, client, scheduler }).runInit();

    expect(summary.pairsFailed).toBe(1);
    expect(summary.pairsOk).toBe(1);
    const state = await readHistoryBackfillState(db);
    expect(state.lastError).toContain('404');
    expect(state.retryDueAt).not.toBeNull();
    expect(state.lastFullOkAt).toBeNull();
  });

  it('取消：停止拉取新 pair 并收尾，可续跑', async () => {
    const { db, http, clock, client, scheduler } = await setup();
    for (let typeId = 1; typeId <= 6; typeId += 1) await seedStats(db, HUB_A, typeId);
    for (let index = 0; index < 6; index += 1) http.enqueue(historyResponse(['2026-09-26']));

    let checks = 0;
    const summary = await initOf({
      db,
      clock,
      client,
      scheduler,
      concurrency: 1,
      // 第 1 次放行，其后视为已取消
      isAborted: () => {
        checks += 1;
        return checks >= 2;
      },
    }).runInit();

    expect(summary.aborted).toBe(true);
    expect(summary.pairsOk).toBe(1);
    expect(http.calls).toHaveLength(1);
    const state = await readHistoryBackfillState(db);
    expect(state.lastFinishedAt).not.toBeNull();
    expect(state.retryDueAt).not.toBeNull(); // 未收尾全量 → 提示可继续
  });

  it('8 路并发拉取 + 写事务严格串行，且合批提交', async () => {
    const { db, clock, scheduler } = await setup();
    const pairs = 8;
    for (let typeId = 1; typeId <= pairs; typeId += 1) await seedStats(db, HUB_A, typeId);

    const http = createGatedHttp(pairs, historyResponse(['2026-09-26']));
    const client = new EsiClient({ http });
    const { db: wrapped, stats } = wrapDb(db);

    const summary = await new HistoryInitializer({
      db: wrapped,
      client,
      scheduler,
      clock,
      concurrency: pairs,
      writeBatchPairs: HISTORY_INIT_WRITE_BATCH_PAIRS,
    }).runInit();

    expect(summary.pairsOk).toBe(pairs);
    // 并发拉取：峰值在途请求 ≥ 2（门控下应为 8）
    expect(http.maxInFlight).toBeGreaterThanOrEqual(2);
    // 写串行：事务从不并发
    expect(stats().maxActive).toBe(1);
    // 合批：事务次数少于 pair 数
    expect(stats().transactions).toBeLessThan(pairs);
  });

  it('轮次裁剪：窗口外的历史遗留被清理', async () => {
    const { db, http, clock, client, scheduler } = await setup();
    await seedStats(db, HUB_A, 1);
    const stale = isoDate(Date.parse(historyRetentionCutoff(T0)) - DAY_MS);
    await insertHistory(db, HUB_A, 1, stale);
    expect(await countRows(db, 'market_history_daily')).toBe(1);

    http.enqueue(historyResponse(['2026-09-26']));
    await initOf({ db, clock, client, scheduler, concurrency: 1 }).runInit();

    const rows = await db.select<{ date: string }>(
      'SELECT date FROM market_history_daily ORDER BY date',
    );
    expect(rows.map((row) => row.date)).toEqual(['2026-09-26']); // 窗口外那行已被裁掉
  });

  it('清单为空：不发起请求并提示同步数据', async () => {
    const { db, http, clock, client, scheduler } = await setup();
    const summary = await initOf({ db, clock, client, scheduler }).runInit();

    expect(summary.skipped).toBe(true);
    expect(summary.skipReason).toContain('初始化清单为空');
    expect(http.calls).toHaveLength(0);
  });
});
