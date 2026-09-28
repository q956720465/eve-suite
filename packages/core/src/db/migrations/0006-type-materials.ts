import type { Migration } from '../types';

/**
 * P4-4 矿石精炼值引擎所需：矿石 / 冰 / 月矿 → 矿物（或产物）映射。
 *
 * 数据来源：官方 SDE `typeMaterials.jsonl`（格式
 * `{"_key":<typeId>,"materials":[{"materialTypeID":<id>,"quantity":<n>}]}`，
 * 2026-09 build 3542233 实测 9,555 行）。P1 导入时未包含该文件，P4-4 扩导入后写入本表。
 *
 * 说明：该文件覆盖所有「可精炼 / 可拆解」的类型，不限于矿石；
 * 是否为矿石由 `sde_types` + `sde_groups.category_id = 25`（Asteroid）判定，
 * 本表只存映射关系。
 */
export const MIGRATION_0006_TYPE_MATERIALS: Migration = {
  version: 6,
  name: 'type-materials',
  statements: [
    `CREATE TABLE IF NOT EXISTS sde_type_materials (
      type_id          INTEGER NOT NULL,
      material_type_id INTEGER NOT NULL,
      quantity         INTEGER NOT NULL,
      PRIMARY KEY (type_id, material_type_id)
    );`,
    `CREATE INDEX IF NOT EXISTS idx_type_materials_material ON sde_type_materials (material_type_id);`,
  ],
};
