/**
 * 访问令牌管理（P3-3）：内存持有访问令牌，临期时用刷新令牌自动换新。
 *
 * 分工：
 * - 刷新令牌的**持久化**由 P3-2 的 `OAuthTokenStore`（系统钥匙串）负责；
 * - 访问令牌**只驻内存**（约 20 分钟失效，不落盘、不进数据库）；
 * - `EsiClient` 只依赖本文件导出的 `EsiAuthProvider` 接口，不感知钥匙串细节。
 *
 * 注意：EVE SSO 在每次刷新时**轮换**刷新令牌，因此刷新成功后必须把新值回写钥匙串，
 * 否则下次启动会用已失效的旧令牌。
 */

import type { EsiAuthProvider } from './client';
import {
  refreshAccessToken,
  TokenRequestError,
  type TokenHttp,
  type TokenSet,
} from './oauth';
import type { OAuthTokenStore } from './secret-store';

export type TokenManagerErrorKind =
  /** 钥匙串里没有该角色的刷新令牌（从未登录或已被清理） */
  | 'no_refresh_token'
  /** 刷新令牌已失效，必须重新走浏览器授权 */
  | 'reauth_required'
  /** 刷新过程出现瞬时故障（网络/服务端错误） */
  | 'refresh_failed'
  /** 令牌响应缺少角色 ID，无法建立会话 */
  | 'unknown_character';

export class TokenManagerError extends Error {
  constructor(
    readonly kind: TokenManagerErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'TokenManagerError';
  }
}

/** 默认提前刷新窗口：剩余有效期低于该值时即刷新 */
export const DEFAULT_REFRESH_SKEW_MS = 60_000;

export interface TokenManagerOptions {
  clientId: string;
  /** 令牌端点 HTTP 能力（运行时 fetch，测试 mock） */
  tokenHttp: TokenHttp;
  /** 刷新令牌存储（P3-2 钥匙串层） */
  store: OAuthTokenStore;
  /** 当前时间（毫秒，测试注入） */
  now?: () => number;
  /** 提前刷新窗口（毫秒），默认 60 秒 */
  refreshSkewMs?: number;
}

interface CharacterSession {
  accessToken: string;
  /** 访问令牌过期时间（epoch 毫秒） */
  expiresAt: number;
  /** 进行中的刷新（单飞：并发请求共用同一次刷新） */
  refreshing: Promise<void> | null;
}

export class TokenManager implements EsiAuthProvider {
  private readonly clientId: string;
  private readonly tokenHttp: TokenHttp;
  private readonly store: OAuthTokenStore;
  private readonly now: () => number;
  private readonly refreshSkewMs: number;
  private readonly sessions = new Map<number, CharacterSession>();

  constructor(options: TokenManagerOptions) {
    this.clientId = options.clientId;
    this.tokenHttp = options.tokenHttp;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.refreshSkewMs = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
  }

  /** 登录成功后写入初始令牌：刷新令牌落钥匙串，访问令牌进内存 */
  async setInitialTokens(tokens: TokenSet): Promise<void> {
    const characterId = tokens.characterId;
    if (characterId === null) {
      throw new TokenManagerError('unknown_character', '令牌响应缺少角色 ID，无法建立会话');
    }
    if (tokens.refreshToken.length === 0) {
      throw new TokenManagerError('no_refresh_token', '令牌响应未包含刷新令牌');
    }

    await this.store.saveRefreshToken(characterId, tokens.refreshToken);
    this.sessions.set(characterId, {
      accessToken: tokens.accessToken,
      expiresAt: tokens.expiresAt,
      refreshing: null,
    });
  }

  /** 取可用访问令牌；内存中无有效令牌时用刷新令牌换新 */
  async getAccessToken(characterId: number): Promise<string> {
    const session = this.sessions.get(characterId);
    if (session !== undefined && isFresh(session, this.now(), this.refreshSkewMs)) {
      return session.accessToken;
    }

    await this.ensureRefreshed(characterId);
    const refreshed = this.sessions.get(characterId);
    if (refreshed === undefined) {
      throw new TokenManagerError('unknown_character', `角色 ${characterId} 无可用会话`);
    }
    return refreshed.accessToken;
  }

  /** 401 后调用：仅丢弃访问令牌（保留刷新令牌），迫使下次调用刷新 */
  invalidate(characterId: number): void {
    const session = this.sessions.get(characterId);
    if (session === undefined) return;
    session.accessToken = '';
    session.expiresAt = 0;
  }

  /** 丢弃内存会话（登出 / 关闭账号）。刷新令牌的删除由 `OAuthTokenStore` 负责 */
  clear(characterId?: number): void {
    if (characterId === undefined) {
      this.sessions.clear();
      return;
    }
    this.sessions.delete(characterId);
  }

  /** 单飞：同一角色的并发调用共用一次刷新 */
  private async ensureRefreshed(characterId: number): Promise<void> {
    const inflight = this.sessions.get(characterId)?.refreshing;
    if (inflight !== null && inflight !== undefined) {
      await inflight;
      return;
    }

    // 下面的登记在同一次同步执行内完成（performRefresh 首个 await 之前不会让出），
    // 因此并发调用不会重复发起刷新。
    const task = this.performRefresh(characterId);
    const session = this.ensureSession(characterId);
    session.refreshing = task;
    try {
      await task;
    } finally {
      if (session.refreshing === task) {
        session.refreshing = null;
      }
    }
  }

  private async performRefresh(characterId: number): Promise<void> {
    const refreshToken = await this.store.loadRefreshToken(characterId);
    if (refreshToken === null || refreshToken.length === 0) {
      throw new TokenManagerError(
        'no_refresh_token',
        `角色 ${characterId} 没有已保存的刷新令牌，需要重新授权`,
      );
    }

    let tokens: TokenSet;
    try {
      tokens = await refreshAccessToken(this.tokenHttp, {
        clientId: this.clientId,
        refreshToken,
        now: this.now(),
      });
    } catch (error) {
      if (error instanceof TokenRequestError && error.oauthError === 'invalid_grant') {
        // 刷新令牌已失效：清除本地条目，避免每次请求都必然失败
        await this.store.deleteRefreshToken(characterId).catch(() => undefined);
        this.sessions.delete(characterId);
        throw new TokenManagerError('reauth_required', '刷新令牌已失效，需要重新授权');
      }
      throw new TokenManagerError(
        'refresh_failed',
        `刷新访问令牌失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (tokens.characterId !== null && tokens.characterId !== characterId) {
      throw new TokenManagerError(
        'refresh_failed',
        `刷新返回的角色 ID（${tokens.characterId}）与请求（${characterId}）不一致，已丢弃`,
      );
    }

    // 轮换：只有拿到不同且非空的新刷新令牌才回写，避免覆盖成空值
    if (tokens.refreshToken.length > 0 && tokens.refreshToken !== refreshToken) {
      await this.store.saveRefreshToken(characterId, tokens.refreshToken);
    }

    const session = this.ensureSession(characterId);
    session.accessToken = tokens.accessToken;
    session.expiresAt = tokens.expiresAt;
  }

  private ensureSession(characterId: number): CharacterSession {
    const existing = this.sessions.get(characterId);
    if (existing !== undefined) return existing;
    const created: CharacterSession = { accessToken: '', expiresAt: 0, refreshing: null };
    this.sessions.set(characterId, created);
    return created;
  }
}

/** 令牌是否仍在有效期内（含提前刷新窗口） */
function isFresh(session: CharacterSession, nowMs: number, skewMs: number): boolean {
  return session.accessToken.length > 0 && session.expiresAt - nowMs > skewMs;
}
