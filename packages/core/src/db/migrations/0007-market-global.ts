import type { Migration } from '../types';

/**
 * P5-1 全域层（跨区快照）扫描状态。
 *
 * 存储红线（方案文档 §4.1 / §5）：
 * - 全域订单**只存最新快照**（复用 `market_orders` / `market_stats`，按区域整区替换），不留历史序列；
 * - 本表只存「整轮扫描」的单行状态（档位本身存 `settings` 表，见 `db/settings.ts`）。
 *
 * 单行表用 `CHECK (id = 1)` 约束，避免出现多行状态互相覆盖。
 * 各区域的成功水位复用既有的 `market_collect_state`
 * （`last_ok_at` 早于本轮开始时刻的区域 = 本轮尚未完成 → 断点续扫的依据）。
 */
export const MIGRATION_0007_MARKET_GLOBAL: Migration = {
  version: 7,
  name: 'market-global-scan',
  statements: [
    `CREATE TABLE IF NOT EXISTS market_global_scan_state (
      id               INTEGER PRIMARY KEY CHECK (id = 1),
      last_started_at  TEXT,
      last_finished_at TEXT,
      last_full_ok_at  TEXT,
      last_error       TEXT,
      retry_due_at     TEXT,
      regions_total    INTEGER NOT NULL DEFAULT 0,
      regions_ok       INTEGER NOT NULL DEFAULT 0,
      regions_failed   INTEGER NOT NULL DEFAULT 0,
      requests         INTEGER NOT NULL DEFAULT 0,
      orders_written   INTEGER NOT NULL DEFAULT 0,
      elapsed_ms       INTEGER NOT NULL DEFAULT 0
    );`,
  ],
};
