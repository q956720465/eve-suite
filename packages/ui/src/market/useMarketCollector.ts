import {
  createFetchHttpClient,
  EsiClient,
  getCollectStates,
  HUB_COLLECT_INTERVAL_MS,
  MarketCollector,
  RequestScheduler,
  TRADE_HUBS,
  type HubCollectState,
} from '@eve-suite/core';
import { initDatabase, openAdapter } from '@eve-suite/core/db/tauri';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface MarketCollectorHandle {
  states: HubCollectState[];
  busy: boolean;
  paused: boolean;
  message: string;
  /** 立即采集一轮（5 分钟定时外的手动触发） */
  collectNow: () => Promise<void>;
  togglePause: () => void;
  refresh: () => Promise<void>;
}

/**
 * 应用内行情采集调度：启动后立即采集一轮，其后每 5 分钟一轮（方案文档 §1）。
 * 采集逻辑在 core，本 Hook 只负责生命周期、定时与状态呈现。
 */
export function useMarketCollector(): MarketCollectorHandle {
  const [states, setStates] = useState<HubCollectState[]>([]);
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [message, setMessage] = useState('');

  const collectorRef = useRef<MarketCollector | null>(null);
  const schedulerRef = useRef<RequestScheduler | null>(null);
  const busyRef = useRef(false);
  const pausedRef = useRef(false);

  const refresh = useCallback(async () => {
    const db = await openAdapter();
    setStates(await getCollectStates(db, TRADE_HUBS.map((hub) => hub.regionId)));
  }, []);

  const collectNow = useCallback(async () => {
    const collector = collectorRef.current;
    if (collector === null || busyRef.current) return;

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
        await initDatabase();
        if (disposed) return;

        const db = await openAdapter();
        const scheduler = new RequestScheduler({
          requestsPerSecond: 10,
          burst: 20,
          maxConcurrent: 4,
        });
        const client = new EsiClient({ http: createFetchHttpClient() });
        const collector = new MarketCollector({
          db,
          client,
          scheduler,
          onProgress: (progress) =>
            setMessage(`采集区域 ${progress.regionId}：${progress.page}/${progress.pages} 页`),
        });

        schedulerRef.current = scheduler;
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

  const togglePause = useCallback(() => {
    setPaused((previous) => {
      const next = !previous;
      pausedRef.current = next;
      if (next) {
        schedulerRef.current?.pause();
        setMessage('已暂停采集（不再发起新请求）');
      } else {
        schedulerRef.current?.resume();
        setMessage('已恢复采集');
      }
      return next;
    });
  }, []);

  return { states, busy, paused, message, collectNow, togglePause, refresh };
}
