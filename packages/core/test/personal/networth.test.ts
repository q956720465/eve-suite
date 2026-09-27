import { describe, expect, it } from 'vitest';

import type { DbAdapter } from '../../src/db/types';
import {
  computeNetWorth,
  DEFAULT_VALUATION_REGION_ID,
  listSnapshots,
  writeDailySnapshot,
} from '../../src/personal/networth';
import { createMigratedDb } from '../helpers/db';
import { createFakeClock } from '../helpers/fake-clock';
import { CHARACTER_ID } from './fixtures';

const JITA = DEFAULT_VALUATION_REGION_ID;
/** 2026-09-27T12:00:00Z */
const START_AT = Date.parse('2026-09-27T12:00:00Z');

async function setup(walletBalance = 1000): Promise<DbAdapter> {
  const db = await createMigratedDb();
  await db.execute(
    'INSERT INTO characters (character_id, name, scopes, wallet_balance, added_at) VALUES (?, ?, ?, ?, ?)',
    [CHARACTER_ID, '测试角色', 'esi-assets.read_assets.v1', walletBalance, '2026-09-01T00:00:00Z'],
  );
  return db;
}

async function insertAsset(
  db: DbAdapter,
  itemId: number,
  typeId: number,
  quantity: number,
  locationId = 60003760,
): Promise<void> {
  await db.execute(
    `INSERT INTO assets (character_id, item_id, type_id, quantity, location_id, location_flag,
                         location_type, is_singleton, fetched_at)
     VALUES (?, ?, ?, ?, ?, 'Hangar', 'station', 0, '2026-09-27T00:00:00Z')`,
    [CHARACTER_ID, itemId, typeId, quantity, locationId],
  );
}

async function insertStats(db: DbAdapter, typeId: number, bestSell: number | null, regionId = JITA): Promise<void> {
  await db.execute(
    `INSERT INTO market_stats (region_id, type_id, best_sell, updated_at) VALUES (?, ?, ?, ?)`,
    [regionId, typeId, bestSell, '2026-09-27T00:00:00Z'],
  );
}

async function insertOrder(
  db: DbAdapter,
  orderId: number,
  price: number,
  volumeRemain: number,
  isBuyOrder: boolean | null,
): Promise<void> {
  await db.execute(
    `INSERT INTO my_orders (character_id, order_id, type_id, region_id, location_id, price,
                            volume_total, volume_remain, is_corporation, duration, issued, range,
                            is_buy_order, fetched_at)
     VALUES (?, ?, 34, ?, 60003760, ?, 100, ?, 0, 90, '2026-09-01T00:00:00Z', 'station', ?, '2026-09-27T00:00:00Z')`,
    [
      CHARACTER_ID,
      orderId,
      JITA,
      price,
      volumeRemain,
      isBuyOrder === null ? null : isBuyOrder ? 1 : 0,
    ],
  );
}

describe('computeNetWorth', () => {
  it('四分项与合计：资产按基准区最低卖价，卖单按未成交量，卖单之外不计', async () => {
    const db = await setup(1000);
    await insertAsset(db, 1, 34, 10); // Tritanium
    await insertAsset(db, 2, 35, 4, 60003760);
    await insertAsset(db, 3, 35, 6, 60008494); // 另一地点同物品
    await insertStats(db, 34, 5); // 10 × 5 = 50
    await insertStats(db, 35, 2.5); // 10 × 2.5 = 25

    await insertOrder(db, 100, 100, 3, false); // 卖单：3 × 100 = 300
    await insertOrder(db, 101, 200, 5, true); // 买单：不计
    await insertOrder(db, 102, 50, 2, null); // is_buy_order 缺省 = 卖单：2 × 50 = 100

    const result = await computeNetWorth(db, CHARACTER_ID);

    expect(result.assetsValue).toBe(75);
    expect(result.walletBalance).toBe(1000);
    expect(result.sellOrdersValue).toBe(400);
    expect(result.contractsValue).toBe(0);
    expect(result.totalValue).toBe(1475);
    expect(result.distinctTypeCount).toBe(2);
    expect(result.missingPriceTypes).toBe(0);
  });

  it('缺价兜底：无市场报价的物品计 0 且计入 missingPriceTypes，不抛错', async () => {
    const db = await setup(0);
    await insertAsset(db, 1, 34, 10);
    await insertAsset(db, 2, 99, 5); // 无报价
    await insertStats(db, 34, 5);
    await insertStats(db, 99, null); // 有行但无卖价
    await insertStats(db, 77, 9, 10000043); // 其它区域的价格不参与（值也不该用）

    const result = await computeNetWorth(db, CHARACTER_ID);

    expect(result.assetsValue).toBe(50);
    expect(result.distinctTypeCount).toBe(2);
    expect(result.missingPriceTypes).toBe(1);
  });

  it('空角色：各项为 0，无资产也不报错', async () => {
    const db = await setup(0);
    const result = await computeNetWorth(db, CHARACTER_ID);
    expect(result).toEqual({
      characterId: CHARACTER_ID,
      totalValue: 0,
      assetsValue: 0,
      walletBalance: 0,
      sellOrdersValue: 0,
      contractsValue: 0,
      distinctTypeCount: 0,
      missingPriceTypes: 0,
    });
  });
});

describe('writeDailySnapshot / listSnapshots', () => {
  it('同日重复写入覆盖不新增；跨日新增一行', async () => {
    const db = await setup(500);
    await insertAsset(db, 1, 34, 10);
    await insertStats(db, 34, 3);
    const clock = createFakeClock(START_AT);

    const first = await writeDailySnapshot(db, CHARACTER_ID, { clock });
    expect(first.snapshotDate).toBe('2026-09-27');
    expect(first.totalValue).toBe(530);

    // 同日：钱包变化 → 覆盖同一行
    await db.execute('UPDATE characters SET wallet_balance = 800 WHERE character_id = ?', [
      CHARACTER_ID,
    ]);
    clock.advance(1_000);
    const second = await writeDailySnapshot(db, CHARACTER_ID, { clock });
    expect(second.totalValue).toBe(830);

    const sameDay = await listSnapshots(db, CHARACTER_ID);
    expect(sameDay).toHaveLength(1);
    expect(sameDay[0].totalValue).toBe(830);

    // 跨日：新增一行，倒序返回
    clock.advance(24 * 60 * 60 * 1000);
    await writeDailySnapshot(db, CHARACTER_ID, { clock });
    const rows = await listSnapshots(db, CHARACTER_ID);
    expect(rows.map((row) => row.snapshotDate)).toEqual(['2026-09-28', '2026-09-27']);
    expect(rows).toHaveLength(2);
  });

  it('快照按角色隔离', async () => {
    const db = await setup(100);
    const otherId = 96099999;
    await db.execute(
      'INSERT INTO characters (character_id, name, scopes, wallet_balance, added_at) VALUES (?, ?, ?, ?, ?)',
      [otherId, '另一角色', 'esi-assets.read_assets.v1', 999, '2026-09-01T00:00:00Z'],
    );
    const clock = createFakeClock(START_AT);

    await writeDailySnapshot(db, CHARACTER_ID, { clock });
    await writeDailySnapshot(db, otherId, { clock });

    const mine = await listSnapshots(db, CHARACTER_ID);
    const theirs = await listSnapshots(db, otherId);
    expect(mine[0].totalValue).toBe(100);
    expect(theirs[0].totalValue).toBe(999);
  });
});
