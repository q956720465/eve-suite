/**
 * 系统钥匙串的 Tauri 运行时绑定（P3-2）。
 *
 * 与 `src-tauri/src/secrets.rs` 的三个命令一一对应；纯逻辑见 `esi/secret-store.ts`。
 * 注意：机密只在此层与 Rust 之间传递，**不写日志、不进数据库**。
 */

import { invoke } from '@tauri-apps/api/core';

import type { SecretStore } from './secret-store';

/** 创建基于系统钥匙串的机密存储 */
export function createTauriSecretStore(): SecretStore {
  return {
    async set(account: string, secret: string): Promise<void> {
      await invoke<unknown>('secret_set', { account, secret });
    },

    get(account: string): Promise<string | null> {
      return invoke<string | null>('secret_get', { account });
    },

    async delete(account: string): Promise<void> {
      await invoke<unknown>('secret_delete', { account });
    },
  };
}
