/**
 * 历史数据全量初始化（P5-2.8）的应用级编排。
 *
 * 逻辑在 core（`HistoryInitializer`：8 路并发拉 / 单写者合批写 / 本轮锚点续跑 /
 * 失败隔离 / 取消）。本 Hook 负责：
 * - **仅手动触发**（无自动档位、无 60s 定时），并做「独占」编排：
 *   暂停采集与个人同步（**轮级**）→ 等在途轮次收尾 → 提档调度器 → 跑 → 还原并恢复；
 * - 启动时做一次全局窗口裁剪（旧口径遗留），并在收尾压缩 WAL；
 * - 状态、进度、取消与可选 VACUUM。
 *
 * 绝不用 `RequestScheduler.pause()` 做独占：它是请求级，会压死在途轮次（踩坑 #30）。
 */

import {
  HISTORY_INIT_BURST,
  HISTORY_INIT_MAX_CONCURRENT,
  HISTORY_INIT_RATE_PER_SECOND,
  HistoryInitializer,
  pruneHistoryWindow,
  type HistoryBackfillStatus,
  type HistoryInitProgress,
  type HistoryInitSummary,
} from '@eve-suite/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import { initCoreRuntime } from '../core/runtime';

/** 等待在途采集轮次收尾的最长时间（枢纽轮次可达 4~5 分钟） */
const WAIT_IDLE_TIMEOUT_MS = 5 * 60_000;
const WAIT_IDLE_POLL_MS = 1_000;

/** 最近一次观察到的 ESI 配额头（用于确认能否再提档，以及错误预算安全） */
export interface ObservedLimits {
  /** X-Ratelimit-Remaining（history 端点若启用限流才有值） */
  rateRemaining: number | null;
  /** X-Ratelimit-Limit */
  rateLimit: string | null;
  /** X-Esi-Error-Limit-Remain */
  errorRemaining: number | null;
}

export interface HistoryInitHandle {
  status: HistoryBackfillStatus | null;
  busy: boolean;
  message: string;
  progress: HistoryInitProgress | null;
  /** 取消信号已置位：拉取将处理完当前 pair 后收尾 */
  aborting: boolean;
  /** 最近观察到的配额头 */
  limits: ObservedLimits;
  /** 手动运行一次全量初始化（中断则自动续跑） */
  runInit: () => Promise<void>;
  /** 请求取消（可续跑） */
  cancel: () => void;
  /** 只重读状态，不发请求 */
  refresh: () => Promise<void>;
  /** 压缩数据库回收空闲页（会短暂持写锁） */
  vacuum: () => Promise<void>;
}

export interface HistoryInitHookOptions {
  pauseCollection: () => void;
  resumeCollection: () => void;
  isCollectionPaused: () => boolean;
  isCollectionBusy: () => boolean;
  pausePersonalSync: () => void;
  resumePersonalSync: () => void;
  isPersonalPaused: () => boolean;
}

const EMPTY_LIMITS: ObservedLimits = { rateRemaining: null, rateLimit: null, errorRemaining: null };

function describeSummary(summary: HistoryInitSummary): string {
  if (summary.skipped) return `未发起初始化：${summary.skipReason ?? '无需初始化'}`;
  const okLabel =
    summary.pairsEmpty > 0
      ? `更新 ${summary.pairsOk.toLocaleString()} 条（其中 ${summary.pairsEmpty.toLocaleString()} 条该区无可用历史）`
      : `更新 ${summary.pairsOk.toLocaleString()} 条`;
  const parts = [
    okLabel,
    `跳过 ${summary.pairsSkipped.toLocaleString()} 条（本轮已处理）`,
    `写入 ${summary.daysWritten.toLocaleString()} 行日线`,
    `耗时 ${Math.round(summary.elapsedMs / 1000)} 秒`,
  ];
  if (summary.pairsFailed > 0) parts.push(`${summary.pairsFailed} 条失败`);
  if (summary.aborted) parts.push('已取消（可继续）');
  return parts.join(' · ');
}

/** 轮询等待在途采集轮次收尾；超时或取消则提前返回 */
async function waitForIdle(isBusy: () => boolean, isAborted: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_IDLE_TIMEOUT_MS;
  while (isBusy() && Date.now() < deadline && !isAborted()) {
    await new Promise<void>((resolve) => setTimeout(resolve, WAIT_IDLE_POLL_MS));
  }
}

export function useHistoryInit(options: HistoryInitHookOptions): HistoryInitHandle {
  const [status, setStatus] = useState<HistoryBackfillStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [progress, setProgress] = useState<HistoryInitProgress | null>(null);
  const [aborting, setAborting] = useState(false);
  const [limits, setLimits] = useState<ObservedLimits>(EMPTY_LIMITS);

  const initRef = useRef<HistoryInitializer | null>(null);
  const busyRef = useRef(false);
  const abortRef = useRef(false);
  /** 回调放 ref：避免函数身份变化导致初始化器反复重建 */
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const ensureInit = useCallback(async (): Promise<HistoryInitializer> => {
    if (initRef.current !== null) return initRef.current;
    const runtime = await initCoreRuntime();
    initRef.current = new HistoryInitializer({
      db: runtime.db,
      client: runtime.esiClient,
      scheduler: runtime.scheduler,
      onProgress: setProgress,
      onObserve: (rateLimit, errorLimit) =>
        setLimits({
          rateRemaining: rateLimit?.remaining ?? null,
          rateLimit: rateLimit?.limit ?? null,
          errorRemaining: errorLimit?.remain ?? null,
        }),
      isAborted: () => abortRef.current,
    });
    return initRef.current;
  }, []);

  const refresh = useCallback(async () => {
    const init = await ensureInit();
    setStatus(await init.status());
  }, [ensureInit]);

  const runInit = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    abortRef.current = false;
    setBusy(true);
    setAborting(false);
    setProgress(null);

    const runtime = await initCoreRuntime();
    const savedLimits = runtime.scheduler.limits;
    const collectionWasPaused = optionsRef.current.isCollectionPaused();
    const personalWasPaused = optionsRef.current.isPersonalPaused();

    try {
      // 独占：先暂停（轮级），再等在途轮次收尾
      optionsRef.current.pauseCollection();
      optionsRef.current.pausePersonalSync();
      setMessage('已暂停采集与个人同步，等待在途轮次收尾…');
      await waitForIdle(
        () => optionsRef.current.isCollectionBusy(),
        () => abortRef.current,
      );
      if (abortRef.current) {
        setMessage('初始化已取消（在开始前）');
        return;
      }

      // 独占期提档调度器（结束在 finally 还原）
      runtime.scheduler.applyLimits({
        requestsPerSecond: HISTORY_INIT_RATE_PER_SECOND,
        burst: HISTORY_INIT_BURST,
        maxConcurrent: HISTORY_INIT_MAX_CONCURRENT,
      });

      setMessage('历史全量初始化进行中…');
      const init = await ensureInit();
      const summary = await init.runInit();
      setMessage(describeSummary(summary));

      // 收尾维护：压缩 WAL（1,400 万行写入会产生巨大 WAL 文件）
      await runtime.db.select('PRAGMA wal_checkpoint(TRUNCATE)').catch(() => undefined);
    } catch (error) {
      setMessage(`初始化失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      runtime.scheduler.applyLimits(savedLimits);
      if (!collectionWasPaused) optionsRef.current.resumeCollection();
      if (!personalWasPaused) optionsRef.current.resumePersonalSync();
      abortRef.current = false;
      setAborting(false);
      busyRef.current = false;
      setBusy(false);
      setProgress(null);
      try {
        await refresh();
      } catch {
        // 状态重读失败不影响主流程
      }
    }
  }, [ensureInit, refresh]);

  const cancel = useCallback(() => {
    if (!busyRef.current) return;
    abortRef.current = true;
    setAborting(true);
    setMessage('已请求取消：完成当前 pair 后收尾，可稍后继续');
  }, []);

  const vacuum = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setMessage('正在压缩数据库（会短暂持写锁）…');
    try {
      const runtime = await initCoreRuntime();
      await runtime.db.execute('VACUUM');
      // VACUUM 会把整库重写进 WAL（GB 级库 → WAL 可涨到 GB 级），必须收尾 checkpoint 回填
      await runtime.db.select('PRAGMA wal_checkpoint(TRUNCATE)').catch(() => undefined);
      setMessage('数据库压缩完成');
    } catch (error) {
      setMessage(`数据库压缩失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  // 应用启动：全局裁剪一次（旧口径遗留）+ 读状态；**不自动运行初始化**
  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const runtime = await initCoreRuntime();
        await pruneHistoryWindow(runtime.db, Date.now());
        const init = await ensureInit();
        if (disposed) return;
        const current = await init.status();
        setStatus(current);
        const processed =
          current.state.pairsOk + current.state.pairsSkipped + current.state.pairsFailed;
        if (current.state.lastStartedAt !== null && processed < current.state.pairsTotal) {
          setMessage('上次初始化未完成：可点「开始/继续初始化」从断点续跑');
        }
      } catch (error) {
        if (!disposed) {
          setMessage(`初始化状态读取失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    })();
    return () => {
      disposed = true;
    };
  }, [ensureInit]);

  return { status, busy, message, progress, aborting, limits, runInit, cancel, refresh, vacuum };
}
