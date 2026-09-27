import type { DbAdapter } from '../db/types';

import { getValuationPrice, valueItems, type ValuationOptions } from '../engines/valuation';

/** 按物品种类聚合的资产行（资产页主表） */
export interface AssetOverviewRow {
  typeId: number;
  /** 该物品的持有总量 */
  quantity: number;
  /** 估值引擎口径单价（默认吉他 5% 分位）；无报价为 null */
  unitPrice: number | null;
  /** Σ(数量 × 单价)，无报价按 0 计 */
  estimatedValue: number;
  /** 分布在多少个地点 */
  locationCount: number;
}

/** 展开后的资产明细行（含具体地点与位置标记） */
export interface AssetDetailRow {
  itemId: number;
  locationId: number;
  locationFlag: string;
  quantity: number;
  isSingleton: number;
  estimatedValue: number;
}

/**
 * 按物品种类聚合的资产概览（数量合计 + 估值，按估值倒序）。
 * 单价与估值统一走估值引擎（默认吉他 5% 分位），与 `computeNetWorth` 同口径。
 */
export async function getAssetOverview(
  db: DbAdapter,
  characterId: number,
  options: ValuationOptions = {},
): Promise<AssetOverviewRow[]> {
  const rows = await db.select<{ typeId: number; quantity: number; locationCount: number }>(
    `SELECT type_id                AS typeId,
            SUM(quantity)          AS quantity,
            COUNT(DISTINCT location_id) AS locationCount
       FROM assets
      WHERE character_id = ?
      GROUP BY type_id`,
    [characterId],
  );

  const valuation = await valueItems(
    db,
    rows.map((row) => ({ typeId: row.typeId, quantity: row.quantity })),
    options,
  );

  const overview = rows.map((row, index) => ({
    typeId: row.typeId,
    quantity: row.quantity,
    unitPrice: valuation.items[index].unitPrice,
    estimatedValue: valuation.items[index].value,
    locationCount: row.locationCount,
  }));

  overview.sort(
    (a, b) => b.estimatedValue - a.estimatedValue || b.quantity - a.quantity || a.typeId - b.typeId,
  );
  return overview;
}

/** 某物品的资产明细（逐条，含地点与位置标记） */
export async function getAssetDetails(
  db: DbAdapter,
  characterId: number,
  typeId: number,
  options: ValuationOptions = {},
): Promise<AssetDetailRow[]> {
  const { price } = await getValuationPrice(db, typeId, options);
  const unitPrice = price ?? 0;

  const rows = await db.select<{
    itemId: number;
    locationId: number;
    locationFlag: string;
    quantity: number;
    isSingleton: number;
  }>(
    `SELECT item_id       AS itemId,
            location_id   AS locationId,
            location_flag AS locationFlag,
            quantity      AS quantity,
            is_singleton  AS isSingleton
       FROM assets
      WHERE character_id = ? AND type_id = ?
      ORDER BY quantity DESC, item_id`,
    [characterId, typeId],
  );

  // 同一物品单价一致，按数量倒序与按估值倒序等价
  return rows.map((row) => ({ ...row, estimatedValue: row.quantity * unitPrice }));
}
