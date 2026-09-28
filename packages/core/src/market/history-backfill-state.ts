import { readSetting, writeSetting } from '../db/settings';
import type { DbAdapter } from '../db/types';

import { TRADE_HUBS } from './hubs';
import { DEFAULT_SPREAD_FILTERS } from './spread';

/**
 * 枢纽历史基线预拉的档位模型、整轮状态与预拉清单（P5-2.6）。
 *
 * 目的：把 5 枢纽区「够得到价差候选门槛」的物品日线历史预拉到本地，
 * 使价差页的历史校验对枢纽候选零等待。
 *
 * 关键口径：
 * - **区域 = 5 枢纽**（`TRADE_HUBS`）。实测双枢纽占价差候选主力；
 *   枢纽区 `market_stats` 约 6.95 万行，远小于全库 21.2 万行。
 * - **物品 = 门槛筛而非排序截断**：`sell_orders >= 5 OR buy_orders >= 5`。
 *   实测「按订单数降序取 Top N」只覆盖双门槛物品的 20.7%
 *   （13,959 个双门槛物品里 Top 1000 之外还剩 11,073 个），
 *   因为门槛线很低而头部物品订单数极高 —— 排序截断会把门槛区间整段切掉。
 *   门槛值直接取自价差粗筛的默认参数，保证「预拉集合 ⊇ 候选集合」不漂移。
 * - **周期 24h**：ESI 日线一天只新增 1 天，且端点自身 `Expires` 到次日，
 *   更高频拿不到新数据（纯浪费请求）。
 *
 * 断点续扫不需要水位列：`market_history_daily.fetched_at` 的「当日已抓取」
 * 判定（`refreshTypeHistory` 内部）天然提供幂等与中断续跑依据。
 */

/** 预拉档位：每日一次 / 关闭 */
export type HistoryBackfillTier = '24h' | 'off';

/** 档位顺序（界面下拉按此顺序展示） */
export const HISTORY_BACKFILL_TIERS: readonly HistoryBackfillTier[] = ['24h', 'off'];

/** 默认档位：开启，每日一次 */
export const DEFAULT_HISTORY_BACKFILL_TIER: HistoryBackfillTier = '24h';

/** 各档位周期（毫秒）；`off` 为 null —— 关闭后不再自动预拉，已拉历史保留 */
export const HISTORY_BACKFILL_TIER_MS: Readonly<Record<HistoryBackfillTier, number | null>> = {
  '24h': 24 * 3_600_000,
  off: null,
};

/** 部分失败后的重试延后：不让失败 pair 干等到下一个 24h 周期 */
export const HISTORY_BACKFILL_RETRY_DELAY_MS = 15 * 60_000;

/** 档位在 `settings` 表中的键名 */
export const HISTORY_BACKFILL_TIER_KEY = 'market.history.tier';

/** 预拉对象的订单数门槛（与价差粗筛默认参数同源，避免口径漂移） */
export const HISTORY_BACKFILL_MIN_SELL_ORDERS = DEFAULT_SPREAD_FILTERS.minSellOrders;
export const HISTORY_BACKFILL_MIN_BUY_ORDERS = DEFAULT_SPREAD_FILTERS.minBuyOrders;

/** 枢纽区 ID（预拉只覆盖这 5 个区域） */
export const HISTORY_BACKFILL_REGION_IDS: readonly number[] = TRADE_HUBS.map(
  (hub) => hub.regionId,
);

/** 整轮预拉状态（`market_history_backfill_state` 单行） */
export interface HistoryBackfillState {
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
  /** 本轮清单总数 */
  pairsTotal: number;
  /** 本轮成功写入的 pair 数 */
  pairsOk: number;
  /** 本轮因「当日已抓取」跳过的 pair 数 */
  pairsSkipped: number;
  /** 本轮失败 pair 数 */
  pairsFailed: number;
  /** 本轮累计写入日线行数 */
  daysWritten: number;
  /** 本轮累计耗时（毫秒） */
  elapsedMs: number;
}

export const EMPTY_HISTORY_BACKFILL_STATE: HistoryBackfillState = {
  lastStartedAt: null,
  lastFinishedAt: null,
  lastFullOkAt: null,
  lastError: null,
  retryDueAt: null,
  pairsTotal: 0,
  pairsOk: 0,
  pairsSkipped: 0,
  pairsFailed: 0,
  daysWritten: 0,
  elapsedMs: 0,
};

const STATE_SELECT = `SELECT last_started_at  AS lastStartedAt,
                             last_finished_at AS lastFinishedAt,
                             last_full_ok_at  AS lastFullOkAt,
                             last_error       AS lastError,
                             retry_due_at     AS retryDueAt,
                             pairs_total      AS pairsTotal,
                             pairs_ok         AS pairsOk,
                             pairs_skipped    AS pairsSkipped,
                             pairs_failed     AS pairsFailed,
                             days_written     AS daysWritten,
                             elapsed_ms       AS elapsedMs
                        FROM market_history_backfill_state
                       WHERE id = 1`;

/** 读取整轮预拉状态；尚无记录返回空状态 */
export async function readHistoryBackfillState(db: DbAdapter): Promise<HistoryBackfillState> {
  const rows = await db.select<HistoryBackfillState>(STATE_SELECT);
  return rows[0] ?? EMPTY_HISTORY_BACKFILL_STATE;
}

/** 覆盖写入整轮预拉状态（单行 upsert） */
export async function writeHistoryBackfillState(
  db: DbAdapter,
  state: HistoryBackfillState,
): Promise<void> {
  await db.execute(
    `INSERT INTO market_history_backfill_state
       (id, last_started_at, last_finished_at, last_full_ok_at, last_error, retry_due_at,
        pairs_total, pairs_ok, pairs_skipped, pairs_failed, days_written, elapsed_ms)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       last_started_at  = excluded.last_started_at,
       last_finished_at = excluded.last_finished_at,
       last_full_ok_at  = excluded.last_full_ok_at,
       last_error       = excluded.last_error,
       retry_due_at     = excluded.retry_due_at,
       pairs_total      = excluded.pairs_total,
       pairs_ok         = excluded.pairs_ok,
       pairs_skipped    = excluded.pairs_skipped,
       pairs_failed     = excluded.pairs_failed,
       days_written     = excluded.days_written,
       elapsed_ms       = excluded.elapsed_ms`,
    [
      state.lastStartedAt,
      state.lastFinishedAt,
      state.lastFullOkAt,
      state.lastError,
      state.retryDueAt,
      state.pairsTotal,
      state.pairsOk,
      state.pairsSkipped,
      state.pairsFailed,
      state.daysWritten,
      state.elapsedMs,
    ],
  );
}

/** 解析档位取值：非法或缺失回退默认档 */
export function parseHistoryBackfillTier(value: string | null): HistoryBackfillTier {
  return value !== null && (HISTORY_BACKFILL_TIERS as readonly string[]).includes(value)
    ? (value as HistoryBackfillTier)
    : DEFAULT_HISTORY_BACKFILL_TIER;
}

export async function readHistoryBackfillTier(db: DbAdapter): Promise<HistoryBackfillTier> {
  return parseHistoryBackfillTier(await readSetting(db, HISTORY_BACKFILL_TIER_KEY));
}

export async function writeHistoryBackfillTier(
  db: DbAdapter,
  tier: HistoryBackfillTier,
): Promise<void> {
  await writeSetting(db, HISTORY_BACKFILL_TIER_KEY, tier);
}

/** 上一轮预拉「已开始但未收尾」→ 视为中断（应用被杀 / 页面重载），需立即续跑 */
export function isBackfillInterrupted(state: HistoryBackfillState): boolean {
  if (state.lastStartedAt === null) return false;
  if (state.lastFinishedAt === null) return true;
  return Date.parse(state.lastStartedAt) > Date.parse(state.lastFinishedAt);
}

/** 本轮是否需要发起预拉 */
export function isBackfillDue(input: {
  state: HistoryBackfillState;
  tier: HistoryBackfillTier;
  /** 当前时刻（毫秒） */
  now: number;
}): boolean {
  if (HISTORY_BACKFILL_TIER_MS[input.tier] === null) return false; // 关闭档：不自动预拉
  if (isBackfillInterrupted(input.state)) return true;
  if (input.state.retryDueAt !== null && input.now >= Date.parse(input.state.retryDueAt)) {
    return true;
  }
  if (input.state.lastFullOkAt === null) return true; // 从未全量成功：首启即跑
  return (
    input.now >= Date.parse(input.state.lastFullOkAt) + (HISTORY_BACKFILL_TIER_MS[input.tier] ?? 0)
  );
}

/**
 * 下次自动预拉时刻（毫秒）；关闭档返回 null。
 * 已到期 / 中断 / 从未预拉时返回 `now`（调用方按「立即」处理）。
 */
export function nextBackfillDueAt(input: {
  state: HistoryBackfillState;
  tier: HistoryBackfillTier;
  now: number;
}): number | null {
  const tierMs = HISTORY_BACKFILL_TIER_MS[input.tier];
  if (tierMs === null) return null;
  if (isBackfillInterrupted(input.state) || input.state.lastFullOkAt === null) return input.now;

  let next = Date.parse(input.state.lastFullOkAt) + tierMs;
  if (input.state.retryDueAt !== null) {
    next = Math.min(next, Date.parse(input.state.retryDueAt));
  }
  // 已经过期（含锚点漂移）一律按「立即」处理，避免界面显示过去时刻
  return Math.max(next, input.now);
}

/** 预拉清单中的一项 */
export interface BackfillPair {
  regionId: number;
  typeId: number;
}

/** 预拉清单的筛选条件（SQL 片段与参数），供清单查询与计数共用 */
function pairFilter(): { where: string; params: unknown[] } {
  const placeholders = HISTORY_BACKFILL_REGION_IDS.map(() => '?').join(', ');
  return {
    where: `region_id IN (${placeholders})
              AND (sell_orders >= ? OR buy_orders >= ?)`,
    params: [
      ...HISTORY_BACKFILL_REGION_IDS,
      HISTORY_BACKFILL_MIN_SELL_ORDERS,
      HISTORY_BACKFILL_MIN_BUY_ORDERS,
    ],
  };
}

/**
 * 预拉清单：5 枢纽中「可能出现在价差候选任一侧」的 (区域, 物品)。
 * 排序固定（区域 + 物品），保证续跑与进度可复现。
 */
export async function listBackfillPairs(db: DbAdapter): Promise<BackfillPair[]> {
  const { where, params } = pairFilter();
  return db.select<BackfillPair>(
    `SELECT region_id AS regionId, type_id AS typeId
       FROM market_stats
      WHERE ${where}
      ORDER BY region_id, type_id`,
    params,
  );
}

/** 预拉清单条数（界面展示用；避免为取长度拉全量行） */
export async function countBackfillPairs(db: DbAdapter): Promise<number> {
  const { where, params } = pairFilter();
  const rows = await db.select<{ total: number }>(
    `SELECT COUNT(*) AS total FROM market_stats WHERE ${where}`,
    params,
  );
  return rows[0]?.total ?? 0;
}

/** 界面所需的预拉状态快照 */
export interface HistoryBackfillStatus {
  tier: HistoryBackfillTier;
  state: HistoryBackfillState;
  /** 下次自动预拉时刻（毫秒）；关闭档为 null */
  nextDueAt: number | null;
  /** 当前清单条数（5 枢纽门槛筛结果） */
  pairCount: number;
}

/** 一次性读出界面要展示的全部预拉状态 */
export async function getHistoryBackfillStatus(
  db: DbAdapter,
  now: number,
): Promise<HistoryBackfillStatus> {
  const [tier, state, pairCount] = await Promise.all([
    readHistoryBackfillTier(db),
    readHistoryBackfillState(db),
    countBackfillPairs(db),
  ]);
  return {
    tier,
    state,
    nextDueAt: nextBackfillDueAt({ state, tier, now }),
    pairCount,
  };
}
