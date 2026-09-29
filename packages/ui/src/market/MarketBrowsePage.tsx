import {
  getMarketGroupPath,
  getMarketStationScope,
  getStationOrderBook,
  getStationTypeRow,
  getTypeDetail,
  listMarketGroupChildren,
  listMarketTypes,
  MARKET_BROWSE_DEFAULT_LIMIT,
  MARKET_BROWSE_MAX_LIMIT,
  searchMarketTypes,
  type MarketGroupNode,
  type MarketGroupRef,
  type MarketStationScope,
  type MarketTypeList,
  type MarketTypeRow,
  type MarketTypeSortKey,
  type SortDirection,
  type StationOrderBook,
  type TypeDetail,
} from '@eve-suite/core';
import { initDatabase, openAdapter } from '@eve-suite/core/db/tauri';
import { isTauri } from '@tauri-apps/api/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * 市场浏览（P9-1-2）：三栏结构对齐游戏内市场 —— 左=市场分组树 / 中=物品列表 / 右=详情与订单簿。
 *
 * 取数全部走 `@eve-suite/core` 公共出口的 `market/browse.ts`（P9-1-1）：
 * - 左树懒加载（`listMarketGroupChildren`），已加载层缓存在内存
 * - 中列 = 选中分组**及其全部后代**的物品 + 所选站点点位报价（`listMarketTypes`）
 * - 搜索命中时中列切换为搜索结果（`searchMarketTypes`），点结果可「定位」回分组树
 * - 详情 = SDE 物品详情 + 站点点位 + 站点订单簿
 */

/** 五大枢纽主交易站：固定候选（与「资产」页净值基准站点同值） */
const HUB_STATIONS: readonly { stationId: number; label: string }[] = [
  { stationId: 60003760, label: '吉他 4-4 · The Forge' },
  { stationId: 60008494, label: '艾玛 · Domain' },
  { stationId: 60011866, label: '多迪谢 · Sinq Laison' },
  { stationId: 60005686, label: '赫克 · Metropolis' },
  { stationId: 60004588, label: '伦斯 · Heimatar' },
];

const DEFAULT_STATION_ID = HUB_STATIONS[0].stationId;

/** 每页条数候选（core 上限 1000） */
const PAGE_SIZES: readonly number[] = [200, 500, 1000];

/** 可排序列（排序键直接复用 core 的 `MarketTypeSortKey`，不自造第二套） */
const SORT_COLUMNS: readonly { key: MarketTypeSortKey; label: string }[] = [
  { key: 'name', label: '名称' },
  { key: 'bestSell', label: '卖价' },
  { key: 'bestBuy', label: '买价' },
  { key: 'sellVolume', label: '卖量' },
  { key: 'buyVolume', label: '买量' },
];

/** 订单簿单侧档位 */
const ORDER_BOOK_SIDE = 20;

/** 根层缓存的键（`parentGroupId` 为 null） */
const ROOT_KEY = '__root__';

interface DetailBundle {
  type: TypeDetail | null;
  row: MarketTypeRow | null;
  book: StationOrderBook | null;
  crumbs: MarketGroupRef[];
}

function cacheKey(parentGroupId: number | null): string {
  return parentGroupId === null ? ROOT_KEY : String(parentGroupId);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatIsk(value: number | null): string {
  if (value === null) return '—';
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatVolume(value: number): string {
  return value === 0 ? '—' : value.toLocaleString();
}

/** 市场浏览页（P9-1-2） */
export default function MarketBrowsePage() {
  const [stationId, setStationId] = useState(DEFAULT_STATION_ID);
  const [scope, setScope] = useState<MarketStationScope | null>(null);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState('');

  // 左树
  const [children, setChildren] = useState<Map<string, MarketGroupNode[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null);

  // 中列
  const [query, setQuery] = useState('');
  const [groupList, setGroupList] = useState<MarketTypeList | null>(null);
  const [searchList, setSearchList] = useState<MarketTypeList | null>(null);
  const [sortBy, setSortBy] = useState<MarketTypeSortKey>('name');
  const [sortDir, setSortDir] = useState<SortDirection>('asc');
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [pageSize, setPageSize] = useState<number>(MARKET_BROWSE_DEFAULT_LIMIT);
  const [onlyWithOrders, setOnlyWithOrders] = useState(false);
  const [listLoading, setListLoading] = useState(false);

  // 右详情
  const [selectedTypeId, setSelectedTypeId] = useState<number | null>(null);
  const [detail, setDetail] = useState<DetailBundle | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // 竞态保护：每次取数递增序号，回来时序号不一致即丢弃（快速切分组/站点不串数据）
  const listSeqRef = useRef(0);
  const detailSeqRef = useRef(0);

  const openReadyAdapter = useCallback(async () => {
    await initDatabase();
    return openAdapter();
  }, []);

  // 挂载：检查环境 → 载入根层分组
  useEffect(() => {
    if (!isTauri()) {
      setMessage('浏览器预览（非 Tauri 环境）：市场浏览需要桌面应用');
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const db = await openReadyAdapter();
        const roots = await listMarketGroupChildren(db, null);
        if (cancelled) return;
        setChildren(new Map([[ROOT_KEY, roots]]));
        setReady(true);
        if (roots.length > 0) setSelectedGroupId(roots[0].marketGroupId);
        else setMessage('未检测到市场分组数据，请先到「数据」页导入 SDE');
      } catch (error) {
        if (!cancelled) setMessage(`市场分组加载失败：${describeError(error)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [openReadyAdapter]);

  // 站点范围（站名 / 星系 / 星域）
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void (async () => {
      try {
        const db = await openAdapter();
        const next = await getMarketStationScope(db, stationId);
        if (!cancelled) setScope(next);
      } catch (error) {
        if (!cancelled) setMessage(`站点信息读取失败：${describeError(error)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, stationId]);

  const searching = query.trim().length > 0;
  const activeList = searching ? searchList : groupList;

  // 中列（分组模式）：搜索词为空时才取数
  useEffect(() => {
    if (!ready || searching || selectedGroupId === null) {
      if (!searching) setGroupList(null);
      return;
    }
    const seq = ++listSeqRef.current;
    setListLoading(true);
    void (async () => {
      try {
        const db = await openAdapter();
        const result = await listMarketTypes(db, {
          marketGroupId: selectedGroupId,
          stationId,
          limit: pageSize,
          offset: (page - 1) * pageSize,
          sortBy,
          sortDir,
          onlyWithOrders,
        });
        if (seq !== listSeqRef.current) return;
        setGroupList(result);
        setMessage('');
      } catch (error) {
        if (seq === listSeqRef.current) setMessage(`列表加载失败：${describeError(error)}`);
      } finally {
        if (seq === listSeqRef.current) setListLoading(false);
      }
    })();
  }, [ready, searching, selectedGroupId, stationId, page, pageSize, sortBy, sortDir, onlyWithOrders]);

  // 中列（搜索模式）：防抖后取数
  useEffect(() => {
    if (!ready) return;
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setSearchList(null);
      return;
    }
    const seq = ++listSeqRef.current;
    setListLoading(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const db = await openAdapter();
          const result = await searchMarketTypes(db, {
            query: trimmed,
            stationId,
            limit: pageSize,
            offset: (page - 1) * pageSize,
            sortBy,
            sortDir,
          });
          if (seq !== listSeqRef.current) return;
          setSearchList(result);
          setMessage('');
        } catch (error) {
          if (seq === listSeqRef.current) setMessage(`搜索失败：${describeError(error)}`);
        } finally {
          if (seq === listSeqRef.current) setListLoading(false);
        }
      })();
    }, 280);
    return () => clearTimeout(timer);
  }, [ready, query, stationId, page, pageSize, sortBy, sortDir]);

  // 右详情
  useEffect(() => {
    if (!ready || selectedTypeId === null) {
      setDetail(null);
      return;
    }
    const seq = ++detailSeqRef.current;
    setDetailLoading(true);
    void (async () => {
      try {
        const db = await openAdapter();
        const [type, row, book] = await Promise.all([
          getTypeDetail(db, selectedTypeId),
          getStationTypeRow(db, stationId, selectedTypeId),
          getStationOrderBook(db, stationId, selectedTypeId, ORDER_BOOK_SIDE),
        ]);
        const crumbs =
          row?.marketGroupId === null || row === null
            ? []
            : await getMarketGroupPath(db, row.marketGroupId);
        if (seq !== detailSeqRef.current) return;
        setDetail({ type, row, book, crumbs });
      } catch (error) {
        if (seq === detailSeqRef.current) setMessage(`详情加载失败：${describeError(error)}`);
      } finally {
        if (seq === detailSeqRef.current) setDetailLoading(false);
      }
    })();
  }, [ready, selectedTypeId, stationId]);

  const totalPages = useMemo(() => {
    if (activeList === null) return 1;
    return Math.max(1, Math.ceil(activeList.total / pageSize));
  }, [activeList, pageSize]);

  // 越界钳制：换站点/改每页后列表变短时回到最后一页，避免停留在空页
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  useEffect(() => {
    setPageInput(String(page));
  }, [page]);

  const loadChildren = useCallback(
    async (parentGroupId: number) => {
      try {
        const db = await openAdapter();
        const nodes = await listMarketGroupChildren(db, parentGroupId);
        setChildren((previous) => {
          const next = new Map(previous);
          next.set(cacheKey(parentGroupId), nodes);
          return next;
        });
      } catch (error) {
        setMessage(`子分组加载失败：${describeError(error)}`);
      }
    },
    [],
  );

  const toggleGroup = useCallback(
    (node: MarketGroupNode) => {
      const willExpand = !expanded.has(node.marketGroupId);
      setExpanded((previous) => {
        const next = new Set(previous);
        if (willExpand) next.add(node.marketGroupId);
        else next.delete(node.marketGroupId);
        return next;
      });
      if (willExpand && node.childCount > 0 && !children.has(cacheKey(node.marketGroupId))) {
        void loadChildren(node.marketGroupId);
      }
    },
    [children, expanded, loadChildren],
  );

  const selectGroup = useCallback((marketGroupId: number) => {
    setSelectedGroupId(marketGroupId);
    setQuery('');
    setPage(1);
    setSelectedTypeId(null);
  }, []);

  /** 搜索命中「定位」：展开左树到该物品所属分组 → 中列回到分组模式 → 选中该物品 */
  const locate = useCallback(
    async (row: MarketTypeRow) => {
      if (row.marketGroupId === null) return;
      try {
        const db = await openAdapter();
        const path = await getMarketGroupPath(db, row.marketGroupId);
        for (const node of path) {
          if (node.parentGroupId !== null && !children.has(cacheKey(node.marketGroupId))) {
            await loadChildren(node.marketGroupId);
          }
        }
        setExpanded((previous) => {
          const next = new Set(previous);
          // 展开路径上每个父节点的父层（即把路径节点本身设为已展开）
          for (const node of path) if (node.parentGroupId !== null) next.add(node.marketGroupId);
          return next;
        });
        setQuery('');
        setPage(1);
        setSelectedGroupId(row.marketGroupId);
        setSelectedTypeId(row.typeId);
      } catch (error) {
        setMessage(`定位失败：${describeError(error)}`);
      }
    },
    [children, loadChildren],
  );

  const changeSort = useCallback(
    (key: MarketTypeSortKey) => {
      if (key === sortBy) setSortDir((previous) => (previous === 'asc' ? 'desc' : 'asc'));
      else {
        setSortBy(key);
        setSortDir('asc');
      }
      setPage(1);
    },
    [sortBy],
  );

  const commitPageInput = useCallback(() => {
    const parsed = Number.parseInt(pageInput.trim(), 10);
    const target = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), totalPages) : 1;
    setPage(target);
    // 同步回写：越界输入被钳制时 page 可能不变（如已在第 1 页却不小心输了 99），
    // 只靠 [page] 的 effect 不会触发，输入框会留下过期数字
    setPageInput(String(target));
  }, [pageInput, totalPages]);

  const renderBranch = (parentGroupId: number | null, depth: number): React.ReactNode => {
    const nodes = children.get(cacheKey(parentGroupId)) ?? [];
    return nodes.map((node) => {
      const isOpen = expanded.has(node.marketGroupId);
      return (
        <div key={node.marketGroupId}>
          <div
            className={`browse-tree-row${selectedGroupId === node.marketGroupId ? ' selected' : ''}`}
            style={{ paddingLeft: 4 + depth * 14 }}
            onClick={() => selectGroup(node.marketGroupId)}
          >
            <span
              className="browse-tree-toggle"
              onClick={(event) => {
                event.stopPropagation();
                toggleGroup(node);
              }}
            >
              {node.childCount > 0 ? (isOpen ? '▾' : '▸') : '·'}
            </span>
            <span className="browse-tree-name">{node.nameZh ?? node.nameEn}</span>
            <span className="browse-tree-count">
              {node.childCount === 0 ? node.typeCount : ''}
            </span>
          </div>
          {isOpen && renderBranch(node.marketGroupId, depth + 1)}
        </div>
      );
    });
  };

  const roots = children.get(ROOT_KEY) ?? [];
  const selectedGroupName = useMemo(() => {
    if (selectedGroupId === null) return null;
    for (const [key, nodes] of children) {
      if (key === ROOT_KEY) continue;
      const hit = nodes.find((node) => node.marketGroupId === selectedGroupId);
      if (hit !== undefined) return hit.nameZh ?? hit.nameEn;
    }
    return (roots.find((node) => node.marketGroupId === selectedGroupId)?.nameZh ??
      roots.find((node) => node.marketGroupId === selectedGroupId)?.nameEn ??
      null);
  }, [children, roots, selectedGroupId]);

  return (
    <section className="browse">
      <div className="panel">
        <div className="panel-head">
          <h2>市场浏览</h2>
          <span className="hint">
            左=市场分组树 · 中=物品列表（已含全部子分组）· 右=详情与订单簿；报价为所选站点在架订单
          </span>
        </div>
        <div className="params">
          <label>
            地点
            <select
              value={stationId}
              onChange={(event) => {
                setStationId(Number(event.target.value));
                setPage(1);
              }}
            >
              {HUB_STATIONS.map((station) => (
                <option key={station.stationId} value={station.stationId}>
                  {station.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            每页
            <select
              value={pageSize}
              onChange={(event) => {
                setPageSize(Number(event.target.value));
                setPage(1);
              }}
            >
              {PAGE_SIZES.filter((size) => size <= MARKET_BROWSE_MAX_LIMIT).map((size) => (
                <option key={size} value={size}>
                  {size} 条
                </option>
              ))}
            </select>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={onlyWithOrders}
              onChange={(event) => {
                setOnlyWithOrders(event.target.checked);
                setPage(1);
              }}
            />
            仅显示有报价
          </label>
          <span className="hint">
            {scope === null
              ? '站点：读取中…'
              : `站点：${scope.nameZh ?? scope.nameEn} · ${scope.regionNameZh ?? scope.regionNameEn}`}
          </span>
        </div>

        <input
          className="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(1);
          }}
          placeholder="搜索物品（中/英文名，如 Tritanium / 三钛合金）；清空回到分组浏览"
        />
      </div>

      <div className="browse-body">
        <div className="browse-layout">
          <div className="panel browse-tree-panel">
            <h2>市场分组</h2>
            {ready && roots.length === 0 ? (
              <p className="hint">未检测到市场分组数据，请先到「数据」页导入 SDE。</p>
            ) : (
              <div className="browse-tree">{renderBranch(null, 0)}</div>
            )}
          </div>

          <div className="panel">
            <div className="panel-head">
              <h2>{searching ? `搜索「${query.trim()}」` : (selectedGroupName ?? '物品列表')}</h2>
              <span className="hint">
                {listLoading
                  ? '加载中…'
                  : activeList === null
                    ? '—'
                    : `${activeList.total.toLocaleString()} 条`}
              </span>
            </div>

            <div className="browse-table">
              <table className="result">
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>分组</th>
                    {SORT_COLUMNS.filter((column) => column.key !== 'name').map((column) => (
                      <th
                        key={column.key}
                        className={`sortable${sortBy === column.key ? ' active' : ''}`}
                        onClick={() => changeSort(column.key)}
                      >
                        {column.label}
                        {sortBy === column.key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(activeList?.rows ?? []).map((row) => (
                    <tr
                      key={row.typeId}
                      className={selectedTypeId === row.typeId ? 'selected' : ''}
                      onClick={() => setSelectedTypeId(row.typeId)}
                    >
                      <td title={`${row.nameEn}${row.nameZh === null ? '' : ` / ${row.nameZh}`}`}>
                        {row.nameZh ?? row.nameEn}
                      </td>
                      <td className="dim">
                        {searching ? (
                          <button
                            type="button"
                            className="link"
                            onClick={(event) => {
                              event.stopPropagation();
                              void locate(row);
                            }}
                          >
                            {row.marketGroupNameZh ?? row.marketGroupNameEn ?? '—'}
                          </button>
                        ) : (
                          (row.marketGroupNameZh ?? row.marketGroupNameEn ?? '—')
                        )}
                      </td>
                      <td className="sell">{formatIsk(row.bestSell)}</td>
                      <td className="buy">{formatIsk(row.bestBuy)}</td>
                      <td>{formatVolume(row.sellVolume)}</td>
                      <td>{formatVolume(row.buyVolume)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {activeList !== null && activeList.total === 0 && !listLoading && (
              <p className="hint">
                {searching
                  ? '没有匹配的市场物品。'
                  : onlyWithOrders
                    ? '该分组在此站点没有在架报价（可取消「仅显示有报价」）。'
                    : '该分组下没有市场物品。'}
              </p>
            )}

            <div className="browse-pager">
              <button
                type="button"
                disabled={page <= 1 || listLoading}
                onClick={() => setPage(1)}
              >
                首页
              </button>
              <button
                type="button"
                disabled={page <= 1 || listLoading}
                onClick={() => setPage((previous) => Math.max(1, previous - 1))}
              >
                上一页
              </button>
              <span>
                第
                <input
                  value={pageInput}
                  onChange={(event) => setPageInput(event.target.value)}
                  onBlur={commitPageInput}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commitPageInput();
                  }}
                />
                / {totalPages} 页
              </span>
              <button
                type="button"
                disabled={page >= totalPages || listLoading}
                onClick={() => setPage((previous) => Math.min(totalPages, previous + 1))}
              >
                下一页
              </button>
              <button
                type="button"
                disabled={page >= totalPages || listLoading}
                onClick={() => setPage(totalPages)}
              >
                末页
              </button>
            </div>
          </div>

          <div className="panel browse-detail">
            <h2>详情</h2>
            {selectedTypeId === null ? (
              <p className="hint">点左侧分组浏览，或点中列任意一行查看详情。</p>
            ) : detail === null ? (
              <p className="hint">{detailLoading ? '加载中…' : '无数据'}</p>
            ) : (
              <>
                <div className="browse-crumbs">
                  {detail.crumbs.map((node) => (
                    <button
                      key={node.marketGroupId}
                      type="button"
                      onClick={() => selectGroup(node.marketGroupId)}
                    >
                      {node.nameZh ?? node.nameEn}
                    </button>
                  ))}
                </div>

                <div className="panel-head">
                  <h3 className="browse-title">
                    {detail.row?.nameZh ?? detail.type?.nameZh ?? detail.row?.nameEn ?? detail.type?.nameEn ?? '—'}
                  </h3>
                  <span className="hint">typeID {selectedTypeId}</span>
                </div>

                <ul className="counts">
                  <li>
                    英文名 <code>{detail.type?.nameEn ?? '—'}</code>
                  </li>
                  <li>
                    体积 <code>{detail.type?.volume ?? '—'}</code>
                  </li>
                  <li>
                    打包体积 <code>{detail.type?.packagedVolume ?? '—'}</code>
                  </li>
                  <li>
                    单次产量 <code>{detail.type?.portionSize ?? '—'}</code>
                  </li>
                  <li>
                    类别 <code>{detail.type?.categoryNameZh ?? detail.type?.categoryNameEn ?? '—'}</code>
                  </li>
                  <li>
                    基础价 <code>{formatIsk(detail.type?.basePrice ?? null)}</code>
                  </li>
                </ul>

                <table className="result">
                  <thead>
                    <tr>
                      <th>站点点位</th>
                      <th>价格</th>
                      <th>量 / 条数</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>最低卖价</td>
                      <td className="sell">{formatIsk(detail.row?.bestSell ?? null)}</td>
                      <td>
                        {formatVolume(detail.row?.sellVolume ?? 0)} /{' '}
                        {(detail.row?.sellOrders ?? 0).toLocaleString()}
                      </td>
                    </tr>
                    <tr>
                      <td>最高买价</td>
                      <td className="buy">{formatIsk(detail.row?.bestBuy ?? null)}</td>
                      <td>
                        {formatVolume(detail.row?.buyVolume ?? 0)} /{' '}
                        {(detail.row?.buyOrders ?? 0).toLocaleString()}
                      </td>
                    </tr>
                  </tbody>
                </table>

                <h3 className="browse-subtitle">卖单 · 前 {ORDER_BOOK_SIDE} 档（{detail.book?.sellOrderCount ?? 0} 条）</h3>
                <table className="result">
                  <thead>
                    <tr>
                      <th>价格</th>
                      <th>剩余量</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(detail.book?.sells ?? []).map((entry) => (
                      <tr key={entry.orderId}>
                        <td className="sell">{formatIsk(entry.price)}</td>
                        <td>{entry.volumeRemain.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <h3 className="browse-subtitle">买单 · 前 {ORDER_BOOK_SIDE} 档（{detail.book?.buyOrderCount ?? 0} 条）</h3>
                <table className="result">
                  <thead>
                    <tr>
                      <th>价格</th>
                      <th>剩余量</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(detail.book?.buys ?? []).map((entry) => (
                      <tr key={entry.orderId}>
                        <td className="buy">{formatIsk(entry.price)}</td>
                        <td>{entry.volumeRemain.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {detail.type?.descriptionZh !== null && detail.type?.descriptionZh !== undefined && (
                  <p className="description">{detail.type.descriptionZh}</p>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {message.length > 0 && <p className="message">{message}</p>}
    </section>
  );
}
