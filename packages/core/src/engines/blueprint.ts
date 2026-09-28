import type { DbAdapter } from '../db/types';
import { getValuationPrice, valueItems, type ValuationOptions } from './valuation';

/**
 * 蓝图成本引擎（方案 §6.1「计算器」——蓝图成本）。
 *
 * 口径（P4-2 定稿）：
 * - 材料：`数量 = max(runs, ceil(round2(基础量 × runs × (1 − ME/100))))`
 *   取整发生在**整个任务**层面（不是每 run 分别取整），且**每 run 至少 1 单位**；
 *   建筑/安全等级系数默认 1.0（NPC 站口径）
 * - 时长：`秒 = ceil(基础时长 × runs × (1 − TE/100))`（不含技能 / 建筑加成）
 * - 价格：材料单价一律走估值引擎（口径 / 基准 / 站点 / 离群过滤全部透传），缺价计 0 并列入 `missingTypeIds`
 *
 * 明确不做（留 P5）：工业任务安装费（系统成本指数 / 设施税 / SCC 附加费）、
 * 递归展开到基础原料、发明成功率与解密器、公司/建筑系数。
 */

/** 蓝图活动（SDE 中 `activity` 的取值） */
export type BlueprintActivity =
  | 'manufacturing'
  | 'research_material'
  | 'research_time'
  | 'copying'
  | 'invention'
  | 'reaction';

/** 默认活动：制造 */
export const DEFAULT_BLUEPRINT_ACTIVITY: BlueprintActivity = 'manufacturing';

/** 材料效率上限（%）：每级 1%，最高 10 级 */
export const MAX_MATERIAL_EFFICIENCY = 10;

/** 时间效率上限（%）：每级 2%，最高 10 级 */
export const MAX_TIME_EFFICIENCY = 20;

export interface BlueprintCostOptions extends ValuationOptions {
  /** 活动，默认 `manufacturing` */
  activity?: BlueprintActivity;
  /** 任务流程数，默认 1（小于 1 或非整数会被归一到 ≥1 的整数） */
  runs?: number;
  /** 材料效率（%），0–10，超界按上限截断 */
  me?: number;
  /** 时间效率（%），0–20，超界按上限截断 */
  te?: number;
  /** 是否把蓝图自身价格计入总成本（默认 false；对 BPC 无意义，市场无 BPC 报价） */
  includeBlueprintPrice?: boolean;
}

/** 蓝图活动与基础时长 */
export interface BlueprintActivityInfo {
  activity: BlueprintActivity;
  timeSeconds: number | null;
}

/** 蓝图产出（一次流程的产出量） */
export interface BlueprintProduct {
  typeId: number;
  quantityPerRun: number;
  /** 折后总产出 = quantityPerRun × runs */
  totalQuantity: number;
}

/** 材料行 */
export interface BlueprintMaterialLine {
  typeId: number;
  /** SDE 基础量（ME 0、单流程） */
  baseQuantity: number;
  /** 折后总需求（含 runs 与 ME） */
  quantity: number;
  /** 估值引擎口径单价；无报价为 null */
  unitPrice: number | null;
  /** quantity × unitPrice，无报价计 0 */
  value: number;
  /** 是否有报价 */
  priced: boolean;
}

export interface BlueprintCostResult {
  blueprintTypeId: number;
  activity: BlueprintActivity;
  /** 实际生效的流程数 / 效率（归一或截断后） */
  runs: number;
  me: number;
  te: number;
  /** 该蓝图在 SDE 中的全部活动（供界面做活动选择与「非蓝图」判断） */
  activities: BlueprintActivityInfo[];
  maxProductionLimit: number | null;
  /** 产出；无产出行（SDE 存在此类蓝图）时为 null */
  product: BlueprintProduct | null;
  materials: BlueprintMaterialLine[];
  /** Σ 材料估值 */
  materialCost: number;
  /** 蓝图自身价格（仅 includeBlueprintPrice 时有值） */
  blueprintPrice: number | null;
  /** 材料成本 +（可选）蓝图价格 */
  totalCost: number;
  /** 总成本 ÷ 总产出；无产出时为 null */
  costPerUnit: number | null;
  /** 折后任务时长（秒）；无该活动时长时为 null */
  jobSeconds: number | null;
  /** 无报价材料（去重，按首次出现顺序） */
  missingTypeIds: number[];
}

interface MaterialRow {
  typeId: number;
  baseQuantity: number;
}

interface ProductRow {
  typeId: number;
  quantityPerRun: number;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** 归一流程数：取整且不低于 1 */
export function normalizeRuns(runs: number | undefined): number {
  if (runs === undefined || !Number.isFinite(runs)) return 1;
  return Math.max(1, Math.floor(runs));
}

/** 保留两位小数（对齐 CCP 的 2 位精度口径，避免浮点伪影被 ceil 放大） */
function roundTo2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 材料折后数量（纯函数）。
 * `max(runs, ceil(round2(基础量 × runs × (1 − ME/100))))`——取整在任务层面，且每 run 至少 1 单位。
 */
export function adjustMaterialQuantity(
  baseQuantity: number,
  runs: number,
  me = 0,
): number {
  const effectiveRuns = normalizeRuns(runs);
  const modifier = 1 - clamp(me, 0, MAX_MATERIAL_EFFICIENCY) / 100;
  const required = Math.ceil(roundTo2(effectiveRuns * baseQuantity * modifier));
  return Math.max(effectiveRuns, required);
}

/** 时间折后秒数（纯函数）：`ceil(基础时长 × runs × (1 − TE/100))` */
export function adjustJobSeconds(baseSeconds: number, runs: number, te = 0): number {
  const effectiveRuns = normalizeRuns(runs);
  const modifier = 1 - clamp(te, 0, MAX_TIME_EFFICIENCY) / 100;
  return Math.ceil(baseSeconds * effectiveRuns * modifier);
}

/** 蓝图的活动清单（含基础时长） */
export async function getBlueprintActivities(
  db: DbAdapter,
  blueprintTypeId: number,
): Promise<BlueprintActivityInfo[]> {
  const rows = await db.select<{ activity: BlueprintActivity; timeSeconds: number | null }>(
    `SELECT activity      AS activity,
            time_seconds  AS timeSeconds
       FROM sde_blueprint_activities
      WHERE blueprint_type_id = ?
      ORDER BY activity`,
    [blueprintTypeId],
  );
  return rows;
}

/** 某活动的基础材料清单（按基础量降序，量同则按物品 ID 升序） */
export async function getBlueprintMaterials(
  db: DbAdapter,
  blueprintTypeId: number,
  activity: BlueprintActivity = DEFAULT_BLUEPRINT_ACTIVITY,
): Promise<MaterialRow[]> {
  return db.select<MaterialRow>(
    `SELECT type_id  AS typeId,
            quantity AS baseQuantity
       FROM sde_blueprint_io
      WHERE blueprint_type_id = ? AND activity = ? AND direction = 'input'
      ORDER BY quantity DESC, type_id`,
    [blueprintTypeId, activity],
  );
}

/** 某活动的产出行 */
export async function getBlueprintProducts(
  db: DbAdapter,
  blueprintTypeId: number,
  activity: BlueprintActivity = DEFAULT_BLUEPRINT_ACTIVITY,
): Promise<ProductRow[]> {
  return db.select<ProductRow>(
    `SELECT type_id  AS typeId,
            quantity AS quantityPerRun
       FROM sde_blueprint_io
      WHERE blueprint_type_id = ? AND activity = ? AND direction = 'output'
      ORDER BY quantity DESC, type_id`,
    [blueprintTypeId, activity],
  );
}

/** 单次任务最大流程数（BPC 的 run 上限）；SDE 缺失时为 null */
export async function getMaxProductionLimit(
  db: DbAdapter,
  blueprintTypeId: number,
): Promise<number | null> {
  const rows = await db.select<{ maxLimit: number | null }>(
    'SELECT max_production_limit AS maxLimit FROM sde_blueprints WHERE blueprint_type_id = ?',
    [blueprintTypeId],
  );
  return rows[0]?.maxLimit ?? null;
}

/**
 * 计算蓝图成本（材料清单 + 估值 + 时长）。
 *
 * @example
 * await computeBlueprintCost(db, 17477);                        // 妄想级：默认制造、1 run、ME 0
 * await computeBlueprintCost(db, 17477, { runs: 10, me: 10 });  // ME10、10 runs
 */
export async function computeBlueprintCost(
  db: DbAdapter,
  blueprintTypeId: number,
  options: BlueprintCostOptions = {},
): Promise<BlueprintCostResult> {
  const activity = options.activity ?? DEFAULT_BLUEPRINT_ACTIVITY;
  const runs = normalizeRuns(options.runs);
  const me = clamp(options.me ?? 0, 0, MAX_MATERIAL_EFFICIENCY);
  const te = clamp(options.te ?? 0, 0, MAX_TIME_EFFICIENCY);

  const [activities, materialRows, productRows, maxProductionLimit] = await Promise.all([
    getBlueprintActivities(db, blueprintTypeId),
    getBlueprintMaterials(db, blueprintTypeId, activity),
    getBlueprintProducts(db, blueprintTypeId, activity),
    getMaxProductionLimit(db, blueprintTypeId),
  ]);

  const demanded = materialRows.map((row) => ({
    typeId: row.typeId,
    baseQuantity: row.baseQuantity,
    quantity: adjustMaterialQuantity(row.baseQuantity, runs, me),
  }));

  const valuation = await valueItems(
    db,
    demanded.map((row) => ({ typeId: row.typeId, quantity: row.quantity })),
    options,
  );

  const materials: BlueprintMaterialLine[] = demanded.map((row, index) => ({
    ...row,
    unitPrice: valuation.items[index].unitPrice,
    value: valuation.items[index].value,
    priced: valuation.items[index].unitPrice !== null,
  }));

  const materialCost = valuation.totalValue;
  const blueprintPrice =
    options.includeBlueprintPrice === true
      ? (await getValuationPrice(db, blueprintTypeId, options)).price
      : null;
  const totalCost = materialCost + (blueprintPrice ?? 0);

  // 制造类活动通常只有一条产出行；若将来出现多条，取产出量最大者作为主产物
  const primary = productRows[0] ?? null;
  const product: BlueprintProduct | null =
    primary === null
      ? null
      : {
          typeId: primary.typeId,
          quantityPerRun: primary.quantityPerRun,
          totalQuantity: primary.quantityPerRun * runs,
        };

  const activityTime = activities.find((item) => item.activity === activity)?.timeSeconds ?? null;

  return {
    blueprintTypeId,
    activity,
    runs,
    me,
    te,
    activities,
    maxProductionLimit,
    product,
    materials,
    materialCost,
    blueprintPrice,
    totalCost,
    costPerUnit: product === null || product.totalQuantity <= 0 ? null : totalCost / product.totalQuantity,
    jobSeconds: activityTime === null ? null : adjustJobSeconds(activityTime, runs, te),
    missingTypeIds: valuation.missingTypeIds,
  };
}
