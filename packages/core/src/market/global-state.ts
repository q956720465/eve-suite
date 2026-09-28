import { readSetting, writeSetting } from '../db/settings';
import type { DbAdapter } from '../db/types';

import { isTradeHub } from './hubs';

/**
 * 全域层（跨区快照）的档位模型、整轮扫描状态与区域清单。
 *
 * 方案文档 §4.1：全域层 = 全部市场区域完整快照，**默认 6h**，五档可调
 * （3h / 6h / 12h / 24h / 关闭），启动时距上次成功扫描超档位则补跑（catch-up）；
 * 存储红线：只存最新快照（订单表按区域整区替换，不再留历史）。
 *
 * 区域清单口径（**方案 A，已与用户确认**）：
 * - 「70 区域」= `sde_regions` 中已知空间区域（`region_id ∈ [10000000, 10999999]`，
 *   本地实测恰好 70 个；其余 44 个为虫洞区，无市场）；
 * - 其中 5 个枢纽区由**枢纽层每 5 分钟**维护（数据更新鲜），
 *   故全域轮次直采 **65** 个非枢纽区，两者共同覆盖 70 区。
 */

/** 全域层扫描档位 */
export type GlobalScanTier = '3h' | '6h' | '12h' | '24h' | 'off';

/** 档位顺序（界面下拉按此顺序展示） */
export const GLOBAL_SCAN_TIERS: readonly GlobalScanTier[] = ['3h', '6h', '12h', '24h', 'off'];

/** 默认档位（方案 §1：默认 6 小时） */
export const DEFAULT_GLOBAL_SCAN_TIER: GlobalScanTier = '6h';

/** 各档位周期（毫秒）；`off` 为 null —— 关闭后不再自动扫描，已有快照保留 */
export const GLOBAL_SCAN_TIER_MS: Readonly<Record<GlobalScanTier, number | null>> = {
  '3h': 3 * 3_600_000,
  '6h': 6 * 3_600_000,
  '12h': 12 * 3_600_000,
  '24h': 24 * 3_600_000,
  off: null,
};

/** 部分失败后的重试延后：不让失败区域干等到下一个档位周期 */
export const GLOBAL_SCAN_RETRY_DELAY_MS = 15 * 60_000;

/** 档位在 `settings` 表中的键名 */
export const GLOBAL_SCAN_TIER_KEY = 'market.global.tier';

/** 已知空间（有市场）的区域 ID 区间 */
export const MARKET_REGION_ID_MIN = 10_000_000;
export const MARKET_REGION_ID_MAX = 10_999_999;

/** 整轮扫描状态（`market_global_scan_state` 单行） */
export interface GlobalScanState {
  /** 本轮开始时刻；续扫时保持为**本轮最初**的开始时刻（本轮锚点） */
  lastStartedAt: string | null;
  /** 本轮最近一次收尾时刻 */
  lastFinishedAt: string | null;
  /** 最近一次「全量成功」的完成时刻 —— 档位到期以此为锚点 */
  lastFullOkAt: string | null;
  /** 本轮首个失败原因（无失败为 null） */
  lastError: string | null;
  /** 待重试时刻（部分失败 / 被暂停后设置；全量成功时清空） */
  retryDueAt: string | null;
  /** 区域总数（本轮口径） */
  regionsTotal: number;
  /** 本轮已完成区域数（含续扫时跳过的已完成区域） */
  regionsOk: number;
  /** 本轮失败区域数 */
  regionsFailed: number;
  /** 本轮累计请求数 */
  requests: number;
  /** 本轮累计写入订单数 */
  ordersWritten: number;
  /** 本轮累计耗时（毫秒） */
  elapsedMs: number;
}

export const EMPTY_GLOBAL_SCAN_STATE: GlobalScanState = {
  lastStartedAt: null,
  lastFinishedAt: null,
  lastFullOkAt: null,
  lastError: null,
  retryDueAt: null,
  regionsTotal: 0,
  regionsOk: 0,
  regionsFailed: 0,
  requests: 0,
  ordersWritten: 0,
  elapsedMs: 0,
};

const STATE_SELECT = `SELECT last_started_at  AS lastStartedAt,
                             last_finished_at AS lastFinishedAt,
                             last_full_ok_at  AS lastFullOkAt,
                             last_error       AS lastError,
                             retry_due_at     AS retryDueAt,
                             regions_total    AS regionsTotal,
                             regions_ok       AS regionsOk,
                             regions_failed   AS regionsFailed,
                             requests         AS requests,
                             orders_written   AS ordersWritten,
                             elapsed_ms       AS elapsedMs
                        FROM market_global_scan_state
                       WHERE id = 1`;

/** 读取整轮扫描状态；尚无记录返回空状态 */
export async function readGlobalScanState(db: DbAdapter): Promise<GlobalScanState> {
  const rows = await db.select<GlobalScanState>(STATE_SELECT);
  return rows[0] ?? EMPTY_GLOBAL_SCAN_STATE;
}

/** 覆盖写入整轮扫描状态（单行 upsert） */
export async function writeGlobalScanState(
  db: DbAdapter,
  state: GlobalScanState,
): Promise<void> {
  await db.execute(
    `INSERT INTO market_global_scan_state
       (id, last_started_at, last_finished_at, last_full_ok_at, last_error, retry_due_at,
        regions_total, regions_ok, regions_failed, requests, orders_written, elapsed_ms)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       last_started_at  = excluded.last_started_at,
       last_finished_at = excluded.last_finished_at,
       last_full_ok_at  = excluded.last_full_ok_at,
       last_error       = excluded.last_error,
       retry_due_at     = excluded.retry_due_at,
       regions_total    = excluded.regions_total,
       regions_ok       = excluded.regions_ok,
       regions_failed   = excluded.regions_failed,
       requests         = excluded.requests,
       orders_written   = excluded.orders_written,
       elapsed_ms       = excluded.elapsed_ms`,
    [
      state.lastStartedAt,
      state.lastFinishedAt,
      state.lastFullOkAt,
      state.lastError,
      state.retryDueAt,
      state.regionsTotal,
      state.regionsOk,
      state.regionsFailed,
      state.requests,
      state.ordersWritten,
      state.elapsedMs,
    ],
  );
}

/** 解析档位取值：非法或缺失回退默认档 */
export function parseGlobalScanTier(value: string | null): GlobalScanTier {
  return value !== null && (GLOBAL_SCAN_TIERS as readonly string[]).includes(value)
    ? (value as GlobalScanTier)
    : DEFAULT_GLOBAL_SCAN_TIER;
}

export async function readGlobalScanTier(db: DbAdapter): Promise<GlobalScanTier> {
  return parseGlobalScanTier(await readSetting(db, GLOBAL_SCAN_TIER_KEY));
}

export async function writeGlobalScanTier(db: DbAdapter, tier: GlobalScanTier): Promise<void> {
  await writeSetting(db, GLOBAL_SCAN_TIER_KEY, tier);
}

/** 上一轮扫描「已开始但未收尾」→ 视为中断（应用被杀 / 页面重载），需立即续扫 */
export function isScanInterrupted(state: GlobalScanState): boolean {
  if (state.lastStartedAt === null) return false;
  if (state.lastFinishedAt === null) return true;
  return Date.parse(state.lastStartedAt) > Date.parse(state.lastFinishedAt);
}

/** 本轮是否需要发起扫描（方案 §4.1 的 catch-up 判定） */
export function isScanDue(input: {
  state: GlobalScanState;
  tier: GlobalScanTier;
  /** 当前时刻（毫秒） */
  now: number;
}): boolean {
  if (GLOBAL_SCAN_TIER_MS[input.tier] === null) return false; // 关闭档：不自动扫描
  if (isScanInterrupted(input.state)) return true;
  if (
    input.state.retryDueAt !== null &&
    input.now >= Date.parse(input.state.retryDueAt)
  ) {
    return true;
  }
  if (input.state.lastFullOkAt === null) return true; // 从未全量成功：首启即扫
  return input.now >= Date.parse(input.state.lastFullOkAt) + (GLOBAL_SCAN_TIER_MS[input.tier] ?? 0);
}

/**
 * 下次自动扫描时刻（毫秒）；关闭档返回 null。
 * 已到期 / 中断 / 从未扫描时返回 `now`（调用方按「立即」处理）。
 */
export function nextScanDueAt(input: {
  state: GlobalScanState;
  tier: GlobalScanTier;
  now: number;
}): number | null {
  const tierMs = GLOBAL_SCAN_TIER_MS[input.tier];
  if (tierMs === null) return null;
  if (isScanInterrupted(input.state) || input.state.lastFullOkAt === null) return input.now;

  let next = Date.parse(input.state.lastFullOkAt) + tierMs;
  if (input.state.retryDueAt !== null) {
    next = Math.min(next, Date.parse(input.state.retryDueAt));
  }
  // 已经过期（含锚点漂移）一律按「立即」处理，避免界面显示过去时刻
  return Math.max(next, input.now);
}

/** 已知空间区域 ID 清单（升序；即方案里的「70 区域」） */
export async function listMarketRegionIds(db: DbAdapter): Promise<number[]> {
  const rows = await db.select<{ regionId: number }>(
    `SELECT region_id AS regionId
       FROM sde_regions
      WHERE region_id BETWEEN ? AND ?
      ORDER BY region_id`,
    [MARKET_REGION_ID_MIN, MARKET_REGION_ID_MAX],
  );
  return rows.map((row) => row.regionId);
}

/**
 * 全域层实际扫描的区域清单 = 已知空间区域 **排除 5 个枢纽区**（方案 A）。
 * 枢纽区由枢纽层每 5 分钟维护，无需全域轮次重复拉取。
 */
export async function listGlobalScanRegionIds(db: DbAdapter): Promise<number[]> {
  return (await listMarketRegionIds(db)).filter((regionId) => !isTradeHub(regionId));
}

/** 界面所需的全域层状态快照 */
export interface GlobalScanStatus {
  tier: GlobalScanTier;
  state: GlobalScanState;
  /** 下次自动扫描时刻（毫秒）；关闭档为 null */
  nextDueAt: number | null;
  /** 已知空间区域总数（70） */
  marketRegionCount: number;
  /** 全域轮次直采的区域数（65，已排除枢纽） */
  scanRegionCount: number;
}

/** 一次性读出界面要展示的全部全域层状态 */
export async function getGlobalScanStatus(
  db: DbAdapter,
  now: number,
): Promise<GlobalScanStatus> {
  const [tier, state, marketRegionIds, scanRegionIds] = await Promise.all([
    readGlobalScanTier(db),
    readGlobalScanState(db),
    listMarketRegionIds(db),
    listGlobalScanRegionIds(db),
  ]);
  return {
    tier,
    state,
    nextDueAt: nextScanDueAt({ state, tier, now }),
    marketRegionCount: marketRegionIds.length,
    scanRegionCount: scanRegionIds.length,
  };
}
