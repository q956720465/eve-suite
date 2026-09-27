import type { DbAdapter } from '../db/types';

/** 区域订单分页的缓存 scope */
export function ordersPageScope(regionId: number, page: number): string {
  return `orders:${regionId}:${page}`;
}

/** 日线历史的缓存 scope */
export function historyScope(regionId: number, typeId: number): string {
  return `history:${regionId}:${typeId}`;
}

const READ_CHUNK = 500;
const WRITE_CHUNK = 500;

/** 批量读取 ETag（scope → etag） */
export async function loadEtags(
  db: DbAdapter,
  scopes: readonly string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (let offset = 0; offset < scopes.length; offset += READ_CHUNK) {
    const chunk = scopes.slice(offset, offset + READ_CHUNK);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await db.select<{ scope: string; etag: string }>(
      `SELECT scope, etag FROM market_etag_cache WHERE scope IN (${placeholders})`,
      chunk,
    );
    for (const row of rows) {
      result.set(row.scope, row.etag);
    }
  }
  return result;
}

/** 批量写入 ETag（存在则更新） */
export async function saveEtags(
  db: DbAdapter,
  entries: ReadonlyMap<string, string>,
  updatedAt: string,
): Promise<void> {
  const pairs = [...entries];
  for (let offset = 0; offset < pairs.length; offset += WRITE_CHUNK) {
    const chunk = pairs.slice(offset, offset + WRITE_CHUNK);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => '(?, ?, ?)').join(', ');
    const params: unknown[] = [];
    for (const [scope, etag] of chunk) {
      params.push(scope, etag, updatedAt);
    }
    await db.execute(
      `INSERT INTO market_etag_cache (scope, etag, updated_at) VALUES ${placeholders}
       ON CONFLICT(scope) DO UPDATE SET etag = excluded.etag, updated_at = excluded.updated_at`,
      params,
    );
  }
}
