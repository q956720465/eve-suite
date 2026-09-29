import type { DbAdapter } from '../db/types';
import { toLikePattern } from '../sde/repo';

import type { OrderBook, OrderBookEntry } from './repo';

/**
 * P9-1-1 市场浏览查询层（只读）。
 *
 * 数据源：
 * - 分组树：SDE `sde_market_groups`（P9-1-0 引入）
 * - 物品：SDE `sde_types` —— **只有 `published = 1` 且挂了 `market_group_id` 的物品才在市场里**
 * - 报价：`market_orders` 最新快照，**按站点（`location_id`）聚合**
 *   - ⚠️ 区域订单端点**也包含玩家建筑（Upwell）单**：2026-09-29 真实库实测有 **121 个非 SDE 地点 /
 *     69,572 单（占全库 4.5%）**，且本仓库**从不调用** `/markets/structures/`，故这些单只能来自区域端点。
 *   - 因此本模块的「站点」**一律限定为 SDE 收录的 NPC 站**（建筑没有可显示的站名）；
 *     未收录的 `location_id` 会被 `requireStationScope` fail-fast 挡掉。
 *
 * 性能口径（2026-09-29 真实库实测，The Forge / 吉他 4-4 `60003760`）：
 * 「**先把子树收窄成物品集合，再用 `idx_market_orders_type (region_id, type_id)` 聚合站点订单**」
 * 为 **15~77 ms**；若反过来「先聚合全站订单再 LEFT JOIN」则为 **1.5~1.9 s**（差 20~100 倍）——
 * 故本模块一律采用前者，且**无需新增索引**。
 */

/** 市场分组引用（树路径等不需要计数的场景） */
export interface MarketGroupRef {
  marketGroupId: number;
  /** 根节点为 null */
  parentGroupId: number | null;
  nameEn: string;
  nameZh: string | null;
  iconId: number | null;
}

/** 左树节点：分组引用 + 直接子分组数 / 直接挂载物品数 */
export interface MarketGroupNode extends MarketGroupRef {
  /** 直接子分组数 */
  childCount: number;
  /** 直接挂在该分组下、且 `published = 1` 的物品数 */
  typeCount: number;
}

/** 中列 / 搜索行的站点报价部分 */
export interface MarketTypeQuote {
  /** 站点卖单最低价（无卖单为 null） */
  bestSell: number | null;
  /** 站点买单最高价（无买单为 null） */
  bestBuy: number | null;
  /** 站点卖单剩余量合计 */
  sellVolume: number;
  /** 站点买单剩余量合计 */
  buyVolume: number;
  /** 站点卖单条数 */
  sellOrders: number;
  /** 站点买单条数 */
  buyOrders: number;
}

/** 中列 / 搜索行（两者同一形状：都带所属市场分组名，便于展示归属） */
export interface MarketTypeRow extends MarketTypeQuote {
  typeId: number;
  nameEn: string;
  nameZh: string | null;
  volume: number | null;
  packagedVolume: number | null;
  marketGroupId: number | null;
  /** 所属市场分组英文名（无分组/分组缺失为 null） */
  marketGroupNameEn: string | null;
  /** 所属市场分组中文名 */
  marketGroupNameZh: string | null;
}

export type MarketTypeSortKey = 'name' | 'bestSell' | 'bestBuy' | 'sellVolume' | 'buyVolume';
export type SortDirection = 'asc' | 'desc';

export interface MarketTypeListOptions {
  /** 选中分组：**含其全部后代分组**（与游戏内市场一致） */
  marketGroupId: number;
  stationId: number;
  limit?: number;
  offset?: number;
  sortBy?: MarketTypeSortKey;
  sortDir?: SortDirection;
  /** 仅返回所选站点有卖单或买单的物品（默认 false：全部列出，与游戏一致） */
  onlyWithOrders?: boolean;
}

export interface MarketSearchOptions {
  query: string;
  stationId: number;
  limit?: number;
  offset?: number;
  sortBy?: MarketTypeSortKey;
  sortDir?: SortDirection;
}

export interface MarketTypeList {
  /** 过滤后的总数（不受 limit 影响） */
  total: number;
  rows: MarketTypeRow[];
}

/** 站点所属范围（解析站点 → 区域 + 属地名称） */
export interface MarketStationScope {
  stationId: number;
  regionId: number;
  nameEn: string;
  nameZh: string | null;
  systemNameEn: string;
  systemNameZh: string | null;
  regionNameEn: string;
  regionNameZh: string | null;
}

/** 站点订单簿：top-N 明细 + 全量条数 */
export interface StationOrderBook extends OrderBook {
  /** 该物品在该站点的卖单总条数（非 `sells.length`） */
  sellOrderCount: number;
  /** 该物品在该站点的买单总条数（非 `buys.length`） */
  buyOrderCount: number;
}

export const MARKET_BROWSE_DEFAULT_LIMIT = 200;
export const MARKET_BROWSE_MAX_LIMIT = 1000;

/** 订单簿单侧最大档位 */
const ORDER_BOOK_MAX_SIDE = 200;

/**
 * 显示名表达式（中列 / 搜索的默认排序键与 tie-break）。
 * 中文优先，空串或缺失回退英文名 —— 故 `nameZh` 为 NULL / `''` 都不会污染排序。
 */
const DISPLAY_NAME = `COALESCE(NULLIF(TRIM(nameZh), ''), nameEn)`;

/** 站点聚合结果的取列片段（配合 `agg` CTE 的别名 `a`） */
const AGG_COLUMNS = `a.bestSell                 AS bestSell,
                     a.bestBuy                  AS bestBuy,
                     COALESCE(a.sellVolume, 0)  AS sellVolume,
                     COALESCE(a.buyVolume, 0)   AS buyVolume,
                     COALESCE(a.sellOrders, 0)  AS sellOrders,
                     COALESCE(a.buyOrders, 0)   AS buyOrders`;

const ORDER_BOOK_COLUMNS = `order_id      AS orderId,
                            price         AS price,
                            volume_remain AS volumeRemain,
                            location_id   AS locationId,
                            issued        AS issued`;

/** 子树 CTE（参数：选中分组 id）：含自身与全部后代 */
const SUBTREE_CTE = `WITH RECURSIVE sub(id) AS (
  SELECT market_group_id FROM sde_market_groups WHERE market_group_id = ?
  UNION ALL
  SELECT g.market_group_id FROM sde_market_groups g JOIN sub ON g.parent_group_id = sub.id
)`;

/** 市场可见物品的公共条件（published 且挂在市场分组下） */
const MARKET_VISIBLE = `t.published = 1 AND t.market_group_id IS NOT NULL`;

/**
 * 「有效分组」递归集：**子树内至少有一个市场可见物品**的分组。
 * 用它统一「是否展示该分组」与「该分组是否可展开」两个判断，避免出现
 * 「子树里全是死枝却显示可展开」的不一致（真实库有 52 个既无子分组又无物品的死枝）。
 */
const VISIBLE_GROUPS_CTE = `WITH RECURSIVE visible(id) AS (
  SELECT DISTINCT market_group_id FROM sde_types
   WHERE published = 1 AND market_group_id IS NOT NULL
  UNION
  SELECT g.parent_group_id FROM sde_market_groups g
    JOIN visible v ON v.id = g.market_group_id
   WHERE g.parent_group_id IS NOT NULL
)`;

/** 分组是否有效（在 `visible` 递归集内） */
const IS_VISIBLE = (alias: string) => `${alias}.market_group_id IN (SELECT id FROM visible)`;

/** LIKE 转义（用户输入的 % _ \ 按字面处理） */
const LIKE_ESCAPE = `ESCAPE '\\'`;

/**
 * 站点聚合 CTE：把 `typeFilter` 命中的订单按 `type_id` 汇总为站点点位。
 * **参数顺序：`region_id`、`location_id`**（其余由调用方在 `typeFilter` 内自行安排）。
 */
function stationAggCte(typeFilter: string): string {
  return `agg AS (
    SELECT o.type_id AS typeId,
           MIN(CASE WHEN o.is_buy_order = 0 THEN o.price END) AS bestSell,
           MAX(CASE WHEN o.is_buy_order = 1 THEN o.price END) AS bestBuy,
           SUM(CASE WHEN o.is_buy_order = 0 THEN o.volume_remain ELSE 0 END) AS sellVolume,
           SUM(CASE WHEN o.is_buy_order = 1 THEN o.volume_remain ELSE 0 END) AS buyVolume,
           SUM(o.is_buy_order = 0) AS sellOrders,
           SUM(o.is_buy_order = 1) AS buyOrders
      FROM market_orders o
     WHERE o.region_id = ? AND o.location_id = ?
       AND ${typeFilter}
     GROUP BY o.type_id
  )`;
}

/** 站点所属范围；未收录于 SDE 时返回 null */
export async function getMarketStationScope(
  db: DbAdapter,
  stationId: number,
): Promise<MarketStationScope | null> {
  const rows = await db.select<MarketStationScope>(
    `SELECT station_id     AS stationId,
            region_id      AS regionId,
            name_en        AS nameEn,
            name_zh        AS nameZh,
            system_name_en AS systemNameEn,
            system_name_zh AS systemNameZh,
            region_name_en AS regionNameEn,
            region_name_zh AS regionNameZh
       FROM sde_stations
      WHERE station_id = ?`,
    [stationId],
  );
  return rows[0] ?? null;
}

/**
 * 取站点所属范围；未收录则抛错。
 * 市场浏览只允许选 SDE 内的 NPC 站点（玩家建筑不在区域订单端点内），故 fail fast。
 */
async function requireStationScope(db: DbAdapter, stationId: number): Promise<MarketStationScope> {
  const scope = await getMarketStationScope(db, stationId);
  if (scope === null) {
    throw new Error(`站点未收录于 SDE，无法定位区域：${stationId}`);
  }
  return scope;
}

/**
 * 左树一层：某分组的直接子分组。
 * `parentGroupId` 传 null 取根层。
 * 只返回**有效分组**（子树内含市场可见物品），且 `childCount` 同口径 —— 故
 * `childCount > 0` ⟺ 展开后必有内容；死枝不会出现在任何一层。
 */
export async function listMarketGroupChildren(
  db: DbAdapter,
  parentGroupId: number | null,
): Promise<MarketGroupNode[]> {
  return db.select<MarketGroupNode>(
    `${VISIBLE_GROUPS_CTE}
     SELECT g.market_group_id AS marketGroupId,
            g.parent_group_id  AS parentGroupId,
            g.name_en          AS nameEn,
            g.name_zh          AS nameZh,
            g.icon_id          AS iconId,
            (SELECT COUNT(*) FROM sde_market_groups c
              WHERE c.parent_group_id = g.market_group_id
                AND ${IS_VISIBLE('c')}) AS childCount,
            (SELECT COUNT(*) FROM sde_types t
              WHERE t.market_group_id = g.market_group_id AND t.published = 1) AS typeCount
       FROM sde_market_groups g
      WHERE ((? IS NULL AND g.parent_group_id IS NULL) OR g.parent_group_id = ?)
        AND ${IS_VISIBLE('g')}
      ORDER BY ${DISPLAY_NAME}, nameEn, marketGroupId`,
    [parentGroupId, parentGroupId],
  );
}

/** 树的祖先链（**根 → 自身**）；分组不存在时返回空数组 */
export async function getMarketGroupPath(
  db: DbAdapter,
  marketGroupId: number,
): Promise<MarketGroupRef[]> {
  return db.select<MarketGroupRef>(
    `WITH RECURSIVE chain(marketGroupId, parentGroupId, nameEn, nameZh, iconId, depth) AS (
       SELECT market_group_id, parent_group_id, name_en, name_zh, icon_id, 0
         FROM sde_market_groups WHERE market_group_id = ?
       UNION ALL
       SELECT g.market_group_id, g.parent_group_id, g.name_en, g.name_zh, g.icon_id, c.depth + 1
         FROM sde_market_groups g JOIN chain c ON g.market_group_id = c.parentGroupId
     )
     SELECT marketGroupId, parentGroupId, nameEn, nameZh, iconId
       FROM chain ORDER BY depth DESC`,
    [marketGroupId],
  );
}

/**
 * 中列：选中分组**及其全部后代**下的市场可见物品，附所选站点点位报价。
 * 默认把无报价物品也列出来（价格列为空），与游戏内市场一致；`onlyWithOrders` 可切换。
 */
export async function listMarketTypes(
  db: DbAdapter,
  options: MarketTypeListOptions,
): Promise<MarketTypeList> {
  const { marketGroupId, stationId } = options;
  const limit = clampLimit(options.limit);
  const offset = clampOffset(options.offset);
  const onlyWithOrders = options.onlyWithOrders === true;
  const { regionId } = await requireStationScope(db, stationId);

  const rows = await db.select<MarketTypeRow>(
    `${SUBTREE_CTE},
     scope AS (
       SELECT t.type_id           AS typeId,
              t.name_en           AS nameEn,
              t.name_zh           AS nameZh,
              t.volume            AS volume,
              t.packaged_volume   AS packagedVolume,
              t.market_group_id   AS marketGroupId
         FROM sde_types t
        WHERE t.published = 1 AND t.market_group_id IN (SELECT id FROM sub)
     ),
     ${stationAggCte('o.type_id IN (SELECT typeId FROM scope)')}
     SELECT * FROM (
       SELECT s.typeId          AS typeId,
              s.nameEn          AS nameEn,
              s.nameZh          AS nameZh,
              s.volume          AS volume,
              s.packagedVolume  AS packagedVolume,
              s.marketGroupId   AS marketGroupId,
              mg.name_en        AS marketGroupNameEn,
              mg.name_zh        AS marketGroupNameZh,
              ${AGG_COLUMNS}
         FROM scope s
         LEFT JOIN sde_market_groups mg ON mg.market_group_id = s.marketGroupId
         LEFT JOIN agg a ON a.typeId = s.typeId
     )
     ${onlyWithOrders ? 'WHERE bestSell IS NOT NULL OR bestBuy IS NOT NULL' : ''}
     ORDER BY ${buildOrderBy(options.sortBy ?? 'name', options.sortDir ?? 'asc')}
     LIMIT ? OFFSET ?`,
    [marketGroupId, regionId, stationId, limit, offset],
  );

  const total = await countMarketTypes(db, {
    marketGroupId,
    regionId,
    stationId,
    onlyWithOrders,
  });
  return { total, rows };
}

/**
 * 搜索：中/英文名模糊匹配市场可见物品，附所属市场分组名与站点点位报价。
 * 结果优先精确匹配（与 SDE 搜索口径一致），空查询返回空列表。
 */
export async function searchMarketTypes(
  db: DbAdapter,
  options: MarketSearchOptions,
): Promise<MarketTypeList> {
  const trimmed = options.query.trim();
  if (trimmed.length === 0) return { total: 0, rows: [] };

  const limit = clampLimit(options.limit);
  const offset = clampOffset(options.offset);
  const { regionId } = await requireStationScope(db, options.stationId);
  const pattern = toLikePattern(trimmed);

  const rows = await db.select<MarketTypeRow>(
    `WITH matched AS (
       SELECT t.type_id AS typeId
         FROM sde_types t
        WHERE ${MARKET_VISIBLE}
          AND (t.name_en LIKE ? ${LIKE_ESCAPE} OR t.name_zh LIKE ? ${LIKE_ESCAPE})
     ),
     ${stationAggCte('o.type_id IN (SELECT typeId FROM matched)')}
     SELECT * FROM (
       SELECT t.type_id         AS typeId,
              t.name_en         AS nameEn,
              t.name_zh         AS nameZh,
              t.volume          AS volume,
              t.packaged_volume AS packagedVolume,
              t.market_group_id AS marketGroupId,
              mg.name_en        AS marketGroupNameEn,
              mg.name_zh        AS marketGroupNameZh,
              ${AGG_COLUMNS}
         FROM sde_types t
         LEFT JOIN sde_market_groups mg ON mg.market_group_id = t.market_group_id
         LEFT JOIN agg a ON a.typeId = t.type_id
        WHERE t.type_id IN (SELECT typeId FROM matched)
     )
     ORDER BY (nameEn = ?) DESC, (nameZh = ?) DESC,
              ${buildOrderBy(options.sortBy ?? 'name', options.sortDir ?? 'asc')}
     LIMIT ? OFFSET ?`,
    [pattern, pattern, regionId, options.stationId, trimmed, trimmed, limit, offset],
  );

  const totalRows = await db.select<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM sde_types t
      WHERE ${MARKET_VISIBLE}
        AND (t.name_en LIKE ? ${LIKE_ESCAPE} OR t.name_zh LIKE ? ${LIKE_ESCAPE})`,
    [pattern, pattern],
  );
  return { total: totalRows[0]?.n ?? 0, rows };
}

/** 单个物品的站点点位行（与中列**同一套聚合口径**，避免两处漂移） */
export async function getStationTypeRow(
  db: DbAdapter,
  stationId: number,
  typeId: number,
): Promise<MarketTypeRow | null> {
  const { regionId } = await requireStationScope(db, stationId);
  const rows = await db.select<MarketTypeRow>(
    `WITH ${stationAggCte('o.type_id = ?')}
     SELECT t.type_id          AS typeId,
            t.name_en          AS nameEn,
            t.name_zh          AS nameZh,
            t.volume           AS volume,
            t.packaged_volume  AS packagedVolume,
            t.market_group_id  AS marketGroupId,
            mg.name_en         AS marketGroupNameEn,
            mg.name_zh         AS marketGroupNameZh,
            ${AGG_COLUMNS}
       FROM sde_types t
       LEFT JOIN sde_market_groups mg ON mg.market_group_id = t.market_group_id
       LEFT JOIN agg a ON a.typeId = t.type_id
      WHERE t.type_id = ? AND ${MARKET_VISIBLE}`,
    [regionId, stationId, typeId, typeId],
  );
  return rows[0] ?? null;
}

/** 站点订单簿：卖价升序 / 买价降序各取前 N 档，并附全量条数 */
export async function getStationOrderBook(
  db: DbAdapter,
  stationId: number,
  typeId: number,
  limitPerSide: number = 20,
): Promise<StationOrderBook> {
  const { regionId } = await requireStationScope(db, stationId);
  const take = clampSide(limitPerSide);

  // `INDEXED BY idx_market_orders_type`：`location_id` 无索引，且 `ORDER BY price … LIMIT` 会让 planner
  // 误选 `idx_market_orders_side` 顺序扫全区一侧（实测 ≈1 s）→ 强制按 type 精确 seek。见 DEV_STATUS「P11-6」
  const sells = await db.select<OrderBookEntry>(
    `SELECT ${ORDER_BOOK_COLUMNS} FROM market_orders INDEXED BY idx_market_orders_type
      WHERE region_id = ? AND location_id = ? AND type_id = ? AND is_buy_order = 0
      ORDER BY price ASC, order_id ASC
      LIMIT ?`,
    [regionId, stationId, typeId, take],
  );

  const buys = await db.select<OrderBookEntry>(
    `SELECT ${ORDER_BOOK_COLUMNS} FROM market_orders INDEXED BY idx_market_orders_type
      WHERE region_id = ? AND location_id = ? AND type_id = ? AND is_buy_order = 1
      ORDER BY price DESC, order_id ASC
      LIMIT ?`,
    [regionId, stationId, typeId, take],
  );

  const counts = await db.select<{ sellOrderCount: number; buyOrderCount: number }>(
    `SELECT (SELECT COUNT(*) FROM market_orders
              WHERE region_id = ? AND location_id = ? AND type_id = ? AND is_buy_order = 0) AS sellOrderCount,
            (SELECT COUNT(*) FROM market_orders
              WHERE region_id = ? AND location_id = ? AND type_id = ? AND is_buy_order = 1) AS buyOrderCount`,
    [regionId, stationId, typeId, regionId, stationId, typeId],
  );

  return {
    sells,
    buys,
    sellOrderCount: counts[0]?.sellOrderCount ?? 0,
    buyOrderCount: counts[0]?.buyOrderCount ?? 0,
  };
}

/** 子树内市场可见物品总数（`onlyWithOrders` 时需先算站点聚合） */
async function countMarketTypes(
  db: DbAdapter,
  input: { marketGroupId: number; regionId: number; stationId: number; onlyWithOrders: boolean },
): Promise<number> {
  if (!input.onlyWithOrders) {
    const rows = await db.select<{ n: number }>(
      `${SUBTREE_CTE}
       SELECT COUNT(*) AS n FROM sde_types t
        WHERE t.published = 1 AND t.market_group_id IN (SELECT id FROM sub)`,
      [input.marketGroupId],
    );
    return rows[0]?.n ?? 0;
  }

  const rows = await db.select<{ n: number }>(
    `${SUBTREE_CTE},
     scope AS (
       SELECT t.type_id AS typeId FROM sde_types t
        WHERE t.published = 1 AND t.market_group_id IN (SELECT id FROM sub)
     ),
     ${stationAggCte('o.type_id IN (SELECT typeId FROM scope)')}
     SELECT COUNT(*) AS n
       FROM scope s
       LEFT JOIN agg a ON a.typeId = s.typeId
      WHERE a.bestSell IS NOT NULL OR a.bestBuy IS NOT NULL`,
    [input.marketGroupId, input.regionId, input.stationId],
  );
  return rows[0]?.n ?? 0;
}

/**
 * 排序片段。**null 恒排最后**（无论升降序）；恒定以 `typeId` 收尾，
 * 保证同一排序键下 offset 分页不重不漏。
 */
function buildOrderBy(sortBy: MarketTypeSortKey, sortDir: SortDirection): string {
  const dir = sortDir === 'desc' ? 'DESC' : 'ASC';
  switch (sortBy) {
    case 'name':
      return `${DISPLAY_NAME} ${dir}, typeId ASC`;
    case 'bestSell':
      return `(bestSell IS NULL) ASC, bestSell ${dir}, typeId ASC`;
    case 'bestBuy':
      return `(bestBuy IS NULL) ASC, bestBuy ${dir}, typeId ASC`;
    case 'sellVolume':
      return `sellVolume ${dir}, typeId ASC`;
    case 'buyVolume':
      return `buyVolume ${dir}, typeId ASC`;
  }
}

function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return MARKET_BROWSE_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(value), 1), MARKET_BROWSE_MAX_LIMIT);
}

function clampOffset(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(Math.trunc(value), 0);
}

function clampSide(value: number): number {
  if (!Number.isFinite(value)) return 20;
  return Math.min(Math.max(Math.trunc(value), 1), ORDER_BOOK_MAX_SIDE);
}
