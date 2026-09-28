import { GLOBAL_SCAN_TIERS, type GlobalScanTier } from '@eve-suite/core';

import type { GlobalScannerHandle } from './useGlobalScanner';

const TIER_LABELS: Record<GlobalScanTier, string> = {
  '3h': '3 小时（重度搬砖）',
  '6h': '6 小时（默认）',
  '12h': '12 小时（轻度）',
  '24h': '24 小时（保守）',
  off: '关闭（仅用枢纽层）',
};

function formatTime(iso: string | null): string {
  return iso === null ? '—' : new Date(iso).toLocaleString();
}

/**
 * 全域层（跨区快照）状态与控制。
 * 档位五档（3h/6h/12h/24h/关闭）+ 整轮状态 + 本轮进度 + 「立即扫描」（force）。
 */
export default function GlobalScanPanel({
  scanner,
  paused,
}: {
  scanner: GlobalScannerHandle;
  paused: boolean;
}) {
  const status = scanner.status;
  const state = status?.state ?? null;
  const progress = scanner.progress;

  const coverage =
    status === null
      ? '正在读取状态…'
      : `${status.marketRegionCount} 个 = 全域轮次直采 ${status.scanRegionCount} 个 + 枢纽层每 5 分钟维护 5 个`;

  const progressText =
    state === null
      ? '—'
      : scanner.busy && progress !== null
        ? `区域 ${progress.regionId} · ${progress.page}/${progress.pages} 页`
        : `${state.regionsOk}/${state.regionsTotal} 个区域${
            state.regionsTotal > 0 && state.regionsOk < state.regionsTotal
              ? '（本轮未完成，下轮自动续扫）'
              : ''
          }`;

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>全域层 · 跨区快照</h2>
        <div className="tabs">
          <button
            type="button"
            onClick={() => void scanner.scanNow()}
            disabled={scanner.busy || paused}
          >
            {scanner.busy ? '扫描中…' : '立即扫描'}
          </button>
        </div>
      </div>

      <div className="params">
        <label>
          扫描档位
          <select
            value={status?.tier ?? '6h'}
            onChange={(event) => void scanner.setTier(event.target.value as GlobalScanTier)}
          >
            {GLOBAL_SCAN_TIERS.map((tier) => (
              <option key={tier} value={tier}>
                {TIER_LABELS[tier]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="hint">
        订单只存最新快照（按区域整区替换，不留历史）；遇到枢纽层 5 分钟轮次时全域请求让路。
      </p>
      {paused && <p className="hint">采集已暂停：全域扫描不在暂停期间开始，恢复后自动续扫。</p>}

      <table className="result">
        <tbody>
          <tr>
            <th>覆盖区域</th>
            <td>{coverage}</td>
          </tr>
          <tr>
            <th>上次全量完成</th>
            <td>{formatTime(state?.lastFullOkAt ?? null)}</td>
          </tr>
          <tr>
            <th>下次自动扫描</th>
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
                : `${state.ordersWritten.toLocaleString()} 条订单 · ${state.requests.toLocaleString()} 次请求 · 耗时 ${Math.round(state.elapsedMs / 1000)} 秒`}
            </td>
          </tr>
          <tr>
            <th>最近错误</th>
            <td>{state?.lastError ?? '—'}</td>
          </tr>
        </tbody>
      </table>

      <p className="message">{scanner.message}</p>
    </div>
  );
}
