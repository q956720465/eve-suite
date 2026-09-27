import Database from '@tauri-apps/plugin-sql';

import { runMigrations, type MigrateResult } from './migrate';
import { MIGRATIONS } from './migrations';
import type { DbAdapter } from './types';

/** 数据库连接串：相对路径由 plugin-sql 解析到应用数据目录 */
const DB_URL = 'sqlite:eve-suite.db';

export interface DatabaseInitResult extends MigrateResult {
  /** 实际生效的日志模式（期望 wal） */
  journalMode: string;
}

let adapterPromise: Promise<DbAdapter> | null = null;
let initPromise: Promise<DatabaseInitResult> | null = null;

/**
 * 初始化应用数据库：建立连接（进程内单例）→ WAL/外键 PRAGMA → 应用迁移。
 * 应用启动时调用一次；并发重复调用共享同一结果，失败不缓存可重试。
 */
export function initDatabase(): Promise<DatabaseInitResult> {
  initPromise ??= doInit().catch((error: unknown) => {
    initPromise = null;
    throw error;
  });
  return initPromise;
}

/** 获取数据库适配器（供后续模块的仓储层使用），连接进程内复用 */
export function openAdapter(): Promise<DbAdapter> {
  adapterPromise ??= createAdapter().catch((error: unknown) => {
    adapterPromise = null;
    throw error;
  });
  return adapterPromise;
}

async function doInit(): Promise<DatabaseInitResult> {
  const adapter = await openAdapter();

  // WAL 为库级持久设置；外键约束为连接级设置
  const journalRows = await adapter.select<{ journal_mode: string }>('PRAGMA journal_mode = WAL');
  await adapter.execute('PRAGMA foreign_keys = ON');

  const result = await runMigrations(adapter, MIGRATIONS);
  return { ...result, journalMode: journalRows[0]?.journal_mode ?? 'unknown' };
}

async function createAdapter(): Promise<DbAdapter> {
  const db = await Database.load(DB_URL);
  return {
    async execute(sql: string, params: readonly unknown[] = []): Promise<void> {
      await db.execute(sql, params as unknown[]);
    },
    async select<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      return (await db.select<T[]>(sql, params as unknown[])) as T[];
    },
  };
}