import type { DbAdapter } from './types';

/**
 * 应用设置读写（`settings` 键值表，v1 迁移建立，方案文档 §5 的应用表）。
 *
 * 只做最小能力：读一个键、写一个键（存在则覆盖）。
 * 值一律以 TEXT 存储，由调用方负责序列化与校验
 * （如全域层档位的取值收敛在 `market/global-state.ts`）。
 */

/** 读取设置值；键不存在返回 null */
export async function readSetting(db: DbAdapter, key: string): Promise<string | null> {
  const rows = await db.select<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
  return rows[0]?.value ?? null;
}

/** 写入设置值（存在则覆盖） */
export async function writeSetting(db: DbAdapter, key: string, value: string): Promise<void> {
  await db.execute(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}
