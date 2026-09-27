import { describe, expect, it } from 'vitest';

import { runMigrations } from '../../src/db/migrate';
import { MIGRATIONS } from '../../src/db/migrations';
import type { Migration } from '../../src/db/types';
import { createNodeSqliteAdapter } from '../helpers/node-sqlite-adapter';

/** 测试夹具迁移（仅测试使用，与生产迁移清单无关） */
function fixture(version: number, name: string, sql: string): Migration {
  return { version, name, sql };
}

async function tableExists(
  db: ReturnType<typeof createNodeSqliteAdapter>,
  name: string,
): Promise<boolean> {
  const rows = await db.select(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    [name],
  );
  return rows.length === 1;
}

describe('迁移执行器', () => {
  it('全新库：建立版本表，无待应用迁移', async () => {
    const db = createNodeSqliteAdapter();
    const result = await runMigrations(db, []);
    expect(result).toEqual({ applied: 0, schemaVersion: 0 });
    expect(await tableExists(db, 'schema_migrations')).toBe(true);
  });

  it('应用生产迁移：settings 与 SDE 表建立且版本记录正确', async () => {
    const db = createNodeSqliteAdapter();
    const result = await runMigrations(db, MIGRATIONS);
    expect(result).toEqual({
      applied: MIGRATIONS.length,
      schemaVersion: MIGRATIONS.length,
    });
    expect(await tableExists(db, 'settings')).toBe(true);
    expect(await tableExists(db, 'sde_types')).toBe(true);
    expect(await tableExists(db, 'sde_stations')).toBe(true);

    const rows = await db.select<{ version: number }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    );
    expect(rows.map((row) => row.version)).toEqual(MIGRATIONS.map((migration) => migration.version));
  });

  it('幂等：重复执行不会重复应用', async () => {
    const db = createNodeSqliteAdapter();
    await runMigrations(db, MIGRATIONS);
    const second = await runMigrations(db, MIGRATIONS);
    expect(second).toEqual({ applied: 0, schemaVersion: MIGRATIONS.length });

    const count = await db.select<{ n: number }>('SELECT COUNT(*) AS n FROM schema_migrations');
    expect(count[0].n).toBe(MIGRATIONS.length);
  });

  it('statements 模式：多条语句逐条执行（规避运行时只执行首条的陷阱）', async () => {
    const db = createNodeSqliteAdapter();
    const multi: Migration = {
      version: 1,
      name: 'multi',
      statements: [
        'CREATE TABLE multi_a (id INTEGER PRIMARY KEY);',
        'CREATE TABLE multi_b (id INTEGER PRIMARY KEY);',
        'CREATE INDEX idx_multi_a ON multi_a (id);',
      ],
    };
    const result = await runMigrations(db, [multi]);
    expect(result).toEqual({ applied: 1, schemaVersion: 1 });
    expect(await tableExists(db, 'multi_a')).toBe(true);
    expect(await tableExists(db, 'multi_b')).toBe(true);
  });

  it('增量：只应用版本高于当前的迁移', async () => {
    const db = createNodeSqliteAdapter();
    const v1 = fixture(1, 't1', 'CREATE TABLE t1 (id INTEGER PRIMARY KEY);');
    const v2 = fixture(2, 't2', 'CREATE TABLE t2 (id INTEGER PRIMARY KEY);');
    await runMigrations(db, [v1, v2]);

    const v3 = fixture(3, 't3', 'CREATE TABLE t3 (id INTEGER PRIMARY KEY);');
    const result = await runMigrations(db, [v1, v2, v3]);
    expect(result).toEqual({ applied: 1, schemaVersion: 3 });
    expect(await tableExists(db, 't3')).toBe(true);
  });

  it('失败回滚：出错迁移不落版本、不产生半成品表', async () => {
    const db = createNodeSqliteAdapter();
    const bad = fixture(
      1,
      'bad',
      'CREATE TABLE ok_table (id INTEGER PRIMARY KEY); CREATE TABLE ok_bad (',
    );
    await expect(runMigrations(db, [bad])).rejects.toThrow(/迁移 1_bad 执行失败/);

    const versions = await db.select('SELECT version FROM schema_migrations');
    expect(versions).toHaveLength(0);
    expect(await tableExists(db, 'ok_table')).toBe(false);
  });

  it('版本重复：拒绝执行', async () => {
    const db = createNodeSqliteAdapter();
    const duplicated = [
      fixture(1, 'a', 'CREATE TABLE a (id INTEGER)'),
      fixture(1, 'b', 'CREATE TABLE b (id INTEGER)'),
    ];
    await expect(runMigrations(db, duplicated)).rejects.toThrow(/迁移版本重复：1/);
  });
});