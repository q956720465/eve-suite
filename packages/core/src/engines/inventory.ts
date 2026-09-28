import type { DbAdapter } from '../db/types';
import { TRADE_HUBS } from '../market/hubs';

import {
  DEFAULT_BLUEPRINT_ACTIVITY,
  MAX_MATERIAL_EFFICIENCY,
  adjustMaterialQuantity,
  getBlueprintMaterials,
  getBlueprintProducts,
  getMaxProductionLimit,
  normalizeRuns,
  type BlueprintActivity,
  type BlueprintProduct,
} from './blueprint';
import { DEFAULT_VALUATION_BASIS, valueItems, type ValuationBasis } from './valuation';

/**
 * 库存缺口分析引擎（方案 §6.2「六大整合功能」）。
 *
 * 口径（P5-3 定稿）：
 * - **需求** = 蓝图 BOM 折后量（复用 P4-2 已验收的 `adjustMaterialQuantity`：runs 与 ME 口径一致）
 * - **已有** = **全部已授权角色**资产之和（`assets` 表；**不含公司资产**——P3 未同步公司端点）
 * - **缺口** = `max(0, 需求 − 已有)`；缺口为 0 的行默认不返回
 * - **比价** = 逐物品在各枢纽取估值引擎单价（默认 `p5_sell`，与全站同口径；可切 `best_sell`）
 * - **总价** = `Σ(缺口 × 建议枢纽单价)`；**建议枢纽**见下方排序说明
 * - **理论下限** = `Σ(缺口 × 逐项最低枢纽单价)`，作对照
 * - 全部枢纽都无报价的物品单列 `missingTypeIds`，**不计入总价**（界面需标注）
 *
 * 引擎**只读本地库**，整个计算零 ESI 请求（离线可算）。
 */

/** 单批查询的 type_id 数量上限（保守低于 SQLite 变量上限） */
const TYPE_ID_CHUNK = 900;

export interface InventoryGapOptions {
  /** 活动，默认 `manufacturing` */
  activity?: BlueprintActivity;
  /** 任务流程数，默认 1（复用 `normalizeRuns`：取整且 ≥1） */
  runs?: number;
  /** 材料效率（%），0–10，超界按上限截断 */
  me?: number;
  /** 比价枢纽区域，默认五大枢纽（`TRADE_HUBS`）；重复项自动去掉、保持传入顺序 */
  regionIds?: readonly number[];
  /** 价格口径，默认 `p5_sell`（与净值/蓝图/LP 同口径） */
  basis?: ValuationBasis;
  /** 是否剔除离群卖单（10 倍中位数规则） */
  filterOutliers?: boolean;
  /** 离群倍数阈值，默认 10 */
  outlierMultiple?: number;
  /** 是否保留「缺口为 0」的行（默认 false，只返回需要采购的物品） */
  includeOwned?: boolean;
}

/** 缺口行中某枢纽的单价 */
export interface InventoryGapPrice {
  regionId: number;
  price: number | null;
}

/** 一行缺口（按物品） */
export interface InventoryGapLine {
  typeId: number;
  /** SDE 基础量（ME 0、单流程） */
  baseQuantity: number;
  /** 折后总需求（含 runs 与 ME） */
  required: number;
  /** 全账号持有量 */
  owned: number;
  /** 缺口 = max(0, required − owned) */
  gap: number;
  /** 各枢纽单价（顺序与 `hubRegionIds` 一致） */
  prices: InventoryGapPrice[];
  /** 有报价的枢纽中单价最低者；全无报价为 null */
  cheapestRegionId: number | null;
  /** 建议枢纽下的单价；该枢纽无报价为 null */
  unitPrice: number | null;
  /** 建议枢纽下小计 = gap × unitPrice（无报价计 0） */
  subtotal: number;
  /** 是否有任一枢纽报价 */
  priced: boolean;
}

/** 单个枢纽的汇总（供「换枢纽买」对照） */
export interface InventoryHubSummary {
  regionId: number;
  /** 仅累加有报价的缺口项 */
  totalCost: number;
  /** 该枢纽缺价的缺口物品种数（越少越好） */
  missingCount: number;
  /** 该枢纽能否把所有缺口物品都报上价 */
  fullyPriced: boolean;
}

export interface InventoryGapResult {
  blueprintTypeId: number;
  activity: BlueprintActivity;
  runs: number;
  me: number;
  /** 单次任务流程上限（SDE；缺失为 null） */
  maxProductionLimit: number | null;
  /** `runs` 是否超过单次任务上限（仅提示，不影响计算） */
  runsExceedsLimit: boolean;
  /** 产出（无产出行时为 null） */
  product: BlueprintProduct | null;
  hubRegionIds: number[];
  hubSummaries: InventoryHubSummary[];
  /** 建议购买枢纽；无可比枢纽或无可采购物品为 null */
  suggestedRegionId: number | null;
  /** 建议枢纽下的总价 */
  totalCost: number;
  /** 逐项最低的理论下限（仅计有报价项） */
  floorCost: number;
  /** 缺口行（已按小计降序；`includeOwned` 时含缺口为 0 的行） */
  lines: InventoryGapLine[];
  /** BOM 材料种数 */
  materialTypeCount: number;
  /** 有缺口的物品种数 */
  gapTypeCount: number;
  /** 所有枢纽都无报价的缺口物品（去重，按首次出现顺序） */
  missingTypeIds: number[];
}

/**
 * 全账号（全部已授权角色）持有量。
 *
 * 注意：蓝图复制品在 ESI 中 `quantity = -1` 作标记，故**只累加正值**，
 * 避免把标记值当成负库存拉低合计。
 */
export async function getOwnedQuantities(
  db: DbAdapter,
  typeIds?: readonly number[],
): Promise<Map<number, number>> {
  const owned = new Map<number, number>();
  if (typeIds !== undefined && typeIds.length === 0) return owned;

  const head = `SELECT type_id AS typeId,
                       SUM(CASE WHEN quantity > 0 THEN quantity ELSE 0 END) AS quantity
                  FROM assets`;
  const tail = ' GROUP BY type_id';

  if (typeIds === undefined) {
    const rows = await db.select<{ typeId: number; quantity: number }>(head + tail);
    for (const row of rows) owned.set(row.typeId, row.quantity ?? 0);
    return owned;
  }

  const unique = [...new Set(typeIds)];
  for (let offset = 0; offset < unique.length; offset += TYPE_ID_CHUNK) {
    const chunk = unique.slice(offset, offset + TYPE_ID_CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await db.select<{ typeId: number; quantity: number }>(
      `${head} WHERE type_id IN (${placeholders})${tail}`,
      chunk,
    );
    for (const row of rows) owned.set(row.typeId, row.quantity ?? 0);
  }
  return owned;
}

function clampMe(me: number | undefined): number {
  if (me === undefined || !Number.isFinite(me)) return 0;
  return Math.min(MAX_MATERIAL_EFFICIENCY, Math.max(0, me));
}

/** 去重并保持顺序 */
function uniqueInOrder(values: readonly number[]): number[] {
  const seen = new Set<number>();
  const result: number[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

/**
 * 计算库存缺口与采购清单。
 *
 * @example
 * await computeInventoryGap(db, 17477, { runs: 10, me: 10 });
 */
export async function computeInventoryGap(
  db: DbAdapter,
  blueprintTypeId: number,
  options: InventoryGapOptions = {},
): Promise<InventoryGapResult> {
  const activity = options.activity ?? DEFAULT_BLUEPRINT_ACTIVITY;
  const runs = normalizeRuns(options.runs);
  const me = clampMe(options.me);
  const hubRegionIds = uniqueInOrder(
    options.regionIds !== undefined && options.regionIds.length > 0
      ? options.regionIds
      : TRADE_HUBS.map((hub) => hub.regionId),
  );
  const basis = options.basis ?? DEFAULT_VALUATION_BASIS;

  const [materialRows, productRows, maxProductionLimit] = await Promise.all([
    getBlueprintMaterials(db, blueprintTypeId, activity),
    getBlueprintProducts(db, blueprintTypeId, activity),
    getMaxProductionLimit(db, blueprintTypeId),
  ]);

  const demanded = materialRows.map((row) => ({
    typeId: row.typeId,
    baseQuantity: row.baseQuantity,
    required: adjustMaterialQuantity(row.baseQuantity, runs, me),
  }));
  const ownedByType = await getOwnedQuantities(
    db,
    demanded.map((row) => row.typeId),
  );

  // 逐枢纽批量定价（每枢纽一次批量查询）：quantity 传 1，只取单价
  const priceByRegion = new Map<number, Map<number, number | null>>();
  if (demanded.length > 0) {
    for (const regionId of hubRegionIds) {
      const valuation = await valueItems(
        db,
        demanded.map((row) => ({ typeId: row.typeId, quantity: 1 })),
        {
          regionId,
          basis,
          ...(options.filterOutliers === undefined ? {} : { filterOutliers: options.filterOutliers }),
          ...(options.outlierMultiple === undefined ? {} : { outlierMultiple: options.outlierMultiple }),
        },
      );
      const map = new Map<number, number | null>();
      for (const item of valuation.items) map.set(item.typeId, item.unitPrice);
      priceByRegion.set(regionId, map);
    }
  }

  const allLines: InventoryGapLine[] = demanded.map((row) => {
    const owned = ownedByType.get(row.typeId) ?? 0;
    const gap = Math.max(0, row.required - owned);
    const prices: InventoryGapPrice[] = hubRegionIds.map((regionId) => ({
      regionId,
      price: priceByRegion.get(regionId)?.get(row.typeId) ?? null,
    }));

    let cheapestRegionId: number | null = null;
    let cheapestPrice: number | null = null;
    for (const entry of prices) {
      if (entry.price === null) continue;
      if (cheapestPrice === null || entry.price < cheapestPrice) {
        cheapestPrice = entry.price;
        cheapestRegionId = entry.regionId;
      }
    }

    return {
      typeId: row.typeId,
      baseQuantity: row.baseQuantity,
      required: row.required,
      owned,
      gap,
      prices,
      cheapestRegionId,
      unitPrice: null, // 建议枢纽确定后回填
      subtotal: 0,
      priced: cheapestPrice !== null,
    };
  });

  // 逐枢纽汇总：只累加有报价的缺口项，并记录缺价种数
  const hubSummaries: InventoryHubSummary[] = hubRegionIds.map((regionId) => {
    let totalCost = 0;
    let missingCount = 0;
    for (const line of allLines) {
      if (line.gap <= 0) continue;
      const price = priceByRegion.get(regionId)?.get(line.typeId) ?? null;
      if (price === null) {
        missingCount += 1;
      } else {
        totalCost += line.gap * price;
      }
    }
    return { regionId, totalCost, missingCount, fullyPriced: missingCount === 0 };
  });

  /**
   * 建议购买枢纽：**先比「能否一次买齐」**（缺价种数升序），再比总价（升序），最后按传入顺序。
   *
   * 为什么不直接取总价最低：某枢纽若对部分物品**没有报价**，总价会因少算而偏低，
   * 直接取最低会选到「数据缺失」的枢纽 —— 故先把缺价少的排前面。
   */
  const rankedHubs = [...hubSummaries].sort(
    (a, b) =>
      a.missingCount - b.missingCount ||
      a.totalCost - b.totalCost ||
      hubRegionIds.indexOf(a.regionId) - hubRegionIds.indexOf(b.regionId),
  );
  // 没有任何缺口时「建议购买枢纽」无意义 → null
  const hasGaps = allLines.some((line) => line.gap > 0);
  const suggested = hasGaps ? (rankedHubs[0] ?? null) : null;
  const suggestedRegionId = suggested === null ? null : suggested.regionId;

  // 回填建议枢纽单价与小计
  for (const line of allLines) {
    if (suggestedRegionId === null) continue;
    const price = priceByRegion.get(suggestedRegionId)?.get(line.typeId) ?? null;
    line.unitPrice = price;
    line.subtotal = line.gap > 0 && price !== null ? line.gap * price : 0;
  }

  const gapLines = allLines.filter((line) => line.gap > 0);
  const missingTypeIds: number[] = [];
  for (const line of gapLines) {
    if (!line.priced) missingTypeIds.push(line.typeId);
  }

  const floorCost = gapLines.reduce((sum, line) => {
    if (line.cheapestRegionId === null) return sum; // 全无报价 → 不计
    const price = line.prices.find((entry) => entry.regionId === line.cheapestRegionId)?.price ?? null;
    return price === null ? sum : sum + line.gap * price;
  }, 0);

  // 默认只返回需采购的行，且按小计降序（最花钱的排前面）
  const lines = (options.includeOwned === true ? allLines : gapLines)
    .slice()
    .sort((a, b) => b.subtotal - a.subtotal || a.typeId - b.typeId);

  const primary = productRows[0] ?? null;
  const product: BlueprintProduct | null =
    primary === null
      ? null
      : {
          typeId: primary.typeId,
          quantityPerRun: primary.quantityPerRun,
          totalQuantity: primary.quantityPerRun * runs,
        };

  return {
    blueprintTypeId,
    activity,
    runs,
    me,
    maxProductionLimit,
    runsExceedsLimit: maxProductionLimit !== null && runs > maxProductionLimit,
    product,
    hubRegionIds,
    hubSummaries,
    suggestedRegionId,
    totalCost: suggested === null ? 0 : suggested.totalCost,
    floorCost,
    lines,
    materialTypeCount: allLines.length,
    gapTypeCount: gapLines.length,
    missingTypeIds,
  };
}
