import { describe, expect, it } from 'vitest';

import { EsiClient } from '../../src/esi/client';
import { EsiError } from '../../src/esi/types';
import { createMockHttp, emptyResponse, jsonResponse } from '../helpers/mock-http';

const BASE = 'https://esi.evetech.net/latest';

function createClient() {
  const http = createMockHttp();
  return { http, client: new EsiClient({ http, baseUrl: BASE }) };
}

describe('ESI 客户端', () => {
  it('解析业务数据与限流/错误预算响应头', async () => {
    const { http, client } = createClient();
    http.enqueue(
      jsonResponse(
        200,
        { players: 12345, server_version: '1.2.3', start_time: '2026-09-27T11:00:00Z' },
        {
          etag: 'W/"abc"',
          'x-ratelimit-group': 'status',
          'x-ratelimit-limit': '600/15m',
          'x-ratelimit-remaining': '598',
          'x-ratelimit-used': '2',
          'x-esi-error-limit-remain': '100',
          'x-esi-error-limit-reset': '60',
        },
      ),
    );

    const result = await client.fetchStatus();

    expect(result.notModified).toBe(false);
    expect(result.data?.players).toBe(12345);
    expect(result.etag).toBe('W/"abc"');
    expect(result.rateLimit).toEqual({ group: 'status', limit: '600/15m', remaining: 598, used: 2 });
    expect(result.errorLimit).toEqual({ remain: 100, reset: 60 });
    expect(http.calls[0].url).toBe(`${BASE}/status/`);
  });

  it('区域订单：URL 含分页与 order_type，并解析 X-Pages', async () => {
    const { http, client } = createClient();
    http.enqueue(
      jsonResponse(200, [{ order_id: 1, type_id: 34, price: 4.5, is_buy_order: false }], {
        'x-pages': '404',
      }),
    );

    const result = await client.fetchRegionOrders(10000002, 3);

    expect(http.calls[0].url).toBe(
      `${BASE}/markets/10000002/orders/?order_type=all&page=3`,
    );
    expect(result.pages).toBe(404);
    expect(result.data).toHaveLength(1);
  });

  it('ETag 条件请求：传入 If-None-Match，304 时 notModified 且无数据', async () => {
    const { http, client } = createClient();
    http.enqueue(emptyResponse(304, { etag: 'W/"abc"' }));

    const result = await client.fetchRegionOrders(10000002, 1, { etag: 'W/"abc"' });

    expect(http.calls[0].ifNoneMatch).toBe('W/"abc"');
    expect(result.notModified).toBe(true);
    expect(result.data).toBeNull();
    expect(result.etag).toBe('W/"abc"');
  });

  it('按需订单与日线历史：URL 构造正确', async () => {
    const { http, client } = createClient();
    http.enqueue(jsonResponse(200, []));
    http.enqueue(jsonResponse(200, []));

    await client.fetchTypeOrders(10000002, 34);
    await client.fetchTypeHistory(10000002, 34);

    expect(http.calls[0].url).toBe(`${BASE}/markets/10000002/orders/?type_id=34`);
    expect(http.calls[1].url).toBe(`${BASE}/markets/10000002/history/?type_id=34`);
  });

  it('429：抛可重试错误，并保留 Retry-After 与配额信息', async () => {
    const { http, client } = createClient();
    http.enqueue(
      emptyResponse(429, {
        'retry-after': '30',
        'x-ratelimit-group': 'market-order',
        'x-ratelimit-limit': '12000/15m',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-used': '12000',
      }),
    );

    const error = await client.fetchRegionOrders(10000002, 1).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EsiError);
    const esiError = error as EsiError;
    expect(esiError.kind).toBe('throttled');
    expect(esiError.status).toBe(429);
    expect(esiError.retryAfterSeconds).toBe(30);
    expect(esiError.retryable).toBe(true);
    expect(esiError.rateLimit?.remaining).toBe(0);
  });

  it('5xx：归类为可重试的 throttled', async () => {
    const { http, client } = createClient();
    http.enqueue(emptyResponse(503));

    const error = (await client.fetchStatus().catch((e: unknown) => e)) as EsiError;
    expect(error.kind).toBe('throttled');
    expect(error.retryable).toBe(true);
  });

  it('4xx：归类为不可重试的 client 错误', async () => {
    const { http, client } = createClient();
    http.enqueue(emptyResponse(404));

    const error = (await client.fetchStatus().catch((e: unknown) => e)) as EsiError;
    expect(error.kind).toBe('client');
    expect(error.status).toBe(404);
    expect(error.retryable).toBe(false);
  });

  it('非法 JSON：归类为 invalid（可重试）', async () => {
    const { http, client } = createClient();
    http.enqueue({ status: 200, headers: {}, text: '<html>not json</html>' });

    const error = (await client.fetchStatus().catch((e: unknown) => e)) as EsiError;
    expect(error.kind).toBe('invalid');
    expect(error.retryable).toBe(true);
  });

  it('网络异常：归类为 network', async () => {
    const { http, client } = createClient();
    http.enqueue(new Error('socket hang up'));

    const error = (await client.fetchStatus().catch((e: unknown) => e)) as EsiError;
    expect(error.kind).toBe('network');
    expect(error.retryable).toBe(true);
  });
});
