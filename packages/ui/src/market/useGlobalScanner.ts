/**
 * 全域层（跨区快照）扫描调度（应用级）。
 *
 * 扫描逻辑在 core（`GlobalMarketScanner`：档位到期 / catch-up / 断点续扫 / 让路 / 失败隔离）；
 * 本 Hook 只负责生命周期、到期检查定时与状态呈现，并**放在应用壳持有**——
 * 离开「行情」页也不中断，与枢纽层采集（`useMarketCollector`）同构。
 */

import {
  GlobalMarketScanner,
  writeGlobalScanTier,
  type GlobalScanProgress,
  type GlobalScanStatus,
  type GlobalScanSummary,
  type GlobalScanTier,
} from '@eve-suite/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import { initCoreRuntime } from '../core/runtime';

/** 到期检查间隔：只查库判到期，不发请求 */
export const GLOBAL_DUE_CHECK_INTERVAL_MS = 60_000;

export interface GlobalScannerHandle {
  status: GlobalScanStatus | null;
  busy: boolean;
  message: string;
  progress: GlobalScanProgress | null;
  /** 切换档位（写库；随后的到期检查按新档位生效） */
  setTier: (tier: GlobalScanTier) => Promise<void>;
  /** 立即扫描：force —— 忽略档位与续扫过滤，重扫全部区域 */
  scanNow: () => Promise<void>;
  /** 只重读状态，不发请求 */
  refresh: () => Promise<void>;
  /** 到期检查一次（应用启动 / 恢复采集时调用；未到期则零请求） */
  kick: () => Promise<void>;
}

export interface GlobalScannerOptions {
  /** 是否已暂停采集（暂停时不开始新扫描；在途扫描在区域边界收尾） */
  isPaused: () => boolean;
}

/** 把本轮汇总翻成一行可读文案 */
function describeSummary(summary: GlobalScanSummary): string {
  if (summary.skipped) {
    return `未发起扫描：${summary.skipReason ?? '无需扫描'}`;
  }
  const parts = [
    `${summary.regionsOk}/${summary.regionsTotal} 个区域就绪`,
    `写入 ${summary.ordersWritten.toLocaleString()} 条订单`,
    `${summary.requests.toLocaleString()} 次请求`,
    `耗时 ${Math.round(summary.elapsedMs / 1000)} 秒`,
  ];
  if (summary.regionsResumed > 0) parts.push(`续扫跳过 ${summary.regionsResumed} 个`);
  if (summary.regionsFailed > 0) parts.push(`${summary.regionsFailed} 个区域失败`);
  if (summary.aborted) parts.push('已暂停，本轮在区域边界提前结束（恢复后自动续扫）');
  return parts.join(' · ');
}

export function useGlobalScanner(options: GlobalScannerOptions): GlobalScannerHandle {
  const [status, setStatus] = useState<GlobalScanStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [progress, setProgress] = useState<GlobalScanProgress | null>(null);

  const scannerRef = useRef<GlobalMarketScanner | null>(null);
  const busyRef = useRef(false);
  /** 回调放 ref：避免函数身份变化导致扫描器反复重建 */
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const ensureScanner = useCallback(async (): Promise<GlobalMarketScanner> => {
    if (scannerRef.current !== null) return scannerRef.current;
    // 与枢纽层 / 个人数据共用同一个调度器实例：全域请求走 global 优先级，
    // 枢纽轮次的请求始终先派发（方案 §4.4 全局令牌桶 + §4.1 优先级让路）
    const runtime = await initCoreRuntime();
    scannerRef.current = new GlobalMarketScanner({
      db: runtime.db,
      client: runtime.esiClient,
      scheduler: runtime.scheduler,
      onProgress: setProgress,
      isPaused: () => optionsRef.current.isPaused(),
    });
    return scannerRef.current;
  }, []);

  const refresh = useCallback(async () => {
    const scanner = await ensureScanner();
    setStatus(await scanner.status());
  }, [ensureScanner]);

  const run = useCallback(
    async (force: boolean) => {
      if (busyRef.current) return;
      // 先占位再 await：并发调用（如启动检查与恢复检查同时触发）不得双跑同一轮扫描
      busyRef.current = true;
      setBusy(true);
      setProgress(null);
      try {
        const scanner = await ensureScanner();

        if (!force && optionsRef.current.isPaused()) {
          setMessage('已暂停采集：全域扫描暂不开始（恢复后自动续扫）');
          setStatus(await scanner.status());
          return;
        }

        const summary = force
          ? await scanner.runScan({ force: true })
          : await scanner.runDueScan();
        setMessage(describeSummary(summary));
      } catch (error) {
        setMessage(`全域扫描失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        busyRef.current = false;
        setBusy(false);
        setProgress(null);
      }

      try {
        const scanner = await ensureScanner();
        setStatus(await scanner.status());
      } catch {
        // 状态重读失败不影响主流程
      }
    },
    [ensureScanner],
  );

  // 应用启动：装配扫描器 → 读状态 → 到期检查一次（catch-up：开机即补跑）
  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const scanner = await ensureScanner();
        if (disposed) return;
        setStatus(await scanner.status());
        await run(false);
      } catch (error) {
        if (!disposed) {
          setMessage(
            `全域层初始化失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    })();
    return () => {
      disposed = true;
    };
  }, [ensureScanner, run]);

  // 到期检查：只判到期，未到期零请求
  useEffect(() => {
    const timer = setInterval(() => {
      void run(false);
    }, GLOBAL_DUE_CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [run]);

  const setTier = useCallback(
    async (tier: GlobalScanTier) => {
      try {
        const runtime = await initCoreRuntime();
        await writeGlobalScanTier(runtime.db, tier);
        await refresh();
        setMessage(
          tier === 'off'
            ? '全域层已关闭：不再自动扫描，已有跨区快照保留'
            : `全域层档位已设为 ${tier}（届时自动补扫）`,
        );
      } catch (error) {
        setMessage(`档位保存失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [refresh],
  );

  const scanNow = useCallback(() => run(true), [run]);
  const kick = useCallback(() => run(false), [run]);

  return { status, busy, message, progress, setTier, scanNow, refresh, kick };
}
