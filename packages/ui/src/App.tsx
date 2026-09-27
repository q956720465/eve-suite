import { CORE_VERSION } from '@eve-suite/core';
import { initDatabase } from '@eve-suite/core/db/tauri';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';

/** P0 占位界面：验证「UI → core 公共出口」「UI → Rust IPC」「SQLite 迁移骨架」三条链路 */
export default function App() {
  const [runtime, setRuntime] = useState('检测中…');
  const [database, setDatabase] = useState('检测中…');

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
      <h1>EVE SUITE</h1>
      <p className="subtitle">P0 骨架 · 空应用</p>
      <p className="meta">
        core 版本：<code>{CORE_VERSION}</code>
      </p>
      <p className="meta">
        运行环境：<code>{runtime}</code>
      </p>
      <p className="meta">
        数据库：<code>{database}</code>
      </p>
    </main>
  );
}