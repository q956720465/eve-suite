import type { Migration } from '../types';

/**
 * P9-1 市场浏览页所需：游戏内市场左侧的「市场分组」树。
 *
 * 数据来源：官方 SDE `marketGroups.jsonl`（格式
 * `{"_key":<groupId>,"name":{...8语言},"hasTypes":<bool>,"iconID":<id>,"parentGroupID":<id>}`，
 * 2026-09 build 3552207 实测 2,114 行，其中 19 行为根节点（无 parentGroupID）。
 *
 * `sde_types.market_group_id` 自 P1（0002）起已入库，本迁移补上分组表与索引，
 * 使「分组 → 物品」可双向查询，供市场页组装三级树。
 */
export const MIGRATION_0011_MARKET_GROUPS: Migration = {
  version: 11,
  name: 'market-groups',
  statements: [
    `CREATE TABLE IF NOT EXISTS sde_market_groups (
      market_group_id  INTEGER PRIMARY KEY,
      parent_group_id  INTEGER,
      name_en          TEXT NOT NULL,
      name_zh          TEXT,
      icon_id          INTEGER,
      has_types        INTEGER NOT NULL DEFAULT 0
    );`,
    `CREATE INDEX IF NOT EXISTS idx_sde_market_groups_parent ON sde_market_groups (parent_group_id);`,
    `CREATE INDEX IF NOT EXISTS idx_sde_types_market_group ON sde_types (market_group_id);`,
  ],
};
