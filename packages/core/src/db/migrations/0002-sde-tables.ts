import type { Migration } from '../types';

/**
 * P1 静态数据（SDE）表结构。
 * 数据源：CCP 官方 SDE（JSONL zip），字段来自实际抽样核对（2026-09-24 build 3542233）。
 * 名称字段统一拆出中英文两列（来源为 name.{en,zh}，SDE 自带 8 语言对象）。
 *
 * 使用 statements 数组：运行时驱动 execute 只执行第一条语句，多语句必须逐条下发。
 */
export const MIGRATION_0002_SDE_TABLES: Migration = {
  version: 2,
  name: 'sde-tables',
  statements: [
    // 物品类别
    `CREATE TABLE IF NOT EXISTS sde_categories (
      category_id INTEGER PRIMARY KEY,
      name_en     TEXT NOT NULL,
      name_zh     TEXT,
      published   INTEGER NOT NULL DEFAULT 0
    );`,

    // 物品分组
    `CREATE TABLE IF NOT EXISTS sde_groups (
      group_id    INTEGER PRIMARY KEY,
      category_id INTEGER NOT NULL,
      name_en     TEXT NOT NULL,
      name_zh     TEXT,
      published   INTEGER NOT NULL DEFAULT 0
    );`,

    // 物品类型（核心表）
    `CREATE TABLE IF NOT EXISTS sde_types (
      type_id          INTEGER PRIMARY KEY,
      group_id         INTEGER NOT NULL,
      name_en          TEXT NOT NULL,
      name_zh          TEXT,
      description_en   TEXT,
      description_zh   TEXT,
      volume           REAL,
      packaged_volume  REAL,
      mass             REAL,
      capacity         REAL,
      portion_size     INTEGER,
      base_price       REAL,
      market_group_id  INTEGER,
      icon_id          INTEGER,
      published        INTEGER NOT NULL DEFAULT 0
    );`,

    // 星域
    `CREATE TABLE IF NOT EXISTS sde_regions (
      region_id INTEGER PRIMARY KEY,
      name_en   TEXT NOT NULL,
      name_zh   TEXT
    );`,

    // 星座
    `CREATE TABLE IF NOT EXISTS sde_constellations (
      constellation_id INTEGER PRIMARY KEY,
      region_id        INTEGER NOT NULL,
      name_en          TEXT NOT NULL,
      name_zh          TEXT
    );`,

    // 星系
    `CREATE TABLE IF NOT EXISTS sde_systems (
      system_id        INTEGER PRIMARY KEY,
      constellation_id INTEGER NOT NULL,
      region_id        INTEGER NOT NULL,
      name_en          TEXT NOT NULL,
      name_zh          TEXT,
      security_status  REAL,
      security_class   TEXT
    );`,

    // NPC 空间站（SDE 无 station 名，name_* 为本地按 system+owner+operation 规则合成）
    `CREATE TABLE IF NOT EXISTS sde_stations (
      station_id         INTEGER PRIMARY KEY,
      type_id            INTEGER NOT NULL,
      solar_system_id    INTEGER NOT NULL,
      region_id          INTEGER NOT NULL,
      owner_id           INTEGER NOT NULL,
      operation_id       INTEGER,
      celestial_index    INTEGER,
      orbit_index        INTEGER,
      orbit_id           INTEGER,
      use_operation_name INTEGER NOT NULL DEFAULT 0,
      name_en            TEXT NOT NULL,
      name_zh            TEXT,
      system_name_en     TEXT NOT NULL,
      system_name_zh     TEXT,
      region_name_en     TEXT NOT NULL,
      region_name_zh     TEXT
    );`,

    // 蓝图主表
    `CREATE TABLE IF NOT EXISTS sde_blueprints (
      blueprint_type_id    INTEGER PRIMARY KEY,
      max_production_limit INTEGER
    );`,

    // 蓝图活动（每个蓝图每种活动一行，time 为秒）
    `CREATE TABLE IF NOT EXISTS sde_blueprint_activities (
      blueprint_type_id INTEGER NOT NULL,
      activity          TEXT NOT NULL,
      time_seconds      INTEGER,
      PRIMARY KEY (blueprint_type_id, activity)
    );`,

    // 蓝图投入/产出（direction: input=材料, output=产品）
    `CREATE TABLE IF NOT EXISTS sde_blueprint_io (
      blueprint_type_id INTEGER NOT NULL,
      activity          TEXT NOT NULL,
      direction         TEXT NOT NULL,
      type_id           INTEGER NOT NULL,
      quantity          INTEGER NOT NULL,
      PRIMARY KEY (blueprint_type_id, activity, direction, type_id)
    );`,

    // SDE 元信息（版本号 / 导入时间 / 各表行数）
    `CREATE TABLE IF NOT EXISTS sde_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );`,

    // 搜索索引
    `CREATE INDEX IF NOT EXISTS idx_sde_types_name_en ON sde_types (name_en);`,
    `CREATE INDEX IF NOT EXISTS idx_sde_types_name_zh ON sde_types (name_zh);`,
    `CREATE INDEX IF NOT EXISTS idx_sde_types_group ON sde_types (group_id);`,
    `CREATE INDEX IF NOT EXISTS idx_sde_groups_category ON sde_groups (category_id);`,
    `CREATE INDEX IF NOT EXISTS idx_sde_systems_region ON sde_systems (region_id);`,
    `CREATE INDEX IF NOT EXISTS idx_sde_systems_name_en ON sde_systems (name_en);`,
    `CREATE INDEX IF NOT EXISTS idx_sde_systems_name_zh ON sde_systems (name_zh);`,
    `CREATE INDEX IF NOT EXISTS idx_sde_stations_system ON sde_stations (solar_system_id);`,
    `CREATE INDEX IF NOT EXISTS idx_sde_stations_region ON sde_stations (region_id);`,
    `CREATE INDEX IF NOT EXISTS idx_sde_stations_name_en ON sde_stations (name_en);`,
    `CREATE INDEX IF NOT EXISTS idx_sde_stations_name_zh ON sde_stations (name_zh);`,
    `CREATE INDEX IF NOT EXISTS idx_sde_bp_io_bp ON sde_blueprint_io (blueprint_type_id);`,
    `CREATE INDEX IF NOT EXISTS idx_sde_bp_io_type ON sde_blueprint_io (type_id);`,
    `CREATE INDEX IF NOT EXISTS idx_sde_constellations_region ON sde_constellations (region_id);`,
  ],
};
