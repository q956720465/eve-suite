import type { DbAdapter } from '../db/types';
import type { MarketOrder } from '../esi/types';
import { insertRows } from '../sde/batch';

import { ORDER_COLUMNS, WRITE_BATCH_ROWS, toOrderRow } from './rows';

/**
 * 整区快照的**最小写入计划**（E1：只写变化行）。
 *
 * 背景（2026-09-30 实测，基准数据见 DEV_STATUS）：枢纽「整区替换」原先每次
 * `DELETE 全 40 万行 + INSERT 全 40 万行`，实测 **DELETE 5.2 s + INSERT 13.6 s ≈ 19 s**
 * 的写事务把 SQLite 写锁握住十几秒，其它写者（个人同步水位、历史初始化批写）
 * 只能在 `BEGIN IMMEDIATE` 上等，最长 10.99 s（撞满 busy_timeout）。
 * 而相邻两轮快照的实测差异极小：**order_id 留存 99.6%、内容变化仅 2.1%**
 * → 全量重写在绝大多数轮次里是纯浪费。
 *
 * 做法：**在事务外**读出本地该区旧快照（普通查询，不持写锁）→ 与新快照比对 →
 * 事务内只 `DELETE` 消失的 order_id + `upsert` 新增/变化的行。写事务从 ~19 s
 * 降到与「变化量」成正比（实测变化量 2.1% → 约 0.5 s）。
 *
 * 语义与全量替换**完全等价**（除未变化行的 `fetched_at` 保持旧值）：
 * - 未变化行的其余列与新快照逐列相等 → 不重写
 * - `market_stats` 仍按新快照全量重算（仅 1.9 万行，实测 0.14 s，不值得再 diff）
 */

/** 参与「内容是否变化」比较的列：`fetched_at` 只是抓取标记，不参与比较 */
export const ORDER_COMPARE_COLUMNS = ORDER_COLUMNS.filter((column) => column !== 'fetched_at');

export interface RegionOrderDiffPlan {
  /** 本地有、新快照没有 → 需删除的 order_id */
  vanishedOrderIds: number[];
  /** 新增或内容有变化 → 需 upsert 的整行（列顺序 = `ORDER_COLUMNS`，含 fetched_at） */
  upsertRows: unknown[][];
  /** 内容逐列一致、因此跳过的行数（诊断用） */
  unchangedCount: number;
}

/**
 * 计算最小写入计划。
 *
 * @param existingRows 事务外读出的本地旧行（列需包含 `ORDER_COMPARE_COLUMNS`）
 * @param newOrders 本轮新快照（已按 order_id 去重）
 * @param regionId 区域 ID
 * @param fetchedAt 本轮抓取时刻（写入 upsert 行的 `fetched_at`）
 */
export function planRegionOrderDiff(
  existingRows: readonly Record<string, unknown>[],
  newOrders: readonly MarketOrder[],
  regionId: number,
  fetchedAt: string,
): RegionOrderDiffPlan {
  const existing = new Map<number, readonly unknown[]>();
  for (const row of existingRows) {
    existing.set(Number(row.order_id), ORDER_COMPARE_COLUMNS.map((column) => row[column]));
  }

  const upsertRows: unknown[][] = [];
  const seen = new Set<number>();
  let unchangedCount = 0;
  /** 比较列在整行中的下标（只算一次；`fetched_at` 不参与比较） */
  const compareIndexes = ORDER_COMPARE_COLUMNS.map((column) => ORDER_COLUMNS.indexOf(column));

  for (const order of newOrders) {
    seen.add(order.order_id);
    const row = toOrderRow(order, regionId, fetchedAt);
    const incoming = compareIndexes.map((index) => row[index]);
    const previous = existing.get(order.order_id);
    if (previous !== undefined && sameValues(previous, incoming)) {
      unchangedCount += 1;
      continue;
    }
    upsertRows.push(row);
  }

  const vanishedOrderIds: number[] = [];
  for (const orderId of existing.keys()) {
    if (!seen.has(orderId)) vanishedOrderIds.push(orderId);
  }

  return { vanishedOrderIds, upsertRows, unchangedCount };
}

/** 逐列比较（DB 取回的 REAL/INTEGER 为 number、TEXT 为 string，与 toOrderRow 同类型） */
function sameValues(left: readonly unknown[], right: readonly unknown[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === b) continue;
    if (a === null || b === null || a === undefined || b === undefined) return false;
    if (String(a) !== String(b)) return false;
  }
  return true;
}

/** 删除消失行时的分批大小（避免 SQL 变量上限；SQLite 上限 32766） */
export const DELETE_BATCH_IDS = 500;

/**
 * 在给定事务内应用计划：先删消失行（分批），再 upsert 新增/变化行。
 *
 * 注意：**必须与 `market_stats` 的全量替换在同一个事务内**，以保持「整区原子可用」。
 */
export async function applyRegionOrderDiff(
  tx: DbAdapter,
  regionId: number,
  plan: RegionOrderDiffPlan,
): Promise<void> {
  for (let offset = 0; offset < plan.vanishedOrderIds.length; offset += DELETE_BATCH_IDS) {
    const chunk = plan.vanishedOrderIds.slice(offset, offset + DELETE_BATCH_IDS);
    const placeholders = chunk.map(() => '?').join(', ');
    await tx.execute(
      `DELETE FROM market_orders WHERE region_id = ? AND order_id IN (${placeholders})`,
      [regionId, ...chunk],
    );
  }

  await insertRows(tx, 'market_orders', ORDER_COLUMNS, plan.upsertRows, WRITE_BATCH_ROWS, {
    target: ['order_id'],
    update: ORDER_COLUMNS.filter((column) => column !== 'order_id'),
  });
}
