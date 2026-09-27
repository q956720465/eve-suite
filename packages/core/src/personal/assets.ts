import type { DbAdapter } from '../db/types';

import { DEFAULT_VALUATION_REGION_ID } from './networth';

/** 按物品种类聚合的资产行（资产页主表） */
export interface AssetOverviewRow {
  typeId: number;
  /** 该物品的持有总量 */
  quantity: number;
  /** 基准区域最低卖价；无报价为 null */
  unitPrice: number | null;
  /** Σ(数量 × 卖价)，无报价按 0 计 */
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
 * 估值口径同 `computeNetWorth`：基准区域（默认吉他）`market_stats.best_sell`。
 */
export async function getAssetOverview(
  db: DbAdapter,
  characterId: number,
  regionId: number = DEFAULT_VALUATION_REGION_ID,
): Promise<AssetOverviewRow[]> {
  const rows = await db.select<{
    typeId: number;
    quantity: number;
    unitPrice: number | null;
    estimatedValue: number;
    locationCount: number;
  }>(
    `SELECT a.type_id AS typeId,
            SUM(a.quantity) AS quantity,
            MAX(s.best_sell) AS unitPrice,
            SUM(a.quantity * COALESCE(s.best_sell, 0)) AS estimatedValue,
            COUNT(DISTINCT a.location_id) AS locationCount
       FROM assets a
       LEFT JOIN market_stats s ON s.type_id = a.type_id AND s.region_id = ?
      WHERE a.character_id = ?
      GROUP BY a.type_id
      ORDER BY estimatedValue DESC, quantity DESC, a.type_id`,
    [regionId, characterId],
  );
  return rows.map((row) => ({
    typeId: row.typeId,
    quantity: row.quantity,
    unitPrice: row.unitPrice,
    estimatedValue: row.estimatedValue,
    locationCount: row.locationCount,
  }));
}

/** 某物品的资产明细（逐条，含地点与位置标记） */
export async function getAssetDetails(
  db: DbAdapter,
  characterId: number,
  typeId: number,
  regionId: number = DEFAULT_VALUATION_REGION_ID,
): Promise<AssetDetailRow[]> {
  const rows = await db.select<{
    itemId: number;
    locationId: number;
    locationFlag: string;
    quantity: number;
    isSingleton: number;
    estimatedValue: number;
  }>(
    `SELECT a.item_id AS itemId,
            a.location_id AS locationId,
            a.location_flag AS locationFlag,
            a.quantity AS quantity,
            a.is_singleton AS isSingleton,
            a.quantity * COALESCE(s.best_sell, 0) AS estimatedValue
       FROM assets a
       LEFT JOIN market_stats s ON s.type_id = a.type_id AND s.region_id = ?
      WHERE a.character_id = ? AND a.type_id = ?
      ORDER BY estimatedValue DESC, a.item_id`,
    [regionId, characterId, typeId],
  );
  return rows;
}
