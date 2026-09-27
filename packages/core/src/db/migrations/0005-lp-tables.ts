import type { Migration } from '../types';

/**
 * P4-3 LP 比价引擎表结构。
 *
 * 数据来源：**ESI 公共端点** `GET /loyalty/stores/{corporation_id}/offers/`（无需授权）。
 * 命名说明：方案 §5 曾写作 `sde_lp_offers`，但该数据**不来自 SDE**（SDE 不含 LP 商店），
 * 而是 ESI 实时端点，故不带 `sde_` 前缀。
 *
 * 使用 statements 数组：运行时驱动 execute 只执行第一条语句，多语句必须逐条下发。
 *
 * **主键口径（P4-3 真实数据实测修正）**：`offer_id` 在不同 NPC 军团之间**会重复**
 * （多个 LP 商店共用同一 offer，实测 1000035 与 1000041 等返回相同 offer_id），
 * 故 lp_offers 的主键是 `(corporation_id, offer_id)`，lp_offer_items 亦然。
 */
export const MIGRATION_0005_LP_TABLES: Migration = {
  version: 5,
  name: 'lp-tables',
  statements: [
    // LP 商店报价（每军团按整体替换写入）
    `CREATE TABLE IF NOT EXISTS lp_offers (
      corporation_id INTEGER NOT NULL,
      offer_id       INTEGER NOT NULL,
      type_id        INTEGER NOT NULL,
      quantity       INTEGER NOT NULL,
      lp_cost        INTEGER NOT NULL,
      isk_cost       INTEGER NOT NULL DEFAULT 0,
      ak_cost        INTEGER NOT NULL DEFAULT 0,
      fetched_at     TEXT    NOT NULL,
      PRIMARY KEY (corporation_id, offer_id)
    );`,
    `CREATE INDEX IF NOT EXISTS idx_lp_offers_corp ON lp_offers (corporation_id);`,
    `CREATE INDEX IF NOT EXISTS idx_lp_offers_type ON lp_offers (type_id);`,

    // 报价要求的兑换材料（一个 offer 可多行）
    `CREATE TABLE IF NOT EXISTS lp_offer_items (
      corporation_id INTEGER NOT NULL,
      offer_id       INTEGER NOT NULL,
      type_id        INTEGER NOT NULL,
      quantity       INTEGER NOT NULL,
      PRIMARY KEY (corporation_id, offer_id, type_id)
    );`,
    `CREATE INDEX IF NOT EXISTS idx_lp_offer_items_type ON lp_offer_items (type_id);`,

    // 每军团抓取水位（失败隔离：单军团失败只写该行 last_error）
    `CREATE TABLE IF NOT EXISTS lp_store_state (
      corporation_id  INTEGER PRIMARY KEY,
      last_started_at TEXT,
      last_ok_at      TEXT,
      last_error      TEXT,
      expires_at      TEXT,
      etag            TEXT,
      offers_written  INTEGER NOT NULL DEFAULT 0,
      requests        INTEGER NOT NULL DEFAULT 0
    );`,
  ],
};
