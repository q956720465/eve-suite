import type { DbAdapter } from '../db/types';
import type { LpStoreOffer } from '../esi/types';
import { insertRows } from '../sde/batch';

/** LP 报价（含所需兑换材料），供比价引擎与界面使用 */
export interface LpOfferRecord {
  offerId: number;
  corporationId: number;
  /** 一次兑换产出的物品 */
  typeId: number;
  quantity: number;
  lpCost: number;
  iskCost: number;
  /** CONCORD LP 需求（与军团 LP 不同源，默认口径下跳过） */
  akCost: number;
  requiredItems: { typeId: number; quantity: number }[];
}

/** 每军团抓取水位 */
export interface LpStoreState {
  corporationId: number;
  lastStartedAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  expiresAt: string | null;
  etag: string | null;
  offersWritten: number;
  requests: number;
}

/** 角色在各军团的 LP 余额（来自 P3 同步的 lp_balances） */
export interface LpBalance {
  corporationId: number;
  loyaltyPoints: number;
  fetchedAt: string;
}

export const LP_OFFER_COLUMNS: readonly string[] = [
  'corporation_id',
  'offer_id',
  'type_id',
  'quantity',
  'lp_cost',
  'isk_cost',
  'ak_cost',
  'fetched_at',
];

export const LP_OFFER_ITEM_COLUMNS: readonly string[] = [
  'corporation_id',
  'offer_id',
  'type_id',
  'quantity',
];

/** 某角色有 LP 余额的军团（去重）——LP 商店默认抓取范围 */
export async function listCorporationIdsWithLp(
  db: DbAdapter,
  characterId: number,
): Promise<number[]> {
  const rows = await db.select<{ corporationId: number }>(
    `SELECT DISTINCT corporation_id AS corporationId
       FROM lp_balances
      WHERE character_id = ? AND loyalty_points > 0
      ORDER BY corporation_id`,
    [characterId],
  );
  return rows.map((row) => row.corporationId);
}

/** 角色在各军团的 LP 余额 */
export async function listLpBalances(db: DbAdapter, characterId: number): Promise<LpBalance[]> {
  const rows = await db.select<{ corporationId: number; loyaltyPoints: number; fetchedAt: string }>(
    `SELECT corporation_id  AS corporationId,
            loyalty_points  AS loyaltyPoints,
            fetched_at      AS fetchedAt
       FROM lp_balances
      WHERE character_id = ? AND loyalty_points > 0
      ORDER BY loyalty_points DESC`,
    [characterId],
  );
  return rows;
}

/** 某军团的报价清单（含所需材料） */
export async function listLpOffers(
  db: DbAdapter,
  corporationId: number,
): Promise<LpOfferRecord[]> {
  const offers = await db.select<{
    offerId: number;
    corporationId: number;
    typeId: number;
    quantity: number;
    lpCost: number;
    iskCost: number;
    akCost: number;
  }>(
    `SELECT offer_id       AS offerId,
            corporation_id AS corporationId,
            type_id        AS typeId,
            quantity       AS quantity,
            lp_cost        AS lpCost,
            isk_cost       AS iskCost,
            ak_cost        AS akCost
       FROM lp_offers
      WHERE corporation_id = ?
      ORDER BY lp_cost, offer_id`,
    [corporationId],
  );
  if (offers.length === 0) return [];

  const items = await db.select<{ offerId: number; typeId: number; quantity: number }>(
    `SELECT i.offer_id AS offerId, i.type_id AS typeId, i.quantity AS quantity
       FROM lp_offer_items i
      WHERE i.corporation_id = ?
      ORDER BY i.offer_id, i.type_id`,
    [corporationId],
  );
  const byOffer = new Map<number, { typeId: number; quantity: number }[]>();
  for (const item of items) {
    const list = byOffer.get(item.offerId);
    if (list === undefined) byOffer.set(item.offerId, [{ typeId: item.typeId, quantity: item.quantity }]);
    else list.push({ typeId: item.typeId, quantity: item.quantity });
  }

  return offers.map((offer) => ({ ...offer, requiredItems: byOffer.get(offer.offerId) ?? [] }));
}

const STATE_SELECT = `SELECT corporation_id  AS corporationId,
                             last_started_at AS lastStartedAt,
                             last_ok_at      AS lastOkAt,
                             last_error      AS lastError,
                             expires_at      AS expiresAt,
                             etag            AS etag,
                             offers_written  AS offersWritten,
                             requests        AS requests
                        FROM lp_store_state`;

/** 各军团抓取水位 */
export async function listLpStoreStates(db: DbAdapter): Promise<LpStoreState[]> {
  return db.select<LpStoreState>(`${STATE_SELECT} ORDER BY corporation_id`);
}

/** 单军团抓取水位（无记录时返回 null） */
export async function getLpStoreState(
  db: DbAdapter,
  corporationId: number,
): Promise<LpStoreState | null> {
  const rows = await db.select<LpStoreState>(`${STATE_SELECT} WHERE corporation_id = ?`, [
    corporationId,
  ]);
  return rows[0] ?? null;
}

/**
 * 覆盖写入某军团的全部报价（单事务先删后插，读侧不会看到半成品）。
 * 返回写入的报价行数。
 */
export async function replaceStoreOffers(
  db: DbAdapter,
  corporationId: number,
  offers: readonly LpStoreOffer[],
  fetchedAt: string,
): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute('DELETE FROM lp_offer_items WHERE corporation_id = ?', [corporationId]);
    await tx.execute('DELETE FROM lp_offers WHERE corporation_id = ?', [corporationId]);

    const offerRows = offers.map((offer) => [
      corporationId,
      offer.offer_id,
      offer.type_id,
      offer.quantity,
      offer.lp_cost,
      offer.isk_cost,
      offer.ak_cost,
      fetchedAt,
    ]);
    const itemRows: unknown[][] = [];
    for (const offer of offers) {
      for (const item of offer.required_items ?? []) {
        itemRows.push([corporationId, offer.offer_id, item.type_id, item.quantity]);
      }
    }

    let written = await insertRows(tx, 'lp_offers', LP_OFFER_COLUMNS, offerRows);
    written += await insertRows(tx, 'lp_offer_items', LP_OFFER_ITEM_COLUMNS, itemRows);
    return written;
  });
}

/** 标记抓取开始（水位行不存在则插入） */
export async function markStoreStarted(
  db: DbAdapter,
  corporationId: number,
  at: string,
): Promise<void> {
  await db.execute(
    `INSERT INTO lp_store_state (corporation_id, last_started_at) VALUES (?, ?)
     ON CONFLICT(corporation_id) DO UPDATE SET last_started_at = excluded.last_started_at`,
    [corporationId, at],
  );
}

export interface StoreOkPatch {
  etag?: string | undefined;
  expiresAt: string | null;
  offersWritten: number;
  requests: number;
}

/** 标记抓取成功（写水位 + ETag + 到期时间；不动 last_error 之外的字段语义） */
export async function markStoreOk(
  db: DbAdapter,
  corporationId: number,
  patch: StoreOkPatch,
  at: string,
): Promise<void> {
  await db.execute(
    `INSERT INTO lp_store_state (corporation_id, last_ok_at, last_error, expires_at, etag, offers_written, requests)
     VALUES (?, ?, NULL, ?, ?, ?, ?)
     ON CONFLICT(corporation_id) DO UPDATE SET
       last_ok_at      = excluded.last_ok_at,
       last_error      = NULL,
       expires_at      = excluded.expires_at,
       etag            = COALESCE(excluded.etag, lp_store_state.etag),
       offers_written  = excluded.offers_written,
       requests        = excluded.requests`,
    [corporationId, at, patch.expiresAt, patch.etag ?? null, patch.offersWritten, patch.requests],
  );
}

/** 标记抓取失败（只写错误，保留 last_ok_at 与既有数据） */
export async function markStoreError(
  db: DbAdapter,
  corporationId: number,
  message: string,
): Promise<void> {
  await db.execute(
    `INSERT INTO lp_store_state (corporation_id, last_error) VALUES (?, ?)
     ON CONFLICT(corporation_id) DO UPDATE SET last_error = excluded.last_error`,
    [corporationId, message],
  );
}
