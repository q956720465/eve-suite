import type { MarketOrder } from '../esi/types';

/** 每物品每区域的聚合指标行（对应 market_stats 表） */
export interface MarketStatsRow {
  region_id: number;
  type_id: number;
  best_sell: number | null;
  best_buy: number | null;
  sell_volume: number;
  buy_volume: number;
  sell_orders: number;
  buy_orders: number;
  spread: number | null;
  p5_sell: number | null;
  p95_buy: number | null;
  updated_at: string;
}

/**
 * 由订单快照计算每个物品的聚合指标。
 * - best_sell / best_buy：最低卖价 / 最高买价
 * - spread：买卖价差（任一方向缺失则为 null）
 * - p5_sell：卖价 5% 分位（估值口径，用于抗「1 ISK 钓鱼单」操纵，方案文档 §9）
 * - p95_buy：买价 95% 分位（对称参考）
 */
export function computeMarketStats(
  orders: readonly MarketOrder[],
  regionId: number,
  updatedAt: string,
): MarketStatsRow[] {
  const buckets = new Map<number, { sellPrices: number[]; buyPrices: number[]; sellVolume: number; buyVolume: number }>();

  for (const order of orders) {
    let bucket = buckets.get(order.type_id);
    if (bucket === undefined) {
      bucket = { sellPrices: [], buyPrices: [], sellVolume: 0, buyVolume: 0 };
      buckets.set(order.type_id, bucket);
    }
    if (order.is_buy_order) {
      bucket.buyPrices.push(order.price);
      bucket.buyVolume += order.volume_remain;
    } else {
      bucket.sellPrices.push(order.price);
      bucket.sellVolume += order.volume_remain;
    }
  }

  const rows: MarketStatsRow[] = [];
  for (const [typeId, bucket] of buckets) {
    const bestSell = minOf(bucket.sellPrices);
    const bestBuy = maxOf(bucket.buyPrices);
    rows.push({
      region_id: regionId,
      type_id: typeId,
      best_sell: bestSell,
      best_buy: bestBuy,
      sell_volume: bucket.sellVolume,
      buy_volume: bucket.buyVolume,
      sell_orders: bucket.sellPrices.length,
      buy_orders: bucket.buyPrices.length,
      spread: bestSell !== null && bestBuy !== null ? bestSell - bestBuy : null,
      p5_sell: percentile(bucket.sellPrices, 0.05),
      p95_buy: percentile(bucket.buyPrices, 0.95),
      updated_at: updatedAt,
    });
  }

  // 便于断言与稳定输出：按物品 ID 升序
  rows.sort((a, b) => a.type_id - b.type_id);
  return rows;
}

/** 分位数（线性插值）；空数组返回 null，且不修改入参数组 */
export function percentile(values: readonly number[], ratio: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * ratio;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/** 最小值（避免大数组展开导致的栈溢出） */
function minOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let result = values[0];
  for (const value of values) {
    if (value < result) result = value;
  }
  return result;
}

/** 最大值 */
function maxOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let result = values[0];
  for (const value of values) {
    if (value > result) result = value;
  }
  return result;
}
