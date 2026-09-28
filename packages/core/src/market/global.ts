import type { DbAdapter } from '../db/types';
import type { EsiClient } from '../esi/client';
import { systemClock, type Clock } from '../esi/clock';
import type { RequestScheduler } from '../esi/scheduler';
import type { EsiResult, MarketOrder } from '../esi/types';
import { insertRows } from '../sde/batch';

import {
  getGlobalScanStatus,
  GLOBAL_SCAN_RETRY_DELAY_MS,
  isScanDue,
  isScanInterrupted,
  listGlobalScanRegionIds,
  readGlobalScanState,
  readGlobalScanTier,
  writeGlobalScanState,
  type GlobalScanState,
  type GlobalScanStatus,
  type GlobalScanTier,
} from './global-state';
import { MAX_PAGES_PER_REGION } from './hubs';
import { ORDER_COLUMNS, STATS_COLUMNS, WRITE_BATCH_ROWS, toOrderRow, toStatsRow } from './rows';
import { computeMarketStats } from './stats';

/** 单个区域的全域采集结果 */
export interface GlobalRegionResult {
  regionId: number;
  pages: number;
  requests: number;
  ordersWritten: number;
  statsWritten: number;
  elapsedMs: number;
  error: string | null;
}

/** 全域扫描进度（区域粒度 + 页粒度） */
export interface GlobalScanProgress {
  regionId: number;
  /** 本轮已完成区域数（含续扫时跳过的已完成区域） */
  completedRegions: number;
  totalRegions: number;
  page: number;
  pages: number;
  stage: 'orders' | 'done';
  ordersWritten: number;
}

/** 单次全域扫描（可能是续扫）的结果摘要 */
export interface GlobalScanSummary {
  /** 未发起任何请求时为 true（未到期 / 已暂停 / 缺少区域清单） */
  skipped: boolean;
  skipReason: string | null;
  tier: GlobalScanTier;
  /** 因暂停在区域边界提前结束 */
  aborted: boolean;
  regionsTotal: number;
  /** 本轮已完成区域数（含续扫跳过的） */
  regionsOk: number;
  regionsFailed: number;
  /** 续扫时跳过的「本轮已完成」区域数 */
  regionsResumed: number;
  requests: number;
  ordersWritten: number;
  elapsedMs: number;
  results: GlobalRegionResult[];
}

export interface GlobalScannerOptions {
  db: DbAdapter;
  client: EsiClient;
  scheduler: RequestScheduler;
  clock?: Clock;
  onProgress?: (progress: GlobalScanProgress) => void;
  /** 暂停信号：返回 true 时在当前区域收尾后停止（部分完成、可续扫） */
  isPaused?: () => boolean;
}

interface ScanContext {
  completedRegions: number;
  totalRegions: number;
}

/**
 * 全域层采集器（方案 §4.1 的「全域 6 小时层」）。
 *
 * 与枢纽层的差异：
 * - **不使用 ETag 条件请求**：全域间隔（≥3h）远大于 ESI 订单端点的 5 分钟缓存，
 *   条件请求几乎必然返回 200，只是多一轮往返；且可避免为上百个区域预载上万个
 *   ETag 作用域（`market_etag_cache` 的按页查询会撑爆 IN 占位符）。
 * - **不做整轮跳过**：每个区域独立判定 → 独立替换；单区域失败只影响该区域。
 * - **断点续扫**：以「本轮开始时刻」为锚点，只采集本轮尚未成功（`last_ok_at` 早于锚点）
 *   的区域；应用被杀 / 暂停后重启可继续，不重复拉取已完成区域。
 * - **让路 = 请求优先级**（方案 §4.1「全域任务遇到枢纽 5 分钟周期时让路，请求队列设优先级」）：
 *   全域请求一律以 `global` 优先级入队（低于枢纽层），枢纽轮次的请求始终先派发，峰值不叠加。
 *
 * 为什么不做「区域级等待枢纽轮次结束」：实测（2026-09-28）枢纽一轮可占满整个 5 分钟周期，
 * 区域级等待会把全域轮次切成极小的时间片（10 分钟只推进 1 个区域）→ 反而饿死全域轮次。
 * 写入争用由 DB-1 的瞬时锁退避重试（`db/retry.ts` 接线在 `db/tauri.ts`）兜住。
 */
export class GlobalMarketScanner {
  private readonly db: DbAdapter;
  private readonly client: EsiClient;
  private readonly scheduler: RequestScheduler;
  private readonly clock: Clock;
  private readonly onProgress: GlobalScannerOptions['onProgress'];
  private readonly isPausedHook: (() => boolean) | undefined;

  constructor(options: GlobalScannerOptions) {
    this.db = options.db;
    this.client = options.client;
    this.scheduler = options.scheduler;
    this.clock = options.clock ?? systemClock;
    this.onProgress = options.onProgress;
    this.isPausedHook = options.isPaused;
  }

  /** 界面用：档位 / 整轮状态 / 下次到期 / 覆盖区域数 */
  async status(): Promise<GlobalScanStatus> {
    return getGlobalScanStatus(this.db, this.clock.now());
  }

  /** 到期才扫描（应用启动与定时检查的入口） */
  async runDueScan(): Promise<GlobalScanSummary> {
    return this.runScan({ force: false });
  }

  /** 扫描一轮：`force` = 忽略档位到期判定与续扫过滤，重扫全部区域（手动「立即扫描」） */
  async runScan(options: { force?: boolean } = {}): Promise<GlobalScanSummary> {
    const startedAt = this.clock.now();
    const tier = await readGlobalScanTier(this.db);
    const forced = options.force === true;

    if (this.isPausedNow()) {
      return this.skippedSummary(tier, '已暂停采集');
    }

    const state = await readGlobalScanState(this.db);
    if (!forced && !isScanDue({ state, tier, now: startedAt })) {
      return this.skippedSummary(tier, '未到扫描周期');
    }

    const regionIds = await listGlobalScanRegionIds(this.db);
    if (regionIds.length === 0) {
      return this.skippedSummary(tier, '区域清单为空：请先在「数据」页同步 SDE');
    }

    // 续扫判定：上一轮未收尾（应用被杀 / 页面重载）或存在待重试 → 沿用本轮锚点。
    // 锚点即「本轮开始时刻」，据此跳过本轮已成功的区域。
    // 手动 force 不续扫：按全新整轮处理（否则刚扫完立即点「立即扫描」会无事发生）。
    const resuming =
      !forced && (isScanInterrupted(state) || state.retryDueAt !== null);
    const anchorMs =
      resuming && state.lastStartedAt !== null ? Date.parse(state.lastStartedAt) : startedAt;
    const roundStartedIso = resuming
      ? (state.lastStartedAt ?? new Date(startedAt).toISOString())
      : new Date(startedAt).toISOString();

    if (!resuming) {
      // 新一轮：锚点 / 计数归零，避免展示上一轮残留
      await writeGlobalScanState(this.db, {
        ...state,
        lastStartedAt: roundStartedIso,
        lastError: null,
        retryDueAt: null,
        regionsTotal: regionIds.length,
        regionsOk: 0,
        regionsFailed: 0,
        requests: 0,
        ordersWritten: 0,
        elapsedMs: 0,
      });
    }

    const okAt = await loadRegionOkTimes(this.db, regionIds);
    const pending = forced
      ? [...regionIds]
      : regionIds.filter((regionId) => !isCollectedSince(okAt.get(regionId), anchorMs));

    const ctx: ScanContext = {
      completedRegions: regionIds.length - pending.length,
      totalRegions: regionIds.length,
    };

    const results: GlobalRegionResult[] = [];
    let attemptRequests = 0;
    let attemptOrders = 0;
    let aborted = false;

    for (const regionId of pending) {
      if (this.isPausedNow()) {
        aborted = true;
        break;
      }

      const result = await this.scanRegion(regionId, ctx);
      results.push(result);
      attemptRequests += result.requests;
      attemptOrders += result.ordersWritten;
      ctx.completedRegions += 1;
    }

    const finishedAt = this.clock.now();
    const failedRegions = results.filter((result) => result.error !== null).length;
    const completedRegions = ctx.completedRegions;
    const allOk = failedRegions === 0 && completedRegions === regionIds.length;
    const firstError = results.find((result) => result.error !== null)?.error ?? null;

    const carriedRequests = resuming ? state.requests : 0;
    const carriedOrders = resuming ? state.ordersWritten : 0;
    const retryDueAt = allOk
      ? null
      : new Date(
          failedRegions > 0 ? finishedAt + GLOBAL_SCAN_RETRY_DELAY_MS : finishedAt,
        ).toISOString();

    const nextState: GlobalScanState = {
      lastStartedAt: roundStartedIso,
      lastFinishedAt: new Date(finishedAt).toISOString(),
      lastFullOkAt: allOk ? new Date(finishedAt).toISOString() : state.lastFullOkAt,
      lastError: firstError,
      retryDueAt,
      regionsTotal: regionIds.length,
      regionsOk: completedRegions - failedRegions,
      regionsFailed: failedRegions,
      requests: carriedRequests + attemptRequests,
      ordersWritten: carriedOrders + attemptOrders,
      elapsedMs: finishedAt - anchorMs,
    };
    await writeGlobalScanState(this.db, nextState);

    return {
      skipped: false,
      skipReason: null,
      tier,
      aborted,
      regionsTotal: regionIds.length,
      regionsOk: nextState.regionsOk,
      regionsFailed: failedRegions,
      regionsResumed: regionIds.length - pending.length,
      requests: attemptRequests,
      ordersWritten: attemptOrders,
      elapsedMs: nextState.elapsedMs,
      results,
    };
  }

  /** 采集单个区域：全量分页 → 去重 → 单事务整区替换订单与聚合指标 */
  private async scanRegion(regionId: number, ctx: ScanContext): Promise<GlobalRegionResult> {
    const startedAt = this.clock.now();
    try {
      const firstPage = await this.fetchPage(regionId, 1);
      if (firstPage.notModified) {
        throw new Error('收到意外的 304（全域层未发条件请求）');
      }
      const totalPages = Math.max(
        1,
        Math.min(firstPage.pages ?? 1, MAX_PAGES_PER_REGION),
      );

      const pages: MarketOrder[][] = new Array<MarketOrder[]>(totalPages);
      pages[0] = firstPage.data ?? [];
      let requests = 1;
      this.reportProgress(regionId, ctx, 1, totalPages, 'orders', 0);

      if (totalPages > 1) {
        const pageNumbers = Array.from({ length: totalPages - 1 }, (_, index) => index + 2);
        let completed = 1;
        const fetched = await Promise.all(
          pageNumbers.map(async (page) => ({ page, result: await this.fetchPage(regionId, page) })),
        );
        for (const { page, result } of fetched) {
          if (result.notModified) {
            throw new Error('收到意外的 304（全域层未发条件请求）');
          }
          pages[page - 1] = result.data ?? [];
          completed += 1;
          if (completed % 25 === 0 || completed === totalPages) {
            this.reportProgress(regionId, ctx, completed, totalPages, 'orders', 0);
          }
        }
        requests += fetched.length;
      }

      // 按 order_id 去重（保留最后一次出现）：同区域跨页漂移时同一订单可能被两份页同时包含，
      // 而 market_orders.order_id 是单列主键（踩坑 #29）
      const rawOrders: MarketOrder[] = [];
      for (const page of pages) rawOrders.push(...page);
      const uniqueOrders = [...new Map(rawOrders.map((order) => [order.order_id, order])).values()];

      const now = this.clock.now();
      const fetchedAt = new Date(now).toISOString();
      const stats = computeMarketStats(uniqueOrders, regionId, fetchedAt);
      const orderRows = uniqueOrders.map((order) => toOrderRow(order, regionId, fetchedAt));
      const statsRows = stats.map(toStatsRow);

      await this.db.transaction(async (tx) => {
        await tx.execute('DELETE FROM market_orders WHERE region_id = ?', [regionId]);
        await insertRows(tx, 'market_orders', ORDER_COLUMNS, orderRows, WRITE_BATCH_ROWS, {
          target: ['order_id'],
          update: ORDER_COLUMNS.filter((column) => column !== 'order_id'),
        });

        await tx.execute('DELETE FROM market_stats WHERE region_id = ?', [regionId]);
        await insertRows(tx, 'market_stats', STATS_COLUMNS, statsRows, WRITE_BATCH_ROWS);

        await upsertRegionState(tx, {
          regionId,
          now,
          pages: totalPages,
          requests,
          ordersWritten: orderRows.length,
          lastError: null,
        });
      });

      this.reportProgress(regionId, ctx, totalPages, totalPages, 'done', orderRows.length);

      return {
        regionId,
        pages: totalPages,
        requests,
        ordersWritten: orderRows.length,
        statsWritten: statsRows.length,
        elapsedMs: this.clock.now() - startedAt,
        error: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.recordRegionFailure(regionId, message);
      return {
        regionId,
        pages: 0,
        requests: 0,
        ordersWritten: 0,
        statsWritten: 0,
        elapsedMs: this.clock.now() - startedAt,
        error: message,
      };
    }
  }

  /** 全域层请求：`global` 优先级 + 不带条件请求头 */
  private async fetchPage(regionId: number, page: number): Promise<EsiResult<MarketOrder[]>> {
    const result = await this.scheduler.run('global', () =>
      this.client.fetchRegionOrders(regionId, page),
    );
    this.scheduler.observe(result.rateLimit, result.errorLimit);
    return result;
  }

  private isPausedNow(): boolean {
    return this.isPausedHook?.() ?? false;
  }

  private async recordRegionFailure(regionId: number, message: string): Promise<void> {
    try {
      const now = this.clock.now();
      await upsertRegionState(this.db, {
        regionId,
        now,
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
    ctx: ScanContext,
    page: number,
    pages: number,
    stage: GlobalScanProgress['stage'],
    ordersWritten: number,
  ): void {
    this.onProgress?.({
      regionId,
      completedRegions: ctx.completedRegions,
      totalRegions: ctx.totalRegions,
      page,
      pages,
      stage,
      ordersWritten,
    });
  }

  private async skippedSummary(tier: GlobalScanTier, reason: string): Promise<GlobalScanSummary> {
    return {
      skipped: true,
      skipReason: reason,
      tier,
      aborted: false,
      regionsTotal: 0,
      regionsOk: 0,
      regionsFailed: 0,
      regionsResumed: 0,
      requests: 0,
      ordersWritten: 0,
      elapsedMs: 0,
      results: [],
    };
  }
}

interface RegionStateInput {
  regionId: number;
  /** 当前时刻（毫秒，取自注入时钟） */
  now: number;
  pages: number;
  requests: number;
  ordersWritten: number;
  lastError: string | null;
}

/**
 * 写单区域水位（复用枢纽层的 `market_collect_state`）。
 *
 * 成功时推进 `last_ok_at`，失败时**不推进**（新行留 NULL、已有行保持原值）——
 * 这正是断点续扫 / 失败只重试的判据：`last_ok_at` 早于本轮锚点 = 本轮尚未成功。
 * 若失败也写入成功时刻，失败区域会被误判为「本轮已完成」而永不重试。
 */
async function upsertRegionState(db: DbAdapter, input: RegionStateInput): Promise<void> {
  const now = new Date(input.now).toISOString();
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
    [
      input.regionId,
      now,
      input.lastError === null ? now : null,
      input.lastError,
      input.pages,
      input.ordersWritten,
      input.requests,
    ],
  );
}

/** 逐区域取上次成功水位 */
async function loadRegionOkTimes(
  db: DbAdapter,
  regionIds: readonly number[],
): Promise<Map<number, string | null>> {
  if (regionIds.length === 0) return new Map();
  const placeholders = regionIds.map(() => '?').join(', ');
  const rows = await db.select<{ regionId: number; lastOkAt: string | null }>(
    `SELECT region_id AS regionId, last_ok_at AS lastOkAt
       FROM market_collect_state
      WHERE region_id IN (${placeholders})`,
    regionIds,
  );
  return new Map(rows.map((row) => [row.regionId, row.lastOkAt]));
}

/** 该区域是否已在本轮成功采集过（时间戳非法一律视为未采集） */
function isCollectedSince(lastOkAt: string | null | undefined, anchorMs: number): boolean {
  if (lastOkAt === null || lastOkAt === undefined) return false;
  const ms = Date.parse(lastOkAt);
  return Number.isFinite(ms) && ms >= anchorMs;
}
