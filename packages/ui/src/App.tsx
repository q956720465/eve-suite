import { CORE_VERSION } from '@eve-suite/core';

/** P0 占位界面：验证「UI → core 公共出口」链路 */
export default function App() {
  return (
    <main className="app">
      <h1>EVE SUITE</h1>
      <p className="subtitle">P0 骨架 · 空应用</p>
      <p className="meta">
        core 版本：<code>{CORE_VERSION}</code>
      </p>
    </main>
  );
}