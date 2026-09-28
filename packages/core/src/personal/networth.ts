import type { DbAdapter } from '../db/types';
import { valueItems, type ValuationOptions } from '../engines/valuation';
import { systemClock, type Clock } from '../esi/clock';

/**
 * 净值分项。
 *
 * 合同分项口径（P5-4 轻口径，本地零请求）：见 [computeContractsValue]。
 */
export interface NetWorthBreakdown {
  characterId: number;
  totalValue: number;
  /** Σ(资产数量 × 估值引擎口径价)：默认吉他 5% 分位（方案 §6.3 唯一定价出口） */
  assetsValue: number;
  walletBalance: number;
  /** Σ(未成交卖单 volume_remain × price) */
  sellOrdersValue: number;
  /** 合同分项（口径见 `computeContractsValue`） */
  contractsValue: number;
  /** 参与估值的物品种类数 */
  distinctTypeCount: number;
  /** 基准区域无报价的物品种类数——估值偏低提示 */
  missingPriceTypes: number;
  /** 无报价物品 typeId（去重，按首次出现顺序）；供界面列出具名明细 */
  missingTypeIds: number[];
}

/** 跨角色的「全账号」净值合计（分项加总 + 分角色明细） */
export interface AccountNetWorth {
  /** 计入合计的角色（按传入顺序） */
  characterIds: number[];
  totalValue: number;
  assetsValue: number;
  walletBalance: number;
  sellOrdersValue: number;
  contractsValue: number;
  /** 全部角色合计的物品种类数（去重） */
  distinctTypeCount: number;
  /** 全部角色合计的无报价物品种类数（去重） */
  missingPriceTypes: number;
  /** 全部角色合计的无报价物品 typeId（去重，按首次出现顺序） */
  missingTypeIds: number[];
  /** 分角色明细（与 `characterIds` 同序） */
  characters: NetWorthBreakdown[];
}

export interface NetWorthSnapshot extends NetWorthBreakdown {
  /** UTC 日期 `YYYY-MM-DD` */
  snapshotDate: string;
  createdAt: string;
}

/**
 * 合同分项（P5-4 轻口径，**本地零请求 / 零迁移**）：
 * - 我**发起**且 `outstanding` 的 **item_exchange** → 计 `price`（被托管物品的变现价值）
 * - 我**承接**且 `outstanding` 的 **courier** → 计 `reward`（待收运费）
 * - 其余（auction / loan / 已完成 / 已过期）→ 不计
 * - **排除公司合同**（`for_corporation = 1`）——本项目不跟踪公司资产/钱包，计入会使合计口径不一致
 *
 * 局限：**不逐项估值合同内物品**（ESI 合同物品需 `/contracts/{id}/items`，当前未同步）。
 */
async function computeContractsValue(db: DbAdapter, characterId: number): Promise<number> {
  const rows = await db.select<{ issuedValue: number | null; courierValue: number | null }>(
    `SELECT
       COALESCE(SUM(CASE WHEN type = 'item_exchange' AND status = 'outstanding'
                          AND for_corporation = 0 AND issuer_id = ?
                         THEN COALESCE(price, 0) ELSE 0 END), 0) AS issuedValue,
       COALESCE(SUM(CASE WHEN type = 'courier' AND status = 'outstanding'
                          AND for_corporation = 0 AND acceptor_id = ?
                         THEN COALESCE(reward, 0) ELSE 0 END), 0) AS courierValue
       FROM contracts
      WHERE character_id = ?`,
    [characterId, characterId, characterId],
  );
  const row = rows[0];
  return (row?.issuedValue ?? 0) + (row?.courierValue ?? 0);
}

/**
 * 计算角色净值（不写库）。
 *
 * 口径：`assets_value` 走估值引擎 [valueItems]（默认吉他 5% 分位，缺失按回退链处理）；
 * 卖单按未成交量的挂单价计；合同按 [computeContractsValue]；
 * 无报价的物品计 0 并计入 `missingPriceTypes` / `missingTypeIds`（不抛错、不跳过整表）。
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
      GROUP BY type_id
      ORDER BY type_id`,
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
  const contractsValue = await computeContractsValue(db, characterId);

  return {
    characterId,
    totalValue: assetsValue + walletBalance + sellOrdersValue + contractsValue,
    assetsValue,
    walletBalance,
    sellOrdersValue,
    contractsValue,
    distinctTypeCount: valuation.distinctTypeCount,
    missingPriceTypes: valuation.missingTypeIds.length,
    missingTypeIds: valuation.missingTypeIds,
  };
}

/**
 * 跨角色的「全账号」净值合计：分项加总 + 分角色明细。
 *
 * 分项与 `computeNetWorth` 完全同口径（估值引擎 / 卖单 / 合同），
 * 故 `合计各分项 = Σ 各角色同分项` 严格成立。
 */
export async function computeAccountNetWorth(
  db: DbAdapter,
  characterIds: readonly number[],
  options: ValuationOptions = {},
): Promise<AccountNetWorth> {
  const ids = [...characterIds];
  const breakdowns: NetWorthBreakdown[] = [];
  for (const characterId of ids) {
    breakdowns.push(await computeNetWorth(db, characterId, options));
  }

  const missingTypeIds: number[] = [];
  const seen = new Set<number>();
  for (const breakdown of breakdowns) {
    for (const typeId of breakdown.missingTypeIds) {
      if (seen.has(typeId)) continue;
      seen.add(typeId);
      missingTypeIds.push(typeId);
    }
  }

  // 去重的物品种类数：直接查库（跨角色去重；空角色列表直接为 0）
  let distinctTypeCount = 0;
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(', ');
    const rows = await db.select<{ total: number }>(
      `SELECT COUNT(DISTINCT type_id) AS total FROM assets WHERE character_id IN (${placeholders})`,
      ids,
    );
    distinctTypeCount = rows[0]?.total ?? 0;
  }

  const sum = (pick: (breakdown: NetWorthBreakdown) => number): number =>
    breakdowns.reduce((total, breakdown) => total + pick(breakdown), 0);

  return {
    characterIds: ids,
    totalValue: sum((item) => item.totalValue),
    assetsValue: sum((item) => item.assetsValue),
    walletBalance: sum((item) => item.walletBalance),
    sellOrdersValue: sum((item) => item.sellOrdersValue),
    contractsValue: sum((item) => item.contractsValue),
    distinctTypeCount,
    missingPriceTypes: missingTypeIds.length,
    missingTypeIds,
    characters: breakdowns,
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
    missingTypeIds: [],
  }));
}
