import { readHeader, readNumberHeader, type HttpClient, type HttpResponse } from './http';
import {
  EsiError,
  type CharacterAsset,
  type CharacterContract,
  type CharacterOrder,
  type CharacterPublicInfo,
  type EsiCacheControl,
  type EsiErrorLimit,
  type EsiRateLimit,
  type EsiResult,
  type EsiStatus,
  type IndustryJob,
  type LoyaltyPoints,
  type LpStoreOffer,
  type MarketHistoryEntry,
  type MarketOrder,
  type MiningObservation,
  type WalletJournalEntry,
} from './types';

/** ESI 公共端点（tranquility） */
export const DEFAULT_ESI_BASE_URL = 'https://esi.evetech.net/latest';

/**
 * 认证能力端口（消费方定义，适配器为 `TokenManager`）。
 * ESI 客户端只依赖本接口，不感知系统钥匙串与刷新令牌细节。
 */
export interface EsiAuthProvider {
  /** 返回可用访问令牌（实现方负责临期刷新） */
  getAccessToken(characterId: number): Promise<string>;
  /** 令牌被服务端拒绝（401）时调用：丢弃内存令牌，下次调用将强制刷新 */
  invalidate(characterId: number): void;
}

export interface EsiClientOptions {
  /** 宿主注入的 HTTP 客户端（运行时 fetch，测试 mock） */
  http: HttpClient;
  baseUrl?: string;
  /** 认证能力；未提供时只能访问公开端点（传 characterId 会报错） */
  auth?: EsiAuthProvider;
}

export interface EsiRequestOptions {
  /** 上次响应携带的 ETag，命中时服务端返回 304（无响应体） */
  etag?: string;
  /** 以该角色身份发起认证请求（需构造时提供 auth） */
  characterId?: number;
  signal?: AbortSignal;
}

/**
 * ESI 客户端：负责 URL 构造、条件请求、认证令牌注入、响应头解析与错误分类。
 * 限流排队与退避重试由上层请求队列负责，本类只做「一次请求」（401 例外：强制刷新后重试一次）。
 *
 * 错误契约：认证类失败（如刷新令牌失效）会以 `TokenManagerError` **原样抛出**，
 * 不包装成 `EsiError` —— 调度器只对 `EsiError` 重试，而「需要重新授权」不应被重试。
 */
export class EsiClient {
  private readonly http: HttpClient;
  private readonly baseUrl: string;
  private readonly auth: EsiAuthProvider | undefined;

  constructor(options: EsiClientOptions) {
    this.http = options.http;
    this.baseUrl = (options.baseUrl ?? DEFAULT_ESI_BASE_URL).replace(/\/+$/, '');
    this.auth = options.auth;
  }

  /** 服务器状态（轻量，用于连通性自检） */
  fetchStatus(options?: EsiRequestOptions): Promise<EsiResult<EsiStatus>> {
    return this.request<EsiStatus>(`${this.baseUrl}/status/`, options);
  }

  /** 区域全量订单（分页；order_type=all 含买单与卖单，每页约 1000 条） */
  fetchRegionOrders(
    regionId: number,
    page: number,
    options?: EsiRequestOptions,
  ): Promise<EsiResult<MarketOrder[]>> {
    return this.request<MarketOrder[]>(
      `${this.baseUrl}/markets/${regionId}/orders/?order_type=all&page=${page}`,
      options,
    );
  }

  /**
   * 单物品订单（按需，1-2 个请求）。
   * 注意：该端点不像分页端点那样经过 5 分钟缓存，数据更新更快。
   */
  fetchTypeOrders(
    regionId: number,
    typeId: number,
    options?: EsiRequestOptions,
  ): Promise<EsiResult<MarketOrder[]>> {
    return this.request<MarketOrder[]>(
      `${this.baseUrl}/markets/${regionId}/orders/?type_id=${typeId}`,
      options,
    );
  }

  /** 单物品日线历史（ESI 自带约 400 天） */
  fetchTypeHistory(
    regionId: number,
    typeId: number,
    options?: EsiRequestOptions,
  ): Promise<EsiResult<MarketHistoryEntry[]>> {
    return this.request<MarketHistoryEntry[]>(
      `${this.baseUrl}/markets/${regionId}/history/?type_id=${typeId}`,
      options,
    );
  }

  /**
   * 认证 GET（个人数据端点）：`path` 为 ESI 路径，如 `/characters/123/wallet/`。
   * 下列具体快捷方法即其封装。
   */
  fetchAuthenticated<T>(
    path: string,
    characterId: number,
    options?: Omit<EsiRequestOptions, 'characterId'>,
  ): Promise<EsiResult<T>> {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    return this.request<T>(`${this.baseUrl}${normalized}`, { ...options, characterId });
  }

  // ── 个人数据端点（P3-5；均需授权 scope，经调度器以 personal 优先级下发） ──

  /** 资产列表（分页） */
  fetchCharacterAssets(
    characterId: number,
    page: number,
    options?: Omit<EsiRequestOptions, 'characterId'>,
  ): Promise<EsiResult<CharacterAsset[]>> {
    return this.fetchAuthenticated<CharacterAsset[]>(
      `/characters/${characterId}/assets/?page=${page}`,
      characterId,
      options,
    );
  }

  /** 钱包余额（单值数字，非分页） */
  fetchWalletBalance(
    characterId: number,
    options?: Omit<EsiRequestOptions, 'characterId'>,
  ): Promise<EsiResult<number>> {
    return this.fetchAuthenticated<number>(`/characters/${characterId}/wallet/`, characterId, options);
  }

  /** 钱包账本（分页；ESI 自带约 6 周） */
  fetchWalletJournal(
    characterId: number,
    page: number,
    options?: Omit<EsiRequestOptions, 'characterId'>,
  ): Promise<EsiResult<WalletJournalEntry[]>> {
    return this.fetchAuthenticated<WalletJournalEntry[]>(
      `/characters/${characterId}/wallet/journal/?page=${page}`,
      characterId,
      options,
    );
  }

  /** 当前挂单（分页；不含历史） */
  fetchCharacterOrders(
    characterId: number,
    page: number,
    options?: Omit<EsiRequestOptions, 'characterId'>,
  ): Promise<EsiResult<CharacterOrder[]>> {
    return this.fetchAuthenticated<CharacterOrder[]>(
      `/characters/${characterId}/orders/?page=${page}`,
      characterId,
      options,
    );
  }

  /** 合同（分页） */
  fetchCharacterContracts(
    characterId: number,
    page: number,
    options?: Omit<EsiRequestOptions, 'characterId'>,
  ): Promise<EsiResult<CharacterContract[]>> {
    return this.fetchAuthenticated<CharacterContract[]>(
      `/characters/${characterId}/contracts/?page=${page}`,
      characterId,
      options,
    );
  }

  /** 制造/科研任务（分页） */
  fetchIndustryJobs(
    characterId: number,
    page: number,
    options?: Omit<EsiRequestOptions, 'characterId'>,
  ): Promise<EsiResult<IndustryJob[]>> {
    return this.fetchAuthenticated<IndustryJob[]>(
      `/characters/${characterId}/industry/jobs/?page=${page}`,
      characterId,
      options,
    );
  }

  /** 采矿观察（分页） */
  fetchMiningLedger(
    characterId: number,
    page: number,
    options?: Omit<EsiRequestOptions, 'characterId'>,
  ): Promise<EsiResult<MiningObservation[]>> {
    return this.fetchAuthenticated<MiningObservation[]>(
      `/characters/${characterId}/mining/?page=${page}`,
      characterId,
      options,
    );
  }

  /** 忠诚点余额（分页，通常 1 页） */
  fetchLoyaltyPoints(
    characterId: number,
    page: number,
    options?: Omit<EsiRequestOptions, 'characterId'>,
  ): Promise<EsiResult<LoyaltyPoints[]>> {
    return this.fetchAuthenticated<LoyaltyPoints[]>(
      `/characters/${characterId}/loyalty/points/?page=${page}`,
      characterId,
      options,
    );
  }

  /** 角色公开信息（无需授权；仅取 corporation_id） */
  fetchCharacterPublicInfo(
    characterId: number,
    options?: EsiRequestOptions,
  ): Promise<EsiResult<CharacterPublicInfo>> {
    return this.request<CharacterPublicInfo>(
      `${this.baseUrl}/characters/${characterId}/`,
      options,
    );
  }

  /** LP 商店报价（**公共端点，无需授权**；一次返回该军团全部 offer） */
  fetchLpStoreOffers(
    corporationId: number,
    options?: EsiRequestOptions,
  ): Promise<EsiResult<LpStoreOffer[]>> {
    return this.request<LpStoreOffer[]>(
      `${this.baseUrl}/loyalty/stores/${corporationId}/offers/`,
      options,
    );
  }

  private async request<T>(url: string, options?: EsiRequestOptions): Promise<EsiResult<T>> {
    const characterId = options?.characterId;
    let bearerToken: string | undefined;
    if (characterId !== undefined) {
      bearerToken = await this.acquireToken(characterId);
    }

    let response = await this.send(url, options, bearerToken);

    // 401：令牌可能被提前吊销（改密/被踢下线）→ 强制刷新后仅重试一次
    if (response.status === 401 && characterId !== undefined && this.auth !== undefined) {
      this.auth.invalidate(characterId);
      bearerToken = await this.acquireToken(characterId);
      response = await this.send(url, options, bearerToken);
    }

    const etag = readHeader(response.headers, 'etag');
    const pages = readNumberHeader(response.headers, 'x-pages');
    const rateLimit = parseRateLimit(response.headers);
    const errorLimit = parseErrorLimit(response.headers);
    const cacheControl = parseCacheControl(response.headers);
    const responseMeta = { etag, pages, rateLimit, errorLimit, cacheControl };

    if (response.status === 304) {
      return { notModified: true, data: null, ...responseMeta };
    }

    if (response.status === 429 || response.status >= 500) {
      throw new EsiError(
        'throttled',
        response.status,
        `HTTP ${response.status}（${url}）`,
        readNumberHeader(response.headers, 'retry-after') ?? undefined,
        rateLimit,
        errorLimit,
      );
    }

    if (response.status < 200 || response.status >= 300) {
      throw new EsiError(
        'client',
        response.status,
        `HTTP ${response.status}（${url}）`,
        undefined,
        rateLimit,
        errorLimit,
      );
    }

    let data: T;
    try {
      data = JSON.parse(response.text) as T;
    } catch (error) {
      throw new EsiError(
        'invalid',
        response.status,
        `响应不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
        undefined,
        rateLimit,
        errorLimit,
      );
    }

    return { notModified: false, data, ...responseMeta };
  }

  /** 取访问令牌；未配置 auth 时属于调用方用法错误 */
  private async acquireToken(characterId: number): Promise<string> {
    if (this.auth === undefined) {
      throw new EsiError(
        'client',
        null,
        `请求角色 ${characterId} 的认证端点，但 EsiClient 未配置 auth`,
      );
    }
    return this.auth.getAccessToken(characterId);
  }

  /** 发送一次请求并把传输层异常归一化为 network 类 EsiError */
  private async send(
    url: string,
    options: EsiRequestOptions | undefined,
    bearerToken: string | undefined,
  ): Promise<HttpResponse> {
    try {
      return await this.http.get({
        url,
        ifNoneMatch: options?.etag,
        bearerToken,
        signal: options?.signal,
      });
    } catch (error) {
      if (error instanceof EsiError) throw error;
      throw new EsiError(
        'network',
        null,
        `请求失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function parseRateLimit(headers: Readonly<Record<string, string>>): EsiRateLimit | null {
  const group = readHeader(headers, 'x-ratelimit-group');
  const limit = readHeader(headers, 'x-ratelimit-limit');
  const remaining = readNumberHeader(headers, 'x-ratelimit-remaining');
  const used = readNumberHeader(headers, 'x-ratelimit-used');
  if (group === null || limit === null || remaining === null || used === null) return null;
  return { group, limit, remaining, used };
}

function parseErrorLimit(headers: Readonly<Record<string, string>>): EsiErrorLimit | null {
  const remain = readNumberHeader(headers, 'x-esi-error-limit-remain');
  const reset = readNumberHeader(headers, 'x-esi-error-limit-reset');
  if (remain === null || reset === null) return null;
  return { remain, reset };
}

/**
 * 解析缓存指令（`Cache-Control` + `Expires` 头）。
 *
 * 实测 ESI 多数端点只发 `public` + `Expires`（HTTP 日期），少数端点发 `max-age`，
 * 故到期时间需两个来源；无任何一条时 maxAgeSeconds / expiresAtMs 为 null
 * （调用方视作「不可缓存」，即每轮回源）。
 */
export function parseCacheControl(
  headers: Readonly<Record<string, string>>,
): EsiCacheControl | null {
  const raw = readHeader(headers, 'cache-control');
  const expiresRaw = readHeader(headers, 'expires');
  if (raw === null && expiresRaw === null) return null;

  const directives =
    raw === null
      ? []
      : raw
          .split(',')
          .map((directive) => directive.trim().toLowerCase())
          .filter((directive) => directive.length > 0);

  let maxAgeSeconds: number | null = null;
  for (const directive of directives) {
    if (!directive.startsWith('max-age=')) continue;
    const value = Number(directive.slice('max-age='.length).replace(/^"|"$/g, ''));
    if (Number.isFinite(value) && value >= 0) maxAgeSeconds = value;
    break;
  }

  let expiresAtMs: number | null = null;
  if (expiresRaw !== null && expiresRaw.toLowerCase() !== '0') {
    const parsed = Date.parse(expiresRaw);
    if (Number.isFinite(parsed)) expiresAtMs = parsed;
  }

  return {
    maxAgeSeconds,
    expiresAtMs,
    // no-cache 与 no-store 在本项目用途下等价：都表示「不得直接复用」，需回源
    noStore: directives.includes('no-store') || directives.includes('no-cache'),
    mustRevalidate: directives.includes('must-revalidate'),
  };
}
