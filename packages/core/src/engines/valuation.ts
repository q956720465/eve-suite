import type { DbAdapter } from '../db/types';
import { percentile } from '../market/stats';

/**
 * 估值引擎（方案 §1 / §6.3 / §9）——全站唯一的价格出口。
 *
 * 口径（P4-1 定稿）：
 * - 价格口径 `basis`：`p5_sell`（卖价 5% 分位，默认，抗「1 ISK 钓鱼单」）；
 *   `best_sell`（最低卖价，P3 旧口径，保留供对照）
 * - 回退链：主口径 → 另一口径 → 无报价（null，调用方计 0 并计入 missing）
 * - 基准：`regionId` 默认吉他 The Forge；指定 `stationId` 后按订单簿 `location_id` 重算
 *   （`market_stats` 只有区域级指标，站点级必须回到 `market_orders`）
 * - 离群过滤（可选）：剔除高于「中位数 × multiple」的卖单（方案 §9，默认 10 倍）
 *
 * 引擎**只读本地库**，不发任何 ESI 请求（离线可算）。
 */

/** 默认估值基准区域：吉他 The Forge */
export const DEFAULT_VALUATION_REGION_ID = 10000002;

/** 默认价格口径：卖价 5% 分位（防操纵） */
export const DEFAULT_VALUATION_BASIS: ValuationBasis = 'p5_sell';

/** 默认离群倍数阈值：10 倍中位数（方案 §9） */
export const DEFAULT_OUTLIER_MULTIPLE = 10;

/** 价格口径 */
export type ValuationBasis = 'p5_sell' | 'best_sell';

/** 价格来源：stats=聚合指标快路径；orders=订单簿重算；fallback=主口径缺失改用它口径；missing=无报价 */
export type ValuationSource = 'stats' | 'orders' | 'fallback' | 'missing';

export interface ValuationOptions {
  /** 基准区域，默认吉他 10000002 */
  regionId?: number;
  /** 站点级基准：指定后按 `market_orders.location_id` 过滤重算 */
  stationId?: number | null;
  /** 价格口径，默认 `p5_sell` */
  basis?: ValuationBasis;
  /** 是否剔除离群卖单（10 倍中位数规则）；置 true 时走订单簿重算 */
  filterOutliers?: boolean;
  /** 离群倍数阈值，默认 10 */
  outlierMultiple?: number;
}

/** 单个物品的估值结论 */
export interface TypeValuation {
  typeId: number;
  regionId: number;
  stationId: number | null;
  /** 调用方请求的口径 */
  basis: ValuationBasis;
  /** 最终价格；null = 无报价（调用方计 0） */
  price: number | null;
  source: ValuationSource;
  /** 实际生效的口径（回退发生时与 `basis` 不同） */
  effectiveBasis: ValuationBasis | null;
}

export interface ValuationItem {
  typeId: number;
  quantity: number;
}

export interface BatchValuationItem extends ValuationItem {
  unitPrice: number | null;
  /** 数量 × 单价；无报价计 0 */
  value: number;
  source: ValuationSource;
  effectiveBasis: ValuationBasis | null;
}

export interface BatchValuation {
  /** 与入参同序同长 */
  items: BatchValuationItem[];
  totalValue: number;
  /** 无报价的物品（按首次出现顺序去重） */
  missingTypeIds: number[];
  /** 参与估值的物品种类数 */
  distinctTypeCount: number;
}

interface PriceResolution {
  price: number | null;
  source: ValuationSource;
  effectiveBasis: ValuationBasis | null;
}

interface StatsPriceRow {
  typeId: number;
  bestSell: number | null;
  p5Sell: number | null;
}

interface ResolvedValuationOptions {
  regionId: number;
  stationId: number | null;
  basis: ValuationBasis;
  filterOutliers: boolean;
  outlierMultiple: number;
  /** 是否需要读订单簿重算（站点级基准 或 开启离群过滤） */
  precise: boolean;
}

/** `IN (...)` 分批上限：保守低于各 SQLite 构建的变量上限 */
const TYPE_ID_CHUNK = 900;

const STATS_SELECT = `SELECT type_id   AS typeId,
                             best_sell AS bestSell,
                             p5_sell   AS p5Sell
                        FROM market_stats
                       WHERE region_id = ? AND type_id = ?`;

const MISSING: PriceResolution = { price: null, source: 'missing', effectiveBasis: null };

/** 仅接受正有限价格（0 / 负价 / NaN 一律视为无报价） */
function isUsablePrice(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** 去掉非正价格（0/负价不参与估值） */
export function positivePrices(prices: readonly number[]): number[] {
  return prices.filter((price) => isUsablePrice(price));
}

/**
 * 离群过滤（方案 §9）：以中位数为基准，剔除高于 `median × multiple` 的卖单。
 * 中位数不可用（样本为空 / 非正 / 阈值非法）时原样返回。
 */
export function filterOutlierPrices(
  prices: readonly number[],
  multiple: number = DEFAULT_OUTLIER_MULTIPLE,
): number[] {
  const clean = positivePrices(prices);
  if (clean.length === 0) return clean;
  const median = percentile(clean, 0.5);
  if (median === null || !isUsablePrice(median)) return clean;
  if (!Number.isFinite(multiple) || multiple <= 0) return clean;
  const ceiling = median * multiple;
  return clean.filter((price) => price <= ceiling);
}

/** 由卖单价格集合取口径价：`p5_sell` = 5% 分位；`best_sell` = 最低价 */
export function priceFromSellPrices(
  prices: readonly number[],
  basis: ValuationBasis,
): number | null {
  const clean = positivePrices(prices);
  if (clean.length === 0) return null;
  if (basis === 'best_sell') {
    let lowest = clean[0];
    for (const price of clean) if (price < lowest) lowest = price;
    return lowest;
  }
  return percentile(clean, 0.05);
}

function resolveOptions(options: ValuationOptions): ResolvedValuationOptions {
  const stationId = options.stationId ?? null;
  const filterOutliers = options.filterOutliers === true;
  return {
    regionId: options.regionId ?? DEFAULT_VALUATION_REGION_ID,
    stationId,
    basis: options.basis ?? DEFAULT_VALUATION_BASIS,
    filterOutliers,
    outlierMultiple: options.outlierMultiple ?? DEFAULT_OUTLIER_MULTIPLE,
    precise: stationId !== null || filterOutliers,
  };
}

/** 由聚合指标行解析：主口径 → 另一口径 → 无报价 */
function resolveFromStats(row: StatsPriceRow | undefined, basis: ValuationBasis): PriceResolution {
  const primary = basis === 'p5_sell' ? row?.p5Sell : row?.bestSell;
  const secondary = basis === 'p5_sell' ? row?.bestSell : row?.p5Sell;
  if (isUsablePrice(primary)) return { price: primary, source: 'stats', effectiveBasis: basis };
  if (isUsablePrice(secondary)) {
    const other: ValuationBasis = basis === 'p5_sell' ? 'best_sell' : 'p5_sell';
    return { price: secondary, source: 'fallback', effectiveBasis: other };
  }
  return MISSING;
}

/** 由订单簿卖价解析；样本为空（或过滤后为空）返回 null 交由调用方决定回退 */
function resolveFromOrders(
  prices: readonly number[] | undefined,
  resolved: ResolvedValuationOptions,
): PriceResolution | null {
  if (prices === undefined) return null;
  const clean = positivePrices(prices);
  if (clean.length === 0) return null;
  const usable = resolved.filterOutliers
    ? filterOutlierPrices(clean, resolved.outlierMultiple)
    : clean;
  const price = priceFromSellPrices(usable, resolved.basis);
  if (!isUsablePrice(price)) return null;
  return { price, source: 'orders', effectiveBasis: resolved.basis };
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const parts: T[][] = [];
  for (let start = 0; start < values.length; start += size) {
    parts.push(values.slice(start, start + size));
  }
  return parts;
}

/** 批量读取聚合指标行 */
async function loadStatsByTypes(
  db: DbAdapter,
  typeIds: readonly number[],
  regionId: number,
): Promise<Map<number, StatsPriceRow>> {
  const map = new Map<number, StatsPriceRow>();
  for (const part of chunk(typeIds, TYPE_ID_CHUNK)) {
    const placeholders = part.map(() => '?').join(', ');
    const rows = await db.select<StatsPriceRow>(
      `SELECT type_id   AS typeId,
              best_sell AS bestSell,
              p5_sell   AS p5Sell
         FROM market_stats
        WHERE region_id = ? AND type_id IN (${placeholders})`,
      [regionId, ...part],
    );
    for (const row of rows) map.set(row.typeId, row);
  }
  return map;
}

/** 批量读取卖单价格（按 type_id 分组，价格升序） */
async function loadSellPricesByTypes(
  db: DbAdapter,
  typeIds: readonly number[],
  regionId: number,
  stationId: number | null,
): Promise<Map<number, number[]>> {
  const map = new Map<number, number[]>();
  for (const part of chunk(typeIds, TYPE_ID_CHUNK)) {
    const placeholders = part.map(() => '?').join(', ');
    const params: unknown[] = [regionId, ...part];
    let sql = `SELECT type_id AS typeId, price AS price
                 FROM market_orders
                WHERE region_id = ? AND type_id IN (${placeholders}) AND is_buy_order = 0`;
    if (stationId !== null) {
      sql += ' AND location_id = ?';
      params.push(stationId);
    }
    sql += ' ORDER BY type_id, price ASC';

    const rows = await db.select<{ typeId: number; price: number }>(sql, params);
    for (const row of rows) {
      const list = map.get(row.typeId);
      if (list === undefined) map.set(row.typeId, [row.price]);
      else list.push(row.price);
    }
  }
  return map;
}

/** 单物品估值 */
async function resolveSingleType(
  db: DbAdapter,
  typeId: number,
  resolved: ResolvedValuationOptions,
): Promise<PriceResolution> {
  if (!resolved.precise) {
    const rows = await db.select<StatsPriceRow>(STATS_SELECT, [resolved.regionId, typeId]);
    return resolveFromStats(rows[0], resolved.basis);
  }

  const orderPrices = await loadSellPricesByTypes(db, [typeId], resolved.regionId, resolved.stationId);
  const fromOrders = resolveFromOrders(orderPrices.get(typeId), resolved);
  if (fromOrders !== null) return fromOrders;

  // 站点级基准是显式指定，不回退到区域价；区域级精确重算为空则退回聚合快路径
  if (resolved.stationId !== null) return MISSING;
  const rows = await db.select<StatsPriceRow>(STATS_SELECT, [resolved.regionId, typeId]);
  return resolveFromStats(rows[0], resolved.basis);
}

/**
 * 单个物品的估值（含口径与来源）。
 *
 * @example
 * const { price } = await getValuationPrice(db, 34);                    // 吉他 5% 分位
 * await getValuationPrice(db, 34, { stationId: 60003760 });             // 站点级
 * await getValuationPrice(db, 34, { filterOutliers: true });            // 剔除 10 倍离群
 */
export async function getValuationPrice(
  db: DbAdapter,
  typeId: number,
  options: ValuationOptions = {},
): Promise<TypeValuation> {
  const resolved = resolveOptions(options);
  const resolution = await resolveSingleType(db, typeId, resolved);
  return {
    typeId,
    regionId: resolved.regionId,
    stationId: resolved.stationId,
    basis: resolved.basis,
    ...resolution,
  };
}

/** 单物品按数量估值；无报价计 0 */
export async function valueQuantity(
  db: DbAdapter,
  typeId: number,
  quantity: number,
  options: ValuationOptions = {},
): Promise<number> {
  const { price } = await getValuationPrice(db, typeId, options);
  return price === null ? 0 : price * quantity;
}

/**
 * 批量估值（净值 / 资产页 / 缺口清单的统入口）：
 * 同口径下只做一次批量查询，返回与入参同序的结果。
 */
export async function valueItems(
  db: DbAdapter,
  items: readonly ValuationItem[],
  options: ValuationOptions = {},
): Promise<BatchValuation> {
  const resolved = resolveOptions(options);
  const typeIds = [...new Set(items.map((item) => item.typeId))];

  const prices = new Map<number, PriceResolution>();
  if (typeIds.length > 0) {
    if (resolved.precise) {
      const orderPrices = await loadSellPricesByTypes(db, typeIds, resolved.regionId, resolved.stationId);
      const stats = resolved.stationId === null
        ? await loadStatsByTypes(db, typeIds, resolved.regionId)
        : null;
      for (const typeId of typeIds) {
        const fromOrders = resolveFromOrders(orderPrices.get(typeId), resolved);
        if (fromOrders !== null) {
          prices.set(typeId, fromOrders);
        } else if (stats !== null) {
          prices.set(typeId, resolveFromStats(stats.get(typeId), resolved.basis));
        } else {
          prices.set(typeId, MISSING);
        }
      }
    } else {
      const stats = await loadStatsByTypes(db, typeIds, resolved.regionId);
      for (const typeId of typeIds) {
        prices.set(typeId, resolveFromStats(stats.get(typeId), resolved.basis));
      }
    }
  }

  const resultItems: BatchValuationItem[] = items.map((item) => {
    const resolution = prices.get(item.typeId) ?? MISSING;
    return {
      typeId: item.typeId,
      quantity: item.quantity,
      unitPrice: resolution.price,
      value: resolution.price === null ? 0 : resolution.price * item.quantity,
      source: resolution.source,
      effectiveBasis: resolution.effectiveBasis,
    };
  });

  const missingTypeIds: number[] = [];
  for (const item of resultItems) {
    if (item.unitPrice === null && !missingTypeIds.includes(item.typeId)) {
      missingTypeIds.push(item.typeId);
    }
  }

  let totalValue = 0;
  for (const item of resultItems) totalValue += item.value;

  return { items: resultItems, totalValue, missingTypeIds, distinctTypeCount: typeIds.length };
}
