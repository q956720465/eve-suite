import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { DbAdapter } from '../../src/db/types';

export interface PoolingAdapter extends DbAdapter {
  /** 连接数 */
  readonly size: number;
  /** 关闭全部连接并删除临时数据库文件 */
  dispose(): void;
}

/**
 * 连接池模拟适配器：在同一数据库文件上开多条连接，普通 execute / select 轮流分派到不同连接，
 * 只有 transaction 会话会固定在单条连接上。
 *
 * 存在意义：真实运行时（sqlx 连接池）下，「依赖连接身份的隐式事务」（裸写 BEGIN/COMMIT、
 * 或把一批语句直接 execute）会表现为 `database is locked` 或原子性丢失；单连接的
 * node:sqlite 适配器无法复现这类缺陷，导致「测试绿、运行时红」。用本适配器跑迁移与
 * 导入测试，可让此类问题在 CI 中直接暴露。
 */
export function createPoolingAdapter(connectionCount = 3): PoolingAdapter {
  if (connectionCount < 2) {
    throw new Error('连接池模拟至少需要 2 条连接');
  }

  const file = join(tmpdir(), `eve-suite-pool-${randomUUID()}.db`);
  const connections = Array.from({ length: connectionCount }, () => new DatabaseSync(file));

  // 与运行时保持一致：WAL（库级持久）+ 有界等待（避免测试长时间挂起）
  connections[0].exec('PRAGMA journal_mode = WAL');
  for (const connection of connections) {
    connection.exec('PRAGMA busy_timeout = 2000');
  }

  let cursor = 0;
  const nextConnection = (): DatabaseSync => {
    const connection = connections[cursor % connections.length];
    cursor += 1;
    return connection;
  };

  return {
    size: connectionCount,

    async execute(sql: string, params: readonly unknown[] = []): Promise<void> {
      runOn(nextConnection(), sql, params);
    },

    async select<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      return queryOn<T>(nextConnection(), sql, params);
    },

    async transaction<T>(work: (tx: DbAdapter) => Promise<T>): Promise<T> {
      // 会话固定在一条连接上：回调内所有操作复用该连接
      const connection = nextConnection();
      connection.exec('BEGIN');
      try {
        const result = await work(adapterOn(connection));
        connection.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          connection.exec('ROLLBACK');
        } catch {
          // 回滚失败不应掩盖原始错误
        }
        throw error;
      }
    },

    dispose(): void {
      for (const connection of connections) {
        try {
          connection.close();
        } catch {
          // 忽略关闭异常
        }
      }
      try {
        unlinkSync(file);
      } catch {
        // 文件可能已被清理
      }
    },
  };
}

/** 绑定到指定连接的适配器（事务会话内使用） */
function adapterOn(connection: DatabaseSync): DbAdapter {
  return {
    async execute(sql: string, params: readonly unknown[] = []): Promise<void> {
      runOn(connection, sql, params);
    },
    async select<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      return queryOn<T>(connection, sql, params);
    },
    async transaction<T>(): Promise<T> {
      throw new Error('不支持嵌套事务');
    },
  };
}

function runOn(connection: DatabaseSync, sql: string, params: readonly unknown[]): void {
  if (params.length === 0) {
    connection.exec(sql);
    return;
  }
  const statement = connection.prepare(sql);
  statement.run(...(params as Parameters<typeof statement.run>));
}

function queryOn<T>(connection: DatabaseSync, sql: string, params: readonly unknown[]): T[] {
  const statement = connection.prepare(sql);
  return statement.all(...(params as Parameters<typeof statement.all>)) as T[];
}
