import { describe, expect, it } from 'vitest';

import { computeMarketStats, percentile } from '../../src/market/stats';
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
