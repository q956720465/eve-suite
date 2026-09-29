import {
  DEFAULT_SPREAD_DEPTH_QUANTITY,
  DEFAULT_SPREAD_FILTERS,
  MAX_SPREAD_DEPTH_QUANTITY,
  TRADE_HUBS,
  computeSpreadCapture,
  computeSpreadDepth,
  getTypeNames,
  getSpreadFreshness,
  normalizeSpreadDepthQuantity,
  rankCrossRegionSpreads,
  readSpreadLiquidityStats,
  spreadCaptureKey,
  spreadDepthKey,
  validateSpreadHistory,
  type SpreadCaptureResult,
  type SpreadDepthResult,
  type SpreadFreshness,
  type SpreadHistoryReason,
  type SpreadHistoryVerdict,
  type SpreadLiquidityStats,
  type SpreadRow,
  type SpreadSortKey,
  type TypeNameEntry,
} from '@eve-suite/core';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

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
 * 流动性单元格（P11-3）：无历史 / 无成交 / 数值。
 * 「无历史」判定与 core 的历史校验一致（`avgVolume30 === null` → no-history）。
 */
function renderLiquidity(
  stats: SpreadLiquidityStats | undefined,
  value: number | null,
  digits: number,
): ReactNode {
  if (stats === undefined || stats.avgVolume30 === null) {
    return <span className="hint">无历史</span>;
  }
  if (value === null) return <span className="hint">无成交</span>;
  return `${value.toFixed(digits)} 天`;
}

/**
 * 现实捕获份额（P11-4）：`q* / Q`。份额**在渲染时按当前目标量重算**（core 只给绝对量 `q*`）。
 * 单侧无单 → 「无卖单 / 无买单」；两侧有单但无盈利 → `0%`；`q* ≥ Q` → 封顶 `100%`（括号内仍报真实量）。
 */
function renderCapture(
  capture: SpreadCaptureResult | undefined,
  targetQuantity: number,
): ReactNode {
  if (capture === undefined) return <span className="hint">—</span>;
  if (capture.noSellOrders) return <span className="hint">无卖单</span>;
  if (capture.noBuyOrders) return <span className="hint">无买单</span>;
  if (capture.captureQuantity === 0) return '0%';
  const share = capture.captureQuantity / targetQuantity;
  const percent = Math.min(share, 1) * 100;
  return `${percent.toFixed(0)}%（${capture.captureQuantity.toLocaleString()}）`;
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
  const [depthInput, setDepthInput] = useState(String(DEFAULT_SPREAD_DEPTH_QUANTITY));

  const [rows, setRows] = useState<SpreadRow[]>([]);
  const [names, setNames] = useState<Map<number, TypeNameEntry>>(new Map());
  const [freshness, setFreshness] = useState<SpreadFreshness | null>(null);
  const [verdicts, setVerdicts] = useState<Map<string, SpreadHistoryVerdict>>(new Map());
  const [depths, setDepths] = useState<Map<string, SpreadDepthResult>>(new Map());
  const [liquidity, setLiquidity] = useState<Map<string, SpreadLiquidityStats>>(new Map());
  const [captures, setCaptures] = useState<Map<string, SpreadCaptureResult>>(new Map());

  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [depthLoading, setDepthLoading] = useState(false);
  const [liquidityLoading, setLiquidityLoading] = useState(false);
  const [captureLoading, setCaptureLoading] = useState(false);
  const [message, setMessage] = useState('');

  const limit = useMemo(() => {
    const parsed = Number.parseInt(limitInput.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SPREAD_FILTERS.limit;
  }, [limitInput]);

  /** 目标量（非法输入回退默认；上/下限见 core 的 normalizeSpreadDepthQuantity） */
  const depthQuantity = useMemo(
    () => normalizeSpreadDepthQuantity(Number.parseInt(depthInput.trim(), 10)),
    [depthInput],
  );

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

  /**
   * 订单簿深度（P11-2）：按目标量在**买入区**模拟吃卖单。
   * 刻意与 `refresh` 分开 —— 改目标量只重算本列，**不重跑粗筛、不清空历史校验结果**。
   */
  useEffect(() => {
    if (rows.length === 0) {
      setDepths(new Map());
      setDepthLoading(false);
      return;
    }
    let cancelled = false;
    setDepthLoading(true);
    void (async () => {
      try {
        const { db } = await initCoreRuntime();
        const targets = rows.map((row) => ({ regionId: row.buyRegionId, typeId: row.typeId }));
        const result = await computeSpreadDepth(db, targets, depthQuantity);
        if (!cancelled) setDepths(result);
      } catch (error) {
        if (!cancelled) {
          setDepths(new Map());
          setMessage(`深度计算失败：${error instanceof Error ? error.message : String(error)}`);
        }
      } finally {
        if (!cancelled) setDepthLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rows, depthQuantity]);

  /**
   * 流动性 / 库存天数（P11-3）：**只读已入库日线**（零 ESI 请求）。
   * 同样与 `refresh` 分开 —— 只依赖 `rows`（**与目标量无关**），因此改目标量不会重算本列。
   * 买入区与卖出区都查：成交天数取卖出区（能否卖掉），库存天数取买入区（供给能撑多久）。
   */
  useEffect(() => {
    if (rows.length === 0) {
      setLiquidity(new Map());
      setLiquidityLoading(false);
      return;
    }
    let cancelled = false;
    setLiquidityLoading(true);
    void (async () => {
      try {
        const { db } = await initCoreRuntime();
        const targets = rows.flatMap((row) => [
          { regionId: row.buyRegionId, typeId: row.typeId },
          { regionId: row.sellRegionId, typeId: row.typeId },
        ]);
        const result = await readSpreadLiquidityStats(db, targets);
        if (!cancelled) setLiquidity(result);
      } catch (error) {
        if (!cancelled) {
          setLiquidity(new Map());
          setMessage(`流动性统计失败：${error instanceof Error ? error.message : String(error)}`);
        }
      } finally {
        if (!cancelled) setLiquidityLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rows]);

  /**
   * 现实捕获份额（P11-4）：成本侧（买入区卖单）× 收益侧（卖出区买单）的边际交叉点 `q*`。
   * `q*` **与目标量无关** → 本 effect **只依赖 `rows`**，改目标量只重算份额百分比、**零查询**。
   */
  useEffect(() => {
    if (rows.length === 0) {
      setCaptures(new Map());
      setCaptureLoading(false);
      return;
    }
    let cancelled = false;
    setCaptureLoading(true);
    void (async () => {
      try {
        const { db } = await initCoreRuntime();
        const targets = rows.map((row) => ({
          typeId: row.typeId,
          buyRegionId: row.buyRegionId,
          sellRegionId: row.sellRegionId,
        }));
        const result = await computeSpreadCapture(db, targets);
        if (!cancelled) setCaptures(result);
      } catch (error) {
        if (!cancelled) {
          setCaptures(new Map());
          setMessage(`现实捕获计算失败：${error instanceof Error ? error.message : String(error)}`);
        }
      } finally {
        if (!cancelled) setCaptureLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rows]);

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
          <label>
            目标量（单位）
            <input
              type="number"
              min={1}
              max={MAX_SPREAD_DEPTH_QUANTITY}
              value={depthInput}
              onChange={(event) => setDepthInput(event.target.value)}
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

        <p className="hint">
          「可成交均价」= 在买入区按目标量 {depthQuantity.toLocaleString()} 单位模拟吃卖单的 VWAP
          （与买价同口径：排除 min_volume&gt;1 的整批大单；量不足时按实际可吃量计并标注比例）
        </p>

        <p className="hint">
          「卖区成交天数」= 卖出区近 7 天有成交的天数（与「历史校验」的活跃门槛同口径，≥
          4 天为通过）；「买区库存天数」= 买入区在架卖量 ÷ 买入区近 30 天日均成交量。
          <strong>只读已入库日线，不发任何请求</strong> —— 日线仅覆盖 5 枢纽全量 + 按需拉取过的物品，
          其余多显示「无历史」；日均成交量为 0 时显示「无成交」
        </p>

        <p className="hint">
          「现实捕获份额」= 同时吃买入区卖单 + 卖给卖出区买单，<strong>两簿走量后仍保持边际为正</strong>
          的可成交量 q* ÷ 目标量 {depthQuantity.toLocaleString()}（括号内为绝对量）。两侧按同一口径排除
          min_volume&gt;1 的整批大单；收益侧已剔除高于 p95_buy 的钓鱼买单。q* 与目标量无关：
          改目标量只重算百分比、<strong>不发任何查询</strong>
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
                <th>可成交均价</th>
                <th>卖出区</th>
                <th>卖价</th>
                <th>单件价差</th>
                <th>价差率</th>
                <th>现实捕获份额</th>
                <th>ISK/m³</th>
                <th>订单 买/卖</th>
                <th>卖区成交天数</th>
                <th>买区库存天数</th>
                <th>历史校验</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const verdict = verdicts.get(spreadKey(row));
                const depth = depths.get(spreadDepthKey(row.buyRegionId, row.typeId));
                const buyLiquidity = liquidity.get(spreadDepthKey(row.buyRegionId, row.typeId));
                const sellLiquidity = liquidity.get(spreadDepthKey(row.sellRegionId, row.typeId));
                const capture = captures.get(
                  spreadCaptureKey(row.typeId, row.buyRegionId, row.sellRegionId),
                );
                return (
                  <tr key={spreadKey(row)}>
                    <td>{nameOf(row.typeId)}</td>
                    <td>{regionName(row.buyRegionNameZh, row.buyRegionNameEn)}</td>
                    <td className="sell">{formatIsk(row.buyPrice)}</td>
                    <td>
                      {depthLoading ? (
                        <span className="hint">计算中…</span>
                      ) : depth === undefined || depth.averagePrice === null ? (
                        <span className="hint">无卖单</span>
                      ) : (
                        <>
                          {formatIsk(depth.averagePrice)}
                          {!depth.sufficient && (
                            <span className="hint">
                              （量不足：可吃{' '}
                              {Math.floor((depth.availableQuantity / depthQuantity) * 100)}%）
                            </span>
                          )}
                        </>
                      )}
                    </td>
                    <td>{regionName(row.sellRegionNameZh, row.sellRegionNameEn)}</td>
                    <td className="buy">{formatIsk(row.sellPrice)}</td>
                    <td>{formatIsk(row.spreadIsk)}</td>
                    <td>{formatRate(row.spreadRate)}</td>
                    <td>
                      {captureLoading ? (
                        <span className="hint">计算中…</span>
                      ) : (
                        renderCapture(capture, depthQuantity)
                      )}
                    </td>
                    <td>{formatIsk(row.iskPerM3)}</td>
                    <td>
                      {row.buySellOrders} / {row.sellBuyOrders}
                    </td>
                    <td>
                      {liquidityLoading ? (
                        <span className="hint">计算中…</span>
                      ) : (
                        renderLiquidity(sellLiquidity, sellLiquidity?.activeDays7 ?? null, 0)
                      )}
                    </td>
                    <td>
                      {liquidityLoading ? (
                        <span className="hint">计算中…</span>
                      ) : (
                        renderLiquidity(buyLiquidity, buyLiquidity?.daysOfSupply ?? null, 1)
                      )}
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
