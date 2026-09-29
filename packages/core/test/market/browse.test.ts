import { describe, expect, it } from 'vitest';

import type { DbAdapter } from '../../src/db/types';
import {
  getMarketGroupPath,
  getMarketStationScope,
  getStationOrderBook,
  getStationTypeRow,
  listMarketGroupChildren,
  listMarketTypes,
  searchMarketTypes,
} from '../../src/market/browse';
import { createMigratedDb } from '../helpers/db';

const REGION = 10000002;
const FOREIGN_REGION = 10000001;
const STATION = 60003760;
/** 同区域另一站点：验证站点级隔离 */
const OTHER_STATION = 60003466;
/** 另一区域站点：验证区域级隔离 */
const FOREIGN_STATION = 60000001;
const UNKNOWN_STATION = 99999999;

/** 小组件 id */
const G_SHIP_ROOT = 1;
const G_FRIGATES = 10;
const G_STANDARD_FRIGATES = 100;
const G_FACTION_FRIGATES = 101;
/** 死枝：无子分组也无物品 */
const G_CRUISERS_DEAD = 11;
const G_MINERALS = 2;
/** 死枝根 */
const G_EMPTY_ROOT = 3;

async function seedStation(
  db: DbAdapter,
  stationId: number,
  regionId: number,
  nameEn: string,
  nameZh: string,
  systemNameZh: string,
  regionNameZh: string,
): Promise<void> {
  await db.execute(
    `INSERT INTO sde_stations
       (station_id, type_id, solar_system_id, region_id, owner_id, use_operation_name,
        name_en, name_zh, system_name_en, system_name_zh, region_name_en, region_name_zh)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
    [
      stationId,
      52678,
      30000142,
      regionId,
      1000035,
      nameEn,
      nameZh,
      'Jita',
      systemNameZh,
      'The Forge',
      regionNameZh,
    ],
  );
}

async function seedGroup(
  db: DbAdapter,
  marketGroupId: number,
  parentGroupId: number | null,
  nameEn: string,
  nameZh: string,
  iconId = 1443,
): Promise<void> {
  await db.execute(
    `INSERT INTO sde_market_groups
       (market_group_id, parent_group_id, name_en, name_zh, icon_id, has_types)
     VALUES (?, ?, ?, ?, ?, 0)`,
    [marketGroupId, parentGroupId, nameEn, nameZh, iconId],
  );
}

async function seedType(
  db: DbAdapter,
  input: {
    typeId: number;
    nameEn: string;
    nameZh: string;
    marketGroupId: number | null;
    published?: number;
    volume?: number;
  },
): Promise<void> {
  await db.execute(
    `INSERT INTO sde_types
       (type_id, group_id, name_en, name_zh, volume, packaged_volume, market_group_id, published)
     VALUES (?, 18, ?, ?, ?, 0.01, ?, ?)`,
    [
      input.typeId,
      input.nameEn,
      input.nameZh,
      input.volume ?? 1,
      input.marketGroupId,
      input.published ?? 1,
    ],
  );
}

async function seedOrder(
  db: DbAdapter,
  input: {
    orderId: number;
    typeId: number;
    price: number;
    isBuyOrder: boolean;
    volumeRemain?: number;
    stationId?: number;
    regionId?: number;
  },
): Promise<void> {
  await db.execute(
    `INSERT INTO market_orders
       (order_id, region_id, type_id, location_id, price, volume_total, volume_remain,
        min_volume, is_buy_order, duration, issued, range, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 90, '2026-09-29T00:00:00Z', 'region', '2026-09-29T00:00:00Z')`,
    [
      input.orderId,
      input.regionId ?? REGION,
      input.typeId,
      input.stationId ?? STATION,
      input.price,
      input.volumeRemain ?? 100,
      input.volumeRemain ?? 100,
      input.isBuyOrder ? 1 : 0,
    ],
  );
}

/**
 * 小型市场树：
 * ```
 * 1  舰船 Ships                    （根，内容全在后代）
 *  10 护卫舰 Frigates
 *    100 标准护卫舰 Standard Frigates
 *    101 势力护卫舰 Faction Frigates
 *  11 巡洋舰 Cruisers              （死枝）
 * 2  矿物 Minerals                 （根，直接挂物品）
 *  3 空根 Empty Root               （死枝根）
 * ```
 */
async function setup(): Promise<DbAdapter> {
  const db = await createMigratedDb();

  await seedStation(db, STATION, REGION, 'Jita IV - Moon 4 - Caldari Navy Assembly Plant', '吉他 IV - 卫星 4 - 加达里海军 组装车间', '吉他', '伏尔戈');
  await seedStation(db, OTHER_STATION, REGION, 'Jita IV - Moon 4 - Caldari Business Tribunal', '吉他 IV - 卫星 4 - 商业法庭', '吉他', '伏尔戈');
  await seedStation(db, FOREIGN_STATION, FOREIGN_REGION, 'Amarr VIII (Oris) - Emperor Family Academy', '艾玛 VIII - 皇帝家族学院', '艾玛', '多美');

  await seedGroup(db, G_SHIP_ROOT, null, 'Ships', '舰船');
  await seedGroup(db, G_FRIGATES, G_SHIP_ROOT, 'Frigates', '护卫舰');
  await seedGroup(db, G_STANDARD_FRIGATES, G_FRIGATES, 'Standard Frigates', '标准护卫舰');
  await seedGroup(db, G_FACTION_FRIGATES, G_FRIGATES, 'Faction Frigates', '势力护卫舰');
  await seedGroup(db, G_CRUISERS_DEAD, G_SHIP_ROOT, 'Cruisers', '巡洋舰');
  await seedGroup(db, G_MINERALS, null, 'Minerals', '矿物');
  await seedGroup(db, G_EMPTY_ROOT, null, 'Empty Root', '空根');

  await seedType(db, { typeId: 34, nameEn: 'Tritanium', nameZh: '三钛合金', marketGroupId: G_MINERALS, volume: 0.01 });
  await seedType(db, { typeId: 35, nameEn: 'Pyerite', nameZh: '类晶体胶矿', marketGroupId: G_MINERALS, volume: 0.01 });
  // 名称包含 Tritanium → 用于验证「精确匹配优先」
  await seedType(db, { typeId: 700, nameEn: 'Tritanium Rich', nameZh: '富三钛合金', marketGroupId: G_MINERALS, volume: 0.01 });
  // 未发布 → 不进市场
  await seedType(db, { typeId: 36, nameEn: 'Mexallon', nameZh: '同位聚合体', marketGroupId: G_MINERALS, published: 0 });
  // 无市场分组 → 不进市场
  await seedType(db, { typeId: 37, nameEn: 'Unassigned Thing', nameZh: '未归类物品', marketGroupId: null });

  await seedType(db, { typeId: 600, nameEn: 'Rifter', nameZh: '裂谷级', marketGroupId: G_STANDARD_FRIGATES, volume: 27289 });
  await seedType(db, { typeId: 601, nameEn: 'Slasher', nameZh: '鞭挞级', marketGroupId: G_STANDARD_FRIGATES, volume: 27289 });
  await seedType(db, { typeId: 602, nameEn: 'Vigil', nameZh: '守夜级', marketGroupId: G_STANDARD_FRIGATES, volume: 27289 });
  await seedType(db, { typeId: 604, nameEn: 'Merlin', nameZh: '小鹰级', marketGroupId: G_STANDARD_FRIGATES, volume: 27289 });
  await seedType(db, { typeId: 603, nameEn: 'Firetail', nameZh: '火尾级', marketGroupId: G_FACTION_FRIGATES, volume: 27289 });

  // 吉他 4-4
  await seedOrder(db, { orderId: 9001, typeId: 34, price: 5, isBuyOrder: false, volumeRemain: 1000 });
  await seedOrder(db, { orderId: 9002, typeId: 34, price: 5.5, isBuyOrder: false, volumeRemain: 200 });
  await seedOrder(db, { orderId: 9003, typeId: 34, price: 4.5, isBuyOrder: true, volumeRemain: 300 });
  await seedOrder(db, { orderId: 9004, typeId: 600, price: 500000, isBuyOrder: false, volumeRemain: 2 });
  await seedOrder(db, { orderId: 9005, typeId: 600, price: 480000, isBuyOrder: true, volumeRemain: 1 });
  // 未发布物品的订单：不应被任何查询统计到
  await seedOrder(db, { orderId: 9008, typeId: 36, price: 1, isBuyOrder: false, volumeRemain: 7 });
  // 同区域另一站点 / 另一区域 → 都不应计入 STATION
  await seedOrder(db, { orderId: 9006, typeId: 34, price: 9.9, isBuyOrder: false, volumeRemain: 99, stationId: OTHER_STATION });
  await seedOrder(db, { orderId: 9007, typeId: 34, price: 8.8, isBuyOrder: false, volumeRemain: 77, stationId: FOREIGN_STATION, regionId: FOREIGN_REGION });

  return db;
}

describe('市场浏览 · 左树', () => {
  it('根层：只返回有效分组，死枝根被隐藏，childCount 与展开结果一致', async () => {
    const db = await setup();
    const roots = await listMarketGroupChildren(db, null);

    expect(roots.map((row) => row.marketGroupId)).toEqual([G_MINERALS, G_SHIP_ROOT]);
    expect(roots[0]).toEqual({
      marketGroupId: G_MINERALS,
      parentGroupId: null,
      nameEn: 'Minerals',
      nameZh: '矿物',
      iconId: 1443,
      // 只有 34/35/700 已发布；36 未发布、37 无分组
      typeCount: 3,
      childCount: 0,
    });
    // 舰船的物品全在后代；死枝「巡洋舰」不计入 childCount
    expect(roots[1].childCount).toBe(1);
    expect(roots[1].typeCount).toBe(0);
  });

  it('第二层：死枝不出现，且 childCount ⟺ 展开后必有内容', async () => {
    const db = await setup();
    const children = await listMarketGroupChildren(db, G_SHIP_ROOT);

    expect(children.map((row) => row.marketGroupId)).toEqual([G_FRIGATES]);
    expect(children[0].childCount).toBe(2);
    expect(children[0].typeCount).toBe(0);

    // 逐层展开到底 == childCount 所承诺的内容量
    const third = await listMarketGroupChildren(db, G_FRIGATES);
    // 势(52BF) < 标(6807)：同一套码点序
    expect(third.map((row) => row.nameZh)).toEqual(['势力护卫舰', '标准护卫舰']);
    expect(third.map((row) => row.marketGroupId)).toEqual([
      G_FACTION_FRIGATES,
      G_STANDARD_FRIGATES,
    ]);
    expect(third.every((row) => row.childCount === 0)).toBe(true);
  });

  it('路径：根→自身；不存在的分组返回空数组', async () => {
    const db = await setup();

    const path = await getMarketGroupPath(db, G_STANDARD_FRIGATES);
    expect(path.map((node) => [node.marketGroupId, node.nameZh])).toEqual([
      [G_SHIP_ROOT, '舰船'],
      [G_FRIGATES, '护卫舰'],
      [G_STANDARD_FRIGATES, '标准护卫舰'],
    ]);

    expect(await getMarketGroupPath(db, 9999)).toEqual([]);
  });
});

describe('市场浏览 · 中列', () => {
  it('子树语义：选中分组包含其全部后代分组的物品', async () => {
    const db = await setup();
    const list = await listMarketTypes(db, { marketGroupId: G_SHIP_ROOT, stationId: STATION });

    expect(list.total).toBe(5);
    expect(list.rows.map((row) => row.typeId).sort((a, b) => a - b)).toEqual([
      600, 601, 602, 603, 604,
    ]);
  });

  it('只返回市场可见物品：未发布与无分组的不出现', async () => {
    const db = await setup();
    const list = await listMarketTypes(db, { marketGroupId: G_MINERALS, stationId: STATION });

    // 34 / 35 / 700；排除未发布的 36。排序：三(4E09) < 富(5BCC) < 类(7C7B)
    expect(list.total).toBe(3);
    expect(list.rows.map((row) => row.nameZh)).toEqual(['三钛合金', '富三钛合金', '类晶体胶矿']);
    expect(list.rows.map((row) => row.typeId)).toEqual([34, 700, 35]);
  });

  it('中列行带所属市场分组名（供「分组」列展示）', async () => {
    const db = await setup();

    const list = await listMarketTypes(db, { marketGroupId: G_SHIP_ROOT, stationId: STATION });
    // 子树内的物品各带自己所属子分组名，而非选中分组
    expect(list.rows.map((row) => row.marketGroupNameZh).sort()).toEqual([
      '势力护卫舰',
      '标准护卫舰',
      '标准护卫舰',
      '标准护卫舰',
      '标准护卫舰',
    ]);

    // 单物品行同口径
    const row = await getStationTypeRow(db, STATION, 600);
    expect(row).toMatchObject({
      marketGroupId: G_STANDARD_FRIGATES,
      marketGroupNameEn: 'Standard Frigates',
      marketGroupNameZh: '标准护卫舰',
    });
  });

  it('站点报价聚合：最低卖价 / 最高买价 / 量与条数，且不串站点与区域', async () => {
    const db = await setup();
    const list = await listMarketTypes(db, { marketGroupId: G_MINERALS, stationId: STATION });
    const trit = list.rows.find((row) => row.typeId === 34);

    expect(trit).toMatchObject({
      bestSell: 5,
      bestBuy: 4.5,
      sellVolume: 1200,
      buyVolume: 300,
      sellOrders: 2,
      buyOrders: 1,
    });

    // 无订单物品：价格为空、量为 0，但默认仍出现在列表里
    const pyerite = list.rows.find((row) => row.typeId === 35);
    expect(pyerite).toMatchObject({ bestSell: null, bestBuy: null, sellVolume: 0, buyVolume: 0 });

    // 同区域另一站点：只看到自己的那一档
    const other = await getStationTypeRow(db, OTHER_STATION, 34);
    expect(other).toMatchObject({ bestSell: 9.9, bestBuy: null, sellVolume: 99, sellOrders: 1 });

    // 未发布物品的订单不被统计
    expect(await getStationTypeRow(db, STATION, 36)).toBeNull();
  });

  it('onlyWithOrders：剔除所选站点无报价的物品', async () => {
    const db = await setup();

    const all = await listMarketTypes(db, {
      marketGroupId: G_STANDARD_FRIGATES,
      stationId: STATION,
    });
    expect(all.total).toBe(4);

    const priced = await listMarketTypes(db, {
      marketGroupId: G_STANDARD_FRIGATES,
      stationId: STATION,
      onlyWithOrders: true,
    });
    expect(priced.total).toBe(1);
    expect(priced.rows.map((row) => row.typeId)).toEqual([600]);
  });

  it('分页：total 不受 limit 影响，逐页取完不重不漏', async () => {
    const db = await setup();
    const base = { marketGroupId: G_STANDARD_FRIGATES, stationId: STATION };

    const page1 = await listMarketTypes(db, { ...base, limit: 2, offset: 0 });
    const page2 = await listMarketTypes(db, { ...base, limit: 2, offset: 2 });
    const beyond = await listMarketTypes(db, { ...base, limit: 2, offset: 99 });

    expect(page1.total).toBe(4);
    expect(page2.total).toBe(4);
    expect(page1.rows).toHaveLength(2);
    expect(page2.rows).toHaveLength(2);
    expect(beyond.rows).toHaveLength(0);
    // total 与 limit/offset 无关（越界时也能拿到 4，供界面钳制页码）
    expect(beyond.total).toBe(4);

    const ids = [...page1.rows, ...page2.rows].map((row) => row.typeId);
    expect(new Set(ids).size).toBe(4);

    // limit 下限钳到 1，上限钳到 1000
    expect((await listMarketTypes(db, { ...base, limit: 0 })).rows).toHaveLength(1);
    expect((await listMarketTypes(db, { ...base, limit: 99_999 })).rows).toHaveLength(4);
  });

  it('排序：默认显示名升序（中文按码点，非拼音）；价格排序时 null 恒排最后', async () => {
    const db = await setup();

    const byName = await listMarketTypes(db, {
      marketGroupId: G_STANDARD_FRIGATES,
      stationId: STATION,
    });
    // 守(5B88) < 小(5C0F) < 裂(88C2) < 鞭(97ED)：SQLite 默认码点序
    expect(byName.rows.map((row) => row.nameZh)).toEqual([
      '守夜级',
      '小鹰级',
      '裂谷级',
      '鞭挞级',
    ]);

    const asc = await listMarketTypes(db, {
      marketGroupId: G_SHIP_ROOT,
      stationId: STATION,
      sortBy: 'bestSell',
    });
    const desc = await listMarketTypes(db, {
      marketGroupId: G_SHIP_ROOT,
      stationId: STATION,
      sortBy: 'bestSell',
      sortDir: 'desc',
    });

    // 只有 600 有报价 —— 升序与降序都排第一，无报价的恒在最后
    expect(asc.rows[0].typeId).toBe(600);
    expect(asc.rows.slice(1).every((row) => row.bestSell === null)).toBe(true);
    expect(desc.rows[0].typeId).toBe(600);
    expect(desc.rows.slice(1).every((row) => row.bestSell === null)).toBe(true);
  });
});

describe('市场浏览 · 搜索', () => {
  it('中英文名命中，带分组归属与站点报价；精确匹配优先', async () => {
    const db = await setup();

    const zh = await searchMarketTypes(db, { query: '裂谷', stationId: STATION });
    expect(zh.total).toBe(1);
    expect(zh.rows[0]).toMatchObject({
      typeId: 600,
      marketGroupId: G_STANDARD_FRIGATES,
      marketGroupNameZh: '标准护卫舰',
      bestSell: 500000,
      bestBuy: 480000,
    });

    // SQLite LIKE 对 ASCII 大小写不敏感
    const en = await searchMarketTypes(db, { query: 'rifter', stationId: STATION });
    expect(en.rows.map((row) => row.typeId)).toEqual([600]);

    const partial = await searchMarketTypes(db, { query: 'Tritanium', stationId: STATION });
    expect(partial.total).toBe(2);
    expect(partial.rows.map((row) => row.typeId)).toEqual([34, 700]);
  });

  it('搜索也受市场可见性约束：未发布 / 无分组 / 空查询', async () => {
    const db = await setup();

    expect((await searchMarketTypes(db, { query: 'Mexallon', stationId: STATION })).total).toBe(0);
    expect((await searchMarketTypes(db, { query: 'Unassigned', stationId: STATION })).total).toBe(0);
    expect(await searchMarketTypes(db, { query: '   ', stationId: UNKNOWN_STATION })).toEqual({
      total: 0,
      rows: [],
    });
  });
});

describe('市场浏览 · 订单簿与站点范围', () => {
  it('订单簿：卖价升序 / 买价降序取档位，条数为全量', async () => {
    const db = await setup();

    const book = await getStationOrderBook(db, STATION, 34);
    expect(book.sells.map((entry) => entry.price)).toEqual([5, 5.5]);
    expect(book.buys.map((entry) => entry.price)).toEqual([4.5]);
    expect(book.sellOrderCount).toBe(2);
    expect(book.buyOrderCount).toBe(1);

    const topOnly = await getStationOrderBook(db, STATION, 34, 1);
    expect(topOnly.sells).toHaveLength(1);
    expect(topOnly.sells[0].orderId).toBe(9001);
    // 条数仍是全量，不因取档位而变
    expect(topOnly.sellOrderCount).toBe(2);

    const empty = await getStationOrderBook(db, STATION, 35);
    expect(empty).toEqual({ sells: [], buys: [], sellOrderCount: 0, buyOrderCount: 0 });
  });

  it('站点范围：解析区域与属地名称；未收录返回 null', async () => {
    const db = await setup();

    expect(await getMarketStationScope(db, STATION)).toEqual({
      stationId: STATION,
      regionId: REGION,
      nameEn: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant',
      nameZh: '吉他 IV - 卫星 4 - 加达里海军 组装车间',
      systemNameEn: 'Jita',
      systemNameZh: '吉他',
      regionNameEn: 'The Forge',
      regionNameZh: '伏尔戈',
    });
    expect(await getMarketStationScope(db, UNKNOWN_STATION)).toBeNull();
  });

  it('未收录站点：fail fast，不静默返回空结果', async () => {
    const db = await setup();

    await expect(getStationOrderBook(db, UNKNOWN_STATION, 34)).rejects.toThrow(/未收录/);
    await expect(
      listMarketTypes(db, { marketGroupId: G_MINERALS, stationId: UNKNOWN_STATION }),
    ).rejects.toThrow(/未收录/);
    await expect(
      searchMarketTypes(db, { query: 'Tritanium', stationId: UNKNOWN_STATION }),
    ).rejects.toThrow(/未收录/);
  });
});
