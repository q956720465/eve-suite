import type { DbAdapter } from '../../src/db/types';

export const CEP_FORCE = 1000125;
export const AMARR_NAVY = 1000120;

export interface LpOfferInput {
  offerId: number;
  corporationId?: number;
  /** 一次兑换产出的物品 */
  typeId: number;
  quantity?: number;
  lpCost: number;
  iskCost?: number;
  akCost?: number;
  requiredItems?: readonly { typeId: number; quantity: number }[];
}

/** 插入一条 LP 报价（含所需材料） */
export async function insertLpOffer(db: DbAdapter, input: LpOfferInput): Promise<void> {
  const corporationId = input.corporationId ?? CEP_FORCE;
  await db.execute(
    `INSERT INTO lp_offers (offer_id, corporation_id, type_id, quantity, lp_cost, isk_cost, ak_cost, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '2026-09-28T00:00:00Z')`,
    [
      input.offerId,
      corporationId,
      input.typeId,
      input.quantity ?? 1,
      input.lpCost,
      input.iskCost ?? 0,
      input.akCost ?? 0,
    ],
  );
  for (const item of input.requiredItems ?? []) {
    await db.execute(
      `INSERT INTO lp_offer_items (corporation_id, offer_id, type_id, quantity) VALUES (?, ?, ?, ?)`,
      [corporationId, input.offerId, item.typeId, item.quantity],
    );
  }
}

/** 插入角色在某军团的 LP 余额 */
export async function insertLpBalance(
  db: DbAdapter,
  characterId: number,
  corporationId: number,
  loyaltyPoints: number,
): Promise<void> {
  await db.execute(
    `INSERT INTO lp_balances (character_id, corporation_id, loyalty_points, fetched_at)
     VALUES (?, ?, ?, '2026-09-28T00:00:00Z')`,
    [characterId, corporationId, loyaltyPoints],
  );
}
