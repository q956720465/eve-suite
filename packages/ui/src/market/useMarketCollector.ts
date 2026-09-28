import {
  getCollectStates,
  HUB_COLLECT_INTERVAL_MS,
  MarketCollector,
  TRADE_HUBS,
  type HubCollectState,
} from '@eve-suite/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import { initCoreRuntime } from '../core/runtime';

export interface MarketCollectorHandle {
  states: HubCollectState[];
  busy: boolean;
  paused: boolean;
  message: string;
  /** 立即采集一轮（5 分钟定时外的手动触发） */
  collectNow: () => Promise<void>;
  togglePause: () => void;
  /** 幂等暂停（供独占编排调用）：重复调用无副作用 */
  pause: () => void;
  /** 幂等恢复（供独占编排调用）：重复调用无副作用 */
  resume: () => void;
  /** 读 ref 的实时暂停态（异步编排中避免 state 滞后） */
  isPaused: () => boolean;
  /** 读 ref 的实时忙态（是否有在途采集轮次） */
  isBusy: () => boolean;
  refresh: () => Promise<void>;
}

/**
 * 应用内行情采集调度：启动后立即采集一轮，其后每 5 分钟一轮（方案文档 §1）。
 * 采集逻辑在 core，本 Hook 只负责生命周期、定时与状态呈现。
 *
 * 请求调度器与 ESI 客户端取自**应用级 core 运行时单例**（方案 §4.4：全局令牌桶所有管道共享）——
 * 枢纽层与全域层共用同一个优先级队列，全域层向枢纽层「让路」才真正生效
 * （两个独立调度器时，优先级只在各自队列内有效）。
 */
export function useMarketCollector(): MarketCollectorHandle {
  const [states, setStates] = useState<HubCollectState[]>([]);
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [message, setMessage] = useState('');

  const collectorRef = useRef<MarketCollector | null>(null);
  const busyRef = useRef(false);
  const pausedRef = useRef(false);

  const refresh = useCallback(async () => {
    const runtime = await initCoreRuntime();
    setStates(await getCollectStates(runtime.db, TRADE_HUBS.map((hub) => hub.regionId)));
  }, []);

  const collectNow = useCallback(async () => {
    const collector = collectorRef.current;
    // 暂停 = 不开始新一轮（在途轮次不受影响，见 togglePause 注释）
    if (collector === null || busyRef.current || pausedRef.current) return;

    busyRef.current = true;
    setBusy(true);
    try {
      const results = await collector.collectHubs();
      const ordersWritten = results.reduce((sum, result) => sum + result.ordersWritten, 0);
      const skipped = results.filter((result) => result.skipped).length;
      const failures = results.filter((result) => result.error !== null);

      if (failures.length > 0) {
        const firstError = failures[0].error ?? '未知错误';
        setMessage(
          `采集完成：${results.length - failures.length} 个区域成功、${failures.length} 个失败（${firstError}）`,
        );
      } else {
        setMessage(
          `采集完成：写入 ${ordersWritten.toLocaleString()} 条订单，${skipped} 个区域无变化`,
        );
      }
      await refresh();
    } catch (error) {
      setMessage(`采集失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [refresh]);

  useEffect(() => {
    let disposed = false;

    void (async () => {
      try {
        setMessage('正在初始化行情采集…');
        const runtime = await initCoreRuntime();
        if (disposed) return;

        const collector = new MarketCollector({
          db: runtime.db,
          client: runtime.esiClient,
          scheduler: runtime.scheduler,
          onProgress: (progress) =>
            setMessage(`采集区域 ${progress.regionId}：${progress.page}/${progress.pages} 页`),
        });

        collectorRef.current = collector;

        await refresh();
        if (!pausedRef.current) await collectNow();
      } catch (error) {
        if (!disposed) {
          setMessage(
            `行情采集初始化失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    })();

    return () => {
      disposed = true;
    };
  }, [collectNow, refresh]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (!pausedRef.current) void collectNow();
    }, HUB_COLLECT_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [collectNow]);

  /**
   * 暂停/恢复采集（**轮次级**）。
   *
   * 不能改成请求调度器级暂停：在途轮次已把整页请求排入队列，请求级暂停会把它们永远压住，
   * 轮次不结束、`busy` 不复位（现象：暂停后「采集中…」长期不变）。故只拦「新一轮开始」。
   */
  const pause = useCallback(() => {
    if (pausedRef.current) return;
    pausedRef.current = true;
    setPaused(true);
    setMessage('已暂停采集：当前轮次结束后不再开始新轮次');
  }, []);

  const resume = useCallback(() => {
    if (!pausedRef.current) return;
    pausedRef.current = false;
    setPaused(false);
    setMessage(busyRef.current ? '已恢复采集（当前轮次进行中）' : '已恢复采集，正在补跑一轮…');
    void collectNow();
  }, [collectNow]);

  const togglePause = useCallback(() => {
    if (pausedRef.current) {
      resume();
    } else {
      pause();
    }
  }, [pause, resume]);

  const isPaused = useCallback(() => pausedRef.current, []);
  const isBusy = useCallback(() => busyRef.current, []);

  return {
    states,
    busy,
    paused,
    message,
    collectNow,
    togglePause,
    pause,
    resume,
    isPaused,
    isBusy,
    refresh,
  };
}
