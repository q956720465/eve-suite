import { CORE_VERSION } from '@eve-suite/core';
import { initDatabase } from '@eve-suite/core/db/tauri';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useEffect, useRef, useState } from 'react';

import CalcPage from './calc/CalcPage';
import { useLpStoreSync } from './lp/useLpStoreSync';
import MarketPage from './market/MarketPage';
import { useGlobalScanner } from './market/useGlobalScanner';
import { useMarketCollector } from './market/useMarketCollector';
import WatchlistPage from './market/WatchlistPage';
import NotifyPage from './notify/NotifyPage';
import { useNotifyEngine } from './notify/useNotifyEngine';
import AssetsPage from './personal/AssetsPage';
import { useCharacters } from './personal/useCharacters';
import { usePersonalSync } from './personal/usePersonalSync';
import SdePage from './sde/SdePage';
import SpreadPage from './market/SpreadPage';
import { useHistoryInit } from './market/useHistoryInit';

type Tab = 'sde' | 'market' | 'spread' | 'watchlist' | 'assets' | 'calc' | 'notify';

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'sde', label: '数据' },
  { id: 'market', label: '行情' },
  { id: 'spread', label: '价差' },
  { id: 'watchlist', label: '监视' },
  { id: 'assets', label: '资产' },
  { id: 'calc', label: '计算' },
  { id: 'notify', label: '提醒' },
];

/** 应用壳：环境状态 + 页签导航 + 各功能页（P2 起行情采集在应用级运行） */
export default function App() {
  const [runtime, setRuntime] = useState('检测中…');
  const [database, setDatabase] = useState('检测中…');
  const [tab, setTab] = useState<Tab>('sde');

  // 行情采集在应用级持有：切页签不中断，也不重复初始化
  const collector = useMarketCollector();

  // 全域层（跨区快照）同样在应用级持有：档位到期即补跑（catch-up），
  // 请求与枢纽层共用同一个调度器 —— 全域请求以更低优先级入队，为枢纽轮次让路
  const globalScanner = useGlobalScanner({ isPaused: () => collector.paused });

  // 个人数据（授权 + 同步调度）同样在应用级持有：调度不依赖当前页签，
  // 「启动即同步」在应用启动后立即生效，而不是等到访问「资产」页
  const characters = useCharacters();
  const personalSync = usePersonalSync();

  // 历史数据全量初始化（P5-2.8，仅手动）：独占编排需要采集器与个人同步的暂停能力
  const historyInit = useHistoryInit({
    pauseCollection: collector.pause,
    resumeCollection: collector.resume,
    isCollectionPaused: collector.isPaused,
    isCollectionBusy: collector.isBusy,
    pausePersonalSync: personalSync.pause,
    resumePersonalSync: personalSync.resume,
    isPersonalPaused: personalSync.isPaused,
  });

  const wasPausedRef = useRef(false);
  useEffect(() => {
    const wasPaused = wasPausedRef.current;
    wasPausedRef.current = collector.paused;
    // 暂停期间跳过的全域扫描，在「恢复采集」时立刻补上
    if (wasPaused && !collector.paused) {
      void globalScanner.kick();
    }
  }, [collector.paused, globalScanner.kick]);

  // LP 报价同步同样在应用级持有：只抓「角色有 LP 余额的军团」，24h 内不回源
  const lpStore = useLpStoreSync(characters);
  const lastCharacterIdsRef = useRef<string | null>(null);

  // 提醒引擎（P5-7）同样在应用级持有：每 60 秒评估规则，命中即推送（托盘 + 可选 Webhook）
  const notifyEngine = useNotifyEngine();

  useEffect(() => {
    if (!characters.ready || characters.characters.length === 0) return;
    void personalSync.start();
  }, [characters.ready, characters.characters.length, personalSync.start]);

  // 角色集合变化（新授权、登出后重新授权）→ 立即补跑一轮，不等下个周期。
  // 首次就绪只记录：应用启动那一轮由 start() 的「启动即同步」负责。
  const characterIdsKey = characters.characters
    .map((item) => item.characterId)
    .sort((left, right) => left - right)
    .join(',');
  useEffect(() => {
    if (!characters.ready) return;
    const previous = lastCharacterIdsRef.current;
    lastCharacterIdsRef.current = characterIdsKey;
    if (previous === null || characterIdsKey.length === 0 || previous === characterIdsKey) return;
    void personalSync.kick();
  }, [characters.ready, characterIdsKey, personalSync.kick]);

  // 自动轮次完成后刷新角色卡：corporation_id / last_sync_at 随轮更新；
  // 同时补一次 LP 报价同步（LP 余额刚随个人数据落库，此时才知道该抓哪些军团）
  useEffect(() => {
    if (personalSync.lastRound === null) return;
    void characters.refresh().catch(() => undefined);
    void lpStore.kick();
  }, [personalSync.lastRound, characters.refresh, lpStore.kick]);

  useEffect(() => {
    invoke<string>('app_version')
      .then((version) => setRuntime(`Tauri 窗口 · 壳版本 ${version}`))
      .catch(() => setRuntime('浏览器预览（非 Tauri 环境）'));

    initDatabase()
      .then(({ applied, schemaVersion, journalMode }) =>
        setDatabase(
          `就绪 · schema v${schemaVersion} · 本次应用 ${applied} 个迁移 · 日志模式 ${journalMode}`,
        ),
      )
      .catch((error: unknown) => {
        if (!isTauri()) {
          setDatabase('浏览器预览（非 Tauri 环境）');
          return;
        }
        setDatabase(`初始化失败：${error instanceof Error ? error.message : String(error)}`);
      });
  }, []);

  return (
    <main className="app">
      <header className="app-header">
        <div className="title-row">
          <h1>EVE SUITE</h1>
          <nav className="nav">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={tab === item.id ? 'active' : ''}
                onClick={() => setTab(item.id)}
              >
                {item.label}
              </button>
            ))}
          </nav>
        </div>
        <p className="subtitle">P5 全域行情 · 跨区价差 · 历史全量 · 库存缺口 · 资产与净值 · 计算器 · 提醒</p>
        <p className="meta">
          core 版本：<code>{CORE_VERSION}</code>
        </p>
        <p className="meta">
          运行环境：<code>{runtime}</code>
        </p>
        <p className="meta">
          数据库：<code>{database}</code>
        </p>
      </header>

      {tab === 'sde' && <SdePage />}
      {tab === 'market' && <MarketPage collector={collector} scanner={globalScanner} />}
      {tab === 'spread' && <SpreadPage init={historyInit} />}
      {tab === 'watchlist' && <WatchlistPage />}
      {tab === 'assets' && <AssetsPage characters={characters} sync={personalSync} />}
      {tab === 'calc' && <CalcPage lpStore={lpStore} />}
      {tab === 'notify' && <NotifyPage engine={notifyEngine} />}
    </main>
  );
}
