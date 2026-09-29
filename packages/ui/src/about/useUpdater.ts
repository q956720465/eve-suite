import { relaunch } from '@tauri-apps/plugin-process';
import { check as checkUpdate, type Update } from '@tauri-apps/plugin-updater';
import { isTauri } from '@tauri-apps/api/core';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 内置更新器（P6-4）。
 *
 * 行为约定（经用户确认）：
 * - **启动后延迟静默检查一次**（默认 10 秒，不打扰启动流程）
 * - 有新版时**只提示、不自动下载**；用户点「立即更新」才下载安装
 * - 安装完成后**重启应用**（`@tauri-apps/plugin-process` 的 `relaunch`）
 * - 更新包由构建时用私钥签名，应用内用 `tauri.conf.json` 的公钥校验（篡改即拒绝安装）
 *
 * 非 Tauri 环境（浏览器预览）整个模块降级为「不可用」，不报错。
 */

/** 启动后自动检查的延迟（毫秒） */
export const UPDATE_AUTO_CHECK_DELAY_MS = 10_000;

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'installing'
  | 'error'
  | 'unsupported';

export interface UpdaterHandle {
  status: UpdateStatus;
  /** 新版本号（`available` 之后有值） */
  version: string | null;
  /** 发行说明（Markdown / 纯文本，可能为空） */
  notes: string | null;
  /** 当前版本号 */
  currentVersion: string | null;
  /** 下载进度 0–1；总大小未知时为 null */
  progress: number | null;
  error: string | null;
  /** 手动检查（也会被启动时的静默检查调用） */
  check: () => Promise<void>;
  /** 下载并安装，成功后重启应用 */
  install: () => Promise<void>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useUpdater(): UpdaterHandle {
  const [status, setStatus] = useState<UpdateStatus>('idle');
  const [version, setVersion] = useState<string | null>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** 待安装的更新对象（只有它在内存里，不能跨次 check 复用） */
  const pendingRef = useRef<Update | null>(null);
  const inFlightRef = useRef(false);

  const check = useCallback(async () => {
    if (!isTauri()) {
      setStatus('unsupported');
      return;
    }
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setStatus('checking');
    setError(null);
    try {
      const update = await checkUpdate();
      if (update === null) {
        pendingRef.current = null;
        setVersion(null);
        setNotes(null);
        setStatus('up-to-date');
        return;
      }
      pendingRef.current = update;
      setVersion(update.version);
      setNotes(update.body ?? null);
      setCurrentVersion(update.currentVersion);
      setStatus('available');
    } catch (cause) {
      // 离线 / 私有仓库未公开时属预期情况，如实展示而非静默
      setStatus('error');
      setError(describeError(cause));
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  const install = useCallback(async () => {
    const update = pendingRef.current;
    if (update === null) return;
    setStatus('downloading');
    setProgress(null);
    setError(null);
    let received = 0;
    let total: number | null = null;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          total = event.data.contentLength ?? null;
          setProgress(total === null ? null : 0);
          return;
        }
        if (event.event === 'Progress') {
          received += event.data.chunkLength;
          setProgress(total !== null && total > 0 ? Math.min(1, received / total) : null);
          return;
        }
        // Finished：进入安装阶段
        setStatus('installing');
      });
      // 安装完成 → 重启以加载新版本
      await relaunch();
    } catch (cause) {
      setStatus('error');
      setError(describeError(cause));
    }
  }, []);

  // 启动后延迟静默检查一次（只跑一次，不随依赖变化重跑）
  useEffect(() => {
    const timer = setTimeout(() => void check(), UPDATE_AUTO_CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [check]);

  return { status, version, notes, currentVersion, progress, error, check, install };
}
