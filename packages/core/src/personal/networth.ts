import type { DbAdapter } from '../db/types';
import { valueItems, type ValuationOptions } from '../engines/valuation';
import { systemClock, type Clock } from '../esi/clock';

/** 净值分项（contractsValue 恒为 0，合同估值留 P5） */
export interface NetWorthBreakdown {
  characterId: number;
  totalValue: number;
  /** Σ(资产数量 × 估值引擎口径价)：默认吉他 5% 分位（方案 §6.3 唯一定价出口） */
  assetsValue: number;
  walletBalance: number;
  /** Σ(未成交卖单 volume_remain × price) */
  sellOrdersValue: number;
  /** 记 0（合同估值留 P5） */
  contractsValue: number;
  /** 参与估值的物品种类数 */
  distinctTypeCount: number;
  /** 基准区域无报价的物品种类数——估值偏低提示 */
  missingPriceTypes: number;
}

export interface NetWorthSnapshot extends NetWorthBreakdown {
  /** UTC 日期 `YYYY-MM-DD` */
  snapshotDate: string;
  createdAt: string;
}

/**
 * 计算角色净值（不写库）。
 *
 * 口径：`assets_value` 走估值引擎 [valueItems]（默认吉他 5% 分位，缺失按回退链处理）；
 * 卖单按未成交量的挂单价计；无报价的物品计 0 并计入 `missingPriceTypes`（不抛错、不跳过整表）。
 */
export async function computeNetWorth(
  db: DbAdapter,
  characterId: number,
  options: ValuationOptions = {},
): Promise<NetWorthBreakdown> {
  const assetRows = await db.select<{ typeId: number; quantity: number }>(
    `SELECT type_id AS typeId, SUM(quantity) AS quantity
       FROM assets
      WHERE character_id = ?
      GROUP BY type_id`,
    [characterId],
  );

  const valuation = await valueItems(
    db,
    assetRows.map((row) => ({ typeId: row.typeId, quantity: row.quantity })),
    options,
  );

  const walletRows = await db.select<{ walletBalance: number | null }>(
    'SELECT wallet_balance AS walletBalance FROM characters WHERE character_id = ?',
    [characterId],
  );

  const orderRows = await db.select<{ sellOrdersValue: number | null }>(
    `SELECT COALESCE(SUM(volume_remain * price), 0) AS sellOrdersValue
       FROM my_orders
      WHERE character_id = ? AND COALESCE(is_buy_order, 0) = 0`,
    [characterId],
  );

  const assetsValue = valuation.totalValue;
  const walletBalance = walletRows[0]?.walletBalance ?? 0;
  const sellOrdersValue = orderRows[0]?.sellOrdersValue ?? 0;
  const contractsValue = 0;

  return {
    characterId,
    totalValue: assetsValue + walletBalance + sellOrdersValue + contractsValue,
    assetsValue,
    walletBalance,
    sellOrdersValue,
    contractsValue,
    distinctTypeCount: valuation.distinctTypeCount,
    missingPriceTypes: valuation.missingTypeIds.length,
  };
}

export interface WriteSnapshotOptions {
  clock?: Clock;
  /** 估值口径（区域 / 站点 / 口径 / 离群过滤）；缺省为引擎默认（吉他 5% 分位） */
  valuation?: ValuationOptions;
}

/**
 * 写入当日净值快照：同一 (角色, UTC 日期) 只保留一行，重复调用覆盖。
 */
export async function writeDailySnapshot(
  db: DbAdapter,
  characterId: number,
  options: WriteSnapshotOptions = {},
): Promise<NetWorthSnapshot> {
  const clock = options.clock ?? systemClock;
  const createdAt = new Date(clock.now()).toISOString();
  const snapshotDate = createdAt.slice(0, 10);
  const breakdown = await computeNetWorth(db, characterId, options.valuation);

  await db.execute(
    `INSERT INTO networth_snapshots (
       character_id, snapshot_date, total_value, assets_value,
       wallet_balance, sell_orders_value, contracts_value, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(character_id, snapshot_date) DO UPDATE SET
       total_value = excluded.total_value,
       assets_value = excluded.assets_value,
       wallet_balance = excluded.wallet_balance,
       sell_orders_value = excluded.sell_orders_value,
       contracts_value = excluded.contracts_value,
       created_at = excluded.created_at`,
    [
      characterId,
      snapshotDate,
      breakdown.totalValue,
      breakdown.assetsValue,
      breakdown.walletBalance,
      breakdown.sellOrdersValue,
      breakdown.contractsValue,
      createdAt,
    ],
  );

  return { ...breakdown, snapshotDate, createdAt };
}

/** 最近若干条净值快照（按日期倒序） */
export async function listSnapshots(
  db: DbAdapter,
  characterId: number,
  limit = 30,
): Promise<NetWorthSnapshot[]> {
  const rows = await db.select<{
    snapshot_date: string;
    total_value: number;
    assets_value: number;
    wallet_balance: number;
    sell_orders_value: number;
    contracts_value: number;
    created_at: string;
  }>(
    `SELECT snapshot_date, total_value, assets_value, wallet_balance,
            sell_orders_value, contracts_value, created_at
       FROM networth_snapshots
      WHERE character_id = ?
      ORDER BY snapshot_date DESC
      LIMIT ?`,
    [characterId, limit],
  );
  return rows.map((row) => ({
    characterId,
    snapshotDate: row.snapshot_date,
    totalValue: row.total_value,
    assetsValue: row.assets_value,
    walletBalance: row.wallet_balance,
    sellOrdersValue: row.sell_orders_value,
    contractsValue: row.contracts_value,
    createdAt: row.created_at,
    // 快照行不存这两项统计（按当前资产现算，仅用于展示参考）
    distinctTypeCount: 0,
    missingPriceTypes: 0,
  }));
}
