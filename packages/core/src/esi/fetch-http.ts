import type { HttpClient, HttpGetRequest, HttpResponse } from './http';
import type { TokenHttp } from './oauth';

/**
 * 基于全局 fetch 的 HTTP 客户端（WebView 与 Node 18+ 均可用）。
 *
 * 为何不经过宿主代理：实测 ESI 已返回 `Access-Control-Allow-Origin: *`，
 * 并通过 `Access-Control-Expose-Headers` 暴露 Etag / X-Pages / 错误预算等响应头，
 * 条件请求头 If-None-Match 也在预检允许列表中 —— 因此可直接在渲染进程发请求，
 * 省去每轮数十 MB 数据穿过 IPC 的开销。
 */
export function createFetchHttpClient(): HttpClient {
  return {
    async get(request: HttpGetRequest): Promise<HttpResponse> {
      const headers: Record<string, string> = {};
      if (request.ifNoneMatch !== undefined) {
        headers['If-None-Match'] = request.ifNoneMatch;
      }
      if (request.bearerToken !== undefined) {
        headers.Authorization = `Bearer ${request.bearerToken}`;
      }

      const response = await fetch(request.url, {
        method: 'GET',
        headers,
        signal: request.signal,
      });

      const normalized: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        normalized[key.toLowerCase()] = value;
      });

      // 304 无响应体；其余状态读取文本（gzip 由 fetch 自动解压）
      const text = response.status === 304 ? '' : await response.text();

      return { status: response.status, headers: normalized, text };
    },
  };
}

/**
 * 基于全局 fetch 的令牌端点客户端（PKCE 换码 / 刷新令牌）。
 *
 * 实测 EVE SSO 令牌端点 CORS 允许渲染进程直连，故与 ESI 请求一样不经宿主代理。
 * 请求体为 `application/x-www-form-urlencoded`（OAuth 2.0 规范要求）。
 */
export function createFetchTokenHttp(): TokenHttp {
  return {
    async postForm(url: string, body: Readonly<Record<string, string>>): Promise<HttpResponse> {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
      });

      const normalized: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        normalized[key.toLowerCase()] = value;
      });

      return { status: response.status, headers: normalized, text: await response.text() };
    },
  };
}
