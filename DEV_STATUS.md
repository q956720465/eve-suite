# DEV_STATUS —— 跨会话开发进度锚点

> 用途：新会话开局先读本文件 + 方案文档第 8 节，即可定位「做到哪 / 下一步 / 有哪些坑」。
> 维护规则：每个子模块验收通过后更新一次本文件。
>
> **接续入口（新会话从这里开始）**：**P3 已全部完成并验收**（含 P3-8 真数据端到端验证——界面五步全通过、登出/二次授权/重新同步全链路实测）；**P4-1 估值引擎**（唯一定价出口 + 净值/资产页口径切换）、**P4-2 蓝图成本引擎**（BOM × 引擎价 + ME/TE 折扣）、**P4-3 LP 比价引擎**（ESI 公共 LP 商店 + ISK/LP 排名 + LP 组合）均已验收（真实库 / 真实 ESI 零误差，core **283** 用例全绿）。
> 下一子任务是 **P4-4 矿石精炼值引擎**（需补 SDE 矿石→矿物映射；**开工前先出「任务清单 + 验收清单」交用户确认**）。跳到「## 下一步」看待办清单，跳到「## P4 进度」看 P4-1 / P4-2 / P4-3 明细与实测记录。
> 关键外部配置：CCP 应用 Callback URL 必须是 `http://127.0.0.1:14565/callback`（详见决策区与踩坑 #23）。

## 总览

| 阶段 | 状态 | 说明 |
|---|---|---|
| **P0 骨架** | ✅ 全部完成 | 含 Release 链路验证 |
| **P1 SDE 数据基座** | ✅ 全部完成（含 UI 人工复验） | 官方 SDE 下载/转换/入库 + 中英文搜索 |
| **P2 行情模块** | ✅ 全部完成（含 UI 人工复验） | 5 枢纽 5 分钟采集 + 按需行情 + 监视列表 |
| **P3 OAuth 个人数据** | ✅ 全部完成（含真数据端到端验证） | 本地回环授权 + 七类数据同步（含调度）+ 资产/净值页；**界面五步验收 + 登出/二次授权/重新同步全链路实测通过** |
| **P4 四大引擎** | 🔄 进行中（P4-1 / P4-2 / P4-3 已完成） | 估值 + 蓝图成本 + LP 比价已落地；余 矿石精炼值 |
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

## P3 进度（已完成）

| 子任务 | 状态 | 备注 |
|---|---|---|
| P3-1 OAuth 本地回环授权 | ✅ 完成 | core 逻辑层（PKCE S256 / 授权 URL / 令牌交换与刷新 / JWT 解析）+ **Rust 回环服务**（`src-tauri/src/oauth.rs`，**127.0.0.1 固定端口** `/callback`）+ 打开系统浏览器；真实浏览器授权已在 **P3-8** 跑通（过程中修掉 3 个缺陷，见踩坑 #21/#22/#23） |
| P3-2 令牌安全存储 | ✅ 完成 | Rust `keyring` **只存 refresh token**（账号 `refresh-token:<characterId>`），access token 仅内存；**数据库零令牌字段**；CI 三平台构建已验证（run `36322411890`） |
| P3-3 认证请求 + 自动刷新 | ✅ 完成 | `EsiClient` 注入 Bearer（`auth` + `characterId`）；401 → 强制刷新后**只重试一次**；`TokenManager` 临期（默认 60s）自动刷新，**单飞**并发 + **轮换回写**钥匙串 |
| P3-4 迁移 0004 个人表 | ✅ 完成 | 10 张表（9 张个人/净值 + 1 张同步状态）+ 9 个索引；字段按官方 OpenAPI 3.1 核对；真实库 v3→v4 实测通过 |
| P3-5 七类数据同步 | ✅ 完成 | `PersonalSyncer`（8 端点水位：assets / wallet_balance / wallet_journal / orders / contracts / industry / mining / loyalty）；覆盖型整体替换、追加型按主键 upsert（journal 按 entry_id、mining 按复合键）；分页共享 `esi/paging.ts`（不改 P2 collector）；`insertRows` 加可选 `onConflict`（默认行为不变）；余额与军团 ID 写 `characters`；失败隔离（单 scope 只写该行 last_error，last_ok_at 不变）；认证错误原样记录不包装；8 端点真实未认证请求实测全部 401（路径校验通过，含尾斜杠兼容行为） |
| P3-6 同步调度 | ✅ 完成 | `PersonalSyncScheduler`（core，纯逻辑可测）：**启动即同步** + 周期（默认 **20 分钟**，可配）；**单飞**（上轮未结束不叠轮）；`pause`/`resume`（计量网络，恢复即补一轮）；**`reauth_required` 停摆**——中止该角色剩余端点、置阻塞态、回调提示，直到 `clearReauthBlock`（其它角色不受影响）。**Cache-Control 遵守**：`EsiResult.cacheControl` 解析 `Cache-Control` + **`Expires`**，按到期时间写入 `personal_sync_state.expires_at`，未到期则整轮不发请求（`skippedReason='cache'`）；`force` 可越过。`personal/repo.ts` 提供角色清单与水位读取 |
| P3-7 UI 资产页 | ✅ 完成 | 应用级运行时单例（`ui/src/core/runtime.ts`：共享调度器 + `TokenManager` + 钥匙串，含补上的 `createFetchTokenHttp`）；`useCharacters`（授权/登出）、`usePersonalSync`（启停/暂停/立即同步 force/reauth 停摆）；`AssetsPage`（角色卡 + 净值四分项 + 8 端点同步状态 + 资产聚合表可展开到逐条含站名 + 每日快照）；净值口径与快照写入见决策。**P3-8 补丁**：每轮同步完成后刷新角色卡（否则 `corporation_id` / `last_sync_at` 一直显示授权那一刻的陈旧值，表现为「未知 (ESI未补齐)」+「--」）。该补丁只覆盖自动轮次，**手动「立即同步」已由 P3-9 补齐**） |
| P3-8 真数据端到端验证 | ✅ 完成 | 真实授权（角色 WEEK 813 / 2114553827）+ 本地库核验全绿 + **界面五步全通过**（①立即同步 ②切页签不中断 ③暂停/恢复 ④生成今日快照 ⑤登出清除 + 二次授权 + 重新同步）+ 游戏内读数抽查（**结论待用户回执**）。全部结论见下节 |
| P3-9 同步/启动时机修复 | ✅ 完成 | P3-8 收尾中暴露的缺陷一并修掉（①②③ 为缺陷，④ 为随之失效的文案）：①**手动「立即同步」后角色卡不刷新**（`syncNow()` 不产生完成信号，卡片刷新只挂在 `sync.lastRound` 上，而收尾重载漏了角色卡）→ `handleSyncNow` 补 `await characters.refresh()`；②**「启动即同步」实际依赖先访问「资产」页**（`start()` 挂在 AssetsPage 的 effect 上）→ 个人数据 hook（`useCharacters` + `usePersonalSync`）上移到**应用壳 App 级**持有，`AssetsPage` 改收 props；③**二次授权后不自动补跑一轮**（`start()` 幂等）→ 新增 `kick()`（暂停 / 未启动时忽略，`scheduler.runOnce()` 本就 public 且自带单飞，故**core 未改**），App 监听角色集合变化即补跑；④授权成功提示语由「（可点「立即同步」拉取数据）」改为「（正在自动同步…）」——补跑自动化后原括注已失真 |

**P3-8 核验记录（2026-09-27，真实库 `%APPDATA%\com.eve-suite.desktop\eve-suite.db`）**：
- 角色行：`WEEK 813` / `2114553827`，`corporation_id=98446928` **已由同步补齐**，7 个 scopes 齐全（含修正后的 `esi-characters.read_loyalty.v1`）
- 8 端点水位：全部 `last_ok_at` 有值、`last_error` 全为 null；缓存到期时间符合 ESI 实际（钱包余额 30s / 订单 15m / 合同工业 5m / 资产 1h）
- 数据行数：assets **1495**、wallet_journal 2、lp_balances 6、networth_snapshots 1；my_orders / contracts / industry_jobs / mining_ledger = 0（该角色确实没有，非失败）
- 逐页 ETag：`personal:` 前缀 8 条已生效
- 净值自洽：快照 138,141,810,294.96 = assets 136,715,453,316.04 + wallet 1,426,356,978.92 + 0 + 0 ✓；界面合计 138,139,637,589.2 亦自洽（与快照差约 217 万，为行情/物品正常微小变动）
- 余额交叉：钱包流水最近一条的 `balance` = 当前余额 ✓（ESI 内部自洽）
- **refresh token 实测 48 字节**（远低于 Windows 凭据 2560 字节上限）→ 踩坑 #14 的「超限需分片」风险**闭环消除**
- **CORS 待复核项闭环**：认证端点预检放行 `authorization, if-none-match`，实际 GET 暴露 `Etag/X-Pages/X-Ratelimit-*/X-Esi-Error-Limit-*`，令牌端点预检通过 → **无需 Rust 代理**
- 界面手工验收（**五步全部通过**，点击类用 computer-use 自动化，文字输入人工）：
  - ①「立即同步」→ 角色卡补齐军团 ID / 钱包余额 / 最近同步 ✓
  - ②切页签往返同步不中断（仍「自动同步中」）✓
  - ③暂停显示「已暂停」、恢复后**立即补跑一轮**（钱包余额最近成功推进到 23:46:26；资产因缓存未到期且正确跳过）✓
  - ④「生成今日快照」→ 先点「立即同步」刷新卡片再写快照，界面**净值卡与快照行三项数值严格相等**：净值 `138,161,761,314.6` = 资产 `136,735,404,335.68` + 钱包 `1,426,356,978.92`（卖单/合同 0），与 DB 直读一致；提示语「已写入今日净值快照」✓
  - ⑤「登出并清除本地数据」（二次确认弹窗文案正确）→ 登出成功提示；`characters` / 8 张个人表 / 8 条水位 / `personal:` ETag 8 条 / `networth_snapshots` **全部清零**，钥匙串条目（`refresh-token:2114553827.com.eve-suite.desktop`）消失；**P2/P1 数据零误伤**（`market_orders` 891,667 / `market_stats` 69,722 / `sde_types` 53,060 / `watchlist_items` 1）✓
    - 重新授权（二次授权路径）：授权 URL 参数完整未截断（7 scopes + `redirect_uri=http://127.0.0.1:14565/callback` + state + code_challenge），回环 `127.0.0.1:14565` **重新绑定成功**（OwnerProcess = eve-suite.exe）→ **固定端口「先释放旧监听器再绑同端口」的设计实测生效**（踩坑 #23）
    - 本次 Chrome 的 EVE 登录会话已过期，停在账号密码页需人工登录（字段输入无法自动化，也不应代填）；登录后回调自动完成，应用提示「授权成功：WEEK 813」
    - 授权后**不会自动补跑一轮**，需点「立即同步」或等 20 分钟周期（`start()` 幂等 + `syncNow()` 不更新 `lastRound`）——**该缺陷已在 P3-9 修复**（新增 `kick()`，见下）
- 重新同步等价性（登出 → 二次授权 → 立即同步后）：`corporation_id=98446928` 补齐、钱包 `1,426,356,978.92` 与登出前**一致**、`assets` **1495** 与登出前**一致**、`lp_balances` 6 / `wallet_journal` 2 一致、8 条水位与 `personal:` ETag 8 条**全部重建**；本轮「写入 1,504 条」= assets 1495 + lp 6 + journal 2 + characters 1 ✓
- 快照等价性（重新同步后）：`2026-09-27` 净值 `137,877,416,853.99` = 资产 `136,451,059,875.07` + 钱包 `1,426,356,978.92` ✓（**同日 upsert 只更新不新增**，快照行数恒为 1）
- 游戏内抽查（用户人工比对）：库内读数已提供 —— 钱包余额 `1,426,356,978.92` ISK、妄想级蓝图（Covetor Blueprint）`6` 张（单价 2,178,000,000）、资产 1495 条 / 610 种、LP 6 条、钱包流水 2 条；**用户比对结论待回执**
- **净值会随 P2 枢纽行情每 5 分钟刷新而微动**：本轮观测到资产估值在同一天内出现 `136,735,404,335.68` → `136,451,059,875.07` 级别的漂移，属正常（`best_sell` 变动），故「净值卡 = 快照」需在同一时刻比对

**P3-9 实测记录（2026-09-28，真实库）**：
- 静态：ui `tsc --noEmit` 通过、`pnpm --filter @eve-suite/ui build` 通过；core **219 用例不回归**（P3-9 未改 core）
- ① 手动「立即同步」后角色卡刷新：先点「暂停自动同步」（排除 20 分钟周期轮次干扰）再点「立即同步」，卡片「最近同步」`00:56:25` → `00:57:48`，**未切页签、未重载**；与库内 `last_sync_at = 2026-09-27T16:57:48.562Z` 逐秒吻合（提示语「立即同步完成：写入 0 条」——force 仍带 If-None-Match，ESI 返回 304 故无写入，水位与 `last_sync_at` 照常推进）
- ② 应用级启动：应用停在「数据」页（`已授权角色` 不存在，资产页**从未挂载**）重载后不点任何按钮，库内 `last_sync_at` `17:02:27` → `17:03:16`，即「启动即同步」不再依赖访问资产页
- ③ 角色集合变化补跑：登出清除（`characters` / 8 张个人表 / 水位 / `personal:` ETag 全 0，钥匙串条目消失）→ 二次授权后**未点任何按钮**（全程只点了「授权新角色」），库内 `assets` 1495 / `wallet_journal` 2 / `lp_balances` 6、水位 8 条与 `personal:` ETag 8 条**自动重建**，界面提示「同步完成：1 个角色 · 写入 1,504 条」
- ④ 文案（授权成功提示语）：随 P3-9 一并改的模板字符串，**仅通过静态检查（tsc/构建）验证**；该串只在 `authorize()` 成功那一刻可见，本次未为它重复做一次登出 + 授权
- 回归：暂停 / 恢复；切页签往返（**暂停状态现在跨页签保持**，因 hook 已在 App 级）；「行情」页采集状态正常且未重复初始化（行情采集仍是 App 级单实例，P2 未受影响）
- 核验脚本并发实验：脚本改为 `readOnly: true` 后，在强制同步进行中并发跑 4 次，该轮**未再出现** `database is locked`（单次实验，不足以定论，仍按下方「避开同步写入窗口」执行）

**P3 已确认的决策**：
- **公司资产不纳入 P3**（需额外 scope 与公司角色权限，留到 P5）
- **净值口径**：P3 先用 P2 已有的「吉他最低卖价」，P4 统一切换到估值引擎
- **client_id 已内置**：`packages/core/src/esi/oauth.ts` 的 `EVE_CLIENT_ID`（公开非机密）
- **不使用 client_secret**：走 PKCE；该 secret 曾出现在聊天记录中，建议到 CCP 后台重置，且**严禁写入仓库或安装包**
- OAuth 全流程走渲染进程 fetch（实测 token/verify 端点 CORS 允许，预检通过）——只有「本地回环接收回调」需要 Rust
- **回调地址形态（P3-8 实测修正）**：**必须固定端口**，运行时用 `http://127.0.0.1:14565/callback`，且 **CCP 后台注册的 Callback URL 必须逐字与此一致**（含端口与路径）。EVE SSO **不采纳 RFC 8252 的回环动态端口豁免**，随机端口会被拒 `invalid_request: The redirect URL does not match any of the configured values`。端口常量唯一事实源：`packages/core/src/esi/oauth.ts` 的 `OAUTH_LOOPBACK_PORT = 14565`（改端口需同步改 CCP 后台）
- **scope 拼写以官方 OpenAPI 为唯一准据**：忠诚点读权限是 `esi-characters.read_loyalty.v1`（**不存在** `esi-loyalty.*` 组）。方案文档 §4.3 已同步修正；后台勾选时它在 `esi-characters` 分组下
- **令牌存储口径（P3-2）**：钥匙串只存 refresh token，access token 仅内存；不建角色索引（角色清单归属 P3-4 的 `characters` 表）；登出是否调 SSO revoke 端点留 P3-7
- **同步调度口径（P3-6）**：周期 **20 分钟**（方案 §4.2「15–30 分钟」取中位，构造参数可调）；调度器只做 core 逻辑（纯逻辑可测），UI 生命周期钩子归 **P3-7**；`reauth_required` **停摆**不重试（重试不可能成功）；`force` 供 P3-7「立即同步」按钮越过缓存
- **净值每日快照未纳入 P3-6**（`networth_snapshots` 表已建待填），与资产页一起在 **P3-7** 落地
- **P3-7 口径（已定）**：
  - **净值四分项**：`assets_value` = Σ(数量 × 吉他 `market_stats.best_sell`)；`wallet_balance`；`sell_orders_value` = Σ(未成交**卖单** `volume_remain × price`)；`contracts_value` **恒 0**（合同估值留 P4）；无报价物品按 0 计并计入 `missingPriceTypes`
  - **快照写入时机**：每轮同步**有实际写入**（非 304 / 非缓存命中）时写当日快照，按 **UTC 日期** `(character_id, snapshot_date)` upsert；另提供「生成今日快照」手动按钮
  - **资产展示**：按 `type_id` 聚合（数量合计 / 单价 / 估值 / 地点数），点行展开到逐条（`location_flag` + 站名解析，非空间站则显示地点 id）
  - **调度启动条件**：应用内**仅当已有已授权角色**时才启动（无角色不空转）
  - **登出**：删钥匙串条目 + 清内存会话 + 清该角色全部个人数据与水位（**不可恢复**，UI 二次确认）
  - **共享单例**：本轮只新增 `ui/src/core/runtime.ts` 供个人数据使用；P2 `useMarketCollector` 仍自建调度器，**待后续单独立重构方案**（方案 §4.4 要求全局单例）
- **P3-9 口径（已定）**：
  - **应用级持有**：个人数据与行情采集一致，在**应用壳 App** 层持有 hook 并向下传 props（`<AssetsPage characters={characters} sync={personalSync} />`）；「启动即同步」「角色集合变化补跑」「自动轮次后刷新角色卡」三个副作用统一放 App，`AssetsPage` 只做展示与交互
  - **补跑语义**：`kick()` 在**暂停或调度未启动时忽略**（不越过计量网络暂停开关）；在途轮次由 `PersonalSyncScheduler.runOnce()` 的**单飞**语义复用，不叠轮。首次就绪不补跑（启动那一轮由 `start()` 的「启动即同步」负责）
  - **行为变化**：暂停开关状态现在**跨页签保持**（hook 已上移到 App）；应用启动后不进「资产」页也会同步个人数据

## P4 进度（进行中）

| 子任务 | 状态 | 备注 |
|---|---|---|
| P4-1 估值引擎 | ✅ 完成 | `engines/valuation.ts`（方案 §6.3 唯一定价出口）：口径 `p5_sell`（默认）/`best_sell`；回退链 **主口径 → 另一口径 → missing**；基准可切区域与站点（站点级按 `market_orders.location_id` 重算）；可选 **10 倍中位数离群过滤**；批量入口 `valueItems`。**净值与资产页口径已切换**（`networth.ts` / `assets.ts`），常量 `DEFAULT_VALUATION_REGION_ID` 归属引擎 |
| P4-2 蓝图成本引擎 | ✅ 完成 | `engines/blueprint.ts`：材料 `max(runs, ceil(round2(基础量 × runs × (1 − ME/100))))`（**取整在任务层**、**每 run 至少 1 单位**）、时长 `ceil(基础时长 × runs × (1 − TE/100))`；单价一律走估值引擎（口径/基准/站点/过滤透传）、缺价计 0 并列入 `missingTypeIds`、可选 `includeBlueprintPrice`；支持 6 类活动（`manufacturing` 默认）、多件产出、无产出行与非蓝图容错 |
| P4-3 LP 比价引擎 | ✅ 完成 | `lp/sync.ts` + `lp/repo.ts`（数据源 **ESI 公共端点** `/loyalty/stores/{corp}/offers/`，无需授权）+ `engines/lp.ts`：`netIsk = 产出估值 − 材料成本 − ISK 支出`、`ISK/LP = netIsk ÷ lpCost`；默认跳过 `ak_cost > 0`；`rankLpOffers` / `buildLpPortfolio`（× 真实 LP 余额 → 「每军团换什么、共值多少 ISK」）。新迁移 **0005**（复合主键，见踩坑 #26） |
| P4-4 矿石精炼值引擎 | 未开始 | 需补 SDE 矿石→矿物映射（现导入未含 `typeMaterials`） |
| P4-5 计算器页 + 端到端 | 未开始 | Fuzzworks 对标 + 官网算例对照归档 |

**P4-1 实测记录（2026-09-28，真实库只读核验 + 单测）**：
- 静态：core **219 → 243 用例全绿**（新增 engines 22 条 + 净值口径 2 条；29 个文件）；`tsc --noEmit`（core / ui）通过；`pnpm --filter @eve-suite/ui build` 通过；本轮未动 Rust（`cargo test` 不涉及）
- 真实库只读抽查（角色 `WEEK 813` / 2114553827，610 种资产物品）：**3 个物品的引擎价 = `market_stats.p5_sell` = 订单簿手算 5% 分位，Δ 全为 0**
  | type_id | 物品 | 数量 | 卖单数 | 引擎价（p5） | 最低卖价 | Δ（引擎 vs 手算） |
  |---|---|---|---|---|---|---|
  | 17477 | Covetor Blueprint（妄想级） | 6 | 7 | 2,178,300,000 | 2,178,000,000 | **0** |
  | 999 | — | 7 | 3 | 1,749,100,000 | 1,749,000,000 | **0** |
  | 21010 | — | 9 | 2 | 1,313,050,000 | 1,313,000,000 | **0** |
- 站点级（吉他 4-4 `60003760`）精确路径：引擎 `source='orders'` = 2,178,300,000 = 手算 ✓
- 离群过滤（区域级精确路径，type 999）：原始 3 单 / 中位数 1,750,000,000 / 上限 17,500,000,000 → **无剔除**，引擎 = 手算 1,749,100,000 ✓
- **净值口径切换**（old `best_sell` → new `p5_sell`）：`137,562,301,572.56` → `137,809,388,643.50`，**+247,087,070.94 ISK（+0.18%）**；资产分项 `136,162,725,782.64` → `136,409,812,853.58`；无报价 **19 / 610** 种
- 快照：现存 `2026-09-27` 快照为**旧口径**值 `137,562,106,074.08`（P4-1 未回填历史）；同日再次「生成今日快照」会按新口径**覆盖该行**（upsert 不新增），跨日自动切新口径
- 核验方式：临时只读用例（`readOnly: true` 打开运行库，直接调用引擎 API 与手算比对），跑完已删除，未入库；该步核验期间未运行应用
- **界面复核（真机 `pnpm tauri dev`，`eve-suite.exe` 为 debug 构建）**：界面资产页数值与库内只读直算**逐项一致**
  | 项目 | 界面 | 库内直算 |
  |---|---|---|
  | 合计净值 | 137,809,388,643.5 | 137,809,388,643.50403 |
  | 资产估值 | 136,409,812,853.58 | 136,409,812,853.58401 |
  | 钱包余额 | 1,399,575,789.92 | 1,399,575,789.92 |
  | 未成交卖单 / 合同 | 0 / 0 | 0 / 0 |
  | 提示行 | 共 610 种物品，其中 19 种在吉他无报价 | 610 种 / 19 种缺失 |
  - 资产表前 4 行（单价 / 估值）全部一致：妄想级蓝图 6×2,178,300,000=13,069,800,000；多米尼克斯级蓝图 7×1,749,100,000=12,243,700,000；旗舰推进引擎蓝图 9×1,313,050,000=11,817,450,000；旗舰附甲蓝图 6×1,356,050,000=8,136,300,000
  - 展开明细（`getAssetDetails`）一致：妄想级蓝图 → 物品 `1007840889518` / 地点 `1032824096378` / `AutoFit` / 数量 1 / 估值 2,178,300,000（库内该物品 6 行各 1 个、同地点，与概览「数量 6 / 地点数 1」自洽）
  - UI 自动化要点：WebView 内容以 `foreign_child_window`（`msedgewebview2.exe`）呈现，**点击用该子窗口 pid + element_id 生效**（本次实测），长页面下方节点不入自动化树（需滚动后重取）
- **第三方口径对照（A7，2026-09-28）**：对照源为 **Fuzzwork 公开聚合接口**（`market.fuzzwork.co.uk/aggregates`；ISK.GG 无公开 API，未取数），吉他 10000002、6 个物品（17477 / 999 / 21010 / 21018 / 995 / 997）
  - **订单簿数据一致**：我方 `market_stats.best_sell` = 其 `sell.min`、订单数 = `sell.orderCount`，**6/6 逐项吻合**（说明双方看到的是同一订单簿快照）
  - **差异在口径定义**：其 `sell.percentile` = **成交量加权**的 5% 分位；本地按该定义复算，**6/6 与其输出完全相同**；而我方 `p5_sell`（P2 起）是**按订单数线性插值**的 5% 分位 → 差额为「最小价位档内的小数」，本例 **+0.004% ~ +0.014%**（+5 万 ~ +30 万 ISK）
  - 结论：**数据一致、差异纯口径**，对净值影响可忽略（万分之几）；是否新增「成交量加权」口径留作 P5 评估（引擎 `basis` 已是可扩展的枚举）

**P4-1 口径（已定）**：
- **唯一定价出口**：净值 / 资产页（含后续缺口分析、LP 排名、采矿时薪）统一走 `engines/valuation.ts`，其它模块**不得**自行拼价格
- **5% 分位定义 = 按订单数线性插值**（P2 起沿用；Fuzzwork 用**成交量加权**口径，差异仅万分之几，已在 A7 逐项复核，见实测记录）
- **双路径**：批量（资产/净值）走 `market_stats` 快路径（零重算）；`stationId` 指定或 `filterOutliers: true` 时走订单簿重算
- **离群过滤默认关闭**（仅单物品精确估值显式开启）。若要「全站默认开启」，正确落点是 **P2 采集器算 `p5_sell` 时过滤** → 需另开方案（涉及已验收代码）
- **站点级无订单不回退区域价**（基准是显式指定的）；区域级精确重算无样本时回退聚合快路径（`source='stats'`）
- **卖单估值维持 P3 语义**（`volume_remain × 挂单价`）；`contractsValue` 仍记 0（合同估值留 P5）
- 观测：5% 分位普遍略高于最低卖价（样本充足时差值约为最小价位档），故净值小幅上升，口径变化可解释
- 已知特性（已固化用例）：订单簿稀疏时（样本 ≤ 3）**1 ISK 钓鱼单仍会显著拉低分位**——低侧操纵不属 10 倍中位数规则的覆盖范围，留待 P5 评估（如加样本量下限或低侧规则）

**P4-2 实测记录（2026-09-28，真实库只读 + Fuzzwork 对照 + 单测）**：
- 静态：core **243 → 264 用例全绿**（新增 blueprint 21 条；30 个文件）；`tsc --noEmit`（core / ui）与 `ui build` 通过；未动 Rust；**未新增迁移**（只用 P1 已入库的 `sde_blueprints` / `sde_blueprint_activities` / `sde_blueprint_io`）
- **A4 与 Fuzzwork 零误差**（对照源 `https://www.fuzzwork.co.uk/blueprint/api/blueprint.php?typeid=<id>`；临时只读用例，跑完已删）
  | 蓝图 | 基础材料 | 产物 | 制造时长 | run 上限 |
  |---|---|---|---|---|
  | 803（弹药，一次产出 100 件） | 4 种 = 4 ✓ | 202 ×100 ✓ | 900 ✓ | 200 ✓ |
  | 17477（妄想级） | 7 种 = 7 ✓ | 17476 ×1 ✓ | 12,000 ✓ | 10 ✓ |
  | 688（含小基础量材料样本） | 10 种 = 10 ✓ | 638 ×1 ✓ | 18,000 ✓ | 10 ✓ |
  （材料按 `type_id` + 数量**逐项全等**断言，非抽样；`max_production_limit` 亦逐项相符）
- 真实库成本样例（吉他 5% 分位；临时脚本输出）：
  - `803` runs1/ME0：材料成本 **27,690.664**（三钛 3,084@3.745、类晶体胶矿 472@17.1995 …）；总产出 100；runs5/ME10 材料 **124,607.988** → 单位成本 ≈ 10,249.2
  - `17477` runs1/ME0：材料 **37,488,210** + 蓝图价 2,178,300,000 = **2,215,788,210**；runs5/ME10 材料 **168,696,945**（= 37,488,210 × 5 × 0.9 ✓ 与公式自洽）
  - 三个样本的制造材料**全部有报价**（`missingTypeIds` 为空）
- 关键数据事实（P4-5 计算器页要用）：SDE 活动计数 manufacturing 4872 / research_material 4343 / research_time 4343 / copying 4343 / invention 1117 / reaction 120；**368 个蓝图一次产出 >1 件**；**23 个蓝图有制造活动但无产出行**（引擎返回 `product: null` 而非抛错）

**P4-2 口径（已定）**：
- **公式来源**：EVE University 官方帮助「材料效率研究」（取整发生在**整个项目**层面、**每 run 至少 1 单位**）+ Qoi《Formulas for EVE Industry》`max(runs, ceil(round2(runs × 基础量 × modifier)))`；`modifier = 1 − ME/100`（NPC 站 1.0，**不含建筑/安全/团队系数**）
- **明确不做**（留 P5）：工业任务安装费（系统成本指数 / 设施税 / SCC 附加费）、递归展开到基础原料、发明成功率与解密器、技能对时长的影响（当前时长仅含 TE）
- **Fuzzwork 蓝图 API 只返回基础量**（实测忽略 `runs` / `me` / `te` 参数）→ 折扣公式由官方/社区公式 + fixture 手算锁死，基础量 / 产物 / 时长 / run 上限用 API 程序化零误差对照
- 多产出取「产出量最大的一行」为主产物（当前 SDE 制造活动只有 1 行，此处仅为稳健）
- `includeBlueprintPrice` **默认关**；开启时计入**蓝图本体（BPO）**价格——BPC 无市场报价，故该开关只对 BPO 有意义

**P4-3 实测记录（2026-09-28，真实库副本 + 真实 ESI + 单测）**：
- 静态：core **264 → 283 用例全绿**（新增 sync 8 + 引擎 11；32 个文件）；`tsc --noEmit`（core / ui）与 `ui build` 通过；未动 Rust
- **迁移 v4 → v5**（用 `VACUUM INTO` 生成真实库**一致副本**后迁移，**不触碰运行库**）：`applied=1`、`schemaVersion=5`；`market_orders` **890,852** / `sde_types` **53,060** / `assets` **1,495** / `lp_balances` **6** **行数全部不变**
- **真实抓取**（6 个有 LP 余额的军团，走 ESI 公共端点）：offer 数 **310 / 310 / 319 / 234 / 102 / 310**；**库内条数 = ESI 直读条数**（逐条 `offer_id` 集合相等断言通过，逐军团核对）
- **LP 组合（真实数据 + 真实 LP 余额）**：
  | 军团 | 可用 LP | 最优 offer | ISK/LP | 全部 LP 净收益 |
  |---|---|---|---|---|
  | 1000125 | 192,938 | 15343 | 6,500.00 | **1,254,097,000** |
  | 1000120 | 5,189 | 3655 | 3,891.11 | 20,190,981 |
  | 1000130 | 1,439 | 4426 | 3,066.67 | 4,412,933 |
  | 1000035 | 627 | 4180 | 3,398.80 | 2,131,048 |
  | 1000041 | 61 | 4180 | 3,398.80 | 207,327 |
  | 1000167 | 36 | 4180 | 3,398.80 | 122,357 |
  | **合计** | | | | **1,281,161,645 ISK** |
- 手算校验（零误差样例）：offer **4180**（type 27086 ×1、LP 375、ISK 375,000、无材料）= (1,649,550 − 375,000) ÷ 375 = **3,398.8** ✓
- **真实数据暴露的设计缺陷（已修）**：`offer_id` **在不同军团间重复**（1000035/1000041/1000167 返回同一批 offer_id）→ 原「offer_id 单列主键」触发 `UNIQUE constraint failed`；改为主键 `(corporation_id, offer_id)`（迁移未提交前修正，见踩坑 #26），并加回归用例
- **A4 Fuzzwork 对照：无法程序化取数**（其 LP 页是 JS 表单 + 免责确认，`/lpstore/api/lpstore.php` 返回 File not found；无公开 LP API）→ 按确认的方案改为**人工核对清单**（上表 offer 与 ISK/LP 可逐条核对）。其页面同时明示 **"Prices are as per a simulated 5% buy from the Jita market"**，即默认价格口径为 **Jita 5% 分位**，与本项目默认口径一致
- ⚠️ **已知口径差异（待你决定，未实现）**：Fuzzwork 对**蓝图类产出**按「生产技能 PE5 的材料成本」估算其价值；本项目对**无市场报价的产出**（含 BPC）返回 `iskPerLp = null`（不虚构估值）→ 这类 offer 目前不参与排名。若要覆盖，需引入「蓝图成本估值 + ME/PE 假设」，属引擎扩展，**建议单独立项确认**

**P4-3 口径（已定）**：
- **数据源 = ESI 公共端点** `GET /loyalty/stores/{corporation_id}/offers/`（无需授权）——方案 §4.2 的「社区 GitHub JSON」**作废**（该端点已公开，官方数据优于第三方）
- **抓取范围**：默认只抓**角色有 LP 余额的军团**（`lp_balances`）；支持指定军团 id
- **公式**：`netIsk = 产出估值 − 材料成本 − ISK 支出`；`ISK/LP = netIsk ÷ lpCost`；`lpCost = 0` 或产出无报价时 **null**（不除零、不假装有值）
- **`ak_cost > 0`（CONCORD LP）默认跳过**并在结果中计数（`skippedAkOffers`），可显式纳入
- **表命名**：`lp_offers` / `lp_offer_items` / `lp_store_state`（**不带 `sde_` 前缀**——来源是 ESI 而非 SDE，方案 §5 的 `sde_lp_offers` 是历史假设）
- **写入语义**：每军团**整体替换**（单事务先删后插）；失败隔离——单军团失败只写该行 `last_error`，`last_ok_at` 与既有报价不动
- **新鲜度**：`max(服务端 Cache-Control/Expires 声明, 本地 24h TTL)`——既严格不早于服务端缓存回源（方案 §9 CCP 合规），又减少低频数据请求；到期后靠 ETag 条件请求（304 即零流量）；`force` 可越过
- **调度优先级**：`ondemand`（按需刷新）

## 数据库现状

- schema 版本：**v5**（v1 settings + v2 SDE 11 表 + v3 行情 7 表 + v4 个人数据 10 表 + v5 LP 商店 3 表）
- 迁移文件：`0001-settings` `0002-sde-tables` `0003-market-tables` `0004-personal-tables` `0005-lp-tables`（**已发布，禁止修改，只能新增**）
- v5 LP 表：`lp_offers`（主键 `(corporation_id, offer_id)`）`lp_offer_items` `lp_store_state`；真实库副本 v4→v5 迁移实测通过（行数不变）
- **运行库当前仍为 v4**（P4-3 只在**副本**上跑了迁移；下次启动应用会自动升到 **v5** 并建 3 张 LP 表——属正常路径，已由迁移执行器幂等保证）
- v4 个人数据表：`characters` `assets` `wallet_journal` `my_orders` `contracts` `industry_jobs` `mining_ledger` `lp_balances` `networth_snapshots` `personal_sync_state`（字段按官方 **OpenAPI 3.1** 逐端点核对）
- 真实运行库升级实测：v3 → v4 应用 1 个迁移，`market_orders` 890,552 行与 `sde_types` 53,060 行**行数不变**，10 张新表就位，库内 `idx_` 索引 28 个
- 运行库位置：`%APPDATA%\com.eve-suite.desktop\eve-suite.db`（WAL）
- SDE 缓存：`%APPDATA%\com.eve-suite.desktop\sde-cache\`（11 个 JSONL，约 160MB）
- 实测入库（SDE build 3542233）：types 53,060 / stations 5,210 / blueprints 5,082 / 配方材料 42,830
- 实测采集（真实行情）：**5 枢纽 890,701 条订单**（伏尔戈 403,514 / 多美 182,019 / 美特伯里斯 119,361 / 西玛特尔 71,330 / 金纳泽 114,477），聚合出 56,347+ 条 market_stats；Tritanium 实测 吉他 卖 3.69 / 买 3.70 / 5% 分位 3.762
- 测试：core **283 用例全绿**（32 个文件；P4-1 新增 24、P4-2 新增 21、P4-3 新增 19）；Rust **12 用例全绿**（另有 1 个 `#[ignore]` 真钥匙串往返自检，用 `cargo test -- --ignored --nocapture` 手动跑）
- UI：`pnpm --filter @eve-suite/ui build` 通过（tsc + vite）；P3-8 **界面五步验收全部通过**（①立即同步 ②切页签不中断 ③暂停/恢复 ④生成今日快照 ⑤登出清除 + 二次授权 + 重新同步）；P4-1 更新资产页口径文案并**做了真机界面复核**（净值卡 / 资产表前 4 行 / 展开明细与库内直算逐项一致，见 P4-1 实测记录）
- P4-1 / P4-2 **未新增迁移**（当时 schema 仍 v4）；**P4-3 新增迁移 0005**（LP 商店 3 表，schema → v5）：估值/蓝图引擎只读既有 `market_stats` / `market_orders` / `sde_blueprints*`，LP 引擎只读 `lp_*` 与 `lp_balances`
- P3-8 收尾后的库态（登出清空 → 二次授权 → 重新同步恢复）：`characters` 1 / `assets` 1495 / `wallet_journal` 2 / `lp_balances` 6 / `networth_snapshots` 1 / 水位 8 条 / `personal:` ETag 8 条
- 机密存储：OAuth 刷新令牌存**系统钥匙串**（服务名 `com.eve-suite.desktop`），**数据库零令牌字段**（v5 亦不含任何令牌列；LP 商店为公共数据，无需授权）

## 下一步

1. **P4-4 矿石精炼值引擎**（下一子任务）：矿石精炼产值 = Σ(矿物量 × 引擎价) − 损耗/税（方案 §6.1 计算器 / §6.2 采矿时薪）。需要：**补 SDE 矿石→矿物映射**（现 SDE 导入只含 11 个 JSONL，未含 `typeMaterials`；需扩导入或另辟数据源）+ 精炼产出率（`sde_types.portion_size` 已入库，矿石通常 100）+ 站/建筑税率参数。**开工前先出「任务清单 + 验收清单」交用户确认。** 之后 P4-5（计算器页 + 与 Fuzzworks 算例端到端对照归档）。
2. **待推送**：本地有数个提交未推送（起点 `9130776` → `6d3c6b1`）；推送时机由用户掌控（推送后 CI 才会跑）
3. 已知待办（非阻塞；凡涉及改动已有代码，均需先出方案并确认）：
   - **P2 行情采集未用共享调度器**（方案 §4.4 要求全局令牌桶单例）：`packages/ui/src/market/useMarketCollector.ts` 自建 `RequestScheduler`，与 P3 新增的 `ui/src/core/runtime.ts` 未统一
   - **core 数据库层对瞬时锁的容错**：连接池 + 外部进程并发时曾观测到该轮同步因 `SQLITE_BUSY`（`database is locked`）整轮失败；根治需评估 `BEGIN IMMEDIATE` / BUSY 重试，属独立议题（P3-9 只把核验脚本改为只读打开，未动 core）
   - 登出是否调 SSO revoke 端点（当前只删本地令牌与数据）
   - **估值分位口径是否对齐第三方**：当前 `p5_sell` = 按订单数线性插值；ISK.GG/Fuzzwork 用**成交量加权**（A7 实测差异 +0.004%~+0.014%，数据本身一致）。若要新增「成交量加权」口径，属引擎 + P2 采集侧扩展，**需先出方案**
   - **LP offer 的 BPC 类产出估值**：Fuzzwork 对「产出为蓝图」的 offer 按 **PE5 材料成本**估算价值；本项目对无市场报价产出返回 `iskPerLp = null`（不虚构）→ 这类 offer 暂不参与排名。若要覆盖，需引入「蓝图成本估值 + ME/PE 假设」，属引擎扩展，**需先出方案**

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
   - 补充（P3-8 用 computer-use 实测）：**纯点击/读状态的 UI 验收可以自动化**。要点：① WebView 内容会**合并到主进程 `eve-suite.exe` 的树里**（`document ... val="http://localhost:1420/"`），点按钮要用**主进程 pid + element_id**；用 `msedgewebview2.exe` 的 pid 点击**不生效**。② 元素 id 每次重取全量树（`disableDiff: true`）会变，需现取现用，不要跨观察缓存。③ 对 Tauri 窗口先 `perform_action { action: "set_focus" }` 更稳（尤其游戏占焦点时）。
   - 补充 2（P4-1 界面复核实测，2026-09-28）：**树形态会变**——本次 WebView 内容出现在 `<foreign_child_window>`（`msedgewebview2.exe` pid，带 `windowId`）下，主进程树里只有无名容器 pane（无按钮/表格）。此时**用该子窗口 pid + element_id 点击生效**（实测点「资产」成功切页并读到数值）。两处补充不矛盾，判据是**节点出现在哪个 pid 的树里就用哪个 pid**。另：**长页面视口外的节点不入自动化树**（资产页下方表格/明细需先 `scroll` 再重取全量树）。
11. **dev 启动失败先查端口 1420**：上一次未完全退出的 vite 会占用端口（`Stop-Process` 按占用进程清理）。
12. **【易静默失效】`keyring` 每个平台必须「恰好启用一个」后端**：只有在「该平台适用的后端恰好一个」时才会启用它；启用多个（或零个）会**静默回落 mock 存储**（内存态、跨进程不持久）→ 症状是「测试全绿，但重启应用后令牌凭空消失」。
   - 核验手段：`cargo tree -p keyring --depth 1` 应只出现该平台的后端依赖（Windows = `windows-sys`/`byteorder`/`zeroize`）；若同时出现 `dbus-secret-service`、`linux-keyutils`，说明配置有问题。
   - 注意：keyring 的后端依赖是**按 target 门控**的，一份 `features = ["apple-native","windows-native","sync-secret-service"]` 可跨三平台构建，不会在 Windows 上误编译 dbus。
13. **Linux 编译 `sync-secret-service` 需系统 `libdbus-1-dev`**（已加入 CI 的 apt 安装列表）。若仍失败，回退顺序：① `keyring` 的 `vendored` feature（源码编译 libdbus，需 build-essential）→ ② `async-secret-service`（zbus 纯 Rust，无 C 依赖）。
   - **已实测**：首轮推送（提交 `9130776`）的 CI run `36322411890` 中 ubuntu-22.04 构建通过，**无需回退**。
14. **Windows 凭据管理器条目名 = `{account}.{service}`**（实测 `refresh-token:2114553827.com.eve-suite.desktop`），故账号名带 `:` 不影响识别。
   - **token 长度风险已闭环**：P3-8 实测 refresh token **48 字节**，远低于 Windows 单条凭据 2560 字节上限 → **无需分片存储**。若将来换用更长的令牌（如 JWT 化），再复核此上限。
15. **认证错误的错误契约（P3-3 定，勿破坏）**：`TokenManagerError`（如 `reauth_required`）由 `EsiClient` **原样抛出**，**不包装成 `EsiError`**。
   - 原因：`RequestScheduler` 只重试 `EsiError` 且要求 `retryable === true`；若把「刷新令牌失效 / 需重新授权」包成可重试错误，会变成永远失败的无限重试。
   - 推论：认证类失败**不会被调度器自动重试**。若日后希望「刷新时网络抖动」也能重试，需在 P3-6 的同步任务层单独处理。
   - 令牌端点错误已结构化：`oauth.ts` 的 `TokenRequestError` 带 `status` 与 `oauthError`（如 `invalid_grant`），**不要再用字符串匹配 HTTP 文本**来区分失败原因。
16. **401 只重试一次**：`EsiClient` 收到 401 会调用 `auth.invalidate()` 丢弃内存访问令牌并重发**一次**；再次 401 直接报错（避免死循环）。
17. **ESI 规格获取方式已变（2026-08-11 起）**：Swagger 全线下线，`https://esi.evetech.net/latest/swagger.json` 与 `/_latest/swagger.json` 均 404。
   - 现只有 **OpenAPI 3.1**：`https://esi.evetech.net/meta/openapi.json`（**只支持 GET，HEAD 返回 405**，别误判为不存在）。
   - **路径不再带尾斜杠**：官方规格写 `/characters/{character_id}/assets`（旧文档的 `/assets/` 已不是规范写法）；P2 用尾斜杠能通是 ESI 的兼容行为，新代码统一按规格写。
   - 响应 schema 是 **数组包装**：字段在 `components.schemas.<名字>.items.properties`，不在顶层。
   - `/characters/{character_id}/wallet` 返回**单个数字**（ISK 余额），不是对象。
18. **`market_etag_cache` 是通用逐页 ETag KV（P3-5 起跨模块复用）**：`scope` 为自由文本键——P2 行情用 `orders:...` / `history:...`，P3 个人数据用 `personal:<characterId>:<scope>:<页>`。表名虽带 market，但**不要**为个人数据另建 ETag 表；而 `personal_sync_state.etag` 只存单请求端点（wallet_balance）的 ETag，分页端点该列为空、水位页数在 `pages`。
   - 个人数据端点的运行时路径沿用 client 既有的**尾斜杠风格**（与 P2 一致），8 端点已实测（未认证 401）可通——踩坑 #17 的「无尾斜杠」是对官方规格文档而言，运行时两种写法 ESI 都接受。
19. **【易漏】ESI 的到期时间多数走 `Expires` 而非 `max-age`（2026-09-27 实测）**：只解析 `Cache-Control: max-age` 会漏掉大部分端点。
   | 端点 | 实测响应头 |
   |---|---|
   | `/status/` | `public, max-age=30, must-revalidate, stale-if-error=900` |
   | `/markets/{region}/orders/` | `public`（**无 max-age**）+ `Expires: <now+约3分钟>`（5 分钟缓存边界，剩余量随机） |
   | `/markets/{region}/history/` | `public`（**无 max-age**）+ `Expires: <次日>` |
   | `/characters/{id}/` | `public, max-age=86400, must-revalidate, stale-if-error=900` |
   - 对策：`parseCacheControl` 同时解析 `Cache-Control` 与 `Expires`（`expiresAtMs`）；`computeExpiresAt` 优先级 **no-store → max-age → Expires**（RFC 7234），**已过去的时刻记 null**（不把过期时间写进水位）。
   - 推论：判断「是否需要回源」不能只看 `max-age`；忽略 `Expires` 会让所有行情/个人数据端点退化成每轮都请求。
20. **逻辑层与运行时绑定层必须成对交付**：P3-1 交付了 OAuth 流程（`runOAuthFlow` 等）却**没写渲染进程的 `TokenHttp` 实现**（`postForm`），测试里全是 fake，直到 P3-7 接线时才补上 `createFetchTokenHttp()`——期间「能否真正换到令牌」无法验证。
   - 对策：新增「纯逻辑 + 宿主能力」分离的模块时，**同阶段必须交付一个真实绑定实现**（对照 `db/tauri.ts`、`esi/tauri-oauth.ts` 的做法），否则该能力的可用性一直悬空。
21. **【致命，P3-8 实测】Windows 打开授权 URL 严禁走 `cmd /C start`**：`cmd` 会把 URL 里的 `&` 当**命令分隔符**截断、`%` 当**变量展开** → 浏览器只收到 `https://login.eveonline.com/v2/oauth/authorize?response_type=code`，SSO 报 `invalid_request: client_id is required`（看似「参数没传」，实为 URL 被 shell 吃掉）。
   - 对策：Windows 用 `rundll32 url.dll,FileProtocolHandler <url>`（`CreateProcess` 直接传 argv，绕过 shell）；macOS/Linux 用 `open` / `xdg-open`。已抽 `browser_command()` 并加回归测试断言「URL 是单个未修改参数」。
   - 通用教训：**任何把外部字符串交给 shell 的地方都要审**；CSP/URL/路径带 `&`、`%`、`^` 时尤其危险。
22. **【易错，P3-8 实测】scope 名字必须对官方 OpenAPI 核对，别照抄文档**：`esi-loyalty.read_loyalty_points.v1` **不存在**，正确是 `esi-characters.read_loyalty.v1`（忠诚点端点 `/characters/{id}/loyalty/points/` 归属 `esi-characters` 分组）。写错时 SSO 只在授权页报 `invalid_scope: The requested '...' scope is not valid.`，**其它 6 个 scope 都会照常通过**——极易误导成「后台没勾选」。
   - 对策：scope 清单以 `https://esi.evetech.net/meta/openapi.json` 里的 `esi-*` 全集为唯一准据（踩坑 #17 同源）。方案文档 §4.3 已修正。
23. **【关键，P3-8 实测】EVE SSO 要求回调地址「逐字精确匹配」，不支持回环动态端口**：按 RFC 8252 用随机端口会报 `invalid_request: The redirect URL does not match any of the configured values for this client.`（`127.0.0.1` ≠ `127.0.0.1:55408`）。
   - 对策：**固定端口**（本项目 `14565`，常量 `OAUTH_LOOPBACK_PORT`），且 CCP 后台 Callback URL 必须逐字为 `http://127.0.0.1:14565/callback`。改端口 → 必须同步改后台。
   - 连带设计：固定端口意味着**重新授权必须先释放旧监听器**再绑同一端口（`oauth.rs` 拆成「回调通道」+「监听中止句柄」两个状态，`AddrInUse` 时短暂重试）；`wait_callback` 超时/取消也要中止监听器，否则下次绑不上。
24. **【易误判，P4-1 实测】「过滤后样本为空」在数学上不可能发生**：离群阈值为 `中位数 × 倍数`，而中位数本身必 ≤ 该阈值（倍数为正），故过滤**永远**至少留下一个样本；即便偶/奇样本量不同也成立（中位数取中间值或两中值插值）。
   - 推论：`filterOutliers` 路径**只能**因「该物品在订单簿里已无卖单」而为空（例如区域快照被替换）。据此把「精确重算无样本」统一作为回退条件即可，**不要**写「过滤可能清空样本」的分支或用例（写了也永远走不到，属假防护）。
   - 连带口径：10 倍中位数规则只作用于**高侧**离群（低侧 1 ISK 钓鱼单不在其覆盖范围）→ 稀疏订单簿下 5% 分位仍可能被拉低，已在 `valuation.test.ts` 固化为已知特性。
25. **【易错，P4-2 实测】SQL 保留字不能直接作列别名**：`SELECT max_production_limit AS limit ...` 直接报 `near "limit": syntax error`（`limit` 是关键字），改用 `AS maxLimit` 即通。
   - 通用教训：列别名避开 SQL 关键字（`limit` / `order` / `group` / `index` / `key` / `range` 等）；本项目 core 内统一用驼峰业务名（如 `maxLimit` / `baseQuantity`），不要照搬列名英文单词。
   - 备注：`market_orders` 表本身有 `range` 列（建表时未加引号也能建），但**查询里做别名/表达式时更易踩到**，新增 SQL 时注意。
26. **【致命，P4-3 真实数据实测】`offer_id` 在不同 NPC 军团之间会重复**：LP 商店的 offer_id 是**军团内**编号，多个军团（实测 1000035 / 1000041 / 1000167）返回同一批 offer_id → 用 `offer_id` 单列主键会立刻 `UNIQUE constraint failed: lp_offers.offer_id`（单测全绿也测不出，因为 fixture 只用了单军团数据）。
   - 对策：`lp_offers` 主键 = **`(corporation_id, offer_id)`**，`lp_offer_items` 主键 = `(corporation_id, offer_id, type_id)`；整体替换按 `corporation_id` 直接删除即可（无需子查询）。已加回归用例「同一 offer_id 在不同军团可共存」。
   - 通用教训：**第三方/官方数据的「ID」先确认作用域**（全局唯一 / 军团内唯一 / 区域内唯一）；跨作用域复用 ID 的字段一律进复合主键。同类风险点：`market_orders.order_id`（实测全局唯一，暂无需改）。
   - 另一条工程经验：**真实数据核验能抓住单测抓不到的作用域缺陷**——本次若只跑单测（fixture 单军团）会全绿放行。

## 关键文件地图

| 关注点 | 文件 |
|---|---|
| UI 入口 / 导航 / **应用级持有**（行情采集 + 个人数据 hook，P3-9） | `packages/ui/src/App.tsx` |
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
| OAuth 逻辑 / 授权流程编排 | `packages/core/src/esi/oauth.ts`、`esi/oauth-flow.ts` |
| OAuth 运行时绑定（回环 / 钥匙串） | `packages/core/src/esi/tauri-oauth.ts`、`esi/tauri-secrets.ts` |
| 机密存储契约 / 令牌存储 | `packages/core/src/esi/secret-store.ts` |
| 访问令牌管理（Bearer 注入点） | `packages/core/src/esi/token-manager.ts` |
| OAuth 回环服务（Rust） | `src-tauri/src/oauth.rs` |
| 系统钥匙串（Rust） | `src-tauri/src/secrets.rs` |
| 行情采集 / 统计 / 按需 / 监视 | `packages/core/src/market/` |
| **估值引擎（P4-1 唯一定价出口）** | `packages/core/src/engines/valuation.ts`（出口 `engines/index.ts`） |
| **蓝图成本引擎（P4-2）** | `packages/core/src/engines/blueprint.ts`（BOM / ME-TE 折扣 / 成本编排） |
| **LP 比价引擎（P4-3）** | `packages/core/src/engines/lp.ts`（ISK/LP 排名 / LP 组合） |
| **LP 商店同步与仓储（P4-3）** | `packages/core/src/lp/sync.ts`、`lp/repo.ts`（ESI 公共端点 + ETag/TTL + 整团替换） |
| 迁移 0005（LP 三表） | `packages/core/src/db/migrations/0005-lp-tables.ts` |
| 个人数据同步（P3-5） | `packages/core/src/personal/`（scopes / rows / state / sync）+ `esi/paging.ts` |
| 个人数据调度（P3-6） | `packages/core/src/personal/scheduler.ts`、`personal/repo.ts`；缓存解析在 `esi/client.ts` 的 `parseCacheControl` |
| UI：资产页 / 授权 / 同步 Hook | `packages/ui/src/personal/`（AssetsPage.tsx、useCharacters.ts、usePersonalSync.ts） |
| UI：core 运行时单例（共享调度器 + 令牌） | `packages/ui/src/core/runtime.ts` |
| 净值 / 资产查询（口径走估值引擎） | `packages/core/src/personal/networth.ts`、`personal/assets.ts` |
| Tauri 壳（命令注册） | `src-tauri/src/lib.rs` |
| CI workflow | `.github/workflows/build.yml` |
| 方案（唯一事实来源） | `EVE 工具套件 · 单机桌面版完整开发方案.md` |

## 本机环境（已验证）

node v25.2.1 · pnpm 11.7.0 · rustc/cargo 1.98.1（项目要求 ≥ 1.85）· git 2.55.0（Windows）· 屏幕 2560×1440 @150%

**CCP 开发者应用（EVE SSO）配置**：
- `client_id` = `f08a568e43694797ac48637012682c1a`（已内置在 `packages/core/src/esi/oauth.ts` 的 `EVE_CLIENT_ID`）
- **Callback URL 必须逐字为 `http://127.0.0.1:14565/callback`**，Scopes 需勾选全部 7 个（含 `esi-characters.read_loyalty.v1`，在 esi-characters 分组下）
- 该应用**不使用 client_secret**（走 PKCE）；后台的 secret 曾泄露在聊天记录中，建议重置且严禁入库

**只读核验脚本**（不在仓库内，位于系统临时目录，重装系统/清临时目录后需重建）：
- `%TEMP%\eve-verify-p38.cjs` —— P3 用：用 `node:sqlite` 直读 `%APPDATA%\com.eve-suite.desktop\eve-suite.db`，输出 schema 版本 / characters 行 / 8 张个人表行数 / `personal_sync_state` 水位 / `personal:` ETag 数 / `networth_snapshots` / 按 core 同口径现算的净值 / 资产 Top10（含 SDE 中英文名）/ 钱包账本最近 5 条
- `%TEMP%\eve-verify-p41.cjs` —— **P4-1 用（估值口径）**：按引擎同口径（`p5_sell` → `best_sell` 回退）现算资产估值 / 净值四分项 / 资产估值 Top6（含中文名），用于与界面资产页逐项对照
- `%TEMP%\eve-verify-a7.cjs` —— **A7 用（第三方口径对照）**：对指定 type 列表同时按「订单数插值 5% 分位」（core 口径）与「成交量加权 5% 分位」（ISK.GG/Fuzzwork 口径）复算，便于与 Fuzzwork 聚合接口逐项比对
- 运行：`node "$env:TEMP\eve-verify-p41.cjs"`（应用运行中亦可）
- **注意（P3-9 实测修正）**：此前「WAL 只读无冲突」的说法不严谨——脚本当时是**读写打开**（`new DatabaseSync(path)` 默认读写），与应用的写事务并发时曾导致该轮同步 `database is locked`（`SQLITE_BUSY`）整轮失败；现已改为 **`readOnly: true` 打开**，并在同步进行中并发 4 次未复现。**仍建议避开同步写入窗口运行**（正在同步时先别跑）
- 注意：`node:sqlite` 是实验特性，会打印 ExperimentalWarning，可忽略

**第三方对照接口（验收用，无需 key）**：
- **蓝图基础量**：`https://www.fuzzwork.co.uk/blueprint/api/blueprint.php?typeid=<id>` → `activityMaterials`（按活动 ID：1=制造 / 3=TE 研究 / 4=ME 研究 / 5=复制 / 8=发明）、`blueprintDetails`（产物 / `times` / `maxProductionLimit`）。**只返回基础量**（实测忽略 `runs` / `me` / `te` 参数）
- **聚合行情**：`https://market.fuzzwork.co.uk/aggregates/?region=<regionId>&types=<逗号分隔 id>` → `sell.min/median/percentile/volume/orderCount`（`percentile` = **成交量加权** 5% 分位，见 A7 对照）
- **LP 商店（P4-3）**：Fuzzwork 的 LP 页（`https://www.fuzzwork.co.uk/lpstore/`）**无公开 API**（JS 表单 + 免责确认；`/lpstore/api/lpstore.php` 404）→ 对照需人工核对。其页面口径说明：默认 **"Prices are as per a simulated 5% buy from the Jita market"**（= Jita 5% 分位，与本项目默认一致）；**蓝图类产出按 PE5 材料成本估值**（本项目未实现，见「下一步 · 已知待办」）
- **LP 商店权威数据源**：ESI 公共端点 `https://esi.evetech.net/latest/loyalty/stores/{corporation_id}/offers/`（无需授权）

## 会话纪要（2026-09-28）

> 仅供追溯「该会话做了什么」；**权威事实以上半部分各节为准**（接续入口 / 总览 / P3 明细 / 核验记录 / 决策 / 下一步），本节不重复维护细节。

**该会话完成三件事**

| # | 事项 | 结果 | 提交 |
|---|---|---|---|
| 1 | P3-8 收尾：界面步骤 ④ 生成今日快照、⑤ 登出并清除本地数据 + 二次授权 | 全通过 | `9c54009`（9 文件，+255 / −91） |
| 2 | 修复「手动「立即同步」后角色卡不刷新」 | 通过 | 并入 #3 |
| 3 | P3-9 同步 / 启动时机修复（应用级持有一轮启动 + 角色变化补跑 + 核验脚本只读 + 提示语文案） | 通过 | `fcdd9d3`（5 文件，+84 / −29） |
| 4 | **P4-1 估值引擎**（唯一定价出口 + 净值/资产页口径切换） | 通过（真实库抽查零误差 + 界面逐项一致 + 第三方口径对照） | `6b31a9c`（11 文件，+871 / −83） |
| 5 | **P4-2 蓝图成本引擎**（BOM × 引擎价 + ME/TE 折扣 + 可选蓝图价） | 通过（真实库 + Fuzzwork 基础量零误差） | `33052dc`（4 文件，+658 / −1） |
| 6 | **P4-3 LP 比价引擎**（ESI 公共 LP 商店 + ISK/LP 排名 + LP 组合） | 通过（真实库副本迁移 + 真实 ESI 抓取逐条一致） | `6d3c6b1`（13 文件，+1,284） |

**关键验收证据**（完整记录见「P3-8 核验记录」「P3-9 实测记录」，以及「## P4 进度」下的 P4-1 / P4-2 / P4-3 实测记录）

- 步骤 ④：界面净值卡与快照行严格相等 `138,161,761,314.6 = 136,735,404,335.68 + 1,426,356,978.92`
- 步骤 ⑤：登出后 `characters` / 8 张个人表 / 8 条水位 / `personal:` ETag 8 条 / 快照**全清零**、钥匙串条目消失；**P2/P1 零误伤**（`market_orders` 891,667 / `sde_types` 53,060 / `watchlist_items` 1）
- 二次授权 + 重新同步等价：`corporation_id=98446928` 补齐、钱包 `1,426,356,978.92` 与 `assets` 1495 与登出前**一致**，水位 / ETag 8 条重建；「写入 1,504 条」= assets 1495 + LP 6 + journal 2 + characters 1
- 手动同步刷卡片：暂停自动同步（排除周期轮次干扰）后点「立即同步」，卡片「最近同步」`00:56:25` → `00:57:48`，与库 `last_sync_at = 2026-09-27T16:57:48.562Z` 逐秒吻合
- P3-9 ① 应用级启动：停在「数据」页、资产页**从未挂载**，库 `last_sync_at` `17:02:27` → `17:03:16`
- P3-9 ② 角色变化补跑：二次授权后**未点任何按钮**（只点了「授权新角色」），`assets` 0 → 1495、水位 0 → 8、ETag 0 → 8 自动重建
- 回归：暂停 / 恢复、切页签、行情页采集正常且未重复初始化；**暂停状态现在跨页签保持**（hook 上移到 App 级的副产物）
- 静态：ui `tsc` / `build` 通过；core 219 用例全绿；`cargo test` 12 通过 + 1 ignored
- 提示语文案（授权成功 → 「正在自动同步…」）**仅静态验证**——该串只在 `authorize()` 成功那一刻可见，未为它重复一次登出 + 授权

**该会话结束时的仓库 / 环境状态**

- 最新提交：P4-3 `6d3c6b1`（本次纪要为紧随其后的 docs 提交）；**工作区干净**；`main` 领先 `origin/main`（`28c3475` → `6d3c6b1`，含 P4-1 / P4-2 / P4-3 及配套 docs 提交），**未推送**
- 核验用临时用例（`zz-realdb-verify.test.ts` / `zz-realdb-p42.test.ts` / `zz-realdb-p43.test.ts`）**跑完均已删除**，未入库；P4-1 界面复核启动的 `pnpm tauri dev` **已按用户要求停止**（`eve-suite.exe` 进程已结束），P4-3 核验改用「真实库副本 + 真实 ESI」，**全程未动运行库**
- 遗留非阻塞待办与下一步见「## 下一步」第 2、3 条

