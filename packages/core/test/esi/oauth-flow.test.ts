import { describe, expect, it } from 'vitest';

import type { HttpResponse } from '../../src/esi/http';
import {
  DEFAULT_AUTH_TIMEOUT_MS,
  DEFAULT_REDIRECT_PATH,
  OAuthFlowError,
  runOAuthFlow,
  type CallbackPayload,
  type LoopbackServer,
} from '../../src/esi/oauth-flow';
import { OAUTH_LOOPBACK_PORT, SSO_TOKEN_ENDPOINT, type TokenHttp } from '../../src/esi/oauth';

/** 固定随机源：按请求长度填充，保证 PKCE/state 可复现且互不相同 */
const fixedRandom = (length: number): Uint8Array => new Uint8Array(length).fill(9);

/** 与 generateState(fixedRandom) 的结果一致 */
const EXPECTED_STATE = Buffer.from(new Uint8Array(16).fill(9)).toString('base64url');

function makeJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}.sig`;
}

interface FakeLoopback {
  server: LoopbackServer;
  /** openBrowser 收到的授权 URL */
  opened: string[];
  /** prepare 收到的监听端口 */
  preparedPorts: number[];
  /** prepare 收到的回调路径 */
  preparedPaths: string[];
  /** waitCallback 收到的超时值 */
  timeouts: number[];
  cancels: number;
}

/** 构造假回环服务：prepare 原样回显端口与路径，waitCallback 返回预置回调或抛错 */
function createFakeLoopback(result: CallbackPayload | Error): FakeLoopback {
  const fake: FakeLoopback = {
    server: {} as LoopbackServer,
    opened: [],
    preparedPorts: [],
    preparedPaths: [],
    timeouts: [],
    cancels: 0,
  };

  fake.server = {
    async prepare(port: number, redirectPath: string) {
      fake.preparedPorts.push(port);
      fake.preparedPaths.push(redirectPath);
      return { port, redirectUri: `http://127.0.0.1:${port}${redirectPath}` };
    },
    async openBrowser(url: string) {
      fake.opened.push(url);
    },
    async waitCallback(timeoutMs: number) {
      fake.timeouts.push(timeoutMs);
      if (result instanceof Error) throw result;
      return result;
    },
    async cancel() {
      fake.cancels += 1;
    },
  };

  return fake;
}

function createTokenHttp(status: number, body: unknown): { http: TokenHttp; sent: Record<string, string>[] } {
  const sent: Record<string, string>[] = [];
  return {
    sent,
    http: {
      async postForm(url: string, form: Readonly<Record<string, string>>): Promise<HttpResponse> {
        expect(url).toBe(SSO_TOKEN_ENDPOINT);
        sent.push({ ...form });
        return {
          status,
          headers: { 'content-type': 'application/json' },
          text: typeof body === 'string' ? body : JSON.stringify(body),
        };
      },
    },
  };
}

const successCallback = (state: string): CallbackPayload => ({
  code: 'CODE-1',
  state,
  error: null,
  errorDescription: null,
});

describe('授权流程编排', () => {
  it('成功路径：prepare → 打开授权页 → 校验 state → 换令牌', async () => {
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
    const loopback = createFakeLoopback(successCallback(EXPECTED_STATE));

    const tokens = await runOAuthFlow({
      clientId: 'client-1',
      scopes: ['esi-assets.read_assets.v1', 'esi-wallet.read_character_wallet.v1'],
      tokenHttp: http,
      loopback: loopback.server,
      randomBytes: fixedRandom,
      now: () => 1_000_000,
    });

    expect(tokens.refreshToken).toBe('refresh-1');
    expect(tokens.expiresAt).toBe(1_000_000 + 1_200_000);
    expect(tokens.characterId).toBe(2112625428);
    expect(tokens.characterName).toBe('Test Pilot');

    // 回环：默认端口与回调路径，成功路径不应取消
    expect(loopback.preparedPorts).toEqual([OAUTH_LOOPBACK_PORT]);
    expect(loopback.preparedPaths).toEqual([DEFAULT_REDIRECT_PATH]);
    expect(loopback.cancels).toBe(0);

    // 授权 URL 携带固定端口回调地址、state 与 S256 挑战
    expect(loopback.opened).toHaveLength(1);
    const url = new URL(loopback.opened[0]);
    expect(url.origin + url.pathname).toBe('https://login.eveonline.com/v2/oauth/authorize');
    expect(url.searchParams.get('redirect_uri')).toBe(
      `http://127.0.0.1:${OAUTH_LOOPBACK_PORT}/callback`,
    );
    expect(url.searchParams.get('state')).toBe(EXPECTED_STATE);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).not.toBeNull();
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('scope')).toBe(
      'esi-assets.read_assets.v1 esi-wallet.read_character_wallet.v1',
    );

    // 令牌交换带上授权码与 PKCE 校验串
    expect(sent[0].grant_type).toBe('authorization_code');
    expect(sent[0].code).toBe('CODE-1');
    expect(sent[0].code_verifier).not.toBe('');
    expect(sent[0].client_id).toBe('client-1');
  });

  it('自定义回调路径、端口与超时会透传给回环服务', async () => {
    const { http } = createTokenHttp(200, {
      access_token: makeJwt({ sub: 'CHARACTER:EVE:1' }),
      refresh_token: 'r',
      expires_in: 1200,
    });
    const loopback = createFakeLoopback(successCallback(EXPECTED_STATE));

    await runOAuthFlow({
      clientId: 'c',
      scopes: [],
      tokenHttp: http,
      loopback: loopback.server,
      redirectPath: '/cb',
      loopbackPort: 23456,
      timeoutMs: 1234,
      randomBytes: fixedRandom,
    });

    expect(loopback.preparedPorts).toEqual([23456]);
    expect(loopback.preparedPaths).toEqual(['/cb']);
    expect(loopback.timeouts).toEqual([1234]);
    const url = new URL(loopback.opened[0]);
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:23456/cb');
  });

  it('默认超时为 5 分钟', async () => {
    const { http } = createTokenHttp(200, {
      access_token: makeJwt({ sub: 'CHARACTER:EVE:1' }),
      refresh_token: 'r',
      expires_in: 1200,
    });
    const loopback = createFakeLoopback(successCallback(EXPECTED_STATE));

    await runOAuthFlow({
      clientId: 'c',
      scopes: [],
      tokenHttp: http,
      loopback: loopback.server,
      randomBytes: fixedRandom,
    });

    expect(loopback.timeouts).toEqual([DEFAULT_AUTH_TIMEOUT_MS]);
    expect(DEFAULT_AUTH_TIMEOUT_MS).toBe(5 * 60 * 1000);
  });

  it('state 不一致：拒绝并释放端口，不请求令牌', async () => {
    const { http, sent } = createTokenHttp(200, {});
    const loopback = createFakeLoopback(successCallback('OTHER-STATE'));

    await expect(
      runOAuthFlow({
        clientId: 'c',
        scopes: [],
        tokenHttp: http,
        loopback: loopback.server,
        randomBytes: fixedRandom,
      }),
    ).rejects.toMatchObject({ kind: 'state_mismatch' });

    expect(sent).toHaveLength(0);
    expect(loopback.cancels).toBe(1);
  });

  it('用户拒绝授权（access_denied）：归类为 denied 并释放端口', async () => {
    const { http, sent } = createTokenHttp(200, {});
    const loopback = createFakeLoopback({
      code: null,
      state: null,
      error: 'access_denied',
      errorDescription: 'User denied access',
    });

    const error = await runOAuthFlow({
      clientId: 'c',
      scopes: [],
      tokenHttp: http,
      loopback: loopback.server,
      randomBytes: fixedRandom,
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(OAuthFlowError);
    expect((error as OAuthFlowError).kind).toBe('denied');
    expect(sent).toHaveLength(0);
    expect(loopback.cancels).toBe(1);
  });

  it('其他回调错误：归类为 callback_error 并带原因', async () => {
    const { http } = createTokenHttp(200, {});
    const loopback = createFakeLoopback({
      code: null,
      state: null,
      error: 'invalid_request',
      errorDescription: 'bad scope',
    });

    const error = await runOAuthFlow({
      clientId: 'c',
      scopes: [],
      tokenHttp: http,
      loopback: loopback.server,
      randomBytes: fixedRandom,
    }).catch((reason: unknown) => reason);

    expect((error as OAuthFlowError).kind).toBe('callback_error');
    expect((error as Error).message).toContain('invalid_request');
    expect((error as Error).message).toContain('bad scope');
  });

  it('回调无授权码：归类为 missing_code 并释放端口', async () => {
    const { http } = createTokenHttp(200, {});
    const loopback = createFakeLoopback({
      code: null,
      state: EXPECTED_STATE,
      error: null,
      errorDescription: null,
    });

    await expect(
      runOAuthFlow({
        clientId: 'c',
        scopes: [],
        tokenHttp: http,
        loopback: loopback.server,
        randomBytes: fixedRandom,
      }),
    ).rejects.toMatchObject({ kind: 'missing_code' });

    expect(loopback.cancels).toBe(1);
  });

  it('等待回调超时（宿主抛错）：向上传播并释放端口', async () => {
    const { http } = createTokenHttp(200, {});
    const loopback = createFakeLoopback(new Error('授权超时（100 毫秒），已释放本地回环端口'));

    await expect(
      runOAuthFlow({
        clientId: 'c',
        scopes: [],
        tokenHttp: http,
        loopback: loopback.server,
        timeoutMs: 100,
        randomBytes: fixedRandom,
      }),
    ).rejects.toThrow(/超时/);

    expect(loopback.cancels).toBe(1);
  });

  it('令牌端点失败：向调用方抛错且释放端口', async () => {
    const { http } = createTokenHttp(400, { error: 'invalid_grant' });
    const loopback = createFakeLoopback(successCallback(EXPECTED_STATE));

    await expect(
      runOAuthFlow({
        clientId: 'c',
        scopes: [],
        tokenHttp: http,
        loopback: loopback.server,
        randomBytes: fixedRandom,
      }),
    ).rejects.toThrow(/HTTP 400/);

    expect(loopback.cancels).toBe(1);
  });
});
