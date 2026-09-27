/**
 * OAuth 授权流程编排（P3-1）：把「PKCE → 打开系统浏览器 → 收回调 → 换令牌」串起来。
 *
 * 纯 TypeScript，不依赖 Tauri：宿主能力（本地回环监听 / 打开浏览器）通过
 * `LoopbackServer` 注入（运行时见 `esi/tauri-oauth.ts`，测试见 test/esi/oauth-flow.test.ts）。
 */

import {
  buildAuthorizeUrl,
  exchangeCode,
  generatePkce,
  generateState,
  OAUTH_LOOPBACK_PORT,
  type TokenHttp,
  type TokenSet,
} from './oauth';

/** 默认回调路径（与 Rust 侧 DEFAULT_CALLBACK_PATH 一致） */
export const DEFAULT_REDIRECT_PATH = '/callback';

/** 等待用户完成浏览器授权的默认超时（5 分钟） */
export const DEFAULT_AUTH_TIMEOUT_MS = 5 * 60 * 1000;

/** 回环回调参数（缺失字段为 null） */
export interface CallbackPayload {
  code: string | null;
  state: string | null;
  error: string | null;
  errorDescription: string | null;
}

/** 宿主提供的回环授权能力（Rust 侧实现，测试可注入假实现） */
export interface LoopbackServer {
  /** 绑定 127.0.0.1 指定端口（须与 CCP 注册的回调地址一致），返回端口与完整回调地址 */
  prepare(port: number, redirectPath: string): Promise<{ port: number; redirectUri: string }>;
  /** 用系统默认浏览器打开 URL */
  openBrowser(url: string): Promise<void>;
  /** 等待浏览器回调（超时抛错） */
  waitCallback(timeoutMs: number): Promise<CallbackPayload>;
  /** 取消并释放回环端口 */
  cancel(): Promise<void>;
}

export type OAuthFlowErrorKind =
  /** 用户在授权页点了拒绝/取消 */
  | 'denied'
  /** 回调带了 error（非 access_denied） */
  | 'callback_error'
  /** 未返回授权码 */
  | 'missing_code'
  /** state 与请求不一致（疑似 CSRF） */
  | 'state_mismatch';

export class OAuthFlowError extends Error {
  constructor(
    readonly kind: OAuthFlowErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'OAuthFlowError';
  }
}

export interface OAuthFlowOptions {
  clientId: string;
  scopes: readonly string[];
  /** 令牌端点 HTTP 能力（运行时 fetch，测试 mock） */
  tokenHttp: TokenHttp;
  /** 回环授权能力 */
  loopback: LoopbackServer;
  /** 回调路径，默认 `/callback` */
  redirectPath?: string;
  /** 回环监听端口，默认 `OAUTH_LOOPBACK_PORT`（须与 CCP 注册的回调地址一致） */
  loopbackPort?: number;
  /** 等待回调超时（毫秒），默认 5 分钟 */
  timeoutMs?: number;
  /** 随机源（测试注入以获得可复现的 PKCE/state） */
  randomBytes?: (length: number) => Uint8Array;
  /** 当前时间（毫秒，测试注入） */
  now?: () => number;
}

/**
 * 执行完整授权流程，成功返回令牌集合。
 *
 * 注意：本函数只负责拿到令牌，**不做持久化**（令牌存储见 P3-2）。
 * 失败时统一释放回环端口后抛出错误。
 */
export async function runOAuthFlow(options: OAuthFlowOptions): Promise<TokenSet> {
  const redirectPath = options.redirectPath ?? DEFAULT_REDIRECT_PATH;
  const port = options.loopbackPort ?? OAUTH_LOOPBACK_PORT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  const { redirectUri } = await options.loopback.prepare(port, redirectPath);

  try {
    const pkce = await generatePkce(options.randomBytes);
    const state = generateState(options.randomBytes);

    const authorizeUrl = buildAuthorizeUrl({
      clientId: options.clientId,
      redirectUri,
      scopes: options.scopes,
      state,
      challenge: pkce.challenge,
    });

    await options.loopback.openBrowser(authorizeUrl);
    const callback = await options.loopback.waitCallback(timeoutMs);

    if (callback.error !== null) {
      throw callback.error === 'access_denied'
        ? new OAuthFlowError('denied', '授权被取消（access_denied）')
        : new OAuthFlowError(
            'callback_error',
            `授权失败：${callback.error}${
              callback.errorDescription === null ? '' : `（${callback.errorDescription}）`
            }`,
          );
    }

    if (callback.code === null || callback.code.length === 0) {
      throw new OAuthFlowError('missing_code', '回调未携带授权码');
    }

    if (callback.state !== state) {
      throw new OAuthFlowError('state_mismatch', '回调 state 与请求不一致，已中止授权');
    }

    return await exchangeCode(options.tokenHttp, {
      clientId: options.clientId,
      code: callback.code,
      verifier: pkce.verifier,
      now: now(),
    });
  } catch (error) {
    // 失败/超时后释放回环端口（成功路径由 waitCallback 内部消费会话）
    await options.loopback.cancel().catch(() => undefined);
    throw error;
  }
}
