import { describe, expect, it } from 'vitest';

import { EsiClient } from '../../src/esi/client';
import { RequestScheduler } from '../../src/esi/scheduler';
import type { MarketOrder } from '../../src/esi/types';
import { refreshTypeHistory, refreshTypeOrders } from '../../src/market/on-demand';
import { getOrderBook, getTypeStats } from '../../src/market/repo';
import { countRows, createMigratedDb } from '../helpers/db';
import { createFakeClock } from '../helpers/fake-clock';
import { createMockHttp, emptyResponse, jsonResponse } from '../helpers/mock-http';

const REGION = 10000002;
const TYPE = 34;
/** 固定基准时间：2026-09-27 02:00 UTC */
const T0 = Date.UTC(2026, 8, 27, 2, 0, 0);

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
  });
  return { db, http, deps: { db, client, scheduler } };
}

describe('按需刷新物品订单', () => {
  it('首次拉取：写入订单、统计与订单簿', async () => {
    const { db, http, deps } = await setup();
    http.enqueue(
      jsonResponse(200, [
        order({ order_id: 1, type_id: TYPE, price: 4.5, is_buy_order: false }),
        order({ order_id: 2, type_id: TYPE, price: 4, is_buy_order: true }),
      ]),
    );

    const result = await refreshTypeOrders(deps, REGION, TYPE, { now: T0 });

    expect(result.skipped).toBe(false);
    expect(result.ordersWritten).toBe(2);
    expect(result.statsWritten).toBe(1);
    expect(http.calls[0].url).toBe(
      'https://esi.evetech.net/latest/markets/10000002/orders/?type_id=34',
    );

    const stats = await getTypeStats(db, REGION, TYPE);
    expect(stats?.bestSell).toBe(4.5);
    expect(stats?.bestBuy).toBe(4);

    const book = await getOrderBook(db, REGION, TYPE);
    expect(book.sells).toHaveLength(1);
    expect(book.buys).toHaveLength(1);
  });

  it('TTL 内重复调用：跳过且不发起请求', async () => {
    const { http, deps } = await setup();
    http.enqueue(
      jsonResponse(200, [order({ order_id: 1, type_id: TYPE, price: 4.5, is_buy_order: false })]),
    );
    await refreshTypeOrders(deps, REGION, TYPE, { now: T0 });

    const second = await refreshTypeOrders(deps, REGION, TYPE, { now: T0 + 60_000 });

    expect(second.skipped).toBe(true);
    expect(second.ordersWritten).toBe(0);
    expect(http.calls).toHaveLength(1);
  });

  it('超过 TTL：重新拉取', async () => {
    const { http, deps } = await setup();
    http.enqueue(
      jsonResponse(200, [order({ order_id: 1, type_id: TYPE, price: 4.5, is_buy_order: false })]),
    );
    await refreshTypeOrders(deps, REGION, TYPE, { now: T0 });

    http.enqueue(
      jsonResponse(200, [order({ order_id: 1, type_id: TYPE, price: 5, is_buy_order: false })]),
    );
    const refreshed = await refreshTypeOrders(deps, REGION, TYPE, { now: T0 + 10 * 60_000 });

    expect(refreshed.skipped).toBe(false);
    expect(http.calls).toHaveLength(2);
  });

  it('force：忽略 TTL 强制刷新', async () => {
    const { http, deps } = await setup();
    http.enqueue(jsonResponse(200, []));
    await refreshTypeOrders(deps, REGION, TYPE, { now: T0 });

    http.enqueue(jsonResponse(200, []));
    const forced = await refreshTypeOrders(deps, REGION, TYPE, { force: true, now: T0 });

    expect(forced.skipped).toBe(false);
    expect(http.calls).toHaveLength(2);
  });

  it('市场无订单：清空该物品的旧快照与统计', async () => {
    const { db, http, deps } = await setup();
    http.enqueue(
      jsonResponse(200, [order({ order_id: 1, type_id: TYPE, price: 4.5, is_buy_order: false })]),
    );
    await refreshTypeOrders(deps, REGION, TYPE, { now: T0 });
    expect(await countRows(db, 'market_orders')).toBe(1);

    http.enqueue(jsonResponse(200, []));
    await refreshTypeOrders(deps, REGION, TYPE, { force: true, now: T0 });

    expect(await countRows(db, 'market_orders')).toBe(0);
    expect(await countRows(db, 'market_stats')).toBe(0);
  });

  it('请求失败：抛错且不影响既有数据', async () => {
    const { db, http, deps } = await setup();
    http.enqueue(
      jsonResponse(200, [order({ order_id: 1, type_id: TYPE, price: 4.5, is_buy_order: false })]),
    );
    await refreshTypeOrders(deps, REGION, TYPE, { now: T0 });

    http.enqueue(emptyResponse(404));
    await expect(refreshTypeOrders(deps, REGION, TYPE, { force: true, now: T0 })).rejects.toThrow();

    expect(await countRows(db, 'market_orders')).toBe(1);
  });
});

describe('日线历史刷新', () => {
  it('首次拉取：写入日线数据与 ETag', async () => {
    const { db, http, deps } = await setup();
    http.enqueue(
      jsonResponse(
        200,
        [
          { date: '2026-09-25', average: 4.2, highest: 5, lowest: 3.8, order_count: 100, volume: 1000 },
          { date: '2026-09-26', average: 4.3, highest: 5.1, lowest: 3.9, order_count: 110, volume: 1100 },
        ],
        { etag: 'W/"h1"' },
      ),
    );

    const result = await refreshTypeHistory(deps, REGION, TYPE, { now: T0 });

    expect(result.skipped).toBe(false);
    expect(result.daysWritten).toBe(2);
    expect(await countRows(db, 'market_history_daily')).toBe(2);

    const etags = await db.select<{ scope: string }>('SELECT scope FROM market_etag_cache');
    expect(etags[0].scope).toBe(`history:${REGION}:${TYPE}`);
  });

  it('当日重复调用：跳过且不发起请求（每日一次）', async () => {
    const { http, deps } = await setup();
    http.enqueue(jsonResponse(200, [{ date: '2026-09-26', average: 4, highest: 5, lowest: 3, order_count: 1, volume: 1 }]));
    await refreshTypeHistory(deps, REGION, TYPE, { now: T0 });

    const second = await refreshTypeHistory(deps, REGION, TYPE, { now: T0 + 12 * 3600_000 });

    expect(second.skipped).toBe(true);
    expect(http.calls).toHaveLength(1);
  });

  it('次日调用：重新拉取（带 ETag，304 时不重写数据）', async () => {
    const { db, http, deps } = await setup();
    http.enqueue(
      jsonResponse(200, [{ date: '2026-09-26', average: 4, highest: 5, lowest: 3, order_count: 1, volume: 1 }], {
        etag: 'W/"h1"',
      }),
    );
    await refreshTypeHistory(deps, REGION, TYPE, { now: T0 });

    http.enqueue(emptyResponse(304, { etag: 'W/"h1"' }));
    const nextDay = await refreshTypeHistory(deps, REGION, TYPE, { now: T0 + 24 * 3600_000 });

    expect(nextDay.skipped).toBe(true);
    expect(http.calls[1].ifNoneMatch).toBe('W/"h1"');
    expect(await countRows(db, 'market_history_daily')).toBe(1);
  });

  it('force：忽略每日限制强制刷新', async () => {
    const { http, deps } = await setup();
    http.enqueue(jsonResponse(200, []));
    await refreshTypeHistory(deps, REGION, TYPE, { now: T0 });

    http.enqueue(jsonResponse(200, []));
    const forced = await refreshTypeHistory(deps, REGION, TYPE, { force: true, now: T0 });

    expect(forced.skipped).toBe(false);
    expect(http.calls).toHaveLength(2);
  });
});
