/**
 * 个人数据同步的端点水位键（personal_sync_state.scope）。
 * 与 ESI 端点一一对应；wallet_balance 为单请求端点，其余分页。
 */
export const PERSONAL_SCOPES = [
  'assets',
  'wallet_balance',
  'wallet_journal',
  'orders',
  'contracts',
  'industry',
  'mining',
  'loyalty',
] as const;

export type PersonalScope = (typeof PERSONAL_SCOPES)[number];

/** 分页端点（走 fetchAllPages；wallet_balance 单请求，不在此列） */
export const PAGED_SCOPES: readonly PersonalScope[] = [
  'assets',
  'wallet_journal',
  'orders',
  'contracts',
  'industry',
  'mining',
  'loyalty',
];

export function isPersonalScope(value: string): value is PersonalScope {
  return (PERSONAL_SCOPES as readonly string[]).includes(value);
}
