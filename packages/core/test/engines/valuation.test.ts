import { describe, expect, it } from 'vitest';

import {
  DEFAULT_VALUATION_BASIS,
  DEFAULT_VALUATION_REGION_ID,
  filterOutlierPrices,
  getValuationPrice,
  priceFromSellLevels,
  priceFromSellPrices,
  valueItems,
  valueQuantity,
} from '../../src/engines/valuation';
import { createMigratedDb } from '../helpers/db';
import { AMARR, insertSellOrders, insertStats, JITA, JITA_44, JITA_OTHER } from './fixtures';

describe('默认口径常量', () => {
  it('默认基准为吉他，默认口径为 5% 分位', () => {
    expect(DEFAULT_VALUATION_REGION_ID).toBe(JITA);
    expect(DEFAULT_VALUATION_BASIS).toBe('p5_sell');
  });
});

describe('聚合指标快路径（market_stats）', () => {
  it('默认取 p5_sell 并标记来源 stats', async () => {
    const db = await createMigratedDb();
    await insertStats(db, { typeId: 34, bestSell: 3.69, p5Sell: 3.762 });

    const result = await getValuationPrice(db, 34);

    expect(result.price).toBe(3.762);
    expect(result.source).toBe('stats');
    expect(result.effectiveBasis).toBe('p5_sell');
    expect(result.basis).toBe('p5_sell');
    expect(result.regionId).toBe(JITA);
    expect(result.stationId).toBeNull();
  });

  it('指定 best_sell 口径时取最低卖价', async () => {
    const db = await createMigratedDb();
    await insertStats(db, { typeId: 34, bestSell: 3.69, p5Sell: 3.762 });

    const result = await getValuationPrice(db, 34, { basis: 'best_sell' });

    expect(result.price).toBe(3.69);
    expect(result.source).toBe('stats');
    expect(result.effectiveBasis).toBe('best_sell');
  });

  it('主口径缺失时回退到另一口径并标记 fallback', async () => {
    const db = await createMigratedDb();
    await insertStats(db, { typeId: 35, bestSell: 5, p5Sell: null });

    const result = await getValuationPrice(db, 35);

    expect(result.price).toBe(5);
    expect(result.source).toBe('fallback');
    expect(result.effectiveBasis).toBe('best_sell');
  });

  it('反向回退同样成立（basis=best_sell 时用 p5_sell 兜底）', async () => {
    const db = await createMigratedDb();
    await insertStats(db, { typeId: 36, bestSell: null, p5Sell: 8 });

    const result = await getValuationPrice(db, 36, { basis: 'best_sell' });

    expect(result.price).toBe(8);
    expect(result.source).toBe('fallback');
    expect(result.effectiveBasis).toBe('p5_sell');
  });

  it('无报价：无行 / 两列皆空 / 非正价格 → price null 且来源 missing', async () => {
    const db = await createMigratedDb();
    await insertStats(db, { typeId: 36, bestSell: null, p5Sell: null });
    await insertStats(db, { typeId: 37, bestSell: -1, p5Sell: 0 });

    for (const typeId of [99, 36, 37]) {
      const result = await getValuationPrice(db, typeId);
      expect(result.price).toBeNull();
      expect(result.source).toBe('missing');
      expect(result.effectiveBasis).toBeNull();
    }
  });

  it('基准区域隔离：他区有价、本区无行时不计价', async () => {
    const db = await createMigratedDb();
    await insertStats(db, { typeId: 34, regionId: AMARR, bestSell: 5, p5Sell: 6 });

    expect((await getValuationPrice(db, 34)).price).toBeNull();
    expect((await getValuationPrice(db, 34, { regionId: AMARR })).price).toBe(6);
  });
});

describe('订单簿精确路径（站点级基准）', () => {
  it('按站点过滤订单后取 5% 分位（含奇数/偶数/单样本样本量）', async () => {
    const db = await createMigratedDb();
    await insertSellOrders(db, 100, [10, 20, 30, 40, 50], { firstOrderId: 1000 });
    await insertSellOrders(db, 101, [10, 20, 30, 40], { firstOrderId: 2000 });
    await insertSellOrders(db, 102, [7], { firstOrderId: 3000 });
    // 同物品在另一站点的高价单不参与
    await insertSellOrders(db, 100, [900], { locationId: JITA_OTHER, firstOrderId: 4000 });

    expect((await getValuationPrice(db, 100, { stationId: JITA_44 })).price).toBeCloseTo(12, 10);
    expect((await getValuationPrice(db, 101, { stationId: JITA_44 })).price).toBeCloseTo(11.5, 10);
    expect((await getValuationPrice(db, 102, { stationId: JITA_44 })).price).toBe(7);
  });

  it('站点级 basis=best_sell 取该站点最低卖价，来源为 orders', async () => {
    const db = await createMigratedDb();
    await insertSellOrders(db, 100, [10, 20, 30], { firstOrderId: 1000 });

    const result = await getValuationPrice(db, 100, { stationId: JITA_44, basis: 'best_sell' });

    expect(result.price).toBe(10);
    expect(result.source).toBe('orders');
    expect(result.effectiveBasis).toBe('best_sell');
    expect(result.stationId).toBe(JITA_44);
  });

  it('站点级无该物品订单时不回退区域价（基准是显式指定的）', async () => {
    const db = await createMigratedDb();
    await insertStats(db, { typeId: 103, bestSell: 8, p5Sell: 9 });

    const result = await getValuationPrice(db, 103, { stationId: JITA_44 });

    expect(result.price).toBeNull();
    expect(result.source).toBe('missing');
  });

  it('买单不参与卖价口径', async () => {
    const db = await createMigratedDb();
    await insertSellOrders(db, 104, [10], { firstOrderId: 5000 });
    await db.execute(
      `INSERT INTO market_orders (order_id, region_id, type_id, location_id, price, volume_total,
                                  volume_remain, min_volume, is_buy_order, duration, issued, range, fetched_at)
       VALUES (6000, ?, 104, ?, 999, 100, 100, 1, 1, 90, '2026-09-01T00:00:00Z', 'station', '2026-09-27T00:00:00Z')`,
      [JITA, JITA_44],
    );

    expect((await getValuationPrice(db, 104, { stationId: JITA_44 })).price).toBe(10);
  });

  it('站点级同口径排除整批大单（min_volume > 1）', async () => {
    const db = await createMigratedDb();
    await insertSellOrders(db, 105, [10, 20, 30], { firstOrderId: 6000 });
    await insertSellOrders(db, 105, [1], { firstOrderId: 7000, minVolume: 10_000 });

    const p5 = await getValuationPrice(db, 105, { stationId: JITA_44 });
    expect(p5.source).toBe('orders');
    expect(p5.price).toBeCloseTo(11, 10); // [10,20,30] → (3-1)×0.05 = 0.1 → 10 + 10×0.1；未过滤时为 1 + 9×0.15 = 2.35

    const best = await getValuationPrice(db, 105, { stationId: JITA_44, basis: 'best_sell' });
    expect(best.price).toBe(10); // 未过滤时为 1
  });

  it('站点级仅剩整批大单时不回退区域价（该站点无 1 单位可成交价）', async () => {
    const db = await createMigratedDb();
    await insertStats(db, { typeId: 106, bestSell: 8, p5Sell: 9 });
    await insertSellOrders(db, 106, [1], { firstOrderId: 8000, minVolume: 5_000 });

    const result = await getValuationPrice(db, 106, { stationId: JITA_44 });

    expect(result.price).toBeNull();
    expect(result.source).toBe('missing');
  });

  it('区域级离群过滤路径（同样回订单簿）排除整批大单', async () => {
    const db = await createMigratedDb();
    await insertSellOrders(db, 107, [10, 20, 30, 40, 50], { firstOrderId: 9000 });
    await insertSellOrders(db, 107, [1], { firstOrderId: 9500, minVolume: 10_000 });

    const result = await getValuationPrice(db, 107, { filterOutliers: true });

    expect(result.source).toBe('orders');
    expect(result.price).toBeCloseTo(12, 10); // [10,20,30,40,50] → (5-1)×0.05 = 0.2 → 10 + 10×0.2；未过滤时为 1 + 9×0.25 = 3.25
  });
});

describe('离群过滤（10 倍中位数）', () => {
  it('filterOutlierPrices：剔除高于 中位数×倍数 的样本', () => {
    const prices = [1, 100, 101, 102, 100000];

    expect(filterOutlierPrices(prices)).toEqual([1, 100, 101, 102]);
    expect(filterOutlierPrices(prices, 2)).toEqual([1, 100, 101, 102]);
    expect(filterOutlierPrices(prices, 100_000)).toEqual(prices);
    expect(filterOutlierPrices([])).toEqual([]);
    expect(filterOutlierPrices([0, -1])).toEqual([]);
  });

  it('不修改入参', () => {
    const prices = [1, 2, 3];
    filterOutlierPrices(prices);
    expect(prices).toEqual([1, 2, 3]);
  });

  it('开启过滤后 5% 分位随样本量变化（同一路径对比）', async () => {
    const db = await createMigratedDb();
    await insertSellOrders(db, 200, [1, 100, 101, 102, 100000], { firstOrderId: 7000 });

    const raw = await getValuationPrice(db, 200, { stationId: JITA_44 });
    const filtered = await getValuationPrice(db, 200, {
      stationId: JITA_44,
      filterOutliers: true,
    });

    expect(raw.source).toBe('orders');
    expect(filtered.source).toBe('orders');
    expect(raw.price).toBeCloseTo(20.8, 10); // (5-1)*0.05 → 1 + 99×0.2
    expect(filtered.price).toBeCloseTo(15.85, 10); // 过滤后 4 个样本 → 1 + 99×0.15
  });

  it('过滤只作用于高侧，最低卖价不受影响', async () => {
    const db = await createMigratedDb();
    await insertSellOrders(db, 201, [1, 1000, 1001, 1002, 1_000_000], { firstOrderId: 8000 });

    const result = await getValuationPrice(db, 201, {
      stationId: JITA_44,
      basis: 'best_sell',
      filterOutliers: true,
    });

    expect(result.price).toBe(1);
  });

  it('薄订单簿下的 1 ISK 钓鱼单仍会拉低分位（已知特性，样本量不足所致）', async () => {
    const db = await createMigratedDb();
    await insertSellOrders(db, 300, [1, 1000, 1100], { firstOrderId: 9000 });

    const result = await getValuationPrice(db, 300, { stationId: JITA_44, filterOutliers: true });

    // 中位数 1000 → 上限 10000 → 无高侧离群可剔；低侧的 1 ISK 单本身不受该规则约束
    expect(result.price).toBeCloseTo(100.9, 10); // 1 + 999×0.1
  });
});

describe('priceFromSellPrices 口径取值', () => {
  it('5% 分位（5% 位置线性插值）与最低价', () => {
    expect(priceFromSellPrices([10, 20, 30, 40, 50], 'p5_sell')).toBeCloseTo(12, 10);
    expect(priceFromSellPrices([10, 20, 30, 40], 'p5_sell')).toBeCloseTo(11.5, 10);
    expect(priceFromSellPrices([7], 'p5_sell')).toBe(7);
    expect(priceFromSellPrices([10, 2, 30], 'best_sell')).toBe(2);
    expect(priceFromSellPrices([], 'p5_sell')).toBeNull();
    expect(priceFromSellPrices([0, -5], 'best_sell')).toBeNull();
  });
});

describe('批量估值 valueItems', () => {
  it('与单条查询同口径一致，缺失物品计 0 并去重列出', async () => {
    const db = await createMigratedDb();
    await insertStats(db, { typeId: 34, bestSell: 3.75, p5Sell: 4.25 });
    await insertStats(db, { typeId: 35, bestSell: 2.5, p5Sell: null });

    const batch = await valueItems(db, [
      { typeId: 34, quantity: 10 },
      { typeId: 35, quantity: 4 },
      { typeId: 99, quantity: 7 },
      { typeId: 99, quantity: 1 },
    ]);

    expect(batch.items.map((item) => item.unitPrice)).toEqual([4.25, 2.5, null, null]);
    expect(batch.items.map((item) => item.value)).toEqual([42.5, 10, 0, 0]);
    expect(batch.items.map((item) => item.source)).toEqual(['stats', 'fallback', 'missing', 'missing']);
    expect(batch.totalValue).toBe(52.5);
    expect(batch.missingTypeIds).toEqual([99]);
    expect(batch.distinctTypeCount).toBe(3);

    // 与单条查询完全一致
    const single = await getValuationPrice(db, 34);
    expect(batch.items[0].unitPrice).toBe(single.price);
    expect(batch.items[0].effectiveBasis).toBe(single.effectiveBasis);
  });

  it('空入参返回零结果', async () => {
    const db = await createMigratedDb();
    const batch = await valueItems(db, []);
    expect(batch).toEqual({ items: [], totalValue: 0, missingTypeIds: [], distinctTypeCount: 0 });
  });

  it('站点级批量：无该站点订单的物品记为缺失', async () => {
    const db = await createMigratedDb();
    await insertSellOrders(db, 100, [10, 20, 30], { firstOrderId: 1000 });
    await insertStats(db, { typeId: 101, bestSell: 5, p5Sell: 6 });

    const batch = await valueItems(
      db,
      [
        { typeId: 100, quantity: 2 },
        { typeId: 101, quantity: 3 },
      ],
      { stationId: JITA_44 },
    );

    expect(batch.items[0].unitPrice).toBeCloseTo(11, 10); // (3-1)*0.05 = 0.1 → 10 + 10×0.1
    expect(batch.items[0].source).toBe('orders');
    expect(batch.items[1].unitPrice).toBeNull();
    expect(batch.items[1].value).toBe(0);
    expect(batch.missingTypeIds).toEqual([101]);
  });

  it('区域级开启过滤：订单簿已无该物品（快照被替换）时回退到聚合快路径', async () => {
    const db = await createMigratedDb();
    await insertStats(db, { typeId: 400, bestSell: 12, p5Sell: 13 });
    // 订单簿里有其它物品的正常订单，但 400 已无卖单 → 精确重算无样本 → 回退快路径
    await insertSellOrders(db, 401, [5, 6, 7], { firstOrderId: 11000 });

    const precise = await getValuationPrice(db, 400, { filterOutliers: true });

    expect(precise.price).toBe(13);
    expect(precise.source).toBe('stats');
    expect(precise.effectiveBasis).toBe('p5_sell');
  });

  it('valueQuantity：无报价计 0', async () => {
    const db = await createMigratedDb();
    await insertStats(db, { typeId: 34, bestSell: 3.75, p5Sell: 4 });

    expect(await valueQuantity(db, 34, 3)).toBe(12);
    expect(await valueQuantity(db, 99, 3)).toBe(0);
  });
});

describe('挂单量加权口径（P11-1）', () => {
  it('聚合快路径：命中 wavg_sell / w5_sell 时取对应列并标记 stats', async () => {
    const db = await createMigratedDb();
    await insertStats(db, { typeId: 34, bestSell: 3.6, p5Sell: 3.76, wavgSell: 4.08, w5Sell: 3.9 });

    const wavg = await getValuationPrice(db, 34, { basis: 'wavg_sell' });
    expect(wavg.price).toBe(4.08);
    expect(wavg.source).toBe('stats');
    expect(wavg.effectiveBasis).toBe('wavg_sell');

    const w5 = await getValuationPrice(db, 34, { basis: 'w5_sell' });
    expect(w5.price).toBe(3.9);
    expect(w5.source).toBe('stats');
    expect(w5.effectiveBasis).toBe('w5_sell');
  });

  it('加权口径缺失时回退到 p5_sell（不跳 best_sell）', async () => {
    const db = await createMigratedDb();
    await insertStats(db, { typeId: 34, bestSell: 3.6, p5Sell: 3.76, wavgSell: null });

    const result = await getValuationPrice(db, 34, { basis: 'wavg_sell' });

    expect(result.price).toBe(3.76);
    expect(result.source).toBe('fallback');
    expect(result.effectiveBasis).toBe('p5_sell');
  });

  it('加权口径与 p5_sell 都缺失时判无报价 —— **不回退到 best_sell**', async () => {
    const db = await createMigratedDb();
    await insertStats(db, { typeId: 34, bestSell: 3.6, p5Sell: null, wavgSell: null });

    const wavg = await getValuationPrice(db, 34, { basis: 'wavg_sell' });
    expect(wavg.price).toBeNull();
    expect(wavg.source).toBe('missing');

    const w5 = await getValuationPrice(db, 34, { basis: 'w5_sell' });
    expect(w5.price).toBeNull();
    expect(w5.source).toBe('missing');
  });

  it('订单簿路径（站点级）也支持加权口径：由该站卖单明细加权', async () => {
    const db = await createMigratedDb();
    // 每单默认 volume_remain = 100（insertSellOrders 的 fixture 默认值）
    await insertSellOrders(db, 34, [10], { firstOrderId: 1 }); // 10 × 100
    await insertSellOrders(db, 34, [20, 20, 20], { firstOrderId: 2 }); // 20 × 300

    const wavg = await getValuationPrice(db, 34, { stationId: JITA_44, basis: 'wavg_sell' });
    // (10×100 + 20×300) / 400 = 17.5
    expect(wavg.price).toBeCloseTo(17.5);
    expect(wavg.source).toBe('orders');
    expect(wavg.effectiveBasis).toBe('wavg_sell');

    const w5 = await getValuationPrice(db, 34, { stationId: JITA_44, basis: 'w5_sell' });
    // 总量 400、阈值 20 单位：第一档累计 100 ≥ 20 → 10
    expect(w5.price).toBe(10);
    expect(w5.source).toBe('orders');
  });

  it('priceFromSellLevels 在 p5_sell / best_sell 上与 priceFromSellPrices 逐位一致', () => {
    const prices = [10, 20, 30, 40, 50];
    const levels = prices.map((price) => ({ price, volume: 7 }));
    expect(priceFromSellLevels(levels, 'p5_sell')).toBe(priceFromSellPrices(prices, 'p5_sell'));
    expect(priceFromSellLevels(levels, 'best_sell')).toBe(priceFromSellPrices(prices, 'best_sell'));
  });
});
