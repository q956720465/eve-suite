/**
 * 回环授权能力的 Tauri 运行时绑定（P3-1）。
 *
 * 与 `src-tauri/src/oauth.rs` 的命令一一对应；纯逻辑（流程编排）见 `esi/oauth-flow.ts`，
 * 分离的原因同 `db/tauri.ts`：流程可在无 Tauri 环境下离线单测。
 */

import { invoke } from '@tauri-apps/api/core';

import { DEFAULT_REDIRECT_PATH, type CallbackPayload, type LoopbackServer } from './oauth-flow';

/** `oauth_prepare` 的返回 */
interface PrepareResponse {
  port: number;
  redirectUri: string;
}

/** 创建基于 Rust 回环服务的宿主能力 */
export function createTauriLoopbackServer(): LoopbackServer {
  return {
    prepare(
      port: number,
      redirectPath: string = DEFAULT_REDIRECT_PATH,
    ): Promise<PrepareResponse> {
      return invoke<PrepareResponse>('oauth_prepare', { port, redirectPath });
    },

    async openBrowser(url: string): Promise<void> {
      await invoke<unknown>('oauth_open_browser', { url });
    },

    waitCallback(timeoutMs: number): Promise<CallbackPayload> {
      return invoke<CallbackPayload>('oauth_wait_callback', { timeoutMs });
    },

    async cancel(): Promise<void> {
      await invoke<unknown>('oauth_cancel');
    },
  };
}
