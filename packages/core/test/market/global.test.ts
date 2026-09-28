import { describe, expect, it } from 'vitest';

import { EsiClient } from '../../src/esi/client';
import { RequestScheduler, type RequestPriority } from '../../src/esi/scheduler';
import type { MarketOrder } from '../../src/esi/types';
import {
  EMPTY_GLOBAL_SCAN_STATE,
  GLOBAL_SCAN_RETRY_DELAY_MS,
  readGlobalScanState,
  writeGlobalScanState,
  writeGlobalScanTier,
} from '../../src/market/global-state';
import {
  GlobalMarketScanner,
  type GlobalScanProgress,
  type GlobalScannerOptions,
} from '../../src/market/global';
import { countRows, createMigratedDb } from '../helpers/db';
import { createFakeClock } from '../helpers/fake-clock';
import { createMockHttp, emptyResponse, jsonResponse } from '../helpers/mock-http';

type TestDb = Awaited<ReturnType<typeof createMigratedDb>>;

/** 两个非枢纽的已知空间区域（全域轮次的直采目标） */
const REGION_A = 10000001;
const REGION_B = 10000060;
const NOW = Date.parse('2026-09-28T12:00:00.000Z');
const HOUR = 3_600_000;

function order(
  overrides: Partial<MarketOrder> & Pick<MarketOrder, 'order_id' | 'type_id' | 'price' | 'is_buy_order'>,
): MarketOrder {
  return {
    location_id: 60003760,
    volume_total: 100,
    volume_remain: 100,
    min_volume: 1,
    duration: 90,
    issued: '2026-09-01T00:00:00Z',
    range: 'region',
    ...overrides,
  };
}

async function seedRegions(db: TestDb, regionIds: readonly number[]): Promise<void> {
  for (const regionId of regionIds) {
    await db.execute('INSERT INTO sde_regions (region_id, name_en, name_zh) VALUES (?, ?, ?)', [
      regionId,
      `Region ${regionId}`,
      null,
    ]);
  }
}

/** 直接写某区域的水位（模拟「上一轮已完成该区域」） */
async function seedRegionState(db: TestDb, regionId: number, lastOkAt: string): Promise<void> {
  await db.execute(
    `INSERT INTO market_collect_state
       (region_id, last_started_at, last_ok_at, last_error, pages, orders_written, requests)
     VALUES (?, ?, ?, NULL, 1, 1, 1)`,
    [regionId, lastOkAt, lastOkAt],
  );
}

interface SetupOptions {
  regionIds?: readonly number[];
  tier?: '3h' | '6h' | '12h' | '24h' | 'off';
  scannerOptions?: Omit<GlobalScannerOptions, 'db' | 'client' | 'scheduler' | 'clock'>;
}

async function setup(options: SetupOptions = {}) {
  const db = await createMigratedDb();
  await seedRegions(db, options.regionIds ?? [REGION_A, REGION_B]);
  if (options.tier !== undefined) await writeGlobalScanTier(db, options.tier);

  const http = createMockHttp();
  const client = new EsiClient({ http });
  const clock = createFakeClock(NOW);
  const scheduler = new RequestScheduler({
    clock,
    requestsPerSecond: 1000,
    burst: 1000,
    maxConcurrent: 4,
  });

  // 记录请求优先级：全域层必须走 'global'（低于枢纽层，配合让路）
  const priorities: RequestPriority[] = [];
  const originalRun = scheduler.run.bind(scheduler);
  scheduler.run = ((priority: RequestPriority, run: () => Promise<unknown>) => {
    priorities.push(priority);
    return originalRun(priority, run);
  }) as unknown as RequestScheduler['run'];

  const progress: GlobalScanProgress[] = [];
  const { onProgress, ...rest } = options.scannerOptions ?? {};
  const scanner = new GlobalMarketScanner({
    db,
    client,
    scheduler,
    clock,
    onProgress: (event) => {
      progress.push(event);
      onProgress?.(event);
    },
    ...rest,
  });

  return { db, http, clock, scanner, priorities, progress };
}

describe('全域层扫描器', () => {
  it('首轮扫描：写入订单与聚合指标、推进区域水位与整轮状态（global 优先级、不带条件请求）', async () => {
    const { db, http, scanner, priorities } = await setup();
    http.enqueue(
      jsonResponse(200, [order({ order_id: 1, type_id: 34, price: 4.5, is_buy_order: false })], {
        'x-pages': '1',
      }),
    );
    http.enqueue(
      jsonResponse(200, [order({ order_id: 2, type_id: 34, price: 6, is_buy_order: false })], {
        'x-pages': '1',
      }),
    );

    const summary = await scanner.runDueScan();

    expect(summary.skipped).toBe(false);
    expect(summary.regionsTotal).toBe(2);
    expect(summary.regionsOk).toBe(2);
    expect(summary.regionsFailed).toBe(0);
    expect(summary.requests).toBe(2);
    expect(summary.ordersWritten).toBe(2);
    expect(await countRows(db, 'market_orders')).toBe(2);
    expect(await countRows(db, 'market_stats')).toBe(2);

    expect(priorities).toEqual(['global', 'global']);
    expect(http.calls.every((call) => call.ifNoneMatch === undefined)).toBe(true);
    expect(http.calls.map((call) => call.url)).toEqual([
      expect.stringContaining(`/markets/${REGION_A}/orders/`),
      expect.stringContaining(`/markets/${REGION_B}/orders/`),
    ]);

    const regionStates = await db.select<{ last_ok_at: string | null; last_error: string | null }>(
      'SELECT last_ok_at, last_error FROM market_collect_state ORDER BY region_id',
    );
    expect(regionStates).toHaveLength(2);
    expect(regionStates.every((row) => row.last_ok_at !== null && row.last_error === null)).toBe(
      true,
    );

    const state = await readGlobalScanState(db);
    expect(state).toMatchObject({
      regionsTotal: 2,
      regionsOk: 2,
      regionsFailed: 0,
      lastError: null,
      retryDueAt: null,
      requests: 2,
    });
    expect(state.lastFullOkAt).not.toBeNull();

    // 全量成功且未到档位 → 下一轮直接跳过、零请求
    const second = await scanner.runDueScan();
    expect(second.skipped).toBe(true);
    expect(second.skipReason).toBe('未到扫描周期');
    expect(http.calls).toHaveLength(2);
  });

  it('catch-up：距上次全量成功超档位时补扫；未超则不扫', async () => {
    const { db, http, scanner } = await setup({ tier: '3h' });
    const fourHoursAgo = new Date(NOW - 4 * HOUR).toISOString();
    await writeGlobalScanState(db, {
      ...EMPTY_GLOBAL_SCAN_STATE,
      lastStartedAt: fourHoursAgo,
      lastFinishedAt: fourHoursAgo,
      lastFullOkAt: fourHoursAgo,
      regionsTotal: 2,
      regionsOk: 2,
    });

    http.enqueue(
      jsonResponse(200, [order({ order_id: 1, type_id: 34, price: 4.5, is_buy_order: false })], {
        'x-pages': '1',
      }),
    );
    http.enqueue(
      jsonResponse(200, [order({ order_id: 2, type_id: 34, price: 6, is_buy_order: false })], {
        'x-pages': '1',
      }),
    );

    const summary = await scanner.runDueScan();
    expect(summary.skipped).toBe(false);
    expect(summary.requests).toBe(2);
    expect(await countRows(db, 'market_orders')).toBe(2);

    // 未超档位：只把锚点前移 1 小时（仍未到 3h）→ 不扫
    const twoHoursAgo = new Date(NOW - 2 * HOUR).toISOString();
    await writeGlobalScanState(db, {
      ...EMPTY_GLOBAL_SCAN_STATE,
      lastStartedAt: twoHoursAgo,
      lastFinishedAt: twoHoursAgo,
      lastFullOkAt: twoHoursAgo,
    });
    const skipped = await scanner.runDueScan();
    expect(skipped.skipped).toBe(true);
    expect(http.calls).toHaveLength(2);
  });

  it('关闭档：不自动扫描（已有快照保留），手动 force 仍可扫描', async () => {
    const { db, http, scanner } = await setup({ tier: 'off' });

    const skipped = await scanner.runDueScan();
    expect(skipped.skipped).toBe(true);
    expect(skipped.tier).toBe('off');
    expect(http.calls).toHaveLength(0);
    expect(await countRows(db, 'market_orders')).toBe(0);

    http.enqueue(
      jsonResponse(200, [order({ order_id: 1, type_id: 34, price: 4.5, is_buy_order: false })], {
        'x-pages': '1',
      }),
    );
    http.enqueue(
      jsonResponse(200, [order({ order_id: 2, type_id: 34, price: 6, is_buy_order: false })], {
        'x-pages': '1',
      }),
    );
    const forced = await scanner.runScan({ force: true });
    expect(forced.skipped).toBe(false);
    expect(forced.regionsOk).toBe(2);
    expect(await countRows(db, 'market_orders')).toBe(2);
  });

  it('缺少区域清单（未导入 SDE）：跳过且不发请求', async () => {
    const { http, scanner } = await setup({ regionIds: [] });
    const summary = await scanner.runDueScan();
    expect(summary.skipped).toBe(true);
    expect(summary.skipReason).toContain('SDE');
    expect(http.calls).toHaveLength(0);
  });

  it('已暂停：不开始新扫描', async () => {
    const { http, scanner } = await setup({ scannerOptions: { isPaused: () => true } });
    const summary = await scanner.runDueScan();
    expect(summary.skipped).toBe(true);
    expect(summary.skipReason).toBe('已暂停采集');
    expect(http.calls).toHaveLength(0);
  });

  it('整区替换：重复扫描不叠加（只存最新快照），价格按最新快照覆盖', async () => {
    const { db, http, scanner } = await setup();
    http.enqueue(
      jsonResponse(200, [order({ order_id: 1, type_id: 34, price: 5, is_buy_order: false })], {
        'x-pages': '1',
      }),
    );
    http.enqueue(
      jsonResponse(200, [order({ order_id: 2, type_id: 34, price: 6, is_buy_order: false })], {
        'x-pages': '1',
      }),
    );
    await scanner.runScan({ force: true });
    expect(await countRows(db, 'market_orders')).toBe(2);

    http.enqueue(
      jsonResponse(200, [order({ order_id: 1, type_id: 34, price: 7, is_buy_order: false })], {
        'x-pages': '1',
      }),
    );
    http.enqueue(
      jsonResponse(200, [order({ order_id: 2, type_id: 34, price: 8, is_buy_order: false })], {
        'x-pages': '1',
      }),
    );
    await scanner.runScan({ force: true });

    expect(await countRows(db, 'market_orders')).toBe(2);
    expect(await countRows(db, 'market_stats')).toBe(2);
    const rows = await db.select<{ region_id: number; price: number }>(
      'SELECT region_id, price FROM market_orders ORDER BY region_id',
    );
    expect(rows).toEqual([
      { region_id: REGION_A, price: 7 },
      { region_id: REGION_B, price: 8 },
    ]);
  });

  it('跨页重复 order_id：去重后仍整区替换成功（与枢纽层同口径）', async () => {
    const { db, http, scanner } = await setup({ regionIds: [REGION_A] });
    http.enqueue(
      jsonResponse(
        200,
        [
          order({ order_id: 1, type_id: 34, price: 5, is_buy_order: false }),
          order({ order_id: 2, type_id: 34, price: 6, is_buy_order: false }),
        ],
        { 'x-pages': '2' },
      ),
    );
    http.enqueue(
      jsonResponse(200, [
        order({ order_id: 2, type_id: 34, price: 6.5, is_buy_order: false }),
        order({ order_id: 3, type_id: 35, price: 9, is_buy_order: false }),
      ]),
    );

    const summary = await scanner.runScan({ force: true });

    expect(summary.regionsFailed).toBe(0);
    expect(summary.requests).toBe(2);
    expect(summary.ordersWritten).toBe(3);
    expect(await countRows(db, 'market_orders')).toBe(3);
    const dup = await db.select<{ price: number }>(
      'SELECT price FROM market_orders WHERE order_id = 2',
    );
    expect(dup[0].price).toBe(6.5);
  });

  it('单区域失败隔离：失败区记错且不推进水位，其余区域照常写入，本轮标记部分完成', async () => {
    const { db, http, scanner } = await setup();
    http.enqueue(emptyResponse(404));
    http.enqueue(
      jsonResponse(200, [order({ order_id: 11, type_id: 34, price: 6, is_buy_order: false })], {
        'x-pages': '1',
      }),
    );

    const summary = await scanner.runDueScan();

    expect(summary.regionsFailed).toBe(1);
    expect(summary.regionsOk).toBe(1);
    expect(summary.results).toHaveLength(2);
    expect(summary.results[0].error).not.toBeNull();
    expect(summary.results[1].error).toBeNull();
    expect(await countRows(db, 'market_orders')).toBe(1);

    const failedState = await db.select<{ last_ok_at: string | null; last_error: string | null }>(
      'SELECT last_ok_at, last_error FROM market_collect_state WHERE region_id = ?',
      [REGION_A],
    );
    expect(failedState[0].last_ok_at).toBeNull();
    expect(failedState[0].last_error).not.toBeNull();

    const state = await readGlobalScanState(db);
    expect(state.lastFullOkAt).toBeNull();
    expect(state.lastError).not.toBeNull();
    expect(state.regionsFailed).toBe(1);
    expect(state.retryDueAt).not.toBeNull();
    expect(Date.parse(state.retryDueAt ?? '')).toBe(
      Date.parse(state.lastFinishedAt ?? '') + GLOBAL_SCAN_RETRY_DELAY_MS,
    );
  });

  it('失败后重试：到点只补失败区域，已完成区域不重复拉取', async () => {
    const { db, http, clock, scanner } = await setup();
    http.enqueue(emptyResponse(404));
    http.enqueue(
      jsonResponse(200, [order({ order_id: 21, type_id: 34, price: 6, is_buy_order: false })], {
        'x-pages': '1',
      }),
    );
    await scanner.runDueScan();

    clock.advance(GLOBAL_SCAN_RETRY_DELAY_MS + 60_000);
    const callsBefore = http.calls.length;
    http.enqueue(
      jsonResponse(200, [order({ order_id: 22, type_id: 34, price: 7, is_buy_order: false })], {
        'x-pages': '1',
      }),
    );

    const retry = await scanner.runDueScan();

    expect(retry.skipped).toBe(false);
    expect(retry.regionsResumed).toBe(1);
    expect(retry.requests).toBe(1);
    expect(http.calls.length - callsBefore).toBe(1);
    expect(http.calls[http.calls.length - 1].url).toContain(`/markets/${REGION_A}/orders/`);

    const state = await readGlobalScanState(db);
    expect(state.lastFullOkAt).not.toBeNull();
    expect(state.retryDueAt).toBeNull();
    expect(state.regionsFailed).toBe(0);
    expect(state.regionsOk).toBe(2);
  });

  it('断点续扫：上一轮中断时沿用本轮锚点，只补未完成区域', async () => {
    const { db, http, scanner } = await setup();
    const anchor = new Date(NOW - HOUR).toISOString();
    await writeGlobalScanState(db, {
      ...EMPTY_GLOBAL_SCAN_STATE,
      lastStartedAt: anchor,
      regionsTotal: 2,
    });
    await seedRegionState(db, REGION_A, anchor);

    http.enqueue(
      jsonResponse(200, [order({ order_id: 31, type_id: 34, price: 5, is_buy_order: false })], {
        'x-pages': '1',
      }),
    );

    const summary = await scanner.runDueScan();

    expect(summary.skipped).toBe(false);
    expect(summary.regionsResumed).toBe(1);
    expect(summary.requests).toBe(1);
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0].url).toContain(`/markets/${REGION_B}/orders/`);

    const state = await readGlobalScanState(db);
    expect(state.lastStartedAt).toBe(anchor);
    expect(state.lastFullOkAt).not.toBeNull();
  });

  it('暂停：在途扫描在当前区域收尾后停止，并把续扫设为立即', async () => {
    let paused = false;
    const { db, http, scanner } = await setup({
      scannerOptions: {
        isPaused: () => paused,
        onProgress: (event) => {
          if (event.stage === 'done') paused = true;
        },
      },
    });
    http.enqueue(
      jsonResponse(200, [order({ order_id: 41, type_id: 34, price: 5, is_buy_order: false })], {
        'x-pages': '1',
      }),
    );
    http.enqueue(
      jsonResponse(200, [order({ order_id: 42, type_id: 34, price: 6, is_buy_order: false })], {
        'x-pages': '1',
      }),
    );

    const summary = await scanner.runDueScan();

    expect(summary.aborted).toBe(true);
    expect(summary.regionsOk).toBe(1);
    expect(http.calls).toHaveLength(1); // 第二个区域未发起请求

    const state = await readGlobalScanState(db);
    expect(state.lastFullOkAt).toBeNull();
    expect(Date.parse(state.retryDueAt ?? '')).toBe(Date.parse(state.lastFinishedAt ?? ''));
  });

  it('让路：全域请求一律以 global 优先级入队（低于枢纽层，峰值不叠加）', async () => {
    const { http, scanner, priorities } = await setup({ regionIds: [REGION_A] });
    http.enqueue(
      jsonResponse(200, [order({ order_id: 51, type_id: 34, price: 5, is_buy_order: false })], {
        'x-pages': '1',
      }),
    );

    const summary = await scanner.runScan({ force: true });

    expect(summary.regionsFailed).toBe(0);
    expect(summary.requests).toBe(1);
    expect(priorities).toEqual(['global']);
  });
});
