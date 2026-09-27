import {
  exportWatchlistCsv,
  listWatchItems,
  removeWatchItem,
  type WatchlistItem,
} from '@eve-suite/core';
import { openAdapter } from '@eve-suite/core/db/tauri';
import { useCallback, useEffect, useState } from 'react';

/** 监视列表页：条目管理 + 6 小时聚合历史 + CSV 导出 */
export default function WatchlistPage() {
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [message, setMessage] = useState('');
  const [csv, setCsv] = useState('');

  const refresh = useCallback(async () => {
    const db = await openAdapter();
    setItems(await listWatchItems(db));
  }, []);

  useEffect(() => {
    void refresh().catch((error: unknown) =>
      setMessage(`读取监视列表失败：${error instanceof Error ? error.message : String(error)}`),
    );
  }, [refresh]);

  const handleRemove = useCallback(
    async (watchId: number) => {
      try {
        const db = await openAdapter();
        await removeWatchItem(db, watchId);
        await refresh();
        setMessage('已移出监视');
      } catch (error) {
        setMessage(`移出失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [refresh],
  );

  const handleExport = useCallback(async () => {
    try {
      const db = await openAdapter();
      setCsv(await exportWatchlistCsv(db));
      setMessage(`已生成 CSV（${items.length} 条）`);
    } catch (error) {
      setMessage(`导出失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [items.length]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(csv);
      setMessage('CSV 已复制到剪贴板');
    } catch {
      setMessage('复制失败，请手动选中下方文本复制');
    }
  }, [csv]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `eve-suite-watchlist-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }, [csv]);

  return (
    <section className="market">
      <div className="panel">
        <div className="panel-head">
          <h2>监视列表</h2>
          <div className="tabs">
            <button type="button" onClick={() => void refresh()}>
              刷新
            </button>
            <button type="button" onClick={() => void handleExport()}>
              导出 CSV
            </button>
            {csv.length > 0 && (
              <>
                <button type="button" onClick={() => void handleCopy()}>
                  复制
                </button>
                <button type="button" onClick={handleDownload}>
                  下载
                </button>
              </>
            )}
          </div>
        </div>

        {items.length === 0 ? (
          <p className="hint">暂无监视物品。可在「行情」页搜索物品后点击「加入监视」。</p>
        ) : (
          <table className="result">
            <thead>
              <tr>
                <th>物品</th>
                <th>枢纽</th>
                <th>最低卖价</th>
                <th>最高买价</th>
                <th>价差</th>
                <th>5% 分位</th>
                <th>更新时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.watchId}>
                  <td>
                    {item.nameZh ?? item.nameEn ?? `typeID ${item.typeId}`}
                    {item.nameZh !== null && item.nameEn !== null ? ` (${item.nameEn})` : ''}
                  </td>
                  <td>{item.regionNameZh ?? item.regionNameEn ?? item.regionId}</td>
                  <td className="sell">{formatIsk(item.bestSell)}</td>
                  <td className="buy">{formatIsk(item.bestBuy)}</td>
                  <td>{formatIsk(item.spread)}</td>
                  <td>{formatIsk(item.p5Sell)}</td>
                  <td>
                    {item.updatedAt === null ? '未采集' : new Date(item.updatedAt).toLocaleString()}
                  </td>
                  <td>
                    <button type="button" onClick={() => void handleRemove(item.watchId)}>
                      移出
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {message.length > 0 && <p className="message">{message}</p>}
      </div>

      {csv.length > 0 && (
        <div className="panel">
          <h2>CSV 预览</h2>
          <textarea className="csv" value={csv} readOnly rows={8} />
        </div>
      )}
    </section>
  );
}

function formatIsk(value: number | null): string {
  if (value === null) return '—';
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
