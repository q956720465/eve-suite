import { CORE_VERSION } from '@eve-suite/core';
import { initDatabase } from '@eve-suite/core/db/tauri';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';

/**
 * 关于页（P6-1 版本与元数据）。
 *
 * 面向**用户**的元数据页：版本、运行环境、数据存放位置与数据来源。
 * 合规声明（CCP 商标与第三方开发许可）在 P6-2 追加为独立区块。
 */

/** 应用配置目录名（与 `src-tauri/tauri.conf.json` 的 identifier 一致） */
const APP_DIR = 'com.eve-suite.desktop';

const STORAGE_PATHS: readonly { platform: string; path: string }[] = [
  { platform: 'Windows', path: `%APPDATA%\\${APP_DIR}\\eve-suite.db` },
  { platform: 'macOS', path: `~/Library/Application Support/${APP_DIR}/eve-suite.db` },
  { platform: 'Linux', path: `~/.config/${APP_DIR}/eve-suite.db` },
];

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function AboutPage() {
  const [shellVersion, setShellVersion] = useState('检测中…');
  const [schemaVersion, setSchemaVersion] = useState('检测中…');
  const [journalMode, setJournalMode] = useState('—');

  useEffect(() => {
    if (isTauri()) {
      invoke<string>('app_version')
        .then(setShellVersion)
        .catch((error: unknown) => setShellVersion(`读取失败：${describeError(error)}`));
    } else {
      setShellVersion('浏览器预览（非 Tauri 环境）');
    }

    initDatabase()
      .then(({ schemaVersion: dbSchema, journalMode: journal }) => {
        setSchemaVersion(`v${dbSchema}`);
        setJournalMode(journal);
      })
      .catch((error: unknown) => {
        setSchemaVersion(isTauri() ? `读取失败：${describeError(error)}` : '浏览器预览（非 Tauri 环境）');
      });
  }, []);

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <h2>版本与运行环境</h2>
          <span className="hint">版本号唯一真源为打包配置，构建期同步到各包，避免手工改动漂移</span>
        </div>
        <table className="result">
          <thead>
            <tr>
              <th>项目</th>
              <th>值</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>EVE Suite 版本</td>
              <td className="sell">{shellVersion}</td>
            </tr>
            <tr>
              <td>core 版本</td>
              <td>{CORE_VERSION}</td>
            </tr>
            <tr>
              <td>数据库 schema</td>
              <td>{schemaVersion}</td>
            </tr>
            <tr>
              <td>日志模式</td>
              <td>{journalMode}</td>
            </tr>
            <tr>
              <td>运行环境</td>
              <td>{isTauri() ? 'Tauri 窗口（桌面）' : '浏览器预览（非 Tauri 环境）'}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>数据与隐私</h2>
          <span className="hint">零服务器、无账号体系；数据全部保存在本机</span>
        </div>
        <p className="hint">
          本工具<strong>没有服务端</strong>，也不收集任何遥测数据。所有行情、资产、工业与采矿数据
          都写入下面这个本地 SQLite 文件；卸载应用<strong>不会</strong>自动删除它，如需彻底清除请手动删除该文件。
        </p>
        <table className="result">
          <thead>
            <tr>
              <th>平台</th>
              <th>数据库文件</th>
            </tr>
          </thead>
          <tbody>
            {STORAGE_PATHS.map((item) => (
              <tr key={item.platform}>
                <td>{item.platform}</td>
                <td>{item.path}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="hint">
          <strong>OAuth 刷新令牌</strong>不写入数据库，而是存在操作系统钥匙串
          （Windows 凭据管理器 / macOS 钥匙串 / Linux Secret Service）；
          <strong>Webhook 地址与加签密钥</strong>存在数据库的 <code>settings</code> 表，仅本机可见。
        </p>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>数据来源</h2>
          <span className="hint">全部来自 CCP 官方公开接口，未使用任何第三方私有数据源</span>
        </div>
        <table className="result">
          <thead>
            <tr>
              <th>数据</th>
              <th>来源</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>物品 / 蓝图 / 星系 / 空间站等静态数据</td>
              <td>CCP 官方 SDE（Static Data Export），应用内一键下载导入</td>
            </tr>
            <tr>
              <td>市场行情与历史</td>
              <td>CCP 官方 ESI（`/markets/*`），按 `Cache-Control` 缓存，不重复拉取</td>
            </tr>
            <tr>
              <td>资产 / 钱包 / 工业 / 采矿等个人数据</td>
              <td>CCP 官方 ESI 授权接口（仅在你本人授权后读取你自己的角色数据）</td>
            </tr>
            <tr>
              <td>市场价格估值口径</td>
              <td>本地按订单簿计算（默认卖价 5% 分位，抗钓鱼单），无外部行情源</td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}
