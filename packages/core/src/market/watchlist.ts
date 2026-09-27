import type { DbAdapter } from '../db/types';

/** 6 小时聚合桶宽度（方案文档：细粒度历史仅由监视列表的 6h 聚合行承担） */
export const WATCH_BUCKET_MS = 6 * 3600_000;

/** 监视列表条目（含物品名与最新行情） */
export interface WatchlistItem {
  watchId: number;
  typeId: number;
  regionId: number;
  note: string | null;
  createdAt: string;
  nameEn: string | null;
  nameZh: string | null;
  regionNameEn: string | null;
  regionNameZh: string | null;
  bestSell: number | null;
  bestBuy: number | null;
  spread: number | null;
  p5Sell: number | null;
  sellVolume: number;
  buyVolume: number;
  updatedAt: string | null;
}

const ITEM_SELECT = `SELECT w.watch_id      AS watchId,
                            w.type_id       AS typeId,
                            w.region_id     AS regionId,
                            w.note          AS note,
                            w.created_at    AS createdAt,
                            t.name_en       AS nameEn,
                            t.name_zh       AS nameZh,
                            r.name_en       AS regionNameEn,
                            r.name_zh       AS regionNameZh,
                            s.best_sell     AS bestSell,
                            s.best_buy      AS bestBuy,
                            s.spread        AS spread,
                            s.p5_sell       AS p5Sell,
                            s.sell_volume   AS sellVolume,
                            s.buy_volume    AS buyVolume,
                            s.updated_at    AS updatedAt
                       FROM watchlist_items w
                       LEFT JOIN sde_types t   ON t.type_id   = w.type_id
                       LEFT JOIN sde_regions r ON r.region_id = w.region_id
                       LEFT JOIN market_stats s ON s.region_id = w.region_id AND s.type_id = w.type_id`;

/** 加入监视（同一物品+区域已存在时直接返回其 ID） */
export async function addWatchItem(
  db: DbAdapter,
  typeId: number,
  regionId: number,
  note: string | null = null,
  nowMs: number = Date.now(),
): Promise<number> {
  const existing = await db.select<{ watchId: number }>(
    'SELECT watch_id AS watchId FROM watchlist_items WHERE type_id = ? AND region_id = ?',
    [typeId, regionId],
  );
  const found = existing[0]?.watchId;
  if (found !== undefined) return found;

  await db.execute(
    'INSERT INTO watchlist_items (type_id, region_id, note, created_at) VALUES (?, ?, ?, ?)',
    [typeId, regionId, note, new Date(nowMs).toISOString()],
  );

  const created = await db.select<{ watchId: number }>(
    'SELECT watch_id AS watchId FROM watchlist_items WHERE type_id = ? AND region_id = ?',
    [typeId, regionId],
  );
  const watchId = created[0]?.watchId;
  if (watchId === undefined) {
    throw new Error('加入监视失败：未取回新记录 ID');
  }
  return watchId;
}

/** 移出监视（同时清理其聚合历史） */
export async function removeWatchItem(db: DbAdapter, watchId: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute('DELETE FROM watchlist_stats WHERE watch_id = ?', [watchId]);
    await tx.execute('DELETE FROM watchlist_items WHERE watch_id = ?', [watchId]);
  });
}

/** 列出全部监视条目（含物品名、区域名与最新行情） */
export async function listWatchItems(db: DbAdapter): Promise<WatchlistItem[]> {
  const rows = await db.select<WatchlistItem>(
    `${ITEM_SELECT} ORDER BY w.created_at DESC, w.watch_id DESC`,
  );
  return rows.map((row) => ({
    ...row,
    sellVolume: row.sellVolume ?? 0,
    buyVolume: row.buyVolume ?? 0,
  }));
}

/**
 * 记录一次 6 小时聚合快照。
 * 从 market_stats 取当前最优价与量，写入 watchlist_stats 对应时间桶（同桶覆盖）。
 * 返回写入的条目数。
 */
export async function recordWatchStats(db: DbAdapter, nowMs: number = Date.now()): Promise<number> {
  const bucketAt = bucket6h(nowMs);
  const rows = await db.select<{
    watchId: number;
    bestSell: number | null;
    bestBuy: number | null;
    sellVolume: number | null;
    buyVolume: number | null;
  }>(
    `SELECT w.watch_id    AS watchId,
            s.best_sell   AS bestSell,
            s.best_buy    AS bestBuy,
            s.sell_volume AS sellVolume,
            s.buy_volume  AS buyVolume
       FROM watchlist_items w
       LEFT JOIN market_stats s ON s.region_id = w.region_id AND s.type_id = w.type_id`,
  );
  if (rows.length === 0) return 0;

  const CHUNK = 500;
  for (let offset = 0; offset < rows.length; offset += CHUNK) {
    const chunk = rows.slice(offset, offset + CHUNK);
    const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
    const params: unknown[] = [];
    for (const row of chunk) {
      params.push(
        row.watchId,
        bucketAt,
        row.bestSell ?? null,
        row.bestBuy ?? null,
        row.sellVolume ?? 0,
        row.buyVolume ?? 0,
      );
    }
    await db.execute(
      `INSERT INTO watchlist_stats (watch_id, bucket_at, best_sell, best_buy, sell_volume, buy_volume)
       VALUES ${placeholders}
       ON CONFLICT(watch_id, bucket_at) DO UPDATE SET
         best_sell   = excluded.best_sell,
         best_buy    = excluded.best_buy,
         sell_volume = excluded.sell_volume,
         buy_volume  = excluded.buy_volume`,
      params,
    );
  }

  return rows.length;
}

/** 某监视条目的 6 小时聚合历史（按时间升序） */
export async function listWatchStats(
  db: DbAdapter,
  watchId: number,
  limit = 200,
): Promise<{ bucketAt: string; bestSell: number | null; bestBuy: number | null; sellVolume: number; buyVolume: number }[]> {
  return db.select(
    `SELECT bucket_at AS bucketAt,
            best_sell AS bestSell,
            best_buy  AS bestBuy,
            sell_volume AS sellVolume,
            buy_volume  AS buyVolume
       FROM watchlist_stats
      WHERE watch_id = ?
      ORDER BY bucket_at DESC
      LIMIT ?`,
    [watchId, limit],
  );
}

/** 导出监视列表为 CSV 文本 */
export async function exportWatchlistCsv(db: DbAdapter): Promise<string> {
  const items = await listWatchItems(db);
  const header = [
    'watchId',
    'typeId',
    'nameEn',
    'nameZh',
    'regionId',
    'regionNameEn',
    'regionNameZh',
    'bestSell',
    'bestBuy',
    'spread',
    'sellVolume',
    'buyVolume',
    'updatedAt',
  ];
  const lines = [header.join(',')];
  for (const item of items) {
    lines.push(
      [
        item.watchId,
        item.typeId,
        item.nameEn,
        item.nameZh,
        item.regionId,
        item.regionNameEn,
        item.regionNameZh,
        item.bestSell,
        item.bestBuy,
        item.spread,
        item.sellVolume,
        item.buyVolume,
        item.updatedAt,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\n');
}

/** 6 小时时间桶起点（UTC 对齐，ISO 字符串） */
export function bucket6h(timestampMs: number): string {
  const aligned = Math.floor(timestampMs / WATCH_BUCKET_MS) * WATCH_BUCKET_MS;
  return new Date(aligned).toISOString();
}

/** CSV 单元格转义：含分隔符/引号/换行时加引号并将内部引号翻倍 */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}
