import type { DbAdapter } from '../db/types';

import {
  adjustMaterialQuantity,
  getBlueprintMaterials,
  getBlueprintProducts,
  normalizeRuns,
  type BlueprintActivity,
} from './blueprint';
import { DEFAULT_VALUATION_REGION_ID, valueItems, type ValuationOptions } from './valuation';

/**
 * 工业成本闭环引擎（方案 §6.2「工业成本闭环」）。
 *
 * 口径（P5-6 定稿，经用户确认）：
 * - **任务来源**：P3 已同步的 `industry_jobs`（ESI `/characters/{id}/industry/jobs/`）
 * - **关联点**：钱包流水 `wallet_journal` 中 `context_id_type = 'industry_job_id'`
 *   （ESI 官方枚举，已验证）→ 把「任务的安装费 / 税」与任务精确对上
 * - **两层对账**：
 *   1. **安装费层**：预算 = ESI 返回的 `cost`；实际 = 关联流水的支出 → 偏差 = 实际 − 预算
 *   2. **材料层（成本闭环）**：材料预算（BOM 折后 × 估值单价）→ 与**产出估值**比较得毛利
 * - **为什么材料「实际采购额」不做**：钱包流水里买材料的 `market_transaction` 其 `context_id`
 *   指向交易 ID（`context_id_type = 'market_transaction_id'`），**无法反查 typeId**，
 *   故不臆造材料实际支出（备选「时间窗口近似」噪声过大，已由用户否决）
 * - **ME 假设**：ESI 的工业任务**不返回 ME / TE** → 材料预算按**假设 ME**（默认 0，即材料成本上限）计算
 * - **完工判定**：`status ∈ {delivered, ready}` 或 `completed_date` 非空；未完工任务单列且**不计入汇总**
 * - **产出估值**：`product_type_id × (successful_runs ?? runs)`，走估值引擎；BPC 类产物无市场报价 → 毛利为 null
 * - **零 ESI**：只读本地库（`industry_jobs` + `wallet_journal` + SDE 蓝图表 + 行情）
 */

/** 单批 id 数量（保守低于 SQLite 变量上限） */
const ID_CHUNK = 900;

/**
 * ESI `activity_id` → SDE 蓝图活动。
 *
 * 依据 Fuzzwork 的 SDE 转换文档（1 制造 / 3 TE 研究 / 4 ME 研究 / 5 复制 / 8 发明 / **11 反应**）。
 * 未识别的 id（如 7 逆向工程，SDE 无对应活动数据）返回 null —— 任务照常展示，但不做 BOM 预算，
 * **绝不猜测**活动含义。
 */
export const INDUSTRY_ACTIVITY_IDS: ReadonlyMap<number, BlueprintActivity> = new Map([
  [1, 'manufacturing'],
  [3, 'research_time'],
  [4, 'research_material'],
  [5, 'copying'],
  [8, 'invention'],
  [11, 'reaction'],
]);

/** 已完工状态（ESI `status` 枚举的小写形式） */
const COMPLETED_STATUSES: ReadonlySet<string> = new Set(['delivered', 'ready']);

/** 把 ESI 的 `activity_id` 解析为 SDE 活动；未识别返回 null */
export function resolveIndustryActivity(activityId: number): BlueprintActivity | null {
  return INDUSTRY_ACTIVITY_IDS.get(activityId) ?? null;
}

export interface IndustryReconciliationOptions extends ValuationOptions {
  /**
   * **材料效率假设（%）**，0–10，默认 0。
   *
   * ESI 的工业任务不返回 ME —— 按 0 计即「材料成本上限」，越低效率越保守。
   */
  me?: number;
}

/** 材料行 */
export interface IndustryMaterialLine {
  typeId: number;
  /** SDE 基础量（ME 0、单流程） */
  baseQuantity: number;
  /** 折后总需求（含 runs 与假设 ME） */
  quantity: number;
  unitPrice: number | null;
  /** quantity × unitPrice，无报价计 0 */
  value: number;
  priced: boolean;
}

/** 关联的钱包流水行 */
export interface IndustryLedgerLine {
  entryId: number;
  date: string;
  refType: string;
  description: string;
  /** 正数入账 / 负数出账 */
  amount: number;
}

/** 单条任务的对账明细 */
export interface IndustryJobReconciliation {
  characterId: number;
  jobId: number;
  activityId: number;
  /** 映射到的 SDE 活动；未识别为 null */
  activity: BlueprintActivity | null;
  blueprintTypeId: number;
  productTypeId: number | null;
  facilityId: number;
  /** 任务流程数 */
  runs: number;
  /** ESI 的成功流程数（发明等概率活动才有意义） */
  successfulRuns: number | null;
  status: string;
  startDate: string;
  endDate: string;
  completedDate: string | null;
  /** 是否已完工 */
  isCompleted: boolean;

  /** 材料明细（活动未识别或 SDE 无 BOM 时为空数组） */
  materials: IndustryMaterialLine[];
  /** 材料预算 = Σ 材料 value；**无法解析 BOM 时为 null**（区别于「BOM 全缺价 → 0」） */
  materialBudget: number | null;
  /** 材料缺价类型（按首次出现顺序） */
  missingMaterialTypeIds: number[];

  /** 安装费预算 = ESI `cost`；缺失为 null */
  installationFeeBudget: number | null;
  /** 安装费实际 = 关联流水的支出（无关联流水时为 0，配合 `hasLedgerLink` 判断） */
  installationFeeActual: number;
  /** 安装费偏差 = 实际 − 预算；两者缺一为 null */
  installationFeeDelta: number | null;

  /** 关联流水（按日期、entry_id 升序） */
  ledger: IndustryLedgerLine[];
  /** 实际支出 = Σ|负 amount| */
  actualSpend: number;
  /** 实际收入 = Σ 正 amount（如取消退款） */
  actualIncome: number;
  /** 是否存在关联流水 */
  hasLedgerLink: boolean;

  /** 产出数量 = 单流程产出 × 成功流程数 */
  productQuantity: number | null;
  /** 产出单价（估值引擎口径） */
  productUnitPrice: number | null;
  /** 产出估值；产出无报价为 null */
  productValue: number | null;
  /**
   * 毛利 = 产出估值 − 材料预算 − 安装费实际。
   * 产出无报价 / 无法解析 BOM 时为 null；无关联流水时安装费按 0 计入（界面据 `hasLedgerLink` 标注）。
   */
  grossProfit: number | null;
}

/** 按活动的汇总（仅已完工任务） */
export interface IndustryActivitySummary {
  activityId: number;
  activity: BlueprintActivity | null;
  jobCount: number;
  materialBudget: number;
  installationFeeBudget: number;
  installationFeeActual: number;
  actualSpend: number;
  /** 可算毛利任务的产出估值合计 */
  productValue: number;
  grossProfit: number;
}

export interface IndustryReconciliationResult {
  characterIds: number[];
  /** 实际生效的假设 ME（%） */
  me: number;
  /** 实际生效的估值基准区域 */
  regionId: number;
  /** 已完工任务数（参与汇总） */
  completedCount: number;
  /** 未完工任务数（不参与汇总） */
  unfinishedCount: number;
  /** 已完工任务中「没有关联流水」的数量 */
  unlinkedCount: number;
  /** 已完工任务中「无法算出毛利」的数量 */
  profitIncompleteCount: number;

  /** 汇总（仅已完工任务） */
  materialBudget: number;
  installationFeeBudget: number;
  installationFeeActual: number;
  /** 安装费总偏差（仅累加两者都有的任务） */
  installationFeeDelta: number;
  actualSpend: number;
  actualIncome: number;
  /** 可算毛利任务的产出估值合计 */
  productValue: number;
  grossProfit: number;

  /** 已完工任务（按完成时间降序；缺失完成时间则按开始时间） */
  jobs: IndustryJobReconciliation[];
  /** 未完工任务（按开始时间降序） */
  unfinishedJobs: IndustryJobReconciliation[];
  /** 按活动汇总（仅已完工；按任务数降序） */
  activitySummaries: IndustryActivitySummary[];
  /** 材料 / 产出缺价类型（去重） */
  missingTypeIds: number[];
}

interface IndustryJobRow {
  characterId: number;
  jobId: number;
  activityId: number;
  blueprintTypeId: number;
  facilityId: number;
  runs: number;
  status: string;
  startDate: string;
  endDate: string;
  completedDate: string | null;
  successfulRuns: number | null;
  productTypeId: number | null;
  cost: number | null;
}

interface IndustryLedgerRow {
  characterId: number;
  entryId: number;
  jobId: number;
  date: string;
  refType: string;
  description: string;
  amount: number | null;
}

/** 蓝图 BOM / 产出缓存（同一 蓝图+活动 只查一次） */
interface BlueprintCacheEntry {
  materials: { typeId: number; baseQuantity: number }[];
  product: { typeId: number; quantityPerRun: number } | null;
}

function clampMe(me: number | undefined): number {
  if (me === undefined || !Number.isFinite(me)) return 0;
  return Math.min(10, Math.max(0, me));
}

/** 关联键（ESI 的 job_id 全局唯一，但仍按角色 + 任务双键，杜绝跨角色串号） */
function ledgerKey(characterId: number, jobId: number): string {
  return `${characterId}:${jobId}`;
}

function isCompleted(status: string, completedDate: string | null): boolean {
  if (completedDate !== null && completedDate.length > 0) return true;
  return COMPLETED_STATUSES.has(status.toLowerCase());
}

/**
 * 工业成本对账：给定角色集合，逐任务给出「预算 vs 实际」与产出盈亏。
 *
 * @example
 * await computeIndustryReconciliation(db, [2114553827], { me: 10 });
 */
export async function computeIndustryReconciliation(
  db: DbAdapter,
  characterIds: readonly number[],
  options: IndustryReconciliationOptions = {},
): Promise<IndustryReconciliationResult> {
  const ids = [...new Set(characterIds)];
  const me = clampMe(options.me);
  const regionId = options.regionId ?? DEFAULT_VALUATION_REGION_ID;
  const valuation: ValuationOptions = {
    ...options,
    regionId,
  };

  const empty: IndustryReconciliationResult = {
    characterIds: ids,
    me,
    regionId,
    completedCount: 0,
    unfinishedCount: 0,
    unlinkedCount: 0,
    profitIncompleteCount: 0,
    materialBudget: 0,
    installationFeeBudget: 0,
    installationFeeActual: 0,
    installationFeeDelta: 0,
    actualSpend: 0,
    actualIncome: 0,
    productValue: 0,
    grossProfit: 0,
    jobs: [],
    unfinishedJobs: [],
    activitySummaries: [],
    missingTypeIds: [],
  };
  if (ids.length === 0) return empty;

  // ── 1. 读任务（跨角色分块） ──
  const jobRows: IndustryJobRow[] = [];
  for (let offset = 0; offset < ids.length; offset += ID_CHUNK) {
    const chunk = ids.slice(offset, offset + ID_CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    jobRows.push(
      ...(await db.select<IndustryJobRow>(
        `SELECT character_id      AS characterId,
                job_id            AS jobId,
                activity_id       AS activityId,
                blueprint_type_id AS blueprintTypeId,
                facility_id       AS facilityId,
                runs              AS runs,
                status            AS status,
                start_date        AS startDate,
                end_date          AS endDate,
                completed_date    AS completedDate,
                successful_runs   AS successfulRuns,
                product_type_id   AS productTypeId,
                cost              AS cost
           FROM industry_jobs
          WHERE character_id IN (${placeholders})
          ORDER BY start_date DESC, job_id DESC`,
        chunk,
      )),
    );
  }
  if (jobRows.length === 0) return empty;

  // ── 2. 关联钱包流水（context_id_type = 'industry_job_id'） ──
  const jobIds = [...new Set(jobRows.map((row) => row.jobId))];
  const ledgerByJob = new Map<string, IndustryLedgerLine[]>();
  for (let offset = 0; offset < ids.length; offset += ID_CHUNK) {
    const charChunk = ids.slice(offset, offset + ID_CHUNK);
    const charPlaceholders = charChunk.map(() => '?').join(', ');
    for (let jobOffset = 0; jobOffset < jobIds.length; jobOffset += ID_CHUNK) {
      const jobChunk = jobIds.slice(jobOffset, jobOffset + ID_CHUNK);
      const jobPlaceholders = jobChunk.map(() => '?').join(', ');
      const rows = await db.select<IndustryLedgerRow>(
        `SELECT character_id AS characterId,
                entry_id     AS entryId,
                context_id   AS jobId,
                date         AS date,
                ref_type     AS refType,
                description  AS description,
                amount       AS amount
           FROM wallet_journal
          WHERE character_id IN (${charPlaceholders})
            AND context_id_type = 'industry_job_id'
            AND context_id IN (${jobPlaceholders})
          ORDER BY date, entry_id`,
        [...charChunk, ...jobChunk],
      );
      for (const row of rows) {
        const key = ledgerKey(row.characterId, row.jobId);
        const list = ledgerByJob.get(key) ?? [];
        list.push({
          entryId: row.entryId,
          date: row.date,
          refType: row.refType,
          description: row.description,
          amount: row.amount ?? 0,
        });
        ledgerByJob.set(key, list);
      }
    }
  }

  // ── 3. 解析 BOM / 产出（按 蓝图+活动 缓存） ──
  const blueprintCache = new Map<string, BlueprintCacheEntry>();
  const loadBlueprint = async (
    blueprintTypeId: number,
    activity: BlueprintActivity,
  ): Promise<BlueprintCacheEntry> => {
    const key = `${blueprintTypeId}:${activity}`;
    const cached = blueprintCache.get(key);
    if (cached !== undefined) return cached;

    const [materialRows, productRows] = await Promise.all([
      getBlueprintMaterials(db, blueprintTypeId, activity),
      getBlueprintProducts(db, blueprintTypeId, activity),
    ]);
    const primary = productRows[0] ?? null;
    const entry: BlueprintCacheEntry = {
      materials: materialRows,
      product: primary === null ? null : { typeId: primary.typeId, quantityPerRun: primary.quantityPerRun },
    };
    blueprintCache.set(key, entry);
    return entry;
  };

  interface PreparedJob {
    row: IndustryJobRow;
    activity: BlueprintActivity | null;
    runs: number;
    materials: { typeId: number; baseQuantity: number; quantity: number }[];
    product: { typeId: number; quantityPerRun: number } | null;
  }

  const prepared: PreparedJob[] = [];
  for (const row of jobRows) {
    const activity = resolveIndustryActivity(row.activityId);
    const runs = normalizeRuns(row.runs);
    if (activity === null) {
      prepared.push({ row, activity, runs, materials: [], product: null });
      continue;
    }
    const entry = await loadBlueprint(row.blueprintTypeId, activity);
    prepared.push({
      row,
      activity,
      runs,
      materials: entry.materials.map((material) => ({
        typeId: material.typeId,
        baseQuantity: material.baseQuantity,
        quantity: adjustMaterialQuantity(material.baseQuantity, runs, me),
      })),
      product: entry.product,
    });
  }

  // ── 4. 批量取单价（材料 + 产出），一次批量查询，避免逐物品往返 ──
  const materialTypeIds = [...new Set(prepared.flatMap((job) => job.materials.map((m) => m.typeId)))];
  const productTypeIds = [
    ...new Set(
      prepared
        .map((job) => job.product?.typeId ?? job.row.productTypeId ?? null)
        .filter((typeId): typeId is number => typeId !== null),
    ),
  ];

  const unitPriceOf = new Map<number, number | null>();
  const missing = new Set<number>();
  if (materialTypeIds.length > 0) {
    const batch = await valueItems(
      db,
      materialTypeIds.map((typeId) => ({ typeId, quantity: 1 })),
      valuation,
    );
    for (const item of batch.items) {
      unitPriceOf.set(item.typeId, item.unitPrice);
      if (item.unitPrice === null) missing.add(item.typeId);
    }
  }
  if (productTypeIds.length > 0) {
    const batch = await valueItems(
      db,
      productTypeIds.map((typeId) => ({ typeId, quantity: 1 })),
      valuation,
    );
    for (const item of batch.items) unitPriceOf.set(item.typeId, item.unitPrice);
  }

  // ── 5. 逐任务组装 ──
  const buildJob = (job: PreparedJob): IndustryJobReconciliation => {
    const { row } = job;
    const ledger = ledgerByJob.get(ledgerKey(row.characterId, row.jobId)) ?? [];

    let actualSpend = 0;
    let actualIncome = 0;
    for (const entry of ledger) {
      if (entry.amount < 0) actualSpend += -entry.amount;
      else actualIncome += entry.amount;
    }
    const hasLedgerLink = ledger.length > 0;

    const materials: IndustryMaterialLine[] = job.materials.map((material) => {
      const unitPrice = unitPriceOf.get(material.typeId) ?? null;
      return {
        ...material,
        unitPrice,
        value: unitPrice === null ? 0 : unitPrice * material.quantity,
        priced: unitPrice !== null,
      };
    });
    const missingMaterialTypeIds = materials
      .filter((material) => !material.priced)
      .map((material) => material.typeId);
    const materialBudget =
      job.activity === null || materials.length === 0
        ? null
        : materials.reduce((total, material) => total + material.value, 0);

    const installationFeeBudget = row.cost;
    const installationFeeActual = actualSpend;
    const installationFeeDelta =
      hasLedgerLink && installationFeeBudget !== null ? installationFeeActual - installationFeeBudget : null;

    // 产出：优先用 BOM 的产出行；缺失时退回任务自身的 product_type_id
    const productTypeId = job.product?.typeId ?? row.productTypeId;
    const successfulRuns = job.row.successfulRuns;
    const productQuantity =
      productTypeId === null || job.product === null
        ? null
        : job.product.quantityPerRun * (successfulRuns ?? job.runs);
    const productUnitPrice = productTypeId === null ? null : (unitPriceOf.get(productTypeId) ?? null);
    const productValue =
      productQuantity === null || productUnitPrice === null ? null : productQuantity * productUnitPrice;

    // 无关联流水时安装费按 0 计入（界面据 hasLedgerLink 提示）
    const grossProfit =
      productValue !== null && materialBudget !== null
        ? productValue - materialBudget - installationFeeActual
        : null;

    return {
      characterId: row.characterId,
      jobId: row.jobId,
      activityId: row.activityId,
      activity: job.activity,
      blueprintTypeId: row.blueprintTypeId,
      productTypeId,
      facilityId: row.facilityId,
      runs: job.runs,
      successfulRuns,
      status: row.status,
      startDate: row.startDate,
      endDate: row.endDate,
      completedDate: row.completedDate,
      isCompleted: isCompleted(row.status, row.completedDate),
      materials,
      materialBudget,
      missingMaterialTypeIds,
      installationFeeBudget,
      installationFeeActual,
      installationFeeDelta,
      ledger,
      actualSpend,
      actualIncome,
      hasLedgerLink,
      productQuantity,
      productUnitPrice,
      productValue,
      grossProfit,
    };
  };

  const all = prepared.map(buildJob);
  const completed = all.filter((job) => job.isCompleted);
  const unfinished = all.filter((job) => !job.isCompleted);

  // ── 6. 汇总（仅已完工；毛利只累加可算的任务） ──
  let materialBudget = 0;
  let installationFeeBudget = 0;
  let installationFeeActual = 0;
  let installationFeeDelta = 0;
  let actualSpend = 0;
  let actualIncome = 0;
  let productValue = 0;
  let grossProfit = 0;
  let unlinkedCount = 0;
  let profitIncompleteCount = 0;

  for (const job of completed) {
    if (job.materialBudget !== null) materialBudget += job.materialBudget;
    if (job.installationFeeBudget !== null) installationFeeBudget += job.installationFeeBudget;
    installationFeeActual += job.installationFeeActual;
    if (job.installationFeeDelta !== null) installationFeeDelta += job.installationFeeDelta;
    actualSpend += job.actualSpend;
    actualIncome += job.actualIncome;
    if (job.productValue !== null) productValue += job.productValue;
    if (job.grossProfit !== null) grossProfit += job.grossProfit;
    else profitIncompleteCount += 1;
    if (!job.hasLedgerLink) unlinkedCount += 1;
  }

  const byActivity = new Map<number, IndustryActivitySummary>();
  for (const job of completed) {
    const summary = byActivity.get(job.activityId) ?? {
      activityId: job.activityId,
      activity: job.activity,
      jobCount: 0,
      materialBudget: 0,
      installationFeeBudget: 0,
      installationFeeActual: 0,
      actualSpend: 0,
      productValue: 0,
      grossProfit: 0,
    };
    summary.jobCount += 1;
    if (job.materialBudget !== null) summary.materialBudget += job.materialBudget;
    if (job.installationFeeBudget !== null) summary.installationFeeBudget += job.installationFeeBudget;
    summary.installationFeeActual += job.installationFeeActual;
    summary.actualSpend += job.actualSpend;
    if (job.productValue !== null) summary.productValue += job.productValue;
    if (job.grossProfit !== null) summary.grossProfit += job.grossProfit;
    byActivity.set(job.activityId, summary);
  }

  const sortByTimeDesc = (a: IndustryJobReconciliation, b: IndustryJobReconciliation): number =>
    (b.completedDate ?? b.startDate).localeCompare(a.completedDate ?? a.startDate) || b.jobId - a.jobId;

  return {
    characterIds: ids,
    me,
    regionId,
    completedCount: completed.length,
    unfinishedCount: unfinished.length,
    unlinkedCount,
    profitIncompleteCount,
    materialBudget,
    installationFeeBudget,
    installationFeeActual,
    installationFeeDelta,
    actualSpend,
    actualIncome,
    productValue,
    grossProfit,
    jobs: completed.slice().sort(sortByTimeDesc),
    unfinishedJobs: unfinished
      .slice()
      .sort((a, b) => b.startDate.localeCompare(a.startDate) || b.jobId - a.jobId),
    activitySummaries: [...byActivity.values()].sort(
      (a, b) => b.jobCount - a.jobCount || a.activityId - b.activityId,
    ),
    missingTypeIds: [...missing],
  };
}
