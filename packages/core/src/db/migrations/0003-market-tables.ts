import type { Migration } from '../types';

/**
 * P2 行情模块表结构。
 *
 * 存储红线（方案文档 §5）：
 * - 订单只存「最新快照」，覆盖写入，不留历史序列
 * - 细粒度历史仅由监视列表的 6 小时粒度聚合行承担
 * - 长期趋势依赖 ESI 官方 400 天日线
 *
 * 使用 statements 数组：运行时驱动 execute 只执行第一条语句，多语句必须逐条下发。
 */
export const MIGRATION_0003_MARKET_TABLES: Migration = {
  version: 3,
  name: 'market-tables',
  statements: [
    // 订单最新快照（每轮按区域整体替换）
    `CREATE TABLE IF NOT EXISTS market_orders (
      order_id      INTEGER PRIMARY KEY,
      region_id     INTEGER NOT NULL,
      type_id       INTEGER NOT NULL,
      location_id   INTEGER NOT NULL,
      price         REAL    NOT NULL,
      volume_total  INTEGER NOT NULL,
      volume_remain INTEGER NOT NULL,
      min_volume    INTEGER NOT NULL,
      is_buy_order  INTEGER NOT NULL,
      duration      INTEGER NOT NULL,
      issued        TEXT    NOT NULL,
      range         TEXT    NOT NULL,
      fetched_at    TEXT    NOT NULL
    );`,
    `CREATE INDEX IF NOT EXISTS idx_market_orders_region ON market_orders (region_id);`,
    `CREATE INDEX IF NOT EXISTS idx_market_orders_type ON market_orders (region_id, type_id);`,
    `CREATE INDEX IF NOT EXISTS idx_market_orders_side ON market_orders (region_id, is_buy_order, price);`,

    // 每物品每区域的最新聚合指标（覆盖写入）
    `CREATE TABLE IF NOT EXISTS market_stats (
      region_id    INTEGER NOT NULL,
      type_id      INTEGER NOT NULL,
      best_sell    REAL,
      best_buy     REAL,
      sell_volume  INTEGER NOT NULL DEFAULT 0,
      buy_volume   INTEGER NOT NULL DEFAULT 0,
      sell_orders  INTEGER NOT NULL DEFAULT 0,
      buy_orders   INTEGER NOT NULL DEFAULT 0,
      spread       REAL,
      p5_sell      REAL,
      p95_buy      REAL,
      updated_at   TEXT    NOT NULL,
      PRIMARY KEY (region_id, type_id)
    );`,
    `CREATE INDEX IF NOT EXISTS idx_market_stats_type ON market_stats (type_id);`,

    // ESI 官方日线历史（约 400 天）
    `CREATE TABLE IF NOT EXISTS market_history_daily (
      region_id   INTEGER NOT NULL,
      type_id     INTEGER NOT NULL,
      date        TEXT    NOT NULL,
      average     REAL    NOT NULL,
      highest     REAL    NOT NULL,
      lowest      REAL    NOT NULL,
      order_count INTEGER NOT NULL,
      volume      INTEGER NOT NULL,
      fetched_at  TEXT    NOT NULL,
      PRIMARY KEY (region_id, type_id, date)
    );`,
    `CREATE INDEX IF NOT EXISTS idx_market_history_type ON market_history_daily (type_id);`,

    // 监视列表
    `CREATE TABLE IF NOT EXISTS watchlist_items (
      watch_id   INTEGER PRIMARY KEY AUTOINCREMENT,
      type_id    INTEGER NOT NULL,
      region_id  INTEGER NOT NULL,
      note       TEXT,
      created_at TEXT    NOT NULL,
      UNIQUE (type_id, region_id)
    );`,

    // 监视列表的 6 小时粒度聚合行（细粒度历史的承担者）
    `CREATE TABLE IF NOT EXISTS watchlist_stats (
      watch_id    INTEGER NOT NULL,
      bucket_at   TEXT    NOT NULL,
      best_sell   REAL,
      best_buy    REAL,
      sell_volume INTEGER NOT NULL DEFAULT 0,
      buy_volume  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (watch_id, bucket_at)
    );`,

    // ETag 缓存（按 scope 复用 304，显著降低流量与写入）
    `CREATE TABLE IF NOT EXISTS market_etag_cache (
      scope      TEXT PRIMARY KEY,
      etag       TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`,

    // 采集状态（每区域一行）
    `CREATE TABLE IF NOT EXISTS market_collect_state (
      region_id       INTEGER PRIMARY KEY,
      last_started_at TEXT,
      last_ok_at      TEXT,
      last_error      TEXT,
      pages           INTEGER NOT NULL DEFAULT 0,
      orders_written  INTEGER NOT NULL DEFAULT 0,
      requests        INTEGER NOT NULL DEFAULT 0
    );`,
  ],
};
