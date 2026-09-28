import { describe, expect, it } from 'vitest';

import { computeInventoryGap, getOwnedQuantities } from '../../src/engines/inventory';
import { createMigratedDb } from '../helpers/db';
import { AMARR, JITA, insertAsset, insertBlueprint, insertStats } from './fixtures';

const BP = 1000;
const PRODUCT = 2000;
const MAT_A = 34; // 基础量 100
const MAT_B = 35; // 基础量 50
const MAT_C = 36; // 基础量 10

/** 样本蓝图：制造业 3 种材料，单次流程上限 10 */
async function setup() {
  const db = await createMigratedDb();
  await insertBlueprint(db, {
    blueprintTypeId: BP,
    maxProductionLimit: 10,
    activities: [{ activity: 'manufacturing', timeSeconds: 600 }],
    io: [
      { direction: 'input', typeId: MAT_A, quantity: 100 },
      { direction: 'input', typeId: MAT_B, quantity: 50 },
      { direction: 'input', typeId: MAT_C, quantity: 10 },
      { direction: 'output', typeId: PRODUCT, quantity: 1 },
    ],
  });
  return db;
}

async function seedPrices(
  db: Awaited<ReturnType<typeof createMigratedDb>>,
  prices: Record<number, Record<number, number>>,
): Promise<void> {
  for (const [regionId, byType] of Object.entries(prices)) {
    for (const [typeId, price] of Object.entries(byType)) {
      await insertStats(db, { regionId: Number(regionId), typeId: Number(typeId), p5Sell: price });
    }
  }
}

describe('getOwnedQuantities（跨角色聚合）', () => {
  it('合计全部角色的持有量，且忽略负 quantity（BPC 的 -1 标记）', async () => {
    const db = await createMigratedDb();
    await insertAsset(db, { characterId: 1, itemId: 1, typeId: MAT_A, quantity: 30 });
    await insertAsset(db, { characterId: 2, itemId: 1, typeId: MAT_A, quantity: 40 });
    await insertAsset(db, { characterId: 1, itemId: 2, typeId: MAT_B, quantity: -1 }); // 蓝图复制品标记

    const owned = await getOwnedQuantities(db, [MAT_A, MAT_B]);

    expect(owned.get(MAT_A)).toBe(70);
    expect(owned.get(MAT_B)).toBe(0); // -1 不计成负库存
  });

  it('空 typeIds 直接返回空表（不查询）', async () => {
    const db = await createMigratedDb();
    await insertAsset(db, { characterId: 1, itemId: 1, typeId: MAT_A, quantity: 5 });

    expect((await getOwnedQuantities(db, [])).size).toBe(0);
  });
});

describe('computeInventoryGap（缺口 + 多枢纽比价）', () => {
  it('无资产：缺口 = 需求（BOM 折后量）', async () => {
    const db = await setup();
    await seedPrices(db, {
      [JITA]: { [MAT_A]: 10, [MAT_B]: 20, [MAT_C]: 5 },
      [AMARR]: { [MAT_A]: 10, [MAT_B]: 20, [MAT_C]: 5 },
    });

    const result = await computeInventoryGap(db, BP, { regionIds: [JITA, AMARR] });

    expect(result.materialTypeCount).toBe(3);
    expect(result.gapTypeCount).toBe(3);
    expect(result.lines.map((line) => [line.typeId, line.required, line.owned, line.gap])).toEqual([
      [MAT_A, 100, 0, 100],
      [MAT_B, 50, 0, 50],
      [MAT_C, 10, 0, 10],
    ]);
    expect(result.product?.typeId).toBe(PRODUCT);
  });

  it('跨角色聚合：两角色各持一部分 → 缺口按合计扣减；缺口 0 的行默认不显示', async () => {
    const db = await setup();
    await seedPrices(db, { [JITA]: { [MAT_A]: 10, [MAT_B]: 20, [MAT_C]: 5 } });
    await insertAsset(db, { characterId: 1, itemId: 1, typeId: MAT_A, quantity: 30 });
    await insertAsset(db, { characterId: 2, itemId: 1, typeId: MAT_A, quantity: 40 }); // 合计 70
    await insertAsset(db, { characterId: 1, itemId: 2, typeId: MAT_B, quantity: 50 }); // 已够

    const result = await computeInventoryGap(db, BP, { regionIds: [JITA] });

    const a = result.lines.find((line) => line.typeId === MAT_A);
    expect(a?.owned).toBe(70);
    expect(a?.gap).toBe(30);
    expect(result.lines.some((line) => line.typeId === MAT_B)).toBe(false); // 缺口 0 → 隐藏
    expect(result.gapTypeCount).toBe(2); // A 与 C
    expect(result.materialTypeCount).toBe(3);

    const withOwned = await computeInventoryGap(db, BP, { regionIds: [JITA], includeOwned: true });
    const b = withOwned.lines.find((line) => line.typeId === MAT_B);
    expect(b?.gap).toBe(0);
    expect(b?.subtotal).toBe(0);
  });

  it('多枢纽比价：总价取建议枢纽、逐项最低为理论下限、行按小计降序', async () => {
    const db = await setup();
    await seedPrices(db, {
      [JITA]: { [MAT_A]: 10, [MAT_B]: 20, [MAT_C]: 5 }, // 1000+1000+50 = 2050
      [AMARR]: { [MAT_A]: 8, [MAT_B]: 25, [MAT_C]: 5 }, // 800+1250+50 = 2100
    });

    const result = await computeInventoryGap(db, BP, { regionIds: [JITA, AMARR] });

    expect(result.suggestedRegionId).toBe(JITA);
    expect(result.totalCost).toBe(2050);
    expect(result.floorCost).toBe(1850); // 800+1000+50
    expect(result.floorCost).toBeLessThanOrEqual(result.totalCost);
    expect(result.hubSummaries.map((hub) => [hub.regionId, hub.totalCost])).toEqual([
      [JITA, 2050],
      [AMARR, 2100],
    ]);
    expect(result.lines.map((line) => line.typeId)).toEqual([MAT_A, MAT_B, MAT_C]);

    const a = result.lines[0];
    expect(a.cheapestRegionId).toBe(AMARR); // 8 < 10
    expect(a.unitPrice).toBe(10); // 建议枢纽 = 吉他
    expect(a.subtotal).toBe(1000);
    expect(a.prices).toEqual([
      { regionId: JITA, price: 10 },
      { regionId: AMARR, price: 8 },
    ]);
  });

  it('缺价：所有枢纽都无报价的物品单列、不计入总价', async () => {
    const db = await setup();
    await seedPrices(db, {
      [JITA]: { [MAT_A]: 10, [MAT_B]: 20 },
      [AMARR]: { [MAT_A]: 12, [MAT_B]: 22 },
    });

    const result = await computeInventoryGap(db, BP, { regionIds: [JITA, AMARR] });

    const c = result.lines.find((line) => line.typeId === MAT_C);
    expect(c?.priced).toBe(false);
    expect(c?.unitPrice).toBeNull();
    expect(c?.subtotal).toBe(0);
    expect(result.missingTypeIds).toEqual([MAT_C]);
    expect(result.totalCost).toBe(2000); // 不含缺价项（MAT_C 无价 → 少算）
  });

  it('建议枢纽优先「能一次买齐」：缺价少的枢纽胜过总价更低但缺价的枢纽', async () => {
    const db = await setup();
    await seedPrices(db, {
      [JITA]: { [MAT_A]: 10, [MAT_B]: 20 }, // 2000，但缺 MAT_C
      [AMARR]: { [MAT_A]: 11, [MAT_B]: 21, [MAT_C]: 5 }, // 2200，齐全
    });

    const result = await computeInventoryGap(db, BP, { regionIds: [JITA, AMARR] });

    expect(result.hubSummaries).toEqual([
      { regionId: JITA, totalCost: 2000, missingCount: 1, fullyPriced: false },
      { regionId: AMARR, totalCost: 2200, missingCount: 0, fullyPriced: true },
    ]);
    expect(result.suggestedRegionId).toBe(AMARR);
    expect(result.totalCost).toBe(2200);
  });

  it('ME / runs 口径与蓝图成本引擎一致（需求随 ME 折扣）', async () => {
    const db = await setup();
    await seedPrices(db, { [JITA]: { [MAT_A]: 10 } });

    const result = await computeInventoryGap(db, BP, { regionIds: [JITA], runs: 2, me: 10 });

    expect(result.runs).toBe(2);
    expect(result.me).toBe(10);
    const a = result.lines.find((line) => line.typeId === MAT_A);
    expect(a?.required).toBe(180); // ceil(round2(100 × 2 × 0.9))
    expect(a?.subtotal).toBe(1800);
  });

  it('runs 超过单次任务上限：仅提示不阻断', async () => {
    const db = await setup();
    await seedPrices(db, { [JITA]: { [MAT_A]: 10 } });

    const over = await computeInventoryGap(db, BP, { regionIds: [JITA], runs: 20 });
    expect(over.maxProductionLimit).toBe(10);
    expect(over.runsExceedsLimit).toBe(true);

    const ok = await computeInventoryGap(db, BP, { regionIds: [JITA], runs: 10 });
    expect(ok.runsExceedsLimit).toBe(false);
  });

  it('活动无材料：返回空清单且不报错', async () => {
    const db = await setup();

    const result = await computeInventoryGap(db, BP, {
      regionIds: [JITA],
      activity: 'invention',
    });

    expect(result.materialTypeCount).toBe(0);
    expect(result.gapTypeCount).toBe(0);
    expect(result.lines).toEqual([]);
    expect(result.missingTypeIds).toEqual([]);
    expect(result.totalCost).toBe(0);
    expect(result.suggestedRegionId).toBeNull();
  });

  it('预算口径可切 best_sell（贴合「最低卖价」字面）', async () => {
    const db = await setup();
    await insertStats(db, { regionId: JITA, typeId: MAT_A, bestSell: 7, p5Sell: 10 });

    const p5 = await computeInventoryGap(db, BP, { regionIds: [JITA] });
    const best = await computeInventoryGap(db, BP, { regionIds: [JITA], basis: 'best_sell' });

    expect(p5.lines.find((line) => line.typeId === MAT_A)?.unitPrice).toBe(10);
    expect(best.lines.find((line) => line.typeId === MAT_A)?.unitPrice).toBe(7);
  });
});
