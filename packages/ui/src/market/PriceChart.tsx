import {
  CandlestickSeries,
  ColorType,
  createChart,
  type IChartApi,
  type ISeriesApi,
} from 'lightweight-charts';
import { useEffect, useRef } from 'react';

export interface PricePoint {
  date: string;
  average: number;
  highest: number;
  lowest: number;
  volume: number;
}

interface PriceChartProps {
  points: readonly PricePoint[];
  height?: number;
}

/**
 * 日线 K 线图（Lightweight-charts v5）。
 * ESI 日线只提供平均/最高/最低价，故用「平均价」同时充当开收价绘制实体。
 */
export default function PriceChart({ points, height = 300 }: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);

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
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#4ade80',
      downColor: '#f87171',
      borderVisible: false,
      wickUpColor: '#4ade80',
      wickDownColor: '#f87171',
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const observer = new ResizeObserver(() => {
      chart.applyOptions({ width: container.clientWidth });
    });
    observer.observe(container);
    chart.applyOptions({ width: container.clientWidth });

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [height]);

  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (series === null || chart === null) return;

    series.setData(
      points.map((point) => ({
        time: point.date,
        open: point.average,
        high: point.highest,
        low: point.lowest,
        close: point.average,
      })),
    );
    chart.timeScale().fitContent();
  }, [points]);

  return <div className="chart" ref={containerRef} style={{ height }} />;
}
