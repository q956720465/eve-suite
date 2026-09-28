import type { DbAdapter } from '../db/types';

import type { MarketDeps } from './on-demand';
import { refreshTypeHistory } from './on-demand';

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
