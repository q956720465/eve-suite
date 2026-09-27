import { describe, expect, it } from 'vitest';

import type { DbAdapter } from '../../src/db/types';
import { importSde } from '../../src/sde/import';
import { getStationNames, getTypeNames } from '../../src/sde/repo';
import { createMigratedDb } from '../helpers/db';

import { createMemorySource } from './fixtures';

async function setup(): Promise<DbAdapter> {
  const db = await createMigratedDb();
  await importSde(db, createMemorySource());
  return db;
}

describe('getTypeNames', () => {
  it('批量命中中英文名；未收录的 id 不在结果中', async () => {
    const db = await setup();
    const rows = await db.select<{ type_id: number; name_en: string }>(
      'SELECT type_id, name_en FROM sde_types ORDER BY type_id LIMIT 2',
    );
    expect(rows.length).toBeGreaterThan(0);

    const names = await getTypeNames(db, [...rows.map((row) => row.type_id), 999999999]);

    for (const row of rows) {
      expect(names.get(row.type_id)?.nameEn).toBe(row.name_en);
    }
    expect(names.size).toBe(rows.length);
    expect(names.has(999999999)).toBe(false);
  });

  it('重复 id 去重且空输入返回空 Map', async () => {
    const db = await setup();
    const rows = await db.select<{ type_id: number }>('SELECT type_id FROM sde_types LIMIT 1');
    const typeId = rows[0].type_id;

    expect((await getTypeNames(db, [typeId, typeId, typeId])).size).toBe(1);
    expect((await getTypeNames(db, [])).size).toBe(0);
  });
});

describe('getStationNames', () => {
  it('批量命中站名与星系名；未收录的 id 不在结果中', async () => {
    const db = await setup();
    const rows = await db.select<{ station_id: number; name_en: string }>(
      'SELECT station_id, name_en FROM sde_stations ORDER BY station_id LIMIT 2',
    );
    expect(rows.length).toBeGreaterThan(0);

    const names = await getStationNames(db, [...rows.map((row) => row.station_id), 1]);

    for (const row of rows) {
      expect(names.get(row.station_id)?.nameEn).toBe(row.name_en);
    }
    expect(names.has(1)).toBe(false);
  });
});
