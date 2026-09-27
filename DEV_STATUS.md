# DEV_STATUS —— 跨会话开发进度锚点

> 用途：新会话开局先读本文件 + 方案文档第 8 节，即可定位「做到哪 / 下一步 / 有哪些坑」。
> 维护规则：每个子模块验收通过后更新一次本文件。

## 总览

| 阶段 | 状态 | 说明 |
|---|---|---|
| **P0 骨架** | ✅ 全部完成 | 含 Release 链路验证 |
| **P1 SDE 数据基座** | ✅ 完成（UI 搜索待人工复验） | 官方 SDE 下载/转换/入库 + 中英文搜索 |
| P2 行情模块 | ⏳ 下一步 | 枢纽 5 分钟采集 + 按需订单 + 历史回填 |
| P3 OAuth 个人数据 | 未开始 | **提前提醒：需要 CCP 开发者应用 client_id，申请有周期** |
| P4 四大引擎 | 未开始 | 蓝图 BOM 数据已随 P1 入库 |
| P5 整合功能 + 全域层 | 未开始 | |
| P6 分发打磨 | 未开始 | 仓库需由私有转公开；macOS 签名 / 公证 |

## P0 子任务明细

| 子任务 | 状态 | 提交 | 备注 |
|---|---|---|---|
| P0-1 monorepo 脚手架 + 国内镜像 | ✅ | `92dd44c` | pnpm workspace + core/ui 双包 + tsconfig.base |
| P0-2 Tauri 2 壳 + IPC 占位 | ✅ | `aa0364d` | 窗口 1280×800（min 1024×700） |
| P0-3 SQLite 迁移骨架 | ✅ | `59030be` | 迁移执行器 + WAL；schema v1 |
| P0-4 三平台 CI 构建 | ✅ | `d96b966` | push main → Artifacts；tag `v*` → Release；三平台全绿 |
| P0-4-4 打 tag 验证 Release 链路 | ✅ | tag `v0.0.1` | Release 页已挂全平台安装包 |
| P0-5 README + DEV_STATUS | ✅ | `b2b342e` `5639a4f` | 构建/运行指南 + 本文件 |

## P1 子任务明细

| 子任务 | 状态 | 备注 |
|---|---|---|
| P1-1 迁移 0002：SDE 静态表 | ✅ | 11 张表 + 14 个索引；DDL 全部 `IF NOT EXISTS` |
| P1-2 Rust IO 层 | ✅ | 下载 / 解压 / 分块读 / 文件大小 / 删除，共 7 个命令（`src-tauri/src/sde.rs`） |
| P1-3 SDE 解析 · 转换 · 导入 | ✅ | 多语言名（含中文）、站名合成、蓝图 BOM；单事务原子导入 |
| P1-4 仓储层 + 搜索 API | ✅ | 物品（中英文）、空间站（站名 / 星系 / 星域）搜索 |
| P1-5 UI 数据页 | ✅ | 状态卡 + 一键同步（含进度）+ 搜索表格 + 物品详情 |
| P1-6 数据库连接层重构 | ✅ | 退役 plugin-sql，自管 sqlx 连接池 + `transaction(fn)` 契约 |

## 数据库现状

- schema 版本：**v2**（v1 `settings` + v2 SDE 11 张表）
- 迁移文件：`0001-settings.ts`、`0002-sde-tables.ts`（**已发布，禁止修改，只能新增**）
- 运行库位置：`%APPDATA%\com.eve-suite.desktop\eve-suite.db`（WAL）
- SDE 缓存：`%APPDATA%\com.eve-suite.desktop\sde-cache\`（解压后的 11 个 JSONL，约 160MB）
- 实测入库量（CCP SDE build 3542233 / 2026-09-24）：types **53,060**、groups 1,611、categories 48、regions 114、constellations 1,184、systems 8,490、stations **5,210**、blueprints 5,082、blueprint_activities 19,138、blueprint_io **42,830**
- 测试：**43 用例全绿**（6 个文件），含连接池模拟适配器用例

## 下一步（P2 开工前先做的事）

1. 对照方案文档第 4/5/6 节（枢纽 5 分钟采集、按需订单、400 天日线、监视列表）产出 **P2 任务清单 + 验收清单**，交用户确认后再写代码
2. （可并行）准备 CCP 开发者应用注册（P3 才用，但审批有周期）

## 踩坑备忘（重要，勿重蹈）

1. **【致命】手写 `BEGIN` / `COMMIT` 在连接池驱动下必然失效**：`tauri-plugin-sql` 内部是 sqlx **连接池**（多连接），TS 侧发出的 `BEGIN` 与后续语句会被分派到**不同连接** → `database is locked`，或原子性静默丢失（DDL 在别的连接上自动提交了）。更坑的是：测试用 `node:sqlite` 是单连接，**根本测不出来**（典型「测试绿、运行时红」，P1 踩中且已根治）。
   - 对策：退役 plugin-sql，自管 sqlx 连接池（`src-tauri/src/db.rs`），把「原子执行」写进 `DbAdapter.transaction(fn)` 契约 → **禁止在 core 里再裸写 BEGIN/COMMIT**。
   - 已加 `test/db/pooling.test.ts`：多连接轮转适配器 + 反例用例，同类缺陷以后会在 CI 当场变红。
2. **连接级 PRAGMA 必须通过连接选项设置**：`foreign_keys` / `busy_timeout` 在池化驱动下用 `execute('PRAGMA ...')` 只对其中一条连接生效（`journal_mode` 是库级持久，不受影响）。现统一在 `SqliteConnectOptions` 中设置。
3. **迁移含多条语句时必须用 `statements` 数组**：运行时驱动 `execute` 只执行传入 SQL 的**第一条**（`sqlx::query` 语义）。已发布迁移 0001 保持 `sql` 单语句模式不变。
4. **本机 GitHub 直连间歇性不通（TCP 443）**——表现为 push 失败、下载卡死。对策：
   - `git push`：用重试循环（每 30s 一次、最多 12 次），成功率高
   - 下载 GitHub Release 资产：走 `https://gh-proxy.com/https://github.com/...` 镜像（实测 25MB/s；ghproxy.net 仅 ~25KB/s 勿用）
   - gh CLI 已装（`%LOCALAPPDATA%\Programs\gh\bin\gh.exe`，v2.101.0），**登录未完成**（设备码兑换 token 撞上 443 超时）
5. **Windows 本地打包的 WiX 依赖**：首次 MSI 打包需从 GitHub 下载 WiX 3.14（41MB，直连必卡）。已手动解压到 `%LOCALAPPDATA%\tauri\WixTools314\`（Tauri 校验 = 10 个文件存在性检查，命中即跳过下载）。**换机/重装需重做**；NSIS 同理（已缓存）。
6. **TypeScript 7**：不再自动加载 `@types/*`，tsconfig 需显式 `"types": ["node"]`。
7. **`node:sqlite`**：core 测试用 Node 内建 SQLite，ExperimentalWarning 属正常；测试与运行时共用同一套迁移/导入逻辑。
8. **本机 DPI 缩放 150%**：用 PowerShell 做 UI 自动化时，非 DPI 感知进程拿到的窗口坐标是逻辑值，与物理坐标差 1.5 倍（点击会偏）。需先 `SetProcessDPIAware()`。

## 关键文件地图

| 关注点 | 文件 |
|---|---|
| UI 入口 | `packages/ui/src/App.tsx` |
| UI 数据页（SDE） | `packages/ui/src/sde/SdePage.tsx` |
| core 公共出口（typed command 层） | `packages/core/src/index.ts` |
| 数据库契约 / 迁移执行器 | `packages/core/src/db/types.ts`、`packages/core/src/db/migrate.ts` |
| 迁移清单（新增迁移在此注册） | `packages/core/src/db/migrations/index.ts` |
| 运行时数据库适配器（事务会话） | `packages/core/src/db/tauri.ts` |
| 数据库连接层（Rust：自管池 + 事务命令） | `src-tauri/src/db.rs` |
| SDE 下载 / 解压 / 分块读（Rust） | `src-tauri/src/sde.rs` |
| SDE 解析 · 导入 · 搜索（core） | `packages/core/src/sde/` |
| SDE 运行时数据源 | `packages/core/src/sde/tauri.ts` |
| Tauri 壳（命令注册） | `src-tauri/src/lib.rs` |
| 打包配置 / 权限 | `src-tauri/tauri.conf.json`、`src-tauri/capabilities/default.json` |
| CI workflow | `.github/workflows/build.yml` |
| 方案（唯一事实来源） | `EVE 工具套件 · 单机桌面版完整开发方案.md` |

## 本机环境（已验证）

node v25.2.1 · pnpm 11.7.0 · rustc/cargo 1.98.1（项目要求 ≥ 1.85）· git 2.55.0（Windows）· 屏幕 2560×1440 @150%
