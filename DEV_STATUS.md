# DEV_STATUS —— 跨会话开发进度锚点

> 用途：新会话开局先读本文件 + 方案文档第 8 节，即可定位「做到哪 / 下一步 / 有哪些坑」。
> 维护规则：每个子模块验收通过后更新一次本文件。

## 总览

| 阶段 | 状态 | 说明 |
|---|---|---|
| **P0 骨架** | ✅ 全部完成 | 含 Release 链路验证 |
| **P1 SDE 数据基座** | ✅ 全部完成（含 UI 人工复验） | 官方 SDE 下载/转换/入库 + 中英文搜索 |
| **P2 行情模块** | ✅ 全部完成（含 UI 人工复验） | 5 枢纽 5 分钟采集 + 按需行情 + 监视列表 |
| P3 OAuth 个人数据 | ⏳ 下一步（**需先备好 client_id**） | 本地回环授权 + 七类数据同步 + 资产/净值视图 |
| P4 四大引擎 | 未开始 | 蓝图 BOM 数据已随 P1 入库 |
| P5 整合功能 + 全域层 | 未开始 | |
| P6 分发打磨 | 未开始 | 仓库需由私有转公开；macOS 签名 / 公证 |

## P0 子任务明细

| 子任务 | 状态 | 提交 | 备注 |
|---|---|---|---|
| P0-1 monorepo 脚手架 + 国内镜像 | ✅ | `92dd44c` | pnpm workspace + core/ui 双包 |
| P0-2 Tauri 2 壳 + IPC 占位 | ✅ | `aa0364d` | 窗口 1280×800 |
| P0-3 SQLite 迁移骨架 | ✅ | `59030be` | 迁移执行器 + WAL；schema v1 |
| P0-4 三平台 CI 构建 | ✅ | `d96b966` | push main → Artifacts；tag `v*` → Release |
| P0-4-4 打 tag 验证 Release 链路 | ✅ | tag `v0.0.1` | Release 页已挂全平台安装包 |
| P0-5 README + DEV_STATUS | ✅ | `b2b342e` `5639a4f` | 构建/运行指南 + 本文件 |

## P1 子任务明细

| 子任务 | 状态 | 备注 |
|---|---|---|
| P1-1 迁移 0002：SDE 静态表 | ✅ | 11 张表 + 14 个索引；DDL 全部 `IF NOT EXISTS` |
| P1-2 Rust IO 层 | ✅ | 下载 / 解压 / 分块读 / 文件大小 / 删除（`src-tauri/src/sde.rs`） |
| P1-3 SDE 解析 · 转换 · 导入 | ✅ | 多语言名（含中文）、站名合成、蓝图 BOM；单事务原子导入 |
| P1-4 仓储层 + 搜索 API | ✅ | 物品（中英文）、空间站（站名 / 星系 / 星域）搜索 |
| P1-5 UI 数据页 | ✅ | 状态卡 + 一键同步 + 搜索表格 + 物品详情 |
| P1-6 数据库连接层重构 | ✅ | 退役 plugin-sql，自管 sqlx 连接池 + `transaction(fn)` 契约 |

## P2 子任务明细

| 子任务 | 状态 | 备注 |
|---|---|---|
| P2-1 ESI 客户端 | ✅ | URL 构造 / ETag 条件请求 / 响应头解析（限流、错误预算、X-Pages）/ 错误分类 |
| P2-2 请求调度器 | ✅ | 优先级队列（枢纽>按需>个人>全域）+ 令牌桶 + 并发控制 + 退避重试 + 错误预算降速 |
| P2-3 迁移 0003：行情表 | ✅ | market_orders / market_stats / market_history_daily / watchlist_items / watchlist_stats / etag 缓存 / 采集状态 |
| P2-4 枢纽采集器 | ✅ | 5 枢纽分页拉取 + 全 304 跳过 + 部分 304 补齐 + 整区替换 + 统计重算（含 5% 分位） |
| P2-5 按需刷新 | ✅ | 物品订单（TTL 5 分钟）+ 日线历史（每日一次；304 时仅刷新抓取时间） |
| P2-6 监视列表 | ✅ | 增删（级联清理）+ 6 小时聚合快照 + CSV 导出 |
| P2-7 UI 行情页 | ✅ | 采集状态表 + 跨枢纽比价 + 订单簿 + Lightweight-charts 日线图 + 监视页 |
| P2-8 真数据端到端验证 | ✅ | 5 枢纽 890,701 条订单，约 100 秒；实测见下 |

## 数据库现状

- schema 版本：**v3**（v1 settings + v2 SDE 11 表 + v3 行情 7 表）
- 迁移文件：`0001-settings` `0002-sde-tables` `0003-market-tables`（**已发布，禁止修改，只能新增**）
- 运行库位置：`%APPDATA%\com.eve-suite.desktop\eve-suite.db`（WAL）
- SDE 缓存：`%APPDATA%\com.eve-suite.desktop\sde-cache\`（11 个 JSONL，约 160MB）
- 实测入库（SDE build 3542233）：types 53,060 / stations 5,210 / blueprints 5,082 / 配方材料 42,830
- 实测采集（真实行情）：**5 枢纽 890,701 条订单**（伏尔戈 403,514 / 多美 182,019 / 美特伯里斯 119,361 / 西玛特尔 71,330 / 金纳泽 114,477），聚合出 56,347+ 条 market_stats；Tritanium 实测 吉他 卖 3.69 / 买 3.70 / 5% 分位 3.762
- 测试：**96 用例全绿**（12 个文件）

## 下一步（P3 开工前先做的事）

1. **注册 CCP 开发者应用拿 client_id**（P3 唯一前置依赖，审批有周期，建议尽早提交）
2. 对照方案文档 §4.3 / §5 / §6.1（OAuth scopes、个人数据表、资产模块验收）产出 **P3 任务清单 + 验收清单**，交用户确认后再写代码

## 踩坑备忘（重要，勿重蹈）

1. **【致命】手写 `BEGIN` / `COMMIT` 在连接池驱动下必然失效**：`tauri-plugin-sql` 内部是 sqlx 连接池（多连接），TS 侧发出的 `BEGIN` 与后续语句会被分派到**不同连接** → `database is locked` 或原子性静默丢失；而测试用 `node:sqlite` 是单连接，**根本测不出来**（典型「测试绿、运行时红」，P1 踩中并已根治）。
   - 对策：退役 plugin-sql，自管 sqlx 连接池（`src-tauri/src/db.rs`），把「原子执行」写进 `DbAdapter.transaction(fn)` 契约 → **禁止在 core 里再裸写 BEGIN/COMMIT**。
   - 已加 `test/db/pooling.test.ts`：多连接轮转适配器 + 反例用例，同类缺陷以后会在 CI 当场变红。
2. **连接级 PRAGMA 必须通过连接选项设置**：`foreign_keys` / `busy_timeout` 在池化驱动下用 `execute('PRAGMA ...')` 只对其中一条连接生效。现统一在 `SqliteConnectOptions` 中设置。
3. **迁移含多条语句时必须用 `statements` 数组**：运行时驱动 `execute` 只执行传入 SQL 的**第一条**。
4. **ESI 的 304 响应不携带 `X-Pages`**：分页采集若用首页的 `X-Pages` 判断总页数，首页命中 304 时会把页数误判为 1 → 漏采。已改为「首页 304 时回退到上次记录的页数」（`market_collector_state.pages`）。
5. **ESI 的 CORS 完整可用**：`Access-Control-Allow-Origin: *`，且通过 `Access-Control-Expose-Headers` 暴露 Etag / X-Pages / 错误预算等头，预检允许 `if-none-match` → **HTTP 直接走渲染进程 fetch**，无需 Rust 代理（省掉每轮数十 MB 的 IPC）。
6. **本机 GitHub 直连间歇性不通（TCP 443）**：`git push` 用重试循环（30s × 12 次）；下载 GitHub 资产走 `https://gh-proxy.com/...`（~25MB/s）。gh CLI 已装但**未登录**（设备码兑换 token 撞上 443）。
7. **Windows 本地打包的 WiX 依赖**：已手动解压到 `%LOCALAPPDATA%\tauri\WixTools314\`（换机需重做）；NSIS 同理（已缓存）。
8. **TypeScript 7** 不再自动加载 `@types/*`，tsconfig 需显式 `"types"`。
9. **本机 DPI 缩放 150%**：PowerShell 做 UI 自动化前必须 `SetProcessDPIAware()`，否则坐标差 1.5 倍。
10. **WebView2 的文本输入无法被自动化注入**（SendKeys/剪贴板均无效，鼠标事件可到达）：UI 的文字输入类验收需人工完成；截图用 `PrintWindow(flags=2)` 可靠，屏幕 GDI 截屏拿不到 WebView2 内容。
11. **dev 启动失败先查端口 1420**：上一次未完全退出的 vite 会占用端口（`Stop-Process` 按占用进程清理）。

## 关键文件地图

| 关注点 | 文件 |
|---|---|
| UI 入口 / 导航 | `packages/ui/src/App.tsx` |
| UI 数据页（SDE） | `packages/ui/src/sde/SdePage.tsx` |
| UI 行情页 / 监视页 | `packages/ui/src/market/MarketPage.tsx`、`WatchlistPage.tsx` |
| UI 采集调度 / 图表 | `packages/ui/src/market/useMarketCollector.ts`、`PriceChart.tsx` |
| core 公共出口（typed command 层） | `packages/core/src/index.ts` |
| 数据库契约 / 迁移执行器 | `packages/core/src/db/types.ts`、`db/migrate.ts` |
| 迁移清单（新增迁移在此注册） | `packages/core/src/db/migrations/index.ts` |
| 运行时数据库适配器（事务会话） | `packages/core/src/db/tauri.ts` |
| 数据库连接层（Rust） | `src-tauri/src/db.rs` |
| SDE 下载/解压/分块读（Rust） | `src-tauri/src/sde.rs` |
| SDE 解析 · 导入 · 搜索 | `packages/core/src/sde/` |
| ESI 客户端 / 调度器 | `packages/core/src/esi/client.ts`、`scheduler.ts` |
| 行情采集 / 统计 / 按需 / 监视 | `packages/core/src/market/` |
| Tauri 壳（命令注册） | `src-tauri/src/lib.rs` |
| CI workflow | `.github/workflows/build.yml` |
| 方案（唯一事实来源） | `EVE 工具套件 · 单机桌面版完整开发方案.md` |

## 本机环境（已验证）

node v25.2.1 · pnpm 11.7.0 · rustc/cargo 1.98.1（项目要求 ≥ 1.85）· git 2.55.0（Windows）· 屏幕 2560×1440 @150%
