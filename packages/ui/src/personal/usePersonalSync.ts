/**
 * 个人数据同步调度（应用级）。
 *
 * 调度逻辑在 core（`PersonalSyncScheduler`，纯逻辑可测）；本 Hook 负责生命周期、
 * 暂停开关、手动「立即同步」（force 越过缓存）与状态呈现。
 */

import {
  listCharacterIds,
  PersonalSyncScheduler,
  writeDailySnapshot,
  type PersonalSyncRoundSummary,
} from '@eve-suite/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import { initCoreRuntime, type CoreRuntime } from '../core/runtime';

export interface PersonalSyncHandle {
  running: boolean;
  paused: boolean;
  busy: boolean;
  message: string;
  /** 需重新授权的角色（刷新令牌失效，已停摆） */
  reauthCharacters: number[];
  /** 最近一轮的统计（无则为 null） */
  lastRound: PersonalSyncRoundSummary | null;
  start: () => Promise<void>;
  stop: () => void;
  togglePause: () => void;
  syncNow: () => Promise<void>;
  /** 用户重新授权后解除停摆 */
  clearReauth: (characterId: number) => void;
}

/** 只要有端点真正写入（非 304 / 非缓存跳过）就算本轮有数据更新 */
function hasFreshData(summary: PersonalSyncRoundSummary): boolean {
  return summary.scopeResults.some((entry) =>
    entry.results.some((result) => result.ok && !result.skipped),
  );
}

export function usePersonalSync(): PersonalSyncHandle {
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [reauthCharacters, setReauthCharacters] = useState<number[]>([]);
  const [lastRound, setLastRound] = useState<PersonalSyncRoundSummary | null>(null);

  const schedulerRef = useRef<PersonalSyncScheduler | null>(null);
  const runtimeRef = useRef<CoreRuntime | null>(null);
  const busyRef = useRef(false);

  const ensureRuntime = useCallback(async (): Promise<CoreRuntime> => {
    if (runtimeRef.current !== null) return runtimeRef.current;
    const runtime = await initCoreRuntime();
    runtimeRef.current = runtime;
    return runtime;
  }, []);

  const describeRound = useCallback((summary: PersonalSyncRoundSummary): string => {
    if (summary.syncedCharacters.length === 0) {
      return summary.blockedCharacters.length > 0
        ? '本轮无同步：有角色需要重新授权'
        : '本轮无已授权角色';
    }
    const parts = [
      `同步完成：${summary.syncedCharacters.length} 个角色`,
      `写入 ${summary.itemsWritten.toLocaleString()} 条`,
    ];
    if (summary.cachedScopes > 0) parts.push(`${summary.cachedScopes} 个端点未到期复用缓存`);
    if (summary.failedScopes > 0) parts.push(`${summary.failedScopes} 个端点失败`);
    if (summary.reauthCharacters.length > 0) parts.push('有角色需重新授权');
    return parts.join(' · ');
  }, []);

  const start = useCallback(async () => {
    if (schedulerRef.current !== null) return;
    try {
      const runtime = await ensureRuntime();
      const scheduler = new PersonalSyncScheduler({
        syncer: runtime.syncer,
        listCharacterIds: () => listCharacterIds(runtime.db),
        onRoundStart: (characterIds) => {
          if (characterIds.length > 0) setMessage('正在同步个人数据…');
        },
        onRoundComplete: (summary) => {
          setLastRound(summary);
          setMessage(describeRound(summary));
          // 有实际更新才写当日快照（避免用全 304/缓存命中的旧数据覆盖）
          if (!hasFreshData(summary)) return;
          for (const entry of summary.scopeResults) {
            void writeDailySnapshot(runtime.db, entry.characterId).catch(() => undefined);
          }
        },
        onReauthRequired: (characterId, reason) => {
          setReauthCharacters((previous) =>
            previous.includes(characterId) ? previous : [...previous, characterId],
          );
          setMessage(`角色 ${characterId} 需重新授权：${reason}`);
        },
      });
      schedulerRef.current = scheduler;
      scheduler.start();
      setRunning(true);
      setPaused(false);
    } catch (error) {
      setMessage(`同步初始化失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [describeRound, ensureRuntime]);

  const stop = useCallback(() => {
    schedulerRef.current?.stop();
    schedulerRef.current = null;
    setRunning(false);
  }, []);

  const togglePause = useCallback(() => {
    const scheduler = schedulerRef.current;
    if (scheduler === null) return;
    setPaused((previous) => {
      const next = !previous;
      if (next) {
        scheduler.pause();
        setMessage('已暂停个人数据同步（不再发起新请求）');
      } else {
        scheduler.resume();
        setMessage('已恢复个人数据同步');
      }
      return next;
    });
  }, []);

  /** 手动「立即同步」：越过 Cache-Control 到期时间，强制拉取并写当日快照 */
  const syncNow = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setMessage('正在立即同步（忽略缓存）…');
    try {
      const runtime = await ensureRuntime();
      const characterIds = await listCharacterIds(runtime.db);
      if (characterIds.length === 0) {
        setMessage('尚无已授权角色，请先授权');
        return;
      }

      const failures: string[] = [];
      let written = 0;
      for (const characterId of characterIds) {
        const result = await runtime.syncer.syncCharacter(characterId, { force: true });
        for (const scopeResult of result.scopes) {
          if (!scopeResult.ok) failures.push(`${scopeResult.scope}: ${scopeResult.error ?? '未知错误'}`);
          written += scopeResult.itemsWritten;
        }
        if (result.reauthRequired) {
          setReauthCharacters((previous) =>
            previous.includes(characterId) ? previous : [...previous, characterId],
          );
        }
        await writeDailySnapshot(runtime.db, characterId);
      }

      setMessage(
        failures.length === 0
          ? `立即同步完成：写入 ${written.toLocaleString()} 条`
          : `立即同步完成（${failures.length} 个端点失败）：${failures[0]}`,
      );
    } catch (error) {
      setMessage(`立即同步失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [ensureRuntime]);

  const clearReauth = useCallback((characterId: number) => {
    schedulerRef.current?.clearReauthBlock(characterId);
    setReauthCharacters((previous) => previous.filter((id) => id !== characterId));
  }, []);

  useEffect(() => {
    return () => {
      schedulerRef.current?.stop();
      schedulerRef.current = null;
    };
  }, []);

  return {
    running,
    paused,
    busy,
    message,
    reauthCharacters,
    lastRound,
    start,
    stop,
    togglePause,
    syncNow,
    clearReauth,
  };
}
