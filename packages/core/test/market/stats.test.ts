import { describe, expect, it } from 'vitest';

import {
  computeMarketStats,
  percentile,
  weightedAverage,
  weightedPercentile,
} from '../../src/market/stats';
import type { MarketOrder } from '../../src/esi/types';

function order(overrides: Partial<MarketOrder> & Pick<MarketOrder, 'order_id' | 'type_id' | 'price' | 'is_buy_order'>): MarketOrder {
  return {
    location_id: 60003760,
    volume_total: 100,
    volume_remain: 100,
    min_volume: 1,
    duration: 90,
    issued: '2026-09-01T00:00:00Z',
    range: 'region',
    ...overrides,
  };
}

describe('分位数', () => {
  it('空数组返回 null', () => {
    expect(percentile([], 0.05)).toBeNull();
  });

  it('单元素返回该值', () => {
    expect(percentile([42], 0.05)).toBe(42);
  });

  it('线性插值', () => {
    // (5-1) * 0.05 = 0.2 → 1 + (2-1) * 0.2 = 1.2
    expect(percentile([1, 2, 3, 4, 5], 0.05)).toBeCloseTo(1.2);
    expect(percentile([1, 2, 3, 4, 5], 0.95)).toBeCloseTo(4.8);
  });

  it('不修改入参数组', () => {
    const values = [3, 1, 2];
    percentile(values, 0.5);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe('市场统计计算', () => {
  it('按物品聚合：最优价、量、价差与分位价', () => {
    const rows = computeMarketStats(
      [
        order({ order_id: 1, type_id: 34, price: 5, is_buy_order: false, volume_remain: 100 }),
        order({ order_id: 2, type_id: 34, price: 4, is_buy_order: false, volume_remain: 100 }),
        order({ order_id: 3, type_id: 34, price: 3.5, is_buy_order: true, volume_remain: 30 }),
        order({ order_id: 4, type_id: 35, price: 10, is_buy_order: false, volume_remain: 7 }),
      ],
      10000002,
      '2026-09-27T00:00:00Z',
    );

    expect(rows).toHaveLength(2);

    const tritanium = rows.find((row) => row.type_id === 34);
    expect(tritanium).toMatchObject({
      region_id: 10000002,
      type_id: 34,
      best_sell: 4,
      best_buy: 3.5,
      sell_volume: 200,
      buy_volume: 30,
      sell_orders: 2,
      buy_orders: 1,
      spread: 0.5,
      updated_at: '2026-09-27T00:00:00Z',
    });
    expect(tritanium?.p5_sell).toBeCloseTo(4.05);
    expect(tritanium?.p95_buy).toBe(3.5);
  });

  it('单边缺失时最优价与价差为 null', () => {
    const rows = computeMarketStats(
      [order({ order_id: 1, type_id: 34, price: 5, is_buy_order: false })],
      10000002,
      'T',
    );
    expect(rows[0].best_buy).toBeNull();
    expect(rows[0].spread).toBeNull();
    expect(rows[0].p95_buy).toBeNull();
  });

  it('结果按 type_id 升序，便于稳定断言', () => {
    const rows = computeMarketStats(
      [
        order({ order_id: 1, type_id: 99, price: 1, is_buy_order: false }),
        order({ order_id: 2, type_id: 5, price: 1, is_buy_order: false }),
      ],
      10000002,
      'T',
    );
    expect(rows.map((row) => row.type_id)).toEqual([5, 99]);
  });

  it('空订单返回空数组', () => {
    expect(computeMarketStats([], 10000002, 'T')).toEqual([]);
  });
});

describe('整批大单过滤（min_volume > 1）', () => {
  it('卖侧的极低价整批大单不再污染 best_sell / p5_sell / 量与计数', () => {
    const rows = computeMarketStats(
      [
        // 操纵单：1 ISK 卖价，但要求整批买 10,000 单位
        order({ order_id: 1, type_id: 34, price: 1, is_buy_order: false, volume_remain: 10_000, min_volume: 10_000 }),
        order({ order_id: 2, type_id: 34, price: 4, is_buy_order: false, volume_remain: 100 }),
        order({ order_id: 3, type_id: 34, price: 5, is_buy_order: false, volume_remain: 100 }),
        order({ order_id: 4, type_id: 34, price: 3, is_buy_order: true, volume_remain: 30 }),
      ],
      10000002,
      'T',
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      best_sell: 4, // 未过滤时会被 1 ISK 大单拉到 1
      best_buy: 3,
      sell_volume: 200, // 10,000 不计入
      sell_orders: 2,
      spread: 1,
    });
    expect(rows[0].p5_sell).toBeCloseTo(4.05); // 未过滤时为 1 + (4-1)×0.1 = 1.3
  });

  it('买侧对称排除（1 单位卖不进去的整批买单不抬高 best_buy）', () => {
    const rows = computeMarketStats(
      [
        order({ order_id: 1, type_id: 34, price: 999, is_buy_order: true, volume_remain: 5_000, min_volume: 5_000 }),
        order({ order_id: 2, type_id: 34, price: 3, is_buy_order: true, volume_remain: 30 }),
        order({ order_id: 3, type_id: 34, price: 5, is_buy_order: false, volume_remain: 100 }),
      ],
      10000002,
      'T',
    );

    expect(rows[0]).toMatchObject({
      best_sell: 5,
      best_buy: 3,
      buy_volume: 30,
      buy_orders: 1,
      spread: 2,
    });
    expect(rows[0].p95_buy).toBe(3);
  });

  it('某物品订单全部被排除时不产生该物品的行（等价于无可成交报价）', () => {
    const rows = computeMarketStats(
      [order({ order_id: 1, type_id: 34, price: 1, is_buy_order: false, min_volume: 100 })],
      10000002,
      'T',
    );

    expect(rows).toEqual([]);
  });

  it('过滤按物品隔离：仅整批单的物品消失，正常物品保留', () => {
    const rows = computeMarketStats(
      [
        order({ order_id: 1, type_id: 34, price: 5, is_buy_order: false }),
        order({ order_id: 2, type_id: 35, price: 5, is_buy_order: false, min_volume: 2 }),
      ],
      10000002,
      'T',
    );

    expect(rows.map((row) => row.type_id)).toEqual([34]);
  });
});

describe('挂单量加权口径（P11-1）', () => {
  it('weightedAverage：按 volume_remain 加权；空 / 全零量返回 null', () => {
    expect(weightedAverage([])).toBeNull();
    expect(weightedAverage([{ price: 10, volume: 0 }])).toBeNull();
    // (10×1 + 20×3) / 4 = 17.5
    expect(weightedAverage([{ price: 10, volume: 1 }, { price: 20, volume: 3 }])).toBeCloseTo(17.5);
    // 零量档位不参与
    expect(weightedAverage([{ price: 10, volume: 0 }, { price: 20, volume: 2 }])).toBe(20);
  });

  it('weightedPercentile：累计量首次达到阈值时的价位，且**不插值**', () => {
    expect(weightedPercentile([], 0.05)).toBeNull();
    // 总量 20，5% → 1 单位：第一档就有 10 单位 → 取第一档价
    expect(
      weightedPercentile([{ price: 100, volume: 10 }, { price: 200, volume: 10 }], 0.05),
    ).toBe(100);
    // 阈值 12 单位：第一档不够 → 落到第二档
    expect(
      weightedPercentile([{ price: 100, volume: 10 }, { price: 200, volume: 10 }], 0.6),
    ).toBe(200);
    // 不插值：总量 100、阈值 5 单位，第一档只有 1 单位 → 直接给第二档价（若插值约 104）
    expect(weightedPercentile([{ price: 100, volume: 1 }, { price: 200, volume: 99 }], 0.05)).toBe(200);
  });

  it('computeMarketStats 同时产出 wavg_sell / w5_sell，且不改变 p5_sell', () => {
    const rows = computeMarketStats(
      [
        order({ order_id: 1, type_id: 34, price: 10, is_buy_order: false, volume_remain: 1 }),
        order({ order_id: 2, type_id: 34, price: 20, is_buy_order: false, volume_remain: 99 }),
      ],
      10000002,
      'T',
    );

    // (10×1 + 20×99) / 100 = 19.9
    expect(rows[0].wavg_sell).toBeCloseTo(19.9);
    // 阈值 5 单位：第一档只有 1 单位 → 落在第二档
    expect(rows[0].w5_sell).toBe(20);
    // 旧口径（按订单数 5% 分位）不受影响：10 + (20−10)×0.05
    expect(rows[0].p5_sell).toBeCloseTo(10.5);
  });

  it('无卖单时两列为 null', () => {
    const rows = computeMarketStats(
      [order({ order_id: 1, type_id: 34, price: 5, is_buy_order: true })],
      10000002,
      'T',
    );
    expect(rows[0].wavg_sell).toBeNull();
    expect(rows[0].w5_sell).toBeNull();
  });

  it('整批大单（min_volume > 1）同样不参与加权口径', () => {
    const rows = computeMarketStats(
      [
        order({
          order_id: 1,
          type_id: 34,
          price: 1,
          is_buy_order: false,
          volume_remain: 10_000,
          min_volume: 10_000,
        }),
        order({ order_id: 2, type_id: 34, price: 10, is_buy_order: false, volume_remain: 1 }),
        order({ order_id: 3, type_id: 34, price: 20, is_buy_order: false, volume_remain: 3 }),
      ],
      10000002,
      'T',
    );

    // 只看后两档：(10×1 + 20×3) / 4 = 17.5；若把 1 ISK 大单算进来会显著偏低
    expect(rows[0].wavg_sell).toBeCloseTo(17.5);
    expect(rows[0].sell_volume).toBe(4);
  });
});
