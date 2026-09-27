import {
  computeNetWorth,
  getAssetDetails,
  getAssetOverview,
  getCharacterScopeStates,
  getStationNames,
  getTypeNames,
  listSnapshots,
  writeDailySnapshot,
  type AssetDetailRow,
  type AssetOverviewRow,
  type NetWorthBreakdown,
  type NetWorthSnapshot,
  type PersonalScope,
  type ScopeStateSummary,
  type StationNameEntry,
  type TypeNameEntry,
} from '@eve-suite/core';
import { useCallback, useEffect, useState } from 'react';

import { initCoreRuntime } from '../core/runtime';
import type { CharactersHandle } from './useCharacters';
import type { PersonalSyncHandle } from './usePersonalSync';

/** 角色与同步句柄由应用壳（App）在应用级持有后传入：调度不随页签挂载 / 卸载 */
export interface AssetsPageProps {
  characters: CharactersHandle;
  sync: PersonalSyncHandle;
}

/** 端点中文名（与 PERSONAL_SCOPES 一一对应） */
const SCOPE_LABELS: Record<PersonalScope, string> = {
  assets: '资产',
  wallet_balance: '钱包余额',
  wallet_journal: '钱包账本',
  orders: '我的挂单',
  contracts: '合同',
  industry: '工业任务',
  mining: '采矿记录',
  loyalty: '忠诚点',
};

/** 资产页：角色授权 + 同步状态 + 净值 + 资产明细 + 每日快照 */
export default function AssetsPage({ characters, sync }: AssetsPageProps) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [scopeStates, setScopeStates] = useState<ScopeStateSummary[]>([]);
  const [overview, setOverview] = useState<AssetOverviewRow[]>([]);
  const [typeNames, setTypeNames] = useState<Map<number, TypeNameEntry>>(new Map());
  const [networth, setNetworth] = useState<NetWorthBreakdown | null>(null);
  const [snapshots, setSnapshots] = useState<NetWorthSnapshot[]>([]);
  const [expandedTypeId, setExpandedTypeId] = useState<number | null>(null);
  const [details, setDetails] = useState<AssetDetailRow[]>([]);
  const [stationNames, setStationNames] = useState<Map<number, StationNameEntry>>(new Map());
  const [panelMessage, setPanelMessage] = useState('');

  const loadCharacter = useCallback(async (characterId: number) => {
    const runtime = await initCoreRuntime();
    const { db } = runtime;
    const [states, rows, worth, snaps] = await Promise.all([
      getCharacterScopeStates(db, characterId),
      getAssetOverview(db, characterId),
      computeNetWorth(db, characterId),
      listSnapshots(db, characterId),
    ]);
    setScopeStates(states);
    setOverview(rows);
    setTypeNames(await getTypeNames(db, rows.map((row) => row.typeId)));
    setNetworth(worth);
    setSnapshots(snaps);
    setExpandedTypeId(null);
    setDetails([]);
  }, []);

  // 角色清单就绪后默认选中第一个；选中项消失（如被登出）时回落到第一个
  useEffect(() => {
    if (!characters.ready) return;
    const ids = characters.characters.map((item) => item.characterId);
    if (ids.length === 0) {
      setSelectedId(null);
      return;
    }
    setSelectedId((previous) => (previous !== null && ids.includes(previous) ? previous : ids[0]));
  }, [characters.ready, characters.characters]);

  // 「有角色即启动调度」与「自动轮次后刷新角色卡」已上移到应用壳 App，不随本页挂载

  useEffect(() => {
    if (selectedId === null) return;
    void loadCharacter(selectedId).catch((error: unknown) =>
      setPanelMessage(`读取角色数据失败：${error instanceof Error ? error.message : String(error)}`),
    );
  }, [selectedId, loadCharacter, sync.lastRound]);

  const toggleExpand = useCallback(
    async (typeId: number) => {
      if (selectedId === null) return;
      if (expandedTypeId === typeId) {
        setExpandedTypeId(null);
        setDetails([]);
        return;
      }
      try {
        const runtime = await initCoreRuntime();
        const rows = await getAssetDetails(runtime.db, selectedId, typeId);
        setStationNames(await getStationNames(runtime.db, rows.map((row) => row.locationId)));
        setDetails(rows);
        setExpandedTypeId(typeId);
      } catch (error) {
        setPanelMessage(`读取资产明细失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [expandedTypeId, selectedId],
  );

  const handleSyncNow = useCallback(async () => {
    await sync.syncNow();
    // 手动同步不走调度器轮次（不产生 sync.lastRound），需在此补齐角色卡刷新，
    // 否则军团 ID / 钱包余额 / 最近同步 会停留在授权那一刻的陈旧值
    await characters.refresh();
    if (selectedId !== null) await loadCharacter(selectedId);
  }, [sync, characters.refresh, selectedId, loadCharacter]);

  const handleSnapshot = useCallback(async () => {
    if (selectedId === null) return;
    try {
      const runtime = await initCoreRuntime();
      await writeDailySnapshot(runtime.db, selectedId);
      setSnapshots(await listSnapshots(runtime.db, selectedId));
      setPanelMessage('已写入今日净值快照');
    } catch (error) {
      setPanelMessage(`写入快照失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [selectedId]);

  const handleLogout = useCallback(
    async (characterId: number, name: string) => {
      const confirmed = window.confirm(
        `登出「${name}」将删除本地保存的刷新令牌与该角色的全部个人数据（资产 / 钱包 / 合同等），是否继续？`,
      );
      if (!confirmed) return;
      sync.clearReauth(characterId);
      await characters.logout(characterId);
      setPanelMessage('已登出并清除本地数据');
    },
    [characters, sync],
  );

  const selected = characters.characters.find((item) => item.characterId === selectedId) ?? null;
  const message = [characters.message, sync.message, panelMessage].filter((text) => text.length > 0).join(' · ');

  return (
    <section className="assets">
      <div className="panel">
        <div className="panel-head">
          <h2>已授权角色</h2>
          <div className="tabs">
            <button type="button" onClick={() => void characters.authorize()} disabled={characters.busy}>
              {characters.busy ? '授权中…' : '授权新角色'}
            </button>
            <button type="button" onClick={() => void handleSyncNow()} disabled={sync.busy || selected === null}>
              {sync.busy ? '同步中…' : '立即同步'}
            </button>
            <button type="button" onClick={sync.togglePause} disabled={!sync.running}>
              {sync.paused ? '恢复自动同步' : '暂停自动同步'}
            </button>
          </div>
        </div>

        {characters.characters.length === 0 ? (
          <p className="hint">
            尚无已授权角色。点「授权新角色」后会在系统浏览器打开 EVE 官方登录页，授权完成后本地即可看到资产与净值。
            个人数据每 20 分钟自动同步一轮，且会遵守各端点的缓存有效期。
          </p>
        ) : (
          <>
            <div className="tabs">
              {characters.characters.map((item) => (
                <button
                  key={item.characterId}
                  type="button"
                  className={item.characterId === selectedId ? 'active' : ''}
                  onClick={() => setSelectedId(item.characterId)}
                >
                  {item.name}
                </button>
              ))}
            </div>

            {selected !== null && (
              <table className="result">
                <tbody>
                  <tr>
                    <th>角色 ID</th>
                    <td>{selected.characterId}</td>
                    <th>军团 ID</th>
                    <td>{selected.corporationId ?? '未知（同步后补齐）'}</td>
                  </tr>
                  <tr>
                    <th>钱包余额</th>
                    <td className="sell">{formatIsk(selected.walletBalance)}</td>
                    <th>最近同步</th>
                    <td>{formatTime(selected.lastSyncAt)}</td>
                  </tr>
                </tbody>
              </table>
            )}

            {selected !== null && (
              <div className="tabs">
                {sync.reauthCharacters.includes(selected.characterId) && (
                  <span className="hint">该角色刷新令牌已失效，需重新授权后才能继续同步</span>
                )}
                <button
                  type="button"
                  onClick={() => void handleLogout(selected.characterId, selected.name)}
                  disabled={characters.busy}
                >
                  登出并清除本地数据
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {selected !== null && (
        <>
          <div className="panel">
            <div className="panel-head">
              <h2>净值（估值口径：吉他 5% 分位）</h2>
              <div className="tabs">
                <button type="button" onClick={() => void handleSnapshot()}>
                  生成今日快照
                </button>
              </div>
            </div>

            {networth === null ? (
              <p className="hint">暂无数据</p>
            ) : (
              <>
                <table className="result">
                  <thead>
                    <tr>
                      <th>合计净值</th>
                      <th>资产估值</th>
                      <th>钱包余额</th>
                      <th>未成交卖单</th>
                      <th>合同</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>{formatIsk(networth.totalValue)}</td>
                      <td>{formatIsk(networth.assetsValue)}</td>
                      <td>{formatIsk(networth.walletBalance)}</td>
                      <td>{formatIsk(networth.sellOrdersValue)}</td>
                      <td>{formatIsk(networth.contractsValue)}</td>
                    </tr>
                  </tbody>
                </table>
                {networth.missingPriceTypes > 0 && (
                  <p className="hint">
                    共 {networth.distinctTypeCount} 种物品，其中 {networth.missingPriceTypes} 种在吉他无报价
                    （已按 0 计，净值偏低）——请先在「行情」页采集枢纽数据。
                  </p>
                )}
              </>
            )}
          </div>

          <div className="panel">
            <div className="panel-head">
              <h2>同步状态</h2>
              {sync.running && <span className="hint">{sync.paused ? '已暂停' : '自动同步中'}</span>}
            </div>
            {scopeStates.length === 0 ? (
              <p className="hint">尚未同步过该角色的数据，点上方「立即同步」。</p>
            ) : (
              <table className="result">
                <thead>
                  <tr>
                    <th>端点</th>
                    <th>最近成功</th>
                    <th>缓存到期</th>
                    <th>页数</th>
                    <th>最近错误</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.keys(SCOPE_LABELS).map((scope) => {
                    const state = scopeStates.find((item) => item.scope === scope);
                    return (
                      <tr key={scope}>
                        <td>{SCOPE_LABELS[scope as PersonalScope]}</td>
                        <td>{formatTime(state?.lastOkAt ?? null)}</td>
                        <td>{state?.expiresAt == null ? '—' : formatTime(state.expiresAt)}</td>
                        <td>{state?.pages ?? 0}</td>
                        <td>{state?.lastError ?? '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          <div className="panel">
            <div className="panel-head">
              <h2>资产（按物品种类聚合）</h2>
              <span className="hint">点行展开到具体地点</span>
            </div>
            {overview.length === 0 ? (
              <p className="hint">暂无资产数据。</p>
            ) : (
              <table className="result">
                <thead>
                  <tr>
                    <th>物品</th>
                    <th>数量</th>
                    <th>单价（吉他 5% 分位）</th>
                    <th>估值</th>
                    <th>地点数</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.map((row) => {
                    const name = typeNames.get(row.typeId);
                    const expanded = expandedTypeId === row.typeId;
                    return [
                      <tr key={row.typeId} onClick={() => void toggleExpand(row.typeId)}>
                        <td>
                          {expanded ? '▾ ' : '▸ '}
                          {name === undefined
                            ? `typeID ${row.typeId}`
                            : name.nameZh ?? name.nameEn}
                        </td>
                        <td>{row.quantity.toLocaleString()}</td>
                        <td>{row.unitPrice === null ? '无报价' : formatIsk(row.unitPrice)}</td>
                        <td className="sell">{formatIsk(row.estimatedValue)}</td>
                        <td>{row.locationCount}</td>
                      </tr>,
                      expanded ? (
                        <tr key={`${row.typeId}-detail`}>
                          <td colSpan={5}>
                            <table className="result">
                              <thead>
                                <tr>
                                  <th>物品 ID</th>
                                  <th>地点</th>
                                  <th>位置</th>
                                  <th>数量</th>
                                  <th>估值</th>
                                </tr>
                              </thead>
                              <tbody>
                                {details.map((detail) => (
                                  <tr key={detail.itemId}>
                                    <td>{detail.itemId}</td>
                                    <td>{describeLocation(detail.locationId, stationNames)}</td>
                                    <td>{detail.locationFlag}</td>
                                    <td>{detail.quantity.toLocaleString()}</td>
                                    <td>{formatIsk(detail.estimatedValue)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      ) : null,
                    ];
                  })}
                </tbody>
              </table>
            )}
          </div>

          <div className="panel">
            <h2>净值快照（每日一条）</h2>
            {snapshots.length === 0 ? (
              <p className="hint">尚无快照。每次同步有数据更新时会自动写入当日快照。</p>
            ) : (
              <table className="result">
                <thead>
                  <tr>
                    <th>日期</th>
                    <th>净值</th>
                    <th>资产</th>
                    <th>钱包</th>
                    <th>卖单</th>
                    <th>写入时间</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshots.map((snapshot) => (
                    <tr key={snapshot.snapshotDate}>
                      <td>{snapshot.snapshotDate}</td>
                      <td className="sell">{formatIsk(snapshot.totalValue)}</td>
                      <td>{formatIsk(snapshot.assetsValue)}</td>
                      <td>{formatIsk(snapshot.walletBalance)}</td>
                      <td>{formatIsk(snapshot.sellOrdersValue)}</td>
                      <td>{formatTime(snapshot.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {message.length > 0 && <p className="message">{message}</p>}
    </section>
  );
}

function describeLocation(locationId: number, stations: Map<number, StationNameEntry>): string {
  const station = stations.get(locationId);
  if (station === undefined) return `地点 ${locationId}`;
  const stationName = station.nameZh ?? station.nameEn;
  const systemName = station.systemNameZh ?? station.systemNameEn;
  return `${stationName}（${systemName}）`;
}

function formatIsk(value: number | null): string {
  if (value === null) return '—';
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatTime(value: string | null): string {
  if (value === null || value.length === 0) return '—';
  return new Date(value).toLocaleString();
}
