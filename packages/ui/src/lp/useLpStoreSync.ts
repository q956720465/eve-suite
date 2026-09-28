/**
 * LP 报价同步（应用级）。
 *
 * 同步逻辑在 core（`LpStoreSyncer`：ESI 公共端点 + ETag 条件请求 + 24h TTL）；
 * 本 Hook 只负责生命周期与状态呈现，并**放在应用壳持有**——离开「计算」页也不中断，
 * 与个人数据同步（`usePersonalSync`）同构。
 */

import {
  LpStoreSyncer,
  type LpStoreSyncResult,
  type LpStoreSyncSummary,
} from '@eve-suite/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import { initCoreRuntime, type CoreRuntime } from '../core/runtime';

export interface LpStoreSyncHandle {
  syncing: boolean;
  message: string;
  /** 最近一次同步汇总（无则 null）——变化即代表报价可能已更新，面板据此重算 */
  lastSummary: LpStoreSyncSummary | null;
  /** 强制回源（面板「刷新报价」按钮） */
  refresh: () => Promise<void>;
  /** 非强制同步一次（个人数据同步完成、LP 余额刚写库时调用；遵守 24h TTL） */
  kick: () => Promise<void>;
}

/** 角色来源：复用应用壳已有的 `useCharacters`，避免再查一次角色表 */
export interface LpStoreSyncCharacterSource {
  ready: boolean;
  characters: readonly { characterId: number }[];
}

function describeSummary(summary: LpStoreSyncSummary): string {
  const cached = summary.results.filter((item) => item.skippedReason === 'cache').length;
  const notModified = summary.results.filter((item) => item.skippedReason === 'not-modified').length;
  const written = summary.results.reduce((sum, item) => sum + item.offersWritten, 0);
  const parts = [`${summary.okCount} 个军团已就绪`, `写入 ${written.toLocaleString()} 条报价`];
  if (cached > 0) parts.push(`${cached} 个未到期复用缓存`);
  if (notModified > 0) parts.push(`${notModified} 个 304 未变更`);
  if (summary.failedCount > 0) parts.push(`${summary.failedCount} 个失败`);
  return parts.join(' · ');
}

export function useLpStoreSync(source: LpStoreSyncCharacterSource): LpStoreSyncHandle {
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState('');
  const [lastSummary, setLastSummary] = useState<LpStoreSyncSummary | null>(null);

  const runtimeRef = useRef<CoreRuntime | null>(null);
  const syncerRef = useRef<LpStoreSyncer | null>(null);
  const busyRef = useRef(false);
  const lastIdsRef = useRef<string | null>(null);

  const characterIds = source.characters
    .map((item) => item.characterId)
    .sort((left, right) => left - right);
  /** 角色集合的稳定键——直接进依赖，避免数组身份变化导致重复同步 */
  const idsKey = characterIds.join(',');

  const run = useCallback(
    async (force: boolean) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setSyncing(true);
      try {
        const ids = idsKey.length === 0 ? [] : idsKey.split(',').map(Number);
        if (ids.length === 0) {
          setMessage('尚无已授权角色，请先在「资产」页授权');
          return;
        }

        const runtime = await initCoreRuntime();
        runtimeRef.current = runtime;
        if (syncerRef.current === null) {
          syncerRef.current = new LpStoreSyncer({
            db: runtime.db,
            client: runtime.esiClient,
            scheduler: runtime.scheduler,
          });
        }

        // 逐角色串行：每个角色只抓「其有 LP 余额的军团」，无余额则零请求
        const results: LpStoreSyncResult[] = [];
        for (const characterId of ids) {
          const summary = await syncerRef.current.syncCharacterStores(characterId, { force });
          results.push(...summary.results);
        }

        const merged: LpStoreSyncSummary = {
          results,
          okCount: results.filter((item) => item.ok).length,
          failedCount: results.filter((item) => !item.ok).length,
        };
        setLastSummary(merged);
        setMessage(
          results.length === 0
            ? '该角色暂无 LP 余额军团，无需抓取报价'
            : describeSummary(merged),
        );
      } catch (error) {
        setMessage(`LP 报价同步失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        busyRef.current = false;
        setSyncing(false);
      }
    },
    [idsKey],
  );

  // 应用级：首次就绪（启动即同步）与角色集合变化时各同步一次；
  // 非 force —— 遵守 LP 商店 24h TTL，到期后才靠 ETag 条件请求复校（304 即零流量）。
  useEffect(() => {
    if (!source.ready) return;
    const previous = lastIdsRef.current;
    lastIdsRef.current = idsKey;
    if (idsKey.length === 0) return;
    if (previous !== null && previous === idsKey) return;
    void run(false);
  }, [source.ready, idsKey, run]);

  const refresh = useCallback(() => run(true), [run]);
  const kick = useCallback(() => run(false), [run]);

  return { syncing, message, lastSummary, refresh, kick };
}
