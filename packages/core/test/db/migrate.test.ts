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

  it('应用生产迁移：settings 表建立且版本记录正确', async () => {
    const db = createNodeSqliteAdapter();
    const result = await runMigrations(db, MIGRATIONS);
    expect(result).toEqual({ applied: 1, schemaVersion: 1 });
    expect(await tableExists(db, 'settings')).toBe(true);

    const rows = await db.select<{ version: number; name: string }>(
      'SELECT version, name FROM schema_migrations ORDER BY version',
    );
    expect(rows).toEqual([{ version: 1, name: 'settings' }]);
  });

  it('幂等：重复执行不会重复应用', async () => {
    const db = createNodeSqliteAdapter();
    await runMigrations(db, MIGRATIONS);
    const second = await runMigrations(db, MIGRATIONS);
    expect(second).toEqual({ applied: 0, schemaVersion: 1 });

    const count = await db.select<{ n: number }>('SELECT COUNT(*) AS n FROM schema_migrations');
    expect(count[0].n).toBe(1);
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