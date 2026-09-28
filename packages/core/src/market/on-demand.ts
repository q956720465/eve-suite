import type { DbAdapter } from '../db/types';
import type { EsiClient } from '../esi/client';
import type { RequestPriority, RequestScheduler } from '../esi/scheduler';
import { insertRows } from '../sde/batch';

import { historyScope, loadEtags, saveEtags } from './etag-cache';
import {
  HISTORY_COLUMNS,
  ORDER_COLUMNS,
  STATS_COLUMNS,
  WRITE_BATCH_ROWS,
  toOrderRow,
  toStatsRow,
} from './rows';
import { computeMarketStats } from './stats';

/** 按需数据的默认新鲜度阈值：5 分钟（与枢纽层采集节奏一致） */
export const ONDEMAND_TTL_MS = 5 * 60_000;

/**
 * 日线历史的本地保留天数（P5-2.7）。
 *
 * 价差历史校验只用「30 天均价锚 + 近 7 天窗口」，90 天足够覆盖；而 ESI 端点虽返回
 * 约 400 天，整段存储会让库体积与每轮写入量放大 4 倍以上（配合增量写入一起收敛）。
 * 注意：行情页价格图读的就是本表，因此图表历史长度 = 本常量。
 */
export const HISTORY_RETENTION_DAYS = 90;

/** 行情模块运行依赖（由宿主注入） */
export interface MarketDeps {
  db: DbAdapter;
  client: EsiClient;
  scheduler: RequestScheduler;
}

export interface TypeRefreshResult {
  regionId: number;
  typeId: number;
  ordersWritten: number;
  statsWritten: number;
  /** 命中本地缓存或 304，未重新写入 */
  skipped: boolean;
}

export interface HistoryRefreshResult {
  regionId: number;
  typeId: number;
  daysWritten: number;
  skipped: boolean;
}

/**
 * 按需刷新单个物品在某区域的订单与统计（打开物品详情时调用）。
 * 该端点不走 ESI 的 5 分钟区域缓存，数据更新更快，因此本地 TTL 取 5 分钟。
 */
export async function refreshTypeOrders(
  deps: MarketDeps,
  regionId: number,
  typeId: number,
  options: { maxAgeMs?: number; force?: boolean; now?: number } = {},
): Promise<TypeRefreshResult> {
  const maxAgeMs = options.maxAgeMs ?? ONDEMAND_TTL_MS;
  const now = options.now ?? Date.now();

  if (options.force !== true && (await isStatsFresh(deps.db, regionId, typeId, maxAgeMs, now))) {
    return { regionId, typeId, ordersWritten: 0, statsWritten: 0, skipped: true };
  }

  const result = await deps.scheduler.run('ondemand', () =>
    deps.client.fetchTypeOrders(regionId, typeId),
  );
  deps.scheduler.observe(result.rateLimit, result.errorLimit);

  const orders = result.data ?? [];
  const fetchedAt = new Date(now).toISOString();
  const stats = computeMarketStats(orders, regionId, fetchedAt);
  const orderRows = orders.map((order) => toOrderRow(order, regionId, fetchedAt));
  const statsRows = stats.map(toStatsRow);

  await deps.db.transaction(async (tx) => {
    await tx.execute('DELETE FROM market_orders WHERE region_id = ? AND type_id = ?', [
      regionId,
      typeId,
    ]);
    await insertRows(tx, 'market_orders', ORDER_COLUMNS, orderRows, WRITE_BATCH_ROWS);

    await tx.execute('DELETE FROM market_stats WHERE region_id = ? AND type_id = ?', [
      regionId,
      typeId,
    ]);
    await insertRows(tx, 'market_stats', STATS_COLUMNS, statsRows, WRITE_BATCH_ROWS);
  });

  return {
    regionId,
    typeId,
    ordersWritten: orderRows.length,
    statsWritten: statsRows.length,
    skipped: false,
  };
}

/**
 * 刷新单个物品在某区域的日线历史（ESI 自带约 400 天）。
 * 默认每日一次（方案文档：北京 19:00 停机后回填），ETag 命中时仅刷新抓取时间。
 *
 * `priority` 默认 `ondemand`（用户主动等待的场景，抢时间）；
 * 「枢纽历史基线预拉」这类后台批量任务传 `global`，让路给枢纽 / 个人数据。
 */
export async function refreshTypeHistory(
  deps: MarketDeps,
  regionId: number,
  typeId: number,
  options: { force?: boolean; now?: number; priority?: RequestPriority } = {},
): Promise<HistoryRefreshResult> {
  const now = options.now ?? Date.now();
  const today = new Date(now).toISOString().slice(0, 10);

  if (options.force !== true && (await isHistoryFetchedToday(deps.db, regionId, typeId, today))) {
    return { regionId, typeId, daysWritten: 0, skipped: true };
  }

  const scope = historyScope(regionId, typeId);
  const etags = await loadEtags(deps.db, [scope]);
  const result = await deps.scheduler.run(options.priority ?? 'ondemand', () =>
    deps.client.fetchTypeHistory(regionId, typeId, { etag: etags.get(scope) }),
  );
  deps.scheduler.observe(result.rateLimit, result.errorLimit);

  const fetchedAt = new Date(now).toISOString();

  if (result.notModified) {
    // 数据未变：只刷新抓取时间，避免当天重复校验
    await deps.db.execute(
      'UPDATE market_history_daily SET fetched_at = ? WHERE region_id = ? AND type_id = ?',
      [fetchedAt, regionId, typeId],
    );
    return { regionId, typeId, daysWritten: 0, skipped: true };
  }

  // 只保留窗口内的日线（P5-2.7）：端点返回约 400 天，但校验只需 30 天锚 + 近 7 天窗口
  const cutoff = historyRetentionCutoff(now);
  const kept = (result.data ?? []).filter((entry) => entry.date >= cutoff);

  // 增量写入：先取本地最新日期，只写「>= 它」的行（含当天，故当天数据会被刷新覆盖）。
  // 日常通常 1~2 行，而不是整段 400 行 —— 这是把「每轮千万行写入 + 上万个持锁事务」
  // 收敛到「万行级」的关键，也是与枢纽整区替换争抢写锁的根因所在。
  const maxRows = await deps.db.select<{ maxDate: string | null }>(
    'SELECT MAX(date) AS maxDate FROM market_history_daily WHERE region_id = ? AND type_id = ?',
    [regionId, typeId],
  );
  const maxDate = maxRows[0]?.maxDate ?? null;
  const fresh = maxDate === null ? kept : kept.filter((entry) => entry.date >= maxDate);

  const rows: unknown[][] = fresh.map((entry) => [
    regionId,
    typeId,
    entry.date,
    entry.average,
    entry.highest,
    entry.lowest,
    entry.order_count,
    entry.volume,
    fetchedAt,
  ]);

  await deps.db.transaction(async (tx) => {
    if (kept.length === 0) {
      // 窗口内无数据（该物品在此区已无成交）：清空该 pair，与「空历史」语义一致
      await tx.execute('DELETE FROM market_history_daily WHERE region_id = ? AND type_id = ?', [
        regionId,
        typeId,
      ]);
    } else {
      if (rows.length > 0) {
        await insertRows(tx, 'market_history_daily', HISTORY_COLUMNS, rows, WRITE_BATCH_ROWS, {
          target: ['region_id', 'type_id', 'date'],
          update: HISTORY_COLUMNS.filter(
            (column) => column !== 'region_id' && column !== 'type_id' && column !== 'date',
          ),
        });
      } else {
        // 无待写日期：仅刷新最新一行的 fetched_at —— 「当日已抓取」判据只看这一行
        await tx.execute(
          `UPDATE market_history_daily SET fetched_at = ?
            WHERE region_id = ? AND type_id = ?
              AND date = (SELECT MAX(date) FROM market_history_daily
                           WHERE region_id = ? AND type_id = ?)`,
          [fetchedAt, regionId, typeId, regionId, typeId],
        );
      }
      // 裁剪滚出窗口的旧行（首次由 400 天收敛到 90 天时会删除约 310 行）
      await tx.execute(
        'DELETE FROM market_history_daily WHERE region_id = ? AND type_id = ? AND date < ?',
        [regionId, typeId, cutoff],
      );
    }

    if (result.etag !== null) {
      await saveEtags(tx, new Map([[scope, result.etag]]), fetchedAt);
    }
  });

  return { regionId, typeId, daysWritten: rows.length, skipped: false };
}

/** 本地统计是否在有效期内 */
async function isStatsFresh(
  db: DbAdapter,
  regionId: number,
  typeId: number,
  maxAgeMs: number,
  now: number,
): Promise<boolean> {
  const rows = await db.select<{ updated_at: string }>(
    'SELECT updated_at FROM market_stats WHERE region_id = ? AND type_id = ?',
    [regionId, typeId],
  );
  const updatedAt = rows[0]?.updated_at;
  if (updatedAt === undefined) return false;
  const timestamp = Date.parse(updatedAt);
  return Number.isFinite(timestamp) && now - timestamp <= maxAgeMs;
}

/** 日线历史今天是否已抓取过（按 UTC 日期） */
async function isHistoryFetchedToday(
  db: DbAdapter,
  regionId: number,
  typeId: number,
  today: string,
): Promise<boolean> {
  const rows = await db.select<{ fetched_at: string }>(
    `SELECT fetched_at FROM market_history_daily
      WHERE region_id = ? AND type_id = ?
      ORDER BY fetched_at DESC LIMIT 1`,
    [regionId, typeId],
  );
  const fetchedAt = rows[0]?.fetched_at;
  return fetchedAt !== undefined && fetchedAt.slice(0, 10) === today;
}

/** 保留窗口的起始日期（含），格式与 `market_history_daily.date` 一致（UTC `YYYY-MM-DD`） */
export function historyRetentionCutoff(now: number): string {
  return new Date(now - HISTORY_RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
}
