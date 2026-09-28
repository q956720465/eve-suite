import { describe, expect, it } from 'vitest';

import { EsiClient } from '../../src/esi/client';
import { RequestScheduler } from '../../src/esi/scheduler';
import type { MarketOrder } from '../../src/esi/types';
import {
  HISTORY_RETENTION_DAYS,
  refreshTypeHistory,
  refreshTypeOrders,
} from '../../src/market/on-demand';
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

/** 保留窗口的起始日期（含）与「窗口外一天」，用于边界构造 */
const CUTOFF = new Date(T0 - HISTORY_RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
const BEFORE_CUTOFF = new Date(Date.parse(CUTOFF) - 86_400_000).toISOString().slice(0, 10);

/** 构造一条日线（端点返回形状） */
function day(date: string, average: number) {
  return { date, average, highest: average + 1, lowest: average - 1, order_count: 10, volume: 100 };
}

describe('日线历史：增量写入与保留窗口（P5-2.7）', () => {
  it('次日刷新：只增量写入新增日期（含当天覆盖），不整段重写', async () => {
    const { db, http, deps } = await setup();
    http.enqueue(jsonResponse(200, [day('2026-09-25', 4.2), day('2026-09-26', 4.3)]));
    await refreshTypeHistory(deps, REGION, TYPE, { now: T0 });
    expect(await countRows(db, 'market_history_daily')).toBe(2);

    // 次日端点仍返回全段，但只有最后一天是新的
    http.enqueue(
      jsonResponse(200, [day('2026-09-25', 4.2), day('2026-09-26', 4.3), day('2026-09-27', 4.4)]),
    );
    const nextDay = await refreshTypeHistory(deps, REGION, TYPE, { now: T0 + 24 * 3600_000 });

    // 只写「>= 本地最新日期（09-26）」的行：09-26 覆盖 + 09-27 新增（而不是 3 行）
    expect(nextDay.daysWritten).toBe(2);
    expect(await countRows(db, 'market_history_daily')).toBe(3);
  });

  it('重拉时以最新日期为界覆盖当天行，更早的行不动', async () => {
    const { db, http, deps } = await setup();
    http.enqueue(jsonResponse(200, [day('2026-09-25', 4.2), day('2026-09-26', 4.3)]));
    await refreshTypeHistory(deps, REGION, TYPE, { now: T0 });

    // 当天数据在盘中会变：09-26 的均价被更新，09-25 不变
    http.enqueue(jsonResponse(200, [day('2026-09-25', 9.9), day('2026-09-26', 5.5)]));
    const again = await refreshTypeHistory(deps, REGION, TYPE, { force: true, now: T0 });

    expect(again.daysWritten).toBe(1); // 只有 09-26
    const rows = await db.select<{ date: string; average: number }>(
      'SELECT date, average FROM market_history_daily ORDER BY date',
    );
    expect(rows).toEqual([
      { date: '2026-09-25', average: 4.2 },
      { date: '2026-09-26', average: 5.5 },
    ]);
  });

  it('保留窗口：超出窗口的日线不入库', async () => {
    const { db, http, deps } = await setup();
    http.enqueue(
      jsonResponse(200, [
        day(BEFORE_CUTOFF, 1),
        day(CUTOFF, 2), // 边界：保留
        day('2026-09-26', 4.3),
      ]),
    );

    const result = await refreshTypeHistory(deps, REGION, TYPE, { now: T0 });

    expect(result.daysWritten).toBe(2);
    const earliest = await db.select<{ earliest: string }>(
      'SELECT MIN(date) AS earliest FROM market_history_daily',
    );
    expect(earliest[0]?.earliest).toBe(CUTOFF);
  });

  it('刷新时删除已滚出窗口的历史行', async () => {
    const { db, http, deps } = await setup();
    await db.execute(
      `INSERT INTO market_history_daily
         (region_id, type_id, date, average, highest, lowest, order_count, volume, fetched_at)
       VALUES (?, ?, ?, 1, 1, 1, 1, 1, '2026-01-01T00:00:00Z')`,
      [REGION, TYPE, BEFORE_CUTOFF],
    );

    http.enqueue(jsonResponse(200, [day('2026-09-26', 4.3)]));
    await refreshTypeHistory(deps, REGION, TYPE, { now: T0 });

    expect(await countRows(db, 'market_history_daily')).toBe(1); // 旧行被裁掉，只剩新行
  });

  it('无待写日期时：只刷新抓取时间，不重复写数据行', async () => {
    const { db, http, deps } = await setup();
    http.enqueue(jsonResponse(200, [day('2026-09-26', 4.3)]));
    await refreshTypeHistory(deps, REGION, TYPE, { now: T0 });

    // 端点只回更早的日期（数据回滚 / 延迟）→ 无「>= 本地最新」的行
    http.enqueue(jsonResponse(200, [day('2026-09-25', 4.2)]));
    const result = await refreshTypeHistory(deps, REGION, TYPE, {
      force: true,
      now: T0 + 3600_000,
    });

    expect(result.daysWritten).toBe(0);
    const rows = await db.select<{ date: string; average: number; fetched: string }>(
      'SELECT date, average, fetched_at AS fetched FROM market_history_daily',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.date).toBe('2026-09-26'); // 数据未被更旧的行覆盖
    expect(rows[0]?.fetched).toBe(new Date(T0 + 3600_000).toISOString()); // 但抓取时间已刷新
  });

  it('窗口内无数据：清空该 pair', async () => {
    const { db, http, deps } = await setup();
    http.enqueue(jsonResponse(200, [day('2026-09-26', 4.3)]));
    await refreshTypeHistory(deps, REGION, TYPE, { now: T0 });
    expect(await countRows(db, 'market_history_daily')).toBe(1);

    http.enqueue(jsonResponse(200, []));
    const cleared = await refreshTypeHistory(deps, REGION, TYPE, { force: true, now: T0 });

    expect(cleared.daysWritten).toBe(0);
    expect(await countRows(db, 'market_history_daily')).toBe(0);
  });
});
