import type {
  CharacterAsset,
  CharacterContract,
  CharacterOrder,
  IndustryJob,
  LoyaltyPoints,
  MiningObservation,
  WalletJournalEntry,
} from '../../src/esi/types';

/** 测试用角色 ID（与真实 ESI 请求路径无关，仅作主键） */
export const CHARACTER_ID = 2112696135;
export const CORPORATION_ID = 98000001;

export function asset(overrides: Partial<CharacterAsset> = {}): CharacterAsset {
  return {
    item_id: 1001,
    type_id: 34,
    quantity: 100,
    location_id: 60003760,
    location_flag: 'Hangar',
    location_type: 'station',
    is_singleton: false,
    ...overrides,
  };
}

export function journalEntry(overrides: Partial<WalletJournalEntry> = {}): WalletJournalEntry {
  return {
    id: 100,
    date: '2026-09-27T10:00:00Z',
    ref_type: 'player_donation',
    description: '测试入账',
    amount: 100.5,
    balance: 1100.5,
    first_party_id: 9001,
    second_party_id: CHARACTER_ID,
    ...overrides,
  };
}

export function order(overrides: Partial<CharacterOrder> = {}): CharacterOrder {
  return {
    order_id: 2001,
    type_id: 34,
    region_id: 10000002,
    location_id: 60003760,
    price: 4.5,
    volume_total: 1000,
    volume_remain: 800,
    is_corporation: false,
    duration: 90,
    issued: '2026-09-01T00:00:00Z',
    range: 'station',
    is_buy_order: false,
    min_volume: 1,
    ...overrides,
  };
}

export function contract(overrides: Partial<CharacterContract> = {}): CharacterContract {
  return {
    contract_id: 3001,
    type: 'item_exchange',
    status: 'outstanding',
    availability: 'personal',
    for_corporation: false,
    issuer_id: 9001,
    issuer_corporation_id: CORPORATION_ID,
    assignee_id: CHARACTER_ID,
    acceptor_id: 0,
    date_issued: '2026-09-20T00:00:00Z',
    date_expired: '2026-09-27T00:00:00Z',
    title: '测试合同',
    price: 1_000_000,
    ...overrides,
  };
}

export function job(overrides: Partial<IndustryJob> = {}): IndustryJob {
  return {
    job_id: 4001,
    activity_id: 1,
    blueprint_id: 101000,
    blueprint_type_id: 101002,
    blueprint_location_id: 60003760,
    output_location_id: 60003760,
    facility_id: 60003760,
    station_id: 60003760,
    installer_id: CHARACTER_ID,
    runs: 10,
    status: 'active',
    duration: 600,
    start_date: '2026-09-26T00:00:00Z',
    end_date: '2026-09-28T00:00:00Z',
    ...overrides,
  };
}

export function miningObservation(
  overrides: Partial<MiningObservation> = {},
): MiningObservation {
  return {
    date: '2026-09-26',
    solar_system_id: 30000142,
    type_id: 34,
    quantity: 5000,
    ...overrides,
  };
}

export function loyaltyPoints(overrides: Partial<LoyaltyPoints> = {}): LoyaltyPoints {
  return { corporation_id: CORPORATION_ID, loyalty_points: 2000, ...overrides };
}
