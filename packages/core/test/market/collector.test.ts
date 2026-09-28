import { describe, expect, it } from 'vitest';

import { EsiClient } from '../../src/esi/client';
import { RequestScheduler } from '../../src/esi/scheduler';
import type { MarketOrder } from '../../src/esi/types';
import { MarketCollector } from '../../src/market/collector';
import { countRows, createMigratedDb } from '../helpers/db';
import { createFakeClock } from '../helpers/fake-clock';
import { createMockHttp, emptyResponse, jsonResponse } from '../helpers/mock-http';

const REGION = 10000002;

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

async function setup() {
  const db = await createMigratedDb();
  const http = createMockHttp();
  const client = new EsiClient({ http });
  const scheduler = new RequestScheduler({
    clock: createFakeClock(),
    requestsPerSecond: 1000,
    burst: 1000,
    maxConcurrent: 4,
  });
  const collector = new MarketCollector({ db, client, scheduler });
  return { db, http, collector };
}

describe('枢纽层采集器', () => {
  it('首轮采集：写入订单与聚合指标，并缓存 ETag', async () => {
    const { db, http, collector } = await setup();
    http.enqueue(
      jsonResponse(
        200,
        [
          order({ order_id: 1, type_id: 34, price: 4.5, is_buy_order: false }),
          order({ order_id: 2, type_id: 34, price: 4, is_buy_order: true }),
        ],
        { 'x-pages': '1', etag: 'W/"p1"' },
      ),
    );

    const result = await collector.collectRegion(REGION);

    expect(result.error).toBeNull();
    expect(result.skipped).toBe(false);
    expect(result.pages).toBe(1);
    expect(result.ordersWritten).toBe(2);
    expect(result.statsWritten).toBe(1);
    expect(await countRows(db, 'market_orders')).toBe(2);
    expect(await countRows(db, 'market_stats')).toBe(1);

    const etags = await db.select<{ scope: string; etag: string }>(
      'SELECT scope, etag FROM market_etag_cache',
    );
    expect(etags).toEqual([{ scope: `orders:${REGION}:1`, etag: 'W/"p1"' }]);

    const stats = await db.select<{ best_sell: number; best_buy: number }>(
      'SELECT best_sell, best_buy FROM market_stats',
    );
    expect(stats[0]).toMatchObject({ best_sell: 4.5, best_buy: 4 });
  });

  it('次轮全部 304：整轮跳过且保留既有数据（省流量与写入）', async () => {
    const { db, http, collector } = await setup();
    http.enqueue(
      jsonResponse(200, [order({ order_id: 1, type_id: 34, price: 4.5, is_buy_order: false })], {
        'x-pages': '1',
        etag: 'W/"p1"',
      }),
    );
    await collector.collectRegion(REGION);

    http.enqueue(emptyResponse(304, { etag: 'W/"p1"' }));
    const second = await collector.collectRegion(REGION);

    expect(second.skipped).toBe(true);
    expect(second.ordersWritten).toBe(0);
    expect(second.notModifiedPages).toBe(1);
    expect(await countRows(db, 'market_orders')).toBe(1);
    expect(await countRows(db, 'market_stats')).toBe(1);
  });

  it('部分页命中 304：无条件下补齐该页后完整替换', async () => {
    const { db, http, collector } = await setup();
    http.enqueue(
      jsonResponse(200, [order({ order_id: 1, type_id: 34, price: 5, is_buy_order: false })], {
        'x-pages': '2',
        etag: 'W/"p1"',
      }),
    );
    http.enqueue(
      jsonResponse(200, [order({ order_id: 2, type_id: 35, price: 9, is_buy_order: false })], {
        etag: 'W/"p2"',
      }),
    );
    await collector.collectRegion(REGION);
    expect(await countRows(db, 'market_orders')).toBe(2);

    // 次轮：第 1 页 304、第 2 页变化 → 需补齐第 1 页
    http.enqueue(emptyResponse(304, { etag: 'W/"p1"' }));
    http.enqueue(
      jsonResponse(200, [order({ order_id: 2, type_id: 35, price: 8, is_buy_order: false })], {
        etag: 'W/"p2b"',
      }),
    );
    http.enqueue(
      jsonResponse(200, [order({ order_id: 1, type_id: 34, price: 5, is_buy_order: false })], {
        etag: 'W/"p1"',
      }),
    );

    const result = await collector.collectRegion(REGION);

    expect(result.skipped).toBe(false);
    expect(result.ordersWritten).toBe(2);
    expect(await countRows(db, 'market_orders')).toBe(2);

    const changed = await db.select<{ price: number }>(
      'SELECT price FROM market_orders WHERE order_id = 2',
    );
    expect(changed[0].price).toBe(8);
  });

  it('采集失败：记录错误且保留既有数据', async () => {
    const { db, http, collector } = await setup();
    http.enqueue(
      jsonResponse(200, [order({ order_id: 1, type_id: 34, price: 5, is_buy_order: false })], {
        'x-pages': '1',
        etag: 'W/"p1"',
      }),
    );
    await collector.collectRegion(REGION);

    http.enqueue(emptyResponse(404));
    const failed = await collector.collectRegion(REGION);

    expect(failed.error).not.toBeNull();
    expect(await countRows(db, 'market_orders')).toBe(1);

    const state = await db.select<{ last_error: string | null }>(
      'SELECT last_error FROM market_collect_state WHERE region_id = ?',
      [REGION],
    );
    expect(state[0].last_error).not.toBeNull();
  });

  it('首次采集即失败：记录错误但不写入成功水位（避免显示成「曾经成功过」）', async () => {
    const { db, http, collector } = await setup();
    http.enqueue(emptyResponse(404));

    const failed = await collector.collectRegion(REGION);

    expect(failed.error).not.toBeNull();
    const state = await db.select<{ last_ok_at: string | null; last_error: string | null }>(
      'SELECT last_ok_at, last_error FROM market_collect_state WHERE region_id = ?',
      [REGION],
    );
    expect(state[0].last_ok_at).toBeNull();
    expect(state[0].last_error).not.toBeNull();
  });

  it('先成功后失败：失败不清空既有成功水位', async () => {
    const { db, http, collector } = await setup();
    http.enqueue(
      jsonResponse(200, [order({ order_id: 1, type_id: 34, price: 5, is_buy_order: false })], {
        'x-pages': '1',
        etag: 'W/"p1"',
      }),
    );
    await collector.collectRegion(REGION);
    const before = await db.select<{ last_ok_at: string | null }>(
      'SELECT last_ok_at FROM market_collect_state WHERE region_id = ?',
      [REGION],
    );

    http.enqueue(emptyResponse(404));
    await collector.collectRegion(REGION);

    const after = await db.select<{ last_ok_at: string | null }>(
      'SELECT last_ok_at FROM market_collect_state WHERE region_id = ?',
      [REGION],
    );
    expect(after[0].last_ok_at).toBe(before[0].last_ok_at);
  });

  it('采集状态：成功后记录页数、行数与成功时间', async () => {
    const { db, http, collector } = await setup();
    http.enqueue(
      jsonResponse(200, [order({ order_id: 1, type_id: 34, price: 5, is_buy_order: false })], {
        'x-pages': '3',
        etag: 'W/"p1"',
      }),
    );
    http.enqueue(jsonResponse(200, [], { etag: 'W/"p2"' }));
    http.enqueue(jsonResponse(200, [], { etag: 'W/"p3"' }));

    await collector.collectRegion(REGION);

    const state = await db.select<{
      pages: number;
      orders_written: number;
      last_ok_at: string | null;
      last_error: string | null;
    }>(
      'SELECT pages, orders_written, last_ok_at, last_error FROM market_collect_state WHERE region_id = ?',
      [REGION],
    );
    expect(state[0].pages).toBe(3);
    expect(state[0].orders_written).toBe(1);
    expect(state[0].last_ok_at).not.toBeNull();
    expect(state[0].last_error).toBeNull();
  });

  it('跨页重复 order_id：去重后仍整区替换成功（不因主键冲突整轮失败）', async () => {
    const { db, http, collector } = await setup();
    // 实时行情下「304 探针 + 补齐页」是两次不同时刻取样，同一订单可能被两份页同时包含
    http.enqueue(
      jsonResponse(
        200,
        [
          order({ order_id: 1, type_id: 34, price: 5, is_buy_order: false }),
          order({ order_id: 2, type_id: 34, price: 6, is_buy_order: false }),
        ],
        { 'x-pages': '2', etag: 'W/"p1"' },
      ),
    );
    http.enqueue(
      jsonResponse(
        200,
        [
          order({ order_id: 2, type_id: 34, price: 6.5, is_buy_order: false }),
          order({ order_id: 3, type_id: 35, price: 9, is_buy_order: false }),
        ],
        { etag: 'W/"p2"' },
      ),
    );

    const result = await collector.collectRegion(REGION);

    expect(result.error).toBeNull();
    expect(result.ordersWritten).toBe(3);
    expect(await countRows(db, 'market_orders')).toBe(3);

    // 去重保留「最后一次出现」：order_id=2 取第 2 页的价格
    const dup = await db.select<{ price: number }>(
      'SELECT price FROM market_orders WHERE order_id = 2',
    );
    expect(dup[0].price).toBe(6.5);

    // 聚合指标同样基于去重后的订单集（最低卖价 = 5）
    const stats = await db.select<{ best_sell: number }>('SELECT best_sell FROM market_stats');
    expect(stats[0].best_sell).toBe(5);
  });

  it('同一页内重复 order_id：去重后写入成功', async () => {
    const { db, http, collector } = await setup();
    http.enqueue(
      jsonResponse(
        200,
        [
          order({ order_id: 1, type_id: 34, price: 5, is_buy_order: false }),
          order({ order_id: 1, type_id: 34, price: 5.5, is_buy_order: false }),
        ],
        { 'x-pages': '1', etag: 'W/"p1"' },
      ),
    );

    const result = await collector.collectRegion(REGION);

    expect(result.error).toBeNull();
    expect(await countRows(db, 'market_orders')).toBe(1);
  });
});
