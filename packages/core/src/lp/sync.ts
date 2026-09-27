import type { DbAdapter } from '../db/types';
import type { EsiClient } from '../esi/client';
import { systemClock, type Clock } from '../esi/clock';
import type { RequestScheduler } from '../esi/scheduler';
import type { EsiCacheControl, EsiResult, LpStoreOffer } from '../esi/types';
import { computeExpiresAt } from '../personal/sync';

import {
  getLpStoreState,
  listCorporationIdsWithLp,
  markStoreError,
  markStoreOk,
  markStoreStarted,
  replaceStoreOffers,
} from './repo';

/**
 * LP 报价的本地刷新策略：LP 商店只在版本更新时变化，
 * 默认 24h 内不回源（到期后仍靠 ETag 条件请求，命中 304 即零流量）。
 */
export const DEFAULT_LP_STORE_TTL_MS = 24 * 60 * 60 * 1000;

export interface LpStoreSyncerOptions {
  db: DbAdapter;
  client: EsiClient;
  scheduler: RequestScheduler;
  clock?: Clock;
}

export interface LpStoreSyncOptions {
  /** 忽略本地有效期强制回源 */
  force?: boolean;
}

export interface LpStoreSyncResult {
  corporationId: number;
  ok: boolean;
  requests: number;
  /** 本次写入的报价条数（304 / 缓存跳过时为 0） */
  offersWritten: number;
  skipped: boolean;
  skippedReason: 'not-modified' | 'cache' | null;
  error: string | null;
}

export interface LpStoreSyncSummary {
  results: LpStoreSyncResult[];
  okCount: number;
  failedCount: number;
}

/**
 * 计算本地有效期：**取服务端缓存声明与本地 TTL 的较晚者**。
 * - 不早于服务端声明回源 → 严格遵循 `Cache-Control` / `Expires`（方案 §9 CCP 合规项）
 * - 不早于本地 TTL 回源 → LP 报价这类低频数据不必频繁请求；到期后一次条件请求即可复校
 */
export function resolveStoreExpiresAt(
  cacheControl: EsiCacheControl | null | undefined,
  nowMs: number,
  ttlMs: number = DEFAULT_LP_STORE_TTL_MS,
): string {
  const ttlAt = new Date(nowMs + ttlMs).toISOString();
  const serverAt = computeExpiresAt(cacheControl, nowMs);
  if (serverAt === null) return ttlAt;
  return Date.parse(serverAt) > Date.parse(ttlAt) ? serverAt : ttlAt;
}

/** 是否仍在本地有效期内 */
function isFresh(expiresAt: string | null | undefined, nowMs: number): boolean {
  if (expiresAt === null || expiresAt === undefined) return false;
  const at = Date.parse(expiresAt);
  return Number.isFinite(at) && at > nowMs;
}

/**
 * LP 商店同步器（数据源：ESI **公共**端点，无需授权）。
 *
 * 写入语义：每军团**整体替换**（单事务先删后插），与 P3 的覆盖型端点一致。
 * 错误契约：单军团失败只写该军团 `last_error`（`last_ok_at` 与既有报价不动），其余军团照常。
 */
export class LpStoreSyncer {
  private readonly db: DbAdapter;
  private readonly client: EsiClient;
  private readonly scheduler: RequestScheduler;
  private readonly clock: Clock;

  constructor(options: LpStoreSyncerOptions) {
    this.db = options.db;
    this.client = options.client;
    this.scheduler = options.scheduler;
    this.clock = options.clock ?? systemClock;
  }

  /** 同步多个军团（串行 + 失败隔离） */
  async syncStores(
    corporationIds: readonly number[],
    options: LpStoreSyncOptions = {},
  ): Promise<LpStoreSyncSummary> {
    const results: LpStoreSyncResult[] = [];
    for (const corporationId of corporationIds) {
      results.push(await this.syncStore(corporationId, options));
    }
    return {
      results,
      okCount: results.filter((item) => item.ok).length,
      failedCount: results.filter((item) => !item.ok).length,
    };
  }

  /** 同步「角色有 LP 余额的军团」——LP 商店的默认抓取范围 */
  async syncCharacterStores(
    characterId: number,
    options: LpStoreSyncOptions = {},
  ): Promise<LpStoreSyncSummary> {
    const corporationIds = await listCorporationIdsWithLp(this.db, characterId);
    return this.syncStores(corporationIds, options);
  }

  /** 同步单个军团 */
  async syncStore(
    corporationId: number,
    options: LpStoreSyncOptions = {},
  ): Promise<LpStoreSyncResult> {
    const state = await getLpStoreState(this.db, corporationId);
    const nowMs = this.clock.now();

    if (options.force !== true && isFresh(state?.expiresAt, nowMs)) {
      return {
        corporationId,
        ok: true,
        requests: 0,
        offersWritten: 0,
        skipped: true,
        skippedReason: 'cache',
        error: null,
      };
    }

    await markStoreStarted(this.db, corporationId, new Date(nowMs).toISOString());
    try {
      const result = await this.runScheduled(() =>
        this.client.fetchLpStoreOffers(corporationId, { etag: state?.etag ?? undefined }),
      );
      const okAt = new Date(this.clock.now()).toISOString();
      const expiresAt = resolveStoreExpiresAt(result.cacheControl, this.clock.now());

      if (result.notModified) {
        await markStoreOk(
          this.db,
          corporationId,
          {
            expiresAt,
            offersWritten: state?.offersWritten ?? 0,
            requests: (state?.requests ?? 0) + 1,
          },
          okAt,
        );
        return {
          corporationId,
          ok: true,
          requests: 1,
          offersWritten: 0,
          skipped: true,
          skippedReason: 'not-modified',
          error: null,
        };
      }

      const offers: readonly LpStoreOffer[] = result.data ?? [];
      await replaceStoreOffers(this.db, corporationId, offers, okAt);
      await markStoreOk(
        this.db,
        corporationId,
        {
          etag: result.etag ?? undefined,
          expiresAt,
          offersWritten: offers.length,
          requests: (state?.requests ?? 0) + 1,
        },
        okAt,
      );
      return {
        corporationId,
        ok: true,
        requests: 1,
        offersWritten: offers.length,
        skipped: false,
        skippedReason: null,
        error: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markStoreError(this.db, corporationId, message).catch(() => undefined);
      return {
        corporationId,
        ok: false,
        requests: 1,
        offersWritten: 0,
        skipped: false,
        skippedReason: null,
        error: message,
      };
    }
  }

  /** 统一经调度器下发（LP 商店属按需刷新，优先级 ondemand）并回传限流信息 */
  private async runScheduled<T>(run: () => Promise<EsiResult<T>>): Promise<EsiResult<T>> {
    const result = await this.scheduler.run<EsiResult<T>>('ondemand', run);
    this.scheduler.observe(result.rateLimit, result.errorLimit);
    return result;
  }
}
