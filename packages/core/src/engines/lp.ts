import type { DbAdapter } from '../db/types';
import { listLpBalances, listLpOffers, type LpOfferRecord } from '../lp/repo';

import { valueItems, type ValuationOptions } from './valuation';

/**
 * LP 比价引擎（方案 §6.1「计算器」之 LP 比价 / §6.2「LP 优化器」）。
 *
 * 口径（P4-3 定稿）：
 * - 产出与所需材料**都走估值引擎**（默认吉他 5% 分位；区域/站点/口径/过滤全透传）
 * - `净收益 netIsk = 产出估值 − 所需材料成本 − ISK 支出`
 * - `ISK/LP = netIsk ÷ lp_cost`（`lp_cost = 0` 或产出无报价时为 null，不除零、不假装有值）
 * - `ak_cost > 0`（需 CONCORD LP，与军团 LP 不同源）默认**跳过**，可显式纳入
 */

export interface LpOfferValuation {
  offerId: number;
  corporationId: number;
  /** 产出物 */
  typeId: number;
  quantity: number;
  lpCost: number;
  iskCost: number;
  akCost: number;
  requiredItems: {
    typeId: number;
    quantity: number;
    unitPrice: number | null;
    value: number;
  }[];
  /** 一次兑换的产出估值 */
  outputValue: number;
  /** 所需材料成本（按引擎单价） */
  inputCost: number;
  /** 产出估值 − 材料成本 − ISK 支出 */
  netIsk: number;
  /** 净收益 ÷ LP；无法计算时为 null */
  iskPerLp: number | null;
  /** 产出物是否有报价（无报价时 ISK/LP 不可用） */
  outputPriced: boolean;
  /** 参与本次估值的无报价物品（产出或材料） */
  missingTypeIds: number[];
}

export interface RankLpOffersOptions extends ValuationOptions {
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
   * 产出无市场报价、因而无法计算 ISK/LP 的条数（不受 limit / minIskPerLp 影响）。
   * 多为蓝图类产出（BPC 无市场报价）——估值口径待定，见 DEV_STATUS「已知待办」。
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
  /** 产出无市场报价、无法估值的条数（多为蓝图类产出） */
  unpricedOutputOffers: number;
}

/** 估值上下文：一次性取价，避免逐条 offer 查询 */
interface PriceIndex {
  priceOf(typeId: number): number | null;
}

async function buildPriceIndex(
  db: DbAdapter,
  offers: readonly LpOfferRecord[],
  options: ValuationOptions,
): Promise<PriceIndex> {
  const typeIds = new Set<number>();
  for (const offer of offers) {
    typeIds.add(offer.typeId);
    for (const item of offer.requiredItems) typeIds.add(item.typeId);
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

/** 单条报价估值（价格索引由调用方复用，避免重复查询） */
function valueOffer(offer: LpOfferRecord, prices: PriceIndex): LpOfferValuation {
  const missing = new Set<number>();

  const outputPrice = prices.priceOf(offer.typeId);
  if (outputPrice === null) missing.add(offer.typeId);
  const outputValue = (outputPrice ?? 0) * offer.quantity;

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
  const outputPriced = outputPrice !== null;
  const iskPerLp = outputPriced && offer.lpCost > 0 ? netIsk / offer.lpCost : null;

  return {
    offerId: offer.offerId,
    corporationId: offer.corporationId,
    typeId: offer.typeId,
    quantity: offer.quantity,
    lpCost: offer.lpCost,
    iskCost: offer.iskCost,
    akCost: offer.akCost,
    requiredItems,
    outputValue,
    inputCost,
    netIsk,
    iskPerLp,
    outputPriced,
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
  options: ValuationOptions = {},
): Promise<LpOfferValuation> {
  const prices = await buildPriceIndex(db, [offer], options);
  return valueOffer(offer, prices);
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

  const prices = await buildPriceIndex(db, candidates, options);
  const valued = candidates.map((offer) => valueOffer(offer, prices));
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
