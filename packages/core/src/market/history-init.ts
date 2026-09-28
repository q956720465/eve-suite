import type { DbAdapter } from '../db/types';
import type { EsiClient } from '../esi/client';
import { systemClock, type Clock } from '../esi/clock';
import type { RequestScheduler } from '../esi/scheduler';
import type { EsiErrorLimit, EsiRateLimit, MarketHistoryEntry } from '../esi/types';
import { insertRows } from '../sde/batch';

import { historyScope, saveEtags } from './etag-cache';
import {
  getHistoryBackfillStatus,
  HISTORY_BACKFILL_RETRY_DELAY_MS,
  isBackfillInterrupted,
  listBackfillPairs,
  readHistoryBackfillState,
  writeHistoryBackfillState,
  type BackfillPair,
  type HistoryBackfillState,
  type HistoryBackfillStatus,
} from './history-backfill-state';
import { HISTORY_COLUMNS, WRITE_BATCH_ROWS } from './rows';
import { HISTORY_RETENTION_DAYS, historyRetentionCutoff, pruneHistoryWindow, type MarketDeps } from './on-demand';

/**
 * 历史数据全量初始化（P5-2.8）。
 *
 * 与 P5-2.6「日常预拉」的区别：
 * - **仅手动触发**（不再有档位 / 自动周期），一次性把 5 枢纽候选的 400 天日线补满；
 * - **8 路并发拉取 + 单写者串行落库**（合批事务），把 3.6 万次 commit 降到千级；
 * - 期间由 UI 编排「独占」（暂停采集 / 全域 / 个人同步），并把调度器临时提档
 *   （`RequestScheduler.applyLimits`），结束后还原。
 *
 * 关键设计：
 * - **只写窗口内的行**（`date >= cutoff`，cutoff = 今天 - 400 天），与
 *   `refreshTypeHistory` 的增量写入不同：本模块要能把本地窗口从旧口径**补满**到 400 天，
 *   故窗口不足的 pair 会**整段 upsert**（窗口已满的 pair 才走增量，避免重复重写千万行）。
 * - **续跑判据 = 本轮锚点**：`fetched_at >= 本轮开始时刻` 的 pair 视为本轮已处理（零请求跳过）。
 *   该判据与「窗口是否已满」解耦，避免 ESI 端点返回天数（约 400）与本项目 cutoff 的
 *   微小差异导致「永远判为未满、每次续跑全量重拉」。
 * - **幂等**：同日重跑只跳过本轮已抓取的 pair；跨天后锚点变化 → 自动重抓。
 */

/** 并发拉取路数（独占期） */
export const HISTORY_INIT_CONCURRENCY = 8;

/** 合批写事务的每批 pair 数上限 */
export const HISTORY_INIT_WRITE_BATCH_PAIRS = 50;

/** 写队列背压上限（已备好待落库的 pair 数；写慢时约束拉取，避免内存堆积） */
export const HISTORY_INIT_WRITE_QUEUE_LIMIT = 200;

/** 独占期调度器起步速率（请求/秒）；限流头显示有余量时可由 UI 再提档 */
export const HISTORY_INIT_RATE_PER_SECOND = 13;

/** 独占期调度器并发上限 */
export const HISTORY_INIT_MAX_CONCURRENT = 8;

/** 独占期令牌桶容量（>= 并发数，保证 8 路能立即起步） */
export const HISTORY_INIT_BURST = 40;

/** 进度回调节流：每处理多少个 pair 上报一次 */
const PROGRESS_EVERY = 50;

/**
 * 「窗口已满」判定的容差天数。
 * ESI 端点约返回 400 天，最早日期可能略晚于本项目 cutoff（今天 - 400 天）；
 * 留 7 天容差，避免把「已补满」误判成「未满」而每次重写。
 */
const WINDOW_FULL_SLACK_DAYS = 7;

/** 单次初始化的结果摘要 */
export interface HistoryInitSummary {
  skipped: boolean;
  skipReason: string | null;
  /** 因取消在处理中途提前结束 */
  aborted: boolean;
  pairsTotal: number;
  pairsOk: number;
  pairsSkipped: number;
  pairsFailed: number;
  daysWritten: number;
  elapsedMs: number;
}

/** 初始化进度（pair 粒度） */
export interface HistoryInitProgress {
  /** 已处理 pair 数（成功 + 跳过 + 失败） */
  completed: number;
  total: number;
  pairsOk: number;
  pairsSkipped: number;
  pairsFailed: number;
  daysWritten: number;
  regionId: number;
  typeId: number;
}

export interface HistoryInitOptions {
  db: DbAdapter;
  client: EsiClient;
  scheduler: RequestScheduler;
  clock?: Clock;
  onProgress?: (progress: HistoryInitProgress) => void;
  /** 每次请求后的配额观察（供 UI 展示限流头，决定是否再提档） */
  onObserve?: (rateLimit: EsiRateLimit | null, errorLimit: EsiErrorLimit | null) => void;
  /** 取消信号：返回 true 时不再拉取新 pair（在途 pair 及待写队列照常收尾） */
  isAborted?: () => boolean;
  concurrency?: number;
  writeBatchPairs?: number;
  writeQueueLimit?: number;
}

/** 待落库的一次写入（在拉取阶段备好，交给单写者串行提交） */
type PreparedWrite =
  | { action: 'clear'; regionId: number; typeId: number; etag: string | null; fetchedAt: string }
  | { action: 'touch'; regionId: number; typeId: number; etag: string | null; fetchedAt: string }
  | {
      action: 'upsert';
      regionId: number;
      typeId: number;
      etag: string | null;
      fetchedAt: string;
      rows: unknown[][];
    };

/** 有界写队列：生产者入队（满则等待），单写者按批取出 → 背压 + 合批 */
class WriteQueue {
  private readonly items: PreparedWrite[] = [];
  private readonly spaceWaiters: Array<() => void> = [];
  private readonly itemWaiters: Array<() => void> = [];
  private closed = false;

  constructor(private readonly capacity: number) {}

  /** 生产者入队；队列满时等待（背压） */
  async put(item: PreparedWrite): Promise<void> {
    while (!this.closed && this.items.length >= this.capacity) {
      await new Promise<void>((resolve) => this.spaceWaiters.push(resolve));
    }
    if (this.closed) return;
    this.items.push(item);
    this.itemWaiters.shift()?.();
  }

  /** 单写者取一批（最多 max 个）；已关闭且取空时返回空数组 */
  async takeUpTo(max: number): Promise<PreparedWrite[]> {
    while (this.items.length === 0 && !this.closed) {
      await new Promise<void>((resolve) => this.itemWaiters.push(resolve));
    }
    const batch = this.items.splice(0, max);
    for (let index = 0; index < batch.length; index += 1) {
      this.spaceWaiters.shift()?.();
    }
    return batch;
  }

  close(): void {
    this.closed = true;
    for (const wake of this.itemWaiters.splice(0)) wake();
    for (const wake of this.spaceWaiters.splice(0)) wake();
  }
}

export class HistoryInitializer {
  private readonly db: DbAdapter;
  private readonly deps: MarketDeps;
  private readonly clock: Clock;
  private readonly onProgress: HistoryInitOptions['onProgress'];
  private readonly onObserve: HistoryInitOptions['onObserve'];
  private readonly isAbortedHook: (() => boolean) | undefined;
  private readonly concurrency: number;
  private readonly writeBatchPairs: number;
  private readonly writeQueueLimit: number;

  constructor(options: HistoryInitOptions) {
    this.db = options.db;
    this.deps = { db: options.db, client: options.client, scheduler: options.scheduler };
    this.clock = options.clock ?? systemClock;
    this.onProgress = options.onProgress;
    this.onObserve = options.onObserve;
    this.isAbortedHook = options.isAborted;
    this.concurrency = Math.max(1, options.concurrency ?? HISTORY_INIT_CONCURRENCY);
    this.writeBatchPairs = Math.max(1, options.writeBatchPairs ?? HISTORY_INIT_WRITE_BATCH_PAIRS);
    this.writeQueueLimit = Math.max(
      this.writeBatchPairs,
      options.writeQueueLimit ?? HISTORY_INIT_WRITE_QUEUE_LIMIT,
    );
  }

  /** 界面用：整轮状态 / 清单条数 */
  async status(): Promise<HistoryBackfillStatus> {
    return getHistoryBackfillStatus(this.db, this.clock.now());
  }

  /** 手动触发一次全量初始化（中断则续跑，沿用本轮锚点与累计计数） */
  async runInit(): Promise<HistoryInitSummary> {
    const startedAt = this.clock.now();
    const pairs = await listBackfillPairs(this.db);
    if (pairs.length === 0) {
      return this.skippedSummary('初始化清单为空：请先在「数据」页同步 SDE 与行情');
    }

    const state = await readHistoryBackfillState(this.db);
    const resuming = isBackfillInterrupted(state);
    const roundStartedIso = resuming
      ? (state.lastStartedAt ?? new Date(startedAt).toISOString())
      : new Date(startedAt).toISOString();

    if (!resuming) {
      await writeHistoryBackfillState(this.db, {
        ...state,
        lastStartedAt: roundStartedIso,
        lastError: null,
        retryDueAt: null,
        pairsTotal: pairs.length,
        pairsOk: 0,
        pairsSkipped: 0,
        pairsFailed: 0,
        daysWritten: 0,
        elapsedMs: 0,
      });
    }

    let pairsOk = resuming ? state.pairsOk : 0;
    let pairsSkipped = resuming ? state.pairsSkipped : 0;
    let pairsFailed = resuming ? state.pairsFailed : 0;
    let daysWritten = resuming ? state.daysWritten : 0;
    /** 续跑时累计上一段的活动耗时；本次只叠加「本段耗时」，不把空闲间隔算进来 */
    const baseElapsedMs = resuming ? state.elapsedMs : 0;
    let firstError: string | null = null;
    let aborted = false;
    let nextIndex = 0;
    let lastReported = pairsOk + pairsSkipped + pairsFailed;

    const report = (pair: BackfillPair | null, force = false): void => {
      const completed = pairsOk + pairsSkipped + pairsFailed;
      if (!force && completed - lastReported < PROGRESS_EVERY) return;
      lastReported = completed;
      this.onProgress?.({
        completed,
        total: pairs.length,
        pairsOk,
        pairsSkipped,
        pairsFailed,
        daysWritten,
        regionId: pair?.regionId ?? 0,
        typeId: pair?.typeId ?? 0,
      });
    };

    // 轮次开始即收敛一次窗口外遗留（旧口径数据）；结束再收敛一次
    await pruneHistoryWindow(this.db, startedAt);

    const queue = new WriteQueue(this.writeQueueLimit);
    const writer = (async (): Promise<void> => {
      for (;;) {
        const batch = await queue.takeUpTo(this.writeBatchPairs);
        if (batch.length === 0) return;
        try {
          await this.persistBatch(batch);
          for (const item of batch) {
            pairsOk += 1;
            daysWritten += item.action === 'upsert' ? item.rows.length : 0;
          }
        } catch (error) {
          pairsFailed += batch.length;
          if (firstError === null) firstError = errorMessage(error);
        }
        report(null);
      }
    })();

    const worker = async (): Promise<void> => {
      for (;;) {
        if (this.isAbortedHook?.() === true) {
          aborted = true;
          break;
        }
        const index = nextIndex;
        nextIndex += 1;
        if (index >= pairs.length) break;

        const pair = pairs[index];
        try {
          const prepared = await this.fetchAndPrepare(pair, roundStartedIso);
          if (prepared === null) {
            pairsSkipped += 1;
          } else {
            await queue.put(prepared);
          }
        } catch (error) {
          pairsFailed += 1;
          if (firstError === null) firstError = errorMessage(error);
        }
        report(pair);
      }
    };

    await Promise.all(Array.from({ length: this.concurrency }, () => worker()));
    queue.close();
    await writer;

    const finishedAt = this.clock.now();
    await pruneHistoryWindow(this.db, finishedAt);

    const processed = pairsOk + pairsSkipped + pairsFailed;
    const allOk = pairsFailed === 0 && processed === pairs.length;
    const retryDueAt = allOk
      ? null
      : new Date(pairsFailed > 0 ? finishedAt + HISTORY_BACKFILL_RETRY_DELAY_MS : finishedAt)
          .toISOString();

    const nextState: HistoryBackfillState = {
      lastStartedAt: roundStartedIso,
      lastFinishedAt: new Date(finishedAt).toISOString(),
      lastFullOkAt: allOk ? new Date(finishedAt).toISOString() : state.lastFullOkAt,
      lastError: firstError,
      retryDueAt,
      pairsTotal: pairs.length,
      pairsOk,
      pairsSkipped,
      pairsFailed,
      daysWritten,
      elapsedMs: baseElapsedMs + (finishedAt - startedAt),
    };
    await writeHistoryBackfillState(this.db, nextState);

    report(null, true);

    return {
      skipped: false,
      skipReason: null,
      aborted,
      pairsTotal: pairs.length,
      pairsOk,
      pairsSkipped,
      pairsFailed,
      daysWritten,
      elapsedMs: nextState.elapsedMs,
    };
  }

  /**
   * 拉取并备好一次写入；返回 null 表示本轮已处理过（零请求跳过）。
   *
   * 续跑判据用 `fetched_at >= roundStartedIso`（本轮锚点），与窗口是否已满解耦。
   */
  private async fetchAndPrepare(
    pair: BackfillPair,
    roundStartedIso: string,
  ): Promise<PreparedWrite | null> {
    const now = this.clock.now();
    const cutoff = historyRetentionCutoff(now);
    const fullCutoff = new Date(
      now - (HISTORY_RETENTION_DAYS - WINDOW_FULL_SLACK_DAYS) * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);

    const stats = await this.db.select<{
      maxDate: string | null;
      minDate: string | null;
      fetchedAt: string | null;
    }>(
      `SELECT MAX(date) AS maxDate, MIN(date) AS minDate, MAX(fetched_at) AS fetchedAt
         FROM market_history_daily WHERE region_id = ? AND type_id = ?`,
      [pair.regionId, pair.typeId],
    );
    const maxDate = stats[0]?.maxDate ?? null;
    const minDate = stats[0]?.minDate ?? null;
    const fetchedAt = stats[0]?.fetchedAt ?? null;
    const today = new Date(now).toISOString().slice(0, 10);
    const windowFull = minDate !== null && minDate <= fullCutoff;
    const fetchedToday = fetchedAt !== null && fetchedAt.slice(0, 10) === today;

    // 本轮已处理 → 零请求跳过；当日且窗口已满 → 同样跳过（同日重跑幂等）
    if (fetchedAt !== null && (fetchedAt >= roundStartedIso || (fetchedToday && windowFull))) {
      return null;
    }

    // **不发条件请求**：初始化必须拿到完整响应体，才能把本地窗口补满到 400 天。
    // 若带缓存 ETag，ESI 会回 304（数据未变）→ 拿不到 body → 无法补写更早的日期。
    // 实测：上一轮 90 天口径的 pair 全部命中 304，窗口永远补不满。
    // 初始化是稀有手动操作，放弃 304 优化是值得的；返回的 ETag 仍写入缓存供按需校验复用。
    const result = await this.deps.scheduler.run('ondemand', () =>
      this.deps.client.fetchTypeHistory(pair.regionId, pair.typeId),
    );
    this.deps.scheduler.observe(result.rateLimit, result.errorLimit);
    this.onObserve?.(result.rateLimit, result.errorLimit);

    const fetchedAtIso = new Date(this.clock.now()).toISOString();
    const etag = result.etag ?? null;

    // 防御：未发条件请求时不应出现 304；一旦出现，仅刷新抓取时间，绝不当成「空历史」清空
    if (result.notModified) {
      return { action: 'touch', regionId: pair.regionId, typeId: pair.typeId, etag, fetchedAt: fetchedAtIso };
    }

    const entries: MarketHistoryEntry[] = result.data ?? [];
    const kept = entries.filter((entry) => entry.date >= cutoff);
    if (kept.length === 0) {
      // 窗口内无成交：清空该 pair（与「空历史」语义一致）
      return { action: 'clear', regionId: pair.regionId, typeId: pair.typeId, etag, fetchedAt: fetchedAtIso };
    }

    // 窗口不足（首次 / 旧口径）→ 整段补满；窗口已满 → 只写新增日期（含当天覆盖）
    const fresh = windowFull && maxDate !== null ? kept.filter((entry) => entry.date >= maxDate) : kept;
    if (fresh.length === 0) {
      return { action: 'touch', regionId: pair.regionId, typeId: pair.typeId, etag, fetchedAt: fetchedAtIso };
    }

    const rows: unknown[][] = fresh.map((entry) => [
      pair.regionId,
      pair.typeId,
      entry.date,
      entry.average,
      entry.highest,
      entry.lowest,
      entry.order_count,
      entry.volume,
      fetchedAtIso,
    ]);
    return {
      action: 'upsert',
      regionId: pair.regionId,
      typeId: pair.typeId,
      etag,
      fetchedAt: fetchedAtIso,
      rows,
    };
  }

  /** 单写者：一个事务内按序落库整批 pair（含 per-pair 窗口裁剪与 ETag 保存） */
  private async persistBatch(batch: PreparedWrite[]): Promise<void> {
    const cutoff = historyRetentionCutoff(this.clock.now());
    await this.db.transaction(async (tx) => {
      for (const item of batch) {
        if (item.action === 'clear') {
          await tx.execute(
            'DELETE FROM market_history_daily WHERE region_id = ? AND type_id = ?',
            [item.regionId, item.typeId],
          );
        } else if (item.action === 'touch') {
          await tx.execute(
            `UPDATE market_history_daily SET fetched_at = ?
              WHERE region_id = ? AND type_id = ?
                AND date = (SELECT MAX(date) FROM market_history_daily
                             WHERE region_id = ? AND type_id = ?)`,
            [item.fetchedAt, item.regionId, item.typeId, item.regionId, item.typeId],
          );
        } else {
          await insertRows(tx, 'market_history_daily', HISTORY_COLUMNS, item.rows, WRITE_BATCH_ROWS, {
            target: ['region_id', 'type_id', 'date'],
            update: HISTORY_COLUMNS.filter(
              (column) => column !== 'region_id' && column !== 'type_id' && column !== 'date',
            ),
          });
          await tx.execute(
            'DELETE FROM market_history_daily WHERE region_id = ? AND type_id = ? AND date < ?',
            [item.regionId, item.typeId, cutoff],
          );
        }

        if (item.etag !== null) {
          await saveEtags(
            tx,
            new Map([[historyScope(item.regionId, item.typeId), item.etag]]),
            item.fetchedAt,
          );
        }
      }
    });
  }

  private skippedSummary(reason: string): HistoryInitSummary {
    return {
      skipped: true,
      skipReason: reason,
      aborted: false,
      pairsTotal: 0,
      pairsOk: 0,
      pairsSkipped: 0,
      pairsFailed: 0,
      daysWritten: 0,
      elapsedMs: 0,
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
