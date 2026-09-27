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
