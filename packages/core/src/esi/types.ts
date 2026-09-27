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

/**
 * ESI 响应的缓存指令（`Cache-Control` + `Expires` 头解析结果）。
 * 实测（2026-09-27）ESI 多数端点只用 `public` + `Expires` 传递到期时间，
 * 只有部分端点给 `max-age`，故两者都要解析。
 */
export interface EsiCacheControl {
  /** max-age 秒数；未声明或非法为 null */
  maxAgeSeconds: number | null;
  /** Expires 头解析出的绝对到期时刻（毫秒时间戳）；无该头或非法为 null */
  expiresAtMs: number | null;
  /** no-store / no-cache：禁止复用 */
  noStore: boolean;
  /** must-revalidate：过期后必须回源校验 */
  mustRevalidate: boolean;
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
  /** 服务端缓存指令（200 与 304 均可能携带）；无该头为 null */
  cacheControl?: EsiCacheControl | null;
}

/** 资产项（/characters/{character_id}/assets/） */
export interface CharacterAsset {
  item_id: number;
  type_id: number;
  quantity: number;
  location_id: number;
  location_flag: string;
  location_type: 'station' | 'item' | 'other';
  is_singleton: boolean;
  /** 可选：仅蓝图拷贝为 true 时返回 */
  is_blueprint_copy?: boolean;
}

/** 钱包账本条目（/characters/{character_id}/wallet/journal/），ESI 自带约 6 周 */
export interface WalletJournalEntry {
  /** ESI 的 `id` 字段，映射为 entry_id */
  id: number;
  date: string;
  ref_type: string;
  description: string;
  amount?: number;
  balance?: number;
  reason?: string;
  first_party_id?: number;
  second_party_id?: number;
  context_id?: number;
  context_id_type?: string;
  tax?: number;
  tax_receiver_id?: number;
}

/** 我的挂单（/characters/{character_id}/orders/，仅当前挂单，不含历史） */
export interface CharacterOrder {
  order_id: number;
  type_id: number;
  region_id: number;
  location_id: number;
  price: number;
  volume_total: number;
  volume_remain: number;
  is_corporation: boolean;
  duration: number;
  issued: string;
  range: string;
  /** 可选：ESI 为 false 时会省略 */
  is_buy_order?: boolean;
  /** 可选：买单才有 */
  escrow?: number;
  min_volume?: number;
}

/** 合同（/characters/{character_id}/contracts/） */
export interface CharacterContract {
  contract_id: number;
  /** item_exchange / auction / courier / loan */
  type: string;
  status: string;
  /** public / personal / corporation / alliance */
  availability: string;
  for_corporation: boolean;
  issuer_id: number;
  issuer_corporation_id: number;
  assignee_id: number;
  acceptor_id: number;
  date_issued: string;
  date_expired: string;
  title?: string;
  price?: number;
  reward?: number;
  collateral?: number;
  buyout?: number;
  volume?: number;
  days_to_complete?: number;
  start_location_id?: number;
  end_location_id?: number;
  date_accepted?: string;
  date_completed?: string;
}

/** 制造/科研任务（/characters/{character_id}/industry/jobs/） */
export interface IndustryJob {
  job_id: number;
  activity_id: number;
  blueprint_id: number;
  blueprint_type_id: number;
  blueprint_location_id: number;
  output_location_id: number;
  facility_id: number;
  station_id: number;
  installer_id: number;
  runs: number;
  status: string;
  duration: number;
  start_date: string;
  end_date: string;
  product_type_id?: number;
  licensed_runs?: number;
  successful_runs?: number;
  probability?: number;
  cost?: number;
  pause_date?: string;
  completed_date?: string;
  completed_character_id?: number;
}

/** 采矿观察（/characters/{character_id}/mining/，ESI 无唯一 id，按复合键定位） */
export interface MiningObservation {
  date: string;
  solar_system_id: number;
  type_id: number;
  quantity: number;
}

/** 忠诚点余额（/characters/{character_id}/loyalty/points/） */
export interface LoyaltyPoints {
  corporation_id: number;
  loyalty_points: number;
}

/** 角色公开信息（/characters/{character_id}/，无需授权） */
export interface CharacterPublicInfo {
  /** P3 仅用于填 characters.corporation_id（P5 公司资产要用） */
  corporation_id: number;
}

/** LP 商店报价的兑换材料（一个 offer 可要求多种） */
export interface LpStoreOfferItem {
  type_id: number;
  quantity: number;
}

/**
 * LP 商店报价（`/loyalty/stores/{corporation_id}/offers/`，**公共端点，无需授权**）。
 * `quantity` 为一次兑换产出的物品数量；`ak_cost` 为 CONCORD LP（与军团 LP 不同源）。
 */
export interface LpStoreOffer {
  offer_id: number;
  type_id: number;
  quantity: number;
  lp_cost: number;
  isk_cost: number;
  ak_cost: number;
  required_items: LpStoreOfferItem[];
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
