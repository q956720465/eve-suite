/**
 * ESI（EVE Swagger Interface）数据类型。
 * 字段依据官方接口实测响应（2026-09）定义，仅保留本项目使用的字段。
 */

/** 市场订单（/markets/{region_id}/orders/） */
export interface MarketOrder {
  order_id: number;
  type_id: number;
  location_id: number;
  volume_total: number;
  volume_remain: number;
  min_volume: number;
  price: number;
  is_buy_order: boolean;
  duration: number;
  issued: string;
  range: string;
}

/** 日线历史（/markets/{region_id}/history/），ESI 自带约 400 天 */
export interface MarketHistoryEntry {
  date: string;
  average: number;
  highest: number;
  lowest: number;
  order_count: number;
  volume: number;
}

/** 服务器状态（/status/） */
export interface EsiStatus {
  players: number;
  server_version: string;
  start_time: string;
}

/** 限流信息（X-Ratelimit-* 响应头） */
export interface EsiRateLimit {
  group: string;
  limit: string;
  remaining: number;
  used: number;
}

/** 错误预算（X-Esi-Error-Limit-* 响应头） */
export interface EsiErrorLimit {
  remain: number;
  reset: number;
}

/** 单次 ESI 请求的结果（含缓存与配额元数据） */
export interface EsiResult<T> {
  /** 命中 ETag 条件请求（HTTP 304），data 为 null */
  notModified: boolean;
  data: T | null;
  etag: string | null;
  /** 分页总数（X-Pages），仅分页端点返回 */
  pages: number | null;
  rateLimit: EsiRateLimit | null;
  errorLimit: EsiErrorLimit | null;
}

/** ESI 请求失败原因分类 */
export type EsiErrorKind =
  /** 网络/传输层失败（可重试） */
  | 'network'
  /** 429 或 5xx（可退避重试） */
  | 'throttled'
  /** 4xx 客户端错误（不应重试） */
  | 'client'
  /** 响应不是合法 JSON */
  | 'invalid';

export class EsiError extends Error {
  constructor(
    readonly kind: EsiErrorKind,
    readonly status: number | null,
    message: string,
    /** 服务端给出的建议等待秒数（Retry-After） */
    readonly retryAfterSeconds?: number,
    /** 失败响应中携带的限流信息（供上层自适应降速） */
    readonly rateLimit?: EsiRateLimit | null,
    /** 失败响应中携带的错误预算（供上层熔断判断） */
    readonly errorLimit?: EsiErrorLimit | null,
  ) {
    super(message);
    this.name = 'EsiError';
  }

  /** 是否适合退避后重试 */
  get retryable(): boolean {
    return this.kind === 'network' || this.kind === 'throttled' || this.kind === 'invalid';
  }
}
