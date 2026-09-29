import type { MarketOrder } from '../esi/types';

import type { MarketStatsRow } from './stats';

/** market_orders 列顺序（与批量插入保持一致） */
export const ORDER_COLUMNS = [
  'order_id',
  'region_id',
  'type_id',
  'location_id',
  'price',
  'volume_total',
  'volume_remain',
  'min_volume',
  'is_buy_order',
  'duration',
  'issued',
  'range',
  'fetched_at',
] as const;

/** market_stats 列顺序 */
export const STATS_COLUMNS = [
  'region_id',
  'type_id',
  'best_sell',
  'best_buy',
  'sell_volume',
  'buy_volume',
  'sell_orders',
  'buy_orders',
  'spread',
  'p5_sell',
  'p95_buy',
  'wavg_sell',
  'w5_sell',
  'updated_at',
] as const;

/** market_history_daily 列顺序 */
export const HISTORY_COLUMNS = [
  'region_id',
  'type_id',
  'date',
  'average',
  'highest',
  'lowest',
  'order_count',
  'volume',
  'fetched_at',
] as const;

/** 批量写入行数（13 列 × 1000 = 13000 个参数，低于 SQLite 变量上限） */
export const WRITE_BATCH_ROWS = 1000;

export function toOrderRow(order: MarketOrder, regionId: number, fetchedAt: string): unknown[] {
  return [
    order.order_id,
    regionId,
    order.type_id,
    order.location_id,
    order.price,
    order.volume_total,
    order.volume_remain,
    order.min_volume,
    order.is_buy_order ? 1 : 0,
    order.duration,
    order.issued,
    order.range,
    fetchedAt,
  ];
}

export function toStatsRow(row: MarketStatsRow): unknown[] {
  return [
    row.region_id,
    row.type_id,
    row.best_sell,
    row.best_buy,
    row.sell_volume,
    row.buy_volume,
    row.sell_orders,
    row.buy_orders,
    row.spread,
    row.p5_sell,
    row.p95_buy,
    row.wavg_sell,
    row.w5_sell,
    row.updated_at,
  ];
}
