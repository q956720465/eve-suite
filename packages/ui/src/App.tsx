import { CORE_VERSION } from '@eve-suite/core';
import { initDatabase } from '@eve-suite/core/db/tauri';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';

import MarketPage from './market/MarketPage';
import { useMarketCollector } from './market/useMarketCollector';
import WatchlistPage from './market/WatchlistPage';
import SdePage from './sde/SdePage';

type Tab = 'sde' | 'market' | 'watchlist';

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'sde', label: '数据' },
  { id: 'market', label: '行情' },
  { id: 'watchlist', label: '监视' },
];

/** 应用壳：环境状态 + 页签导航 + 各功能页（P2 起行情采集在应用级运行） */
export default function App() {
  const [runtime, setRuntime] = useState('检测中…');
  const [database, setDatabase] = useState('检测中…');
  const [tab, setTab] = useState<Tab>('sde');

  // 行情采集在应用级持有：切页签不中断，也不重复初始化
  const collector = useMarketCollector();

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
        <p className="subtitle">P2 行情模块 · 5 枢纽采集 · 跨枢纽比价 · 监视列表</p>
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
      {tab === 'market' && <MarketPage collector={collector} />}
      {tab === 'watchlist' && <WatchlistPage />}
    </main>
  );
}
