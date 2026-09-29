import type { Migration } from '../types';

/**
 * P5-7 提醒系统：规则表（方案 §5 的应用表 `notify_rules`）。
 *
 * 两类规则共用一表，按 `kind` 区分：
 * - `undercut`：我的卖单 vs 该物品当前参照价（`p5_sell` / `best_sell`），差额超阈值触发；
 *   至多一条（界面按「全局设置」呈现）
 * - `watch_price`：某监视条目（`watchlist_items.watch_id`）的价格带越界触发；可多条
 *
 * 为什么用独立表而不是塞 `settings`：规则需要**逐条状态**（`last_fired_at` 用于边沿判定与冷却），
 * 键值表无法承载列表语义。
 *
 * Webhook 通道配置（地址 / 类型 / 加签密钥）仍放 `settings`（键 `notify.webhook`）——
 * 它是**单例配置**而非列表。
 */
export const MIGRATION_0010_NOTIFY_RULES: Migration = {
  version: 10,
  name: 'notify-rules',
  statements: [
    `CREATE TABLE IF NOT EXISTS notify_rules (
      rule_id           INTEGER PRIMARY KEY,
      kind              TEXT    NOT NULL CHECK (kind IN ('undercut', 'watch_price')),
      enabled           INTEGER NOT NULL DEFAULT 1,
      threshold_percent REAL,
      threshold_isk     REAL,
      region_id         INTEGER,
      basis             TEXT,
      watch_id          INTEGER,
      min_price         REAL,
      max_price         REAL,
      quiet_start_hour  INTEGER,
      quiet_end_hour    INTEGER,
      last_fired_at     TEXT,
      created_at        TEXT    NOT NULL
    );`,

    `CREATE INDEX IF NOT EXISTS idx_notify_rules_kind ON notify_rules (kind, enabled);`,

    // 一个监视条目只允许一条价格带规则（undercut 规则的 watch_id 为 NULL，不在本索引范围内）
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_notify_rules_watch ON notify_rules (watch_id) WHERE kind = 'watch_price';`,
  ],
};
