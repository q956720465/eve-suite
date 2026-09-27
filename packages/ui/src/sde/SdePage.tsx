import {
  DEFAULT_SEARCH_LIMIT,
  getSdeStatus,
  getTypeDetail,
  importSde,
  searchStations,
  searchTypes,
  type SdeStatus,
  type StationSearchHit,
  type TypeDetail,
  type TypeSearchHit,
} from '@eve-suite/core';
import { openAdapter, initDatabase } from '@eve-suite/core/db/tauri';
import { createTauriSdeSource, ensureSdeCache } from '@eve-suite/core/sde/tauri';
import { isTauri } from '@tauri-apps/api/core';
import { useCallback, useEffect, useState } from 'react';

type SearchMode = 'types' | 'stations';

const COUNT_LABELS: Record<string, string> = {
  categories: '类别',
  groups: '分组',
  types: '物品',
  regions: '星域',
  constellations: '星座',
  systems: '星系',
  stations: '空间站',
  blueprints: '蓝图',
  blueprint_activities: '蓝图活动',
  blueprint_io: '配方材料',
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(value: number): string {
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

/** 数据页：SDE 状态与同步 + 物品/空间站搜索（P1） */
export default function SdePage() {
  const [status, setStatus] = useState<SdeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const [mode, setMode] = useState<SearchMode>('types');
  const [query, setQuery] = useState('');
  const [typeHits, setTypeHits] = useState<TypeSearchHit[]>([]);
  const [stationHits, setStationHits] = useState<StationSearchHit[]>([]);
  const [detail, setDetail] = useState<TypeDetail | null>(null);

  /** 取数据库适配器；必须先等迁移完成，否则表可能尚未建立 */
  const openReadyAdapter = useCallback(async () => {
    await initDatabase();
    return openAdapter();
  }, []);

  const refreshStatus = useCallback(async () => {
    const db = await openReadyAdapter();
    setStatus(await getSdeStatus(db));
  }, [openReadyAdapter]);

  useEffect(() => {
    if (!isTauri()) return;
    refreshStatus().catch((error: unknown) => setMessage(`状态读取失败：${describeError(error)}`));
  }, [refreshStatus]);

  const handleSync = useCallback(async () => {
    setBusy(true);
    setMessage('正在检查 SDE 版本…');
    try {
      const cache = await ensureSdeCache((progress) => {
        setMessage(
          progress.total === null
            ? `下载中：${formatBytes(progress.received)}`
            : `下载中：${formatBytes(progress.received)} / ${formatBytes(progress.total)}（${Math.round(
                (progress.received / progress.total) * 100,
              )}%）`,
        );
      });

      const db = await openReadyAdapter();
      const summary = await importSde(db, createTauriSdeSource(cache.cacheDir), {
        onProgress: (progress) => {
          setMessage(`导入 ${progress.file}：已处理 ${progress.rows} 行，写入 ${progress.written} 行`);
        },
      });

      setMessage(
        summary.skipped
          ? `本地已是 SDE ${summary.version.buildNumber}，无需重新导入`
          : `导入完成：SDE ${summary.version.buildNumber}，耗时 ${(summary.elapsedMs / 1000).toFixed(1)} 秒`,
      );
      await refreshStatus();
    } catch (error) {
      setMessage(`同步失败：${describeError(error)}`);
    } finally {
      setBusy(false);
    }
  }, [openReadyAdapter, refreshStatus]);

  useEffect(() => {
    if (!isTauri()) return;
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setTypeHits([]);
      setStationHits([]);
      return;
    }

    const timer = setTimeout(() => {
      void (async () => {
        try {
          const db = await openReadyAdapter();
          if (mode === 'types') {
            setTypeHits(await searchTypes(db, trimmed, DEFAULT_SEARCH_LIMIT));
          } else {
            setStationHits(await searchStations(db, trimmed, DEFAULT_SEARCH_LIMIT));
          }
        } catch (error) {
          setMessage(`搜索失败：${describeError(error)}`);
        }
      })();
    }, 300);

    return () => clearTimeout(timer);
  }, [query, mode, status?.buildNumber, openReadyAdapter]);

  const handleSelectType = useCallback(
    async (typeId: number) => {
      try {
        const db = await openReadyAdapter();
        setDetail(await getTypeDetail(db, typeId));
      } catch (error) {
        setMessage(`详情读取失败：${describeError(error)}`);
      }
    },
    [openReadyAdapter],
  );

  if (!isTauri()) {
    return (
      <section className="panel">
        <h2>数据基座</h2>
        <p className="hint">SDE 数据同步与搜索需在桌面应用（Tauri）中运行。</p>
      </section>
    );
  }

  return (
    <section className="sde">
      <div className="panel">
        <div className="panel-head">
          <h2>SDE 数据</h2>
          <button type="button" onClick={handleSync} disabled={busy}>
            {busy ? '同步中…' : status?.ready ? '检查更新' : '下载并导入'}
          </button>
        </div>

        {status === null ? (
          <p className="hint">读取中…</p>
        ) : (
          <>
            <p className="meta">
              状态：
              <code>
                {status.ready
                  ? `就绪 · SDE ${status.buildNumber} · ${status.typeCount} 个物品`
                  : '未导入'}
              </code>
            </p>
            {status.releaseDate !== null && (
              <p className="meta">
                数据版本：<code>{status.releaseDate}</code>
              </p>
            )}
            {status.importedAt !== null && (
              <p className="meta">
                导入时间：<code>{new Date(status.importedAt).toLocaleString()}</code>
              </p>
            )}
            {Object.keys(status.counts).length > 0 && (
              <ul className="counts">
                {Object.entries(status.counts).map(([table, rows]) => (
                  <li key={table}>
                    <span>{COUNT_LABELS[table] ?? table}</span>
                    <code>{rows.toLocaleString()}</code>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {message.length > 0 && <p className="message">{message}</p>}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>搜索</h2>
          <div className="tabs">
            <button
              type="button"
              className={mode === 'types' ? 'active' : ''}
              onClick={() => setMode('types')}
            >
              物品
            </button>
            <button
              type="button"
              className={mode === 'stations' ? 'active' : ''}
              onClick={() => setMode('stations')}
            >
              空间站
            </button>
          </div>
        </div>

        <input
          className="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={
            mode === 'types' ? '输入物品名（如 Tritanium / 三钛合金）' : '输入站名或星系（如 Jita / 吉他）'
          }
          disabled={status?.ready !== true}
        />

        {status?.ready !== true && <p className="hint">请先下载并导入 SDE 数据。</p>}

        {mode === 'types' && typeHits.length > 0 && (
          <table className="result">
            <thead>
              <tr>
                <th>typeID</th>
                <th>名称</th>
                <th>中文名</th>
                <th>分组</th>
                <th>体积</th>
              </tr>
            </thead>
            <tbody>
              {typeHits.map((hit) => (
                <tr key={hit.typeId} onClick={() => handleSelectType(hit.typeId)}>
                  <td>{hit.typeId}</td>
                  <td>{hit.nameEn}</td>
                  <td>{hit.nameZh ?? '—'}</td>
                  <td>{hit.groupNameZh ?? hit.groupNameEn ?? '—'}</td>
                  <td>{hit.volume ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {mode === 'stations' && stationHits.length > 0 && (
          <table className="result">
            <thead>
              <tr>
                <th>stationID</th>
                <th>空间站</th>
                <th>星系</th>
                <th>星域</th>
              </tr>
            </thead>
            <tbody>
              {stationHits.map((hit) => (
                <tr key={hit.stationId}>
                  <td>{hit.stationId}</td>
                  <td>{hit.nameEn}</td>
                  <td>{hit.systemNameZh ?? hit.systemNameEn}</td>
                  <td>{hit.regionNameZh ?? hit.regionNameEn}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {query.trim().length > 0 &&
          ((mode === 'types' && typeHits.length === 0) ||
            (mode === 'stations' && stationHits.length === 0)) && (
            <p className="hint">无匹配结果。</p>
          )}
      </div>

      {detail !== null && (
        <div className="panel">
          <div className="panel-head">
            <h2>物品详情</h2>
            <button type="button" onClick={() => setDetail(null)}>
              关闭
            </button>
          </div>
          <p className="meta">
            <code>
              {detail.nameEn}
              {detail.nameZh !== null ? ` · ${detail.nameZh}` : ''} · typeID {detail.typeId}
            </code>
          </p>
          <ul className="counts">
            <li>
              <span>分组</span>
              <code>{detail.groupNameZh ?? detail.groupNameEn ?? '—'}</code>
            </li>
            <li>
              <span>类别</span>
              <code>{detail.categoryNameZh ?? detail.categoryNameEn ?? '—'}</code>
            </li>
            <li>
              <span>体积 / 包装体积</span>
              <code>
                {detail.volume ?? '—'} / {detail.packagedVolume ?? '—'}
              </code>
            </li>
            <li>
              <span>质量 / 单次产出</span>
              <code>
                {detail.mass ?? '—'} / {detail.portionSize ?? '—'}
              </code>
            </li>
            <li>
              <span>基础价格</span>
              <code>{detail.basePrice ?? '—'}</code>
            </li>
            <li>
              <span>发布状态</span>
              <code>{detail.published === 1 ? '已发布' : '未发布'}</code>
            </li>
          </ul>
          <p className="description">{detail.descriptionZh ?? detail.descriptionEn ?? '（无描述）'}</p>
        </div>
      )}
    </section>
  );
}
