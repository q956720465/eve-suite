import type { DbAdapter } from '../db/types';

import type { PersonalScope } from './scopes';

/**
 * personal_sync_state 读写：每角色每端点一行水位。
 *
 * 生命周期约定：
 * - 拉取前 markScopeStarted（记 last_started_at）
 * - 成功 markScopeOk（记 last_ok_at、清 last_error、可选更新 etag/pages）
 * - 失败 markScopeError（只记 last_error，**不触碰 last_ok_at**）
 *
 * 分页端点的逐页 ETag 复用 market_etag_cache 表（scope 为自由文本键，
 * P2 行情键为 `orders:...` / `history:...`，个人数据键为 `personal:<角色>:<scope>:<页>`）。
 */

export interface PersonalScopeState {
  etag: string | null;
  expiresAt: string | null;
  lastStartedAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  pages: number;
}

/** 读取某角色的全部水位行 */
export async function loadScopeStates(
  db: DbAdapter,
  characterId: number,
): Promise<Map<PersonalScope, PersonalScopeState>> {
  const rows = await db.select<{
    scope: PersonalScope;
    etag: string | null;
    expires_at: string | null;
    last_started_at: string | null;
    last_ok_at: string | null;
    last_error: string | null;
    pages: number;
  }>('SELECT scope, etag, expires_at, last_started_at, last_ok_at, last_error, pages FROM personal_sync_state WHERE character_id = ?', [
    characterId,
  ]);
  const result = new Map<PersonalScope, PersonalScopeState>();
  for (const row of rows) {
    result.set(row.scope, {
      etag: row.etag,
      expiresAt: row.expires_at,
      lastStartedAt: row.last_started_at,
      lastOkAt: row.last_ok_at,
      lastError: row.last_error,
      pages: row.pages,
    });
  }
  return result;
}

export async function markScopeStarted(
  db: DbAdapter,
  characterId: number,
  scope: PersonalScope,
  startedAt: string,
): Promise<void> {
  await db.execute(
    `INSERT INTO personal_sync_state (character_id, scope, last_started_at)
     VALUES (?, ?, ?)
     ON CONFLICT(character_id, scope) DO UPDATE SET last_started_at = excluded.last_started_at`,
    [characterId, scope, startedAt],
  );
}

export interface ScopeOkPatch {
  /** 单请求端点（wallet_balance）的 ETag；分页端点不写此列（逐页 ETag 在 KV 表） */
  etag?: string;
  /** 本轮确认的页数；分页端点必传 */
  pages?: number;
}

export async function markScopeOk(
  db: DbAdapter,
  characterId: number,
  scope: PersonalScope,
  patch: ScopeOkPatch,
  okAt: string,
): Promise<void> {
  await db.execute(
    `INSERT INTO personal_sync_state (character_id, scope, etag, pages, last_ok_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(character_id, scope) DO UPDATE SET
       etag = COALESCE(excluded.etag, personal_sync_state.etag),
       pages = COALESCE(excluded.pages, personal_sync_state.pages),
       last_ok_at = excluded.last_ok_at,
       last_error = NULL`,
    [characterId, scope, patch.etag ?? null, patch.pages ?? null, okAt],
  );
}

/** 只记 last_error：last_ok_at / etag / pages 全部保持原样 */
export async function markScopeError(
  db: DbAdapter,
  characterId: number,
  scope: PersonalScope,
  message: string,
): Promise<void> {
  await db.execute(
    `INSERT INTO personal_sync_state (character_id, scope, last_error)
     VALUES (?, ?, ?)
     ON CONFLICT(character_id, scope) DO UPDATE SET last_error = excluded.last_error`,
    [characterId, scope, message],
  );
}

// ── 分页端点逐页 ETag（KV：market_etag_cache） ──

export function personalPageScope(
  characterId: number,
  scope: PersonalScope,
  page: number,
): string {
  return `personal:${characterId}:${scope}:${page}`;
}

/** 读取某 scope 已缓存的逐页 ETag（页码 → ETag）。页数增长后新页自然无缓存 */
export async function loadPageEtags(
  db: DbAdapter,
  characterId: number,
  scope: PersonalScope,
): Promise<Map<number, string>> {
  const prefix = `personal:${characterId}:${scope}:`;
  const rows = await db.select<{ scope: string; etag: string }>(
    'SELECT scope, etag FROM market_etag_cache WHERE scope LIKE ?',
    [`${prefix}%`],
  );
  const result = new Map<number, string>();
  for (const row of rows) {
    const page = Number.parseInt(row.scope.slice(prefix.length), 10);
    if (Number.isInteger(page) && page > 0) result.set(page, row.etag);
  }
  return result;
}

/** 批量回写逐页 ETag（存在则更新） */
export async function savePageEtags(
  db: DbAdapter,
  characterId: number,
  scope: PersonalScope,
  etags: ReadonlyMap<number, string>,
  updatedAt: string,
): Promise<void> {
  if (etags.size === 0) return;
  const entries = [...etags.entries()];
  const placeholders = entries.map(() => '(?, ?, ?)').join(', ');
  const params: unknown[] = [];
  for (const [page, etag] of entries) {
    params.push(personalPageScope(characterId, scope, page), etag, updatedAt);
  }
  await db.execute(
    `INSERT INTO market_etag_cache (scope, etag, updated_at) VALUES ${placeholders}
     ON CONFLICT(scope) DO UPDATE SET etag = excluded.etag, updated_at = excluded.updated_at`,
    params,
  );
}
