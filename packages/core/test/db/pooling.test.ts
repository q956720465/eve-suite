import { describe, expect, it } from 'vitest';

import { runMigrations } from '../../src/db/migrate';
import { MIGRATIONS } from '../../src/db/migrations';
import { importSde } from '../../src/sde/import';
import { createPoolingAdapter } from '../helpers/pooling-adapter';
import { createMemorySource } from '../sde/fixtures';

/**
 * 本组用例使用「连接池模拟适配器」（多连接轮转）。
 * 单连接的内存适配器无法暴露「依赖连接身份的隐式事务」缺陷，
 * 这组用例把该缺陷拉进 CI，避免重演「测试全绿、运行时 database is locked」。
 */
describe('连接池适配器下的原子性', () => {
  it('迁移在连接池下正常完成（可用连接数不影响迁移结果）', async () => {
    const db = createPoolingAdapter();
    try {
      const result = await runMigrations(db, MIGRATIONS);
      expect(result).toEqual({
        applied: MIGRATIONS.length,
        schemaVersion: MIGRATIONS.length,
      });

      const tables = await db.select<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('settings', 'sde_types') ORDER BY name",
      );
      expect(tables.map((row) => row.name)).toEqual(['sde_types', 'settings']);
    } finally {
      db.dispose();
    }
  });

  it('SDE 导入在连接池下正常完成', async () => {
    const db = createPoolingAdapter();
    try {
      await runMigrations(db, MIGRATIONS);
      const summary = await importSde(db, createMemorySource());

      expect(summary.skipped).toBe(false);
      expect(summary.counts.types).toBe(4);

      const rows = await db.select<{ n: number }>('SELECT COUNT(*) AS n FROM sde_types');
      expect(rows[0].n).toBe(4);
    } finally {
      db.dispose();
    }
  });

  it('事务失败整体回滚（连接池下同样成立）', async () => {
    const db = createPoolingAdapter();
    try {
      await runMigrations(db, MIGRATIONS);

      await expect(
        db.transaction(async (tx) => {
          await tx.execute('CREATE TABLE pool_rollback_probe (id INTEGER PRIMARY KEY)');
          throw new Error('模拟失败');
        }),
      ).rejects.toThrow('模拟失败');

      const tables = await db.select<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pool_rollback_probe'",
      );
      expect(tables).toHaveLength(0);
    } finally {
      db.dispose();
    }
  });

  it('反例：裸写 BEGIN/COMMIT 在连接池下必然失败（证明适配器可捕获该类缺陷）', async () => {
    const db = createPoolingAdapter();
    try {
      await runMigrations(db, MIGRATIONS);

      await expect(
        (async () => {
          await db.execute('BEGIN');
          await db.execute('CREATE TABLE naive_probe (id INTEGER PRIMARY KEY)');
          await db.execute('COMMIT');
        })(),
      ).rejects.toThrow();
    } finally {
      db.dispose();
    }
  });
});
