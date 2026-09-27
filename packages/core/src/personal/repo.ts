import type { DbAdapter } from '../db/types';

import type { PersonalScope } from './scopes';
import { loadScopeStates, type PersonalScopeState } from './state';

export interface CharacterSummary {
  characterId: number;
  name: string;
  corporationId: number | null;
  walletBalance: number | null;
  walletSyncedAt: string | null;
  addedAt: string;
  lastSyncAt: string | null;
}

/** 已授权角色清单（P3-7 UI 与调度层共用） */
export async function listCharacters(db: DbAdapter): Promise<CharacterSummary[]> {
  const rows = await db.select<{
    character_id: number;
    name: string;
    corporation_id: number | null;
    wallet_balance: number | null;
    wallet_synced_at: string | null;
    added_at: string;
    last_sync_at: string | null;
  }>(
    `SELECT character_id, name, corporation_id, wallet_balance, wallet_synced_at, added_at, last_sync_at
     FROM characters
     ORDER BY added_at, character_id`,
  );
  return rows.map((row) => ({
    characterId: row.character_id,
    name: row.name,
    corporationId: row.corporation_id,
    walletBalance: row.wallet_balance,
    walletSyncedAt: row.wallet_synced_at,
    addedAt: row.added_at,
    lastSyncAt: row.last_sync_at,
  }));
}

/** 调度用：仅取已授权角色 ID */
export async function listCharacterIds(db: DbAdapter): Promise<number[]> {
  const rows = await db.select<{ character_id: number }>(
    'SELECT character_id FROM characters ORDER BY added_at, character_id',
  );
  return rows.map((row) => row.character_id);
}

export interface ScopeStateSummary extends PersonalScopeState {
  scope: PersonalScope;
}

/** 某角色各端点的同步水位（含 ETag / 到期时间 / 最近成功与错误） */
export async function getCharacterScopeStates(
  db: DbAdapter,
  characterId: number,
): Promise<ScopeStateSummary[]> {
  const states = await loadScopeStates(db, characterId);
  return [...states.entries()].map(([scope, state]) => ({ scope, ...state }));
}

export interface UpsertCharacterInput {
  characterId: number;
  name: string;
  /** 本次授权的 scope 列表（以空格拼接存库） */
  scopes: readonly string[];
  /** 首次授权时通常未知（由 /characters/{id} 后续补齐） */
  corporationId?: number | null;
  /** 首次加入时间（ISO 8601） */
  addedAt: string;
}

/**
 * 写入/更新角色（幂等）。
 * 重复授权时刷新 name 与 scopes；corporation_id 为空则保留既有值
 * （避免用 null 覆盖已由同步端点补齐的数据）。
 */
export async function upsertCharacter(db: DbAdapter, input: UpsertCharacterInput): Promise<void> {
  await db.execute(
    `INSERT INTO characters (character_id, name, corporation_id, scopes, added_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(character_id) DO UPDATE SET
       name = excluded.name,
       scopes = excluded.scopes,
       corporation_id = COALESCE(excluded.corporation_id, characters.corporation_id)`,
    [
      input.characterId,
      input.name,
      input.corporationId ?? null,
      input.scopes.join(' '),
      input.addedAt,
    ],
  );
}

/** 该角色名下的个人数据表（不含 characters 本身与水位表） */
const CHARACTER_DATA_TABLES = [
  'assets',
  'wallet_journal',
  'my_orders',
  'contracts',
  'industry_jobs',
  'mining_ledger',
  'lp_balances',
  'networth_snapshots',
] as const;

/**
 * 清空某角色的全部个人数据与同步水位（登出用），其它角色不受影响。
 * 逐页 ETag 存在共用 KV 表，按 `personal:<角色>:` 前缀清理。
 */
export async function clearCharacterData(db: DbAdapter, characterId: number): Promise<void> {
  await db.transaction(async (tx) => {
    for (const table of CHARACTER_DATA_TABLES) {
      await tx.execute(`DELETE FROM ${table} WHERE character_id = ?`, [characterId]);
    }
    await tx.execute('DELETE FROM personal_sync_state WHERE character_id = ?', [characterId]);
    await tx.execute('DELETE FROM market_etag_cache WHERE scope LIKE ?', [
      `personal:${characterId}:%`,
    ]);
  });
}

/** 登出：移除角色行（个人数据清理另调 `clearCharacterData`） */
export async function removeCharacter(db: DbAdapter, characterId: number): Promise<void> {
  await db.execute('DELETE FROM characters WHERE character_id = ?', [characterId]);
}
