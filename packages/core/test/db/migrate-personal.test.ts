import { describe, expect, it } from 'vitest';

import { runMigrations } from '../../src/db/migrate';
import { MIGRATIONS } from '../../src/db/migrations';
import type { DbAdapter } from '../../src/db/types';
import { createNodeSqliteAdapter } from '../helpers/node-sqlite-adapter';

/** P3-4 期望的表结构：表 → 列（顺序无关）与索引名 */
const EXPECTED_TABLES: Record<string, { columns: readonly string[]; indexes?: readonly string[] }> = {
  characters: {
    columns: [
      'character_id',
      'name',
      'corporation_id',
      'scopes',
      'wallet_balance',
      'wallet_synced_at',
      'added_at',
      'last_sync_at',
    ],
  },
  assets: {
    columns: [
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
    ],
    indexes: ['idx_assets_char_type', 'idx_assets_char_location'],
  },
  wallet_journal: {
    columns: [
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
    ],
    indexes: ['idx_wallet_journal_char_date'],
  },
  my_orders: {
    columns: [
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
    ],
    indexes: ['idx_my_orders_char_type'],
  },
  contracts: {
    columns: [
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
    ],
    indexes: ['idx_contracts_char_status', 'idx_contracts_char_issued'],
  },
  industry_jobs: {
    columns: [
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
    ],
    indexes: ['idx_industry_jobs_char_status'],
  },
  mining_ledger: {
    columns: ['character_id', 'date', 'solar_system_id', 'type_id', 'quantity', 'fetched_at'],
    indexes: ['idx_mining_ledger_char_date'],
  },
  lp_balances: {
    columns: ['character_id', 'corporation_id', 'loyalty_points', 'fetched_at'],
  },
  networth_snapshots: {
    columns: [
      'character_id',
      'snapshot_date',
      'total_value',
      'assets_value',
      'wallet_balance',
      'sell_orders_value',
      'contracts_value',
      'created_at',
    ],
    indexes: ['idx_networth_snapshots_date'],
  },
  personal_sync_state: {
    columns: [
      'character_id',
      'scope',
      'etag',
      'expires_at',
      'last_started_at',
      'last_ok_at',
      'last_error',
      'pages',
    ],
  },
};

async function migrate(): Promise<DbAdapter> {
  const db = createNodeSqliteAdapter();
  await runMigrations(db, MIGRATIONS);
  return db;
}

async function columnsOf(db: DbAdapter, table: string): Promise<string[]> {
  const rows = await db.select<{ name: string }>(`PRAGMA table_info(${table})`);
  return rows.map((row) => row.name);
}

async function indexesOf(db: DbAdapter, table: string): Promise<string[]> {
  const rows = await db.select<{ name: string }>(`PRAGMA index_list(${table})`);
  return rows.map((row) => row.name).filter((name) => name.startsWith('idx_'));
}

describe('迁移 0004：个人数据表', () => {
  it('全新库：个人表建立且为空', async () => {
    const db = await migrate();
    const rows = await db.select<{ n: number }>('SELECT COUNT(*) AS n FROM characters');
    expect(rows[0].n).toBe(0);
  });

  it('应用后 schema 版本为 4，且逐表建立（列与索引齐全）', async () => {
    const db = await migrate();

    const versions = await db.select<{ version: number }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    );
    expect(versions.map((row) => row.version)).toEqual(MIGRATIONS.map((m) => m.version));

    for (const [table, expected] of Object.entries(EXPECTED_TABLES)) {
      const columns = await columnsOf(db, table);
      expect(new Set(columns), `表 ${table} 的列不一致`).toEqual(new Set(expected.columns));
      if (expected.indexes !== undefined) {
        expect(new Set(await indexesOf(db, table)), `表 ${table} 的索引不一致`).toEqual(
          new Set(expected.indexes),
        );
      }
    }
  });

  it('重复执行幂等：不重复应用', async () => {
    const db = await migrate();
    const second = await runMigrations(db, MIGRATIONS);
    expect(second).toEqual({ applied: 0, schemaVersion: MIGRATIONS.length });
  });

  it('不破坏既有表（P1 SDE / P2 行情 仍在）', async () => {
    const db = await migrate();
    const rows = await db.select<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    const names = rows.map((row) => row.name);
    for (const legacy of ['settings', 'sde_types', 'market_orders', 'market_stats', 'market_etag_cache']) {
      expect(names).toContain(legacy);
    }
  });

  it('ESI 可选字段可空：my_orders.is_buy_order / escrow / min_volume 允许为 NULL', async () => {
    const db = await migrate();
    await db.execute(
      `INSERT INTO my_orders (
        character_id, order_id, type_id, region_id, location_id, price,
        volume_total, volume_remain, is_corporation, duration, issued, range,
        min_volume, is_buy_order, escrow, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
      [1, 100, 34, 10000002, 60003760, 3.5, 100, 100, 0, 90, '2026-09-27T00:00:00Z', 'station', '2026-09-27T00:00:00Z'],
    );

    const rows = await db.select<{ is_buy_order: number | null; escrow: number | null }>(
      'SELECT is_buy_order, escrow FROM my_orders WHERE order_id = 100',
    );
    expect(rows[0]).toEqual({ is_buy_order: null, escrow: null });
  });

  it('字段少的端点也能落库并去重：mining_ledger 复合主键拒绝重复行', async () => {
    const db = await migrate();
    const insert = (): Promise<void> =>
      db.execute(
        `INSERT INTO mining_ledger (character_id, date, solar_system_id, type_id, quantity, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [1, '2026-09-27', 30000142, 34, 100, '2026-09-27T00:00:00Z'],
      );

    await insert();
    await expect(insert()).rejects.toThrow(/UNIQUE|PRIMARY/i);

    await db.execute(
      'UPDATE mining_ledger SET quantity = ? WHERE character_id = ? AND date = ? AND solar_system_id = ? AND type_id = ?',
      [150, 1, '2026-09-27', 30000142, 34],
    );
    const rows = await db.select<{ quantity: number }>('SELECT quantity FROM mining_ledger');
    expect(rows).toEqual([{ quantity: 150 }]);
  });

  it('networth_snapshots 分项默认 0，仅 total_value 必填', async () => {
    const db = await migrate();
    await db.execute(
      `INSERT INTO networth_snapshots (character_id, snapshot_date, total_value, created_at)
       VALUES (?, ?, ?, ?)`,
      [1, '2026-09-27', 1234567.89, '2026-09-27T12:00:00Z'],
    );

    const rows = await db.select<Record<string, number>>(
      'SELECT assets_value, wallet_balance, sell_orders_value, contracts_value FROM networth_snapshots',
    );
    expect(rows[0]).toEqual({
      assets_value: 0,
      wallet_balance: 0,
      sell_orders_value: 0,
      contracts_value: 0,
    });
  });

  it('personal_sync_state 以 (角色, scope) 为唯一水位行', async () => {
    const db = await migrate();
    await db.execute(
      `INSERT INTO personal_sync_state (character_id, scope, etag, last_ok_at)
       VALUES (?, ?, ?, ?)`,
      [1, 'assets', 'W/"etag-1"', '2026-09-27T12:00:00Z'],
    );
    await expect(
      db.execute(
        `INSERT INTO personal_sync_state (character_id, scope, etag) VALUES (?, ?, ?)`,
        [1, 'assets', 'W/"etag-2"'],
      ),
    ).rejects.toThrow(/UNIQUE|PRIMARY/i);

    const rows = await db.select<{ scope: string; etag: string }>(
      'SELECT scope, etag FROM personal_sync_state WHERE character_id = 1',
    );
    expect(rows).toEqual([{ scope: 'assets', etag: 'W/"etag-1"' }]);
  });
});
