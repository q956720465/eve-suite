import { describe, expect, it } from 'vitest';

import { computeBlueprintCost } from '../../src/engines/blueprint';
import { buildLpPortfolio, computeOfferValue, rankLpOffers } from '../../src/engines/lp';
import { listLpOffers } from '../../src/lp/repo';
import { insertBlueprint, insertStats } from '../engines/fixtures';
import { createMigratedDb } from '../helpers/db';
import { AMARR_NAVY, CEP_FORCE, insertLpBalance, insertLpOffer } from '../lp/fixtures';

const CHARACTER_ID = 2114553827;

/** 测试物品：out1..out6 为产出，mat 为材料；out4 故意无报价 */
const OUT_1 = 1000;
const OUT_2 = 1001;
const MAT = 1002;
const OUT_3 = 1003;
const OUT_4 = 1004;
const OUT_5 = 1005;
const OUT_6 = 1006;

/**
 * 报价样本（价格均为 5% 分位口径）：
 * - #1 产出 OUT_1 5000，LP 1000，无 ISK/材料        → 净 5000，ISK/LP 5
 * - #2 产出 OUT_2 3000，LP 1000，ISK 1000，材料 MAT×2（500） → 净 1000，ISK/LP 1
 * - #3 产出 OUT_3 800×5，LP 5000，材料 MAT×1        → 净 3500，ISK/LP 0.7
 * - #4 产出 OUT_4 无报价                             → ISK/LP null
 * - #5 产出 OUT_5 100000，LP 100，ak 50              → ISK/LP 1000（默认跳过）
 * - #6 产出 OUT_6 1000，LP 0                         → ISK/LP null（不除零）
 */
async function setupDb() {
  const db = await createMigratedDb();
  await insertStats(db, { typeId: OUT_1, p5Sell: 5000 });
  await insertStats(db, { typeId: OUT_2, p5Sell: 3000 });
  await insertStats(db, { typeId: MAT, p5Sell: 500 });
  await insertStats(db, { typeId: OUT_3, p5Sell: 800 });
  await insertStats(db, { typeId: OUT_5, p5Sell: 100_000 });
  await insertStats(db, { typeId: OUT_6, p5Sell: 1000 });

  await insertLpOffer(db, { offerId: 1, typeId: OUT_1, lpCost: 1000 });
  await insertLpOffer(db, {
    offerId: 2,
    typeId: OUT_2,
    lpCost: 1000,
    iskCost: 1000,
    requiredItems: [{ typeId: MAT, quantity: 2 }],
  });
  await insertLpOffer(db, {
    offerId: 3,
    typeId: OUT_3,
    quantity: 5,
    lpCost: 5000,
    requiredItems: [{ typeId: MAT, quantity: 1 }],
  });
  await insertLpOffer(db, { offerId: 4, typeId: OUT_4, lpCost: 100 });
  await insertLpOffer(db, { offerId: 5, typeId: OUT_5, lpCost: 100, akCost: 50 });
  await insertLpOffer(db, { offerId: 6, typeId: OUT_6, lpCost: 0 });
  return db;
}

describe('computeOfferValue', () => {
  it('净收益与 ISK/LP：产出估值 − 材料成本 − ISK 支出', async () => {
    const db = await setupDb();
    const offers = await listLpOffers(db, CEP_FORCE);

    const withItems = offers.find((offer) => offer.offerId === 2);
    expect(withItems).toBeDefined();
    const value = await computeOfferValue(db, withItems!);

    expect(value.outputValue).toBe(3000);
    expect(value.inputCost).toBe(1000); // MAT 500 × 2
    expect(value.netIsk).toBe(1000);
    expect(value.iskPerLp).toBe(1);
    expect(value.requiredItems).toEqual([
      { typeId: MAT, quantity: 2, unitPrice: 500, value: 1000 },
    ]);
    expect(value.missingTypeIds).toEqual([]);
  });

  it('产出无报价 → ISK/LP 为 null（不把未知当 0）并列入缺失', async () => {
    const db = await setupDb();
    const offers = await listLpOffers(db, CEP_FORCE);

    const unpriced = offers.find((offer) => offer.offerId === 4);
    const value = await computeOfferValue(db, unpriced!);

    expect(value.outputPriced).toBe(false);
    expect(value.outputValue).toBe(0);
    expect(value.iskPerLp).toBeNull();
    expect(value.missingTypeIds).toEqual([OUT_4]);
  });

  it('lp_cost = 0 时 ISK/LP 为 null，但净收益照算', async () => {
    const db = await setupDb();
    const offers = await listLpOffers(db, CEP_FORCE);

    const free = offers.find((offer) => offer.offerId === 6);
    const value = await computeOfferValue(db, free!);

    expect(value.netIsk).toBe(1000);
    expect(value.iskPerLp).toBeNull();
  });

  it('估价口径透传：换基准区域后产出无价', async () => {
    const db = await setupDb();
    const offers = await listLpOffers(db, CEP_FORCE);
    const value = await computeOfferValue(db, offers.find((offer) => offer.offerId === 1)!, {
      regionId: 10000043,
    });

    expect(value.outputPriced).toBe(false);
    expect(value.missingTypeIds).toEqual([OUT_1]);
  });
});

describe('rankLpOffers', () => {
  it('默认按 ISK/LP 降序，跳过 ak_cost > 0 并计数', async () => {
    const db = await setupDb();

    const ranking = await rankLpOffers(db, CEP_FORCE);

    expect(ranking.skippedAkOffers).toBe(1);
    expect(ranking.unpricedOutputOffers).toBe(1); // offer 4 产出无报价
    expect(ranking.offers.map((offer) => offer.offerId)).toEqual([1, 2, 3, 6, 4]);
    expect(ranking.offers.map((offer) => offer.iskPerLp)).toEqual([5, 1, 0.7, null, null]);
  });

  it('纳入 ak offer 后其参与排名（skippedAkOffers 归零）', async () => {
    const db = await setupDb();

    const ranking = await rankLpOffers(db, CEP_FORCE, { includeAkOffers: true });

    expect(ranking.skippedAkOffers).toBe(0);
    expect(ranking.offers.map((offer) => offer.offerId)).toEqual([5, 1, 2, 3, 6, 4]);
  });

  it('minIskPerLp 与 limit 生效', async () => {
    const db = await setupDb();

    const filtered = await rankLpOffers(db, CEP_FORCE, { minIskPerLp: 1 });
    expect(filtered.offers.map((offer) => offer.offerId)).toEqual([1, 2]);
    expect(filtered.unpricedOutputOffers).toBe(1); // 计数不受 minIskPerLp / limit 影响

    const limited = await rankLpOffers(db, CEP_FORCE, { limit: 2 });
    expect(limited.offers.map((offer) => offer.offerId)).toEqual([1, 2]);
    expect(limited.unpricedOutputOffers).toBe(1);
  });

  it('无报价军团返回空排名', async () => {
    const db = await setupDb();

    const ranking = await rankLpOffers(db, AMARR_NAVY);

    expect(ranking).toEqual({
      corporationId: AMARR_NAVY,
      offers: [],
      skippedAkOffers: 0,
      unpricedOutputOffers: 0,
    });
  });
});

describe('buildLpPortfolio', () => {
  it('按军团输出「换什么 + 共值多少 ISK」，并按收益排序', async () => {
    const db = await setupDb();
    await insertLpBalance(db, CHARACTER_ID, CEP_FORCE, 100_000);
    await insertLpBalance(db, CHARACTER_ID, AMARR_NAVY, 10_000);
    // 伦斯军团（AMARR_NAVY 复用为另一军团样本）：产出 OUT_2 3000，LP 100 → ISK/LP 30
    await insertLpOffer(db, { offerId: 900, corporationId: AMARR_NAVY, typeId: OUT_2, lpCost: 100 });

    const portfolio = await buildLpPortfolio(db, CHARACTER_ID);

    expect(portfolio.map((entry) => entry.corporationId)).toEqual([CEP_FORCE, AMARR_NAVY]);
    const [best, second] = portfolio;
    expect(best).toMatchObject({
      loyaltyPoints: 100_000,
      totalNetIsk: 500_000,
      offersRanked: 5,
      unpricedOutputOffers: 1,
    });
    expect(best.bestOffer?.offerId).toBe(1);
    expect(best.alternatives.map((offer) => offer.offerId)).toEqual([2, 3]);
    expect(second).toMatchObject({ loyaltyPoints: 10_000, totalNetIsk: 300_000 });
    expect(second.bestOffer?.iskPerLp).toBe(30);
  });

  it('LP 为 0 的军团不参与；无 LP 余额时返回空数组', async () => {
    const db = await setupDb();
    expect(await buildLpPortfolio(db, CHARACTER_ID)).toEqual([]);

    await insertLpBalance(db, CHARACTER_ID, CEP_FORCE, 0);
    expect(await buildLpPortfolio(db, CHARACTER_ID)).toEqual([]);
  });

  it('最优 offer 无报价时总额按 0（不虚构收益）', async () => {
    const db = await createMigratedDb();
    await insertLpOffer(db, { offerId: 1, typeId: OUT_4, lpCost: 100 });
    await insertLpBalance(db, CHARACTER_ID, CEP_FORCE, 5000);

    const [entry] = await buildLpPortfolio(db, CHARACTER_ID);

    expect(entry.bestOffer?.offerId).toBe(1);
    expect(entry.totalNetIsk).toBe(0);
  });
});

/**
 * 蓝图类产出估值（P7-4，口径对齐 Fuzzwork）。
 *
 * 样本：蓝图 BP_TYPE，主产物 BP_PRODUCT（单次产量 1）；
 * 制造材料 A 基础量 4（单价 100）、B 基础量 2（单价 1000）；
 * LP 商场兑换材料 LP_ITEM ×3（单价 500）。
 *
 * 默认 runs = offer.quantity(5)、ME 0：
 *   制造材料成本 = 4×5×100 + 2×5×1000 = 12,000
 *   产物估值     = 1×5×100,000 = 500,000
 *   产出估值     = 488,000；净收益 = 488,000 − 1,500 = 486,500 → ISK/LP = 486.5
 */
const BP_TYPE = 2000;
const BP_PRODUCT = 2001;
const BP_MAT_A = 2002;
const BP_MAT_B = 2003;
const LP_ITEM = 2004;

async function setupBlueprintDb() {
  const db = await createMigratedDb();
  await insertBlueprint(db, {
    blueprintTypeId: BP_TYPE,
    maxProductionLimit: 10,
    activities: [{ activity: 'manufacturing', timeSeconds: 600 }],
    io: [
      { direction: 'input', typeId: BP_MAT_A, quantity: 4 },
      { direction: 'input', typeId: BP_MAT_B, quantity: 2 },
      { direction: 'output', typeId: BP_PRODUCT, quantity: 1 },
    ],
  });
  await insertStats(db, { typeId: BP_PRODUCT, p5Sell: 100_000 });
  await insertStats(db, { typeId: BP_MAT_A, p5Sell: 100 });
  await insertStats(db, { typeId: BP_MAT_B, p5Sell: 1000 });
  await insertStats(db, { typeId: LP_ITEM, p5Sell: 500 });
  await insertLpOffer(db, {
    offerId: 500,
    typeId: BP_TYPE,
    quantity: 5,
    lpCost: 1000,
    requiredItems: [{ typeId: LP_ITEM, quantity: 3 }],
  });
  return db;
}

describe('蓝图类产出估值（BPC 再制造）', () => {
  it('默认 runs = offer.quantity、ME 0：产出估值 = 产物估值 − 制造材料成本', async () => {
    const db = await setupBlueprintDb();
    const offers = await listLpOffers(db, CEP_FORCE);
    const value = await computeOfferValue(db, offers.find((offer) => offer.offerId === 500)!);

    expect(value.outputKind).toBe('blueprint');
    expect(value.outputValue).toBe(488_000);
    expect(value.inputCost).toBe(1_500); // LP_ITEM 500 × 3
    expect(value.netIsk).toBe(486_500);
    expect(value.iskPerLp).toBe(486.5);
    expect(value.outputPriced).toBe(true);
    expect(value.estimation).toEqual({
      productTypeId: BP_PRODUCT,
      productQuantityPerRun: 1,
      runs: 5,
      me: 0,
      productValue: 500_000,
      buildMaterialCost: 12_000,
      missingTypeIds: [],
    });
    expect(value.missingTypeIds).toEqual([]);
  });

  it('与蓝图成本引擎同口径（交叉验证，防止两处分叉）', async () => {
    const db = await setupBlueprintDb();
    const offers = await listLpOffers(db, CEP_FORCE);
    const value = await computeOfferValue(db, offers.find((offer) => offer.offerId === 500)!);

    const cost = await computeBlueprintCost(db, BP_TYPE, { runs: 5, me: 0 });

    expect(value.estimation?.buildMaterialCost).toBe(cost.materialCost);
    expect(value.estimation?.productTypeId).toBe(cost.product?.typeId);
    expect(value.estimation?.productQuantityPerRun).toBe(cost.product?.quantityPerRun);
    // 折后材料量逐条一致（A 4×5=20、B 2×5=10）
    expect(cost.materials.map((line) => [line.typeId, line.quantity])).toEqual([
      [BP_MAT_A, 20],
      [BP_MAT_B, 10],
    ]);
  });

  it('blueprintRuns 覆盖默认流程数', async () => {
    const db = await setupBlueprintDb();
    const offers = await listLpOffers(db, CEP_FORCE);
    const value = await computeOfferValue(db, offers.find((offer) => offer.offerId === 500)!, {
      blueprintRuns: 10,
    });

    // 材料 4×10×100 + 2×10×1000 = 24,000；产物 1×10×100,000 = 1,000,000
    expect(value.estimation?.runs).toBe(10);
    expect(value.outputValue).toBe(976_000);
    expect(value.iskPerLp).toBe(974.5); // (976,000 − 1,500) ÷ 1000
  });

  it('blueprintMe 走蓝图引擎同一折料公式', async () => {
    const db = await setupBlueprintDb();
    const offers = await listLpOffers(db, CEP_FORCE);
    const value = await computeOfferValue(db, offers.find((offer) => offer.offerId === 500)!, {
      blueprintMe: 10,
    });

    // A: ceil(5×4×0.9) = 18；B: ceil(5×2×0.9) = 9
    expect(value.estimation?.me).toBe(10);
    expect(value.estimation?.buildMaterialCost).toBe(10_800); // 18×100 + 9×1000
    expect(value.outputValue).toBe(489_200);
  });

  it('产物无报价 → 不估算（与普通无报价产出同语义）并计入 unpriced', async () => {
    const db = await createMigratedDb();
    await insertBlueprint(db, {
      blueprintTypeId: BP_TYPE,
      activities: [{ activity: 'manufacturing' }],
      io: [
        { direction: 'input', typeId: BP_MAT_A, quantity: 4 },
        { direction: 'output', typeId: BP_PRODUCT, quantity: 1 },
      ],
    });
    await insertStats(db, { typeId: BP_MAT_A, p5Sell: 100 });
    await insertLpOffer(db, { offerId: 501, typeId: BP_TYPE, quantity: 5, lpCost: 1000 });

    const ranking = await rankLpOffers(db, CEP_FORCE);
    const value = ranking.offers[0];

    expect(value.outputPriced).toBe(false);
    expect(value.estimation).toBeNull();
    expect(value.outputValue).toBe(0);
    expect(value.iskPerLp).toBeNull();
    expect(value.missingTypeIds).toEqual([BP_PRODUCT]);
    expect(ranking.unpricedOutputOffers).toBe(1);
  });

  it('制造材料缺价 → 计 0 并同时列入 offer 与估算的 missing 清单', async () => {
    const db = await setupBlueprintDb();
    await db.execute('DELETE FROM market_stats WHERE type_id = ?', [BP_MAT_B]);
    const offers = await listLpOffers(db, CEP_FORCE);
    const value = await computeOfferValue(db, offers.find((offer) => offer.offerId === 500)!);

    expect(value.estimation?.buildMaterialCost).toBe(2_000); // 只剩材料 A（20×100）
    expect(value.estimation?.missingTypeIds).toEqual([BP_MAT_B]);
    expect(value.missingTypeIds).toEqual([BP_MAT_B]);
    expect(value.outputPriced).toBe(true); // 产物有价 → 仍给估算（偏高，缺价已在 missing 中列出）
  });

  it('非蓝图 offer 不受影响（回归护栏）：outputKind 为 item、estimation 为 null', async () => {
    const db = await setupDb();
    const offers = await listLpOffers(db, CEP_FORCE);
    const value = await computeOfferValue(db, offers.find((offer) => offer.offerId === 1)!);

    expect(value.outputKind).toBe('item');
    expect(value.estimation).toBeNull();
    expect(value.outputValue).toBe(5000);
    expect(value.iskPerLp).toBe(5);
  });

  it('蓝图估算值参与同一 ISK/LP 排名（混排）', async () => {
    const db = await setupBlueprintDb();
    await insertStats(db, { typeId: OUT_1, p5Sell: 5000 });
    await insertLpOffer(db, { offerId: 502, typeId: OUT_1, lpCost: 1000 });

    const ranking = await rankLpOffers(db, CEP_FORCE);

    expect(ranking.offers.map((offer) => offer.offerId)).toEqual([500, 502]);
    expect(ranking.offers.map((offer) => offer.outputKind)).toEqual(['blueprint', 'item']);
    expect(ranking.unpricedOutputOffers).toBe(0);
  });
});
