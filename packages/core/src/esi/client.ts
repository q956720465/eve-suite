import { readHeader, readNumberHeader, type HttpClient, type HttpResponse } from './http';
import {
  EsiError,
  type EsiErrorLimit,
  type EsiRateLimit,
  type EsiResult,
  type EsiStatus,
  type MarketHistoryEntry,
  type MarketOrder,
} from './types';

/** ESI 公共端点（tranquility） */
export const DEFAULT_ESI_BASE_URL = 'https://esi.evetech.net/latest';

export interface EsiClientOptions {
  /** 宿主注入的 HTTP 客户端（运行时 fetch，测试 mock） */
  http: HttpClient;
  baseUrl?: string;
}

export interface EsiRequestOptions {
  /** 上次响应携带的 ETag，命中时服务端返回 304（无响应体） */
  etag?: string;
  signal?: AbortSignal;
}

/**
 * ESI 客户端：负责 URL 构造、条件请求、响应头解析与错误分类。
 * 限流排队与退避重试由上层请求队列负责，本类只做「一次请求」。
 */
export class EsiClient {
  private readonly http: HttpClient;
  private readonly baseUrl: string;

  constructor(options: EsiClientOptions) {
    this.http = options.http;
    this.baseUrl = (options.baseUrl ?? DEFAULT_ESI_BASE_URL).replace(/\/+$/, '');
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

  private async request<T>(url: string, options?: EsiRequestOptions): Promise<EsiResult<T>> {
    let response: HttpResponse;
    try {
      response = await this.http.get({
        url,
        ifNoneMatch: options?.etag,
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

    const etag = readHeader(response.headers, 'etag');
    const pages = readNumberHeader(response.headers, 'x-pages');
    const rateLimit = parseRateLimit(response.headers);
    const errorLimit = parseErrorLimit(response.headers);
    const responseMeta = { etag, pages, rateLimit, errorLimit };

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
