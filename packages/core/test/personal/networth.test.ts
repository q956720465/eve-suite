import { describe, expect, it } from 'vitest';

import type { DbAdapter } from '../../src/db/types';
import { DEFAULT_VALUATION_REGION_ID } from '../../src/engines/valuation';
import {
  computeAccountNetWorth,
  computeNetWorth,
  listSnapshotSeries,
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

/** 同时写入最低卖价与 5% 分位（P4-1 估值口径用例需要） */
async function insertStatsFull(
  db: DbAdapter,
  typeId: number,
  bestSell: number | null,
  p5Sell: number | null,
): Promise<void> {
  await db.execute(
    `INSERT INTO market_stats (region_id, type_id, best_sell, p5_sell, updated_at)
     VALUES (?, ?, ?, ?, '2026-09-27T00:00:00Z')`,
    [JITA, typeId, bestSell, p5Sell],
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

/** 插入一条合同（默认：公开、个人、我发起） */
async function insertContract(
  db: DbAdapter,
  contractId: number,
  overrides: {
    characterId?: number;
    type?: string;
    status?: string;
    forCorporation?: number;
    issuerId?: number;
    acceptorId?: number;
    price?: number | null;
    reward?: number | null;
  } = {},
): Promise<void> {
  await db.execute(
    `INSERT INTO contracts (character_id, contract_id, type, status, availability, for_corporation,
                            issuer_id, issuer_corporation_id, assignee_id, acceptor_id,
                            date_issued, date_expired, price, reward, collateral, buyout, volume,
                            days_to_complete, start_location_id, end_location_id, fetched_at)
     VALUES (?, ?, ?, ?, 'public', ?, ?, 0, 0, ?, '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z',
             ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, '2026-09-27T00:00:00Z')`,
    [
      overrides.characterId ?? CHARACTER_ID,
      contractId,
      overrides.type ?? 'item_exchange',
      overrides.status ?? 'outstanding',
      overrides.forCorporation ?? 0,
      overrides.issuerId ?? CHARACTER_ID,
      overrides.acceptorId ?? 0,
      overrides.price ?? null,
      overrides.reward ?? null,
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

  it('P4-1 口径：资产按估算引擎 5% 分位计价，p5 缺失时回退最低卖价', async () => {
    const db = await setup(0);
    await insertAsset(db, 1, 34, 10); // p5 有值 → 4.25
    await insertAsset(db, 2, 35, 10); // 只有最低卖价 → 回退 2.5
    await insertAsset(db, 3, 99, 1); // 无报价 → 计 0
    await insertStatsFull(db, 34, 3.69, 4.25);
    await insertStatsFull(db, 35, 2.5, null);

    const result = await computeNetWorth(db, CHARACTER_ID);

    expect(result.assetsValue).toBe(67.5); // 10×4.25 + 10×2.5
    expect(result.distinctTypeCount).toBe(3);
    expect(result.missingPriceTypes).toBe(1);
  });

  it('P4-1 口径可指定：basis=best_sell 时按最低卖价计价（供对照）', async () => {
    const db = await setup(0);
    await insertAsset(db, 1, 34, 10);
    await insertAsset(db, 2, 35, 10);
    await insertStatsFull(db, 34, 3.69, 4.25);
    await insertStatsFull(db, 35, 2.5, null);

    const result = await computeNetWorth(db, CHARACTER_ID, { basis: 'best_sell' });

    expect(result.assetsValue).toBeCloseTo(61.9, 8); // 10×3.69 + 10×2.5
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
      missingTypeIds: [],
    });
  });

  it('缺价明细：missingTypeIds 列出无报价物品（与计数同源）', async () => {
    const db = await setup(0);
    await insertAsset(db, 1, 34, 10);
    await insertAsset(db, 2, 99, 1);
    await insertAsset(db, 3, 77, 1);
    await insertStats(db, 34, 5);

    const result = await computeNetWorth(db, CHARACTER_ID);

    expect(result.missingPriceTypes).toBe(2);
    expect(result.missingTypeIds).toEqual([77, 99]); // 按 type_id 升序（查询已 ORDER BY）
  });

  it('合同分项（P5-4 轻口径）：只计我发起且 outstanding 的 item_exchange 与我承接的 courier', async () => {
    const db = await setup(0);
    const other = 96099998;
    await insertContract(db, 1, { price: 5000 }); // 我发起 · item_exchange · outstanding → 计
    await insertContract(db, 2, { issuerId: other, price: 9999 }); // 非我发起 → 不计
    await insertContract(db, 3, { forCorporation: 1, price: 7777 }); // 公司合同 → 不计
    await insertContract(db, 4, { type: 'courier', acceptorId: CHARACTER_ID, reward: 300 }); // 我承接 courier → 计
    await insertContract(db, 5, { type: 'courier', acceptorId: other, reward: 999 }); // 非我承接 → 不计
    await insertContract(db, 6, { status: 'finished', price: 8888 }); // 已结算 → 不计
    await insertContract(db, 7, { type: 'auction', price: 1234 }); // auction → 不计
    await insertContract(db, 8, { price: null }); // 无价 → 0

    const result = await computeNetWorth(db, CHARACTER_ID);

    expect(result.contractsValue).toBe(5300); // 5000 + 300
    expect(result.totalValue).toBe(5300);
  });
});

describe('computeAccountNetWorth（跨角色合计）', () => {
  it('分项 = Σ 各角色分项；物品种类与缺价明细跨角色去重', async () => {
    const db = await setup(1000);
    const other = 96099997;
    await db.execute(
      'INSERT INTO characters (character_id, name, scopes, wallet_balance, added_at) VALUES (?, ?, ?, ?, ?)',
      [other, '另一角色', 'esi-assets.read_assets.v1', 2000, '2026-09-01T00:00:00Z'],
    );
    await insertStats(db, 34, 5);
    // 角色 A：34 × 10（有价） + 99 × 1（缺价）
    await insertAsset(db, 1, 34, 10);
    await insertAsset(db, 2, 99, 1);
    // 角色 B：34 × 4（同物品，去重后仍算 1 种） + 77 × 1（缺价）
    await db.execute(
      `INSERT INTO assets (character_id, item_id, type_id, quantity, location_id, location_flag,
                           location_type, is_singleton, fetched_at)
       VALUES (?, ?, ?, ?, 60003760, 'Hangar', 'station', 0, '2026-09-27T00:00:00Z')`,
      [other, 1, 34, 4],
    );
    await db.execute(
      `INSERT INTO assets (character_id, item_id, type_id, quantity, location_id, location_flag,
                           location_type, is_singleton, fetched_at)
       VALUES (?, ?, ?, ?, 60003760, 'Hangar', 'station', 0, '2026-09-27T00:00:00Z')`,
      [other, 2, 77, 1],
    );
    await insertContract(db, 1, { price: 500 }); // 仅角色 A 的合同

    const account = await computeAccountNetWorth(db, [CHARACTER_ID, other]);

    expect(account.characterIds).toEqual([CHARACTER_ID, other]);
    expect(account.characters).toHaveLength(2);
    expect(account.assetsValue).toBe(50 + 20); // (10×5) + (4×5)
    expect(account.walletBalance).toBe(3000);
    expect(account.contractsValue).toBe(500);
    expect(account.totalValue).toBe(account.assetsValue + account.walletBalance + account.sellOrdersValue + account.contractsValue);
    expect(account.distinctTypeCount).toBe(3); // 34 / 99 / 77
    expect(account.missingTypeIds).toEqual([99, 77]); // 跨角色去重、保持首次出现顺序
    expect(account.missingPriceTypes).toBe(2);
  });

  it('空角色列表：全部为 0 且不查库报错', async () => {
    const db = await setup(0);
    const account = await computeAccountNetWorth(db, []);
    expect(account.totalValue).toBe(0);
    expect(account.distinctTypeCount).toBe(0);
    expect(account.missingTypeIds).toEqual([]);
    expect(account.characters).toEqual([]);
  });

  it('基准透传：regionId 换到另一枢纽后资产估值随之变化', async () => {
    const db = await setup(0);
    const amarr = 10000043;
    await insertAsset(db, 1, 34, 10);
    await insertStats(db, 34, 5, JITA);
    await insertStats(db, 34, 9, amarr);

    const jita = await computeAccountNetWorth(db, [CHARACTER_ID], { regionId: JITA });
    const domain = await computeAccountNetWorth(db, [CHARACTER_ID], { regionId: amarr });

    expect(jita.assetsValue).toBe(50);
    expect(domain.assetsValue).toBe(90);
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

describe('listSnapshotSeries（折线图用升序序列）', () => {
  /** 自 START_AT 起连写 n 天快照（每天一条、日期递增） */
  async function writeDays(db: DbAdapter, days: number): Promise<void> {
    const clock = createFakeClock(START_AT);
    for (let index = 0; index < days; index += 1) {
      await writeDailySnapshot(db, CHARACTER_ID, { clock });
      clock.advance(24 * 60 * 60 * 1000);
    }
  }

  it('按日期升序返回，且与 listSnapshots 是同一集合的逆序', async () => {
    const db = await setup(500);
    await writeDays(db, 3);

    const series = await listSnapshotSeries(db, CHARACTER_ID);
    expect(series.map((row) => row.snapshotDate)).toEqual([
      '2026-09-27',
      '2026-09-28',
      '2026-09-29',
    ]);

    const table = await listSnapshots(db, CHARACTER_ID);
    expect(series.map((row) => row.snapshotDate)).toEqual(
      [...table].reverse().map((row) => row.snapshotDate),
    );
    // 数值字段原样透传（不因翻转而错位）
    expect(series[0].totalValue).toBe(table[table.length - 1].totalValue);
  });

  it('limit 取「最近 N 天」但仍为升序', async () => {
    const db = await setup(500);
    await writeDays(db, 4);

    const series = await listSnapshotSeries(db, CHARACTER_ID, 2);
    expect(series.map((row) => row.snapshotDate)).toEqual(['2026-09-29', '2026-09-30']);
  });

  it('limit ≤ 0 等价于全部', async () => {
    const db = await setup(500);
    await writeDays(db, 3);

    expect(await listSnapshotSeries(db, CHARACTER_ID, 0)).toHaveLength(3);
    expect(await listSnapshotSeries(db, CHARACTER_ID, -5)).toHaveLength(3);
  });

  it('无快照时返回空数组', async () => {
    const db = await setup(500);

    expect(await listSnapshotSeries(db, CHARACTER_ID)).toEqual([]);
  });
});
