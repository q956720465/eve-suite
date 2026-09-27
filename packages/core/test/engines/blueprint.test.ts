import { describe, expect, it } from 'vitest';

import {
  adjustJobSeconds,
  adjustMaterialQuantity,
  computeBlueprintCost,
  DEFAULT_BLUEPRINT_ACTIVITY,
  getBlueprintActivities,
  getBlueprintMaterials,
  getBlueprintProducts,
  normalizeRuns,
} from '../../src/engines/blueprint';
import { valueItems } from '../../src/engines/valuation';
import { createMigratedDb } from '../helpers/db';
import { insertBlueprint, insertStats } from './fixtures';

const COVETOR_BP = 17477;
const COVETOR = 17476;
const HULK_BP = 22545;

/** 与真实 SDE 同构的样本：妄想级蓝图（制造材料 + 发明材料 + 两活动） */
async function setupCovetorBlueprint() {
  const db = await createMigratedDb();
  await insertStats(db, { typeId: 34, bestSell: 3.75, p5Sell: 5 }); // 三钛合金
  await insertStats(db, { typeId: 35, bestSell: 2.5, p5Sell: 2 }); // 类晶体胶矿
  await insertBlueprint(db, {
    blueprintTypeId: COVETOR_BP,
    maxProductionLimit: 10,
    activities: [
      { activity: 'manufacturing', timeSeconds: 12000 },
      { activity: 'invention', timeSeconds: 128100 },
    ],
    io: [
      { direction: 'input', typeId: 34, quantity: 1_600_000 },
      { direction: 'input', typeId: 35, quantity: 300_000 },
      { direction: 'input', typeId: 20410, quantity: 8, activity: 'invention' },
      { direction: 'output', typeId: COVETOR, quantity: 1 },
      { direction: 'output', typeId: HULK_BP, quantity: 1, activity: 'invention' },
    ],
  });
  return db;
}

describe('normalizeRuns', () => {
  it('归一到不小于 1 的整数', () => {
    expect(normalizeRuns(undefined)).toBe(1);
    expect(normalizeRuns(0)).toBe(1);
    expect(normalizeRuns(-3)).toBe(1);
    expect(normalizeRuns(2.7)).toBe(2);
    expect(normalizeRuns(5)).toBe(5);
  });
});

describe('adjustMaterialQuantity（ME 折扣）', () => {
  it('ME 0 时等于 基础量 × runs', () => {
    expect(adjustMaterialQuantity(1_600_000, 1, 0)).toBe(1_600_000);
    expect(adjustMaterialQuantity(100, 3, 0)).toBe(300);
  });

  it('取整发生在任务层面（不是每 run 分别取整）', () => {
    // 每 run 取整再乘会是 ceil(2.85)×10 = 30
    expect(adjustMaterialQuantity(3, 10, 5)).toBe(29);
    expect(adjustMaterialQuantity(1_600_000, 1, 10)).toBe(1_440_000);
  });

  it('每 run 至少 1 单位（下限为 runs）', () => {
    expect(adjustMaterialQuantity(1, 10, 10)).toBe(10);
    expect(adjustMaterialQuantity(1, 100, 10)).toBe(100);
    expect(adjustMaterialQuantity(1, 1, 10)).toBe(1);
  });

  it('向上取整且不受浮点伪影放大', () => {
    expect(adjustMaterialQuantity(3, 1, 10)).toBe(3); // 2.7 → 3
    expect(adjustMaterialQuantity(1, 3, 10)).toBe(3); // 2.7 → 3，且不低于 runs
    expect(adjustMaterialQuantity(7, 1, 3)).toBe(7); // 6.79 → 7
  });

  it('ME 超界按上限截断、负值按下限截断', () => {
    expect(adjustMaterialQuantity(100, 1, 15)).toBe(90);
    expect(adjustMaterialQuantity(100, 1, -5)).toBe(100);
  });

  it('runs 归一后参与计算', () => {
    expect(adjustMaterialQuantity(100, 0, 0)).toBe(100);
    expect(adjustMaterialQuantity(100, 2.7, 0)).toBe(200);
  });
});

describe('adjustJobSeconds（TE 折扣）', () => {
  it('按 TE 折扣并向上取整', () => {
    expect(adjustJobSeconds(12000, 1, 0)).toBe(12000);
    expect(adjustJobSeconds(12000, 1, 10)).toBe(10800);
    expect(adjustJobSeconds(12000, 1, 20)).toBe(9600);
    expect(adjustJobSeconds(12000, 3, 10)).toBe(32400);
    expect(adjustJobSeconds(4200, 1, 5)).toBe(3990);
  });

  it('TE 超界截断到 20，runs 归一', () => {
    expect(adjustJobSeconds(12000, 1, 25)).toBe(9600);
    expect(adjustJobSeconds(12000, 0, 0)).toBe(12000);
  });
});

describe('getBlueprint* 数据查询', () => {
  it('活动 / 材料 / 产出按活动区分', async () => {
    const db = await setupCovetorBlueprint();

    await expect(getBlueprintActivities(db, COVETOR_BP)).resolves.toEqual([
      { activity: 'invention', timeSeconds: 128100 },
      { activity: 'manufacturing', timeSeconds: 12000 },
    ]);

    await expect(getBlueprintMaterials(db, COVETOR_BP)).resolves.toEqual([
      { typeId: 34, baseQuantity: 1_600_000 },
      { typeId: 35, baseQuantity: 300_000 },
    ]);
    await expect(getBlueprintProducts(db, COVETOR_BP)).resolves.toEqual([
      { typeId: COVETOR, quantityPerRun: 1 },
    ]);

    // 发明的材料与产出与制造互不串味
    await expect(getBlueprintMaterials(db, COVETOR_BP, 'invention')).resolves.toEqual([
      { typeId: 20410, baseQuantity: 8 },
    ]);
    await expect(getBlueprintProducts(db, COVETOR_BP, 'invention')).resolves.toEqual([
      { typeId: HULK_BP, quantityPerRun: 1 },
    ]);
  });
});

describe('computeBlueprintCost', () => {
  it('默认口径：制造 / 1 run / ME0，材料走估值引擎单价', async () => {
    const db = await setupCovetorBlueprint();

    const result = await computeBlueprintCost(db, COVETOR_BP);

    expect(result.activity).toBe(DEFAULT_BLUEPRINT_ACTIVITY);
    expect(result.runs).toBe(1);
    expect(result.maxProductionLimit).toBe(10);
    expect(result.activities).toHaveLength(2);
    expect(result.product).toEqual({ typeId: COVETOR, quantityPerRun: 1, totalQuantity: 1 });
    expect(result.materials).toEqual([
      { typeId: 34, baseQuantity: 1_600_000, quantity: 1_600_000, unitPrice: 5, value: 8_000_000, priced: true },
      { typeId: 35, baseQuantity: 300_000, quantity: 300_000, unitPrice: 2, value: 600_000, priced: true },
    ]);
    expect(result.materialCost).toBe(8_600_000);
    expect(result.blueprintPrice).toBeNull();
    expect(result.totalCost).toBe(8_600_000);
    expect(result.costPerUnit).toBe(8_600_000);
    expect(result.jobSeconds).toBe(12000);
    expect(result.missingTypeIds).toEqual([]);
  });

  it('ME 与 runs 生效：ME10 单 run 与 ME10 三 run', async () => {
    const db = await setupCovetorBlueprint();

    const oneRun = await computeBlueprintCost(db, COVETOR_BP, { me: 10 });
    expect(oneRun.materials.map((row) => row.quantity)).toEqual([1_440_000, 270_000]);
    expect(oneRun.materialCost).toBe(7_740_000);
    expect(oneRun.costPerUnit).toBe(7_740_000);

    const threeRuns = await computeBlueprintCost(db, COVETOR_BP, { me: 10, runs: 3 });
    expect(threeRuns.materials.map((row) => row.quantity)).toEqual([4_320_000, 810_000]);
    expect(threeRuns.product?.totalQuantity).toBe(3);
    expect(threeRuns.materialCost).toBe(23_220_000);
    expect(threeRuns.costPerUnit).toBe(7_740_000); // 23,220,000 ÷ 3
    expect(threeRuns.jobSeconds).toBe(36_000);
  });

  it('TE 只影响任务时长，不影响材料', async () => {
    const db = await setupCovetorBlueprint();

    const noTe = await computeBlueprintCost(db, COVETOR_BP, { runs: 2 });
    const withTe = await computeBlueprintCost(db, COVETOR_BP, { runs: 2, te: 10 });

    expect(noTe.jobSeconds).toBe(24_000);
    expect(withTe.jobSeconds).toBe(21_600);
    expect(noTe.materialCost).toBe(17_200_000); // 8,600,000 × 2 runs
    expect(withTe.materialCost).toBe(noTe.materialCost);
  });

  it('多件产出：总产出与单位成本按产出量摊', async () => {
    const db = await createMigratedDb();
    await insertStats(db, { typeId: 34, p5Sell: 5 });
    await insertBlueprint(db, {
      blueprintTypeId: 803,
      activities: [{ activity: 'manufacturing', timeSeconds: 600 }],
      io: [
        { direction: 'input', typeId: 34, quantity: 100 },
        { direction: 'output', typeId: 202, quantity: 100 },
      ],
    });

    const result = await computeBlueprintCost(db, 803, { runs: 5 });

    expect(result.product).toEqual({ typeId: 202, quantityPerRun: 100, totalQuantity: 500 });
    expect(result.materialCost).toBe(2_500); // 100 × 5 runs × 5 ISK
    expect(result.costPerUnit).toBe(5);
    expect(result.maxProductionLimit).toBeNull();
  });

  it('无产出行（SDE 存在此类蓝图）：product 与单位成本为 null，材料照算', async () => {
    const db = await createMigratedDb();
    await insertStats(db, { typeId: 34, p5Sell: 5 });
    await insertBlueprint(db, {
      blueprintTypeId: 999001,
      activities: [{ activity: 'manufacturing', timeSeconds: 60 }],
      io: [{ direction: 'input', typeId: 34, quantity: 10 }],
    });

    const result = await computeBlueprintCost(db, 999001);

    expect(result.product).toBeNull();
    expect(result.costPerUnit).toBeNull();
    expect(result.materialCost).toBe(50);
  });

  it('非蓝图（无任何 SDE 行）：返回空结构不抛错', async () => {
    const db = await createMigratedDb();

    const result = await computeBlueprintCost(db, 424242);

    expect(result.activities).toEqual([]);
    expect(result.materials).toEqual([]);
    expect(result.product).toBeNull();
    expect(result.materialCost).toBe(0);
    expect(result.totalCost).toBe(0);
    expect(result.costPerUnit).toBeNull();
    expect(result.jobSeconds).toBeNull();
    expect(result.maxProductionLimit).toBeNull();
    expect(result.missingTypeIds).toEqual([]);
  });

  it('缺价材料计 0 并列入 missingTypeIds', async () => {
    const db = await createMigratedDb();
    await insertStats(db, { typeId: 34, p5Sell: 5 });
    await insertBlueprint(db, {
      blueprintTypeId: 999002,
      activities: [{ activity: 'manufacturing', timeSeconds: 60 }],
      io: [
        { direction: 'input', typeId: 34, quantity: 10 },
        { direction: 'input', typeId: 99, quantity: 4 }, // 无报价
        { direction: 'output', typeId: 500, quantity: 1 },
      ],
    });

    const result = await computeBlueprintCost(db, 999002);

    expect(result.materials.map((row) => row.priced)).toEqual([true, false]);
    expect(result.materials[1]).toMatchObject({ typeId: 99, unitPrice: null, value: 0 });
    expect(result.materialCost).toBe(50);
    expect(result.missingTypeIds).toEqual([99]);
  });

  it('includeBlueprintPrice：可选计入蓝图自身价格', async () => {
    const db = await setupCovetorBlueprint();
    await insertStats(db, { typeId: COVETOR_BP, p5Sell: 2_000_000 });

    const without = await computeBlueprintCost(db, COVETOR_BP);
    expect(without.blueprintPrice).toBeNull();
    expect(without.totalCost).toBe(8_600_000);

    const withPrice = await computeBlueprintCost(db, COVETOR_BP, { includeBlueprintPrice: true });
    expect(withPrice.blueprintPrice).toBe(2_000_000);
    expect(withPrice.totalCost).toBe(10_600_000);
    expect(withPrice.costPerUnit).toBe(10_600_000);
  });

  it('可切换活动（invention）：材料/产出/时长随之切换', async () => {
    const db = await setupCovetorBlueprint();

    const result = await computeBlueprintCost(db, COVETOR_BP, { activity: 'invention' });

    expect(result.product).toEqual({ typeId: HULK_BP, quantityPerRun: 1, totalQuantity: 1 });
    expect(result.materials.map((row) => row.typeId)).toEqual([20410]);
    expect(result.materialCost).toBe(0);
    expect(result.missingTypeIds).toEqual([20410]);
    expect(result.jobSeconds).toBe(128100);
  });

  it('估价口径透传：估值引擎独立调用与引擎内材料成本一致', async () => {
    const db = await setupCovetorBlueprint();

    const result = await computeBlueprintCost(db, COVETOR_BP, { me: 10, runs: 3, basis: 'best_sell' });
    const expected = await valueItems(
      db,
      [
        { typeId: 34, quantity: 1_440_000 * 3 },
        { typeId: 35, quantity: 270_000 * 3 },
      ],
      { basis: 'best_sell' },
    );

    expect(expected.items.map((item) => item.unitPrice)).toEqual([3.75, 2.5]);
    expect(result.materialCost).toBe(expected.totalValue);
  });

  it('基准区域透传：他区价格不参与本区估值', async () => {
    const db = await setupCovetorBlueprint();

    const jita = await computeBlueprintCost(db, COVETOR_BP);
    const amarr = await computeBlueprintCost(db, COVETOR_BP, { regionId: 10000043 });

    expect(jita.materialCost).toBe(8_600_000);
    expect(amarr.materialCost).toBe(0);
    expect(amarr.missingTypeIds).toEqual([34, 35]);
  });
});
