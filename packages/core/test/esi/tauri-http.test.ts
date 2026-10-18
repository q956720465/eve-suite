import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { createTauriHttpClient } from '../../src/esi/tauri-http';

describe('Rust 侧 ESI 客户端（HTTP/1.1 路径）', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('把 Rust 响应映射为 HttpResponse（status / headers / text）', async () => {
    invokeMock.mockResolvedValue({ status: 200, headers: { etag: '"abc"' }, body: 'payload' });
    const response = await createTauriHttpClient().get({
      url: 'https://esi.evetech.net/latest/status/',
    });
    expect(response).toEqual({ status: 200, headers: { etag: '"abc"' }, text: 'payload' });
  });

  it('命令名与参数用 camelCase（Tauri 侧转 snake_case）；可选头缺省传 null', async () => {
    invokeMock.mockResolvedValue({ status: 200, headers: {}, body: '' });
    await createTauriHttpClient().get({ url: 'https://esi.evetech.net/latest/status/' });
    expect(invokeMock).toHaveBeenCalledWith('esi_http_get', {
      url: 'https://esi.evetech.net/latest/status/',
      ifNoneMatch: null,
      bearerToken: null,
    });
  });

  it('条件请求 ETag 与 Bearer 令牌按参数透传；304 空体原样返回', async () => {
    invokeMock.mockResolvedValue({ status: 304, headers: { etag: 'W/"1"' }, body: '' });
    const response = await createTauriHttpClient().get({
      url: 'https://esi.evetech.net/latest/markets/10000002/orders/?page=1',
      ifNoneMatch: 'W/"1"',
      bearerToken: 'token-1',
    });
    expect(invokeMock).toHaveBeenCalledWith('esi_http_get', {
      url: 'https://esi.evetech.net/latest/markets/10000002/orders/?page=1',
      ifNoneMatch: 'W/"1"',
      bearerToken: 'token-1',
    });
    expect(response.status).toBe(304);
    expect(response.text).toBe('');
  });
});
