import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFetchHttpClient } from '../../src/esi/fetch-http';

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

/** 用假 fetch 捕获实际发出的请求（含请求头） */
function stubFetch(status = 200, body = '{}', headers: Record<string, string> = {}): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return {
      status,
      headers: {
        forEach(callback: (value: string, key: string) => void): void {
          for (const [key, value] of Object.entries(headers)) callback(value, key);
        },
      },
      text: async (): Promise<string> => body,
    } as unknown as Response;
  });
  return calls;
}

function headersOf(call: FetchCall): Record<string, string> {
  return (call.init?.headers ?? {}) as Record<string, string>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetch HTTP 客户端', () => {
  it('未传 bearerToken 时不带 Authorization 头', async () => {
    const calls = stubFetch();
    await createFetchHttpClient().get({ url: 'https://esi.evetech.net/latest/status/' });

    expect(calls).toHaveLength(1);
    expect(headersOf(calls[0]).Authorization).toBeUndefined();
  });

  it('传 bearerToken 时以 Bearer 形式发送', async () => {
    const calls = stubFetch();
    await createFetchHttpClient().get({
      url: 'https://esi.evetech.net/latest/characters/42/wallet/',
      bearerToken: 'access-1',
    });

    expect(headersOf(calls[0]).Authorization).toBe('Bearer access-1');
  });

  it('条件请求头与认证头可共存', async () => {
    const calls = stubFetch();
    await createFetchHttpClient().get({
      url: 'https://esi.evetech.net/latest/characters/42/assets/',
      ifNoneMatch: 'W/"etag-1"',
      bearerToken: 'access-2',
    });

    const headers = headersOf(calls[0]);
    expect(headers['If-None-Match']).toBe('W/"etag-1"');
    expect(headers.Authorization).toBe('Bearer access-2');
  });

  it('304 不读取响应体', async () => {
    const calls = stubFetch(304);
    const response = await createFetchHttpClient().get({
      url: 'https://esi.evetech.net/latest/characters/42/assets/',
      bearerToken: 'access-3',
      ifNoneMatch: 'W/"etag-1"',
    });

    expect(calls).toHaveLength(1);
    expect(response.status).toBe(304);
    expect(response.text).toBe('');
  });
});
