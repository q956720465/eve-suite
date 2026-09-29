import type { DbAdapter } from '../db/types';

import type { MarketDeps } from './on-demand';
import { refreshTypeHistory } from './on-demand';
import { MAX_TRADABLE_MIN_VOLUME, type OrderLevel } from './stats';

/**
 * 跨区价差视图（P5-2）
 *
 * 第一段（SQL 粗筛）：基于 market_stats 自连接，用 p5_sell（买入区卖价 5% 分位）
 * 对 p95_buy（卖出区买价 95% 分位）跨区配对，两侧分位口径天然抗单笔钓鱼单；
 * 叠加订单数硬门槛与价差率上限压制孤岛价。
 *
 * 第二段（候选历史校验，validateSpreadHistory）：对粗筛出线的候选按需拉取
 * ESI 日线历史，用 30 天均价锚（2.5×，参考 eve-hub.ru 口径）与卖出区近 7 天
 * 成交天数（≥4，参考 Oracle Market Genius 口径）识别钓鱼单与僵尸物品。
 */

/** 价差排序键 */
export type SpreadSortKey = 'spreadRate' | 'spreadIsk' | 'iskPerM3';

export interface SpreadQueryOptions {
  /** 买入区在架卖单数下限（压制孤岛卖单） */
  minSellOrders?: number;
  /** 卖出区在架买单数下限（压制孤岛买单） */
  minBuyOrders?: number;
  /** 价差率上限（0.3 = 30%；1 = 100%），拦截钓鱼单级别的天价差 */
  maxSpreadRate?: number;
  /** 参与配对的区域（买入区与卖出区都必须在清单内）；缺省为全部已采集区域 */
  regionIds?: readonly number[];
  /** 返回条数上限 */
  limit?: number;
  sortBy?: SpreadSortKey;
}

/** 筛选默认值（P5-2 方案 D3/D4 拍板口径） */
export const DEFAULT_SPREAD_FILTERS: Required<SpreadQueryOptions> = {
  minSellOrders: 5,
  minBuyOrders: 5,
  maxSpreadRate: 3,
  regionIds: [],
  limit: 50,
  sortBy: 'spreadRate',
};

/** 跨区价差行（买价 = 买入区 p5_sell；卖价 = 卖出区 p95_buy） */
export interface SpreadRow {
  typeId: number;
  /** 单个体积 m³（SDE；蓝包装等可能为 NULL） */
  typeVolume: number | null;
  buyRegionId: number;
  buyRegionNameEn: string;
  buyRegionNameZh: string | null;
  buyPrice: number;
  sellRegionId: number;
  sellRegionNameEn: string;
  sellRegionNameZh: string | null;
  sellPrice: number;
  /** 单件价差（ISK） */
  spreadIsk: number;
  /** 价差率（0.25 = 25%） */
  spreadRate: number;
  /** 买入区在架卖单数 */
  buySellOrders: number;
  /** 卖出区在架买单数 */
  sellBuyOrders: number;
  /** 单件价差 ÷ 单件体积（ISK/m³），体积缺失为 null */
  iskPerM3: number | null;
}

/** 快照新鲜度（D9：结果表上方展示数据是多久前的） */
export interface SpreadFreshness {
  minUpdatedAt: string | null;
  maxUpdatedAt: string | null;
  statsRows: number;
}

const SPREAD_SELECT = `SELECT b.type_id   AS typeId,
       t.volume    AS typeVolume,
       b.region_id AS buyRegionId,
       br.name_en  AS buyRegionNameEn,
       br.name_zh  AS buyRegionNameZh,
       b.p5_sell   AS buyPrice,
       s.region_id AS sellRegionId,
       sr.name_en  AS sellRegionNameEn,
       sr.name_zh  AS sellRegionNameZh,
       s.p95_buy   AS sellPrice,
       (s.p95_buy - b.p5_sell)                          AS spreadIsk,
       (CAST(s.p95_buy AS REAL) / b.p5_sell - 1)         AS spreadRate,
       b.sell_orders AS buySellOrders,
       s.buy_orders  AS sellBuyOrders,
       CASE
         WHEN t.volume IS NOT NULL AND t.volume > 0
           THEN (s.p95_buy - b.p5_sell) / t.volume
       END                                            AS iskPerM3
  FROM market_stats b
  JOIN market_stats s
    ON s.type_id = b.type_id AND s.region_id <> b.region_id
  LEFT JOIN sde_types t ON t.type_id = b.type_id
  JOIN sde_regions br ON br.region_id = b.region_id
  JOIN sde_regions sr ON sr.region_id = s.region_id
 WHERE b.p5_sell IS NOT NULL
   AND b.p5_sell > 0
   AND s.p95_buy IS NOT NULL
   AND s.p95_buy > b.p5_sell
   AND b.sell_orders >= ?
   AND s.buy_orders >= ?
   AND (CAST(s.p95_buy AS REAL) / b.p5_sell - 1) <= ?`;

const SORT_COLUMNS: Record<SpreadSortKey, string> = {
  spreadRate: 'spreadRate DESC',
  spreadIsk: 'spreadIsk DESC',
  iskPerM3: 'iskPerM3 DESC',
};

/** 跨区价差粗筛（单 SQL 全库完成，不把中间结果拉进 JS） */
export async function rankCrossRegionSpreads(
  db: DbAdapter,
  options: SpreadQueryOptions = {},
): Promise<SpreadRow[]> {
  const {
    minSellOrders,
    minBuyOrders,
    maxSpreadRate,
    regionIds,
    limit,
    sortBy,
  } = { ...DEFAULT_SPREAD_FILTERS, ...options };

  const hasRegionFilter = regionIds.length > 0;
  const regionPlaceholders = hasRegionFilter ? regionIds.map(() => '?').join(', ') : '';
  const regionClause = hasRegionFilter
    ? ` AND b.region_id IN (${regionPlaceholders}) AND s.region_id IN (${regionPlaceholders})`
    : '';

  const rows = await db.select<SpreadRow>(
    `${SPREAD_SELECT}${regionClause}
     ORDER BY ${SORT_COLUMNS[sortBy]} NULLS LAST, spreadRate DESC
     LIMIT ?`,
    hasRegionFilter
      ? [minSellOrders, minBuyOrders, maxSpreadRate, ...regionIds, ...regionIds, limit]
      : [minSellOrders, minBuyOrders, maxSpreadRate, limit],
  );
  return rows;
}

/** 参与价差配对的快照新鲜度 */
export async function getSpreadFreshness(
  db: DbAdapter,
  regionIds: readonly number[] = [],
): Promise<SpreadFreshness> {
  const hasRegionFilter = regionIds.length > 0;
  const regionClause = hasRegionFilter
    ? `WHERE region_id IN (${regionIds.map(() => '?').join(', ')})`
    : '';
  const rows = await db.select<{
    minUpdatedAt: string | null;
    maxUpdatedAt: string | null;
    statsRows: number;
  }>(
    `SELECT MIN(updated_at) AS minUpdatedAt, MAX(updated_at) AS maxUpdatedAt, COUNT(*) AS statsRows
       FROM market_stats ${regionClause}`,
    hasRegionFilter ? [...regionIds] : [],
  );
  return rows[0] ?? { minUpdatedAt: null, maxUpdatedAt: null, statsRows: 0 };
}

/* ------------------------- 第二段：候选历史校验 ------------------------- */

/** 30 天均价锚比值：候选价偏离本区 30 天均价超过该倍数视为操纵单（eve-hub.ru 口径） */
export const SPREAD_ANCHOR_RATIO = 2.5;

/** 卖出区近 7 天成交天数下限（Oracle Market Genius 口径：7 天里只有 2 天有成交的不算生意） */
export const SPREAD_MIN_ACTIVE_DAYS = 4;

/** 单区（region, type）的历史统计：30 天均价锚 + 近 7 天成交天数 */
export interface SpreadHistoryStats {
  avg30: number | null;
  activeDays7: number;
}

/** 历史校验未通过的原因 */
export type SpreadHistoryReason = 'no-history' | 'price-outlier' | 'inactive';

export interface SpreadHistoryVerdict {
  buyAvg30: number | null;
  sellAvg30: number | null;
  sellActiveDays7: number;
  reasons: SpreadHistoryReason[];
  passed: boolean;
}

/**
 * 纯函数：按两侧 30 天均价锚与卖出区近 7 天成交天数判定候选。
 * - 任一侧无历史数据 → no-history（新物品无法校验）
 * - 任一侧价格偏离本区 30 天均价超过 anchorRatio 倍 → price-outlier
 * - 卖出区近 7 天成交天数不足 → inactive
 */
export function judgeSpreadHistory(input: {
  buyPrice: number;
  sellPrice: number;
  buyAvg30: number | null;
  sellAvg30: number | null;
  sellActiveDays7: number;
  anchorRatio?: number;
  minActiveDays?: number;
}): SpreadHistoryVerdict {
  const anchorRatio = input.anchorRatio ?? SPREAD_ANCHOR_RATIO;
  const minActiveDays = input.minActiveDays ?? SPREAD_MIN_ACTIVE_DAYS;
  const reasons: SpreadHistoryReason[] = [];

  const hasBuyHistory = input.buyAvg30 !== null && input.buyAvg30 > 0;
  const hasSellHistory = input.sellAvg30 !== null && input.sellAvg30 > 0;
  if (!hasBuyHistory || !hasSellHistory) reasons.push('no-history');
  if (
    hasBuyHistory &&
    (input.buyPrice > input.buyAvg30! * anchorRatio ||
      input.buyPrice < input.buyAvg30! / anchorRatio)
  ) {
    reasons.push('price-outlier');
  }
  if (
    hasSellHistory &&
    (input.sellPrice > input.sellAvg30! * anchorRatio ||
      input.sellPrice < input.sellAvg30! / anchorRatio)
  ) {
    reasons.push('price-outlier');
  }
  if (input.sellActiveDays7 < minActiveDays) reasons.push('inactive');

  return {
    buyAvg30: input.buyAvg30,
    sellAvg30: input.sellAvg30,
    sellActiveDays7: input.sellActiveDays7,
    reasons,
    passed: reasons.length === 0,
  };
}

/** 读单区（region, type）的 30 天均价锚与近 7 天成交天数（一条 SQL 算完） */
export async function readSpreadHistoryStats(
  db: DbAdapter,
  regionId: number,
  typeId: number,
  now = Date.now(),
): Promise<SpreadHistoryStats> {
  const d30 = new Date(now - 29 * 86_400_000).toISOString().slice(0, 10);
  const d7 = new Date(now - 6 * 86_400_000).toISOString().slice(0, 10);
  const rows = await db.select<{ avg30: number | null; activeDays7: number }>(
    `SELECT AVG(CASE WHEN date >= ? THEN average END) AS avg30,
            SUM(CASE WHEN date >= ? AND volume > 0 THEN 1 ELSE 0 END) AS activeDays7
       FROM market_history_daily
      WHERE region_id = ? AND type_id = ?`,
    [d30, d7, regionId, typeId],
  );
  const row = rows[0];
  return { avg30: row?.avg30 ?? null, activeDays7: row?.activeDays7 ?? 0 };
}

/**
 * 对粗筛出线的候选执行历史校验：
 * 1. 汇总两侧 (region, type) 去重集合，逐个按需刷新日线历史
 *    （refreshTypeHistory 内部自带「今天已抓取则跳过」，ESI 24h 缓存 → 复看零请求）；
 * 2. 逐行读取两侧统计并判定，返回与候选行同序的 verdict 数组。
 *
 * 校验不过的行由 UI 降级标注展示，不在此处删除。
 */
export async function validateSpreadHistory(
  deps: MarketDeps,
  rows: readonly SpreadRow[],
  options: { now?: number } = {},
): Promise<SpreadHistoryVerdict[]> {
  const now = options.now ?? Date.now();

  const pairs = new Map<string, { regionId: number; typeId: number }>();
  for (const row of rows) {
    pairs.set(`${row.buyRegionId}:${row.typeId}`, {
      regionId: row.buyRegionId,
      typeId: row.typeId,
    });
    pairs.set(`${row.sellRegionId}:${row.typeId}`, {
      regionId: row.sellRegionId,
      typeId: row.typeId,
    });
  }
  for (const pair of pairs.values()) {
    await refreshTypeHistory(deps, pair.regionId, pair.typeId, { now });
  }

  const verdicts: SpreadHistoryVerdict[] = [];
  for (const row of rows) {
    const [buyStats, sellStats] = await Promise.all([
      readSpreadHistoryStats(deps.db, row.buyRegionId, row.typeId, now),
      readSpreadHistoryStats(deps.db, row.sellRegionId, row.typeId, now),
    ]);
    verdicts.push(
      judgeSpreadHistory({
        buyPrice: row.buyPrice,
        sellPrice: row.sellPrice,
        buyAvg30: buyStats.avg30,
        sellAvg30: sellStats.avg30,
        sellActiveDays7: sellStats.activeDays7,
      }),
    );
  }
  return verdicts;
}

/* --------------------- 第三段：订单簿深度走量（P11-2） --------------------- */

/**
 * 订单簿深度走量（P11-2）
 *
 * 解决的问题：价差页的「买价」是买入区的 `p5_sell`（第 5% 分位**挂单价**）—— 它是**理论价**，
 * 不回答「我要吃下 Q 个单位，实际均价是多少」。Q 一大就可能把便宜档吃穿，真实成本显著高于 p5。
 *
 * 口径（P11-2 定稿）：
 * - **只吃买入区的卖单**（与 `p5_sell` 同侧）：`is_buy_order = 0` 且 `min_volume <= 1`（沿用 P7-1，不另立筛选）
 * - **可成交均价** = `Σ(price × 吃到的量) / 实际吃到量` —— 按价格升序累积 `volume_remain` 直到吃满 Q
 * - **量不足**不造假价：按**实际可吃量**给均价，同时回报 `availableQuantity` 与 `sufficient=false`
 * - **完全无卖单** → `averagePrice = null`（调用方显示「无卖单」，不要与 0 混淆）
 *
 * 引擎只读本地库，**零 ESI 请求**。
 */

/** 目标量默认值（单位） */
export const DEFAULT_SPREAD_DEPTH_QUANTITY = 1000;

/** 目标量上限（防呆，避免误输入天文数字） */
export const MAX_SPREAD_DEPTH_QUANTITY = 1_000_000;

/** 深度查询目标：某区域的某物品（价差页用「买入区」） */
export interface SpreadDepthTarget {
  regionId: number;
  typeId: number;
}

/** 单个目标的深度结果 */
export interface SpreadDepthResult {
  /** 按目标量吃单的 VWAP；无卖单为 null */
  averagePrice: number | null;
  /** 实际吃到的量（≤ 目标量；无卖单为 0） */
  filledQuantity: number;
  /** 该区在架可吃总量（已排除 `min_volume > 1` 的整批大单） */
  availableQuantity: number;
  /** 在架量是否够吃满目标量 */
  sufficient: boolean;
}

/**
 * 深度结果键。**UI 请用本函数查表**，不要自造格式
 * （格式与 `validateSpreadHistory` 内部所用一致：`<regionId>:<typeId>`）。
 */
export function spreadDepthKey(regionId: number, typeId: number): string {
  return `${regionId}:${typeId}`;
}

/** 归一化目标量：非法值回退默认、取整、钳制到 `[1, MAX_SPREAD_DEPTH_QUANTITY]` */
export function normalizeSpreadDepthQuantity(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_SPREAD_DEPTH_QUANTITY;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_SPREAD_DEPTH_QUANTITY);
}

/** 单次 `type_id IN (...)` 的批量上限（保守低于 SQLite 变量上限） */
const DEPTH_TYPE_CHUNK = 500;

/**
 * 批量计算「按目标量吃单的可成交均价」。
 *
 * 入参 `targets` 可有重复（内部按 `(regionId, typeId)` 去重）；返回以 `spreadDepthKey` 为键的 Map。
 * 缺省目标量为 `DEFAULT_SPREAD_DEPTH_QUANTITY`；非法值自动归一化。
 */
export async function computeSpreadDepth(
  db: DbAdapter,
  targets: readonly SpreadDepthTarget[],
  targetQuantity: number = DEFAULT_SPREAD_DEPTH_QUANTITY,
): Promise<Map<string, SpreadDepthResult>> {
  const quantity = normalizeSpreadDepthQuantity(targetQuantity);
  const result = new Map<string, SpreadDepthResult>();
  if (targets.length === 0) return result;

  // 按区域归组（每区一次批量查询；同区同物品只保留一份）
  const typeIdsByRegion = new Map<number, number[]>();
  for (const target of targets) {
    const list = typeIdsByRegion.get(target.regionId);
    if (list === undefined) typeIdsByRegion.set(target.regionId, [target.typeId]);
    else if (!list.includes(target.typeId)) list.push(target.typeId);
  }

  for (const [regionId, typeIds] of typeIdsByRegion) {
    const levelsByType = await loadSellLevels(db, regionId, typeIds);
    for (const typeId of typeIds) {
      result.set(
        spreadDepthKey(regionId, typeId),
        computeDepth(levelsByType.get(typeId) ?? [], quantity),
      );
    }
  }
  return result;
}

/** 读某区若干物品的卖单明细（价升序），口径与 `p5_sell` 一致（排除整批大单） */
async function loadSellLevels(
  db: DbAdapter,
  regionId: number,
  typeIds: readonly number[],
): Promise<Map<number, OrderLevel[]>> {
  const map = new Map<number, OrderLevel[]>();
  for (let offset = 0; offset < typeIds.length; offset += DEPTH_TYPE_CHUNK) {
    const chunk = typeIds.slice(offset, offset + DEPTH_TYPE_CHUNK);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => '?').join(', ');
    // `INDEXED BY idx_market_orders_type` 是**必需的性能提示**：对「单类型」区域，
    // planner 会误选 `idx_market_orders_side (region_id, is_buy_order, price)` 以省掉
    // 排序，但代价是**扫整个区该买卖侧**（枢纽区数十万行 → 单查 40–70 ms）；
    // 强制走类型索引则直接 seek 到该 type_id（多类型 IN 列表本就选它）。见 DEV_STATUS「P11-5」
    const rows = await db.select<{ typeId: number; price: number; volume: number }>(
      `SELECT type_id AS typeId, price AS price, volume_remain AS volume
         FROM market_orders INDEXED BY idx_market_orders_type
        WHERE region_id = ? AND type_id IN (${placeholders}) AND is_buy_order = 0
          AND min_volume <= ?
        ORDER BY type_id, price ASC`,
      [regionId, ...chunk, MAX_TRADABLE_MIN_VOLUME],
    );
    for (const row of rows) {
      const list = map.get(row.typeId);
      if (list === undefined) map.set(row.typeId, [{ price: row.price, volume: row.volume }]);
      else list.push({ price: row.price, volume: row.volume });
    }
  }
  return map;
}

/**
 * 逐档吃单：`levels` 必须**按价格升序**（由 `loadSellLevels` 的 SQL 保证）。
 * 量不足时按实际可吃量算均价；无有效挂单返回 `averagePrice = null`。
 */
function computeDepth(levels: readonly OrderLevel[], targetQuantity: number): SpreadDepthResult {
  let availableQuantity = 0;
  for (const level of levels) {
    if (level.volume > 0) availableQuantity += level.volume;
  }
  if (availableQuantity <= 0) {
    return { averagePrice: null, filledQuantity: 0, availableQuantity: 0, sufficient: false };
  }

  let filledQuantity = 0;
  let cost = 0;
  for (const level of levels) {
    if (level.volume <= 0) continue;
    const take = Math.min(level.volume, targetQuantity - filledQuantity);
    if (take <= 0) break;
    filledQuantity += take;
    cost += level.price * take;
    if (filledQuantity >= targetQuantity) break;
  }

  return {
    averagePrice: cost / filledQuantity,
    filledQuantity,
    availableQuantity,
    sufficient: availableQuantity >= targetQuantity,
  };
}

/* --------------------- 第四段：流动性与库存天数（P11-3） --------------------- */

/**
 * 流动性与库存天数（P11-3）
 *
 * 解决的问题：价差页只给价格与订单**笔数**，不回答「这单能不能做成」。本段补两个指标：
 * - `activeDays7`：近 7 天**有成交**的天数 —— **与 `readSpreadHistoryStats` 完全同口径**，
 *   故与历史校验的 `inactive` 门槛（卖出区 ≥ `SPREAD_MIN_ACTIVE_DAYS` 天）读数一致，
 *   用户可直接**预告校验结果**，不会出现「列说够活跃、校验说不活跃」的自相矛盾
 * - `daysOfSupply`（库存天数）：在架卖量 ÷ 近 30 天日均成交量 ——
 *   数值大＝便宜货堆积、`p5_sell` 更可能是真实可买价；数值小＝那点量随时秒没（与 P11-2 深度互补）
 *
 * ⚠️ **只读已入库日线，绝不触发 ESI**（不调用 `refreshTypeHistory`）：日线覆盖是
 * 「5 枢纽全量 + 按需拉取过的 pair」（P5-2.8），故非枢纽区多为 `null` → UI 显示「无历史」。
 *
 * ⚠️ 「近 7 天 / 近 30 天」窗口锚定**当前时刻**（与既有实现一致）。ESI 日线滞后约 2 天时，
 * 窗口内可用天数会少于 7 —— 这是既有口径，本段**刻意不改**，否则会与历史校验读数分叉。
 */

/** 流动性统计目标：某区域的某物品（价差页对买入区与卖出区各查一次） */
export interface SpreadLiquidityTarget {
  regionId: number;
  typeId: number;
}

/** 单区（region, type）的流动性与供给统计 */
export interface SpreadLiquidityStats {
  /** 近 7 天有成交的天数（0–7；与历史校验同口径） */
  activeDays7: number;
  /** 近 30 天日均成交量（按**有数据的天数**平均）；无历史为 null */
  avgVolume30: number | null;
  /** 在架卖量（已排除 `min_volume > 1` 的整批大单） */
  sellVolume: number;
  /** 库存天数 = 在架卖量 ÷ 日均成交量；无历史或日均量为 0 时为 null（**不要显示 ∞**） */
  daysOfSupply: number | null;
}

/** 单次 `type_id IN (...)` 的批量上限 */
const LIQUIDITY_TYPE_CHUNK = 500;

/**
 * 批量读取流动性统计。入参可有重复（内部按 `(regionId, typeId)` 去重）；
 * 返回 Map 的**键格式与 `spreadDepthKey()` 相同**（`<regionId>:<typeId>`），UI 用同一个 helper 查表。
 */
export async function readSpreadLiquidityStats(
  db: DbAdapter,
  targets: readonly SpreadLiquidityTarget[],
  now = Date.now(),
): Promise<Map<string, SpreadLiquidityStats>> {
  const result = new Map<string, SpreadLiquidityStats>();
  if (targets.length === 0) return result;

  const d30 = new Date(now - 29 * 86_400_000).toISOString().slice(0, 10);
  const d7 = new Date(now - 6 * 86_400_000).toISOString().slice(0, 10);

  // 按区域归组（每区两轮批量查询；同区同物品只保留一份）
  const typeIdsByRegion = new Map<number, number[]>();
  for (const target of targets) {
    const list = typeIdsByRegion.get(target.regionId);
    if (list === undefined) typeIdsByRegion.set(target.regionId, [target.typeId]);
    else if (!list.includes(target.typeId)) list.push(target.typeId);
  }

  for (const [regionId, typeIds] of typeIdsByRegion) {
    const history = new Map<number, { activeDays7: number; avgVolume30: number | null }>();
    const sellVolumes = new Map<number, number>();

    for (let offset = 0; offset < typeIds.length; offset += LIQUIDITY_TYPE_CHUNK) {
      const chunk = typeIds.slice(offset, offset + LIQUIDITY_TYPE_CHUNK);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => '?').join(', ');

      // 窗口口径与 readSpreadHistoryStats 逐字对齐（仅把 average 换成 volume）
      const historyRows = await db.select<{
        typeId: number;
        avgVolume30: number | null;
        activeDays7: number;
      }>(
        `SELECT type_id AS typeId,
                AVG(CASE WHEN date >= ? THEN volume END) AS avgVolume30,
                SUM(CASE WHEN date >= ? AND volume > 0 THEN 1 ELSE 0 END) AS activeDays7
           FROM market_history_daily
          WHERE region_id = ? AND type_id IN (${placeholders})
          GROUP BY type_id`,
        [d30, d7, regionId, ...chunk],
      );
      for (const row of historyRows) {
        history.set(row.typeId, {
          activeDays7: row.activeDays7 ?? 0,
          avgVolume30: row.avgVolume30,
        });
      }

      const statsRows = await db.select<{ typeId: number; sellVolume: number | null }>(
        `SELECT type_id AS typeId, sell_volume AS sellVolume
           FROM market_stats
          WHERE region_id = ? AND type_id IN (${placeholders})`,
        [regionId, ...chunk],
      );
      for (const row of statsRows) sellVolumes.set(row.typeId, row.sellVolume ?? 0);
    }

    for (const typeId of typeIds) {
      const entry = history.get(typeId);
      const sellVolume = sellVolumes.get(typeId) ?? 0;
      const avgVolume30 = entry?.avgVolume30 ?? null;
      result.set(spreadDepthKey(regionId, typeId), {
        activeDays7: entry?.activeDays7 ?? 0,
        avgVolume30,
        sellVolume,
        // 日均量缺失或为 0 → 不给「无穷天」这种假读数
        daysOfSupply: avgVolume30 !== null && avgVolume30 > 0 ? sellVolume / avgVolume30 : null,
      });
    }
  }
  return result;
}

/* --------------------- 第五段：现实捕获份额（P11-4） --------------------- */

/**
 * 现实捕获份额（P11-4）
 *
 * 解决的问题：价差页的「买价 / 卖价」两侧都是**分位挂单价**（买入区 `p5_sell` 对卖出区 `p95_buy`），
 * 它们是各自订单簿上的**两个独立读数** —— 从未回答「若我同时吃两边，到底能成交多少单位、还剩多少毛利」。
 * `p5_sell < p95_buy` 只说明「两边各有一档挂单价差为正」，**不保证**这两档能对上量。
 *
 * 口径（P11-4 定稿，**两簿边际交叉点**）：
 * - **成本侧** = 买入区的**卖单**，价格**升序**，`is_buy_order = 0` 且 `min_volume <= 1`（与 P11-2 逐字一致）
 * - **收益侧** = 卖出区的**买单**，价格**降序**，`is_buy_order = 1` 且 `min_volume <= 1`，
 *   并**剔除价格高于 `market_stats.p95_buy` 的买单**（与价差页「卖价」同源，钓鱼单不进走量）
 * - **两指针贪心配对**（最便宜的买 ← 最贵的卖）：`margin_i = rev_i − cost_i` 对 i **单调不增**，
 *   故「边际为正」的区间是一段前缀：**可捕获量 `q*` = 使 `margin_i > 0`（严格）的最大单位数**
 * - **不按目标量截断扫描**：`q*` 只由两簿形状决定，与页面「目标量 Q」无关 → 改 Q **零查询**，
 *   份额 `q* / Q` 由 UI 在渲染时重算（**本函数不封顶，可 > 1**）
 * - 单侧无可用挂单：`q* = 0` 且置 `noSellOrders` / `noBuyOrders`（供 UI 区分「无卖单 / 无买单」）
 *
 * 引擎只读本地库，**零 ESI 请求**。
 */

/** 现实捕获目标：成本侧 = 买入区（吃它的卖单），收益侧 = 卖出区（卖给它的买单） */
export interface SpreadCaptureTarget {
  typeId: number;
  /** 成本侧区域：吃它的卖单 */
  buyRegionId: number;
  /** 收益侧区域：卖给它的买单 */
  sellRegionId: number;
}

/** 单个目标的两簿走量结果 */
export interface SpreadCaptureResult {
  /** q*：两簿走量后仍保持**边际为正**的最大单位数（与目标量 Q 无关） */
  captureQuantity: number;
  /** 前 q* 单位的成本合计（买入区卖单侧） */
  costTotal: number;
  /** 前 q* 单位的收益合计（卖出区买单侧） */
  revenueTotal: number;
  /** 毛利合计 = `revenueTotal − costTotal`（q* > 0 时必为正） */
  marginTotal: number;
  /** 成本侧无可用卖单（已排除 `min_volume > 1`） */
  noSellOrders: boolean;
  /** 收益侧无可用买单（已排除 `min_volume > 1`，并按 `p95_buy` 截断） */
  noBuyOrders: boolean;
}

/**
 * 捕获结果键。**UI 请用本函数查表**，不要自造格式
 * （格式与价差页行键同形：`<typeId>:<buyRegionId>:<sellRegionId>`）。
 */
export function spreadCaptureKey(typeId: number, buyRegionId: number, sellRegionId: number): string {
  return `${typeId}:${buyRegionId}:${sellRegionId}`;
}

/**
 * 批量计算「两簿边际交叉点」。入参可有重复（内部按 `(typeId, buyRegionId, sellRegionId)` 去重）；
 * 返回以 `spreadCaptureKey` 为键的 Map。`q*` 不依赖目标量 → **改目标量不发任何查询**。
 */
export async function computeSpreadCapture(
  db: DbAdapter,
  targets: readonly SpreadCaptureTarget[],
): Promise<Map<string, SpreadCaptureResult>> {
  const result = new Map<string, SpreadCaptureResult>();
  if (targets.length === 0) return result;

  // 同一 `(regionId, typeId)` 可能同时作为成本侧与收益侧（如 A→B 与 B→A 反向行同时在表）
  const sellNeed = new Map<number, number[]>();
  const buyNeed = new Map<number, number[]>();
  const addNeed = (map: Map<number, number[]>, regionId: number, typeId: number): void => {
    const list = map.get(regionId);
    if (list === undefined) map.set(regionId, [typeId]);
    else if (!list.includes(typeId)) list.push(typeId);
  };
  for (const target of targets) {
    addNeed(sellNeed, target.buyRegionId, target.typeId);
    addNeed(buyNeed, target.sellRegionId, target.typeId);
  }

  // 成本侧：卖单明细（价升序）
  const sellLevels = new Map<string, OrderLevel[]>();
  for (const [regionId, typeIds] of sellNeed) {
    const byType = await loadSellLevels(db, regionId, typeIds);
    for (const [typeId, levels] of byType) sellLevels.set(spreadDepthKey(regionId, typeId), levels);
  }

  // 收益侧：买单明细（价降序）+ p95_buy 截断阈值
  const buyLevels = new Map<string, OrderLevel[]>();
  const buyP95 = new Map<string, number | null>();
  for (const [regionId, typeIds] of buyNeed) {
    const byType = await loadBuyLevels(db, regionId, typeIds);
    for (const [typeId, levels] of byType) buyLevels.set(spreadDepthKey(regionId, typeId), levels);
    const p95ByType = await loadBuyP95(db, regionId, typeIds);
    for (const [typeId, value] of p95ByType) {
      buyP95.set(spreadDepthKey(regionId, typeId), value);
    }
  }

  for (const target of targets) {
    const costLevels = sellLevels.get(spreadDepthKey(target.buyRegionId, target.typeId)) ?? [];
    const revenueLevels = truncateBuyLevels(
      buyLevels.get(spreadDepthKey(target.sellRegionId, target.typeId)) ?? [],
      buyP95.get(spreadDepthKey(target.sellRegionId, target.typeId)) ?? null,
    );
    result.set(
      spreadCaptureKey(target.typeId, target.buyRegionId, target.sellRegionId),
      pairCapture(costLevels, revenueLevels),
    );
  }
  return result;
}

/** 读某区若干物品的买单明细（价降序），口径与 `p95_buy` 同侧（排除整批大单） */
async function loadBuyLevels(
  db: DbAdapter,
  regionId: number,
  typeIds: readonly number[],
): Promise<Map<number, OrderLevel[]>> {
  const map = new Map<number, OrderLevel[]>();
  for (let offset = 0; offset < typeIds.length; offset += DEPTH_TYPE_CHUNK) {
    const chunk = typeIds.slice(offset, offset + DEPTH_TYPE_CHUNK);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => '?').join(', ');
    // 同 `loadSellLevels`：必须 `INDEXED BY idx_market_orders_type`，否则「单类型」区域会被扫全区买单侧
    const rows = await db.select<{ typeId: number; price: number; volume: number }>(
      `SELECT type_id AS typeId, price AS price, volume_remain AS volume
         FROM market_orders INDEXED BY idx_market_orders_type
        WHERE region_id = ? AND type_id IN (${placeholders}) AND is_buy_order = 1
          AND min_volume <= ?
        ORDER BY type_id, price DESC`,
      [regionId, ...chunk, MAX_TRADABLE_MIN_VOLUME],
    );
    for (const row of rows) {
      const list = map.get(row.typeId);
      if (list === undefined) map.set(row.typeId, [{ price: row.price, volume: row.volume }]);
      else list.push({ price: row.price, volume: row.volume });
    }
  }
  return map;
}

/** 读某区若干物品的 `p95_buy`（卖价同源；缺失为 null） */
async function loadBuyP95(
  db: DbAdapter,
  regionId: number,
  typeIds: readonly number[],
): Promise<Map<number, number | null>> {
  const map = new Map<number, number | null>();
  for (let offset = 0; offset < typeIds.length; offset += DEPTH_TYPE_CHUNK) {
    const chunk = typeIds.slice(offset, offset + DEPTH_TYPE_CHUNK);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await db.select<{ typeId: number; p95Buy: number | null }>(
      `SELECT type_id AS typeId, p95_buy AS p95Buy
         FROM market_stats
        WHERE region_id = ? AND type_id IN (${placeholders})`,
      [regionId, ...chunk],
    );
    for (const row of rows) map.set(row.typeId, row.p95Buy);
  }
  return map;
}

/**
 * 按 `p95_buy` 截断买单：剔除价格**高于** p95 的买单（钓鱼单不进走量）。
 * `p95` 为 null（无买单/无统计）时**不截断**，交给 `pairCapture` 判定空簿。
 */
function truncateBuyLevels(levels: readonly OrderLevel[], p95: number | null): OrderLevel[] {
  if (p95 === null) return [...levels];
  return levels.filter((level) => level.price <= p95);
}

/**
 * 两指针贪心配对：`costLevels` **价格升序**、`revenueLevels` **价格降序**（均由 SQL 保证）。
 * 逐单位取「最便宜的买 ← 最贵的卖」，一旦边际 ≤ 0 立即停止（边际单调不增，后面只会更差）。
 */
function pairCapture(
  costLevels: readonly OrderLevel[],
  revenueLevels: readonly OrderLevel[],
): SpreadCaptureResult {
  const costs = costLevels.filter((level) => level.volume > 0);
  const revenues = revenueLevels.filter((level) => level.volume > 0);
  const empty = (noSellOrders: boolean, noBuyOrders: boolean): SpreadCaptureResult => ({
    captureQuantity: 0,
    costTotal: 0,
    revenueTotal: 0,
    marginTotal: 0,
    noSellOrders,
    noBuyOrders,
  });
  if (costs.length === 0) return empty(true, revenues.length === 0);
  if (revenues.length === 0) return empty(false, true);

  let i = 0;
  let j = 0;
  let usedCost = 0;
  let usedRevenue = 0;
  let captureQuantity = 0;
  let costTotal = 0;
  let revenueTotal = 0;

  while (i < costs.length && j < revenues.length) {
    const cost = costs[i];
    const revenue = revenues[j];
    const marginPerUnit = revenue.price - cost.price;
    if (marginPerUnit <= 0) break;

    const costRemain = cost.volume - usedCost;
    const revenueRemain = revenue.volume - usedRevenue;
    const take = Math.min(costRemain, revenueRemain);
    captureQuantity += take;
    costTotal += cost.price * take;
    revenueTotal += revenue.price * take;

    usedCost += take;
    usedRevenue += take;
    if (usedCost >= cost.volume) {
      i += 1;
      usedCost = 0;
    }
    if (usedRevenue >= revenue.volume) {
      j += 1;
      usedRevenue = 0;
    }
  }

  return {
    captureQuantity,
    costTotal,
    revenueTotal,
    marginTotal: revenueTotal - costTotal,
    noSellOrders: false,
    noBuyOrders: false,
  };
}
