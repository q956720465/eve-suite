import type { DbAdapter, Migration } from './types';

const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export interface MigrateResult {
  /** 本次新应用的迁移数量 */
  applied: number;
  /** 应用后的 schema 版本（已应用的最大 version） */
  schemaVersion: number;
}

/**
 * 迁移执行器：按 version 升序应用未执行的迁移，幂等可重复调用。
 * 每条迁移在独立事务中执行，失败则回滚且不记入 schema_migrations。
 */
export async function runMigrations(
  db: DbAdapter,
  migrations: readonly Migration[],
): Promise<MigrateResult> {
  assertUniqueVersions(migrations);
  await db.execute(BOOTSTRAP_SQL);

  const rows = await db.select<{ version: number }>(
    'SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations',
  );
  let schemaVersion = rows[0]?.version ?? 0;

  const pending = [...migrations]
    .sort((a, b) => a.version - b.version)
    .filter((migration) => migration.version > schemaVersion);

  let applied = 0;
  for (const migration of pending) {
    try {
      // 整条迁移在单个事务内执行：失败整体回滚，不留半成品结构
      await db.transaction(async (tx) => {
        for (const statement of toStatements(migration)) {
          await tx.execute(statement);
        }
        await tx.execute(
          'INSERT INTO schema_migrations (version, name) VALUES (?, ?)',
          [migration.version, migration.name],
        );
      });
    } catch (error) {
      throw new Error(
        `迁移 ${migration.version}_${migration.name} 执行失败：${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    schemaVersion = migration.version;
    applied += 1;
  }

  return { applied, schemaVersion };
}

/** 取迁移的全部语句：statements 模式逐条返回，sql 模式包装为单元素数组 */
function toStatements(migration: Migration): readonly string[] {
  return migration.statements ? migration.statements : [migration.sql];
}

function assertUniqueVersions(migrations: readonly Migration[]): void {
  const seen = new Set<number>();
  for (const migration of migrations) {
    if (seen.has(migration.version)) {
      throw new Error(`迁移版本重复：${migration.version}`);
    }
    seen.add(migration.version);
  }
}