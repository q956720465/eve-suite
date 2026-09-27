import { describe, expect, it } from 'vitest';

import {
  ASSET_COLUMNS,
  CONTRACT_COLUMNS,
  JOURNAL_COLUMNS,
  JOB_COLUMNS,
  LP_COLUMNS,
  MINING_COLUMNS,
  MY_ORDER_COLUMNS,
  toAssetRow,
  toContractRow,
  toJobRow,
  toJournalRow,
  toLpRow,
  toMiningRow,
  toOrderRow,
} from '../../src/personal/rows';
import { CHARACTER_ID, CORPORATION_ID } from './fixtures';

const FETCHED_AT = '2026-09-27T12:00:00Z';

describe('个人数据行映射', () => {
  it('列常量与迁移 0004 逐表一致', () => {
    expect(ASSET_COLUMNS).toHaveLength(10);
    expect(JOURNAL_COLUMNS).toHaveLength(15);
    expect(MY_ORDER_COLUMNS).toHaveLength(16);
    expect(CONTRACT_COLUMNS).toHaveLength(24);
    expect(JOB_COLUMNS).toHaveLength(24);
    expect(MINING_COLUMNS).toHaveLength(6);
    expect(LP_COLUMNS).toHaveLength(4);
  });

  it('assets：布尔转 0/1，is_blueprint_copy 可选缺省为 null', () => {
    const plain = toAssetRow(
      { item_id: 1, type_id: 34, quantity: 10, location_id: 2, location_flag: 'Hangar', location_type: 'station', is_singleton: false },
      CHARACTER_ID,
      FETCHED_AT,
    );
    expect(plain).toEqual([CHARACTER_ID, 1, 34, 10, 2, 'Hangar', 'station', 0, null, FETCHED_AT]);

    const copy = toAssetRow(
      { item_id: 2, type_id: 34, quantity: 1, location_id: 2, location_flag: 'Hangar', location_type: 'station', is_singleton: true, is_blueprint_copy: true },
      CHARACTER_ID,
      FETCHED_AT,
    );
    expect(copy).toEqual([CHARACTER_ID, 2, 34, 1, 2, 'Hangar', 'station', 1, 1, FETCHED_AT]);
  });

  it('wallet_journal：id 映射 entry_id，可选字段缺省为 null', () => {
    const row = toJournalRow(
      { id: 77, date: '2026-09-27T10:00:00Z', ref_type: 'tax', description: 'desc' },
      CHARACTER_ID,
      FETCHED_AT,
    );
    expect(row).toEqual([
      CHARACTER_ID,
      77,
      '2026-09-27T10:00:00Z',
      'tax',
      'desc',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      FETCHED_AT,
    ]);
  });

  it('my_orders：可选字段（is_buy_order / escrow / min_volume）缺省为 null', () => {
    const row = toOrderRow(
      {
        order_id: 9,
        type_id: 34,
        region_id: 10000002,
        location_id: 60003760,
        price: 3.5,
        volume_total: 100,
        volume_remain: 100,
        is_corporation: true,
        duration: 90,
        issued: '2026-09-01T00:00:00Z',
        range: 'region',
      },
      CHARACTER_ID,
      FETCHED_AT,
    );
    expect(row).toEqual([
      CHARACTER_ID,
      9,
      34,
      10000002,
      60003760,
      3.5,
      100,
      100,
      1,
      90,
      '2026-09-01T00:00:00Z',
      'region',
      null,
      null,
      null,
      FETCHED_AT,
    ]);
  });

  it('contracts：布尔转 0/1，可选字段缺省为 null', () => {
    const row = toContractRow(
      {
        contract_id: 5,
        type: 'courier',
        status: 'outstanding',
        availability: 'personal',
        for_corporation: false,
        issuer_id: 1,
        issuer_corporation_id: CORPORATION_ID,
        assignee_id: 2,
        acceptor_id: 0,
        date_issued: '2026-09-20T00:00:00Z',
        date_expired: '2026-09-27T00:00:00Z',
      },
      CHARACTER_ID,
      FETCHED_AT,
    );
    expect(row).toEqual([
      CHARACTER_ID,
      5,
      'courier',
      'outstanding',
      'personal',
      0,
      1,
      CORPORATION_ID,
      2,
      0,
      '2026-09-20T00:00:00Z',
      '2026-09-27T00:00:00Z',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      FETCHED_AT,
    ]);
  });

  it('industry_jobs / mining / lp：必填直写，可选缺省 null', () => {
    const jobRow = toJobRow(
      {
        job_id: 4,
        activity_id: 1,
        blueprint_id: 1,
        blueprint_type_id: 2,
        blueprint_location_id: 3,
        output_location_id: 3,
        facility_id: 3,
        station_id: 3,
        installer_id: CHARACTER_ID,
        runs: 1,
        status: 'active',
        duration: 60,
        start_date: '2026-09-26T00:00:00Z',
        end_date: '2026-09-27T00:00:00Z',
      },
      CHARACTER_ID,
      FETCHED_AT,
    );
    expect(jobRow).toHaveLength(24);
    expect(jobRow[15]).toBeNull(); // product_type_id
    expect(jobRow[23]).toBe(FETCHED_AT);

    const miningRow = toMiningRow(
      { date: '2026-09-26', solar_system_id: 30000142, type_id: 34, quantity: 42 },
      CHARACTER_ID,
      FETCHED_AT,
    );
    expect(miningRow).toEqual([CHARACTER_ID, '2026-09-26', 30000142, 34, 42, FETCHED_AT]);

    const lpRow = toLpRow({ corporation_id: CORPORATION_ID, loyalty_points: 7 }, CHARACTER_ID, FETCHED_AT);
    expect(lpRow).toEqual([CHARACTER_ID, CORPORATION_ID, 7, FETCHED_AT]);
  });
});
