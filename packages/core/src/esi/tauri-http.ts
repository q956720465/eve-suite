import { invoke } from '@tauri-apps/api/core';

import type { HttpClient, HttpGetRequest, HttpResponse } from './http';

/**
 * Rust 侧 ESI 客户端（**HTTP/1.1 专用**，见 `src-tauri/src/esi_http.rs`）。
 *
 * 为什么不用渲染进程 fetch：Tauri 的渲染进程是 Chromium，对 `https://` 必然协商 HTTP/2，
 * 而实测 ESI 的 h2 路径对「大响应」比 h1 慢约 14 倍（`orders` 页 237 KB：h1 1.26 s vs h2 17.5 s）。
 * Rust 侧顺带提供 30 s 请求超时（渲染进程 fetch 无超时，曾出现请求长时间挂住）。
 */
export function createTauriHttpClient(): HttpClient {
  return {
    async get(request: HttpGetRequest): Promise<HttpResponse> {
      // `signal`（取消）目前无调用方；Rust 侧不实现取消，故此处不透传
      const response = await invoke<{
        status: number;
        headers: Record<string, string>;
        body: string;
      }>('esi_http_get', {
        url: request.url,
        ifNoneMatch: request.ifNoneMatch ?? null,
        bearerToken: request.bearerToken ?? null,
      });

      return { status: response.status, headers: response.headers, text: response.body };
    },
  };
}
