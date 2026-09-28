/** 四大引擎出口（方案 §3.2）：估值 / 蓝图 / LP / 矿石。当前已落地估值与蓝图成本引擎。 */
export {
  DEFAULT_OUTLIER_MULTIPLE,
  DEFAULT_VALUATION_BASIS,
  DEFAULT_VALUATION_REGION_ID,
  filterOutlierPrices,
  getValuationPrice,
  positivePrices,
  priceFromSellPrices,
  valueItems,
  valueQuantity,
} from './valuation';
export type {
  BatchValuation,
  BatchValuationItem,
  TypeValuation,
  ValuationBasis,
  ValuationItem,
  ValuationOptions,
  ValuationSource,
} from './valuation';

export {
  DEFAULT_BLUEPRINT_ACTIVITY,
  MAX_MATERIAL_EFFICIENCY,
  MAX_TIME_EFFICIENCY,
  adjustJobSeconds,
  adjustMaterialQuantity,
  computeBlueprintCost,
  getBlueprintActivities,
  getBlueprintMaterials,
  getBlueprintProducts,
  normalizeRuns,
} from './blueprint';
export type {
  BlueprintActivity,
  BlueprintActivityInfo,
  BlueprintCostOptions,
  BlueprintCostResult,
  BlueprintMaterialLine,
  BlueprintProduct,
} from './blueprint';

export { buildLpPortfolio, computeOfferValue, rankLpOffers } from './lp';
export type {
  LpOfferRanking,
  LpOfferValuation,
  LpPortfolioEntry,
  RankLpOffersOptions,
} from './lp';

export {
  ASTEROID_CATEGORY_ID,
  DEFAULT_REFINE_TAX,
  DEFAULT_REFINE_YIELD,
  computeRefinedQuantity,
  listOreMaterials,
  listRefinableOres,
  refineOre,
} from './refining';
export type {
  OreMaterial,
  RefinableOre,
  RefineMaterialLine,
  RefineOreInput,
  RefineOreResult,
} from './refining';
