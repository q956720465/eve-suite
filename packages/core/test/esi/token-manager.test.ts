import { describe, expect, it } from 'vitest';

import type { HttpResponse } from '../../src/esi/http';
import { SSO_TOKEN_ENDPOINT, type TokenHttp, type TokenSet } from '../../src/esi/oauth';
import { OAuthTokenStore, refreshTokenAccount, type SecretStore } from '../../src/esi/secret-store';
import { DEFAULT_REFRESH_SKEW_MS, TokenManager } from '../../src/esi/token-manager';

const NOW = 1_700_000_000_000;
const CHARACTER_ID = 2112625428;

/** 构造测试用 JWT（令牌端点响应里的 access_token 需为三段结构） */
function makeJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}.sig`;
}

/** 构造令牌端点的成功响应 */
function tokenResponse(characterId: number, refreshToken: string, accessToken?: string): HttpResponse {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    text: JSON.stringify({
      access_token: accessToken ?? makeJwt({ sub: `CHARACTER:EVE:${characterId}`, name: 'Pilot' }),
      refresh_token: refreshToken,
      expires_in: 1200,
      token_type: 'Bearer',
    }),
  };
}

function errorResponse(status: number, body: unknown): HttpResponse {
  return { status, headers: { 'content-type': 'application/json' }, text: JSON.stringify(body) };
}

type Handler = () => Promise<HttpResponse> | HttpResponse;

/** 假令牌端点：记录请求体，可切换处理函数（用于挂起/失败场景） */
function createTokenHttp(): {
  http: TokenHttp;
  calls: Record<string, string>[];
  setHandler: (handler: Handler) => void;
} {
  const calls: Record<string, string>[] = [];
  let handler: Handler = () => errorResponse(500, { error: 'unexpected' });

  return {
    calls,
    setHandler(next: Handler): void {
      handler = next;
    },
    http: {
      async postForm(url: string, body: Readonly<Record<string, string>>): Promise<HttpResponse> {
        expect(url).toBe(SSO_TOKEN_ENDPOINT);
        calls.push({ ...body });
        return await handler();
      },
    },
  };
}

/** 假钥匙串（内存 Map） */
function createFakeSecrets(): { store: OAuthTokenStore; entries: Map<string, string> } {
  const entries = new Map<string, string>();
  const secrets: SecretStore = {
    async set(account, secret) {
      entries.set(account, secret);
    },
    async get(account) {
      return entries.get(account) ?? null;
    },
    async delete(account) {
      entries.delete(account);
    },
  };
  return { store: new OAuthTokenStore(secrets), entries };
}

function tokens(options: {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  characterId?: number | null;
}): TokenSet {
  return {
    accessToken: options.accessToken,
    refreshToken: options.refreshToken,
    expiresAt: options.expiresAt,
    tokenType: 'Bearer',
    characterId: options.characterId === undefined ? CHARACTER_ID : options.characterId,
    characterName: 'Pilot',
    scopes: [],
  };
}

function createManager(): ReturnType<typeof createFakeSecrets> & {
  tokenHttp: ReturnType<typeof createTokenHttp>;
  manager: TokenManager;
} {
  const { store, entries } = createFakeSecrets();
  const tokenHttp = createTokenHttp();
  const manager = new TokenManager({
    clientId: 'client-1',
    tokenHttp: tokenHttp.http,
    store,
    now: () => NOW,
  });
  return { store, entries, tokenHttp, manager };
}

describe('TokenManager 会话与临期刷新', () => {
  it('登录令牌写入钥匙串；内存令牌未临期时不刷新', async () => {
    const { entries, tokenHttp, manager } = createManager();

    await manager.setInitialTokens(
      tokens({ accessToken: 'access-initial', refreshToken: 'refresh-initial', expiresAt: NOW + 1_200_000 }),
    );

    expect(entries.get(refreshTokenAccount(CHARACTER_ID))).toBe('refresh-initial');
    await expect(manager.getAccessToken(CHARACTER_ID)).resolves.toBe('access-initial');
    expect(tokenHttp.calls).toHaveLength(0);
  });

  it('剩余有效期等于提前窗口时视为临期，触发刷新', async () => {
    const { tokenHttp, manager } = createManager();
    const rotated = makeJwt({ sub: `CHARACTER:EVE:${CHARACTER_ID}`, v: 2 });
    tokenHttp.setHandler(() => tokenResponse(CHARACTER_ID, 'refresh-rotated', rotated));

    await manager.setInitialTokens(
      tokens({ accessToken: 'access-initial', refreshToken: 'refresh-initial', expiresAt: NOW + DEFAULT_REFRESH_SKEW_MS }),
    );

    await expect(manager.getAccessToken(CHARACTER_ID)).resolves.toBe(rotated);
    expect(tokenHttp.calls).toHaveLength(1);
  });

  it('剩余有效期略高于提前窗口时不刷新', async () => {
    const { tokenHttp, manager } = createManager();
    await manager.setInitialTokens(
      tokens({
        accessToken: 'access-initial',
        refreshToken: 'refresh-initial',
        expiresAt: NOW + DEFAULT_REFRESH_SKEW_MS + 1,
      }),
    );

    await expect(manager.getAccessToken(CHARACTER_ID)).resolves.toBe('access-initial');
    expect(tokenHttp.calls).toHaveLength(0);
  });

  it('刷新请求使用钥匙串里的刷新令牌，并把轮换后的新令牌回写', async () => {
    const { entries, tokenHttp, manager } = createManager();
    const rotated = makeJwt({ sub: `CHARACTER:EVE:${CHARACTER_ID}`, v: 2 });
    tokenHttp.setHandler(() => tokenResponse(CHARACTER_ID, 'refresh-rotated', rotated));

    await manager.setInitialTokens(
      tokens({ accessToken: 'access-initial', refreshToken: 'refresh-initial', expiresAt: NOW }),
    );

    await expect(manager.getAccessToken(CHARACTER_ID)).resolves.toBe(rotated);
    expect(tokenHttp.calls[0]).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-initial',
      client_id: 'client-1',
    });
    expect(entries.get(refreshTokenAccount(CHARACTER_ID))).toBe('refresh-rotated');
  });

  it('单飞：并发取令牌只触发一次刷新', async () => {
    const { entries, tokenHttp, manager } = createManager();
    const rotated = makeJwt({ sub: `CHARACTER:EVE:${CHARACTER_ID}`, v: 2 });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    tokenHttp.setHandler(async () => {
      await gate;
      return tokenResponse(CHARACTER_ID, 'refresh-rotated', rotated);
    });

    await manager.setInitialTokens(
      tokens({ accessToken: 'access-initial', refreshToken: 'refresh-initial', expiresAt: NOW }),
    );

    const pending = [
      manager.getAccessToken(CHARACTER_ID),
      manager.getAccessToken(CHARACTER_ID),
      manager.getAccessToken(CHARACTER_ID),
    ];
    release();

    await expect(Promise.all(pending)).resolves.toEqual([rotated, rotated, rotated]);
    expect(tokenHttp.calls).toHaveLength(1);
    expect(entries.get(refreshTokenAccount(CHARACTER_ID))).toBe('refresh-rotated');
  });

  it('invalidate 后强制刷新（即使内存令牌仍未过期）', async () => {
    const { tokenHttp, manager } = createManager();
    const refreshed = makeJwt({ sub: `CHARACTER:EVE:${CHARACTER_ID}`, v: 2 });
    tokenHttp.setHandler(() => tokenResponse(CHARACTER_ID, 'refresh-rotated', refreshed));

    await manager.setInitialTokens(
      tokens({ accessToken: 'access-initial', refreshToken: 'refresh-initial', expiresAt: NOW + 1_200_000 }),
    );
    manager.invalidate(CHARACTER_ID);

    await expect(manager.getAccessToken(CHARACTER_ID)).resolves.toBe(refreshed);
    expect(tokenHttp.calls).toHaveLength(1);
  });

  it('clear 后重新从钥匙串取令牌', async () => {
    const { tokenHttp, manager } = createManager();
    const refreshed = makeJwt({ sub: `CHARACTER:EVE:${CHARACTER_ID}`, v: 2 });
    tokenHttp.setHandler(() => tokenResponse(CHARACTER_ID, 'refresh-rotated', refreshed));

    await manager.setInitialTokens(
      tokens({ accessToken: 'access-initial', refreshToken: 'refresh-initial', expiresAt: NOW + 1_200_000 }),
    );
    manager.clear(CHARACTER_ID);

    await expect(manager.getAccessToken(CHARACTER_ID)).resolves.toBe(refreshed);
    expect(tokenHttp.calls).toHaveLength(1);
  });
});

describe('TokenManager 失败与边界', () => {
  it('钥匙串无刷新令牌：no_refresh_token', async () => {
    const { tokenHttp, manager } = createManager();
    await expect(manager.getAccessToken(CHARACTER_ID)).rejects.toMatchObject({
      kind: 'no_refresh_token',
    });
    expect(tokenHttp.calls).toHaveLength(0);
  });

  it('invalid_grant：清除钥匙串条目并提示重新授权', async () => {
    const { entries, tokenHttp, manager } = createManager();
    entries.set(refreshTokenAccount(CHARACTER_ID), 'dead-refresh');
    tokenHttp.setHandler(() => errorResponse(400, { error: 'invalid_grant' }));

    await expect(manager.getAccessToken(CHARACTER_ID)).rejects.toMatchObject({
      kind: 'reauth_required',
    });
    expect(entries.has(refreshTokenAccount(CHARACTER_ID))).toBe(false);
  });

  it('瞬时故障：保留钥匙串条目并抛 refresh_failed', async () => {
    const { entries, tokenHttp, manager } = createManager();
    entries.set(refreshTokenAccount(CHARACTER_ID), 'refresh-stored');
    tokenHttp.setHandler(() => errorResponse(500, { error: 'server_error' }));

    await expect(manager.getAccessToken(CHARACTER_ID)).rejects.toMatchObject({
      kind: 'refresh_failed',
    });
    // 仍保留条目，稍后可重试
    expect(entries.get(refreshTokenAccount(CHARACTER_ID))).toBe('refresh-stored');
  });

  it('网络异常：归类为 refresh_failed 并保留条目', async () => {
    const { entries, tokenHttp, manager } = createManager();
    entries.set(refreshTokenAccount(CHARACTER_ID), 'refresh-stored');
    tokenHttp.setHandler(() => {
      throw new Error('网络不可达');
    });

    await expect(manager.getAccessToken(CHARACTER_ID)).rejects.toMatchObject({
      kind: 'refresh_failed',
    });
    expect(entries.get(refreshTokenAccount(CHARACTER_ID))).toBe('refresh-stored');
  });

  it('刷新返回的角色 ID 不一致：拒绝且不回写', async () => {
    const { entries, tokenHttp, manager } = createManager();
    entries.set(refreshTokenAccount(CHARACTER_ID), 'refresh-stored');
    tokenHttp.setHandler(() => tokenResponse(999, 'refresh-other'));

    await expect(manager.getAccessToken(CHARACTER_ID)).rejects.toMatchObject({
      kind: 'refresh_failed',
    });
    expect(entries.get(refreshTokenAccount(CHARACTER_ID))).toBe('refresh-stored');
  });

  it('登录令牌缺少刷新令牌或角色 ID：明确报错', async () => {
    const { manager } = createManager();

    await expect(
      manager.setInitialTokens(
        tokens({ accessToken: 'a', refreshToken: '', expiresAt: NOW + 1_200_000 }),
      ),
    ).rejects.toMatchObject({ kind: 'no_refresh_token' });

    await expect(
      manager.setInitialTokens(
        tokens({
          accessToken: 'a',
          refreshToken: 'r',
          expiresAt: NOW + 1_200_000,
          characterId: null,
        }),
      ),
    ).rejects.toMatchObject({ kind: 'unknown_character' });
  });
});
