import { describe, expect, it } from 'vitest';

import { EsiClient } from '../../src/esi/client';
import { RequestScheduler } from '../../src/esi/scheduler';
import {
  DEFAULT_SPREAD_FILTERS,
  getSpreadFreshness,
  judgeSpreadHistory,
  rankCrossRegionSpreads,
  readSpreadHistoryStats,
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
     VALUES (?, ?, ?, ?, 1000, 1000, ?, ?, NULL, ?, ?, ?)`,
    [
      regionId,
      typeId,
      seed.bestSell ?? null,
      seed.bestBuy ?? null,
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
