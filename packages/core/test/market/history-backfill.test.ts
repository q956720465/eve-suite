import { describe, expect, it } from 'vitest';

import {
  DEFAULT_HISTORY_BACKFILL_TIER,
  EMPTY_HISTORY_BACKFILL_STATE,
  HISTORY_BACKFILL_REGION_IDS,
  countBackfillPairs,
  isBackfillDue,
  isBackfillInterrupted,
  listBackfillPairs,
  nextBackfillDueAt,
  parseHistoryBackfillTier,
  readHistoryBackfillTier,
  writeHistoryBackfillTier,
  type HistoryBackfillState,
} from '../../src/market';
import { createMigratedDb } from '../helpers/db';

/** 5 枢纽里的前两个（伏尔戈 / 多美）与一个非枢纽区 */
const HUB_A = HISTORY_BACKFILL_REGION_IDS[0];
const HUB_B = HISTORY_BACKFILL_REGION_IDS[1];
const NON_HUB = 10000001;

const HOUR_MS = 3_600_000;

type Db = Awaited<ReturnType<typeof createMigratedDb>>;

/** 种一条 market_stats（清单筛选只看订单数，其余列留空） */
async function seedStats(
  db: Db,
  regionId: number,
  typeId: number,
  orders: { sell?: number; buy?: number } = {},
): Promise<void> {
  await db.execute(
    `INSERT INTO market_stats
       (region_id, type_id, best_sell, best_buy, sell_volume, buy_volume,
        sell_orders, buy_orders, spread, p5_sell, p95_buy, updated_at)
     VALUES (?, ?, NULL, NULL, 0, 0, ?, ?, NULL, NULL, NULL, '2026-09-27T01:00:00Z')`,
    [regionId, typeId, orders.sell ?? 10, orders.buy ?? 10],
  );
}

function stateOf(overrides: Partial<HistoryBackfillState>): HistoryBackfillState {
  return { ...EMPTY_HISTORY_BACKFILL_STATE, ...overrides };
}

describe('初始化清单（5 枢纽 + 订单数门槛）', () => {
  it('只取 5 枢纽，且按「卖单数或买单数达门槛」筛选（OR 口径）', async () => {
    const db = await createMigratedDb();
    await seedStats(db, HUB_A, 1, { sell: 10, buy: 10 }); // 两侧都够 → 含
    await seedStats(db, HUB_A, 2, { sell: 2, buy: 2 }); // 两侧都不够 → 不含
    await seedStats(db, HUB_A, 3, { sell: 10, buy: 1 }); // 仅卖侧够 → 含
    await seedStats(db, HUB_A, 4, { sell: 1, buy: 10 }); // 仅买侧够 → 含
    await seedStats(db, HUB_A, 5, { sell: 5, buy: 5 }); // 恰好等于门槛 → 含
    await seedStats(db, NON_HUB, 1, { sell: 10, buy: 10 }); // 非枢纽 → 不含

    const pairs = await listBackfillPairs(db);

    expect(pairs.map((pair) => pair.typeId)).toEqual([1, 3, 4, 5]);
    expect(pairs.every((pair) => HISTORY_BACKFILL_REGION_IDS.includes(pair.regionId))).toBe(true);
    expect(await countBackfillPairs(db)).toBe(4);
  });

  it('按 (区域, 物品) 固定排序，保证续跑可复现', async () => {
    const db = await createMigratedDb();
    await seedStats(db, HUB_B, 9);
    await seedStats(db, HUB_A, 8);
    await seedStats(db, HUB_A, 7);

    const pairs = await listBackfillPairs(db);

    expect(pairs.map((pair) => `${pair.regionId}:${pair.typeId}`)).toEqual([
      `${HUB_A}:7`,
      `${HUB_A}:8`,
      `${HUB_B}:9`,
    ]);
  });
});

describe('状态与到期判定（P5-2.6 保留：供状态展示与中断判据）', () => {
  it('默认档位为 24h；非法值回退默认', async () => {
    const db = await createMigratedDb();
    expect(await readHistoryBackfillTier(db)).toBe(DEFAULT_HISTORY_BACKFILL_TIER);
    expect(parseHistoryBackfillTier('off')).toBe('off');
    expect(parseHistoryBackfillTier('24h')).toBe('24h');
    expect(parseHistoryBackfillTier('3h')).toBe('24h');
    expect(parseHistoryBackfillTier(null)).toBe('24h');
  });

  it('档位写库后可读回', async () => {
    const db = await createMigratedDb();
    await writeHistoryBackfillTier(db, 'off');
    expect(await readHistoryBackfillTier(db)).toBe('off');
    await writeHistoryBackfillTier(db, '24h');
    expect(await readHistoryBackfillTier(db)).toBe('24h');
  });

  it('到期判定：从未预拉 / 24h 内 / 超 24h / 关闭档 / 中断 / 待重试', () => {
    const now = Date.UTC(2026, 8, 28, 2, 0, 0);

    expect(isBackfillDue({ state: EMPTY_HISTORY_BACKFILL_STATE, tier: '24h', now })).toBe(true);

    const fresh = stateOf({ lastFullOkAt: new Date(now - HOUR_MS).toISOString() });
    expect(isBackfillDue({ state: fresh, tier: '24h', now })).toBe(false);

    const stale = stateOf({ lastFullOkAt: new Date(now - 25 * HOUR_MS).toISOString() });
    expect(isBackfillDue({ state: stale, tier: '24h', now })).toBe(true);

    expect(isBackfillDue({ state: EMPTY_HISTORY_BACKFILL_STATE, tier: 'off', now })).toBe(false);

    const interrupted = stateOf({
      lastStartedAt: new Date(now - HOUR_MS).toISOString(),
      lastFinishedAt: null,
    });
    expect(isBackfillInterrupted(interrupted)).toBe(true);
    expect(isBackfillDue({ state: interrupted, tier: '24h', now })).toBe(true);

    const retrying = stateOf({
      lastFullOkAt: new Date(now - HOUR_MS).toISOString(),
      retryDueAt: new Date(now - 60_000).toISOString(),
    });
    expect(isBackfillDue({ state: retrying, tier: '24h', now })).toBe(true);
  });

  it('下次到期时刻：关闭档为 null，从未预拉为 now', () => {
    const now = Date.UTC(2026, 8, 28, 2, 0, 0);
    expect(nextBackfillDueAt({ state: EMPTY_HISTORY_BACKFILL_STATE, tier: 'off', now })).toBeNull();
    expect(nextBackfillDueAt({ state: EMPTY_HISTORY_BACKFILL_STATE, tier: '24h', now })).toBe(now);

    const fresh = stateOf({ lastFullOkAt: new Date(now).toISOString() });
    expect(nextBackfillDueAt({ state: fresh, tier: '24h', now })).toBe(now + 24 * HOUR_MS);
  });
});
