import type { DbAdapter } from '../db/types';

import { valueItems, type ValuationOptions } from './valuation';

/**
 * 矿石精炼值引擎（方案 §6.1「计算器」之矿石精炼值 / §6.2「采矿时薪」的数据基础）。
 *
 * 口径（P4-4 定稿）：
 * - 精炼按**整份**进行：`份数 = floor(数量 ÷ portion_size)`，不足一份的余数不参与精炼（EVE 行为）
 * - 每种产物：`产出量 = floor(SDE 基础量 × 份数 × 产出率)`
 * - 产值一律走估值引擎（P4-1，区域/站点/口径/过滤全透传）；缺价产物计 0 并列入 `missingTypeIds`
 * - `净产值 = 产出估值 × (1 − 税率)`——**税按价值扣减，不减少产物数量**（NPC 站无税，默认 0）
 * - `产出率` 参数化（默认 0.50 = NPC 站、无技能）；**不建模技能/建筑**（留 P5）
 */

/** 默认精炼产出率：NPC 空间站基础值（无技能） */
export const DEFAULT_REFINE_YIELD = 0.5;

/** NPC 空间站设备基础产出率（与 {@link DEFAULT_REFINE_YIELD} 同值，语义上区分「站设备」与「默认参数」） */
export const NPC_STATION_BASE_YIELD = 0.5;

/** 默认税率：不扣税 */
export const DEFAULT_REFINE_TAX = 0;

/** 矿石/冰/月矿所属分类（SDE category 25 = Asteroid） */
export const ASTEROID_CATEGORY_ID = 25;

export interface NpcStationYieldInput {
  /** Reprocessing 技能等级 0–5（每级 +3%） */
  reprocessing?: number;
  /** Reprocessing Efficiency 技能等级 0–5（每级 +2%） */
  reprocessingEfficiency?: number;
  /** 对应矿种处理技能等级 0–5（每级 +2%，如 Veldspar Processing） */
  oreProcessing?: number;
  /** 植入体加成（如 RX-804 = 0.04） */
  implantBonus?: number;
}

/**
 * NPC 站精炼产出率（EVE 公式，见 EVE University wiki「Reprocessing」）：
 * `产出率 = 50% × (1 + 0.03 × Reprocessing) × (1 + 0.02 × ReprocessingEfficiency)
 *          × (1 + 0.02 × 矿种处理) × (1 + 植入体)`
 *
 * **只覆盖 NPC 站口径**：不含玩家建筑 rig 加成与建筑税（那需要建筑数据，属 P5）。
 * 技能等级按 0–5 夹取；返回值上限 1（100%）。
 */
export function computeNpcStationYield(input: NpcStationYieldInput = {}): number {
  const level = (value: number | undefined): number => {
    if (value === undefined || !Number.isFinite(value)) return 0;
    return Math.min(5, Math.max(0, Math.floor(value)));
  };
  const implant =
    input.implantBonus === undefined || !Number.isFinite(input.implantBonus)
      ? 0
      : Math.max(0, input.implantBonus);

  const yieldRate =
    NPC_STATION_BASE_YIELD *
    (1 + 0.03 * level(input.reprocessing)) *
    (1 + 0.02 * level(input.reprocessingEfficiency)) *
    (1 + 0.02 * level(input.oreProcessing)) *
    (1 + implant);
  return Math.min(1, yieldRate);
}

export interface RefineYieldPreset {
  id: string;
  labelZh: string;
  yieldRate: number;
}

/**
 * 产出率预设（P4-5 计算器界面用；均为 **NPC 站**口径）。
 * 顺序为「逐步加技能」的递增序列；矿种处理技能按**与所选矿石匹配且满级**假设。
 * 用户可选「自定义」直接输入百分比。
 */
export const REFINE_YIELD_PRESETS: readonly RefineYieldPreset[] = [
  {
    id: 'none',
    labelZh: 'NPC 站 · 无技能（50%）',
    yieldRate: computeNpcStationYield(),
  },
  {
    id: 'reprocessing5',
    labelZh: 'Reprocessing V（57.5%）',
    yieldRate: computeNpcStationYield({ reprocessing: 5 }),
  },
  {
    id: 'efficiency5',
    labelZh: 'Reprocessing V + Efficiency V（63.25%）',
    yieldRate: computeNpcStationYield({ reprocessing: 5, reprocessingEfficiency: 5 }),
  },
  {
    id: 'ore5',
    labelZh: '上者 + 矿种处理 V（69.575%）',
    yieldRate: computeNpcStationYield({
      reprocessing: 5,
      reprocessingEfficiency: 5,
      oreProcessing: 5,
    }),
  },
  {
    id: 'implant4',
    labelZh: '上者 + RX-804 植入体（72.358%）',
    yieldRate: computeNpcStationYield({
      reprocessing: 5,
      reprocessingEfficiency: 5,
      oreProcessing: 5,
      implantBonus: 0.04,
    }),
  },
];

export interface RefineOreInput {
  oreTypeId: number;
  /** 矿石数量（单位，非 m³） */
  quantity: number;
  /** 精炼产出率 0–1，默认 {@link DEFAULT_REFINE_YIELD} */
  yieldRate?: number;
  /** 税率 0–1（按产值扣减），默认 {@link DEFAULT_REFINE_TAX} */
  taxRate?: number;
  valuation?: ValuationOptions;
}

export interface RefineMaterialLine {
  typeId: number;
  /** SDE 基础产出量（每 portionSize 单位矿石） */
  baseQuantity: number;
  /** 实际产出量（整份数 × 产出率后向下取整） */
  quantity: number;
  unitPrice: number | null;
  value: number;
  priced: boolean;
}

export interface RefineOreResult {
  oreTypeId: number;
  quantity: number;
  portionSize: number;
  /** 可精炼的整份数 */
  portions: number;
  /** 不足一份、不参与精炼的余数（单位） */
  leftoverUnits: number;
  yieldRate: number;
  taxRate: number;
  materials: RefineMaterialLine[];
  /** 产物估值合计 */
  outputValue: number;
  /** 扣税后净产值 */
  netValue: number;
  /** 每单位矿石净产值 */
  valuePerUnit: number;
  /** 每 m³ 净产值（体积缺失时为 null） */
  valuePerCubicMeter: number | null;
  missingTypeIds: number[];
  /** 该类型在 SDE 无精炼映射（或类型不存在） */
  unmapped: boolean;
}

export interface OreMaterial {
  typeId: number;
  /** SDE 基础产出量（每 portionSize 单位矿石） */
  quantity: number;
}

export interface RefinableOre {
  typeId: number;
  nameEn: string;
  nameZh: string | null;
  portionSize: number;
  volume: number | null;
  /** 产物种类数 */
  materialCount: number;
}

/** 按份数与产出率折算单种产物数量（纯函数，便于单测） */
export function computeRefinedQuantity(
  baseQuantity: number,
  portions: number,
  yieldRate: number,
): number {
  if (!Number.isFinite(baseQuantity) || !Number.isFinite(portions) || !Number.isFinite(yieldRate)) {
    return 0;
  }
  if (baseQuantity <= 0 || portions <= 0 || yieldRate <= 0) return 0;
  return Math.floor(baseQuantity * portions * yieldRate);
}

/** 把比例参数夹到 0–1（非法值回退为默认值） */
function clampRate(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

/** 原始精炼映射（SDE 基础量） */
export async function listOreMaterials(db: DbAdapter, oreTypeId: number): Promise<OreMaterial[]> {
  return db.select<OreMaterial>(
    `SELECT material_type_id AS typeId, quantity AS quantity
       FROM sde_type_materials
      WHERE type_id = ?
      ORDER BY material_type_id`,
    [oreTypeId],
  );
}

/** 有精炼映射的矿石清单（分类为 Asteroid，且已发布）——供界面选择 */
export async function listRefinableOres(db: DbAdapter): Promise<RefinableOre[]> {
  return db.select<RefinableOre>(
    `SELECT t.type_id      AS typeId,
            t.name_en      AS nameEn,
            t.name_zh      AS nameZh,
            COALESCE(t.portion_size, 1) AS portionSize,
            t.volume       AS volume,
            COUNT(m.material_type_id)   AS materialCount
       FROM sde_types t
       JOIN sde_groups g ON g.group_id = t.group_id
       JOIN sde_type_materials m ON m.type_id = t.type_id
      WHERE g.category_id = ? AND t.published = 1
      GROUP BY t.type_id, t.name_en, t.name_zh, t.portion_size, t.volume
      ORDER BY t.type_id`,
    [ASTEROID_CATEGORY_ID],
  );
}

/**
 * 计算某矿石的精炼产值（方案 §6.1 计算器口径）。
 * 矿石类型不存在或无映射时返回 `unmapped: true` 且产物为空（不抛错）。
 */
export async function refineOre(db: DbAdapter, input: RefineOreInput): Promise<RefineOreResult> {
  const quantity =
    Number.isFinite(input.quantity) && input.quantity > 0 ? Math.floor(input.quantity) : 0;
  const yieldRate = clampRate(input.yieldRate, DEFAULT_REFINE_YIELD);
  const taxRate = clampRate(input.taxRate, DEFAULT_REFINE_TAX);
  const valuation = input.valuation ?? {};

  const typeRows = await db.select<{
    portionSize: number | null;
    volume: number | null;
  }>('SELECT portion_size AS portionSize, volume AS volume FROM sde_types WHERE type_id = ?', [
    input.oreTypeId,
  ]);
  const typeRow = typeRows[0];
  const portionSize = (() => {
    const raw = typeRow?.portionSize ?? null;
    return raw !== null && Number.isFinite(raw) && raw > 0 ? raw : 1;
  })();

  const baseMaterials = await listOreMaterials(db, input.oreTypeId);
  const portions = portionSize > 0 ? Math.floor(quantity / portionSize) : 0;
  const emptyResult: RefineOreResult = {
    oreTypeId: input.oreTypeId,
    quantity,
    portionSize,
    portions,
    leftoverUnits: quantity - portions * portionSize,
    yieldRate,
    taxRate,
    materials: [],
    outputValue: 0,
    netValue: 0,
    valuePerUnit: 0,
    valuePerCubicMeter: null,
    missingTypeIds: [],
    unmapped: true,
  };
  if (baseMaterials.length === 0 || typeRow === undefined) return emptyResult;

  // 一次批量取价（数量与单价无关，统一用 1 取价）
  const priced = await valueItems(
    db,
    baseMaterials.map((material) => ({ typeId: material.typeId, quantity: 1 })),
    valuation,
  );
  const priceByType = new Map(priced.items.map((item) => [item.typeId, item.unitPrice]));

  const missing = new Set<number>();
  const materials: RefineMaterialLine[] = baseMaterials.map((material) => {
    const unitPrice = priceByType.get(material.typeId) ?? null;
    if (unitPrice === null) missing.add(material.typeId);
    const refined = computeRefinedQuantity(material.quantity, portions, yieldRate);
    return {
      typeId: material.typeId,
      baseQuantity: material.quantity,
      quantity: refined,
      unitPrice,
      value: (unitPrice ?? 0) * refined,
      priced: unitPrice !== null,
    };
  });

  const outputValue = materials.reduce((sum, material) => sum + material.value, 0);
  const netValue = outputValue * (1 - taxRate);
  const volume = typeRow.volume;
  const totalVolume = volume !== null && Number.isFinite(volume) ? quantity * volume : null;

  return {
    oreTypeId: input.oreTypeId,
    quantity,
    portionSize,
    portions,
    leftoverUnits: quantity - portions * portionSize,
    yieldRate,
    taxRate,
    materials,
    outputValue,
    netValue,
    valuePerUnit: quantity > 0 ? netValue / quantity : 0,
    valuePerCubicMeter: totalVolume !== null && totalVolume > 0 ? netValue / totalVolume : null,
    missingTypeIds: [...missing],
    unmapped: false,
  };
}
