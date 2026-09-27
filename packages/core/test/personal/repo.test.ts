import { describe, expect, it } from 'vitest';

import type { DbAdapter } from '../../src/db/types';
import { DEFAULT_VALUATION_REGION_ID } from '../../src/engines/valuation';
import {
  clearCharacterData,
  getAssetDetails,
  getAssetOverview,
  getCharacterScopeStates,
  listCharacterIds,
  listCharacters,
  removeCharacter,
  upsertCharacter,
} from '../../src/personal';
import { savePageEtags } from '../../src/personal/state';
import { countRows, createMigratedDb } from '../helpers/db';
import { CHARACTER_ID } from './fixtures';

const OTHER_ID = 96099999;
const JITA = DEFAULT_VALUATION_REGION_ID;
const ADDED_AT = '2026-09-27T00:00:00Z';

async function addCharacter(db: DbAdapter, characterId: number, name: string): Promise<void> {
  await upsertCharacter(db, {
    characterId,
    name,
    scopes: ['esi-assets.read_assets.v1'],
    addedAt: ADDED_AT,
  });
}

async function insertAsset(
  db: DbAdapter,
  characterId: number,
  itemId: number,
  typeId: number,
  quantity: number,
  locationId = 60003760,
): Promise<void> {
  await db.execute(
    `INSERT INTO assets (character_id, item_id, type_id, quantity, location_id, location_flag,
                         location_type, is_singleton, fetched_at)
     VALUES (?, ?, ?, ?, ?, 'Hangar', 'station', 0, '2026-09-27T00:00:00Z')`,
    [characterId, itemId, typeId, quantity, locationId],
  );
}

async function insertStats(db: DbAdapter, typeId: number, bestSell: number | null): Promise<void> {
  await db.execute(
    'INSERT INTO market_stats (region_id, type_id, best_sell, updated_at) VALUES (?, ?, ?, ?)',
    [JITA, typeId, bestSell, '2026-09-27T00:00:00Z'],
  );
}

describe('角色写库', () => {
  it('upsertCharacter 幂等：重复写入刷新 name/scopes，保留既有 corporation_id', async () => {
    const db = await createMigratedDb();
    await upsertCharacter(db, {
      characterId: CHARACTER_ID,
      name: '旧名',
      scopes: ['esi-assets.read_assets.v1'],
      addedAt: ADDED_AT,
    });
    await db.execute('UPDATE characters SET corporation_id = ? WHERE character_id = ?', [
      98000001,
      CHARACTER_ID,
    ]);

    // 重复授权：name 与 scopes 更新，corporation_id 不传 → 保留
    await upsertCharacter(db, {
      characterId: CHARACTER_ID,
      name: '新名',
      scopes: ['esi-assets.read_assets.v1', 'esi-wallet.read_character_wallet.v1'],
      addedAt: ADDED_AT,
    });

    const rows = await listCharacters(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('新名');
    const raw = await db.select<{ scopes: string; corporation_id: number | null }>(
      'SELECT scopes, corporation_id FROM characters WHERE character_id = ?',
      [CHARACTER_ID],
    );
    expect(raw[0].scopes).toBe('esi-assets.read_assets.v1 esi-wallet.read_character_wallet.v1');
    expect(raw[0].corporation_id).toBe(98000001);
  });

  it('listCharacterIds 按加入时间排序', async () => {
    const db = await createMigratedDb();
    await upsertCharacter(db, {
      characterId: OTHER_ID,
      name: '后加入',
      scopes: [],
      addedAt: '2026-09-28T00:00:00Z',
    });
    await addCharacter(db, CHARACTER_ID, '先加入');

    expect(await listCharacterIds(db)).toEqual([CHARACTER_ID, OTHER_ID]);
  });

  it('clearCharacterData：只清指定角色，其它角色数据与水位保留', async () => {
    const db = await createMigratedDb();
    await addCharacter(db, CHARACTER_ID, '一号');
    await addCharacter(db, OTHER_ID, '二号');

    await insertAsset(db, CHARACTER_ID, 1, 34, 10);
    await insertAsset(db, OTHER_ID, 2, 34, 20);
    await db.execute(
      `INSERT INTO wallet_journal (character_id, entry_id, date, ref_type, description, fetched_at)
       VALUES (?, 1, '2026-09-27T00:00:00Z', 'tax', 'x', '2026-09-27T00:00:00Z')`,
      [CHARACTER_ID],
    );
    await db.execute(
      `INSERT INTO personal_sync_state (character_id, scope, pages, last_ok_at) VALUES (?, 'assets', 1, ?)`,
      [CHARACTER_ID, '2026-09-27T00:00:00Z'],
    );
    await db.execute(
      `INSERT INTO personal_sync_state (character_id, scope, pages, last_ok_at) VALUES (?, 'assets', 1, ?)`,
      [OTHER_ID, '2026-09-27T00:00:00Z'],
    );
    await savePageEtags(db, CHARACTER_ID, 'assets', new Map([[1, 'W/"a"']]), '2026-09-27T00:00:00Z');

    await clearCharacterData(db, CHARACTER_ID);

    expect(await countRows(db, 'assets')).toBe(1);
    expect(await countRows(db, 'wallet_journal')).toBe(0);
    expect(await getCharacterScopeStates(db, CHARACTER_ID)).toEqual([]);
    expect(await getCharacterScopeStates(db, OTHER_ID)).toHaveLength(1);

    const etags = await db.select<{ scope: string }>(
      "SELECT scope FROM market_etag_cache WHERE scope LIKE 'personal:%'",
    );
    expect(etags).toEqual([]);

    // 角色行本身仍在（由 removeCharacter 负责）
    expect(await countRows(db, 'characters')).toBe(2);
  });

  it('removeCharacter 删除角色行', async () => {
    const db = await createMigratedDb();
    await addCharacter(db, CHARACTER_ID, '一号');
    await addCharacter(db, OTHER_ID, '二号');

    await removeCharacter(db, CHARACTER_ID);

    expect(await listCharacterIds(db)).toEqual([OTHER_ID]);
  });
});

describe('资产查询', () => {
  it('getAssetOverview：按物品种类聚合（数量合计、涉及地点数、估值倒序）', async () => {
    const db = await createMigratedDb();
    await addCharacter(db, CHARACTER_ID, '一号');
    await insertAsset(db, CHARACTER_ID, 1, 34, 10);
    await insertAsset(db, CHARACTER_ID, 2, 34, 5, 60008494);
    await insertAsset(db, CHARACTER_ID, 3, 35, 4);
    await insertStats(db, 34, 5); // 15 × 5 = 75
    await insertStats(db, 35, 100); // 4 × 100 = 400 → 排前

    const rows = await getAssetOverview(db, CHARACTER_ID);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      typeId: 35,
      quantity: 4,
      unitPrice: 100,
      estimatedValue: 400,
      locationCount: 1,
    });
    expect(rows[1]).toMatchObject({
      typeId: 34,
      quantity: 15,
      unitPrice: 5,
      estimatedValue: 75,
      locationCount: 2,
    });
  });

  it('getAssetOverview：无报价的物品 unitPrice 为 null、估值 0', async () => {
    const db = await createMigratedDb();
    await addCharacter(db, CHARACTER_ID, '一号');
    await insertAsset(db, CHARACTER_ID, 1, 99, 3);

    const rows = await getAssetOverview(db, CHARACTER_ID);

    expect(rows).toEqual([
      { typeId: 99, quantity: 3, unitPrice: null, estimatedValue: 0, locationCount: 1 },
    ]);
  });

  it('getAssetDetails：逐条返回并带位置信息，按估值倒序', async () => {
    const db = await createMigratedDb();
    await addCharacter(db, CHARACTER_ID, '一号');
    await insertAsset(db, CHARACTER_ID, 11, 34, 1, 60003760);
    await insertAsset(db, CHARACTER_ID, 12, 34, 10, 60008494);
    await insertStats(db, 34, 5);

    const rows = await getAssetDetails(db, CHARACTER_ID, 34);

    expect(rows.map((row) => row.itemId)).toEqual([12, 11]);
    expect(rows[0]).toMatchObject({
      itemId: 12,
      locationId: 60008494,
      locationFlag: 'Hangar',
      quantity: 10,
      estimatedValue: 50,
    });
  });
});
