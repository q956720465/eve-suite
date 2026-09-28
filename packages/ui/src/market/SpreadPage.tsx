import {
  DEFAULT_SPREAD_FILTERS,
  TRADE_HUBS,
  getTypeNames,
  getSpreadFreshness,
  rankCrossRegionSpreads,
  validateSpreadHistory,
  type SpreadFreshness,
  type SpreadHistoryReason,
  type SpreadHistoryVerdict,
  type SpreadRow,
  type SpreadSortKey,
  type TypeNameEntry,
} from '@eve-suite/core';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { initCoreRuntime } from '../core/runtime';

import HistoryInitPanel from './HistoryInitPanel';
import type { HistoryInitHandle } from './useHistoryInit';

/** 区域范围：全部已采集区域 / 仅五大枢纽之间 */
type RegionScope = 'all' | 'hubs';

const SORT_LABELS: readonly { key: SpreadSortKey; label: string }[] = [
  { key: 'spreadRate', label: '价差率' },
  { key: 'spreadIsk', label: '单件价差' },
  { key: 'iskPerM3', label: 'ISK/m³' },
];

/** 历史校验未通过原因 → 展示标签（对应 validateSpreadHistory 的 verdict） */
const REASON_LABELS: Record<SpreadHistoryReason, string> = {
  'no-history': '无历史',
  'price-outlier': '价格异常',
  inactive: '7天不活跃',
};

function formatIsk(value: number | null): string {
  if (value === null) return '—';
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatRate(value: number): string {
  return `${(value * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}

function spreadKey(row: SpreadRow): string {
  return `${row.typeId}:${row.buyRegionId}:${row.sellRegionId}`;
}

function regionName(zh: string | null, en: string): string {
  return zh ?? en;
}

/**
 * 跨区价差视图（P5-2）：
 * 第一段 SQL 粗筛（零请求，只读本地快照）；
 * 第二段「历史校验」为用户手势触发的按需拉取（ESI 日线 24h 缓存，复看零请求）。
 *
 * 页首挂「历史数据全量初始化」面板（P5-2.8）：手动把 5 枢纽候选的 400 天历史补满，
 * 使下方的历史校验对枢纽候选零等待；未覆盖的候选仍走按需兜底。
 */
export default function SpreadPage({ init }: { init: HistoryInitHandle }) {
  const [scope, setScope] = useState<RegionScope>('all');
  const [sortBy, setSortBy] = useState<SpreadSortKey>(DEFAULT_SPREAD_FILTERS.sortBy);
  const [limitInput, setLimitInput] = useState(String(DEFAULT_SPREAD_FILTERS.limit));

  const [rows, setRows] = useState<SpreadRow[]>([]);
  const [names, setNames] = useState<Map<number, TypeNameEntry>>(new Map());
  const [freshness, setFreshness] = useState<SpreadFreshness | null>(null);
  const [verdicts, setVerdicts] = useState<Map<string, SpreadHistoryVerdict>>(new Map());

  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState('');

  const limit = useMemo(() => {
    const parsed = Number.parseInt(limitInput.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SPREAD_FILTERS.limit;
  }, [limitInput]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const { db } = await initCoreRuntime();
      const regionIds = scope === 'hubs' ? TRADE_HUBS.map((hub) => hub.regionId) : [];
      const spreadRows = await rankCrossRegionSpreads(db, { regionIds, limit, sortBy });
      const [fresh, nameMap] = await Promise.all([
        getSpreadFreshness(db, regionIds),
        spreadRows.length === 0
          ? new Map<number, TypeNameEntry>()
          : await getTypeNames(db, spreadRows.map((row) => row.typeId)),
      ]);
      setRows(spreadRows);
      setFreshness(fresh);
      setNames(nameMap);
      setMessage('');
    } catch (error) {
      setMessage(`价差查询失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setLoading(false);
    }
  }, [scope, limit, sortBy]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** 历史校验：对当前结果行按需拉取 ESI 日线（走共享调度器，复看零请求） */
  const runCheck = useCallback(async () => {
    if (rows.length === 0 || checking) return;
    setChecking(true);
    try {
      const { db, esiClient, scheduler } = await initCoreRuntime();
      const result = await validateSpreadHistory({ db, client: esiClient, scheduler }, rows);
      setVerdicts(new Map(result.map((verdict, index) => [spreadKey(rows[index]), verdict])));
      const passed = result.filter((verdict) => verdict.passed).length;
      setMessage(`历史校验完成：${passed}/${result.length} 条通过`);
    } catch (error) {
      setMessage(`历史校验失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setChecking(false);
    }
  }, [rows, checking]);

  const nameOf = useCallback(
    (typeId: number): string => {
      const entry = names.get(typeId);
      if (entry === undefined) return `typeID ${typeId}`;
      return entry.nameZh ?? entry.nameEn;
    },
    [names],
  );

  return (
    <section className="market">
      <HistoryInitPanel init={init} />

      <div className="panel">
        <div className="panel-head">
          <h2>跨区价差</h2>
          <span className="hint">
            买价 = 买入区卖价 5% 分位；卖价 = 卖出区买价 95% 分位（抗钓鱼单口径）；不含税费与运费
          </span>
        </div>

        <div className="params">
          <label>
            区域范围
            <select value={scope} onChange={(event) => setScope(event.target.value as RegionScope)}>
              <option value="all">全部已采集区域（70 区）</option>
              <option value="hubs">仅五大枢纽之间</option>
            </select>
          </label>
          <label>
            排序
            <select
              value={sortBy}
              onChange={(event) => setSortBy(event.target.value as SpreadSortKey)}
            >
              {SORT_LABELS.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            条数上限
            <input
              type="number"
              min={1}
              value={limitInput}
              onChange={(event) => setLimitInput(event.target.value)}
            />
          </label>
          <button type="button" disabled={loading} onClick={() => void refresh()}>
            {loading ? '查询中…' : '查询'}
          </button>
          <button type="button" disabled={checking || rows.length === 0} onClick={() => void runCheck()}>
            {checking ? '校验中…' : '历史校验'}
          </button>
        </div>

        <p className="hint">
          流动性门槛：买入区在架卖单 ≥ {DEFAULT_SPREAD_FILTERS.minSellOrders} 笔、卖出区在架买单 ≥{' '}
          {DEFAULT_SPREAD_FILTERS.minBuyOrders} 笔、价差率 ≤ {formatRate(DEFAULT_SPREAD_FILTERS.maxSpreadRate)}
          ；历史校验锚：30 天均价 ±2.5×、卖出区近 7 天成交 ≥ 4 天
          {freshness !== null && freshness.statsRows > 0 && (
            <>
              ；快照 {freshness.minUpdatedAt === null ? '—' : new Date(freshness.minUpdatedAt).toLocaleString()} ~{' '}
              {freshness.maxUpdatedAt === null ? '—' : new Date(freshness.maxUpdatedAt).toLocaleString()} ·{' '}
              {freshness.statsRows.toLocaleString()} 行统计
            </>
          )}
        </p>

        {rows.length === 0 ? (
          <p className="hint">暂无符合条件的价差行（先在「行情」页完成采集，或放宽区域范围）。</p>
        ) : (
          <table className="result">
            <thead>
              <tr>
                <th>物品</th>
                <th>买入区</th>
                <th>买价</th>
                <th>卖出区</th>
                <th>卖价</th>
                <th>单件价差</th>
                <th>价差率</th>
                <th>ISK/m³</th>
                <th>订单 买/卖</th>
                <th>历史校验</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const verdict = verdicts.get(spreadKey(row));
                return (
                  <tr key={spreadKey(row)}>
                    <td>{nameOf(row.typeId)}</td>
                    <td>{regionName(row.buyRegionNameZh, row.buyRegionNameEn)}</td>
                    <td className="sell">{formatIsk(row.buyPrice)}</td>
                    <td>{regionName(row.sellRegionNameZh, row.sellRegionNameEn)}</td>
                    <td className="buy">{formatIsk(row.sellPrice)}</td>
                    <td>{formatIsk(row.spreadIsk)}</td>
                    <td>{formatRate(row.spreadRate)}</td>
                    <td>{formatIsk(row.iskPerM3)}</td>
                    <td>
                      {row.buySellOrders} / {row.sellBuyOrders}
                    </td>
                    <td>
                      {verdict === undefined ? (
                        <span className="hint">未校验</span>
                      ) : verdict.passed ? (
                        '通过'
                      ) : (
                        verdict.reasons.map((reason) => (
                          <span key={reason} className="message">
                            {REASON_LABELS[reason]}
                          </span>
                        ))
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {message.length > 0 && <p className="message">{message}</p>}
      </div>
    </section>
  );
}
