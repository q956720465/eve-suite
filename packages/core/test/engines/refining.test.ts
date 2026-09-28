import { describe, expect, it } from 'vitest';

import type { DbAdapter } from '../../src/db/types';
import {
  DEFAULT_REFINE_TAX,
  DEFAULT_REFINE_YIELD,
  computeRefinedQuantity,
  listOreMaterials,
  listRefinableOres,
  refineOre,
} from '../../src/engines/refining';
import { createMigratedDb } from '../helpers/db';

import { insertStats } from './fixtures';

const TRITANIUM = 34;
const PYERITE = 35;
const MEXALLON = 36;

const VELDSPAR = 1230;
const SCORDITE = 1228;
const NO_MAPPING_ORE = 1239;
const UNPUBLISHED_ORE = 999999;
const UNKNOWN_TYPE = 424242;

const VELDSPAR_GROUP = 462;
const MINERAL_GROUP = 18;
const ASTEROID_CATEGORY = 25;
const MATERIAL_CATEGORY = 4;

async function insertCategory(db: DbAdapter, id: number, nameEn: string): Promise<void> {
  await db.execute(
    'INSERT INTO sde_categories (category_id, name_en, name_zh, published) VALUES (?, ?, NULL, 1)',
    [id, nameEn],
  );
}

async function insertGroup(
  db: DbAdapter,
  id: number,
  categoryId: number,
  nameEn: string,
): Promise<void> {
  await db.execute(
    'INSERT INTO sde_groups (group_id, category_id, name_en, name_zh, published) VALUES (?, ?, ?, NULL, 1)',
    [id, categoryId, nameEn],
  );
}

async function insertType(
  db: DbAdapter,
  options: {
    typeId: number;
    groupId: number;
    nameEn: string;
    portionSize: number;
    volume: number;
    published?: number;
  },
): Promise<void> {
  await db.execute(
    `INSERT INTO sde_types (type_id, group_id, name_en, name_zh, volume, portion_size, published)
     VALUES (?, ?, ?, NULL, ?, ?, ?)`,
    [
      options.typeId,
      options.groupId,
      options.nameEn,
      options.volume,
      options.portionSize,
      options.published ?? 1,
    ],
  );
}

async function insertMaterials(
  db: DbAdapter,
  typeId: number,
  materials: readonly { typeId: number; quantity: number }[],
): Promise<void> {
  for (const material of materials) {
    await db.execute(
      'INSERT INTO sde_type_materials (type_id, material_type_id, quantity) VALUES (?, ?, ?)',
      [typeId, material.typeId, material.quantity],
    );
  }
}

/**
 * 测试库：真实取值的矿石映射
 * - Veldspar 1230 → 400 三钛 / 100 单位（volume 0.1）
 * - Scordite 1228 → 150 三钛 + 110 类晶体胶矿
 * - 三角矿 1239 有类型但无映射；999999 有映射但未发布
 */
async function setupDb() {
  const db = await createMigratedDb();
  await insertCategory(db, ASTEROID_CATEGORY, 'Asteroid');
  await insertCategory(db, MATERIAL_CATEGORY, 'Material');
  await insertGroup(db, VELDSPAR_GROUP, ASTEROID_CATEGORY, 'Veldspar');
  await insertGroup(db, MINERAL_GROUP, MATERIAL_CATEGORY, 'Mineral');

  await insertType(db, { typeId: TRITANIUM, groupId: MINERAL_GROUP, nameEn: 'Tritanium', portionSize: 1, volume: 0.01 });
  await insertType(db, { typeId: PYERITE, groupId: MINERAL_GROUP, nameEn: 'Pyerite', portionSize: 1, volume: 0.01 });
  await insertType(db, { typeId: MEXALLON, groupId: MINERAL_GROUP, nameEn: 'Mexallon', portionSize: 1, volume: 0.01 });
  await insertType(db, { typeId: VELDSPAR, groupId: VELDSPAR_GROUP, nameEn: 'Veldspar', portionSize: 100, volume: 0.1 });
  await insertType(db, { typeId: SCORDITE, groupId: VELDSPAR_GROUP, nameEn: 'Scordite', portionSize: 100, volume: 0.15 });
  await insertType(db, { typeId: NO_MAPPING_ORE, groupId: VELDSPAR_GROUP, nameEn: 'No Mapping Ore', portionSize: 100, volume: 0.2 });
  await insertType(db, {
    typeId: UNPUBLISHED_ORE,
    groupId: VELDSPAR_GROUP,
    nameEn: 'Unpublished Ore',
    portionSize: 100,
    volume: 0.3,
    published: 0,
  });

  await insertMaterials(db, VELDSPAR, [{ typeId: TRITANIUM, quantity: 400 }]);
  await insertMaterials(db, SCORDITE, [
    { typeId: TRITANIUM, quantity: 150 },
    { typeId: PYERITE, quantity: 110 },
  ]);
  await insertMaterials(db, UNPUBLISHED_ORE, [{ typeId: TRITANIUM, quantity: 100 }]);

  await insertStats(db, { typeId: TRITANIUM, p5Sell: 5 });
  await insertStats(db, { typeId: PYERITE, p5Sell: 8 });
  return db;
}

describe('computeRefinedQuantity', () => {
  it('向下取整，且非法输入返回 0', () => {
    expect(computeRefinedQuantity(400, 2, 0.5)).toBe(400);
    expect(computeRefinedQuantity(150, 1, 0.5)).toBe(75);
    expect(computeRefinedQuantity(403, 1, 0.5)).toBe(201); // 201.5 → 201
    expect(computeRefinedQuantity(400, 1, 0)).toBe(0);
    expect(computeRefinedQuantity(400, 0, 0.5)).toBe(0);
    expect(computeRefinedQuantity(0, 1, 1)).toBe(0);
    expect(computeRefinedQuantity(-400, 1, 1)).toBe(0);
    expect(computeRefinedQuantity(Number.NaN, 1, 1)).toBe(0);
  });
});

describe('refineOre', () => {
  it('默认口径：整份精炼 + 产出率 50% + 不扣税', async () => {
    const db = await setupDb();

    const result = await refineOre(db, { oreTypeId: VELDSPAR, quantity: 100 });

    expect(result).toMatchObject({
      quantity: 100,
      portionSize: 100,
      portions: 1,
      leftoverUnits: 0,
      yieldRate: DEFAULT_REFINE_YIELD,
      taxRate: DEFAULT_REFINE_TAX,
      outputValue: 1000, // floor(400 × 1 × 0.5) × 5
      netValue: 1000,
      valuePerUnit: 10,
      valuePerCubicMeter: 100, // 1000 ÷ (100 × 0.1)
      unmapped: false,
      missingTypeIds: [],
    });
    expect(result.materials).toEqual([
      {
        typeId: TRITANIUM,
        baseQuantity: 400,
        quantity: 200,
        unitPrice: 5,
        value: 1000,
        priced: true,
      },
    ]);
  });

  it('不足一份的余数不参与精炼（份数 = floor(数量 ÷ 份额)）', async () => {
    const db = await setupDb();

    const result = await refineOre(db, { oreTypeId: VELDSPAR, quantity: 250 });

    expect(result.portions).toBe(2);
    expect(result.leftoverUnits).toBe(50);
    expect(result.materials[0].quantity).toBe(400); // floor(400 × 2 × 0.5)
    expect(result.outputValue).toBe(2000);
    expect(result.valuePerUnit).toBe(8); // 2000 ÷ 250
    expect(result.valuePerCubicMeter).toBe(80); // 2000 ÷ 25 m³
  });

  it('产出率 100% 与税率 10%', async () => {
    const db = await setupDb();

    const full = await refineOre(db, { oreTypeId: VELDSPAR, quantity: 100, yieldRate: 1 });
    expect(full.materials[0].quantity).toBe(400);
    expect(full.netValue).toBe(2000);

    const taxed = await refineOre(db, {
      oreTypeId: VELDSPAR,
      quantity: 100,
      yieldRate: 1,
      taxRate: 0.1,
    });
    expect(taxed.outputValue).toBe(2000);
    expect(taxed.netValue).toBe(1800); // 税按产值扣减，不减产物数量
    expect(taxed.materials[0].quantity).toBe(400);
  });

  it('多产物：逐矿物折算与求和', async () => {
    const db = await setupDb();

    const result = await refineOre(db, { oreTypeId: SCORDITE, quantity: 100, yieldRate: 1 });

    expect(result.materials).toEqual([
      { typeId: TRITANIUM, baseQuantity: 150, quantity: 150, unitPrice: 5, value: 750, priced: true },
      { typeId: PYERITE, baseQuantity: 110, quantity: 110, unitPrice: 8, value: 880, priced: true },
    ]);
    expect(result.outputValue).toBe(1630);
  });

  it('缺价产物计 0 并列入 missingTypeIds（不虚构估值）', async () => {
    const db = await setupDb();
    await insertMaterials(db, VELDSPAR, [{ typeId: MEXALLON, quantity: 7 }]);

    const result = await refineOre(db, { oreTypeId: VELDSPAR, quantity: 100 });

    expect(result.missingTypeIds).toEqual([MEXALLON]);
    expect(result.materials.find((line) => line.typeId === MEXALLON)).toMatchObject({
      quantity: 3, // floor(7 × 1 × 0.5)
      unitPrice: null,
      value: 0,
      priced: false,
    });
    expect(result.outputValue).toBe(1000); // 三钛仍照算
  });

  it('口径透传：换基准区域后无价 → 全部计入缺失', async () => {
    const db = await setupDb();

    const result = await refineOre(db, {
      oreTypeId: VELDSPAR,
      quantity: 100,
      valuation: { regionId: 10000043 },
    });

    expect(result.missingTypeIds).toEqual([TRITANIUM]);
    expect(result.outputValue).toBe(0);
    expect(result.netValue).toBe(0);
  });

  it('无映射矿石与不存在的类型：返回 unmapped，不抛错', async () => {
    const db = await setupDb();

    const noMapping = await refineOre(db, { oreTypeId: NO_MAPPING_ORE, quantity: 100 });
    expect(noMapping.unmapped).toBe(true);
    expect(noMapping.portionSize).toBe(100);
    expect(noMapping.portions).toBe(1);
    expect(noMapping.materials).toEqual([]);

    const unknown = await refineOre(db, { oreTypeId: UNKNOWN_TYPE, quantity: 100 });
    expect(unknown.unmapped).toBe(true);
    expect(unknown.portionSize).toBe(1); // 未知类型回退为 1
    expect(unknown.portions).toBe(100);
    expect(unknown.valuePerCubicMeter).toBeNull();
  });

  it('数量为 0：产出为 0，不除零', async () => {
    const db = await setupDb();

    const result = await refineOre(db, { oreTypeId: VELDSPAR, quantity: 0 });

    expect(result.portions).toBe(0);
    expect(result.materials[0].quantity).toBe(0);
    expect(result.outputValue).toBe(0);
    expect(result.valuePerUnit).toBe(0);
  });

  it('产出率与税率的非法值回退为默认', async () => {
    const db = await setupDb();

    const result = await refineOre(db, {
      oreTypeId: VELDSPAR,
      quantity: 100,
      yieldRate: Number.NaN,
      taxRate: -1,
    });

    expect(result.yieldRate).toBe(DEFAULT_REFINE_YIELD);
    expect(result.taxRate).toBe(0);
  });

  /**
   * 第三方算例零误差（EVE University wiki「Reprocessing」页面的实机示例）：
   * 120,000 单位 Plagioclase，产出率 = 50% × 1.15 × 1.1 × 1.1 = 69.575%
   * → 页面给出 146,107 三钛 + 58,443 第二矿物。
   *
   * 注：该页面文字把第二矿物标为 Pyerite（页面自标「待更新」，属陈旧文字），
   * 而官方 SDE 的 materialTypeID 为 Mexallon（36）——**数量 70 完全一致**；
   * 本用例核对的是数量与「floor(基础量 × 份数 × 产出率)」这一口径。
   */
  it('第三方算例零误差：120,000 Plagioclase @ 69.575% → 146,107 + 58,443', async () => {
    const db = await setupDb();
    await insertType(db, {
      typeId: 18,
      groupId: VELDSPAR_GROUP,
      nameEn: 'Plagioclase',
      portionSize: 100,
      volume: 0.35,
    });
    await insertMaterials(db, 18, [
      { typeId: TRITANIUM, quantity: 175 },
      { typeId: MEXALLON, quantity: 70 },
    ]);
    await insertStats(db, { typeId: MEXALLON, p5Sell: 51.14 });

    const result = await refineOre(db, {
      oreTypeId: 18,
      quantity: 120_000,
      yieldRate: 0.69575,
    });

    expect(result.portions).toBe(1200);
    expect(result.materials[0].quantity).toBe(146_107); // floor(175 × 1200 × 0.69575) = floor(146107.5)
    expect(result.materials[1].quantity).toBe(58_443); // floor(70 × 1200 × 0.69575)
    expect(result.missingTypeIds).toEqual([]);
  });
});

describe('listOreMaterials / listRefinableOres', () => {
  it('原始映射按 material_type_id 排序', async () => {
    const db = await setupDb();

    expect(await listOreMaterials(db, SCORDITE)).toEqual([
      { typeId: TRITANIUM, quantity: 150 },
      { typeId: PYERITE, quantity: 110 },
    ]);
    expect(await listOreMaterials(db, NO_MAPPING_ORE)).toEqual([]);
  });

  it('可精炼矿石清单：只含「已发布 + Asteroid 分类 + 有映射」', async () => {
    const db = await setupDb();

    const ores = await listRefinableOres(db);

    // 按 type_id 升序：1228 Scordite < 1230 Veldspar
    expect(ores.map((ore) => ore.typeId)).toEqual([SCORDITE, VELDSPAR]);
    expect(ores.find((ore) => ore.typeId === VELDSPAR)).toMatchObject({
      nameEn: 'Veldspar',
      portionSize: 100,
      volume: 0.1,
      materialCount: 1,
    });
    expect(ores.find((ore) => ore.typeId === SCORDITE)?.materialCount).toBe(2);
  });
});
