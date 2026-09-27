# DEV_STATUS —— 跨会话开发进度锚点

> 用途：新会话开局先读本文件 + 方案文档第 8 节，即可定位「做到哪 / 下一步 / 有哪些坑」。
> 维护规则：每个子模块验收通过后更新一次本文件。

## 总览

| 阶段 | 状态 | 说明 |
|---|---|---|
| **P0 骨架** | ✅ 完成（P0-4-4 可选验证未做） | 明细见下表 |
| P1 SDE 数据基座 | ⏳ 下一步 | 静态数据导入 |
| P2 行情模块 | 未开始 | |
| P3 OAuth 个人数据 | 未开始 | **提前提醒：需要 CCP 开发者应用 client_id，申请有周期** |
| P4 四大引擎 | 未开始 | |
| P5 整合功能 + 全域层 | 未开始 | |
| P6 分发打磨 | 未开始 | 仓库需由私有转公开；macOS 签名 / 公证 |

## P0 子任务明细

| 子任务 | 状态 | 提交 | 备注 |
|---|---|---|---|
| P0-1 monorepo 脚手架 + 国内镜像 | ✅ | `92dd44c` | pnpm workspace + core/ui 双包 + tsconfig.base |
| P0-2 Tauri 2 壳 + IPC 占位 | ✅ | `aa0364d` | 窗口 1280×800（min 1024×700）；`app_version` 命令双向验证通过 |
| P0-3 SQLite 迁移骨架 | ✅ | `59030be` | DbAdapter + 迁移执行器 + plugin-sql 运行时接线；schema v1；测试 7/7 绿 |
| P0-4 三平台 CI 构建 | ✅ | `d96b966` | push main → Artifacts；tag `v*` → Release；**三平台 job 已全绿** |
| P0-4-4 打 tag 验证 Release 链路 | ⏳ 待决策 | — | 建议打 `v0.0.1` 试跑（仓库私有，仅自己可见） |
| P0-5 README + DEV_STATUS | ✅ | 本次提交 | 即 README.md + 本文件 |

## 数据库现状

- schema 版本：**v1**（`settings` 表）
- 迁移文件：`packages/core/src/db/migrations/0001-settings.ts`（**已发布，禁止修改，只能新增**）
- 运行库位置：`%APPDATA%\com.eve-suite.desktop\eve-suite.db`（WAL）
- 测试：`pnpm --filter @eve-suite/core test` —— 2 文件 7 用例全绿（新建建表 / 应用生产迁移 / 幂等重入 / 增量迁移 / 失败回滚 / 版本重复拒绝）

## 下一步（P1 开工前先做的事）

1. 对照方案文档第 8 节 P1 要求与数据源章节，产出 **P1 任务清单 + 验收清单**，交用户确认后再写代码
2. （可并行）准备 CCP 开发者应用注册（P3 才用，但审批有周期）

## 踩坑备忘（重要，勿重蹈）

1. **tauri-plugin-sql 权限陷阱**：`sql:default` 只含 load/close，**不含 execute/select**。必须在 `src-tauri/capabilities/default.json` 显式授权 `sql:allow-execute`、`sql:allow-select`，否则运行时报 `sql.execute not allowed`（P0-3 实测踩中）。
2. **本机 GitHub 直连间歇性不通（TCP 443）**——表现为 push 失败、下载卡死。对策：
   - `git push`：用重试循环（每 30s 一次、最多 12 次），成功率高
   - 下载 GitHub Release 资产：走 `https://gh-proxy.com/https://github.com/...` 镜像（实测 25MB/s；ghproxy.net 仅 ~25KB/s 勿用）
   - gh CLI 已装（`%LOCALAPPDATA%\Programs\gh\bin\gh.exe`，v2.101.0），**登录未完成**（设备码兑换 token 环节撞上 443 超时）。等网络稳定窗口执行 `gh auth login --web` 即可，供 P6 发布与 CI 监控使用
3. **Windows 本地打包的 WiX 依赖**：首次 MSI 打包需从 GitHub 下载 WiX 3.14（41MB，直连必卡）。已手动解压到 `%LOCALAPPDATA%\tauri\WixTools314\` 完成缓存注入（Tauri 校验 = 10 个文件存在性检查，缓存命中即跳过下载）。**本机已就位；换机/重装需重做**。NSIS 同理（已缓存）。
4. **TypeScript 7**：不再自动加载 `@types/*`，tsconfig 需显式配置 `"types": ["node"]`（core 包已配，见 `packages/core/tsconfig.json`）。
5. **node:sqlite**：core 测试用 Node 内建 SQLite（免原生依赖），Node 会提示 ExperimentalWarning 属正常；运行时数据库走 tauri-plugin-sql，两者共用同一套迁移代码（`test/helpers/node-sqlite-adapter.ts` 为测试适配器）。
6. **git CRLF 提示**：Windows 上提交时提示 `LF will be replaced by CRLF`，为 autocrlf 行为，无实际影响。

## 关键文件地图

| 关注点 | 文件 |
|---|---|
| UI 入口 | `packages/ui/src/App.tsx` |
| core 公共出口（typed command 层） | `packages/core/src/index.ts` |
| 数据库接口 / 迁移执行器 | `packages/core/src/db/types.ts`、`packages/core/src/db/migrate.ts` |
| 迁移清单（新增迁移在此注册） | `packages/core/src/db/migrations/index.ts` |
| 运行时数据库接线 | `packages/core/src/db/tauri.ts` |
| Tauri 壳（IPC 命令） | `src-tauri/src/lib.rs` |
| 打包配置 | `src-tauri/tauri.conf.json` |
| 权限声明 | `src-tauri/capabilities/default.json` |
| CI workflow | `.github/workflows/build.yml` |
| 方案（唯一事实来源） | `EVE 工具套件 · 单机桌面版完整开发方案.md` |

## 本机环境（已验证）

node v25.2.1 · pnpm 11.7.0 · rustc/cargo 1.98.1 · git 2.55.0（Windows）