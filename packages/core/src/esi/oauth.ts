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

/** 个人数据所需 scopes（方案文档 §4.3） */
export const CHARACTER_SCOPES: readonly string[] = [
  'esi-assets.read_assets.v1',
  'esi-wallet.read_character_wallet.v1',
  'esi-contracts.read_character_contracts.v1',
  'esi-markets.read_character_orders.v1',
  'esi-industry.read_character_jobs.v1',
  'esi-industry.read_character_mining.v1',
  'esi-loyalty.read_loyalty_points.v1',
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
    throw new Error(`令牌请求失败：HTTP ${response.status} ${response.text.slice(0, 200)}`);
  }
  return parseTokenResponse(response.text, nowMs);
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
