import type { DbAdapter } from '../db/types';
import type { EsiClient } from '../esi/client';
import { systemClock, type Clock } from '../esi/clock';
import type { RequestScheduler } from '../esi/scheduler';
import type { EsiResult, MarketOrder } from '../esi/types';
import { insertRows } from '../sde/batch';

import { loadEtags, ordersPageScope, saveEtags } from './etag-cache';
import { MAX_PAGES_PER_REGION, TRADE_HUBS } from './hubs';
import { ORDER_COLUMNS, STATS_COLUMNS, WRITE_BATCH_ROWS, toOrderRow, toStatsRow } from './rows';
import { computeMarketStats } from './stats';

export interface CollectRegionResult {
  regionId: number;
  pages: number;
  requests: number;
  notModifiedPages: number;
  /** 全部分页命中 304 且本地已有数据，跳过写入 */
  skipped: boolean;
  ordersWritten: number;
  statsWritten: number;
  elapsedMs: number;
  error: string | null;
}

export interface CollectProgress {
  regionId: number;
  /** 已完成的页数 */
  page: number;
  pages: number;
  stage: 'orders' | 'done';
  ordersWritten: number;
}

export interface MarketCollectorOptions {
  db: DbAdapter;
  client: EsiClient;
  scheduler: RequestScheduler;
  clock?: Clock;
  onProgress?: (progress: CollectProgress) => void;
}

/**
 * 枢纽层采集器。
 *
 * 流程（单区域）：分页拉取订单（带 ETag 条件请求）→ 若全部 304 且本地已有数据则整轮跳过
 * → 否则整区替换订单快照并重算聚合指标（全程单事务）。
 */
export class MarketCollector {
  private readonly db: DbAdapter;
  private readonly client: EsiClient;
  private readonly scheduler: RequestScheduler;
  private readonly clock: Clock;
  private readonly onProgress: MarketCollectorOptions['onProgress'];
  private etagCache = new Map<string, string>();

  constructor(options: MarketCollectorOptions) {
    this.db = options.db;
    this.client = options.client;
    this.scheduler = options.scheduler;
    this.clock = options.clock ?? systemClock;
    this.onProgress = options.onProgress;
  }

  /** 采集全部枢纽（串行执行，避免多区域数据同时在内存中叠加） */
  async collectHubs(): Promise<CollectRegionResult[]> {
    const results: CollectRegionResult[] = [];
    for (const hub of TRADE_HUBS) {
      results.push(await this.collectRegion(hub.regionId));
    }
    return results;
  }

  /** 采集单个区域的完整订单快照 */
  async collectRegion(regionId: number): Promise<CollectRegionResult> {
    const startedAt = this.clock.now();
    try {
      return await this.doCollectRegion(regionId, startedAt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.recordFailure(regionId, message);
      return {
        regionId,
        pages: 0,
        requests: 0,
        notModifiedPages: 0,
        skipped: false,
        ordersWritten: 0,
        statsWritten: 0,
        elapsedMs: this.clock.now() - startedAt,
        error: message,
      };
    }
  }

  private async doCollectRegion(regionId: number, startedAt: number): Promise<CollectRegionResult> {
    this.etagCache = await loadEtags(this.db, buildPageScopes(regionId));

    // 首页用于确定总页数。
    // 注意：304 响应不携带 X-Pages，此时回退到上次采集记录的页数
    // （页数变化必然导致首页内容变化，因此不会出现「首页 304 但页数已变」的情况）。
    const firstPage = await this.fetchPage(regionId, 1);
    const totalPages =
      firstPage.pages !== null
        ? Math.max(1, Math.min(firstPage.pages, MAX_PAGES_PER_REGION))
        : ((await this.loadPreviousPages(regionId)) ?? 1);

    const pages: (MarketOrder[] | null)[] = new Array<MarketOrder[] | null>(totalPages).fill(null);
    const etagUpdates = new Map<string, string>();
    let requests = 1;
    let notModifiedPages = 0;

    pages[0] = firstPage.notModified ? null : (firstPage.data ?? []);
    if (firstPage.notModified) notModifiedPages += 1;
    if (firstPage.etag !== null) etagUpdates.set(ordersPageScope(regionId, 1), firstPage.etag);
    this.reportProgress(regionId, 1, totalPages, 'orders', 0);

    if (totalPages > 1) {
      const pageNumbers = Array.from({ length: totalPages - 1 }, (_, index) => index + 2);
      let completed = 1;
      const fetched = await Promise.all(
        pageNumbers.map(async (page) => ({ page, result: await this.fetchPage(regionId, page) })),
      );
      for (const { page, result } of fetched) {
        pages[page - 1] = result.notModified ? null : (result.data ?? []);
        if (result.notModified) notModifiedPages += 1;
        if (result.etag !== null) etagUpdates.set(ordersPageScope(regionId, page), result.etag);
        completed += 1;
        if (completed % 25 === 0 || completed === totalPages) {
          this.reportProgress(regionId, completed, totalPages, 'orders', 0);
        }
      }
      requests += fetched.length;
    }

    // 全部命中 304 且本地已有该区域数据 → 数据未变化，跳过写入
    if (notModifiedPages === totalPages && (await this.hasLocalOrders(regionId))) {
      await this.recordSuccess(regionId, totalPages, requests, 0);
      return {
        regionId,
        pages: totalPages,
        requests,
        notModifiedPages,
        skipped: true,
        ordersWritten: 0,
        statsWritten: 0,
        elapsedMs: this.clock.now() - startedAt,
        error: null,
      };
    }

    // 部分页命中 304 时需要完整数据：对这些页无条件下重新拉取
    const refillPages = pages
      .map((page, index) => (page === null ? index + 1 : 0))
      .filter((page) => page > 0);
    if (refillPages.length > 0) {
      const refilled = await Promise.all(
        refillPages.map(async (page) => ({ page, result: await this.fetchPage(regionId, page, true) })),
      );
      for (const { page, result } of refilled) {
        pages[page - 1] = result.data ?? [];
      }
      requests += refilled.length;
    }

    const rawOrders: MarketOrder[] = [];
    for (const page of pages) {
      if (page !== null) rawOrders.push(...page);
    }

    // 按 order_id 去重（保留最后一次出现）：实时行情下「304 探针 + 无条件下重拉补齐」
    // 是两次不同时刻取样，订单可能跨页漂移而被两份页同时包含，而 market_orders.order_id
    // 是单列主键 —— 重复行会让整个区域的替换事务失败（踩坑：UNIQUE constraint failed）
    const uniqueOrders = [...new Map(rawOrders.map((order) => [order.order_id, order])).values()];

    const fetchedAt = new Date(this.clock.now()).toISOString();
    const stats = computeMarketStats(uniqueOrders, regionId, fetchedAt);

    const orderRows: unknown[][] = uniqueOrders.map((order) =>
      toOrderRow(order, regionId, fetchedAt),
    );
    const statsRows: unknown[][] = stats.map(toStatsRow);

    await this.db.transaction(async (tx) => {
      await tx.execute('DELETE FROM market_orders WHERE region_id = ?', [regionId]);
      await insertRows(tx, 'market_orders', ORDER_COLUMNS, orderRows, WRITE_BATCH_ROWS, {
        target: ['order_id'],
        update: ORDER_COLUMNS.filter((column) => column !== 'order_id'),
      });

      await tx.execute('DELETE FROM market_stats WHERE region_id = ?', [regionId]);
      await insertRows(tx, 'market_stats', STATS_COLUMNS, statsRows, WRITE_BATCH_ROWS);

      await saveEtags(tx, etagUpdates, fetchedAt);
      await upsertCollectState(tx, {
        regionId,
        pages: totalPages,
        requests,
        ordersWritten: orderRows.length,
        lastError: null,
      });
    });

    this.reportProgress(regionId, totalPages, totalPages, 'done', orderRows.length);

    return {
      regionId,
      pages: totalPages,
      requests,
      notModifiedPages,
      skipped: false,
      ordersWritten: orderRows.length,
      statsWritten: statsRows.length,
      elapsedMs: this.clock.now() - startedAt,
      error: null,
    };
  }

  private async fetchPage(
    regionId: number,
    page: number,
    skipEtag = false,
  ): Promise<EsiResult<MarketOrder[]>> {
    const etag = skipEtag ? undefined : this.etagCache.get(ordersPageScope(regionId, page));
    const result = await this.scheduler.run('hub', () =>
      this.client.fetchRegionOrders(regionId, page, { etag }),
    );
    this.scheduler.observe(result.rateLimit, result.errorLimit);
    return result;
  }

  private async hasLocalOrders(regionId: number): Promise<boolean> {
    const rows = await this.db.select<{ present: number }>(
      'SELECT 1 AS present FROM market_orders WHERE region_id = ? LIMIT 1',
      [regionId],
    );
    return rows.length > 0;
  }

  /** 上次采集记录的页数（首页 304 时用于确定分页范围） */
  private async loadPreviousPages(regionId: number): Promise<number | null> {
    const rows = await this.db.select<{ pages: number | null }>(
      'SELECT pages FROM market_collect_state WHERE region_id = ?',
      [regionId],
    );
    const pages = rows[0]?.pages;
    return pages !== null && pages !== undefined && pages > 0 ? pages : null;
  }

  private async recordSuccess(
    regionId: number,
    pages: number,
    requests: number,
    ordersWritten: number,
  ): Promise<void> {
    await upsertCollectState(this.db, {
      regionId,
      pages,
      requests,
      ordersWritten,
      lastError: null,
    });
  }

  private async recordFailure(regionId: number, message: string): Promise<void> {
    try {
      await upsertCollectState(this.db, {
        regionId,
        pages: 0,
        requests: 0,
        ordersWritten: 0,
        lastError: message,
      });
    } catch {
      // 记录状态失败不影响主流程
    }
  }

  private reportProgress(
    regionId: number,
    page: number,
    pages: number,
    stage: CollectProgress['stage'],
    ordersWritten: number,
  ): void {
    this.onProgress?.({ regionId, page, pages, stage, ordersWritten });
  }
}

function buildPageScopes(regionId: number): string[] {
  return Array.from({ length: MAX_PAGES_PER_REGION }, (_, index) =>
    ordersPageScope(regionId, index + 1),
  );
}

interface CollectStateInput {
  regionId: number;
  pages: number;
  requests: number;
  ordersWritten: number;
  lastError: string | null;
}

async function upsertCollectState(db: DbAdapter, input: CollectStateInput): Promise<void> {
  const now = new Date().toISOString();
  await db.execute(
    `INSERT INTO market_collect_state
       (region_id, last_started_at, last_ok_at, last_error, pages, orders_written, requests)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(region_id) DO UPDATE SET
       last_started_at = excluded.last_started_at,
       last_ok_at      = CASE WHEN excluded.last_error IS NULL THEN excluded.last_ok_at ELSE market_collect_state.last_ok_at END,
       last_error      = excluded.last_error,
       pages           = excluded.pages,
       orders_written  = excluded.orders_written,
       requests        = excluded.requests`,
    [input.regionId, now, now, input.lastError, input.pages, input.ordersWritten, input.requests],
  );
}
