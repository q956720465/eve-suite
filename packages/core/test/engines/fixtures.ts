import type { DbAdapter } from '../../src/db/types';

/** 测试用区域：吉他（默认基准）/ 艾玛 */
export const JITA = 10000002;
export const AMARR = 10000043;

/** 测试用空间站 ID（吉他 4-4 / 另一处，用于区分站点级基准） */
export const JITA_44 = 60003760;
export const JITA_OTHER = 60008494;

export interface MarketOrderInput {
  orderId: number;
  typeId: number;
  price: number;
  regionId?: number;
  locationId?: number;
  volumeRemain?: number;
  isBuyOrder?: boolean;
}

/** 插入一条市场订单快照（默认吉他 4-4 的卖单） */
export async function insertOrder(db: DbAdapter, input: MarketOrderInput): Promise<void> {
  const volume = input.volumeRemain ?? 100;
  await db.execute(
    `INSERT INTO market_orders (order_id, region_id, type_id, location_id, price, volume_total,
                                volume_remain, min_volume, is_buy_order, duration, issued, range, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 90, '2026-09-01T00:00:00Z', 'station', '2026-09-27T00:00:00Z')`,
    [
      input.orderId,
      input.regionId ?? JITA,
      input.typeId,
      input.locationId ?? JITA_44,
      input.price,
      volume,
      volume,
      input.isBuyOrder === true ? 1 : 0,
    ],
  );
}

/** 按价格列表批量插入某物品的卖单（订单号自增，便于铺订单簿） */
export async function insertSellOrders(
  db: DbAdapter,
  typeId: number,
  prices: readonly number[],
  options: { regionId?: number; locationId?: number; firstOrderId?: number } = {},
): Promise<void> {
  let orderId = options.firstOrderId ?? 1;
  for (const price of prices) {
    await insertOrder(db, {
      orderId: orderId++,
      typeId,
      price,
      regionId: options.regionId,
      locationId: options.locationId,
    });
  }
}

export interface MarketStatsInput {
  typeId: number;
  regionId?: number;
  bestSell?: number | null;
  p5Sell?: number | null;
}

/** 插入一条聚合指标行（只填估值关心的两列；其余列走表默认值） */
export async function insertStats(db: DbAdapter, input: MarketStatsInput): Promise<void> {
  await db.execute(
    `INSERT INTO market_stats (region_id, type_id, best_sell, p5_sell, updated_at)
     VALUES (?, ?, ?, ?, '2026-09-27T00:00:00Z')`,
    [input.regionId ?? JITA, input.typeId, input.bestSell ?? null, input.p5Sell ?? null],
  );
}
