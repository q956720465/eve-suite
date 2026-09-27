/** LP 商店模块（P4-3）：ESI 公共端点拉取 + 本地仓储；比价计算在 `engines/lp.ts` */
export {
  LP_OFFER_COLUMNS,
  LP_OFFER_ITEM_COLUMNS,
  getLpStoreState,
  listCorporationIdsWithLp,
  listLpBalances,
  listLpOffers,
  listLpStoreStates,
  markStoreError,
  markStoreOk,
  markStoreStarted,
  replaceStoreOffers,
} from './repo';
export type { LpBalance, LpOfferRecord, LpStoreState, StoreOkPatch } from './repo';

export { DEFAULT_LP_STORE_TTL_MS, LpStoreSyncer, resolveStoreExpiresAt } from './sync';
export type {
  LpStoreSyncOptions,
  LpStoreSyncResult,
  LpStoreSyncSummary,
  LpStoreSyncerOptions,
} from './sync';
