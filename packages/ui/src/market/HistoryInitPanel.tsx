import { useState } from 'react';

import type { HistoryInitHandle } from './useHistoryInit';

function formatTime(iso: string | null): string {
  return iso === null ? '—' : new Date(iso).toLocaleString();
}

function formatLimits(limits: HistoryInitHandle['limits']): string {
  const parts: string[] = [];
  if (limits.rateLimit !== null || limits.rateRemaining !== null) {
    parts.push(`Ratelimit 余 ${limits.rateRemaining ?? '—'} / ${limits.rateLimit ?? '—'}`);
  }
  if (limits.errorRemaining !== null) parts.push(`错误预算余 ${limits.errorRemaining}`);
  return parts.length === 0 ? '尚未观察到限流头' : parts.join(' · ');
}

/**
 * 历史数据全量初始化（P5-2.8）。
 *
 * 把 5 枢纽候选的日线历史补满到 400 天（本地库），使价差历史校验与行情页价格图零等待。
 * 仅手动触发；运行期间独占（暂停采集 / 全域 / 个人同步）并把调度器临时提档。
 */
export default function HistoryInitPanel({ init }: { init: HistoryInitHandle }) {
  const [confirming, setConfirming] = useState(false);
  const status = init.status;
  const state = status?.state ?? null;
  const progress = init.progress;

  const processed = state === null ? 0 : state.pairsOk + state.pairsSkipped + state.pairsFailed;
  const remaining = state === null ? 0 : Math.max(0, state.pairsTotal - processed);

  const progressText =
    state === null
      ? '—'
      : init.busy && progress !== null
        ? `处理中 ${progress.completed.toLocaleString()}/${progress.total.toLocaleString()} 条（区域 ${progress.regionId} · 物品 ${progress.typeId}）`
        : `${processed.toLocaleString()}/${state.pairsTotal.toLocaleString()} 条${
            remaining > 0 && state.pairsTotal > 0 ? `（未完成，可继续 · 剩余约 ${remaining.toLocaleString()}）` : ''
          }`;

  // 运行中「本轮写入」用实时进度计数（状态行只在本轮收尾时才落库）
  const live = init.busy && progress !== null ? progress : null;
  const writtenOk = live?.pairsOk ?? state?.pairsOk ?? 0;
  const writtenSkipped = live?.pairsSkipped ?? state?.pairsSkipped ?? 0;
  const writtenDays = live?.daysWritten ?? state?.daysWritten ?? 0;

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>历史数据全量初始化 · 枢纽</h2>
        <div className="tabs">
          <button type="button" onClick={() => setConfirming(true)} disabled={init.busy}>
            开始 / 继续初始化
          </button>
          <button type="button" onClick={() => init.cancel()} disabled={!init.busy || init.aborting}>
            {init.aborting ? '取消中…' : '取消'}
          </button>
          <button type="button" onClick={() => void init.vacuum()} disabled={init.busy}>
            压缩数据库（VACUUM）
          </button>
        </div>
      </div>

      <p className="hint">
        把 5 枢纽「卖单数或买单数 ≥5」的物品日线历史补满到 <strong>400 天</strong>。
        <strong>仅手动触发</strong>；运行期间会<strong>暂停采集、全域扫描与个人同步</strong>并把请求临时提档，
        结束后自动恢复。中断（关应用 / 取消）后可继续，已完成部分不会重拉。
      </p>

      {confirming && (
        <div className="panel">
          <p className="message">
            即将开始全量初始化：约 <strong>{status?.pairCount.toLocaleString() ?? '—'}</strong> 个
            (区域, 物品) 对，预计写入约 <strong>1,400 万行</strong>日线、耗时较长。
            期间采集 / 全域 / 个人同步将暂停，结束后自动恢复。
          </p>
          <div className="params">
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
                void init.runInit();
              }}
            >
              确认开始
            </button>
            <button type="button" onClick={() => setConfirming(false)}>
              取消
            </button>
          </div>
        </div>
      )}

      <table className="result">
        <tbody>
          <tr>
            <th>初始化范围</th>
            <td>
              {status === null
                ? '正在读取状态…'
                : `5 枢纽 · ${status.pairCount.toLocaleString()} 条候选（卖单数或买单数 ≥5）· 保留 400 天`}
            </td>
          </tr>
          <tr>
            <th>上次完成</th>
            <td>{formatTime(state?.lastFullOkAt ?? null)}</td>
          </tr>
          <tr>
            <th>本轮进度</th>
            <td>{progressText}</td>
          </tr>
          <tr>
            <th>本轮写入</th>
            <td>
              {state === null && live === null
                ? '—'
                : `${writtenOk.toLocaleString()} 条更新 · 跳过 ${writtenSkipped.toLocaleString()} 条 · ${writtenDays.toLocaleString()} 行日线${
                    live === null ? ` · 耗时 ${Math.round((state?.elapsedMs ?? 0) / 1000)} 秒` : ''
                  }`}
            </td>
          </tr>
          <tr>
            <th>最近错误</th>
            <td>{state?.lastError ?? '—'}</td>
          </tr>
          <tr>
            <th>限流头</th>
            <td>{formatLimits(init.limits)}</td>
          </tr>
        </tbody>
      </table>

      <p className="message">{init.message}</p>
    </div>
  );
}
