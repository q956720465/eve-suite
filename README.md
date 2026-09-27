# EVE Suite

EVE Online 单机桌面工具套件 —— 在本地整合「市场行情（对标 ISK.GG）/ 资产估值（对标 jEveAssets）/ 工业计算（对标 Fuzzworks）」三大类能力，**零服务器、数据全本地**。

> 开发方案（唯一事实来源）：[EVE 工具套件 · 单机桌面版完整开发方案.md](<./EVE 工具套件 · 单机桌面版完整开发方案.md>)
> 当前进度与下一步：[DEV_STATUS.md](./DEV_STATUS.md)

## 技术栈

| 层 | 选型 |
|---|---|
| 桌面壳 | Tauri 2（Rust） |
| 核心逻辑 | 纯 TypeScript 包 `@eve-suite/core`（不依赖任何 UI） |
| 界面 | React 19 + Vite 8 |
| 数据库 | SQLite（WAL 模式，Rust 侧自管 sqlx 连接池） |
| 包管理 | pnpm workspace monorepo |
| 测试 | Vitest（core 包可离线运行） |
| 分发 | GitHub Actions 三平台构建 → GitHub Releases |

## 目录结构

```
eve-suite/
├── packages/
│   ├── core/            # 纯 TS 核心包：数据库层 + SDE 静态数据（后续含 ESI 客户端 / 四大引擎 / 调度）
│   │   ├── src/db/      # DbAdapter 契约（含事务原语）+ 迁移执行器 + 迁移清单 + 运行时适配器
│   │   ├── src/sde/     # SDE 解析 / 导入 / 搜索 + 运行时数据源
│   │   └── test/        # vitest 测试（node:sqlite 适配器 + 连接池模拟适配器）
│   └── ui/              # React 界面层（Vite，dev 端口固定 1420）
├── src-tauri/           # Tauri 2 壳（Rust）：窗口 / 自有命令（数据库 + SDE IO）/ 打包配置
│   ├── src/db.rs        # 自管 sqlx 连接池 + 事务会话命令
│   ├── src/sde.rs       # SDE 下载 / 解压 / 分块读取
│   ├── capabilities/    # 权限声明
│   └── icons/           # 应用图标（打包用）
├── .github/workflows/   # CI：三平台构建（build.yml）
├── .cargo/config.toml   # 国内 crates 镜像（CI 构建前移除）
└── .npmrc               # 国内 npm 镜像（CI 构建前移除）
```

## 环境要求

- **Node ≥ 24**（core 测试依赖内建 `node:sqlite`；本机 v25.2.1 已验证）
- **pnpm 11.7.0**（根 `package.json` 的 `packageManager` 字段已锁定版本）
- **Rust ≥ 1.85**（由 sqlx 0.8 / reqwest 0.13 决定；本机 1.98.1 已验证）
- Windows 10+ 自带 WebView2 运行时

## 快速开始

```bash
pnpm install                          # 安装全部 workspace 依赖

# 离线测试（core 包，无需 Tauri 运行时）
pnpm --filter @eve-suite/core test    # 或在根目录跑全部包：pnpm test

# 启动桌面应用（Tauri 窗口 + Vite 热更新）
pnpm tauri dev
```

## 构建安装包

```bash
pnpm tauri build                      # 当前平台全量打包
```

产物位置：`src-tauri/target/release/bundle/`

| 平台 | 产物 |
|---|---|
| Windows | `nsis/EVE Suite_0.0.0_x64-setup.exe`、`msi/EVE Suite_0.0.0_x64_en-US.msi` |
| macOS | `dmg/*.dmg`（未签名/未公证，首次打开需右键 → 打开） |
| Linux | `deb/*.deb`、`rpm/*.rpm`、`appimage/*.AppImage` |

> Windows 首次打包需联网下载 WiX（MSI 工具）与 NSIS 工具，缓存于 `%LOCALAPPDATA%\tauri\`。
> 网络受限时的绕行办法见 [`DEV_STATUS.md`](./DEV_STATUS.md) 的「踩坑备忘」。

## 国内镜像

| 文件 | 作用 |
|---|---|
| `.npmrc` | npm 依赖统一走 `registry.npmmirror.com` |
| `.cargo/config.toml` | crates 依赖走 `rsproxy.cn`（sparse 协议） |

**约定**：CI（GitHub Actions，境外机器）在构建前会移除这两个文件、直连官方源——该逻辑已写入 workflow，请勿修改。

## CI / CD（GitHub Actions）

workflow 文件：`.github/workflows/build.yml`

| 触发 | 行为 |
|---|---|
| push 到 `main` | 三平台（windows-latest / macos-latest / ubuntu-22.04）并行构建，产物上传到该次运行的 Artifacts |
| push `v*` tag | 等三平台构建全部完成后，把全部安装包自动发布到 GitHub Release |

## 数据库

- 单文件 SQLite：`%APPDATA%\com.eve-suite.desktop\eve-suite.db`（WAL 模式）
- 连接层：Rust 侧自管 sqlx 连接池（WAL / 外键 / busy_timeout 统一由连接选项设置）
- 迁移机制：`packages/core/src/db/migrations/` 按版本号累积执行，版本记录于 `schema_migrations` 表
- **规则**：
  - 已发布的迁移文件禁止修改，只能新增新版本文件
  - 多条语句的迁移必须使用 `statements` 数组（驱动 `execute` 只执行第一条语句）
  - core 内禁止裸写 `BEGIN` / `COMMIT`，一律走 `DbAdapter.transaction(fn)`（连接池下裸写会跨连接失效）

## SDE 静态数据（P1）

- 应用内「下载并导入」一键完成：从 CCP 官方拉取 SDE（约 95MB zip）→ 解压缓存到 `sde-cache/` → 批量入库
- 实测：build 3542233 共 12 万行入库，耗时约 **11 秒**
- 名称取 SDE 自带的 8 语言（落库 en / zh 两列），支持中英文搜索
- 空间站名由「星系 + 行星序号 + 拥有者军团 + 作业名」本地合成（SDE 不含站名）