import { DatabaseSync } from 'node:sqlite';

import type { DbAdapter } from '../../src/db/types';

/** 测试用适配器：Node 内置 node:sqlite（默认内存库），与运行时适配器共用同一套迁移逻辑 */
export function createNodeSqliteAdapter(location = ':memory:'): DbAdapter {
  const db = new DatabaseSync(location);
  return {
    async execute(sql: string, params: readonly unknown[] = []): Promise<void> {
      if (params.length === 0) {
        db.exec(sql);
        return;
      }
      const stmt = db.prepare(sql);
      stmt.run(...(params as Parameters<typeof stmt.run>));
    },
    async select<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      const stmt = db.prepare(sql);
      return stmt.all(...(params as Parameters<typeof stmt.all>)) as T[];
    },
  };
}