import type {
  CharacterAsset,
  CharacterContract,
  CharacterOrder,
  IndustryJob,
  LoyaltyPoints,
  MiningObservation,
  WalletJournalEntry,
} from '../esi/types';

/**
 * 个人数据表的列顺序与行映射（与迁移 0004 逐列对应）。
 * 布尔一律转 0/1；可选字段缺省写 null；`id` 映射为 `entry_id`。
 */

// ── assets ──

export const ASSET_COLUMNS = [
  'character_id',
  'item_id',
  'type_id',
  'quantity',
  'location_id',
  'location_flag',
  'location_type',
  'is_singleton',
  'is_blueprint_copy',
  'fetched_at',
] as const;

export function toAssetRow(
  asset: CharacterAsset,
  characterId: number,
  fetchedAt: string,
): unknown[] {
  return [
    characterId,
    asset.item_id,
    asset.type_id,
    asset.quantity,
    asset.location_id,
    asset.location_flag,
    asset.location_type,
    asset.is_singleton ? 1 : 0,
    asset.is_blueprint_copy === undefined ? null : asset.is_blueprint_copy ? 1 : 0,
    fetchedAt,
  ];
}

// ── wallet_journal ──

export const JOURNAL_COLUMNS = [
  'character_id',
  'entry_id',
  'date',
  'ref_type',
  'description',
  'amount',
  'balance',
  'reason',
  'first_party_id',
  'second_party_id',
  'context_id',
  'context_id_type',
  'tax',
  'tax_receiver_id',
  'fetched_at',
] as const;

/** journal 冲突时覆盖的非主键列（条目理论上不可变，此处为幂等兜底） */
export const JOURNAL_CONFLICT_UPDATE = [
  'date',
  'ref_type',
  'description',
  'amount',
  'balance',
  'reason',
  'first_party_id',
  'second_party_id',
  'context_id',
  'context_id_type',
  'tax',
  'tax_receiver_id',
  'fetched_at',
] as const;

export function toJournalRow(
  entry: WalletJournalEntry,
  characterId: number,
  fetchedAt: string,
): unknown[] {
  return [
    characterId,
    entry.id,
    entry.date,
    entry.ref_type,
    entry.description,
    entry.amount ?? null,
    entry.balance ?? null,
    entry.reason ?? null,
    entry.first_party_id ?? null,
    entry.second_party_id ?? null,
    entry.context_id ?? null,
    entry.context_id_type ?? null,
    entry.tax ?? null,
    entry.tax_receiver_id ?? null,
    fetchedAt,
  ];
}

// ── my_orders ──

export const MY_ORDER_COLUMNS = [
  'character_id',
  'order_id',
  'type_id',
  'region_id',
  'location_id',
  'price',
  'volume_total',
  'volume_remain',
  'is_corporation',
  'duration',
  'issued',
  'range',
  'min_volume',
  'is_buy_order',
  'escrow',
  'fetched_at',
] as const;

export function toOrderRow(
  order: CharacterOrder,
  characterId: number,
  fetchedAt: string,
): unknown[] {
  return [
    characterId,
    order.order_id,
    order.type_id,
    order.region_id,
    order.location_id,
    order.price,
    order.volume_total,
    order.volume_remain,
    order.is_corporation ? 1 : 0,
    order.duration,
    order.issued,
    order.range,
    order.min_volume ?? null,
    order.is_buy_order === undefined ? null : order.is_buy_order ? 1 : 0,
    order.escrow ?? null,
    fetchedAt,
  ];
}

// ── contracts ──

export const CONTRACT_COLUMNS = [
  'character_id',
  'contract_id',
  'type',
  'status',
  'availability',
  'for_corporation',
  'issuer_id',
  'issuer_corporation_id',
  'assignee_id',
  'acceptor_id',
  'date_issued',
  'date_expired',
  'title',
  'price',
  'reward',
  'collateral',
  'buyout',
  'volume',
  'days_to_complete',
  'start_location_id',
  'end_location_id',
  'date_accepted',
  'date_completed',
  'fetched_at',
] as const;

export function toContractRow(
  contract: CharacterContract,
  characterId: number,
  fetchedAt: string,
): unknown[] {
  return [
    characterId,
    contract.contract_id,
    contract.type,
    contract.status,
    contract.availability,
    contract.for_corporation ? 1 : 0,
    contract.issuer_id,
    contract.issuer_corporation_id,
    contract.assignee_id,
    contract.acceptor_id,
    contract.date_issued,
    contract.date_expired,
    contract.title ?? null,
    contract.price ?? null,
    contract.reward ?? null,
    contract.collateral ?? null,
    contract.buyout ?? null,
    contract.volume ?? null,
    contract.days_to_complete ?? null,
    contract.start_location_id ?? null,
    contract.end_location_id ?? null,
    contract.date_accepted ?? null,
    contract.date_completed ?? null,
    fetchedAt,
  ];
}

// ── industry_jobs ──

export const JOB_COLUMNS = [
  'character_id',
  'job_id',
  'activity_id',
  'blueprint_id',
  'blueprint_type_id',
  'blueprint_location_id',
  'output_location_id',
  'facility_id',
  'station_id',
  'installer_id',
  'runs',
  'status',
  'duration',
  'start_date',
  'end_date',
  'product_type_id',
  'licensed_runs',
  'successful_runs',
  'probability',
  'cost',
  'pause_date',
  'completed_date',
  'completed_character_id',
  'fetched_at',
] as const;

export function toJobRow(job: IndustryJob, characterId: number, fetchedAt: string): unknown[] {
  return [
    characterId,
    job.job_id,
    job.activity_id,
    job.blueprint_id,
    job.blueprint_type_id,
    job.blueprint_location_id,
    job.output_location_id,
    job.facility_id,
    job.station_id,
    job.installer_id,
    job.runs,
    job.status,
    job.duration,
    job.start_date,
    job.end_date,
    job.product_type_id ?? null,
    job.licensed_runs ?? null,
    job.successful_runs ?? null,
    job.probability ?? null,
    job.cost ?? null,
    job.pause_date ?? null,
    job.completed_date ?? null,
    job.completed_character_id ?? null,
    fetchedAt,
  ];
}

// ── mining_ledger ──

export const MINING_COLUMNS = [
  'character_id',
  'date',
  'solar_system_id',
  'type_id',
  'quantity',
  'fetched_at',
] as const;

/** mining 冲突时覆盖的列：同日同星系同物品的采矿量可能修正 */
export const MINING_CONFLICT_UPDATE = ['quantity', 'fetched_at'] as const;

export function toMiningRow(
  observation: MiningObservation,
  characterId: number,
  fetchedAt: string,
): unknown[] {
  return [
    characterId,
    observation.date,
    observation.solar_system_id,
    observation.type_id,
    observation.quantity,
    fetchedAt,
  ];
}

// ── lp_balances ──

export const LP_COLUMNS = [
  'character_id',
  'corporation_id',
  'loyalty_points',
  'fetched_at',
] as const;

export function toLpRow(
  points: LoyaltyPoints,
  characterId: number,
  fetchedAt: string,
): unknown[] {
  return [characterId, points.corporation_id, points.loyalty_points, fetchedAt];
}
