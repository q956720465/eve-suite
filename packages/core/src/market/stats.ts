import type { MarketOrder } from '../esi/types';

/**
 * 聚合时可接受的订单最小成交量上限。
 *
 * `min_volume > 1` 的订单必须**整批成交**（例如「最低 10,000 单位」的大单），其挂价
 * 不代表「1 单位可成交价」——典型操纵手法即用极低价 + 超大 `min_volume` 把 `best_sell`
 * 打到不真实的位置（P5-2 调研发现，见 DEV_STATUS 已知待办）。
 *
 * 买卖两侧**对称**排除：买侧同理（「最低收 N 单位」的买单，1 单位卖不进去），
 * 以保证 `best_sell` / `best_buy` 同为「单笔 1 单位可成交价」口径。
 *
 * 估值引擎的订单簿精确路径（`engines/valuation.ts`）复用同一常量，避免两处口径分叉。
 */
export const MAX_TRADABLE_MIN_VOLUME = 1;

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
  /** 卖单挂单量加权均价（P11-1；= Fuzzwork `weightedAverage` 同定义） */
  wavg_sell: number | null;
  /** 卖单挂单量加权 5% 分位（P11-1；我方自定义口径，不插值） */
  w5_sell: number | null;
  updated_at: string;
}

/** 一条卖单的（价, 剩余量）：供挂单量加权口径使用 */
export interface OrderLevel {
  price: number;
  volume: number;
}

interface StatsBucket {
  sellPrices: number[];
  buyPrices: number[];
  sellVolume: number;
  buyVolume: number;
  /** 卖单明细（价 + 剩余量），仅供挂单量加权口径 */
  sellLevels: OrderLevel[];
}

/**
 * 由订单快照计算每个物品的聚合指标。
 * - best_sell / best_buy：最低卖价 / 最高买价
 * - spread：买卖价差（任一方向缺失则为 null）
 * - p5_sell：卖价 5% 分位（**按订单数**线性插值；估值默认口径，抗「1 ISK 钓鱼单」操纵）
 * - p95_buy：买价 95% 分位（对称参考）
 * - wavg_sell / w5_sell：**按挂单量加权**的两个口径（P11-1 新增，见 `weightedAverage` / `weightedPercentile`）
 *
 * 口径（P7-1 新增）：`min_volume > 1` 的整批大单**不参与**价格、量与计数的聚合，
 * 见 `MAX_TRADABLE_MIN_VOLUME`。某物品的订单**全部**被排除时不产生该物品的行
 * （等价于「无可成交报价」，估值侧与无行同义）。
 */
export function computeMarketStats(
  orders: readonly MarketOrder[],
  regionId: number,
  updatedAt: string,
): MarketStatsRow[] {
  const buckets = new Map<number, StatsBucket>();

  for (const order of orders) {
    // 整批大单不代表「1 单位可成交价」，买卖两侧对称排除（见 MAX_TRADABLE_MIN_VOLUME）
    if (order.min_volume > MAX_TRADABLE_MIN_VOLUME) continue;

    let bucket = buckets.get(order.type_id);
    if (bucket === undefined) {
      bucket = { sellPrices: [], buyPrices: [], sellVolume: 0, buyVolume: 0, sellLevels: [] };
      buckets.set(order.type_id, bucket);
    }
    if (order.is_buy_order) {
      bucket.buyPrices.push(order.price);
      bucket.buyVolume += order.volume_remain;
    } else {
      bucket.sellPrices.push(order.price);
      bucket.sellVolume += order.volume_remain;
      bucket.sellLevels.push({ price: order.price, volume: order.volume_remain });
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
      wavg_sell: weightedAverage(bucket.sellLevels),
      w5_sell: weightedPercentile(bucket.sellLevels, 0.05),
      updated_at: updatedAt,
    });
  }

  // 便于断言与稳定输出：按物品 ID 升序
  rows.sort((a, b) => a.type_id - b.type_id);
  return rows;
}

/**
 * 挂单量加权均价 `Σ(price × volume_remain) / Σ(volume_remain)`。
 *
 * 口径（P11-1，2026-09-29 实测反推锁定）：与 Fuzzwork `/aggregates` 的 `sell.weightedAverage` 同定义
 * （低流动性物品上可精确对账）。
 *
 * ⚠️ 特性：**尾部敏感** —— 少数「高价 + 大挂单量」的订单会主导结果，故同一物品在采集间隔内
 * 数值波动可能很大（实测三钛合金差 68%）。它只宜作**参考口径**，不适合作默认估值基准。
 */
export function weightedAverage(levels: readonly OrderLevel[]): number | null {
  let total = 0;
  let weighted = 0;
  for (const level of levels) {
    if (!(level.volume > 0)) continue;
    total += level.volume;
    weighted += level.price * level.volume;
  }
  if (total <= 0) return null;
  return weighted / total;
}

/**
 * 挂单量加权分位：按价格升序累积挂单量，**累计量首次 ≥ 总量 × ratio** 时的价位。
 *
 * 与 `percentile()` 的差别：`percentile()` 把每条订单当等权样本并在样本间线性插值；
 * 本函数把 `volume_remain` 当权重，且**不插值**。理由：在「以单位挂单量为样本」的等价视角下，
 * 同一价位的所有单位同价，跨价位边界处只在位置恰为整数时才不插值 —— 故取该档价格即是答案。
 */
export function weightedPercentile(levels: readonly OrderLevel[], ratio: number): number | null {
  const usable = levels.filter((level) => level.volume > 0);
  if (usable.length === 0) return null;
  const total = usable.reduce((sum, level) => sum + level.volume, 0);
  const target = total * ratio;
  const sorted = [...usable].sort((a, b) => a.price - b.price);
  let cumulative = 0;
  for (const level of sorted) {
    cumulative += level.volume;
    if (cumulative >= target) return level.price;
  }
  return sorted[sorted.length - 1].price;
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
