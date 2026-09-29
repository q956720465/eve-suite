import { CORE_VERSION } from '@eve-suite/core';
import { initDatabase } from '@eve-suite/core/db/tauri';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';

import type { UpdaterHandle } from './useUpdater';

/**
 * 关于页（P6-1 版本与元数据 / P6-2 合规 / P6-4 软件更新）。
 *
 * 面向**用户**：合规声明、版本与运行环境、软件更新、数据存放位置与数据来源。
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

/** 更新状态的人类可读描述 */
function describeUpdateStatus(updater: UpdaterHandle): string {
  switch (updater.status) {
    case 'idle':
      return '尚未检查';
    case 'checking':
      return '正在检查…';
    case 'up-to-date':
      return '已是最新版本';
    case 'available':
      return `发现新版本 ${updater.version ?? ''}`;
    case 'downloading':
      return updater.progress === null
        ? '正在下载…'
        : `正在下载 ${Math.round(updater.progress * 100)}%`;
    case 'installing':
      return '正在安装，完成后将自动重启…';
    case 'error':
      return `检查失败：${updater.error ?? '未知错误'}`;
    default:
      return '仅在桌面应用内可用';
  }
}

export default function AboutPage({ updater }: { updater: UpdaterHandle }) {
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
          <h2>许可与合规</h2>
          <span className="hint">非官方第三方工具；遵守 EVE Online 第三方开发者政策</span>
        </div>
        <p className="hint">
          <strong>
            EVE Online 及相关商标、标识、游戏内素材的全部权利归 Fenris Creations（原 CCP Games）所有。
          </strong>{' '}
          本工具是<strong>非官方第三方工具</strong>，与 Fenris Creations 之间不存在隶属、赞助或背书关系；
          名称中的「EVE」仅用于说明用途。
        </p>
        <table className="result">
          <thead>
            <tr>
              <th>项目</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>数据来源</td>
              <td>仅使用 EVE Online 官方公开的 ESI / SDE 接口，不使用任何非公开数据源</td>
            </tr>
            <tr>
              <td>缓存合规</td>
              <td>按官方要求遵循 Cache-Control / Expires 缓存，不重复拉取同一份数据</td>
            </tr>
            <tr>
              <td>账号与数据</td>
              <td>无服务端、无账号体系；不收集也不上传任何用户数据</td>
            </tr>
            <tr>
              <td>本软件许可</td>
              <td>MIT（见仓库 LICENSE 文件）</td>
            </tr>
            <tr>
              <td>免责声明</td>
              <td>价格、估值与统计结果均由本地数据推算，仅供参考；游戏内交易与决策风险自负</td>
            </tr>
          </tbody>
        </table>
        <p className="hint">
          本项目遵守 EVE Online 第三方开发者政策与开发者许可协议。如权利方对本工具的使用方式有异议，
          请联系仓库作者下线相关内容。
        </p>
      </div>

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
          <h2>软件更新</h2>
          <span className="hint">启动后自动检查一次；发现新版本时由你决定何时更新，不会静默安装</span>
        </div>
        <div className="params">
          <button
            type="button"
            onClick={() => void updater.check()}
            disabled={
              updater.status === 'checking' ||
              updater.status === 'downloading' ||
              updater.status === 'installing'
            }
          >
            {updater.status === 'checking' ? '检查中…' : '检查更新'}
          </button>
          <button type="button" onClick={() => void updater.install()} disabled={updater.status !== 'available'}>
            立即更新
          </button>
        </div>
        <table className="result">
          <thead>
            <tr>
              <th>当前版本</th>
              <th>最新版本</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{updater.currentVersion ?? shellVersion}</td>
              <td>{updater.version ?? '—'}</td>
              <td className="sell">{describeUpdateStatus(updater)}</td>
            </tr>
          </tbody>
        </table>
        {updater.status === 'available' && updater.notes !== null && updater.notes.trim().length > 0 && (
          <p className="hint">发行说明：{updater.notes}</p>
        )}
        <p className="hint">
          更新包在发布时使用<strong>私钥签名</strong>，应用内用内置公钥校验 —— 签名不符会被拒绝安装。
          检查与下载都走你本机到 GitHub 的直连，没有中间服务器。
        </p>
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
