import type { DbAdapter } from '../db/types';

/** 物品在某区域的聚合指标 */
export interface TypeMarketStats {
  regionId: number;
  typeId: number;
  bestSell: number | null;
  bestBuy: number | null;
  sellVolume: number;
  buyVolume: number;
  sellOrders: number;
  buyOrders: number;
  spread: number | null;
  p5Sell: number | null;
  p95Buy: number | null;
  updatedAt: string;
}

/** 跨枢纽价格对比行（含枢纽名，便于直接渲染） */
export interface HubPriceComparison {
  regionId: number;
  regionNameEn: string;
  regionNameZh: string | null;
  stats: TypeMarketStats | null;
}

/** 订单簿条目 */
export interface OrderBookEntry {
  orderId: number;
  price: number;
  volumeRemain: number;
  locationId: number;
  issued: string;
}

export interface OrderBook {
  sells: OrderBookEntry[];
  buys: OrderBookEntry[];
}

/** 各枢纽采集状态（含实时订单数） */
export interface HubCollectState {
  regionId: number;
  regionNameEn: string;
  regionNameZh: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  pages: number;
  ordersWritten: number;
  requests: number;
  /** 实时统计的订单行数（0 表示尚未采集） */
  orderCount: number;
}

const STATS_SELECT = `SELECT region_id      AS regionId,
                             type_id        AS typeId,
                             best_sell      AS bestSell,
                             best_buy       AS bestBuy,
                             sell_volume    AS sellVolume,
                             buy_volume     AS buyVolume,
                             sell_orders    AS sellOrders,
                             buy_orders     AS buyOrders,
                             spread         AS spread,
                             p5_sell        AS p5Sell,
                             p95_buy        AS p95Buy,
                             updated_at     AS updatedAt
                        FROM market_stats`;

/** 单物品单区域指标 */
export async function getTypeStats(
  db: DbAdapter,
  regionId: number,
  typeId: number,
): Promise<TypeMarketStats | null> {
  const rows = await db.select<TypeMarketStats>(
    `${STATS_SELECT} WHERE region_id = ? AND type_id = ?`,
    [regionId, typeId],
  );
  return rows[0] ?? null;
}

/** 单物品在全部枢纽的对比（区域名取自 SDE 星域表） */
export async function getTypeStatsAcrossHubs(
  db: DbAdapter,
  regionIdList: readonly number[],
  typeId: number,
): Promise<HubPriceComparison[]> {
  if (regionIdList.length === 0) return [];
  const placeholders = regionIdList.map(() => '?').join(', ');
  const rows = await db.select<{
    regionId: number;
    regionNameEn: string;
    regionNameZh: string | null;
    bestSell: number | null;
    bestBuy: number | null;
    sellVolume: number | null;
    buyVolume: number | null;
    sellOrders: number | null;
    buyOrders: number | null;
    spread: number | null;
    p5Sell: number | null;
    p95Buy: number | null;
    updatedAt: string | null;
  }>(
    `SELECT r.region_id  AS regionId,
            r.name_en    AS regionNameEn,
            r.name_zh    AS regionNameZh,
            s.best_sell  AS bestSell,
            s.best_buy   AS bestBuy,
            s.sell_volume AS sellVolume,
            s.buy_volume  AS buyVolume,
            s.sell_orders AS sellOrders,
            s.buy_orders  AS buyOrders,
            s.spread      AS spread,
            s.p5_sell     AS p5Sell,
            s.p95_buy     AS p95Buy,
            s.updated_at  AS updatedAt
       FROM sde_regions r
       LEFT JOIN market_stats s ON s.region_id = r.region_id AND s.type_id = ?
      WHERE r.region_id IN (${placeholders})`,
    [typeId, ...regionIdList],
  );

  // 保持调用方给定的顺序（即固定枢纽顺序）
  const byRegion = new Map(rows.map((row) => [row.regionId, row]));
  return regionIdList.map((regionId) => {
    const row = byRegion.get(regionId);
    return {
      regionId,
      regionNameEn: row?.regionNameEn ?? String(regionId),
      regionNameZh: row?.regionNameZh ?? null,
      stats:
        row?.updatedAt === null || row?.updatedAt === undefined
          ? null
          : {
              regionId,
              typeId,
              bestSell: row.bestSell ?? null,
              bestBuy: row.bestBuy ?? null,
              sellVolume: row.sellVolume ?? 0,
              buyVolume: row.buyVolume ?? 0,
              sellOrders: row.sellOrders ?? 0,
              buyOrders: row.buyOrders ?? 0,
              spread: row.spread ?? null,
              p5Sell: row.p5Sell ?? null,
              p95Buy: row.p95Buy ?? null,
              updatedAt: row.updatedAt,
            },
    };
  });
}

/** 订单簿（卖单价格升序、买单价格降序，各取前 N 档） */
export async function getOrderBook(
  db: DbAdapter,
  regionId: number,
  typeId: number,
  limitPerSide = 20,
): Promise<OrderBook> {
  const columns = `order_id      AS orderId,
                   price         AS price,
                   volume_remain AS volumeRemain,
                   location_id   AS locationId,
                   issued        AS issued`;

  // `INDEXED BY idx_market_orders_type`：`ORDER BY price … LIMIT` 会让 planner 误选
  // `idx_market_orders_side`（免排序）而顺序扫全区一侧（吉他有 40 万+ 卖单 → 稀有物品 ≈1 s）。见 DEV_STATUS「P11-6」
  const sells = await db.select<OrderBookEntry>(
    `SELECT ${columns} FROM market_orders INDEXED BY idx_market_orders_type
      WHERE region_id = ? AND type_id = ? AND is_buy_order = 0
      ORDER BY price ASC, order_id ASC
      LIMIT ?`,
    [regionId, typeId, limitPerSide],
  );

  const buys = await db.select<OrderBookEntry>(
    `SELECT ${columns} FROM market_orders INDEXED BY idx_market_orders_type
      WHERE region_id = ? AND type_id = ? AND is_buy_order = 1
      ORDER BY price DESC, order_id ASC
      LIMIT ?`,
    [regionId, typeId, limitPerSide],
  );

  return { sells, buys };
}

/** 日线历史（按日期升序返回，可直接用于图表） */
export async function getDailyHistory(
  db: DbAdapter,
  regionId: number,
  typeId: number,
  limit = 400,
): Promise<{ date: string; average: number; highest: number; lowest: number; volume: number }[]> {
  const rows = await db.select<{
    date: string;
    average: number;
    highest: number;
    lowest: number;
    volume: number;
  }>(
    `SELECT date    AS date,
            average AS average,
            highest AS highest,
            lowest  AS lowest,
            volume  AS volume
       FROM market_history_daily
      WHERE region_id = ? AND type_id = ?
      ORDER BY date DESC
      LIMIT ?`,
    [regionId, typeId, limit],
  );
  return rows.reverse();
}

/** 各枢纽采集状态（区域名取自 SDE 星域表） */
export async function getCollectStates(
  db: DbAdapter,
  regionIdList: readonly number[],
): Promise<HubCollectState[]> {
  if (regionIdList.length === 0) return [];
  const placeholders = regionIdList.map(() => '?').join(', ');
  const rows = await db.select<{
    regionId: number;
    regionNameEn: string;
    regionNameZh: string | null;
    lastOkAt: string | null;
    lastError: string | null;
    pages: number | null;
    ordersWritten: number | null;
    requests: number | null;
    orderCount: number;
  }>(
    `SELECT r.region_id AS regionId,
            r.name_en   AS regionNameEn,
            r.name_zh   AS regionNameZh,
            c.last_ok_at     AS lastOkAt,
            c.last_error     AS lastError,
            c.pages          AS pages,
            c.orders_written AS ordersWritten,
            c.requests       AS requests,
            (SELECT COUNT(*) FROM market_orders o WHERE o.region_id = r.region_id) AS orderCount
       FROM sde_regions r
       LEFT JOIN market_collect_state c ON c.region_id = r.region_id
      WHERE r.region_id IN (${placeholders})`,
    regionIdList,
  );

  const byRegion = new Map(rows.map((row) => [row.regionId, row]));
  return regionIdList.map((regionId) => {
    const row = byRegion.get(regionId);
    return {
      regionId,
      regionNameEn: row?.regionNameEn ?? String(regionId),
      regionNameZh: row?.regionNameZh ?? null,
      lastOkAt: row?.lastOkAt ?? null,
      lastError: row?.lastError ?? null,
      pages: row?.pages ?? 0,
      ordersWritten: row?.ordersWritten ?? 0,
      requests: row?.requests ?? 0,
      orderCount: row?.orderCount ?? 0,
    };
  });
}
