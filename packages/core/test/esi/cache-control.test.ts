import { describe, expect, it } from 'vitest';

import { EsiClient, parseCacheControl } from '../../src/esi/client';
import { createMockHttp, emptyResponse, jsonResponse } from '../helpers/mock-http';

describe('parseCacheControl', () => {
  it('无任何缓存头 → null', () => {
    expect(parseCacheControl({})).toBeNull();
    expect(parseCacheControl({ 'content-type': 'application/json' })).toBeNull();
  });

  it('public, max-age=300 → 解析出 max-age', () => {
    expect(parseCacheControl({ 'cache-control': 'public, max-age=300' })).toEqual({
      maxAgeSeconds: 300,
      expiresAtMs: null,
      noStore: false,
      mustRevalidate: false,
    });
  });

  it('大小写与引号不敏感：Max-Age="60"', () => {
    expect(parseCacheControl({ 'cache-control': 'Public, Max-Age="60"' })).toEqual({
      maxAgeSeconds: 60,
      expiresAtMs: null,
      noStore: false,
      mustRevalidate: false,
    });
  });

  it('no-store / no-cache 均视作不可复用', () => {
    expect(parseCacheControl({ 'cache-control': 'no-store' })?.noStore).toBe(true);
    expect(parseCacheControl({ 'cache-control': 'no-cache' })?.noStore).toBe(true);
    expect(parseCacheControl({ 'cache-control': 'public, max-age=30' })?.noStore).toBe(false);
  });

  it('max-age 缺失或非法 → maxAgeSeconds 为 null', () => {
    expect(parseCacheControl({ 'cache-control': 'private' })?.maxAgeSeconds).toBeNull();
    expect(parseCacheControl({ 'cache-control': 'max-age=abc' })?.maxAgeSeconds).toBeNull();
    expect(parseCacheControl({ 'cache-control': 'max-age=-5' })?.maxAgeSeconds).toBeNull();
  });

  it('must-revalidate 单独识别', () => {
    expect(parseCacheControl({ 'cache-control': 'public, max-age=10, must-revalidate' })).toEqual({
      maxAgeSeconds: 10,
      expiresAtMs: null,
      noStore: false,
      mustRevalidate: true,
    });
  });

  it('实测形态：只给 public，靠 Expires 传达到期时间', () => {
    const expires = 'Sun, 27 Sep 2026 14:39:59 GMT';
    const parsed = parseCacheControl({
      'cache-control': 'public',
      expires,
    });
    expect(parsed).toEqual({
      maxAgeSeconds: null,
      expiresAtMs: Date.parse(expires),
      noStore: false,
      mustRevalidate: false,
    });
  });

  it('Expires 非法或为 0 → expiresAtMs 为 null', () => {
    expect(parseCacheControl({ expires: 'not-a-date' })?.expiresAtMs).toBeNull();
    expect(parseCacheControl({ expires: '0' })?.expiresAtMs).toBeNull();
  });
});

describe('EsiClient 注入缓存指令', () => {
  it('200 响应解析 cacheControl', async () => {
    const http = createMockHttp();
    http.enqueue(
      jsonResponse(
        200,
        { players: 1, server_version: 'test', start_time: '2026-09-27T00:00:00Z' },
        { 'cache-control': 'public, max-age=5' },
      ),
    );
    const client = new EsiClient({ http });

    const result = await client.fetchStatus();

    expect(result.cacheControl).toEqual({
      maxAgeSeconds: 5,
      expiresAtMs: null,
      noStore: false,
      mustRevalidate: false,
    });
  });

  it('304 响应同样解析 cacheControl', async () => {
    const http = createMockHttp();
    http.enqueue(
      emptyResponse(304, { etag: 'W/"e1"', 'cache-control': 'public, max-age=7' }),
    );
    const client = new EsiClient({ http });

    const result = await client.fetchStatus({ etag: 'W/"e1"' });

    expect(result.notModified).toBe(true);
    expect(result.cacheControl?.maxAgeSeconds).toBe(7);
  });

  it('无该头时 cacheControl 为 null（不影响既有字段）', async () => {
    const http = createMockHttp();
    http.enqueue(jsonResponse(200, { players: 2, server_version: 'x', start_time: 't' }, { etag: 'W/"a"' }));
    const client = new EsiClient({ http });

    const result = await client.fetchStatus();

    expect(result.cacheControl).toBeNull();
    expect(result.etag).toBe('W/"a"');
  });
});
