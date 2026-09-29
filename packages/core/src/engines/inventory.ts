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
 * 口径（P5-3 定稿，P10-1 扩展比价粒度）：
 * - **需求** = 蓝图 BOM 折后量（复用 P4-2 已验收的 `adjustMaterialQuantity`：runs 与 ME 口径一致）
 * - **已有** = **全部已授权角色**资产之和（`assets` 表；**不含公司资产**——P3 未同步公司端点）
 * - **缺口** = `max(0, 需求 − 已有)`；缺口为 0 的行默认不返回
 * - **比价地点** = 「区域级」或「站点级」二选一：
 *   - 区域级（默认）：`regionIds`（缺省五大枢纽）→ 走估值引擎的 `market_stats` 路径
 *   - 站点级（P10-1）：`locations` 传 `stationId`，**回到 `market_orders` 按 `location_id` 重算**
 *     （`market_stats` 只有区域级指标，站点级必须回订单簿；P7-1 的 `min_volume ≤ 1` 过滤照旧生效）
 * - **单价口径** `basis`：`p5_sell`（卖价 5% 分位，默认，抗「1 ISK 钓鱼单」）或 `best_sell`
 * - **总价** = `Σ(缺口 × 建议地点单价)`；**建议地点**见下方排序说明
 * - **理论下限** = `Σ(缺口 × 逐项最低地点单价)`，作对照
 * - 全部地点都无报价的物品单列 `missingTypeIds`，**不计入总价**（界面需标注）
 *
 * 引擎**只读本地库**，整个计算零 ESI 请求（离线可算）。
 */

/** 单批查询的 type_id 数量上限（保守低于 SQLite 变量上限） */
const TYPE_ID_CHUNK = 900;

/** 比价地点：`stationId` 为 null 表示**区域级**（用区域聚合 / 区域订单簿） */
export interface InventoryLocationRef {
  regionId: number;
  /** 站点级比价时的站点 id（`market_orders.location_id`）；区域级为 null */
  stationId: number | null;
}

export interface InventoryGapOptions {
  /** 活动，默认 `manufacturing` */
  activity?: BlueprintActivity;
  /** 任务流程数，默认 1（复用 `normalizeRuns`：取整且 ≥1） */
  runs?: number;
  /** 材料效率（%），0–10，超界按上限截断 */
  me?: number;
  /** 比价枢纽区域（区域级），默认五大枢纽（`TRADE_HUBS`）；重复项自动去掉、保持传入顺序 */
  regionIds?: readonly number[];
  /**
   * 比价地点（P10-1）：给出后**忽略 `regionIds`**，可按站点级比价
   * （如传 `HUB_MAIN_STATIONS` 得到「五大枢纽主站之间比价」）。重复项自动去掉、保持传入顺序。
   */
  locations?: readonly InventoryLocationRef[];
  /** 价格口径，默认 `p5_sell`（与净值/蓝图/LP 同口径） */
  basis?: ValuationBasis;
  /** 是否剔除离群卖单（10 倍中位数规则） */
  filterOutliers?: boolean;
  /** 离群倍数阈值，默认 10 */
  outlierMultiple?: number;
  /** 是否保留「缺口为 0」的行（默认 false，只返回需要采购的物品） */
  includeOwned?: boolean;
}

/** 缺口行中某地点的单价 */
export interface InventoryGapPrice {
  regionId: number;
  /** 站点级地点（区域级为 null） */
  stationId: number | null;
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
  /** 各地点单价（顺序与 `locations` 一致） */
  prices: InventoryGapPrice[];
  /** 有报价的地点中单价最低者所在区域；全无报价为 null */
  cheapestRegionId: number | null;
  /** 有报价的地点中单价最低者的站点（区域级地点为 null） */
  cheapestStationId: number | null;
  /** 建议地点下的单价；该地点无报价为 null */
  unitPrice: number | null;
  /** 建议地点下小计 = gap × unitPrice（无报价计 0） */
  subtotal: number;
  /** 是否有任一地点报价 */
  priced: boolean;
}

/**
 * 单个地点的汇总（供「换地点买」对照）。
 * 名字沿用 P5-3；`stationId !== null` 表示该行是**站点级**地点。
 */
export interface InventoryHubSummary {
  regionId: number;
  /** 站点级地点（区域级为 null） */
  stationId: number | null;
  /** 仅累加有报价的缺口项 */
  totalCost: number;
  /** 该地点缺价的缺口物品种数（越少越好） */
  missingCount: number;
  /** 该地点能否把所有缺口物品都报上价 */
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
  /** 参与比价的**区域**去重列表（站点级地点取其所属区域） */
  hubRegionIds: number[];
  /** 参与比价的**地点**（顺序与 `lines[].prices` 一致） */
  locations: InventoryLocationRef[];
  hubSummaries: InventoryHubSummary[];
  /** 建议购买地点所在区域；无可比地点或无可采购物品为 null */
  suggestedRegionId: number | null;
  /** 建议购买站点的站点 id（区域级比价时为 null） */
  suggestedStationId: number | null;
  /** 建议地点下的总价 */
  totalCost: number;
  /** 逐项最低的理论下限（仅计有报价项） */
  floorCost: number;
  /** 缺口行（已按小计降序；`includeOwned` 时含缺口为 0 的行） */
  lines: InventoryGapLine[];
  /** BOM 材料种数 */
  materialTypeCount: number;
  /** 有缺口的物品种数 */
  gapTypeCount: number;
  /** 所有地点都无报价的缺口物品（去重，按首次出现顺序） */
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

/** 地点唯一键（站点与区域可能数值相同，必须带前缀区分） */
function locationKey(location: { regionId: number; stationId: number | null }): string {
  return location.stationId === null ? `r:${location.regionId}` : `s:${location.stationId}`;
}

/** 去重并保持顺序（按 `locationKey`） */
function uniqueLocations(values: readonly InventoryLocationRef[]): InventoryLocationRef[] {
  const seen = new Set<string>();
  const result: InventoryLocationRef[] = [];
  for (const value of values) {
    const key = locationKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ regionId: value.regionId, stationId: value.stationId });
  }
  return result;
}

/**
 * 解析比价地点：显式 `locations` 优先；否则由 `regionIds`（缺省五大枢纽）构造**区域级**地点。
 * 不传 `locations` / `regionIds` 时结果与 P5-3 完全一致（默认路径零行为变更）。
 */
function resolveLocations(options: InventoryGapOptions): InventoryLocationRef[] {
  if (options.locations !== undefined && options.locations.length > 0) {
    return uniqueLocations(options.locations);
  }
  const regionIds = uniqueInOrder(
    options.regionIds !== undefined && options.regionIds.length > 0
      ? options.regionIds
      : TRADE_HUBS.map((hub) => hub.regionId),
  );
  return regionIds.map((regionId) => ({ regionId, stationId: null }));
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
  const locations = resolveLocations(options);
  const hubRegionIds = uniqueInOrder(locations.map((location) => location.regionId));
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

  // 逐地点批量定价（每地点一次批量查询）：quantity 传 1，只取单价
  // 区域级地点走 market_stats 路径；站点级地点（stationId 非 null）回订单簿按 location_id 重算
  const priceByLocation = new Map<string, Map<number, number | null>>();
  if (demanded.length > 0) {
    for (const location of locations) {
      const valuation = await valueItems(
        db,
        demanded.map((row) => ({ typeId: row.typeId, quantity: 1 })),
        {
          regionId: location.regionId,
          stationId: location.stationId,
          basis,
          ...(options.filterOutliers === undefined ? {} : { filterOutliers: options.filterOutliers }),
          ...(options.outlierMultiple === undefined ? {} : { outlierMultiple: options.outlierMultiple }),
        },
      );
      const map = new Map<number, number | null>();
      for (const item of valuation.items) map.set(item.typeId, item.unitPrice);
      priceByLocation.set(locationKey(location), map);
    }
  }

  const allLines: InventoryGapLine[] = demanded.map((row) => {
    const owned = ownedByType.get(row.typeId) ?? 0;
    const gap = Math.max(0, row.required - owned);
    const prices: InventoryGapPrice[] = locations.map((location) => ({
      regionId: location.regionId,
      stationId: location.stationId,
      price: priceByLocation.get(locationKey(location))?.get(row.typeId) ?? null,
    }));

    let cheapestRegionId: number | null = null;
    let cheapestStationId: number | null = null;
    let cheapestPrice: number | null = null;
    for (const entry of prices) {
      if (entry.price === null) continue;
      if (cheapestPrice === null || entry.price < cheapestPrice) {
        cheapestPrice = entry.price;
        cheapestRegionId = entry.regionId;
        cheapestStationId = entry.stationId;
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
      cheapestStationId,
      unitPrice: null, // 建议地点确定后回填
      subtotal: 0,
      priced: cheapestPrice !== null,
    };
  });

  // 逐地点汇总：只累加有报价的缺口项，并记录缺价种数
  const hubSummaries: InventoryHubSummary[] = locations.map((location) => {
    const priceMap = priceByLocation.get(locationKey(location));
    let totalCost = 0;
    let missingCount = 0;
    for (const line of allLines) {
      if (line.gap <= 0) continue;
      const price = priceMap?.get(line.typeId) ?? null;
      if (price === null) {
        missingCount += 1;
      } else {
        totalCost += line.gap * price;
      }
    }
    return {
      regionId: location.regionId,
      stationId: location.stationId,
      totalCost,
      missingCount,
      fullyPriced: missingCount === 0,
    };
  });

  /**
   * 建议购买地点：**先比「能否一次买齐」**（缺价种数升序），再比总价（升序），最后按传入顺序。
   *
   * 为什么不直接取总价最低：某地点若对部分物品**没有报价**，总价会因少算而偏低，
   * 直接取最低会选到「数据缺失」的地点 —— 故先把缺价少的排前面。
   */
  const locationOrder = (entry: { regionId: number; stationId: number | null }): number => {
    const key = locationKey(entry);
    const index = locations.findIndex((location) => locationKey(location) === key);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  const rankedHubs = [...hubSummaries].sort(
    (a, b) =>
      a.missingCount - b.missingCount ||
      a.totalCost - b.totalCost ||
      locationOrder(a) - locationOrder(b),
  );
  // 没有任何缺口时「建议购买地点」无意义 → null
  const hasGaps = allLines.some((line) => line.gap > 0);
  const suggested = hasGaps ? (rankedHubs[0] ?? null) : null;
  const suggestedRegionId = suggested === null ? null : suggested.regionId;
  const suggestedStationId = suggested === null ? null : suggested.stationId;

  // 回填建议地点单价与小计
  for (const line of allLines) {
    if (suggested === null) continue;
    const price = priceByLocation.get(locationKey(suggested))?.get(line.typeId) ?? null;
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
    const price =
      line.prices.find(
        (entry) =>
          entry.regionId === line.cheapestRegionId && entry.stationId === line.cheapestStationId,
      )?.price ?? null;
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
    locations,
    hubSummaries,
    suggestedRegionId,
    suggestedStationId,
    totalCost: suggested === null ? 0 : suggested.totalCost,
    floorCost,
    lines,
    materialTypeCount: allLines.length,
    gapTypeCount: gapLines.length,
    missingTypeIds,
  };
}
