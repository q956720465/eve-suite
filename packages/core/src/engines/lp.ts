import type { DbAdapter } from '../db/types';
import { listLpBalances, listLpOffers, type LpOfferRecord } from '../lp/repo';

import {
  DEFAULT_BLUEPRINT_ACTIVITY,
  MAX_MATERIAL_EFFICIENCY,
  adjustMaterialQuantity,
  normalizeRuns,
} from './blueprint';
import { valueItems, type ValuationOptions } from './valuation';

/**
 * LP 比价引擎（方案 §6.1「计算器」之 LP 比价 / §6.2「LP 优化器」）。
 *
 * 口径（P4-3 定稿）：
 * - 产出与所需材料**都走估值引擎**（默认吉他 5% 分位；区域/站点/口径/过滤全透传）
 * - `净收益 netIsk = 产出估值 − 所需材料成本 − ISK 支出`
 * - `ISK/LP = netIsk ÷ lp_cost`（`lp_cost = 0` 或产出无报价时为 null，不除零、不假装有值）
 * - `ak_cost > 0`（需 CONCORD LP，与军团 LP 不同源）默认**跳过**，可显式纳入
 *
 * 蓝图类产出估值（P7-4 新增，口径对齐 Fuzzwork）：
 * - LP 商店有 133 条 offer 的产出是**蓝图**（BPC 无市场报价）→ 改为估算「**换成产出物再制造**」的毛利：
 *   `产出估值 = 产物单价 × (产物单次产量 × runs) − 蓝图制造材料成本(ME 折后 × runs)`
 * - **runs 默认取 offer 的 `quantity`**、**ME 默认 0**：2026-09-29 用本地 SDE 基础材料量对齐
 *   Fuzzwork 页面实测反推所得（材料量比值精确为 1.0000 / 5.0000 …；其页面「assume production
 *   efficiency 5」为历史文案，实测无任何折料），并用 4 条 offer 的 ISK/LP 逐项复算吻合
 * - 两者都可在 `RankLpOffersOptions` 覆盖（面板可调），因为 ESI/SDE **都不返回 LP 商店 BPC 的授权 run 数**
 * - 产物或制造材料缺价时按既有约定**计 0 并列入 `missingTypeIds`**（与所需材料同规则）
 */

/** 产出物种类：普通物品直接取价；蓝图改走「产物再制造」估算 */
export type LpOfferOutputKind = 'item' | 'blueprint';

/** 蓝图类产出的估算过程（供界面标注与独立复核；非蓝图产出为 null） */
export interface LpBlueprintEstimate {
  /** 该 BPC 制造出的产物 */
  productTypeId: number;
  /** 产物单次流程产量 */
  productQuantityPerRun: number;
  /** 实际生效的流程数（默认 = offer 的 `quantity`） */
  runs: number;
  /** 实际生效的材料效率（%） */
  me: number;
  /** 产物估值 = 产物单价 × (单次产量 × runs) */
  productValue: number;
  /** 蓝图制造材料成本（ME 折后 × runs） */
  buildMaterialCost: number;
  /** 制造材料中无报价的物品（计 0 参与估算） */
  missingTypeIds: number[];
}

export interface LpOfferValuation {
  offerId: number;
  corporationId: number;
  /** 产出物 */
  typeId: number;
  quantity: number;
  lpCost: number;
  iskCost: number;
  akCost: number;
  /** 产出物种类（蓝图类为估算值，见 `estimation`） */
  outputKind: LpOfferOutputKind;
  requiredItems: {
    typeId: number;
    quantity: number;
    unitPrice: number | null;
    value: number;
  }[];
  /** 一次兑换的产出估值；蓝图类 = 产物估值 − 蓝图制造材料成本 */
  outputValue: number;
  /** 所需材料成本（按引擎单价） */
  inputCost: number;
  /** 产出估值 − 材料成本 − ISK 支出 */
  netIsk: number;
  /** 净收益 ÷ LP；无法计算时为 null */
  iskPerLp: number | null;
  /** 产出物是否有报价（蓝图类以「产物是否有报价」为准；无报价时 ISK/LP 不可用） */
  outputPriced: boolean;
  /** 蓝图类产出的估算过程；非蓝图产出为 null */
  estimation: LpBlueprintEstimate | null;
  /** 参与本次估值的无报价物品（产出 / 所需材料 / 制造材料） */
  missingTypeIds: number[];
}

/** 蓝图类产出估算的可覆盖假设（两个字段都可在界面上调） */
export interface LpBlueprintOptions {
  /**
   * 蓝图类产出估算的假设流程数；缺省 = 该 offer 的 `quantity`（对齐 Fuzzwork）。
   * 因为 ESI/SDE 都不返回 LP 商店 BPC 的授权 run 数。
   */
  blueprintRuns?: number;
  /** 蓝图类产出估算的假设材料效率（%），0–10 截断，默认 **0**（不折料，对齐 Fuzzwork） */
  blueprintMe?: number;
}

export interface RankLpOffersOptions extends ValuationOptions, LpBlueprintOptions {
  /** 仅返回前 N 条（按 ISK/LP 降序） */
  limit?: number;
  /** 过滤掉 ISK/LP 低于该值的 offer */
  minIskPerLp?: number;
  /** 是否纳入 `ak_cost > 0` 的 offer（默认 false：跳过） */
  includeAkOffers?: boolean;
}

export interface LpOfferRanking {
  corporationId: number;
  /** ISK/LP 降序；无法计算 ISK/LP 的排在最后 */
  offers: LpOfferValuation[];
  /** 因 `ak_cost > 0` 被跳过的条数（仅默认口径下计数） */
  skippedAkOffers: number;
  /**
   * 无法计算 ISK/LP 的条数（不受 limit / minIskPerLp 影响）。
   * P7-4 起蓝图类产出改为「产物再制造」估算，**只有连产物都无报价时才计入此处**。
   */
  unpricedOutputOffers: number;
}

export interface LpPortfolioEntry {
  corporationId: number;
  /** 该军团可用 LP */
  loyaltyPoints: number;
  /** 最优 offer（无可比价 offer 时为 null） */
  bestOffer: LpOfferValuation | null;
  /** 全部 LP 投在最优 offer 上的净收益 */
  totalNetIsk: number;
  /** 次优备选（最多 2 条） */
  alternatives: LpOfferValuation[];
  /** 参与排名的 offer 条数 */
  offersRanked: number;
  skippedAkOffers: number;
  /** 产出无市场报价、无法估值的条数（蓝图类已改为产物估算，只有连产物都无报价才计入） */
  unpricedOutputOffers: number;
}

/** 估值上下文：一次性取价，避免逐条 offer 查询 */
interface PriceIndex {
  priceOf(typeId: number): number | null;
}

/** 蓝图类产出的静态信息（主产物 + 制造材料基础量） */
interface BlueprintSpec {
  productTypeId: number;
  productQuantityPerRun: number;
  materials: { typeId: number; baseQuantity: number }[];
}

/** `IN (...)` 分批上限：保守低于各 SQLite 构建的变量上限 */
const TYPE_ID_CHUNK = 500;

/** 蓝图类产出估算的生效假设（runs 为 null 表示用该 offer 的 `quantity`） */
interface BlueprintAssumption {
  runs: number | null;
  me: number;
}

/** 材料效率截断到 [0, MAX]；非法值按 0 */
function clampMe(me: number): number {
  if (!Number.isFinite(me)) return 0;
  return Math.min(MAX_MATERIAL_EFFICIENCY, Math.max(0, me));
}

/** 由选项解析蓝图估算假设 */
function resolveAssumption(options: ValuationOptions & LpBlueprintOptions): BlueprintAssumption {
  return {
    runs: options.blueprintRuns === undefined ? null : normalizeRuns(options.blueprintRuns),
    me: clampMe(options.blueprintMe ?? 0),
  };
}

/**
 * 识别产出为蓝图的 offer，并取回其主产物与制造材料基础量。
 * 判定以 `sde_blueprints`（蓝图注册表）为准，材料/产物取 `manufacturing` 活动。
 *
 * 边界：SDE 存在**无产出行**的蓝图（P4-2 已记录此类）→ 不进 `specs`，
 * 该 offer 退回「普通物品取价」路径（无市场报价 → 计为无报价），不做估算。
 */
async function loadBlueprintSpecs(
  db: DbAdapter,
  typeIds: readonly number[],
): Promise<Map<number, BlueprintSpec>> {
  const specs = new Map<number, BlueprintSpec>();
  const candidates = [...new Set(typeIds)];
  if (candidates.length === 0) return specs;

  for (let start = 0; start < candidates.length; start += TYPE_ID_CHUNK) {
    const part = candidates.slice(start, start + TYPE_ID_CHUNK);
    const placeholders = part.map(() => '?').join(', ');
    const blueprints = await db.select<{ typeId: number }>(
      `SELECT blueprint_type_id AS typeId
         FROM sde_blueprints
        WHERE blueprint_type_id IN (${placeholders})`,
      part,
    );
    if (blueprints.length === 0) continue;

    const bpIds = blueprints.map((row) => row.typeId);
    const bpPlaceholders = bpIds.map(() => '?').join(', ');
    const [materialRows, productRows] = await Promise.all([
      db.select<{ blueprintTypeId: number; typeId: number; baseQuantity: number }>(
        `SELECT blueprint_type_id AS blueprintTypeId, type_id AS typeId, quantity AS baseQuantity
           FROM sde_blueprint_io
          WHERE activity = ? AND direction = 'input' AND blueprint_type_id IN (${bpPlaceholders})`,
        [DEFAULT_BLUEPRINT_ACTIVITY, ...bpIds],
      ),
      db.select<{ blueprintTypeId: number; typeId: number; quantityPerRun: number }>(
        `SELECT blueprint_type_id AS blueprintTypeId, type_id AS typeId, quantity AS quantityPerRun
           FROM sde_blueprint_io
          WHERE activity = ? AND direction = 'output' AND blueprint_type_id IN (${bpPlaceholders})
          ORDER BY quantity DESC, type_id`,
        [DEFAULT_BLUEPRINT_ACTIVITY, ...bpIds],
      ),
    ]);

    const materialsByBlueprint = new Map<number, { typeId: number; baseQuantity: number }[]>();
    for (const row of materialRows) {
      const list = materialsByBlueprint.get(row.blueprintTypeId);
      if (list === undefined) {
        materialsByBlueprint.set(row.blueprintTypeId, [{ typeId: row.typeId, baseQuantity: row.baseQuantity }]);
      } else {
        list.push({ typeId: row.typeId, baseQuantity: row.baseQuantity });
      }
    }

    // 产出行按 quantity 降序 → 每个蓝图的首行即主产物（与蓝图引擎同口径）
    const taken = new Set<number>();
    for (const row of productRows) {
      if (taken.has(row.blueprintTypeId)) continue;
      taken.add(row.blueprintTypeId);
      specs.set(row.blueprintTypeId, {
        productTypeId: row.typeId,
        productQuantityPerRun: row.quantityPerRun,
        materials: materialsByBlueprint.get(row.blueprintTypeId) ?? [],
      });
    }
  }
  return specs;
}

/**
 * 蓝图类产出估值：产物估值 − 制造材料成本（缺价计 0 并收集）。
 *
 * **产物无报价时不估算**（返回 `outputValue: 0` 且 `estimation: null`），与普通物品
 * 「未知不当有值」的既有约定一致——否则会拿「0 产物价 − 材料成本」得出误导性的负数。
 */
function estimateBlueprintOutput(
  offer: LpOfferRecord,
  spec: BlueprintSpec,
  prices: PriceIndex,
  assumption: BlueprintAssumption,
  missing: Set<number>,
): { outputValue: number; outputPriced: boolean; estimation: LpBlueprintEstimate | null } {
  const productPrice = prices.priceOf(spec.productTypeId);
  if (productPrice === null) {
    missing.add(spec.productTypeId);
    return { outputValue: 0, outputPriced: false, estimation: null };
  }

  const runs = normalizeRuns(assumption.runs ?? offer.quantity);
  const me = assumption.me;
  const productValue = productPrice * spec.productQuantityPerRun * runs;

  const materialMissing: number[] = [];
  let buildMaterialCost = 0;
  for (const material of spec.materials) {
    const unitPrice = prices.priceOf(material.typeId);
    if (unitPrice === null) {
      missing.add(material.typeId);
      materialMissing.push(material.typeId);
    }
    buildMaterialCost += (unitPrice ?? 0) * adjustMaterialQuantity(material.baseQuantity, runs, me);
  }

  return {
    outputValue: productValue - buildMaterialCost,
    outputPriced: true,
    estimation: {
      productTypeId: spec.productTypeId,
      productQuantityPerRun: spec.productQuantityPerRun,
      runs,
      me,
      productValue,
      buildMaterialCost,
      missingTypeIds: materialMissing,
    },
  };
}

async function buildPriceIndex(
  db: DbAdapter,
  offers: readonly LpOfferRecord[],
  options: ValuationOptions,
  specs: ReadonlyMap<number, BlueprintSpec>,
): Promise<PriceIndex> {
  const typeIds = new Set<number>();
  for (const offer of offers) {
    typeIds.add(offer.typeId);
    for (const item of offer.requiredItems) typeIds.add(item.typeId);
    const spec = specs.get(offer.typeId);
    if (spec !== undefined) {
      typeIds.add(spec.productTypeId);
      for (const material of spec.materials) typeIds.add(material.typeId);
    }
  }
  if (typeIds.size === 0) return { priceOf: () => null };

  // 单价与数量无关，统一用数量 1 取价（估值引擎的批量入口一次查完）
  const priced = await valueItems(
    db,
    [...typeIds].map((typeId) => ({ typeId, quantity: 1 })),
    options,
  );
  const priceByType = new Map(priced.items.map((item) => [item.typeId, item.unitPrice]));
  return { priceOf: (typeId) => priceByType.get(typeId) ?? null };
}

/** 单条报价估值（价格索引与蓝图信息由调用方复用，避免重复查询） */
function valueOffer(
  offer: LpOfferRecord,
  prices: PriceIndex,
  specs: ReadonlyMap<number, BlueprintSpec>,
  assumption: BlueprintAssumption,
): LpOfferValuation {
  const missing = new Set<number>();

  const spec = specs.get(offer.typeId);
  let outputValue: number;
  let outputPriced: boolean;
  let estimation: LpBlueprintEstimate | null = null;

  if (spec === undefined) {
    const outputPrice = prices.priceOf(offer.typeId);
    if (outputPrice === null) missing.add(offer.typeId);
    outputValue = (outputPrice ?? 0) * offer.quantity;
    outputPriced = outputPrice !== null;
  } else {
    const estimated = estimateBlueprintOutput(offer, spec, prices, assumption, missing);
    outputValue = estimated.outputValue;
    outputPriced = estimated.outputPriced;
    estimation = estimated.estimation;
  }

  const requiredItems = offer.requiredItems.map((item) => {
    const unitPrice = prices.priceOf(item.typeId);
    if (unitPrice === null) missing.add(item.typeId);
    return {
      typeId: item.typeId,
      quantity: item.quantity,
      unitPrice,
      value: (unitPrice ?? 0) * item.quantity,
    };
  });
  const inputCost = requiredItems.reduce((sum, item) => sum + item.value, 0);

  const netIsk = outputValue - inputCost - offer.iskCost;
  const iskPerLp = outputPriced && offer.lpCost > 0 ? netIsk / offer.lpCost : null;

  return {
    offerId: offer.offerId,
    corporationId: offer.corporationId,
    typeId: offer.typeId,
    quantity: offer.quantity,
    lpCost: offer.lpCost,
    iskCost: offer.iskCost,
    akCost: offer.akCost,
    outputKind: spec === undefined ? 'item' : 'blueprint',
    requiredItems,
    outputValue,
    inputCost,
    netIsk,
    iskPerLp,
    outputPriced,
    estimation,
    missingTypeIds: [...missing],
  };
}

/** ISK/LP 降序；无法计算者排后（按净收益降序、offer_id 升序稳定收尾） */
function compareOffers(a: LpOfferValuation, b: LpOfferValuation): number {
  if (a.iskPerLp !== null && b.iskPerLp !== null) {
    return b.iskPerLp - a.iskPerLp || b.netIsk - a.netIsk || a.offerId - b.offerId;
  }
  if (a.iskPerLp !== null) return -1;
  if (b.iskPerLp !== null) return 1;
  return b.netIsk - a.netIsk || a.offerId - b.offerId;
}

/** 单条 offer 的估值（便捷入口；批量场景请用 `rankLpOffers`） */
export async function computeOfferValue(
  db: DbAdapter,
  offer: LpOfferRecord,
  options: ValuationOptions & LpBlueprintOptions = {},
): Promise<LpOfferValuation> {
  const specs = await loadBlueprintSpecs(db, [offer.typeId]);
  const prices = await buildPriceIndex(db, [offer], options, specs);
  return valueOffer(offer, prices, specs, resolveAssumption(options));
}

/** 某军团全部 offer 的 ISK/LP 排名 */
export async function rankLpOffers(
  db: DbAdapter,
  corporationId: number,
  options: RankLpOffersOptions = {},
): Promise<LpOfferRanking> {
  const all = await listLpOffers(db, corporationId);
  const includeAk = options.includeAkOffers === true;
  const candidates = includeAk ? all : all.filter((offer) => offer.akCost === 0);

  const specs = await loadBlueprintSpecs(db, candidates.map((offer) => offer.typeId));
  const prices = await buildPriceIndex(db, candidates, options, specs);
  const assumption = resolveAssumption(options);
  const valued = candidates.map((offer) => valueOffer(offer, prices, specs, assumption));
  const unpricedOutputOffers = valued.filter((offer) => !offer.outputPriced).length;
  let ranked = [...valued].sort(compareOffers);
  const minIskPerLp = options.minIskPerLp;
  if (minIskPerLp !== undefined) {
    ranked = ranked.filter((offer) => offer.iskPerLp !== null && offer.iskPerLp >= minIskPerLp);
  }
  if (options.limit !== undefined && options.limit >= 0) ranked = ranked.slice(0, options.limit);

  return {
    corporationId,
    offers: ranked,
    skippedAkOffers: includeAk ? 0 : all.length - candidates.length,
    unpricedOutputOffers,
  };
}

/**
 * LP 组合：把角色在各军团的 LP 余额 × 该军团最优 ISK/LP，
 * 输出「每军团换什么、共值多少 ISK」（方案 §6.2 LP 优化器验收口径）。
 */
export async function buildLpPortfolio(
  db: DbAdapter,
  characterId: number,
  options: RankLpOffersOptions = {},
): Promise<LpPortfolioEntry[]> {
  const balances = await listLpBalances(db, characterId);
  if (balances.length === 0) return [];

  const entries: LpPortfolioEntry[] = await Promise.all(
    balances.map(async (balance) => {
      const ranking = await rankLpOffers(db, balance.corporationId, options);
      const best = ranking.offers[0] ?? null;
      return {
        corporationId: balance.corporationId,
        loyaltyPoints: balance.loyaltyPoints,
        bestOffer: best,
        totalNetIsk:
          best === null || best.iskPerLp === null ? 0 : balance.loyaltyPoints * best.iskPerLp,
        alternatives: ranking.offers.slice(1, 3),
        offersRanked: ranking.offers.length,
        skippedAkOffers: ranking.skippedAkOffers,
        unpricedOutputOffers: ranking.unpricedOutputOffers,
      };
    }),
  );

  // 收益高的军团排前面，便于界面直接渲染
  return entries.sort((a, b) => b.totalNetIsk - a.totalNetIsk || a.corporationId - b.corporationId);
}
