import {
  addWatchItem,
  createFetchHttpClient,
  EsiClient,
  getDailyHistory,
  getOrderBook,
  getTypeStatsAcrossHubs,
  refreshTypeHistory,
  refreshTypeOrders,
  RequestScheduler,
  searchTypes,
  TRADE_HUBS,
  type HubPriceComparison,
  type OrderBook,
  type TypeSearchHit,
} from '@eve-suite/core';
import { openAdapter } from '@eve-suite/core/db/tauri';
import { useCallback, useEffect, useRef, useState } from 'react';

import GlobalScanPanel from './GlobalScanPanel';
import PriceChart, { type PricePoint } from './PriceChart';
import type { GlobalScannerHandle } from './useGlobalScanner';
import type { MarketCollectorHandle } from './useMarketCollector';

const HUB_REGION_IDS = TRADE_HUBS.map((hub) => hub.regionId);
/** 基准区域：吉他（The Forge），订单簿与图表以此为准 */
const BASELINE_REGION_ID = HUB_REGION_IDS[0];

/** 行情页：采集状态 + 全域层 + 物品行情（跨枢纽比价 / 订单簿 / 日线走势）+ 加入监视 */
export default function MarketPage({
  collector,
  scanner,
}: {
  collector: MarketCollectorHandle;
  scanner: GlobalScannerHandle;
}) {
  const [message, setMessage] = useState('');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<TypeSearchHit[]>([]);
  const [selected, setSelected] = useState<TypeSearchHit | null>(null);
  const [comparison, setComparison] = useState<HubPriceComparison[]>([]);
  const [book, setBook] = useState<OrderBook | null>(null);
  const [history, setHistory] = useState<PricePoint[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  // 按需查询用的依赖（与采集分离，避免互相阻塞）
  const depsRef = useRef<{ client: EsiClient; scheduler: RequestScheduler } | null>(null);
  useEffect(() => {
    depsRef.current = {
      client: new EsiClient({ http: createFetchHttpClient() }),
      scheduler: new RequestScheduler({ requestsPerSecond: 6, burst: 12, maxConcurrent: 3 }),
    };
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setHits([]);
      return;
    }
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const db = await openAdapter();
          setHits(await searchTypes(db, trimmed, 20));
        } catch (error) {
          setMessage(`搜索失败：${error instanceof Error ? error.message : String(error)}`);
        }
      })();
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  const loadLocal = useCallback(async (typeId: number) => {
    const db = await openAdapter();
    const [nextComparison, nextBook, nextHistory] = await Promise.all([
      getTypeStatsAcrossHubs(db, HUB_REGION_IDS, typeId),
      getOrderBook(db, BASELINE_REGION_ID, typeId, 15),
      getDailyHistory(db, BASELINE_REGION_ID, typeId, 400),
    ]);
    setComparison(nextComparison);
    setBook(nextBook);
    setHistory(nextHistory);
  }, []);

  const handleSelect = useCallback(
    async (hit: TypeSearchHit) => {
      setSelected(hit);
      setDetailLoading(true);
      setMessage('');
      try {
        // 先用本地缓存渲染，再按需刷新（订单 TTL 5 分钟 / 日线每日一次）
        await loadLocal(hit.typeId);

        const deps = depsRef.current;
        if (deps !== null) {
          const db = await openAdapter();
          const market = { db, client: deps.client, scheduler: deps.scheduler };
          await refreshTypeOrders(market, BASELINE_REGION_ID, hit.typeId).catch(() => undefined);
          await refreshTypeHistory(market, BASELINE_REGION_ID, hit.typeId).catch(() => undefined);
          await loadLocal(hit.typeId);
        }
      } catch (error) {
        setMessage(`加载行情失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setDetailLoading(false);
      }
    },
    [loadLocal],
  );

  const handleWatch = useCallback(async () => {
    if (selected === null) return;
    try {
      const db = await openAdapter();
      await addWatchItem(db, selected.typeId, BASELINE_REGION_ID);
      setMessage(`已加入监视：${selected.nameZh ?? selected.nameEn}（基准区域：吉他）`);
    } catch (error) {
      setMessage(`加入监视失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [selected]);

  return (
    <section className="market">
      <div className="panel">
        <div className="panel-head">
          <h2>行情采集 · 5 枢纽 · 每 5 分钟</h2>
          <div className="tabs">
            <button
              type="button"
              onClick={() => void collector.collectNow()}
              disabled={collector.busy}
            >
              {collector.busy ? '采集中…' : '立即采集'}
            </button>
            <button
              type="button"
              className={collector.paused ? 'active' : ''}
              onClick={collector.togglePause}
            >
              {collector.paused ? '已暂停' : '暂停采集'}
            </button>
          </div>
        </div>

        <table className="result">
          <thead>
            <tr>
              <th>枢纽</th>
              <th>订单数</th>
              <th>页数</th>
              <th>最后成功</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {collector.states.map((state) => (
              <tr key={state.regionId}>
                <td>{state.regionNameZh ?? state.regionNameEn}</td>
                <td>{state.orderCount.toLocaleString()}</td>
                <td>{state.pages}</td>
                <td>
                  {state.lastOkAt === null ? '—' : new Date(state.lastOkAt).toLocaleString()}
                </td>
                <td>{state.lastError ?? '正常'}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <p className="message">{message.length > 0 ? message : collector.message}</p>
      </div>

      <GlobalScanPanel scanner={scanner} paused={collector.paused} />

      <div className="panel">
        <div className="panel-head">
          <h2>物品行情</h2>
        </div>
        <input
          className="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="输入物品名（如 Tritanium / 三钛合金）"
        />

        {hits.length > 0 && (
          <table className="result">
            <thead>
              <tr>
                <th>typeID</th>
                <th>名称</th>
                <th>中文名</th>
                <th>分组</th>
              </tr>
            </thead>
            <tbody>
              {hits.map((hit) => (
                <tr
                  key={hit.typeId}
                  className={selected?.typeId === hit.typeId ? 'selected' : ''}
                  onClick={() => void handleSelect(hit)}
                >
                  <td>{hit.typeId}</td>
                  <td>{hit.nameEn}</td>
                  <td>{hit.nameZh ?? '—'}</td>
                  <td>{hit.groupNameZh ?? hit.groupNameEn ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selected !== null && (
        <>
          <div className="panel">
            <div className="panel-head">
              <h2>
                {selected.nameZh ?? selected.nameEn} · typeID {selected.typeId}
              </h2>
              <div className="tabs">
                <button type="button" onClick={() => void handleWatch()}>
                  加入监视
                </button>
                <button
                  type="button"
                  onClick={() => void handleSelect(selected)}
                  disabled={detailLoading}
                >
                  {detailLoading ? '刷新中…' : '刷新行情'}
                </button>
              </div>
            </div>

            <table className="result">
              <thead>
                <tr>
                  <th>枢纽</th>
                  <th>最低卖价</th>
                  <th>最高买价</th>
                  <th>5% 分位</th>
                  <th>价差</th>
                  <th>卖量</th>
                  <th>买量</th>
                  <th>更新时间</th>
                </tr>
              </thead>
              <tbody>
                {comparison.map((row) => (
                  <tr key={row.regionId}>
                    <td>{row.regionNameZh ?? row.regionNameEn}</td>
                    <td className="sell">{formatIsk(row.stats?.bestSell)}</td>
                    <td className="buy">{formatIsk(row.stats?.bestBuy)}</td>
                    <td>{formatIsk(row.stats?.p5Sell)}</td>
                    <td>{formatIsk(row.stats?.spread)}</td>
                    <td>{row.stats === null ? '—' : row.stats.sellVolume.toLocaleString()}</td>
                    <td>{row.stats === null ? '—' : row.stats.buyVolume.toLocaleString()}</td>
                    <td>
                      {row.stats === null
                        ? '未采集'
                        : new Date(row.stats.updatedAt).toLocaleTimeString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="panel">
            <h2>日线走势 · 吉他 · 约 400 天</h2>
            {history.length > 0 ? (
              <PriceChart points={history} />
            ) : (
              <p className="hint">暂无历史数据（首次打开该物品时自动拉取）。</p>
            )}
          </div>

          <div className="panel">
            <h2>订单簿 · 吉他 · 前 15 档</h2>
            <div className="orderbook">
              <table className="result">
                <thead>
                  <tr>
                    <th>卖单价格</th>
                    <th>剩余量</th>
                  </tr>
                </thead>
                <tbody>
                  {(book?.sells ?? []).map((entry) => (
                    <tr key={entry.orderId}>
                      <td className="sell">{formatIsk(entry.price)}</td>
                      <td>{entry.volumeRemain.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <table className="result">
                <thead>
                  <tr>
                    <th>买单价格</th>
                    <th>剩余量</th>
                  </tr>
                </thead>
                <tbody>
                  {(book?.buys ?? []).map((entry) => (
                    <tr key={entry.orderId}>
                      <td className="buy">{formatIsk(entry.price)}</td>
                      <td>{entry.volumeRemain.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function formatIsk(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
