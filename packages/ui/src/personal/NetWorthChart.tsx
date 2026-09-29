import {
  AreaSeries,
  ColorType,
  LineSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
} from 'lightweight-charts';
import { useEffect, useRef } from 'react';

/**
 * 净值趋势折线图（Lightweight-charts v5）。
 *
 * 图例：
 * - 主线 = 快照的**合计净值**（面积图）
 * - 可选叠加 4 个分项（资产 / 钱包 / 未成交卖单 / 合同）
 *
 * 口径提醒（与快照表一致）：横轴是**快照日期（UTC 日）**，同日只更新不新增；
 * **没同步的那天没有数据点**，故折线可能出现断口 —— 断口表示「无快照」，不是 0。
 */
export interface NetWorthPoint {
  snapshotDate: string;
  totalValue: number;
  assetsValue: number;
  walletBalance: number;
  sellOrdersValue: number;
  contractsValue: number;
}

interface NetWorthChartProps {
  points: readonly NetWorthPoint[];
  /** 叠加四个分项折线（默认只画合计净值） */
  showBreakdown?: boolean;
  height?: number;
}

/** 分项线的顺序与配色（与主线区分度优先） */
const BREAKDOWN_SERIES = [
  { key: 'assetsValue', color: '#4ade80' },
  { key: 'walletBalance', color: '#facc15' },
  { key: 'sellOrdersValue', color: '#c084fc' },
  { key: 'contractsValue', color: '#fb923c' },
] as const;

/** 一天（毫秒） */
const DAY_MS = 24 * 60 * 60 * 1000;

/** 图上的一段：有值 = 数据点，无值 = 该日无快照的「空白点」 */
type SeriesSegment = { time: string; value: number } | { time: string };

/**
 * 把「有点的日期」展开成「首末之间逐日」的序列，**缺失日期补空白点**。
 *
 * 为什么必须补：lightweight-charts 对缺失时间点会**直接连线**，视觉上等于「那几天有数据」——
 * 会掩盖「隔几天没开应用」的事实。补空白点后缺口才真实可见（2026-09-29 真机走查发现）。
 */
function withGaps(
  points: readonly NetWorthPoint[],
  pick: (point: NetWorthPoint) => number,
): SeriesSegment[] {
  if (points.length === 0) return [];
  const byDate = new Map(points.map((point) => [point.snapshotDate, point]));
  const startMs = Date.parse(`${points[0].snapshotDate}T00:00:00Z`);
  const endMs = Date.parse(`${points[points.length - 1].snapshotDate}T00:00:00Z`);

  const segments: SeriesSegment[] = [];
  for (let ms = startMs; ms <= endMs; ms += DAY_MS) {
    const date = new Date(ms).toISOString().slice(0, 10);
    const point = byDate.get(date);
    segments.push(point === undefined ? { time: date } : { time: date, value: pick(point) });
  }
  return segments;
}

export default function NetWorthChart({
  points,
  showBreakdown = false,
  height = 280,
}: NetWorthChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const totalRef = useRef<ISeriesApi<'Area'> | null>(null);
  const breakdownRefs = useRef<Array<ISeriesApi<'Line'>>>([]);

  // 建图 / 销毁：分项开关变化时重建（系列增删在 v5 需先 remove 或重建，重建最简单且无状态残留）
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const chart = createChart(container, {
      height,
      layout: {
        background: { type: ColorType.Solid, color: '#121721' },
        textColor: '#8a97a8',
      },
      grid: {
        vertLines: { color: '#1a2230' },
        horzLines: { color: '#1a2230' },
      },
      rightPriceScale: { borderColor: '#1f2937' },
      timeScale: { borderColor: '#1f2937' },
    });
    const total = chart.addSeries(AreaSeries, {
      lineColor: '#7fd6ff',
      topColor: 'rgba(127, 214, 255, 0.28)',
      bottomColor: 'rgba(127, 214, 255, 0.02)',
      lineWidth: 2,
    });
    const breakdown = showBreakdown
      ? BREAKDOWN_SERIES.map((item) =>
          chart.addSeries(LineSeries, { color: item.color, lineWidth: 1 }),
        )
      : [];

    chartRef.current = chart;
    totalRef.current = total;
    breakdownRefs.current = breakdown;

    const observer = new ResizeObserver(() => {
      chart.applyOptions({ width: container.clientWidth });
    });
    observer.observe(container);
    chart.applyOptions({ width: container.clientWidth });

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      totalRef.current = null;
      breakdownRefs.current = [];
    };
  }, [height, showBreakdown]);

  // 灌数据
  useEffect(() => {
    const chart = chartRef.current;
    const total = totalRef.current;
    if (chart === null || total === null) return;

    total.setData(withGaps(points, (point) => point.totalValue));
    breakdownRefs.current.forEach((series, index) => {
      const key = BREAKDOWN_SERIES[index].key;
      series.setData(withGaps(points, (point) => point[key]));
    });
    chart.timeScale().fitContent();
  }, [points, showBreakdown]);

  return <div className="chart" ref={containerRef} style={{ height }} />;
}
