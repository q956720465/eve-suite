import { describe, expect, it } from 'vitest';

import { EsiClient } from '../../src/esi/client';
import { RequestScheduler } from '../../src/esi/scheduler';
import {
  DEFAULT_HISTORY_BACKFILL_TIER,
  EMPTY_HISTORY_BACKFILL_STATE,
  HISTORY_BACKFILL_REGION_IDS,
  HistoryBackfill,
  countBackfillPairs,
  isBackfillDue,
  isBackfillInterrupted,
  listBackfillPairs,
  nextBackfillDueAt,
  parseHistoryBackfillTier,
  readHistoryBackfillState,
  readHistoryBackfillTier,
  writeHistoryBackfillState,
  writeHistoryBackfillTier,
  type HistoryBackfillState,
} from '../../src/market';
import { countRows, createMigratedDb } from '../helpers/db';
import { createFakeClock, type FakeClock } from '../helpers/fake-clock';
import { createMockHttp, jsonResponse, type MockHttp } from '../helpers/mock-http';

/** 5 枢纽里的前两个（伏尔戈 / 多美）与一个非枢纽区 */
const HUB_A = HISTORY_BACKFILL_REGION_IDS[0];
const HUB_B = HISTORY_BACKFILL_REGION_IDS[1];
const NON_HUB = 10000001;

const HOUR_MS = 3_600_000;

type Db = Awaited<ReturnType<typeof createMigratedDb>>;

async function setup(): Promise<{
  db: Db;
  http: MockHttp;
  clock: FakeClock;
  client: EsiClient;
  scheduler: RequestScheduler;
}> {
  const db = await createMigratedDb();
  const http = createMockHttp();
  const clock = createFakeClock();
  const client = new EsiClient({ http });
  const scheduler = new RequestScheduler({ clock, requestsPerSecond: 1000, burst: 1000 });
  return { db, http, clock, client, scheduler };
}

/** 种一条 market_stats（清单筛选只看订单数，其余列留空） */
async function seedStats(
  db: Db,
  regionId: number,
  typeId: number,
  orders: { sell?: number; buy?: number } = {},
): Promise<void> {
  await db.execute(
    `INSERT INTO market_stats
       (region_id, type_id, best_sell, best_buy, sell_volume, buy_volume,
        sell_orders, buy_orders, spread, p5_sell, p95_buy, updated_at)
     VALUES (?, ?, NULL, NULL, 0, 0, ?, ?, NULL, NULL, NULL, '2026-09-27T01:00:00Z')`,
    [regionId, typeId, orders.sell ?? 10, orders.buy ?? 10],
  );
}

/** 一条最小可用的日线历史响应 */
function historyResponse(date = '2026-09-25'): ReturnType<typeof jsonResponse> {
  return jsonResponse(200, [
    { date, average: 4.2, highest: 5, lowest: 3.8, order_count: 100, volume: 1000 },
  ]);
}

function stateOf(overrides: Partial<HistoryBackfillState>): HistoryBackfillState {
  return { ...EMPTY_HISTORY_BACKFILL_STATE, ...overrides };
}

/** 构造预拉器；默认关闭节拍等待（限速单测单独指定 rate） */
function backfillOf(input: {
  db: Db;
  client: EsiClient;
  scheduler: RequestScheduler;
  clock: FakeClock;
  ratePerSecond?: number;
  isPaused?: () => boolean;
}): HistoryBackfill {
  return new HistoryBackfill({
    db: input.db,
    client: input.client,
    scheduler: input.scheduler,
    clock: input.clock,
    ratePerSecond: input.ratePerSecond ?? 0,
    ...(input.isPaused === undefined ? {} : { isPaused: input.isPaused }),
  });
}

describe('预拉清单（5 枢纽 + 订单数门槛）', () => {
  it('只取 5 枢纽，且按「卖单数或买单数达门槛」筛选（OR 口径）', async () => {
    const { db } = await setup();
    await seedStats(db, HUB_A, 1, { sell: 10, buy: 10 }); // 两侧都够 → 含
    await seedStats(db, HUB_A, 2, { sell: 2, buy: 2 }); // 两侧都不够 → 不含
    await seedStats(db, HUB_A, 3, { sell: 10, buy: 1 }); // 仅卖侧够 → 含
    await seedStats(db, HUB_A, 4, { sell: 1, buy: 10 }); // 仅买侧够 → 含
    await seedStats(db, HUB_A, 5, { sell: 5, buy: 5 }); // 恰好等于门槛 → 含
    await seedStats(db, NON_HUB, 1, { sell: 10, buy: 10 }); // 非枢纽 → 不含

    const pairs = await listBackfillPairs(db);

    expect(pairs.map((pair) => pair.typeId)).toEqual([1, 3, 4, 5]);
    expect(pairs.every((pair) => HISTORY_BACKFILL_REGION_IDS.includes(pair.regionId))).toBe(true);
    expect(await countBackfillPairs(db)).toBe(4);
  });

  it('按 (区域, 物品) 固定排序，保证续跑可复现', async () => {
    const { db } = await setup();
    await seedStats(db, HUB_B, 9);
    await seedStats(db, HUB_A, 8);
    await seedStats(db, HUB_A, 7);

    const pairs = await listBackfillPairs(db);

    expect(pairs.map((pair) => `${pair.regionId}:${pair.typeId}`)).toEqual([
      `${HUB_A}:7`,
      `${HUB_A}:8`,
      `${HUB_B}:9`,
    ]);
  });
});

describe('档位与到期判定', () => {
  it('默认档位为 24h；非法值回退默认', async () => {
    const { db } = await setup();
    expect(await readHistoryBackfillTier(db)).toBe(DEFAULT_HISTORY_BACKFILL_TIER);
    expect(parseHistoryBackfillTier('off')).toBe('off');
    expect(parseHistoryBackfillTier('24h')).toBe('24h');
    expect(parseHistoryBackfillTier('3h')).toBe('24h');
    expect(parseHistoryBackfillTier(null)).toBe('24h');
  });

  it('档位写库后可读回', async () => {
    const { db } = await setup();
    await writeHistoryBackfillTier(db, 'off');
    expect(await readHistoryBackfillTier(db)).toBe('off');
    await writeHistoryBackfillTier(db, '24h');
    expect(await readHistoryBackfillTier(db)).toBe('24h');
  });

  it('到期判定：从未预拉 / 24h 内 / 超 24h / 关闭档 / 中断 / 待重试', () => {
    const now = Date.UTC(2026, 8, 28, 2, 0, 0);

    expect(isBackfillDue({ state: EMPTY_HISTORY_BACKFILL_STATE, tier: '24h', now })).toBe(true);

    const fresh = stateOf({ lastFullOkAt: new Date(now - HOUR_MS).toISOString() });
    expect(isBackfillDue({ state: fresh, tier: '24h', now })).toBe(false);

    const stale = stateOf({ lastFullOkAt: new Date(now - 25 * HOUR_MS).toISOString() });
    expect(isBackfillDue({ state: stale, tier: '24h', now })).toBe(true);

    expect(isBackfillDue({ state: EMPTY_HISTORY_BACKFILL_STATE, tier: 'off', now })).toBe(false);

    const interrupted = stateOf({
      lastStartedAt: new Date(now - HOUR_MS).toISOString(),
      lastFinishedAt: null,
    });
    expect(isBackfillInterrupted(interrupted)).toBe(true);
    expect(isBackfillDue({ state: interrupted, tier: '24h', now })).toBe(true);

    const retrying = stateOf({
      lastFullOkAt: new Date(now - HOUR_MS).toISOString(),
      retryDueAt: new Date(now - 60_000).toISOString(),
    });
    expect(isBackfillDue({ state: retrying, tier: '24h', now })).toBe(true);
  });

  it('下次到期时刻：关闭档为 null，从未预拉为 now', () => {
    const now = Date.UTC(2026, 8, 28, 2, 0, 0);
    expect(nextBackfillDueAt({ state: EMPTY_HISTORY_BACKFILL_STATE, tier: 'off', now })).toBeNull();
    expect(nextBackfillDueAt({ state: EMPTY_HISTORY_BACKFILL_STATE, tier: '24h', now })).toBe(now);

    const fresh = stateOf({ lastFullOkAt: new Date(now).toISOString() });
    expect(nextBackfillDueAt({ state: fresh, tier: '24h', now })).toBe(now + 24 * HOUR_MS);
  });
});

describe('枢纽历史预拉 HistoryBackfill', () => {
  it('首轮：按清单逐条拉取并写入，状态推进到全量成功', async () => {
    const { db, http, clock, client, scheduler } = await setup();
    await seedStats(db, HUB_A, 1);
    await seedStats(db, HUB_A, 2);
    http.enqueue(historyResponse());
    http.enqueue(historyResponse());

    const backfill = backfillOf({ db, clock, client, scheduler });
    const summary = await backfill.runScan();

    expect(summary.skipped).toBe(false);
    expect(summary.pairsTotal).toBe(2);
    expect(summary.pairsOk).toBe(2);
    expect(summary.pairsSkipped).toBe(0);
    expect(summary.pairsFailed).toBe(0);
    expect(summary.daysWritten).toBe(2);
    expect(http.calls).toHaveLength(2);
    expect(http.calls[0].url).toBe(
      `https://esi.evetech.net/latest/markets/${HUB_A}/history/?type_id=1`,
    );
    expect(await countRows(db, 'market_history_daily')).toBe(2);

    const state = await readHistoryBackfillState(db);
    expect(state.lastFullOkAt).not.toBeNull();
    expect(state.retryDueAt).toBeNull();
    expect(state.lastError).toBeNull();
    expect(state.pairsOk).toBe(2);
  });

  it('同日二次强制预拉：逐条跳过且零请求（按天幂等）', async () => {
    const { db, http, clock, client, scheduler } = await setup();
    await seedStats(db, HUB_A, 1);
    await seedStats(db, HUB_A, 2);
    http.enqueue(historyResponse());
    http.enqueue(historyResponse());

    const backfill = backfillOf({ db, clock, client, scheduler });
    await backfill.runScan();

    const second = await backfill.runScan({ force: true });

    expect(second.pairsSkipped).toBe(2);
    expect(second.pairsOk).toBe(0);
    expect(http.calls).toHaveLength(2); // 未新增请求
  });

  it('单个 pair 失败不阻断其余，并记录错误与重试时刻', async () => {
    const { db, http, clock, client, scheduler } = await setup();
    await seedStats(db, HUB_A, 1);
    await seedStats(db, HUB_A, 2);
    // 404 → EsiError('client')，不可重试（与 5xx / 429 的「throttled」不同）
    http.enqueue(jsonResponse(404, { error: 'Type not found' }));
    http.enqueue(historyResponse());

    const backfill = backfillOf({ db, clock, client, scheduler });
    const summary = await backfill.runScan();

    expect(summary.pairsFailed).toBe(1);
    expect(summary.pairsOk).toBe(1);

    const state = await readHistoryBackfillState(db);
    expect(state.lastError).toContain('404');
    expect(state.retryDueAt).not.toBeNull();
    expect(state.lastFullOkAt).toBeNull(); // 未全量成功 → 不推进到期锚点
  });

  it('暂停：在处理完当前 pair 后停止，本轮可续跑', async () => {
    const { db, http, clock, client, scheduler } = await setup();
    await seedStats(db, HUB_A, 1);
    await seedStats(db, HUB_A, 2);
    await seedStats(db, HUB_A, 3);
    http.enqueue(historyResponse());
    http.enqueue(historyResponse());
    http.enqueue(historyResponse());

    let checks = 0;
    const backfill = backfillOf({
      db,
      clock,
      client,
      scheduler,
      // 第 1 次（入口）与第 2 次（第 1 个 pair 前）放行，第 3 次起视为已暂停
      isPaused: () => {
        checks += 1;
        return checks >= 3;
      },
    });
    const summary = await backfill.runScan();

    expect(summary.aborted).toBe(true);
    expect(summary.pairsOk).toBe(1);
    expect(http.calls).toHaveLength(1);

    const state = await readHistoryBackfillState(db);
    expect(state.lastFinishedAt).not.toBeNull();
    // 未收尾全量 → 立即到期，恢复后自动续跑
    expect(state.retryDueAt).not.toBeNull();
  });

  it('中断续跑：沿用本轮锚点并累加计数', async () => {
    const { db, http, clock, client, scheduler } = await setup();
    await seedStats(db, HUB_A, 1);
    http.enqueue(historyResponse());

    const anchor = new Date(clock.now() - HOUR_MS).toISOString();
    await writeHistoryBackfillState(
      db,
      stateOf({
        lastStartedAt: anchor,
        lastFinishedAt: null,
        pairsTotal: 2,
        pairsOk: 1,
        daysWritten: 1,
      }),
    );

    const backfill = backfillOf({ db, clock, client, scheduler });
    const summary = await backfill.runScan();

    expect(summary.pairsOk).toBe(2); // 1（上一轮）+ 1（本轮）
    expect(summary.daysWritten).toBe(2);

    const state = await readHistoryBackfillState(db);
    expect(state.lastStartedAt).toBe(anchor); // 锚点保持不变
  });

  it('未到周期：runDueScan 直接跳过且零请求', async () => {
    const { db, http, clock, client, scheduler } = await setup();
    await seedStats(db, HUB_A, 1);
    await writeHistoryBackfillState(
      db,
      stateOf({
        lastStartedAt: new Date(clock.now()).toISOString(),
        lastFinishedAt: new Date(clock.now()).toISOString(),
        lastFullOkAt: new Date(clock.now()).toISOString(),
      }),
    );

    const backfill = backfillOf({ db, clock, client, scheduler });
    const summary = await backfill.runDueScan();

    expect(summary.skipped).toBe(true);
    expect(summary.skipReason).toBe('未到预拉周期');
    expect(http.calls).toHaveLength(0);
  });

  it('关闭档：不发起预拉', async () => {
    const { db, http, clock, client, scheduler } = await setup();
    await seedStats(db, HUB_A, 1);
    await writeHistoryBackfillTier(db, 'off');

    const backfill = backfillOf({ db, clock, client, scheduler });
    const summary = await backfill.runDueScan();

    expect(summary.skipped).toBe(true);
    expect(summary.skipReason).toBe('预拉已关闭');
    expect(http.calls).toHaveLength(0);
  });

  it('暂停状态下不发起预拉', async () => {
    const { db, http, clock, client, scheduler } = await setup();
    await seedStats(db, HUB_A, 1);

    const backfill = backfillOf({ db, clock, client, scheduler, isPaused: () => true });
    const summary = await backfill.runScan();

    expect(summary.skipped).toBe(true);
    expect(summary.skipReason).toBe('已暂停采集');
    expect(http.calls).toHaveLength(0);
  });

  it('清单为空：不发起请求并提示同步数据', async () => {
    const { db, http, clock, client, scheduler } = await setup();

    const backfill = backfillOf({ db, clock, client, scheduler });
    const summary = await backfill.runScan({ force: true });

    expect(summary.skipped).toBe(true);
    expect(summary.skipReason).toContain('预拉清单为空');
    expect(http.calls).toHaveLength(0);
  });

  it('匀速节拍：按目标速率补齐等待（5 req/s → 每个 pair 200ms）', async () => {
    const { db, http, clock, client, scheduler } = await setup();
    await seedStats(db, HUB_A, 1);
    await seedStats(db, HUB_A, 2);
    await seedStats(db, HUB_A, 3);
    http.enqueue(historyResponse());
    http.enqueue(historyResponse());
    http.enqueue(historyResponse());

    const backfill = backfillOf({ db, clock, client, scheduler, ratePerSecond: 5 });
    const summary = await backfill.runScan();

    expect(clock.sleeps).toEqual([200, 200, 200]);
    expect(summary.elapsedMs).toBe(600);
  });
});
