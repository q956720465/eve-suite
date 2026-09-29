import type { HttpResponse } from './http';

/** EVE SSO 端点（取自 OIDC discovery 文档实测） */
export const SSO_ISSUER = 'https://login.eveonline.com';

/**
 * 应用内置的公开 client_id（EVE SSO「Native/Desktop」应用标识，**非机密**）。
 * 采用 PKCE 流程，因此不需要也不应内置 client_secret。
 */
export const EVE_CLIENT_ID = 'f08a568e43694797ac48637012682c1a';
export const SSO_AUTHORIZE_ENDPOINT = `${SSO_ISSUER}/v2/oauth/authorize`;
export const SSO_TOKEN_ENDPOINT = `${SSO_ISSUER}/v2/oauth/token`;
export const SSO_VERIFY_ENDPOINT = `${SSO_ISSUER}/oauth/verify`;
export const SSO_REVOKE_ENDPOINT = `${SSO_ISSUER}/v2/oauth/revoke`;

/**
 * 本地回环监听的**固定**端口（P3-8 实测：EVE SSO 要求回调地址与 CCP 后台注册值
 * 完全一致——含端口与路径，不采纳 RFC 8252 的回环动态端口豁免，随机端口会被拒
 * `invalid_request: The redirect URL does not match...`）。
 * CCP 后台注册的回调地址必须精确为 `http://127.0.0.1:14565/callback`。
 */
export const OAUTH_LOOPBACK_PORT = 14565;

/** 个人数据所需 scopes（方案文档 §4.3） */
export const CHARACTER_SCOPES: readonly string[] = [
  'esi-assets.read_assets.v1',
  'esi-wallet.read_character_wallet.v1',
  'esi-contracts.read_character_contracts.v1',
  'esi-markets.read_character_orders.v1',
  'esi-industry.read_character_jobs.v1',
  'esi-industry.read_character_mining.v1',
  // 注意：忠诚点 scope 归属 esi-characters 组（ESI 规范中不存在 esi-loyalty.*）
  'esi-characters.read_loyalty.v1',
];

export interface PkcePair {
  /** 随机验证串（仅本地保留） */
  verifier: string;
  /** 派生出的挑战值（随授权请求发送） */
  challenge: string;
}

export interface AuthorizeUrlParams {
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  /** 防 CSRF 的随机串，回调需原样返回 */
  state: string;
  challenge: string;
}

/** 授权令牌集合 */
export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** 访问令牌过期时间（epoch 毫秒） */
  expiresAt: number;
  tokenType: string;
  characterId: number | null;
  characterName: string | null;
  scopes: string[];
}

/** 令牌端点的 HTTP 能力（注入以便测试） */
export interface TokenHttp {
  postForm(url: string, body: Readonly<Record<string, string>>): Promise<HttpResponse>;
}

/** 令牌端点返回错误时的结构化异常（区分 invalid_grant 与瞬时故障） */
export class TokenRequestError extends Error {
  constructor(
    readonly status: number,
    /** 令牌端点返回的 `error` 字段（如 `invalid_grant`）；无法解析时为 null */
    readonly oauthError: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'TokenRequestError';
  }
}

/** 生成 PKCE 对（S256）；随机源可注入以便测试 */
export async function generatePkce(
  randomBytes: (length: number) => Uint8Array = defaultRandomBytes,
): Promise<PkcePair> {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(await sha256(verifier));
  return { verifier, challenge };
}

/** 生成授权 state（防 CSRF，回调需原样返回）；随机源可注入以便测试 */
export function generateState(
  randomBytes: (length: number) => Uint8Array = defaultRandomBytes,
): string {
  return base64Url(randomBytes(16));
}

/** 构造授权 URL（用户在系统浏览器中打开） */
export function buildAuthorizeUrl(params: AuthorizeUrlParams): string {
  const url = new URL(SSO_AUTHORIZE_ENDPOINT);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('scope', params.scopes.join(' '));
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/** 用授权码换取令牌（PKCE，无需 client_secret） */
export async function exchangeCode(
  http: TokenHttp,
  params: { clientId: string; code: string; verifier: string; now?: number },
): Promise<TokenSet> {
  return requestToken(http, {
    grant_type: 'authorization_code',
    code: params.code,
    client_id: params.clientId,
    code_verifier: params.verifier,
    now: params.now,
  });
}

/** 用刷新令牌换取新的访问令牌 */
export async function refreshAccessToken(
  http: TokenHttp,
  params: { clientId: string; refreshToken: string; now?: number },
): Promise<TokenSet> {
  return requestToken(http, {
    grant_type: 'refresh_token',
    refresh_token: params.refreshToken,
    client_id: params.clientId,
    now: params.now,
  });
}

/** 撤销令牌的参数（RFC 7009 令牌撤销） */
export interface RevokeTokenParams {
  clientId: string;
  /** 待撤销的令牌（本项目为刷新令牌） */
  token: string;
  /** 令牌类型提示，默认 `refresh_token` */
  tokenTypeHint?: 'refresh_token' | 'access_token';
}

/** 撤销结果；`invalid_grant` 表示服务端认定该令牌本已失效（同样无需再撤销） */
export type RevokeOutcome = 'revoked' | 'invalid_grant';

/**
 * 撤销令牌（RFC 7009）——登出时让远端刷新令牌立即失效，
 * 否则它仍可继续换取新的访问令牌（本地删掉条目并不影响远端）。
 *
 * 响应口径（2026-09-29 对真实 SSO 实测）：**未知/无效令牌返回 200**（RFC 7009 规定
 * 服务端不得因令牌无效而报错），故：
 * - 2xx → `revoked`（涵盖「刚撤销」与「本就已失效」两种情形）
 * - 非 2xx 且响应体 `error = invalid_grant` → 返回 `invalid_grant`（不抛错，调用方同样视为完成）
 * - 其它非 2xx（网络外的协议/服务端错误）→ 抛 `TokenRequestError`，由调用方按 best-effort 处理
 *
 * 公共客户端（PKCE）在表单里带 `client_id` 鉴权，无需 client_secret。
 */
export async function revokeToken(
  http: TokenHttp,
  params: RevokeTokenParams,
): Promise<RevokeOutcome> {
  const response = await http.postForm(SSO_REVOKE_ENDPOINT, {
    token: params.token,
    token_type_hint: params.tokenTypeHint ?? 'refresh_token',
    client_id: params.clientId,
  });

  if (response.status >= 200 && response.status < 300) return 'revoked';
  const oauthError = parseOAuthError(response.text);
  if (oauthError === 'invalid_grant') return 'invalid_grant';
  throw new TokenRequestError(
    response.status,
    oauthError,
    `撤销令牌失败：HTTP ${response.status} ${response.text.slice(0, 200)}`,
  );
}

/** 解析令牌响应体（含 JWT 载荷中的角色信息） */
export function parseTokenResponse(text: string, nowMs: number): TokenSet {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`令牌响应不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }

  const accessToken = readString(payload, 'access_token');
  const refreshToken = readString(payload, 'refresh_token');
  if (accessToken === null) {
    throw new Error('令牌响应缺少 access_token');
  }

  const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 1200;
  const claims = parseJwtPayload(accessToken) ?? {};

  return {
    accessToken,
    refreshToken: refreshToken ?? '',
    expiresAt: nowMs + expiresIn * 1000,
    tokenType: readString(payload, 'token_type') ?? 'Bearer',
    characterId: parseCharacterId(claims.sub),
    characterName: typeof claims.name === 'string' ? claims.name : null,
    scopes: parseScopes(claims.scp),
  };
}

/** 解析 JWT 载荷（不校验签名，仅用于读取 sub/name/scp） */
export function parseJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(base64UrlDecode(parts[1])) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 从 `CHARACTER:EVE:2112625428` 形式的 sub 提取角色 ID */
export function parseCharacterId(subject: unknown): number | null {
  if (typeof subject !== 'string') return null;
  const match = /CHARACTER:EVE:(\d+)/.exec(subject);
  return match === null ? null : Number(match[1]);
}

async function requestToken(
  http: TokenHttp,
  form: Record<string, string | number | undefined>,
): Promise<TokenSet> {
  const body: Record<string, string> = {};
  for (const [key, value] of Object.entries(form)) {
    if (key !== 'now' && value !== undefined) {
      body[key] = String(value);
    }
  }
  const nowMs = typeof form.now === 'number' ? form.now : Date.now();

  const response = await http.postForm(SSO_TOKEN_ENDPOINT, body);
  if (response.status < 200 || response.status >= 300) {
    throw new TokenRequestError(
      response.status,
      parseOAuthError(response.text),
      `令牌请求失败：HTTP ${response.status} ${response.text.slice(0, 200)}`,
    );
  }
  return parseTokenResponse(response.text, nowMs);
}

/** 从令牌端点的错误响应体中提取 `error` 字段（如 `invalid_grant`） */
export function parseOAuthError(text: string): string | null {
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    const error = payload.error;
    return typeof error === 'string' && error.length > 0 ? error : null;
  } catch {
    return null;
  }
}

function parseScopes(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (typeof value === 'string') {
    return value.split(' ').filter((item) => item.length > 0);
  }
  return [];
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function sha256(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return new Uint8Array(digest);
}

function defaultRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return atob(padded + pad);
}
