import type { DbAdapter } from '../db/types';
import type { EsiClient } from '../esi/client';
import { systemClock, type Clock } from '../esi/clock';
import type { RequestScheduler } from '../esi/scheduler';

import {
  getHistoryBackfillStatus,
  HISTORY_BACKFILL_RETRY_DELAY_MS,
  isBackfillDue,
  isBackfillInterrupted,
  listBackfillPairs,
  readHistoryBackfillState,
  readHistoryBackfillTier,
  writeHistoryBackfillState,
  type HistoryBackfillState,
  type HistoryBackfillStatus,
  type HistoryBackfillTier,
} from './history-backfill-state';
import { historyRetentionCutoff, refreshTypeHistory, type MarketDeps } from './on-demand';

/**
 * 枢纽历史基线预拉（P5-2.6）。
 *
 * 目标：把 5 枢纽的日线历史预拉到本地，使价差页的历史校验对枢纽候选**零等待**。
 * 预拉不到的候选（非枢纽侧）仍由 `validateSpreadHistory` 按需拉取兜底。
 *
 * 设计要点：
 * - **周期 24h 而非 6h**：ESI 日线一天只新增 1 天，端点自身 `Expires` 到次日；
 *   更高频拿不到新数据，纯浪费请求。
 * - **让路 = `global` 优先级**：与全域订单轮次同级，低于枢纽层 / 按需 / 个人数据。
 * - **匀速节拍限速**（默认 5 req/s）：令牌桶 10 req/s 是全局共享的，枢纽层实测约占
 *   3 req/s —— 预拉只借一部分，给全域轮次突发与个人同步留余量；同时避免「每秒十余次
 *   写事务」与枢纽的整区替换争抢写锁（DB-1 已实测大事务期间其他写者会等到 10 秒级）。
 * - **串行逐个提交**：调度器每次 `run()` 都会对整个队列重排（O(n log n)），
 *   把上万条请求一次性入队会拖住渲染进程 —— 必须「取一个 → 等完成 → 再取下一个」。
 * - **幂等与断点续跑零成本**：`refreshTypeHistory` 内部的「当日已抓取」判定
 *   （`market_history_daily.fetched_at`）天然提供 —— 中途被杀 / 暂停后重启，
 *   已拉过的自动跳过；跨天后自动重拉。故**不需要水位列**。
 */

/** 预拉的目标速率（请求/秒）：匀速节拍，不是硬上限（单次处理更慢时自然降速） */
export const HISTORY_BACKFILL_RATE_PER_SECOND = 5;

/** 进度回调节流：每处理多少个 pair 上报一次（避免上万次 setState） */
const PROGRESS_EVERY = 50;

/** 单次预拉（可能是续跑）的结果摘要 */
export interface HistoryBackfillSummary {
  /** 未发起任何请求时为 true（未到期 / 已暂停 / 清单为空） */
  skipped: boolean;
  skipReason: string | null;
  tier: HistoryBackfillTier;
  /** 因暂停在处理中途提前结束 */
  aborted: boolean;
  pairsTotal: number;
  pairsOk: number;
  pairsSkipped: number;
  pairsFailed: number;
  daysWritten: number;
  elapsedMs: number;
}

/** 预拉进度（pair 粒度） */
export interface HistoryBackfillProgress {
  /** 已处理 pair 数（含跳过与失败） */
  completed: number;
  total: number;
  regionId: number;
  typeId: number;
  pairsOk: number;
  pairsSkipped: number;
  pairsFailed: number;
}

export interface HistoryBackfillOptions {
  db: DbAdapter;
  client: EsiClient;
  scheduler: RequestScheduler;
  clock?: Clock;
  onProgress?: (progress: HistoryBackfillProgress) => void;
  /** 暂停信号：返回 true 时在处理完当前 pair 后停止（可续跑） */
  isPaused?: () => boolean;
  /** 目标速率（请求/秒）；测试可传极大值以关闭节拍等待 */
  ratePerSecond?: number;
}

export class HistoryBackfill {
  private readonly db: DbAdapter;
  private readonly deps: MarketDeps;
  private readonly clock: Clock;
  private readonly onProgress: HistoryBackfillOptions['onProgress'];
  private readonly isPausedHook: (() => boolean) | undefined;
  private readonly ratePerSecond: number;

  constructor(options: HistoryBackfillOptions) {
    this.db = options.db;
    this.deps = { db: options.db, client: options.client, scheduler: options.scheduler };
    this.clock = options.clock ?? systemClock;
    this.onProgress = options.onProgress;
    this.isPausedHook = options.isPaused;
    this.ratePerSecond = options.ratePerSecond ?? HISTORY_BACKFILL_RATE_PER_SECOND;
  }

  /** 界面用：档位 / 整轮状态 / 下次到期 / 清单条数 */
  async status(): Promise<HistoryBackfillStatus> {
    return getHistoryBackfillStatus(this.db, this.clock.now());
  }

  /** 到期才预拉（应用启动与定时检查的入口） */
  async runDueScan(): Promise<HistoryBackfillSummary> {
    return this.runScan({ force: false });
  }

  /**
   * 预拉一轮。
   *
   * `force` = **忽略档位到期判定**（手动「立即预拉」）；但**不强制重拉当天已抓取的 pair**
   * —— 日线数据当天不会变，重拉只是白耗流量与写事务。
   */
  async runScan(options: { force?: boolean } = {}): Promise<HistoryBackfillSummary> {
    const startedAt = this.clock.now();
    const tier = await readHistoryBackfillTier(this.db);
    const forced = options.force === true;

    if (this.isPausedNow()) {
      return this.skippedSummary(tier, '已暂停采集');
    }
    if (!forced && tier === 'off') {
      return this.skippedSummary(tier, '预拉已关闭');
    }

    const state = await readHistoryBackfillState(this.db);
    if (!forced && !isBackfillDue({ state, tier, now: startedAt })) {
      return this.skippedSummary(tier, '未到预拉周期');
    }

    const pairs = await listBackfillPairs(this.db);
    if (pairs.length === 0) {
      return this.skippedSummary(tier, '预拉清单为空：请先在「数据」页同步 SDE 与行情');
    }

    // 续跑判定：上一轮未收尾（应用被杀 / 页面重载）或存在待重试 → 沿用本轮锚点与累计计数。
    // 手动 force 按全新一轮处理（否则刚跑完立即点「立即预拉」会显示上一轮残留数字）。
    const resuming = !forced && (isBackfillInterrupted(state) || state.retryDueAt !== null);
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
    let firstError: string | null = null;
    let aborted = false;

    // 轮次开始即收敛一次：清理升级前遗留的窗口外行（被跳过的 pair 不会走写入路径，
    // 而整轮可能跑很久，等到收尾才裁会让库体积长时间偏大）
    await this.pruneHistoryWindow(startedAt);

    for (let index = 0; index < pairs.length; index += 1) {
      if (this.isPausedNow()) {
        aborted = true;
        break;
      }

      const pair = pairs[index];
      try {
        // 不传 force：当天已拉过的 pair 由 refreshTypeHistory 内部直接跳过（零请求）
        const result = await refreshTypeHistory(this.deps, pair.regionId, pair.typeId, {
          priority: 'global',
          now: this.clock.now(),
        });
        if (result.skipped) {
          pairsSkipped += 1;
        } else {
          pairsOk += 1;
          daysWritten += result.daysWritten;
        }
      } catch (error) {
        pairsFailed += 1;
        if (firstError === null) {
          firstError = error instanceof Error ? error.message : String(error);
        }
      }

      const completed = index + 1;
      if (completed % PROGRESS_EVERY === 0 || completed === pairs.length) {
        this.reportProgress(completed, pairs.length, pair, pairsOk, pairsSkipped, pairsFailed);
      }

      await this.throttle(completed, startedAt);
    }

    const finishedAt = this.clock.now();
    await this.pruneHistoryWindow(finishedAt);

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
      elapsedMs: finishedAt - Date.parse(roundStartedIso),
    };
    await writeHistoryBackfillState(this.db, nextState);

    return {
      skipped: false,
      skipReason: null,
      tier,
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
   * 匀速节拍：第 `processed` 个 pair 应在 `startedAt + processed / rate` 之前完成。
   * 处理比目标快则补睡差额；比目标慢则不等（自然降速，不追赶堆积）。
   *
   * 走注入的 `Clock.sleep`（与 `RequestScheduler` 同一约定）：测试用假时钟可瞬间跑完
   * 且能断言等待时长。
   */
  private async throttle(processed: number, startedAt: number): Promise<void> {
    if (!Number.isFinite(this.ratePerSecond) || this.ratePerSecond <= 0) return;
    const targetAt = startedAt + (processed * 1000) / this.ratePerSecond;
    const wait = targetAt - this.clock.now();
    if (wait > 0) await this.clock.sleep(wait);
  }

  /**
   * 全局裁剪：把 `market_history_daily` 收敛到保留窗口内（P5-2.7）。
   *
   * 为什么需要它（而不是只在写入路径裁）：被「当日已抓取」跳过的 pair 根本不进写入路径，
   * 单靠 per-pair 裁剪永远清不掉它们的历史遗留（升级前的 400 天数据）。
   * 单条 SQL、一次写事务；日常只影响滚出窗口的少量行。
   */
  private async pruneHistoryWindow(now: number): Promise<void> {
    try {
      await this.db.execute('DELETE FROM market_history_daily WHERE date < ?', [
        historyRetentionCutoff(now),
      ]);
    } catch {
      // 裁剪失败不影响主流程（下一轮再试）
    }
  }

  private isPausedNow(): boolean {
    return this.isPausedHook?.() ?? false;
  }

  private reportProgress(
    completed: number,
    total: number,
    pair: { regionId: number; typeId: number },
    pairsOk: number,
    pairsSkipped: number,
    pairsFailed: number,
  ): void {
    this.onProgress?.({
      completed,
      total,
      regionId: pair.regionId,
      typeId: pair.typeId,
      pairsOk,
      pairsSkipped,
      pairsFailed,
    });
  }

  private skippedSummary(tier: HistoryBackfillTier, reason: string): HistoryBackfillSummary {
    return {
      skipped: true,
      skipReason: reason,
      tier,
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
