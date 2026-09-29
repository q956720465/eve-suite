import { describe, expect, it } from 'vitest';

import {
  INDUSTRY_ACTIVITY_IDS,
  computeIndustryReconciliation,
  resolveIndustryActivity,
} from '../../src/engines/industry';
import { createMigratedDb } from '../helpers/db';

import { JITA, insertBlueprint, insertIndustryJob, insertIndustryJournal, insertStats } from './fixtures';

/**
 * 固定样本（与 inventory.test.ts 同族的蓝图口径）：
 * - `BP` 制造业：材料 A(100) / B(50) / C(10)，产出 PRODUCT ×1
 * - `BP_INV` 发明：材料 DATACORE(2)，产出 BPC ×1（BPC 无市场报价）
 */
const BP = 1000;
const PRODUCT = 2000;
const MAT_A = 34;
const MAT_B = 35;
const MAT_C = 36;

const BP_INV = 3000;
const BPC = 4000;
const DATACORE = 5000;

const CHAR_A = 1;
const CHAR_B = 2;

/** 建两套蓝图 + 价格（吉他 p5_sell：A=10 / B=20 / C=5 / PRODUCT=50 / DATACORE=100） */
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
  await insertBlueprint(db, {
    blueprintTypeId: BP_INV,
    activities: [{ activity: 'invention', timeSeconds: 3600 }],
    io: [
      { direction: 'input', typeId: DATACORE, quantity: 2, activity: 'invention' },
      { direction: 'output', typeId: BPC, quantity: 1, activity: 'invention' },
    ],
  });
  for (const [typeId, price] of Object.entries({
    [MAT_A]: 10,
    [MAT_B]: 20,
    [MAT_C]: 5,
    [PRODUCT]: 50,
    [DATACORE]: 100,
  })) {
    await insertStats(db, { regionId: JITA, typeId: Number(typeId), p5Sell: price });
  }
  return db;
}

/** 一条已完工的制造业任务（runs 10 / cost 1000 / 成功 10） */
async function insertCompletedJob(
  db: Awaited<ReturnType<typeof createMigratedDb>>,
  overrides: Partial<Parameters<typeof insertIndustryJob>[1]> = {},
): Promise<void> {
  await insertIndustryJob(db, {
    characterId: CHAR_A,
    jobId: 9001,
    activityId: 1,
    blueprintTypeId: BP,
    runs: 10,
    status: 'delivered',
    startDate: '2026-09-01T00:00:00Z',
    endDate: '2026-09-02T00:00:00Z',
    completedDate: '2026-09-02T01:00:00Z',
    successfulRuns: 10,
    productTypeId: PRODUCT,
    cost: 1000,
    ...overrides,
  });
}

describe('resolveIndustryActivity（ESI activity_id → SDE 活动）', () => {
  it('已知 id 映射正确，未知 id 返回 null（绝不猜测）', () => {
    expect(resolveIndustryActivity(1)).toBe('manufacturing');
    expect(resolveIndustryActivity(3)).toBe('research_time');
    expect(resolveIndustryActivity(4)).toBe('research_material');
    expect(resolveIndustryActivity(5)).toBe('copying');
    expect(resolveIndustryActivity(8)).toBe('invention');
    expect(resolveIndustryActivity(11)).toBe('reaction');
    expect(resolveIndustryActivity(7)).toBeNull(); // 逆向工程：SDE 无对应活动数据
    expect(resolveIndustryActivity(99)).toBeNull();
    expect(INDUSTRY_ACTIVITY_IDS.size).toBe(6);
  });
});

describe('computeIndustryReconciliation（预算 vs 实际对账）', () => {
  it('空角色列表 → 空结果（不查询）', async () => {
    const db = await setup();
    const result = await computeIndustryReconciliation(db, []);
    expect(result.completedCount).toBe(0);
    expect(result.jobs).toEqual([]);
    expect(result.materialBudget).toBe(0);
  });

  it('无任务 → 空结果，且回填生效的 me / regionId', async () => {
    const db = await setup();
    const result = await computeIndustryReconciliation(db, [CHAR_A], { me: 10 });
    expect(result.completedCount).toBe(0);
    expect(result.me).toBe(10);
    expect(result.regionId).toBe(JITA);
  });

  it('已完工任务：材料预算 = BOM 折后量 × 单价（ME 0），安装费预算 = ESI cost', async () => {
    const db = await setup();
    await insertCompletedJob(db);

    const result = await computeIndustryReconciliation(db, [CHAR_A]);
    expect(result.completedCount).toBe(1);
    const job = result.jobs[0];

    // A 100×10=1000×10 / B 50×10=500×20 / C 10×10=100×5
    expect(job.materials.map((m) => m.quantity)).toEqual([1000, 500, 100]);
    expect(job.materialBudget).toBe(20500);
    expect(job.installationFeeBudget).toBe(1000);
    expect(job.missingMaterialTypeIds).toEqual([]);
    expect(result.materialBudget).toBe(20500);
  });

  it('ME 假设生效：ME 10 → 折后量按 CCP 公式下调', async () => {
    const db = await setup();
    await insertCompletedJob(db);

    const result = await computeIndustryReconciliation(db, [CHAR_A], { me: 10 });
    // ceil(100×10×0.9)=900 / ceil(50×10×0.9)=450 / ceil(10×10×0.9)=90
    expect(result.jobs[0].materials.map((m) => m.quantity)).toEqual([900, 450, 90]);
    expect(result.jobs[0].materialBudget).toBe(9000 + 9000 + 450);
    expect(result.me).toBe(10);
  });

  it('材料缺价：value 计 0 并具名列出，不影响其它材料', async () => {
    const db = await createMigratedDb();
    await insertBlueprint(db, {
      blueprintTypeId: BP,
      activities: [{ activity: 'manufacturing' }],
      io: [
        { direction: 'input', typeId: MAT_A, quantity: 100 },
        { direction: 'input', typeId: MAT_B, quantity: 50 },
        { direction: 'output', typeId: PRODUCT, quantity: 1 },
      ],
    });
    await insertStats(db, { regionId: JITA, typeId: MAT_A, p5Sell: 10 }); // MAT_B 无价
    await insertCompletedJob(db);

    const result = await computeIndustryReconciliation(db, [CHAR_A]);
    const job = result.jobs[0];
    expect(job.missingMaterialTypeIds).toEqual([MAT_B]);
    expect(job.materialBudget).toBe(1000 * 10); // B 计 0
    expect(result.missingTypeIds).toContain(MAT_B);
  });

  it('安装费对账：关联流水与预算不等 → 偏差 = 实际 − 预算', async () => {
    const db = await setup();
    await insertCompletedJob(db);
    await insertIndustryJournal(db, {
      characterId: CHAR_A,
      entryId: 1,
      jobId: 9001,
      date: '2026-09-01T00:00:00Z',
      amount: -600,
    });
    await insertIndustryJournal(db, {
      characterId: CHAR_A,
      entryId: 2,
      jobId: 9001,
      date: '2026-09-01T00:00:00Z',
      amount: -500,
    });

    const result = await computeIndustryReconciliation(db, [CHAR_A]);
    const job = result.jobs[0];
    expect(job.hasLedgerLink).toBe(true);
    expect(job.ledger).toHaveLength(2);
    expect(job.installationFeeActual).toBe(1100);
    expect(job.installationFeeDelta).toBe(100);
    expect(result.installationFeeDelta).toBe(100);
    expect(result.unlinkedCount).toBe(0);
  });

  it('无关联流水：偏差为 null（不臆造），并计入 unlinkedCount', async () => {
    const db = await setup();
    await insertCompletedJob(db);

    const result = await computeIndustryReconciliation(db, [CHAR_A]);
    const job = result.jobs[0];
    expect(job.hasLedgerLink).toBe(false);
    expect(job.actualSpend).toBe(0);
    expect(job.installationFeeDelta).toBeNull();
    expect(result.unlinkedCount).toBe(1);
  });

  it('流水含正 amount（如取消退款）→ 计入 actualIncome 而非支出', async () => {
    const db = await setup();
    await insertCompletedJob(db);
    await insertIndustryJournal(db, { characterId: CHAR_A, entryId: 1, jobId: 9001, date: '2026-09-01T00:00:00Z', amount: -1000 });
    await insertIndustryJournal(db, { characterId: CHAR_A, entryId: 2, jobId: 9001, date: '2026-09-02T00:00:00Z', amount: 400 });

    const result = await computeIndustryReconciliation(db, [CHAR_A]);
    expect(result.jobs[0].actualSpend).toBe(1000);
    expect(result.jobs[0].actualIncome).toBe(400);
    expect(result.installationFeeDelta).toBe(0);
  });

  it('毛利 = 产出估值 − 材料预算 − 安装费实际', async () => {
    const db = await setup();
    await insertCompletedJob(db);
    await insertIndustryJournal(db, { characterId: CHAR_A, entryId: 1, jobId: 9001, date: '2026-09-01T00:00:00Z', amount: -1100 });

    const result = await computeIndustryReconciliation(db, [CHAR_A]);
    const job = result.jobs[0];
    expect(job.productQuantity).toBe(10); // 单流程 1 × 成功 10
    expect(job.productUnitPrice).toBe(50);
    expect(job.productValue).toBe(500);
    expect(job.grossProfit).toBe(500 - 20500 - 1100);
    expect(result.productValue).toBe(500);
    expect(result.profitIncompleteCount).toBe(0);
  });

  it('产出为 BPC（无报价）→ 产出估值为 null、毛利为 null，并计入 profitIncompleteCount', async () => {
    const db = await setup();
    await insertIndustryJob(db, {
      characterId: CHAR_A,
      jobId: 7001,
      activityId: 8,
      blueprintTypeId: BP_INV,
      runs: 5,
      status: 'delivered',
      startDate: '2026-09-01T00:00:00Z',
      endDate: '2026-09-02T00:00:00Z',
      completedDate: '2026-09-02T01:00:00Z',
      successfulRuns: 1,
      productTypeId: BPC,
      cost: 200,
    });

    const result = await computeIndustryReconciliation(db, [CHAR_A]);
    const job = result.jobs[0];
    expect(job.activity).toBe('invention');
    expect(job.materialBudget).toBe(10 * 100); // 2 × 5 runs
    expect(job.productQuantity).toBe(1); // 成功 1 次
    expect(job.productUnitPrice).toBeNull();
    expect(job.productValue).toBeNull();
    expect(job.grossProfit).toBeNull();
    expect(result.profitIncompleteCount).toBe(1);
    expect(result.grossProfit).toBe(0);
  });

  it('产出数量用 successfulRuns（发明失败 = 0 件产出）', async () => {
    const db = await setup();
    await insertIndustryJob(db, {
      characterId: CHAR_A,
      jobId: 7002,
      activityId: 8,
      blueprintTypeId: BP_INV,
      runs: 5,
      status: 'delivered',
      startDate: '2026-09-01T00:00:00Z',
      endDate: '2026-09-02T00:00:00Z',
      completedDate: '2026-09-02T01:00:00Z',
      successfulRuns: 0,
      productTypeId: BPC,
      cost: 200,
    });

    const result = await computeIndustryReconciliation(db, [CHAR_A]);
    expect(result.jobs[0].productQuantity).toBe(0);
    expect(result.jobs[0].productValue).toBeNull(); // BPC 无价 → 仍为 null
  });

  it('完工判定：status=ready 无 completed_date 也算完工；active / paused 进未完工且不计汇总', async () => {
    const db = await setup();
    await insertIndustryJob(db, {
      characterId: CHAR_A,
      jobId: 9001,
      activityId: 1,
      blueprintTypeId: BP,
      runs: 1,
      status: 'ready',
      startDate: '2026-09-01T00:00:00Z',
      endDate: '2026-09-02T00:00:00Z',
      successfulRuns: 1,
      productTypeId: PRODUCT,
      cost: 100,
    });
    await insertIndustryJob(db, {
      characterId: CHAR_A,
      jobId: 9002,
      activityId: 1,
      blueprintTypeId: BP,
      runs: 5,
      status: 'active',
      startDate: '2026-09-03T00:00:00Z',
      endDate: '2026-09-04T00:00:00Z',
      cost: 500,
    });
    await insertIndustryJob(db, {
      characterId: CHAR_A,
      jobId: 9003,
      activityId: 1,
      blueprintTypeId: BP,
      runs: 5,
      status: 'paused',
      startDate: '2026-09-03T00:00:00Z',
      endDate: '2026-09-04T00:00:00Z',
      cost: 500,
    });

    const result = await computeIndustryReconciliation(db, [CHAR_A]);
    expect(result.completedCount).toBe(1);
    expect(result.unfinishedCount).toBe(2);
    expect(result.jobs.map((job) => job.jobId)).toEqual([9001]);
    expect(result.unfinishedJobs.map((job) => job.jobId).sort()).toEqual([9002, 9003]);
    // 未完工的 cost 500 不计入安装费预算汇总
    expect(result.installationFeeBudget).toBe(100);
  });

  it('未知活动 id：活动为 null、材料预算为 null，其余（安装费 / 流水）照常', async () => {
    const db = await setup();
    await insertIndustryJob(db, {
      characterId: CHAR_A,
      jobId: 8001,
      activityId: 7,
      blueprintTypeId: BP,
      runs: 1,
      status: 'delivered',
      startDate: '2026-09-01T00:00:00Z',
      endDate: '2026-09-02T00:00:00Z',
      completedDate: '2026-09-02T01:00:00Z',
      cost: 300,
    });
    await insertIndustryJournal(db, { characterId: CHAR_A, entryId: 1, jobId: 8001, date: '2026-09-01T00:00:00Z', amount: -300 });

    const result = await computeIndustryReconciliation(db, [CHAR_A]);
    const job = result.jobs[0];
    expect(job.activity).toBeNull();
    expect(job.materialBudget).toBeNull();
    expect(job.installationFeeBudget).toBe(300);
    expect(job.installationFeeDelta).toBe(0);
    expect(result.profitIncompleteCount).toBe(1);
  });

  it('跨角色不串号：同一条流水只归属其所属角色的任务', async () => {
    const db = await setup();
    await insertCompletedJob(db, { characterId: CHAR_A, jobId: 1001 });
    await insertCompletedJob(db, { characterId: CHAR_B, jobId: 2002 });
    await insertIndustryJournal(db, {
      characterId: CHAR_A,
      entryId: 1,
      jobId: 1001,
      date: '2026-09-01T00:00:00Z',
      amount: -1000,
    });

    const result = await computeIndustryReconciliation(db, [CHAR_A, CHAR_B]);
    const jobA = result.jobs.find((job) => job.jobId === 1001);
    const jobB = result.jobs.find((job) => job.jobId === 2002);
    expect(jobA?.hasLedgerLink).toBe(true);
    expect(jobB?.hasLedgerLink).toBe(false);
    expect(result.unlinkedCount).toBe(1);
  });

  it('按活动汇总：任务数 / 材料预算 / 安装费 / 毛利分组累计', async () => {
    const db = await setup();
    await insertCompletedJob(db, { jobId: 9001 }); // 制造
    await insertCompletedJob(db, { jobId: 9002 }); // 制造
    await insertIndustryJob(db, {
      characterId: CHAR_A,
      jobId: 7001,
      activityId: 8,
      blueprintTypeId: BP_INV,
      runs: 5,
      status: 'delivered',
      startDate: '2026-09-01T00:00:00Z',
      endDate: '2026-09-02T00:00:00Z',
      completedDate: '2026-09-02T01:00:00Z',
      successfulRuns: 1,
      productTypeId: BPC,
      cost: 200,
    });

    const result = await computeIndustryReconciliation(db, [CHAR_A]);
    expect(result.activitySummaries).toHaveLength(2);
    const manufacturing = result.activitySummaries[0];
    expect(manufacturing.activity).toBe('manufacturing');
    expect(manufacturing.jobCount).toBe(2);
    expect(manufacturing.materialBudget).toBe(20500 * 2);
    expect(manufacturing.installationFeeBudget).toBe(2000);
    expect(manufacturing.productValue).toBe(1000); // 2 × 10 × 50

    const invention = result.activitySummaries[1];
    expect(invention.activity).toBe('invention');
    expect(invention.jobCount).toBe(1);
    expect(invention.productValue).toBe(0); // BPC 无价 → 不计入
    // 合计：材料预算含发明；毛利只统计可算毛利的制造任务（无流水 → 安装费按 0）
    expect(result.materialBudget).toBe(20500 * 2 + 1000);
    expect(result.grossProfit).toBe((500 - 20500) * 2);
    expect(result.profitIncompleteCount).toBe(1);
  });
});
