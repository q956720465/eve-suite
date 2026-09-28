import { HISTORY_BACKFILL_TIERS, type HistoryBackfillTier } from '@eve-suite/core';

import type { HistoryBackfillHandle } from './useHistoryBackfill';

const TIER_LABELS: Record<HistoryBackfillTier, string> = {
  '24h': '每日一次（默认）',
  off: '关闭（仅按需校验）',
};

function formatTime(iso: string | null): string {
  return iso === null ? '—' : new Date(iso).toLocaleString();
}

/**
 * 枢纽历史基线预拉状态与控制。
 *
 * 目的：把 5 枢纽「能进价差候选」的物品日线历史预拉到本地，
 * 使价差页的历史校验对枢纽候选零等待；预拉不到的候选仍走按需校验兜底。
 */
export default function HistoryBackfillPanel({
  backfill,
  paused,
}: {
  backfill: HistoryBackfillHandle;
  paused: boolean;
}) {
  const status = backfill.status;
  const state = status?.state ?? null;
  const progress = backfill.progress;

  const coverage =
    status === null
      ? '正在读取状态…'
      : `5 枢纽 · ${status.pairCount.toLocaleString()} 条候选（卖单数或买单数 ≥5）`;

  const progressText =
    state === null
      ? '—'
      : backfill.busy && progress !== null
        ? `处理中 ${progress.completed.toLocaleString()}/${progress.total.toLocaleString()} 条`
        : `${(
            state.pairsOk +
            state.pairsSkipped +
            state.pairsFailed
          ).toLocaleString()}/${state.pairsTotal.toLocaleString()} 条${
            state.pairsTotal > 0 &&
            state.pairsOk + state.pairsSkipped + state.pairsFailed < state.pairsTotal
              ? '（本轮未完成，下轮自动续跑）'
              : ''
          }`;

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>历史基线预拉 · 枢纽</h2>
        <div className="tabs">
          <button
            type="button"
            onClick={() => void backfill.backfillNow()}
            disabled={backfill.busy || paused}
          >
            {backfill.busy ? '预拉中…' : '立即预拉'}
          </button>
        </div>
      </div>

      <div className="params">
        <label>
          预拉档位
          <select
            value={status?.tier ?? '24h'}
            onChange={(event) => void backfill.setTier(event.target.value as HistoryBackfillTier)}
          >
            {HISTORY_BACKFILL_TIERS.map((tier) => (
              <option key={tier} value={tier}>
                {TIER_LABELS[tier]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="hint">
        只预拉 5 枢纽的日线历史（ESI 日线一天只新增 1 天，故按日更新）；请求走最低优先级，
        速率限 5 req/s 为枢纽采集让路。
      </p>
      {paused && <p className="hint">采集已暂停：预拉不在暂停期间开始，恢复后自动续跑。</p>}

      <table className="result">
        <tbody>
          <tr>
            <th>预拉范围</th>
            <td>{coverage}</td>
          </tr>
          <tr>
            <th>上次完成</th>
            <td>{formatTime(state?.lastFullOkAt ?? null)}</td>
          </tr>
          <tr>
            <th>下次自动预拉</th>
            <td>
              {status === null || status.nextDueAt === null
                ? '已关闭'
                : new Date(status.nextDueAt).toLocaleString()}
            </td>
          </tr>
          <tr>
            <th>本轮进度</th>
            <td>{progressText}</td>
          </tr>
          <tr>
            <th>本轮写入</th>
            <td>
              {state === null
                ? '—'
                : `${state.pairsOk.toLocaleString()} 条更新 · 跳过 ${state.pairsSkipped.toLocaleString()} 条 · ${state.daysWritten.toLocaleString()} 行日线 · 耗时 ${Math.round(state.elapsedMs / 1000)} 秒`}
            </td>
          </tr>
          <tr>
            <th>最近错误</th>
            <td>{state?.lastError ?? '—'}</td>
          </tr>
        </tbody>
      </table>

      <p className="message">{backfill.message}</p>
    </div>
  );
}
