import { runMigrations } from '../../src/db/migrate';
import { MIGRATIONS } from '../../src/db/migrations';
import type { DbAdapter } from '../../src/db/types';
import { createNodeSqliteAdapter } from './node-sqlite-adapter';

/** 创建已完成全部迁移的内存数据库（SDE 测试用） */
export async function createMigratedDb(): Promise<DbAdapter> {
  const db = createNodeSqliteAdapter();
  await runMigrations(db, MIGRATIONS);
  return db;
}

/** 统计表行数 */
export async function countRows(db: DbAdapter, table: string): Promise<number> {
  const rows = await db.select<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
  return rows[0]?.n ?? 0;
}
