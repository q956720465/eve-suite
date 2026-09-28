import type { Migration } from '../types';

/**
 * P5-2.6 枢纽历史基线预拉的扫描状态。
 *
 * 为什么单独一张表：
 * - 预拉是**独立于全域订单轮次**的后台任务（周期 24h，全域订单轮次默认 6h），
 *   两者各自的到期锚点 / 进度 / 错误不能共用同一行状态；
 * - 需要结构化存 `last_full_ok_at`（到期锚点）、`last_error`、多项计数，
 *   塞进 `settings` 键值表要拼串，不如与 `market_global_scan_state` 同构。
 *
 * 存储红线（沿用方案 §5）：
 * - 预拉只往既有的 `market_history_daily` 写（`refreshTypeHistory` 整对替换），
 *   **不新增历史数据表**；
 * - 本表只存「整轮预拉」的单行状态，单行用 `CHECK (id = 1)` 约束。
 *
 * 断点续扫不需要水位列：`market_history_daily.fetched_at` 的「当日已抓取」判定
 * （`isHistoryFetchedToday`）天然提供幂等与续跑依据。
 */
export const MIGRATION_0008_HISTORY_BACKFILL: Migration = {
  version: 8,
  name: 'history-backfill-scan',
  statements: [
    `CREATE TABLE IF NOT EXISTS market_history_backfill_state (
      id               INTEGER PRIMARY KEY CHECK (id = 1),
      last_started_at  TEXT,
      last_finished_at TEXT,
      last_full_ok_at  TEXT,
      last_error       TEXT,
      retry_due_at     TEXT,
      pairs_total      INTEGER NOT NULL DEFAULT 0,
      pairs_ok         INTEGER NOT NULL DEFAULT 0,
      pairs_skipped    INTEGER NOT NULL DEFAULT 0,
      pairs_failed     INTEGER NOT NULL DEFAULT 0,
      days_written     INTEGER NOT NULL DEFAULT 0,
      elapsed_ms       INTEGER NOT NULL DEFAULT 0
    );`,
  ],
};
