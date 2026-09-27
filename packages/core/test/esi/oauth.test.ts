import { describe, expect, it } from 'vitest';

import type { HttpResponse } from '../../src/esi/http';
import {
  buildAuthorizeUrl,
  CHARACTER_SCOPES,
  exchangeCode,
  generatePkce,
  parseCharacterId,
  parseJwtPayload,
  parseTokenResponse,
  refreshAccessToken,
  SSO_TOKEN_ENDPOINT,
  type TokenHttp,
} from '../../src/esi/oauth';

/** 构造测试用 JWT（不校验签名，仅需三段结构） */
function makeJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}.sig`;
}

function createTokenHttp(status: number, body: unknown): { http: TokenHttp; sent: [string, Record<string, string>][] } {
  const sent: [string, Record<string, string>][] = [];
  return {
    sent,
    http: {
      async postForm(url, form): Promise<HttpResponse> {
        sent.push([url, { ...form }]);
        return {
          status,
          headers: { 'content-type': 'application/json' },
          text: typeof body === 'string' ? body : JSON.stringify(body),
        };
      },
    },
  };
}

describe('PKCE 与授权 URL', () => {
  it('生成 PKCE：verifier 为 43 字符，challenge 与之不同', async () => {
    const pkce = await generatePkce();
    expect(pkce.verifier).toHaveLength(43);
    expect(pkce.challenge).toHaveLength(43);
    expect(pkce.challenge).not.toBe(pkce.verifier);
  });

  it('PKCE 的 challenge 是 verifier 的 SHA-256（可复现）', async () => {
    // 固定随机源 → 结果可复现
    const fixed = new Uint8Array(32).fill(7);
    const first = await generatePkce(() => fixed);
    const second = await generatePkce(() => fixed);
    expect(first).toEqual(second);
  });

  it('授权 URL 含全部必需参数（S256 + state + 空格分隔的 scope）', () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: 'client-1',
        redirectUri: 'http://127.0.0.1:43210/callback',
        scopes: ['esi-assets.read_assets.v1', 'esi-wallet.read_character_wallet.v1'],
        state: 'state-abc',
        challenge: 'challenge-xyz',
      }),
    );

    expect(url.origin + url.pathname).toBe('https://login.eveonline.com/v2/oauth/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:43210/callback');
    expect(url.searchParams.get('scope')).toBe(
      'esi-assets.read_assets.v1 esi-wallet.read_character_wallet.v1',
    );
    expect(url.searchParams.get('state')).toBe('state-abc');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-xyz');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('个人数据 scope 覆盖方案文档要求的七类', () => {
    expect(CHARACTER_SCOPES).toContain('esi-assets.read_assets.v1');
    expect(CHARACTER_SCOPES).toContain('esi-wallet.read_character_wallet.v1');
    expect(CHARACTER_SCOPES).toContain('esi-contracts.read_character_contracts.v1');
    expect(CHARACTER_SCOPES).toContain('esi-markets.read_character_orders.v1');
    expect(CHARACTER_SCOPES).toContain('esi-industry.read_character_jobs.v1');
    expect(CHARACTER_SCOPES).toContain('esi-industry.read_character_mining.v1');
    expect(CHARACTER_SCOPES).toContain('esi-characters.read_loyalty.v1');
  });
});

describe('JWT 解析', () => {
  it('从 sub 提取角色 ID', () => {
    expect(parseCharacterId('CHARACTER:EVE:2112625428')).toBe(2112625428);
    expect(parseCharacterId('garbage')).toBeNull();
    expect(parseCharacterId(undefined)).toBeNull();
  });

  it('解析载荷中的角色名与 scopes', () => {
    const token = makeJwt({
      sub: 'CHARACTER:EVE:1234',
      name: 'Test Pilot',
      scp: ['esi-assets.read_assets.v1', 'esi-wallet.read_character_wallet.v1'],
    });
    const payload = parseJwtPayload(token);
    expect(payload?.name).toBe('Test Pilot');
    expect(payload?.scp).toEqual(['esi-assets.read_assets.v1', 'esi-wallet.read_character_wallet.v1']);
  });

  it('非法 JWT 返回 null', () => {
    expect(parseJwtPayload('not-a-jwt')).toBeNull();
    expect(parseJwtPayload('a.b.c')).toBeNull();
  });
});

describe('令牌交换与刷新', () => {
  it('授权码换令牌：POST 表单含 PKCE 校验串，解析出角色信息', async () => {
    const accessToken = makeJwt({
      sub: 'CHARACTER:EVE:2112625428',
      name: 'Test Pilot',
      scp: ['esi-assets.read_assets.v1'],
    });
    const { http, sent } = createTokenHttp(200, {
      access_token: accessToken,
      refresh_token: 'refresh-1',
      expires_in: 1200,
      token_type: 'Bearer',
    });

    const tokens = await exchangeCode(http, {
      clientId: 'client-1',
      code: 'auth-code',
      verifier: 'verifier-1',
      now: 1_000_000,
    });

    expect(sent[0][0]).toBe(SSO_TOKEN_ENDPOINT);
    expect(sent[0][1]).toEqual({
      grant_type: 'authorization_code',
      code: 'auth-code',
      client_id: 'client-1',
      code_verifier: 'verifier-1',
    });
    expect(tokens.refreshToken).toBe('refresh-1');
    expect(tokens.expiresAt).toBe(1_000_000 + 1_200_000);
    expect(tokens.characterId).toBe(2112625428);
    expect(tokens.characterName).toBe('Test Pilot');
    expect(tokens.scopes).toEqual(['esi-assets.read_assets.v1']);
  });

  it('刷新令牌：grant_type 为 refresh_token', async () => {
    const accessToken = makeJwt({ sub: 'CHARACTER:EVE:42', scp: 'esi-assets.read_assets.v1' });
    const { http, sent } = createTokenHttp(200, {
      access_token: accessToken,
      refresh_token: 'refresh-2',
      expires_in: 1200,
    });

    const tokens = await refreshAccessToken(http, {
      clientId: 'client-1',
      refreshToken: 'refresh-1',
      now: 2_000_000,
    });

    expect(sent[0][1]).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-1',
      client_id: 'client-1',
    });
    expect(tokens.refreshToken).toBe('refresh-2');
    expect(tokens.characterId).toBe(42);
    // scp 为空格分隔字符串时也能解析
    expect(tokens.scopes).toEqual(['esi-assets.read_assets.v1']);
  });

  it('HTTP 失败：抛出带状态码的错误', async () => {
    const { http } = createTokenHttp(400, { error: 'invalid_grant' });
    await expect(
      exchangeCode(http, { clientId: 'c', code: 'x', verifier: 'v' }),
    ).rejects.toThrow(/HTTP 400/);
  });

  it('响应缺少 access_token：抛错', () => {
    expect(() => parseTokenResponse('{"refresh_token":"r"}', 0)).toThrow(/access_token/);
  });

  it('非 JSON 响应：抛错', () => {
    expect(() => parseTokenResponse('<html>', 0)).toThrow(/合法 JSON/);
  });
});
