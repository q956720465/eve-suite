/**
 * 枢纽历史基线预拉的调度（应用级）。
 *
 * 预拉逻辑在 core（`HistoryBackfill`：档位到期 / 匀速节拍限速 / 串行逐个 / 失败隔离 /
 * `global` 优先级让路）；本 Hook 只负责生命周期、到期检查定时与状态呈现，并
 * **放在应用壳持有** —— 离开「价差」页也不中断，与 `useGlobalScanner` 同构。
 */

import {
  HistoryBackfill,
  writeHistoryBackfillTier,
  type HistoryBackfillProgress,
  type HistoryBackfillStatus,
  type HistoryBackfillSummary,
  type HistoryBackfillTier,
} from '@eve-suite/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import { initCoreRuntime } from '../core/runtime';

/** 到期检查间隔：只查库判到期，不发请求 */
export const HISTORY_BACKFILL_DUE_CHECK_INTERVAL_MS = 60_000;

export interface HistoryBackfillHandle {
  status: HistoryBackfillStatus | null;
  busy: boolean;
  message: string;
  progress: HistoryBackfillProgress | null;
  /** 切换档位（写库；随后的到期检查按新档位生效） */
  setTier: (tier: HistoryBackfillTier) => Promise<void>;
  /** 立即预拉：忽略档位到期判定（当天已拉过的 pair 仍会跳过） */
  backfillNow: () => Promise<void>;
  /** 只重读状态，不发请求 */
  refresh: () => Promise<void>;
  /** 到期检查一次（应用启动 / 恢复采集时调用；未到期则零请求） */
  kick: () => Promise<void>;
}

export interface HistoryBackfillHookOptions {
  /** 是否已暂停采集（暂停时不开始新预拉；在途预拉处理完当前 pair 后收尾） */
  isPaused: () => boolean;
}

/** 把本轮汇总翻成一行可读文案 */
function describeSummary(summary: HistoryBackfillSummary): string {
  if (summary.skipped) {
    return `未发起预拉：${summary.skipReason ?? '无需预拉'}`;
  }
  const parts = [
    `更新 ${summary.pairsOk.toLocaleString()} 条`,
    `跳过 ${summary.pairsSkipped.toLocaleString()} 条（当日已拉）`,
    `写入 ${summary.daysWritten.toLocaleString()} 行日线`,
    `耗时 ${Math.round(summary.elapsedMs / 1000)} 秒`,
  ];
  if (summary.pairsFailed > 0) parts.push(`${summary.pairsFailed} 条失败`);
  if (summary.aborted) parts.push('已暂停，本轮提前结束（恢复后自动续跑）');
  return parts.join(' · ');
}

export function useHistoryBackfill(options: HistoryBackfillHookOptions): HistoryBackfillHandle {
  const [status, setStatus] = useState<HistoryBackfillStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [progress, setProgress] = useState<HistoryBackfillProgress | null>(null);

  const backfillRef = useRef<HistoryBackfill | null>(null);
  const busyRef = useRef(false);
  /** 回调放 ref：避免函数身份变化导致预拉器反复重建 */
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const ensureBackfill = useCallback(async (): Promise<HistoryBackfill> => {
    if (backfillRef.current !== null) return backfillRef.current;
    // 与枢纽层 / 全域层 / 个人数据共用同一个调度器实例：预拉请求走 global 优先级，
    // 枢纽轮次与按需校验始终先派发
    const runtime = await initCoreRuntime();
    backfillRef.current = new HistoryBackfill({
      db: runtime.db,
      client: runtime.esiClient,
      scheduler: runtime.scheduler,
      onProgress: setProgress,
      isPaused: () => optionsRef.current.isPaused(),
    });
    return backfillRef.current;
  }, []);

  const refresh = useCallback(async () => {
    const backfill = await ensureBackfill();
    setStatus(await backfill.status());
  }, [ensureBackfill]);

  const run = useCallback(
    async (force: boolean) => {
      if (busyRef.current) return;
      // 先占位再 await：并发调用不得双跑同一轮预拉
      busyRef.current = true;
      setBusy(true);
      setProgress(null);
      try {
        const backfill = await ensureBackfill();
        const summary = force ? await backfill.runScan({ force: true }) : await backfill.runDueScan();
        setMessage(describeSummary(summary));
      } catch (error) {
        setMessage(`预拉失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        busyRef.current = false;
        setBusy(false);
        setProgress(null);
      }

      try {
        const backfill = await ensureBackfill();
        setStatus(await backfill.status());
      } catch {
        // 状态重读失败不影响主流程
      }
    },
    [ensureBackfill],
  );

  // 应用启动：装配预拉器 → 读状态 → 到期检查一次（catch-up：开机即补跑）
  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const backfill = await ensureBackfill();
        if (disposed) return;
        setStatus(await backfill.status());
        await run(false);
      } catch (error) {
        if (!disposed) {
          setMessage(`预拉初始化失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    })();
    return () => {
      disposed = true;
    };
  }, [ensureBackfill, run]);

  // 到期检查：只判到期，未到期零请求
  useEffect(() => {
    const timer = setInterval(() => {
      void run(false);
    }, HISTORY_BACKFILL_DUE_CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [run]);

  const setTier = useCallback(
    async (tier: HistoryBackfillTier) => {
      try {
        const runtime = await initCoreRuntime();
        await writeHistoryBackfillTier(runtime.db, tier);
        await refresh();
        setMessage(
          tier === 'off'
            ? '历史预拉已关闭：不再自动预拉，已拉取的历史保留'
            : '历史预拉档位已设为 24h（每天自动预拉一次）',
        );
      } catch (error) {
        setMessage(`档位保存失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [refresh],
  );

  const backfillNow = useCallback(() => run(true), [run]);
  const kick = useCallback(() => run(false), [run]);

  return { status, busy, message, progress, setTier, backfillNow, refresh, kick };
}
