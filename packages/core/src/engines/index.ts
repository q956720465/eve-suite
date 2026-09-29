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
  getMaxProductionLimit,
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

export { computeInventoryGap, getOwnedQuantities } from './inventory';
export type {
  InventoryGapLine,
  InventoryGapOptions,
  InventoryGapPrice,
  InventoryGapResult,
  InventoryHubSummary,
} from './inventory';

export { INDUSTRY_ACTIVITY_IDS, computeIndustryReconciliation, resolveIndustryActivity } from './industry';
export type {
  IndustryActivitySummary,
  IndustryJobReconciliation,
  IndustryLedgerLine,
  IndustryMaterialLine,
  IndustryReconciliationOptions,
  IndustryReconciliationResult,
} from './industry';

export {
  EVE_DOWNTIME_UTC_HOUR,
  computeMiningLedger,
  computeMiningRate,
  eveDayOf,
  previousEveDay,
} from './mining';
export type {
  MiningLedgerDay,
  MiningLedgerMonth,
  MiningLedgerOreLine,
  MiningLedgerOptions,
  MiningLedgerResult,
  MiningLedgerSystemLine,
  MiningRateInput,
  MiningRateResult,
  MiningUnfinishedDay,
  MiningValuationOptions,
} from './mining';

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
  NPC_STATION_BASE_YIELD,
  REFINE_YIELD_PRESETS,
  computeNpcStationYield,
  computeRefinedQuantity,
  listOreMaterials,
  listRefinableOres,
  refineOre,
} from './refining';
export type {
  NpcStationYieldInput,
  OreMaterial,
  RefinableOre,
  RefineMaterialLine,
  RefineOreInput,
  RefineOreResult,
  RefineYieldPreset,
} from './refining';
