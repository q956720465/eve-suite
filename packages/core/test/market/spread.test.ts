import { describe, expect, it } from 'vitest';

import { EsiClient } from '../../src/esi/client';
import { RequestScheduler } from '../../src/esi/scheduler';
import {
  DEFAULT_SPREAD_DEPTH_QUANTITY,
  DEFAULT_SPREAD_FILTERS,
  MAX_SPREAD_DEPTH_QUANTITY,
  computeSpreadCapture,
  computeSpreadDepth,
  getSpreadFreshness,
  judgeSpreadHistory,
  normalizeSpreadDepthQuantity,
  rankCrossRegionSpreads,
  readSpreadHistoryStats,
  readSpreadLiquidityStats,
  spreadCaptureKey,
  spreadDepthKey,
  validateSpreadHistory,
  type SpreadRow,
} from '../../src/market/spread';
import { countRows, createMigratedDb } from '../helpers/db';
import { createFakeClock } from '../helpers/fake-clock';
import { createMockHttp, jsonResponse } from '../helpers/mock-http';

/** 固定基准时间：2026-09-27 02:00 UTC（与 on-demand 测试一致） */
const T0 = Date.UTC(2026, 8, 27, 2, 0, 0);
/** 30 天窗口起点（含）：2026-08-29；7 天窗口起点（含）：2026-09-21 */
const D30 = '2026-08-29';
const D7 = '2026-09-21';

const REGIONS = {
  buyA: { id: 10000001, name: 'Region Buy A' },
  buyB: { id: 10000002, name: 'Region Buy B' },
  sell: { id: 10000003, name: 'Region Sell' },
  outside: { id: 10000004, name: 'Region Outside' },
};

interface StatsSeed {
  bestSell?: number | null;
  bestBuy?: number | null;
  p5Sell?: number | null;
  p95Buy?: number | null;
  sellOrders?: number;
  buyOrders?: number;
  /** 在架卖量（P11-3 库存天数用；缺省 1000 保持既有用例不变） */
  sellVolume?: number;
  updatedAt?: string;
}

async function setup() {
  const db = await createMigratedDb();
  for (const region of Object.values(REGIONS)) {
    await db.execute('INSERT INTO sde_regions (region_id, name_en, name_zh) VALUES (?, ?, NULL)', [
      region.id,
      region.name,
    ]);
  }
  const http = createMockHttp();
  const client = new EsiClient({ http });
  const scheduler = new RequestScheduler({
    clock: createFakeClock(),
    requestsPerSecond: 1000,
    burst: 1000,
  });
  return { db, http, deps: { db, client, scheduler } };
}

async function seedType(
  db: Awaited<ReturnType<typeof createMigratedDb>>,
  typeId: number,
  volume: number | null,
): Promise<void> {
  await db.execute(
    'INSERT INTO sde_types (type_id, group_id, name_en, volume, published) VALUES (?, 1, ?, ?, 1)',
    [typeId, `Type ${typeId}`, volume],
  );
}

async function seedStats(
  db: Awaited<ReturnType<typeof createMigratedDb>>,
  regionId: number,
  typeId: number,
  seed: StatsSeed = {},
): Promise<void> {
  await db.execute(
    `INSERT INTO market_stats
       (region_id, type_id, best_sell, best_buy, sell_volume, buy_volume,
        sell_orders, buy_orders, spread, p5_sell, p95_buy, updated_at)
     VALUES (?, ?, ?, ?, ?, 1000, ?, ?, NULL, ?, ?, ?)`,
    [
      regionId,
      typeId,
      seed.bestSell ?? null,
      seed.bestBuy ?? null,
      seed.sellVolume ?? 1000,
      seed.sellOrders ?? 10,
      seed.buyOrders ?? 10,
      seed.p5Sell ?? null,
      seed.p95Buy ?? null,
      seed.updatedAt ?? '2026-09-27T01:00:00Z',
    ],
  );
}

async function seedHistory(
  db: Awaited<ReturnType<typeof createMigratedDb>>,
  regionId: number,
  typeId: number,
  rows: { date: string; average: number; volume: number }[],
): Promise<void> {
  for (const row of rows) {
    await db.execute(
      `INSERT INTO market_history_daily
         (region_id, type_id, date, average, highest, lowest, order_count, volume, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, 10, ?, '2026-09-27T02:00:00Z')`,
      [regionId, typeId, row.date, row.average, row.average, row.average, row.volume],
    );
  }
}

describe('跨区价差粗筛 rankCrossRegionSpreads', () => {
  it('基本配对：买价取买入区 p5_sell、卖价取卖出区 p95_buy，价差字段正确', async () => {
    const { db } = await setup();
    await seedType(db, 34, 2);
    await seedStats(db, REGIONS.buyA.id, 34, { p5Sell: 100, p95Buy: 10 });
    await seedStats(db, REGIONS.sell.id, 34, { p5Sell: 50, p95Buy: 120 });

    const rows = await rankCrossRegionSpreads(db);

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.typeId).toBe(34);
    expect(row.typeVolume).toBe(2);
    expect(row.buyRegionId).toBe(REGIONS.buyA.id);
    expect(row.buyRegionNameEn).toBe('Region Buy A');
    expect(row.buyPrice).toBe(100);
    expect(row.sellRegionId).toBe(REGIONS.sell.id);
    expect(row.sellPrice).toBe(120);
    expect(row.spreadIsk).toBeCloseTo(20);
    expect(row.spreadRate).toBeCloseTo(0.2);
    expect(row.iskPerM3).toBeCloseTo(10);
  });

  it('best_sell 钓鱼单不污染买价（分位口径）', async () => {
    const { db } = await setup();
    await seedType(db, 34, 1);
    // 买入区挂着一笔 0.02 的钓鱼卖单（best_sell），但 p5 分位是正常价
    await seedStats(db, REGIONS.buyA.id, 34, { bestSell: 0.02, p5Sell: 100, p95Buy: 10 });
    await seedStats(db, REGIONS.sell.id, 34, { p5Sell: 50, p95Buy: 120 });

    const rows = await rankCrossRegionSpreads(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].buyPrice).toBe(100);
  });

  it('流动性门槛：两侧订单数不足被过滤；阈值可调', async () => {
    const { db } = await setup();
    await seedType(db, 34, 1);
    await seedType(db, 35, 1);
    await seedType(db, 36, 1);
    // 34：买入区卖单只有 4 笔 → 被默认门槛过滤
    await seedStats(db, REGIONS.buyA.id, 34, { p5Sell: 100, sellOrders: 4 });
    await seedStats(db, REGIONS.sell.id, 34, { p95Buy: 150 });
    // 35：卖出区买单只有 4 笔 → 被默认门槛过滤
    await seedStats(db, REGIONS.buyA.id, 35, { p5Sell: 100 });
    await seedStats(db, REGIONS.sell.id, 35, { p95Buy: 150, buyOrders: 4 });
    // 36：两侧都是 5 笔 → 通过
    await seedStats(db, REGIONS.buyA.id, 36, { p5Sell: 100, sellOrders: 5 });
    await seedStats(db, REGIONS.sell.id, 36, { p95Buy: 150, buyOrders: 5 });

    const rows = await rankCrossRegionSpreads(db);
    expect(rows.map((row) => row.typeId)).toEqual([36]);

    const relaxed = await rankCrossRegionSpreads(db, { minSellOrders: 1, minBuyOrders: 1 });
    expect(relaxed.map((row) => row.typeId).sort()).toEqual([34, 35, 36]);
  });

  it('价差率上限：默认 300%，超限被过滤；阈值可调', async () => {
    const { db } = await setup();
    await seedType(db, 34, 1);
    await seedStats(db, REGIONS.buyA.id, 34, { p5Sell: 100 });
    await seedStats(db, REGIONS.sell.id, 34, { p95Buy: 500 });

    expect(await rankCrossRegionSpreads(db)).toHaveLength(0);
    expect(await rankCrossRegionSpreads(db, { maxSpreadRate: 4 })).toHaveLength(1);
  });

  it('无价差（卖价 ≤ 买价）与 p5 缺失的行不参与', async () => {
    const { db } = await setup();
    await seedType(db, 34, 1);
    await seedType(db, 35, 1);
    // 34：反着的（买入区更贵）
    await seedStats(db, REGIONS.buyA.id, 34, { p5Sell: 200 });
    await seedStats(db, REGIONS.sell.id, 34, { p95Buy: 120 });
    // 35：买入区无 p5（订单太少时为 NULL）
    await seedStats(db, REGIONS.buyA.id, 35, { p5Sell: null });
    await seedStats(db, REGIONS.sell.id, 35, { p95Buy: 120 });

    expect(await rankCrossRegionSpreads(db)).toHaveLength(0);
  });

  it('同区不配对；regionIds 过滤下两侧都必须在清单内', async () => {
    const { db } = await setup();
    await seedType(db, 34, 1);
    await seedStats(db, REGIONS.buyA.id, 34, { p5Sell: 100 });
    await seedStats(db, REGIONS.buyB.id, 34, { p5Sell: 110 });
    await seedStats(db, REGIONS.sell.id, 34, { p95Buy: 200 });
    await seedStats(db, REGIONS.outside.id, 34, { p95Buy: 400, buyOrders: 10 });

    // 全部区域：buyA→sell、buyB→sell、buyA→outside、buyB→outside 共 4 对
    // （sell 区未播种 p5_sell，不满足买方条件，无法与 outside 配对）
    const all = await rankCrossRegionSpreads(db);
    expect(all).toHaveLength(4);

    // 限定 buyA/buyB/sell：outside 两侧都不再参与
    const filtered = await rankCrossRegionSpreads(db, {
      regionIds: [REGIONS.buyA.id, REGIONS.buyB.id, REGIONS.sell.id],
    });
    expect(filtered).toHaveLength(2);
    for (const row of filtered) {
      expect(row.buyRegionId).not.toBe(REGIONS.outside.id);
      expect(row.sellRegionId).not.toBe(REGIONS.outside.id);
    }
  });

  it('排序：spreadIsk 降序；iskPerM3 降序且体积缺失排最后；limit 生效', async () => {
    const { db } = await setup();
    await seedType(db, 34, 10);
    await seedType(db, 35, 1);
    await seedType(db, 36, null);
    await seedStats(db, REGIONS.buyA.id, 34, { p5Sell: 100 });
    await seedStats(db, REGIONS.sell.id, 34, { p95Buy: 160 });
    await seedStats(db, REGIONS.buyA.id, 35, { p5Sell: 100 });
    await seedStats(db, REGIONS.sell.id, 35, { p95Buy: 200 });
    await seedStats(db, REGIONS.buyA.id, 36, { p5Sell: 100 });
    await seedStats(db, REGIONS.sell.id, 36, { p95Buy: 300 });

    const byIsk = await rankCrossRegionSpreads(db, { sortBy: 'spreadIsk' });
    expect(byIsk.map((row) => row.typeId)).toEqual([36, 35, 34]);

    const perM3 = await rankCrossRegionSpreads(db, { sortBy: 'iskPerM3' });
    expect(perM3.map((row) => row.typeId)).toEqual([35, 34, 36]);
    expect(perM3[0].iskPerM3).toBeCloseTo(100);
    expect(perM3[2].iskPerM3).toBeNull();

    const limited = await rankCrossRegionSpreads(db, { limit: 2 });
    expect(limited).toHaveLength(2);
  });

  it('默认筛选口径为方案拍板值', () => {
    expect(DEFAULT_SPREAD_FILTERS.minSellOrders).toBe(5);
    expect(DEFAULT_SPREAD_FILTERS.minBuyOrders).toBe(5);
    expect(DEFAULT_SPREAD_FILTERS.maxSpreadRate).toBe(3);
    expect(DEFAULT_SPREAD_FILTERS.limit).toBe(50);
    expect(DEFAULT_SPREAD_FILTERS.sortBy).toBe('spreadRate');
  });
});

describe('快照新鲜度 getSpreadFreshness', () => {
  it('返回全库统计的时间范围与行数；regionIds 过滤生效', async () => {
    const { db } = await setup();
    await seedStats(db, REGIONS.buyA.id, 34, { p5Sell: 100, updatedAt: '2026-09-27T01:00:00Z' });
    await seedStats(db, REGIONS.sell.id, 34, { p95Buy: 150, updatedAt: '2026-09-27T02:00:00Z' });
    await seedStats(db, REGIONS.outside.id, 34, { updatedAt: '2026-09-27T05:00:00Z' });

    const all = await getSpreadFreshness(db);
    expect(all.minUpdatedAt).toBe('2026-09-27T01:00:00Z');
    expect(all.maxUpdatedAt).toBe('2026-09-27T05:00:00Z');
    expect(all.statsRows).toBe(3);

    const filtered = await getSpreadFreshness(db, [REGIONS.buyA.id, REGIONS.sell.id]);
    expect(filtered.statsRows).toBe(2);
    expect(filtered.maxUpdatedAt).toBe('2026-09-27T02:00:00Z');

    const empty = await getSpreadFreshness(db, [999]);
    expect(empty).toEqual({ minUpdatedAt: null, maxUpdatedAt: null, statsRows: 0 });
  });
});

describe('历史校验 judgeSpreadHistory', () => {
  const base = { buyPrice: 100, sellPrice: 120 };

  it('历史正常且价格在锚内、卖出区活跃：通过', () => {
    const verdict = judgeSpreadHistory({
      ...base,
      buyAvg30: 102,
      sellAvg30: 118,
      sellActiveDays7: 5,
    });
    expect(verdict.passed).toBe(true);
    expect(verdict.reasons).toEqual([]);
  });

  it('任一侧无历史数据：no-history', () => {
    const verdict = judgeSpreadHistory({
      ...base,
      buyAvg30: 100,
      sellAvg30: null,
      sellActiveDays7: 7,
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toEqual(['no-history']);
  });

  it('价格偏离 30 天均价锚 2.5 倍（上偏或下偏）：price-outlier', () => {
    const high = judgeSpreadHistory({
      buyPrice: 100,
      sellPrice: 1000,
      buyAvg30: 100,
      sellAvg30: 100,
      sellActiveDays7: 7,
    });
    expect(high.reasons).toEqual(['price-outlier']);

    const low = judgeSpreadHistory({
      buyPrice: 30,
      sellPrice: 120,
      buyAvg30: 100,
      sellAvg30: 118,
      sellActiveDays7: 7,
    });
    expect(low.reasons).toEqual(['price-outlier']);
  });

  it('卖出区近 7 天成交天数不足：inactive；可与 outlier 叠加', () => {
    const verdict = judgeSpreadHistory({
      ...base,
      buyAvg30: 100,
      sellAvg30: 400,
      sellActiveDays7: 2,
    });
    expect(verdict.reasons).toEqual(['price-outlier', 'inactive']);
    expect(verdict.passed).toBe(false);
  });

  it('阈值可调', () => {
    const verdict = judgeSpreadHistory({
      ...base,
      buyAvg30: 100,
      sellAvg30: 118,
      sellActiveDays7: 2,
      anchorRatio: 5,
      minActiveDays: 1,
    });
    expect(verdict.passed).toBe(true);
  });
});

describe('历史统计 readSpreadHistoryStats', () => {
  it('30 天均价窗口与近 7 天成交天数口径正确', async () => {
    const { db } = await setup();
    await seedHistory(db, REGIONS.sell.id, 34, [
      // 窗口外（30 天前更早）：不计入均价
      { date: '2026-08-01', average: 1000, volume: 1000 },
      // 窗口内：均价 = (100 + 120) / 2 = 110
      { date: D30, average: 100, volume: 500 },
      { date: '2026-09-10', average: 120, volume: 500 },
      // 近 7 天：3 天有成交 + 1 天零成交
      { date: D7, average: 110, volume: 10 },
      { date: '2026-09-23', average: 110, volume: 10 },
      { date: '2026-09-26', average: 110, volume: 10 },
      { date: '2026-09-27', average: 110, volume: 0 },
    ]);

    const stats = await readSpreadHistoryStats(db, REGIONS.sell.id, 34, T0);
    expect(stats.avg30).toBeCloseTo(110);
    expect(stats.activeDays7).toBe(3);
  });

  it('无历史：avg30 为 null、activeDays7 为 0', async () => {
    const { db } = await setup();
    const stats = await readSpreadHistoryStats(db, REGIONS.buyA.id, 34, T0);
    expect(stats).toEqual({ avg30: null, activeDays7: 0 });
  });
});

describe('候选历史校验 validateSpreadHistory', () => {
  function candidateRow(overrides: Partial<SpreadRow> = {}): SpreadRow {
    return {
      typeId: 34,
      typeVolume: 1,
      buyRegionId: REGIONS.buyA.id,
      buyRegionNameEn: REGIONS.buyA.name,
      buyRegionNameZh: null,
      buyPrice: 100,
      sellRegionId: REGIONS.sell.id,
      sellRegionNameEn: REGIONS.sell.name,
      sellRegionNameZh: null,
      sellPrice: 120,
      spreadIsk: 20,
      spreadRate: 0.2,
      buySellOrders: 10,
      sellBuyOrders: 10,
      iskPerM3: 20,
      ...overrides,
    };
  }

  it('按需拉取两侧历史并给出通过判定；当日复校不再发请求', async () => {
    const { db, http, deps } = await setup();
    // 买入区历史：30 天均价 100，近 7 天天天有成交
    http.enqueue(
      jsonResponse(
        200,
        [
          { date: D30, average: 100, highest: 1, lowest: 1, order_count: 1, volume: 10 },
          { date: D7, average: 100, highest: 1, lowest: 1, order_count: 1, volume: 10 },
        ],
      ),
    );
    // 卖出区历史：30 天均价 120，近 7 天里 4 天有成交（满足 ≥4 门槛）
    http.enqueue(
      jsonResponse(
        200,
        [
          { date: D30, average: 120, highest: 1, lowest: 1, order_count: 1, volume: 10 },
          { date: D7, average: 120, highest: 1, lowest: 1, order_count: 1, volume: 10 },
          { date: '2026-09-22', average: 120, highest: 1, lowest: 1, order_count: 1, volume: 10 },
          { date: '2026-09-23', average: 120, highest: 1, lowest: 1, order_count: 1, volume: 10 },
          { date: '2026-09-24', average: 120, highest: 1, lowest: 1, order_count: 1, volume: 10 },
        ],
      ),
    );

    const rows = [candidateRow()];
    const verdicts = await validateSpreadHistory(deps, rows, { now: T0 });

    expect(http.calls).toHaveLength(2);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].passed).toBe(true);
    expect(verdicts[0].buyAvg30).toBeCloseTo(100);
    expect(verdicts[0].sellAvg30).toBeCloseTo(120);
    expect(verdicts[0].sellActiveDays7).toBe(4);
    expect(await countRows(db, 'market_history_daily')).toBe(7);

    // 当日第二次校验：走「今天已抓取」跳过，不产生新请求
    const again = await validateSpreadHistory(deps, rows, { now: T0 + 3600_000 });
    expect(http.calls).toHaveLength(2);
    expect(again[0].passed).toBe(true);
  });

  it('ESI 无历史的物品：no-history 判定；空历史不重写库', async () => {
    const { db, http, deps } = await setup();
    http.enqueue(jsonResponse(200, []));
    http.enqueue(jsonResponse(200, []));

    const verdicts = await validateSpreadHistory(deps, [candidateRow()], { now: T0 });

    expect(verdicts[0].reasons).toContain('no-history');
    expect(verdicts[0].passed).toBe(false);
    expect(await countRows(db, 'market_history_daily')).toBe(0);
  });

  it('多候选去重拉取（同区同物品只拉一次），行与判定同序', async () => {
    const { http, deps } = await setup();
    // 34：buyA→sell；35：buyB→sell
    // pairs 去重后：buyA:34、sell:34、buyB:35、sell:35 → 共 4 次请求
    for (let i = 0; i < 4; i += 1) {
      http.enqueue(jsonResponse(200, []));
    }

    const rows = [
      candidateRow(),
      candidateRow({ typeId: 35, buyRegionId: REGIONS.buyB.id, buyRegionNameEn: REGIONS.buyB.name }),
    ];
    const verdicts = await validateSpreadHistory(deps, rows, { now: T0 });

    expect(http.calls).toHaveLength(4);
    expect(verdicts).toHaveLength(2);
    expect(verdicts.every((verdict) => !verdict.passed)).toBe(true);
  });
});

/* --------------------- 订单簿深度走量（P11-2） --------------------- */

/** order_id 为全库唯一主键，跨用例用递增计数器避免冲突 */
let nextOrderId = 1;

async function seedOrders(
  db: Awaited<ReturnType<typeof createMigratedDb>>,
  regionId: number,
  typeId: number,
  isBuy: boolean,
  levels: readonly { price: number; volume: number; minVolume?: number }[],
): Promise<void> {
  for (const level of levels) {
    await db.execute(
      `INSERT INTO market_orders
         (order_id, region_id, type_id, location_id, price, volume_total, volume_remain,
          min_volume, is_buy_order, duration, issued, range, fetched_at)
       VALUES (?, ?, ?, 60003760, ?, ?, ?, ?, ?, 90, '2026-09-01T00:00:00Z', 'region', '2026-09-27T00:00:00Z')`,
      [
        nextOrderId,
        regionId,
        typeId,
        level.price,
        level.volume,
        level.volume,
        level.minVolume ?? 1,
        isBuy ? 1 : 0,
      ],
    );
    nextOrderId += 1;
  }
}

/** 卖单（成本侧；P11-2 与 P11-4 同口径） */
function seedSellOrders(
  db: Awaited<ReturnType<typeof createMigratedDb>>,
  regionId: number,
  typeId: number,
  levels: readonly { price: number; volume: number; minVolume?: number }[],
): Promise<void> {
  return seedOrders(db, regionId, typeId, false, levels);
}

/** 买单（收益侧，P11-4） */
function seedBuyOrders(
  db: Awaited<ReturnType<typeof createMigratedDb>>,
  regionId: number,
  typeId: number,
  levels: readonly { price: number; volume: number; minVolume?: number }[],
): Promise<void> {
  return seedOrders(db, regionId, typeId, true, levels);
}

describe('订单簿深度走量（P11-2）', () => {
  it('逐档吃单：吃穿第一档后均价介于两档之间', async () => {
    const { db } = await setup();
    const regionId = REGIONS.buyA.id;
    await seedSellOrders(db, regionId, 34, [
      { price: 10, volume: 100 },
      { price: 20, volume: 100 },
      { price: 30, volume: 100 },
    ]);

    const depth = await computeSpreadDepth(db, [{ regionId, typeId: 34 }], 150);
    const result = depth.get(spreadDepthKey(regionId, 34));

    // 100@10 + 50@20 = 1000 + 1000 = 2000 / 150
    expect(result?.averagePrice).toBeCloseTo(2000 / 150);
    expect(result?.filledQuantity).toBe(150);
    expect(result?.availableQuantity).toBe(300);
    expect(result?.sufficient).toBe(true);
  });

  it('边界：目标量恰好等于第一档挂单量', async () => {
    const { db } = await setup();
    const regionId = REGIONS.buyA.id;
    await seedSellOrders(db, regionId, 34, [
      { price: 10, volume: 100 },
      { price: 20, volume: 100 },
    ]);

    const depth = await computeSpreadDepth(db, [{ regionId, typeId: 34 }], 100);
    const result = depth.get(spreadDepthKey(regionId, 34));

    expect(result?.averagePrice).toBe(10);
    expect(result?.filledQuantity).toBe(100);
    expect(result?.sufficient).toBe(true);
  });

  it('量不足：按实际可吃量算均价，并回报 sufficient=false', async () => {
    const { db } = await setup();
    const regionId = REGIONS.buyA.id;
    await seedSellOrders(db, regionId, 34, [
      { price: 10, volume: 100 },
      { price: 20, volume: 100 },
      { price: 30, volume: 100 },
    ]);

    const depth = await computeSpreadDepth(db, [{ regionId, typeId: 34 }], 1000);
    const result = depth.get(spreadDepthKey(regionId, 34));

    // (1000 + 2000 + 3000) / 300 = 20
    expect(result?.averagePrice).toBe(20);
    expect(result?.filledQuantity).toBe(300);
    expect(result?.availableQuantity).toBe(300);
    expect(result?.sufficient).toBe(false);
  });

  it('完全无卖单：均价为 null（不与 0 混淆）', async () => {
    const { db } = await setup();
    const regionId = REGIONS.buyA.id;

    const depth = await computeSpreadDepth(db, [{ regionId, typeId: 34 }], 100);
    const result = depth.get(spreadDepthKey(regionId, 34));

    expect(result?.averagePrice).toBeNull();
    expect(result?.filledQuantity).toBe(0);
    expect(result?.availableQuantity).toBe(0);
    expect(result?.sufficient).toBe(false);
  });

  it('口径与 p5_sell 一致：整批大单（min_volume > 1）不参与吃单', async () => {
    const { db } = await setup();
    const regionId = REGIONS.buyA.id;
    await seedSellOrders(db, regionId, 34, [
      // 1 ISK 的整批大单：若被算进来会把均价压到接近 1
      { price: 1, volume: 10_000, minVolume: 10_000 },
      { price: 10, volume: 100 },
      { price: 20, volume: 100 },
    ]);

    const depth = await computeSpreadDepth(db, [{ regionId, typeId: 34 }], 150);
    const result = depth.get(spreadDepthKey(regionId, 34));

    expect(result?.averagePrice).toBeCloseTo(2000 / 150);
    expect(result?.availableQuantity).toBe(200);
  });

  it('区域隔离：同一物品在两个区的订单簿互不影响', async () => {
    const { db } = await setup();
    await seedSellOrders(db, REGIONS.buyA.id, 34, [{ price: 10, volume: 100 }]);
    await seedSellOrders(db, REGIONS.buyB.id, 34, [{ price: 50, volume: 100 }]);

    const depth = await computeSpreadDepth(
      db,
      [
        { regionId: REGIONS.buyA.id, typeId: 34 },
        { regionId: REGIONS.buyB.id, typeId: 34 },
      ],
      100,
    );

    expect(depth.get(spreadDepthKey(REGIONS.buyA.id, 34))?.averagePrice).toBe(10);
    expect(depth.get(spreadDepthKey(REGIONS.buyB.id, 34))?.averagePrice).toBe(50);
  });

  it('重复目标自动去重，且空目标返回空 Map', async () => {
    const { db } = await setup();
    const regionId = REGIONS.buyA.id;
    await seedSellOrders(db, regionId, 34, [{ price: 10, volume: 100 }]);

    const depth = await computeSpreadDepth(
      db,
      [
        { regionId, typeId: 34 },
        { regionId, typeId: 34 },
      ],
      100,
    );
    expect(depth.size).toBe(1);
    expect((await computeSpreadDepth(db, [], 100)).size).toBe(0);
  });

  it('缺省目标量 = 默认值；量足够时均价反映默认量', async () => {
    const { db } = await setup();
    const regionId = REGIONS.buyA.id;
    await seedSellOrders(db, regionId, 34, [{ price: 10, volume: 10_000 }]);

    const depth = await computeSpreadDepth(db, [{ regionId, typeId: 34 }]);
    expect(depth.get(spreadDepthKey(regionId, 34))?.filledQuantity).toBe(
      DEFAULT_SPREAD_DEPTH_QUANTITY,
    );
  });

  it('目标量归一化：非法回退默认、下限 1、上限钳制、小数取整', () => {
    expect(normalizeSpreadDepthQuantity(undefined)).toBe(DEFAULT_SPREAD_DEPTH_QUANTITY);
    expect(normalizeSpreadDepthQuantity(Number.NaN)).toBe(DEFAULT_SPREAD_DEPTH_QUANTITY);
    expect(normalizeSpreadDepthQuantity(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SPREAD_DEPTH_QUANTITY);
    expect(normalizeSpreadDepthQuantity(0)).toBe(1);
    expect(normalizeSpreadDepthQuantity(-500)).toBe(1);
    expect(normalizeSpreadDepthQuantity(12.9)).toBe(12);
    expect(normalizeSpreadDepthQuantity(MAX_SPREAD_DEPTH_QUANTITY * 2)).toBe(
      MAX_SPREAD_DEPTH_QUANTITY,
    );
  });
});

/* --------------------- 流动性与库存天数（P11-3） --------------------- */

describe('流动性与库存天数（P11-3）', () => {
  it('activeDays7 与 readSpreadHistoryStats 逐项相等（同口径，可预告校验结果）', async () => {
    const { db } = await setup();
    const regionId = REGIONS.buyA.id;
    await seedHistory(db, regionId, 34, [
      { date: D30, average: 10, volume: 100 },
      // 窗口内但零成交 → 不计天数
      { date: D7, average: 11, volume: 0 },
      { date: '2026-09-25', average: 12, volume: 7 },
      { date: '2026-09-26', average: 13, volume: 3 },
    ]);

    const history = await readSpreadHistoryStats(db, regionId, 34, T0);
    const liquidity = await readSpreadLiquidityStats(db, [{ regionId, typeId: 34 }], T0);

    const stats = liquidity.get(spreadDepthKey(regionId, 34));
    expect(stats?.activeDays7).toBe(2);
    expect(stats?.activeDays7).toBe(history.activeDays7);
  });

  it('库存天数 = 在架卖量 ÷ 近 30 天日均成交量', async () => {
    const { db } = await setup();
    const regionId = REGIONS.buyA.id;
    await seedStats(db, regionId, 34, { sellVolume: 1000 });
    await seedHistory(db, regionId, 34, [
      { date: '2026-09-25', average: 12, volume: 100 },
      { date: '2026-09-26', average: 13, volume: 100 },
    ]);

    const liquidity = await readSpreadLiquidityStats(db, [{ regionId, typeId: 34 }], T0);
    const stats = liquidity.get(spreadDepthKey(regionId, 34));

    expect(stats?.avgVolume30).toBe(100);
    expect(stats?.sellVolume).toBe(1000);
    expect(stats?.daysOfSupply).toBe(10);
  });

  it('无历史：日均量与库存天数为 null、成交天数 0（不得报 0 天库存）', async () => {
    const { db } = await setup();
    const regionId = REGIONS.buyA.id;
    await seedStats(db, regionId, 34, { sellVolume: 500 });

    const liquidity = await readSpreadLiquidityStats(db, [{ regionId, typeId: 34 }], T0);
    const stats = liquidity.get(spreadDepthKey(regionId, 34));

    expect(stats?.activeDays7).toBe(0);
    expect(stats?.avgVolume30).toBeNull();
    expect(stats?.daysOfSupply).toBeNull();
    // 在架卖量仍如实回报（它来自 market_stats，与历史无关）
    expect(stats?.sellVolume).toBe(500);
  });

  it('日均量为 0：库存天数为 null（不给「无穷天」假读数）', async () => {
    const { db } = await setup();
    const regionId = REGIONS.buyA.id;
    await seedStats(db, regionId, 34, { sellVolume: 900 });
    await seedHistory(db, regionId, 34, [
      { date: '2026-09-25', average: 0, volume: 0 },
      { date: '2026-09-26', average: 0, volume: 0 },
    ]);

    const liquidity = await readSpreadLiquidityStats(db, [{ regionId, typeId: 34 }], T0);
    expect(liquidity.get(spreadDepthKey(regionId, 34))?.avgVolume30).toBe(0);
    expect(liquidity.get(spreadDepthKey(regionId, 34))?.daysOfSupply).toBeNull();
  });

  it('窗口边界：30 天窗口外的行不计入日均量，7 天窗口外的行不计入成交天数', async () => {
    const { db } = await setup();
    const regionId = REGIONS.buyA.id;
    await seedHistory(db, regionId, 34, [
      // 超出 30 天窗口（< 2026-08-29）→ 完全不计
      { date: '2026-08-28', average: 1, volume: 999 },
      { date: '2026-09-20', average: 1, volume: 0 }, // 30 天内、7 天窗口外，且零成交
      { date: D7, average: 1, volume: 5 }, // 恰在 7 天窗口起点且 > 0 → 计入
      { date: '2026-09-27', average: 1, volume: 0 },
    ]);

    const liquidity = await readSpreadLiquidityStats(db, [{ regionId, typeId: 34 }], T0);
    const stats = liquidity.get(spreadDepthKey(regionId, 34));

    // 30 天窗口内 3 行：volume 0 / 5 / 0 → 平均 5/3
    expect(stats?.avgVolume30).toBeCloseTo(5 / 3);
    expect(stats?.activeDays7).toBe(1);
  });

  it('去重与空入参；同物品在不同区互不影响', async () => {
    const { db } = await setup();
    await seedStats(db, REGIONS.buyA.id, 34, { sellVolume: 1000 });
    await seedStats(db, REGIONS.buyB.id, 34, { sellVolume: 2000 });
    await seedHistory(db, REGIONS.buyB.id, 34, [{ date: '2026-09-26', average: 1, volume: 50 }]);

    const liquidity = await readSpreadLiquidityStats(
      db,
      [
        { regionId: REGIONS.buyA.id, typeId: 34 },
        { regionId: REGIONS.buyA.id, typeId: 34 },
        { regionId: REGIONS.buyB.id, typeId: 34 },
      ],
      T0,
    );

    expect(liquidity.size).toBe(2);
    expect(liquidity.get(spreadDepthKey(REGIONS.buyA.id, 34))?.avgVolume30).toBeNull();
    expect(liquidity.get(spreadDepthKey(REGIONS.buyB.id, 34))?.daysOfSupply).toBe(40);
    expect((await readSpreadLiquidityStats(db, [], T0)).size).toBe(0);
  });
});

/* --------------------- 现实捕获份额（P11-4） --------------------- */

describe('现实捕获份额（P11-4）', () => {
  it('两簿边际交叉：跨多档走量，margin 归零处停止', async () => {
    const { db } = await setup();
    // 成本侧（买入区卖单，升序）：10 / 20 / 30
    await seedSellOrders(db, REGIONS.buyA.id, 34, [
      { price: 10, volume: 100 },
      { price: 20, volume: 100 },
      { price: 30, volume: 100 },
    ]);
    // 收益侧（卖出区买单，降序）：50 / 40 / 30
    await seedBuyOrders(db, REGIONS.sell.id, 34, [
      { price: 50, volume: 100 },
      { price: 40, volume: 100 },
      { price: 30, volume: 100 },
    ]);
    await seedStats(db, REGIONS.sell.id, 34, { p95Buy: 60 });

    const map = await computeSpreadCapture(db, [
      { typeId: 34, buyRegionId: REGIONS.buyA.id, sellRegionId: REGIONS.sell.id },
    ]);
    const result = map.get(spreadCaptureKey(34, REGIONS.buyA.id, REGIONS.sell.id));

    // (10,50)、(20,40) 各吃满 100 → q* = 200；(30,30) 边际为 0 → 停
    expect(result?.captureQuantity).toBe(200);
    expect(result?.costTotal).toBe(3000);
    expect(result?.revenueTotal).toBe(9000);
    expect(result?.marginTotal).toBe(6000);
    expect(result?.noSellOrders).toBe(false);
    expect(result?.noBuyOrders).toBe(false);
  });

  it('档位中间：一个成本档拆给两笔收益档分别成交', async () => {
    const { db } = await setup();
    await seedSellOrders(db, REGIONS.buyA.id, 34, [{ price: 10, volume: 100 }]);
    await seedBuyOrders(db, REGIONS.sell.id, 34, [
      { price: 50, volume: 60 },
      { price: 40, volume: 40 },
    ]);
    await seedStats(db, REGIONS.sell.id, 34, { p95Buy: 50 });

    const map = await computeSpreadCapture(db, [
      { typeId: 34, buyRegionId: REGIONS.buyA.id, sellRegionId: REGIONS.sell.id },
    ]);
    const result = map.get(spreadCaptureKey(34, REGIONS.buyA.id, REGIONS.sell.id));

    // 1 档 @10 拆成 60（对 50）+ 40（对 40），两段边际均 > 0
    expect(result?.captureQuantity).toBe(100);
    expect(result?.costTotal).toBe(1000);
    expect(result?.revenueTotal).toBe(50 * 60 + 40 * 40);
    expect(result?.marginTotal).toBe(4600 - 1000);
  });

  it('无盈利：最便宜成本 ≥ 最贵收益 → q* = 0，两侧都有单', async () => {
    const { db } = await setup();
    await seedSellOrders(db, REGIONS.buyA.id, 34, [{ price: 100, volume: 100 }]);
    await seedBuyOrders(db, REGIONS.sell.id, 34, [{ price: 50, volume: 100 }]);
    await seedStats(db, REGIONS.sell.id, 34, { p95Buy: 100 });

    const map = await computeSpreadCapture(db, [
      { typeId: 34, buyRegionId: REGIONS.buyA.id, sellRegionId: REGIONS.sell.id },
    ]);
    const result = map.get(spreadCaptureKey(34, REGIONS.buyA.id, REGIONS.sell.id));

    expect(result?.captureQuantity).toBe(0);
    expect(result?.marginTotal).toBe(0);
    expect(result?.noSellOrders).toBe(false);
    expect(result?.noBuyOrders).toBe(false);
  });

  it('单侧无单：无卖单 / 无买单 / 两侧皆空', async () => {
    const { db } = await setup();
    // 41：只有收益侧有单 → 无卖单
    await seedBuyOrders(db, REGIONS.sell.id, 41, [{ price: 50, volume: 100 }]);
    await seedStats(db, REGIONS.sell.id, 41, { p95Buy: 50 });
    // 42：只有成本侧有单 → 无买单
    await seedSellOrders(db, REGIONS.buyA.id, 42, [{ price: 10, volume: 100 }]);
    // 43：两侧皆空

    const map = await computeSpreadCapture(db, [
      { typeId: 41, buyRegionId: REGIONS.buyA.id, sellRegionId: REGIONS.sell.id },
      { typeId: 42, buyRegionId: REGIONS.buyA.id, sellRegionId: REGIONS.sell.id },
      { typeId: 43, buyRegionId: REGIONS.buyA.id, sellRegionId: REGIONS.sell.id },
    ]);

    const onlyRevenue = map.get(spreadCaptureKey(41, REGIONS.buyA.id, REGIONS.sell.id));
    expect(onlyRevenue?.noSellOrders).toBe(true);
    expect(onlyRevenue?.noBuyOrders).toBe(false);
    expect(onlyRevenue?.captureQuantity).toBe(0);

    const onlyCost = map.get(spreadCaptureKey(42, REGIONS.buyA.id, REGIONS.sell.id));
    expect(onlyCost?.noSellOrders).toBe(false);
    expect(onlyCost?.noBuyOrders).toBe(true);

    const both = map.get(spreadCaptureKey(43, REGIONS.buyA.id, REGIONS.sell.id));
    expect(both?.noSellOrders).toBe(true);
    expect(both?.noBuyOrders).toBe(true);
  });

  it('p95_buy 截断确实改变结果：天价钓鱼买单不进走量', async () => {
    // 有 p95 截断：只留 15@300
    const trimmed = await setup();
    await seedSellOrders(trimmed.db, REGIONS.buyA.id, 34, [{ price: 10, volume: 500 }]);
    await seedBuyOrders(trimmed.db, REGIONS.sell.id, 34, [
      { price: 1000, volume: 100 },
      { price: 15, volume: 300 },
    ]);
    await seedStats(trimmed.db, REGIONS.sell.id, 34, { p95Buy: 15 });
    const trimmedMap = await computeSpreadCapture(trimmed.db, [
      { typeId: 34, buyRegionId: REGIONS.buyA.id, sellRegionId: REGIONS.sell.id },
    ]);
    const trimmedResult = trimmedMap.get(spreadCaptureKey(34, REGIONS.buyA.id, REGIONS.sell.id));

    // 无 p95（无统计行）：两笔买单都参与
    const plain = await setup();
    await seedSellOrders(plain.db, REGIONS.buyA.id, 34, [{ price: 10, volume: 500 }]);
    await seedBuyOrders(plain.db, REGIONS.sell.id, 34, [
      { price: 1000, volume: 100 },
      { price: 15, volume: 300 },
    ]);
    const plainMap = await computeSpreadCapture(plain.db, [
      { typeId: 34, buyRegionId: REGIONS.buyA.id, sellRegionId: REGIONS.sell.id },
    ]);
    const plainResult = plainMap.get(spreadCaptureKey(34, REGIONS.buyA.id, REGIONS.sell.id));

    // 截断后：q* = 300（只对 15 成交）；未截断：q* = 400 且收益被 1000 抬高
    expect(trimmedResult?.captureQuantity).toBe(300);
    expect(trimmedResult?.revenueTotal).toBe(15 * 300);
    expect(plainResult?.captureQuantity).toBe(400);
    expect(plainResult?.revenueTotal).toBe(1000 * 100 + 15 * 300);
    expect(trimmedResult?.captureQuantity).not.toBe(plainResult?.captureQuantity);
  });

  it('口径对称：两侧都排除整批大单（min_volume > 1）', async () => {
    const { db } = await setup();
    await seedSellOrders(db, REGIONS.buyA.id, 34, [
      // 1 ISK 的整批大卖单：若参与会把成本压到接近 1
      { price: 1, volume: 10_000, minVolume: 10_000 },
      { price: 10, volume: 100 },
      { price: 20, volume: 100 },
    ]);
    await seedBuyOrders(db, REGIONS.sell.id, 34, [
      // 50 的整批大买单：若参与会抬高收益
      { price: 50, volume: 100, minVolume: 9_999 },
      { price: 40, volume: 100 },
    ]);
    await seedStats(db, REGIONS.sell.id, 34, { p95Buy: 50 });

    const map = await computeSpreadCapture(db, [
      { typeId: 34, buyRegionId: REGIONS.buyA.id, sellRegionId: REGIONS.sell.id },
    ]);
    const result = map.get(spreadCaptureKey(34, REGIONS.buyA.id, REGIONS.sell.id));

    // 成本侧只剩 10/20，收益侧只剩 40 → (10,40) 吃满 100 后收益耗尽
    expect(result?.captureQuantity).toBe(100);
    expect(result?.costTotal).toBe(1000);
    expect(result?.revenueTotal).toBe(4000);
  });

  it('去重、空入参、双向行（同一区域同时作为成本侧与收益侧）', async () => {
    const { db } = await setup();
    // buyA：卖单 10（成本）、买单 30（收益）；sell：卖单 20（成本）、买单 50（收益）
    await seedSellOrders(db, REGIONS.buyA.id, 34, [{ price: 10, volume: 100 }]);
    await seedBuyOrders(db, REGIONS.buyA.id, 34, [{ price: 30, volume: 100 }]);
    await seedSellOrders(db, REGIONS.sell.id, 34, [{ price: 20, volume: 100 }]);
    await seedBuyOrders(db, REGIONS.sell.id, 34, [{ price: 50, volume: 100 }]);
    await seedStats(db, REGIONS.buyA.id, 34, { p95Buy: 30 });
    await seedStats(db, REGIONS.sell.id, 34, { p95Buy: 50 });

    const duplicate = { typeId: 34, buyRegionId: REGIONS.buyA.id, sellRegionId: REGIONS.sell.id };
    const map = await computeSpreadCapture(db, [
      duplicate,
      duplicate,
      { typeId: 34, buyRegionId: REGIONS.sell.id, sellRegionId: REGIONS.buyA.id },
    ]);

    expect(map.size).toBe(2);
    const forward = map.get(spreadCaptureKey(34, REGIONS.buyA.id, REGIONS.sell.id));
    expect(forward?.costTotal).toBe(1000);
    expect(forward?.revenueTotal).toBe(5000);

    const backward = map.get(spreadCaptureKey(34, REGIONS.sell.id, REGIONS.buyA.id));
    expect(backward?.costTotal).toBe(2000);
    expect(backward?.revenueTotal).toBe(3000);

    expect((await computeSpreadCapture(db, [])).size).toBe(0);
  });

  it('与 P11-2 交叉自洽：Q\' = q* 时 filledQuantity 与成本逐位相等', async () => {
    const { db } = await setup();
    await seedSellOrders(db, REGIONS.buyA.id, 34, [
      { price: 10, volume: 100 },
      { price: 20, volume: 100 },
      { price: 30, volume: 100 },
    ]);
    await seedBuyOrders(db, REGIONS.sell.id, 34, [
      { price: 50, volume: 100 },
      { price: 40, volume: 100 },
    ]);
    await seedStats(db, REGIONS.sell.id, 34, { p95Buy: 60 });

    const capture = (
      await computeSpreadCapture(db, [
        { typeId: 34, buyRegionId: REGIONS.buyA.id, sellRegionId: REGIONS.sell.id },
      ])
    ).get(spreadCaptureKey(34, REGIONS.buyA.id, REGIONS.sell.id));
    const q = capture?.captureQuantity ?? 0;
    expect(q).toBe(200);

    const depth = await computeSpreadDepth(db, [{ regionId: REGIONS.buyA.id, typeId: 34 }], q);
    const sold = depth.get(spreadDepthKey(REGIONS.buyA.id, 34));

    expect(sold?.filledQuantity).toBe(q);
    expect((sold?.averagePrice ?? 0) * q).toBeCloseTo(capture?.costTotal ?? -1, 10);
  });

  it('与 P11-2 交叉自洽（成本档拆分的场景）', async () => {
    const { db } = await setup();
    await seedSellOrders(db, REGIONS.buyA.id, 35, [{ price: 10, volume: 100 }]);
    await seedBuyOrders(db, REGIONS.sell.id, 35, [
      { price: 50, volume: 60 },
      { price: 40, volume: 40 },
    ]);
    await seedStats(db, REGIONS.sell.id, 35, { p95Buy: 50 });

    const capture = (
      await computeSpreadCapture(db, [
        { typeId: 35, buyRegionId: REGIONS.buyA.id, sellRegionId: REGIONS.sell.id },
      ])
    ).get(spreadCaptureKey(35, REGIONS.buyA.id, REGIONS.sell.id));

    const depth = await computeSpreadDepth(
      db,
      [{ regionId: REGIONS.buyA.id, typeId: 35 }],
      capture?.captureQuantity ?? 0,
    );
    const sold = depth.get(spreadDepthKey(REGIONS.buyA.id, 35));

    expect(sold?.filledQuantity).toBe(capture?.captureQuantity);
    expect((sold?.averagePrice ?? 0) * (capture?.captureQuantity ?? 0)).toBeCloseTo(
      capture?.costTotal ?? -1,
      10,
    );
  });
});
