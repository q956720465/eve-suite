import { invoke } from '@tauri-apps/api/core';

import { runMigrations, type MigrateResult } from './migrate';
import { MIGRATIONS } from './migrations';
import type { DbAdapter } from './types';

export interface DatabaseInitResult extends MigrateResult {
  /** 实际生效的日志模式（期望 wal） */
  journalMode: string;
}

let adapterPromise: Promise<DbAdapter> | null = null;
let initPromise: Promise<DatabaseInitResult> | null = null;

/**
 * 初始化应用数据库：应用迁移并读取日志模式。
 * 连接池与连接级 PRAGMA（WAL / 外键 / busy_timeout）由 Rust 侧在建立连接时统一设置，
 * 因此这里不再下发 PRAGMA 语句。失败不缓存，可重试。
 */
export function initDatabase(): Promise<DatabaseInitResult> {
  initPromise ??= doInit().catch((error: unknown) => {
    initPromise = null;
    throw error;
  });
  return initPromise;
}

/** 获取数据库适配器（供仓储层使用） */
export function openAdapter(): Promise<DbAdapter> {
  adapterPromise ??= Promise.resolve(createAdapter()).catch((error: unknown) => {
    adapterPromise = null;
    throw error;
  });
  return adapterPromise;
}

async function doInit(): Promise<DatabaseInitResult> {
  const adapter = await openAdapter();
  const journalRows = await adapter.select<{ journal_mode: string }>('PRAGMA journal_mode');
  const result = await runMigrations(adapter, MIGRATIONS);
  return { ...result, journalMode: journalRows[0]?.journal_mode ?? 'unknown' };
}

function createAdapter(): DbAdapter {
  return {
    async execute(sql: string, params: readonly unknown[] = []): Promise<void> {
      await invoke<number>('db_execute', { sql, params: [...params], txId: null });
    },

    async select<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      return invoke<T[]>('db_select', { sql, params: [...params], txId: null });
    },

    async transaction<T>(work: (tx: DbAdapter) => Promise<T>): Promise<T> {
      const txId = await invoke<number>('db_tx_begin');
      try {
        const result = await work(createTransactionAdapter(txId));
        await invoke<unknown>('db_tx_end', { txId, commit: true });
        return result;
      } catch (error) {
        // 回滚失败不应掩盖原始错误
        await invoke<unknown>('db_tx_end', { txId, commit: false }).catch(() => undefined);
        throw error;
      }
    },
  };
}

/** 事务会话内的适配器：所有操作绑定到同一连接（txId） */
function createTransactionAdapter(txId: number): DbAdapter {
  return {
    async execute(sql: string, params: readonly unknown[] = []): Promise<void> {
      await invoke<number>('db_execute', { sql, params: [...params], txId });
    },

    async select<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      return invoke<T[]>('db_select', { sql, params: [...params], txId });
    },

    async transaction<T>(): Promise<T> {
      throw new Error('不支持嵌套事务');
    },
  };
}
