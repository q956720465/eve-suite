import { describe, expect, it } from 'vitest';

import { EsiClient, type EsiAuthProvider } from '../../src/esi/client';
import { emptyResponse, createMockHttp, jsonResponse } from '../helpers/mock-http';
import { TokenManagerError } from '../../src/esi/token-manager';

const CHARACTER_ID = 2112625428;
const WALLET_PATH = `/characters/${CHARACTER_ID}/wallet/`;

interface FakeAuth extends EsiAuthProvider {
  /** getAccessToken 收到的角色 ID（按调用顺序） */
  readonly calls: number[];
  /** invalidate 收到的角色 ID */
  readonly invalidated: number[];
}

/** 假认证能力：按序返回预置令牌（耗尽后复用最后一个） */
function createFakeAuth(tokens: string | readonly string[]): FakeAuth {
  const queue = typeof tokens === 'string' ? [tokens] : [...tokens];
  const calls: number[] = [];
  const invalidated: number[] = [];
  let index = 0;

  return {
    calls,
    invalidated,
    async getAccessToken(characterId: number): Promise<string> {
      calls.push(characterId);
      const value = queue[Math.min(index, queue.length - 1)];
      index += 1;
      return value;
    },
    invalidate(characterId: number): void {
      invalidated.push(characterId);
    },
  };
}

describe('EsiClient 认证请求', () => {
  it('fetchAuthenticated 注入 Bearer 并拼接 ESI 路径', async () => {
    const http = createMockHttp();
    http.enqueue(jsonResponse(200, { balance: 123 }));
    const auth = createFakeAuth('access-1');
    const client = new EsiClient({ http, auth });

    const result = await client.fetchAuthenticated<{ balance: number }>(WALLET_PATH, CHARACTER_ID);

    expect(http.calls).toHaveLength(1);
    expect(http.calls[0].url).toBe(`https://esi.evetech.net/latest${WALLET_PATH}`);
    expect(http.calls[0].bearerToken).toBe('access-1');
    expect(auth.calls).toEqual([CHARACTER_ID]);
    expect(result.data).toEqual({ balance: 123 });
  });

  it('路径缺少前导斜杠时自动补齐', async () => {
    const http = createMockHttp();
    http.enqueue(jsonResponse(200, []));
    const client = new EsiClient({ http, auth: createFakeAuth('access-1') });

    await client.fetchAuthenticated(`characters/${CHARACTER_ID}/assets/`, CHARACTER_ID);

    expect(http.calls[0].url).toBe(`https://esi.evetech.net/latest/characters/${CHARACTER_ID}/assets/`);
  });

  it('公开请求不带 Bearer，也不调用认证能力', async () => {
    const http = createMockHttp();
    http.enqueue(jsonResponse(200, { players: 1 }));
    const auth = createFakeAuth('access-1');
    const client = new EsiClient({ http, auth });

    await client.fetchStatus();

    expect(http.calls[0].bearerToken).toBeUndefined();
    expect(auth.calls).toEqual([]);
    expect(auth.invalidated).toEqual([]);
  });

  it('未配置 auth 却请求认证端点：报用法错误且不发请求', async () => {
    const http = createMockHttp();
    const client = new EsiClient({ http });

    await expect(client.fetchAuthenticated(WALLET_PATH, CHARACTER_ID)).rejects.toMatchObject({
      kind: 'client',
      status: null,
    });
    expect(http.calls).toHaveLength(0);
  });

  it('认证请求仍支持 ETag 条件请求', async () => {
    const http = createMockHttp();
    http.enqueue(emptyResponse(304, { etag: 'W/"etag-9"' }));
    const client = new EsiClient({ http, auth: createFakeAuth('access-1') });

    const result = await client.fetchAuthenticated(WALLET_PATH, CHARACTER_ID, { etag: 'W/"etag-9"' });

    expect(http.calls[0].ifNoneMatch).toBe('W/"etag-9"');
    expect(http.calls[0].bearerToken).toBe('access-1');
    expect(result.notModified).toBe(true);
  });
});

describe('EsiClient 401 自动刷新重试', () => {
  it('401 后丢弃内存令牌并重试一次成功', async () => {
    const http = createMockHttp();
    http.enqueue(emptyResponse(401));
    http.enqueue(jsonResponse(200, { balance: 456 }));
    const auth = createFakeAuth(['stale-token', 'fresh-token']);
    const client = new EsiClient({ http, auth });

    const result = await client.fetchAuthenticated<{ balance: number }>(WALLET_PATH, CHARACTER_ID);

    expect(result.data).toEqual({ balance: 456 });
    expect(http.calls).toHaveLength(2);
    expect(http.calls[0].bearerToken).toBe('stale-token');
    expect(http.calls[1].bearerToken).toBe('fresh-token');
    expect(auth.invalidated).toEqual([CHARACTER_ID]);
  });

  it('连续 401 只重试一次，最终抛出 client 错误', async () => {
    const http = createMockHttp();
    http.enqueue(emptyResponse(401));
    http.enqueue(emptyResponse(401));
    const auth = createFakeAuth(['stale-token', 'still-bad-token']);
    const client = new EsiClient({ http, auth });

    await expect(client.fetchAuthenticated(WALLET_PATH, CHARACTER_ID)).rejects.toMatchObject({
      kind: 'client',
      status: 401,
    });
    expect(http.calls).toHaveLength(2);
    expect(auth.calls).toEqual([CHARACTER_ID, CHARACTER_ID]);
  });

  it('公开请求收到 401 不触发刷新重试', async () => {
    const http = createMockHttp();
    http.enqueue(emptyResponse(401));
    const auth = createFakeAuth('access-1');
    const client = new EsiClient({ http, auth });

    await expect(client.fetchStatus()).rejects.toMatchObject({ kind: 'client', status: 401 });
    expect(http.calls).toHaveLength(1);
    expect(auth.calls).toEqual([]);
    expect(auth.invalidated).toEqual([]);
  });
});

describe('EsiClient 认证错误传播', () => {
  it('认证能力抛出的错误原样穿透，不被包装成 EsiError', async () => {
    const http = createMockHttp();
    const auth: EsiAuthProvider = {
      async getAccessToken(): Promise<string> {
        throw new TokenManagerError('reauth_required', '刷新令牌已失效，需要重新授权');
      },
      invalidate(): void {},
    };
    const client = new EsiClient({ http, auth });

    const error = await client.fetchAuthenticated(WALLET_PATH, CHARACTER_ID).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(TokenManagerError);
    expect((error as TokenManagerError).kind).toBe('reauth_required');
    expect(http.calls).toHaveLength(0);
  });
});
