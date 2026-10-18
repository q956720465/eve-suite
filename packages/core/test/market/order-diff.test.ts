import { describe, expect, it } from 'vitest';

import type { MarketOrder } from '../../src/esi/types';
import { ORDER_COLUMNS, toOrderRow } from '../../src/market/rows';
import { planRegionOrderDiff } from '../../src/market/order-diff';

const REGION = 10000002;
const FETCHED_AT = '2026-09-30T14:00:00.000Z';

function order(
  overrides: Partial<MarketOrder> & Pick<MarketOrder, 'order_id' | 'type_id' | 'price' | 'is_buy_order'>,
): MarketOrder {
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

const BASE = order({ order_id: 1, type_id: 34, price: 4.5, is_buy_order: false });

/** 把订单转成「数据库读回」的形状（列名 → 值） */
function asDbRow(source: MarketOrder, fetchedAt = FETCHED_AT): Record<string, unknown> {
  const values = toOrderRow(source, REGION, fetchedAt);
  return Object.fromEntries(ORDER_COLUMNS.map((column, index) => [column, values[index]]));
}

describe('整区快照最小写入计划（E1）', () => {
  it('本地无行 → 全部作为 upsert（首次 / 本地无该区数据）', () => {
    const plan = planRegionOrderDiff([], [BASE], REGION, FETCHED_AT);
    expect(plan.upsertRows).toHaveLength(1);
    expect(plan.vanishedOrderIds).toEqual([]);
    expect(plan.unchangedCount).toBe(0);
  });

  it('逐列一致 → 跳过写入', () => {
    const plan = planRegionOrderDiff([asDbRow(BASE)], [BASE], REGION, FETCHED_AT);
    expect(plan.upsertRows).toEqual([]);
    expect(plan.vanishedOrderIds).toEqual([]);
    expect(plan.unchangedCount).toBe(1);
  });

  it('忽略 fetched_at：仅抓取时间不同不算变化', () => {
    const plan = planRegionOrderDiff(
      [asDbRow(BASE, '2026-09-30T13:00:00.000Z')],
      [BASE],
      REGION,
      FETCHED_AT,
    );
    expect(plan.upsertRows).toEqual([]);
    expect(plan.unchangedCount).toBe(1);
  });

  it('价格变化 → 该行进入 upsert', () => {
    const changed = { ...BASE, price: 4.6 };
    const plan = planRegionOrderDiff([asDbRow(BASE)], [changed], REGION, FETCHED_AT);
    expect(plan.upsertRows).toHaveLength(1);
    expect(plan.upsertRows[0][ORDER_COLUMNS.indexOf('price')]).toBe(4.6);
    expect(plan.unchangedCount).toBe(0);
  });

  it('买卖方向 / 剩余量变化都被识别（布尔列与 DB 的 0/1 归一比较）', () => {
    const changed = { ...BASE, is_buy_order: true, volume_remain: 42 };
    const plan = planRegionOrderDiff([asDbRow(BASE)], [changed], REGION, FETCHED_AT);
    expect(plan.upsertRows).toHaveLength(1);
    expect(plan.upsertRows[0][ORDER_COLUMNS.indexOf('is_buy_order')]).toBe(1);
    expect(plan.upsertRows[0][ORDER_COLUMNS.indexOf('volume_remain')]).toBe(42);
  });

  it('消失的 order_id → 进入 vanishedOrderIds；新增 → 进入 upsert', () => {
    const other = order({ order_id: 2, type_id: 35, price: 9, is_buy_order: true });
    const fresh = order({ order_id: 3, type_id: 36, price: 1, is_buy_order: false });
    const plan = planRegionOrderDiff([asDbRow(BASE), asDbRow(other)], [BASE, fresh], REGION, FETCHED_AT);
    expect(plan.vanishedOrderIds).toEqual([2]);
    expect(plan.upsertRows).toHaveLength(1);
    expect(plan.upsertRows[0][ORDER_COLUMNS.indexOf('order_id')]).toBe(3);
    expect(plan.unchangedCount).toBe(1);
  });

  it('新快照为空（该区已无订单）→ 本地全部进入 vanished', () => {
    const plan = planRegionOrderDiff([asDbRow(BASE)], [], REGION, FETCHED_AT);
    expect(plan.vanishedOrderIds).toEqual([1]);
    expect(plan.upsertRows).toEqual([]);
  });
});
