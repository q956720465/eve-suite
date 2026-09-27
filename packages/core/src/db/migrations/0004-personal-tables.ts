import type { Migration } from '../types';

/**
 * P3 个人数据表结构（OAuth 授权后的角色数据）。
 *
 * 字段依据官方 OpenAPI 3.1 规格逐端点核对（2026-09-27，`https://esi.evetech.net/meta/openapi.json`；
 * Swagger 已于 2026-08-11 下线，`/latest/swagger.json` 返回 404）。
 *
 * 统一约定：
 * - 时间戳一律 TEXT（ISO 8601）；布尔用 INTEGER（0/1）
 * - `fetched_at` 记录抓取时刻，用于缓存新鲜度判断与排障
 * - ESI 的 `id` 字段在此映射为 `entry_id`，避免裸 `id` 在联表时歧义
 * - 可选字段确实存在（如 orders 的 `is_buy_order` / `escrow` / `min_volume`，ESI 为 false 时会省略）→ 对应列必须可空
 * - 覆盖型端点（assets / orders / contracts / industry_jobs / loyalty）按角色整体替换；
 *   追加型端点（wallet_journal / mining）按主键去重插入 —— 具体策略在 P3-5 实现
 *
 * 使用 statements 数组：运行时驱动 execute 只执行第一条语句，多语句必须逐条下发。
 */
export const MIGRATION_0004_PERSONAL_TABLES: Migration = {
  version: 4,
  name: 'personal-tables',
  statements: [
    // ── 已授权角色（name / scopes 来自 JWT；corporation_id 来自 /characters/{id} 公开端点）
    `CREATE TABLE IF NOT EXISTS characters (
      character_id     INTEGER PRIMARY KEY,
      name             TEXT    NOT NULL,
      corporation_id   INTEGER,
      scopes           TEXT    NOT NULL,
      wallet_balance   REAL,
      wallet_synced_at TEXT,
      added_at         TEXT    NOT NULL,
      last_sync_at     TEXT
    );`,

    // ── /characters/{character_id}/assets
    `CREATE TABLE IF NOT EXISTS assets (
      character_id      INTEGER NOT NULL,
      item_id           INTEGER NOT NULL,
      type_id           INTEGER NOT NULL,
      quantity          INTEGER NOT NULL,
      location_id       INTEGER NOT NULL,
      location_flag     TEXT    NOT NULL,
      location_type     TEXT    NOT NULL,
      is_singleton      INTEGER NOT NULL,
      is_blueprint_copy INTEGER,
      fetched_at        TEXT    NOT NULL,
      PRIMARY KEY (character_id, item_id)
    );`,
    `CREATE INDEX IF NOT EXISTS idx_assets_char_type ON assets (character_id, type_id);`,
    `CREATE INDEX IF NOT EXISTS idx_assets_char_location ON assets (character_id, location_id);`,

    // ── /characters/{character_id}/wallet/journal
    `CREATE TABLE IF NOT EXISTS wallet_journal (
      character_id     INTEGER NOT NULL,
      entry_id         INTEGER NOT NULL,
      date             TEXT    NOT NULL,
      ref_type         TEXT    NOT NULL,
      description      TEXT    NOT NULL,
      amount           REAL,
      balance          REAL,
      reason           TEXT,
      first_party_id   INTEGER,
      second_party_id  INTEGER,
      context_id       INTEGER,
      context_id_type  TEXT,
      tax              REAL,
      tax_receiver_id  INTEGER,
      fetched_at       TEXT    NOT NULL,
      PRIMARY KEY (character_id, entry_id)
    );`,
    `CREATE INDEX IF NOT EXISTS idx_wallet_journal_char_date ON wallet_journal (character_id, date);`,

    // ── /characters/{character_id}/orders（当前挂单，不含历史）
    `CREATE TABLE IF NOT EXISTS my_orders (
      character_id   INTEGER NOT NULL,
      order_id       INTEGER NOT NULL,
      type_id        INTEGER NOT NULL,
      region_id      INTEGER NOT NULL,
      location_id    INTEGER NOT NULL,
      price          REAL    NOT NULL,
      volume_total   INTEGER NOT NULL,
      volume_remain  INTEGER NOT NULL,
      is_corporation INTEGER NOT NULL,
      duration       INTEGER NOT NULL,
      issued         TEXT    NOT NULL,
      range          TEXT    NOT NULL,
      min_volume     INTEGER,
      is_buy_order   INTEGER,
      escrow         REAL,
      fetched_at     TEXT    NOT NULL,
      PRIMARY KEY (character_id, order_id)
    );`,
    `CREATE INDEX IF NOT EXISTS idx_my_orders_char_type ON my_orders (character_id, type_id);`,

    // ── /characters/{character_id}/contracts
    `CREATE TABLE IF NOT EXISTS contracts (
      character_id          INTEGER NOT NULL,
      contract_id           INTEGER NOT NULL,
      type                  TEXT    NOT NULL,
      status                TEXT    NOT NULL,
      availability          TEXT    NOT NULL,
      for_corporation       INTEGER NOT NULL,
      issuer_id             INTEGER NOT NULL,
      issuer_corporation_id INTEGER NOT NULL,
      assignee_id           INTEGER NOT NULL,
      acceptor_id           INTEGER NOT NULL,
      date_issued           TEXT    NOT NULL,
      date_expired          TEXT    NOT NULL,
      title                 TEXT,
      price                 REAL,
      reward                REAL,
      collateral            REAL,
      buyout                REAL,
      volume                REAL,
      days_to_complete      INTEGER,
      start_location_id     INTEGER,
      end_location_id       INTEGER,
      date_accepted         TEXT,
      date_completed        TEXT,
      fetched_at            TEXT    NOT NULL,
      PRIMARY KEY (character_id, contract_id)
    );`,
    `CREATE INDEX IF NOT EXISTS idx_contracts_char_status ON contracts (character_id, status);`,
    `CREATE INDEX IF NOT EXISTS idx_contracts_char_issued ON contracts (character_id, date_issued);`,

    // ── /characters/{character_id}/industry/jobs
    `CREATE TABLE IF NOT EXISTS industry_jobs (
      character_id           INTEGER NOT NULL,
      job_id                 INTEGER NOT NULL,
      activity_id            INTEGER NOT NULL,
      blueprint_id           INTEGER NOT NULL,
      blueprint_type_id      INTEGER NOT NULL,
      blueprint_location_id  INTEGER NOT NULL,
      output_location_id     INTEGER NOT NULL,
      facility_id            INTEGER NOT NULL,
      station_id             INTEGER NOT NULL,
      installer_id           INTEGER NOT NULL,
      runs                   INTEGER NOT NULL,
      status                 TEXT    NOT NULL,
      duration               INTEGER NOT NULL,
      start_date             TEXT    NOT NULL,
      end_date               TEXT    NOT NULL,
      product_type_id        INTEGER,
      licensed_runs          INTEGER,
      successful_runs        INTEGER,
      probability            REAL,
      cost                   REAL,
      pause_date             TEXT,
      completed_date         TEXT,
      completed_character_id INTEGER,
      fetched_at             TEXT    NOT NULL,
      PRIMARY KEY (character_id, job_id)
    );`,
    `CREATE INDEX IF NOT EXISTS idx_industry_jobs_char_status ON industry_jobs (character_id, status);`,

    // ── /characters/{character_id}/mining（ESI 无唯一 id → 复合主键）
    `CREATE TABLE IF NOT EXISTS mining_ledger (
      character_id    INTEGER NOT NULL,
      date            TEXT    NOT NULL,
      solar_system_id INTEGER NOT NULL,
      type_id         INTEGER NOT NULL,
      quantity        INTEGER NOT NULL,
      fetched_at      TEXT    NOT NULL,
      PRIMARY KEY (character_id, date, solar_system_id, type_id)
    );`,
    `CREATE INDEX IF NOT EXISTS idx_mining_ledger_char_date ON mining_ledger (character_id, date);`,

    // ── /characters/{character_id}/loyalty/points
    `CREATE TABLE IF NOT EXISTS lp_balances (
      character_id    INTEGER NOT NULL,
      corporation_id  INTEGER NOT NULL,
      loyalty_points  INTEGER NOT NULL,
      fetched_at      TEXT    NOT NULL,
      PRIMARY KEY (character_id, corporation_id)
    );`,

    // ── 每日净值快照（应用表；P3 口径 = 吉他最低卖价，P4 切估值引擎后可与分项对照）
    `CREATE TABLE IF NOT EXISTS networth_snapshots (
      character_id      INTEGER NOT NULL,
      snapshot_date     TEXT    NOT NULL,
      total_value       REAL    NOT NULL,
      assets_value      REAL    NOT NULL DEFAULT 0,
      wallet_balance    REAL    NOT NULL DEFAULT 0,
      sell_orders_value REAL    NOT NULL DEFAULT 0,
      contracts_value   REAL    NOT NULL DEFAULT 0,
      created_at        TEXT    NOT NULL,
      PRIMARY KEY (character_id, snapshot_date)
    );`,
    `CREATE INDEX IF NOT EXISTS idx_networth_snapshots_date ON networth_snapshots (snapshot_date);`,

    // ── 个人数据同步状态（每角色每端点一行）：ETag 复用 + Cache-Control 遵守 + 排障
    `CREATE TABLE IF NOT EXISTS personal_sync_state (
      character_id    INTEGER NOT NULL,
      scope           TEXT    NOT NULL,
      etag            TEXT,
      expires_at      TEXT,
      last_started_at TEXT,
      last_ok_at      TEXT,
      last_error      TEXT,
      pages           INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (character_id, scope)
    );`,
  ],
};
