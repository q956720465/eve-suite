import { describe, expect, it } from 'vitest';

import { readSetting } from '../../src/db/settings';
import {
  DEFAULT_GLOBAL_SCAN_TIER,
  EMPTY_GLOBAL_SCAN_STATE,
  GLOBAL_SCAN_TIER_KEY,
  GLOBAL_SCAN_TIERS,
  getGlobalScanStatus,
  isScanDue,
  isScanInterrupted,
  listGlobalScanRegionIds,
  listMarketRegionIds,
  nextScanDueAt,
  parseGlobalScanTier,
  readGlobalScanState,
  readGlobalScanTier,
  writeGlobalScanState,
  writeGlobalScanTier,
  type GlobalScanState,
} from '../../src/market/global-state';
import { TRADE_HUBS } from '../../src/market/hubs';
import { createMigratedDb } from '../helpers/db';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-09-28T12:00:00.000Z');

/** 以 NOW 为基准的相对时刻（毫秒偏移）→ ISO 字符串 */
function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function state(overrides: Partial<GlobalScanState> = {}): GlobalScanState {
  return { ...EMPTY_GLOBAL_SCAN_STATE, ...overrides };
}

/** 写入 SDE 星域表（区域清单的唯一来源） */
async function seedRegions(
  db: Awaited<ReturnType<typeof createMigratedDb>>,
  regionIds: readonly number[],
): Promise<void> {
  for (const regionId of regionIds) {
    await db.execute('INSERT INTO sde_regions (region_id, name_en, name_zh) VALUES (?, ?, ?)', [
      regionId,
      `Region ${regionId}`,
      null,
    ]);
  }
}

describe('全域层档位', () => {
  it('五档可识别，非法与缺失回退默认 6h', () => {
    for (const tier of GLOBAL_SCAN_TIERS) {
      expect(parseGlobalScanTier(tier)).toBe(tier);
    }
    expect(GLOBAL_SCAN_TIERS).toEqual(['3h', '6h', '12h', '24h', 'off']);
    expect(DEFAULT_GLOBAL_SCAN_TIER).toBe('6h');
    expect(parseGlobalScanTier(null)).toBe('6h');
    expect(parseGlobalScanTier('1h')).toBe('6h');
    expect(parseGlobalScanTier('')).toBe('6h');
  });

  it('档位读写：落 settings 表，未设置时回读默认档', async () => {
    const db = await createMigratedDb();
    expect(await readGlobalScanTier(db)).toBe('6h');

    await writeGlobalScanTier(db, '12h');
    expect(await readGlobalScanTier(db)).toBe('12h');
    expect(await readSetting(db, GLOBAL_SCAN_TIER_KEY)).toBe('12h');

    await writeGlobalScanTier(db, 'off');
    expect(await readGlobalScanTier(db)).toBe('off');
  });
});

describe('全域层扫描状态', () => {
  it('空库读空状态；写入后可完整回读，且始终只有一行', async () => {
    const db = await createMigratedDb();
    expect(await readGlobalScanState(db)).toEqual(EMPTY_GLOBAL_SCAN_STATE);

    const written = state({
      lastStartedAt: iso(0),
      lastFinishedAt: iso(60_000),
      lastFullOkAt: iso(60_000),
      regionsTotal: 65,
      regionsOk: 65,
      requests: 850,
      ordersWritten: 1234,
      elapsedMs: 1_800_000,
    });
    await writeGlobalScanState(db, written);
    expect(await readGlobalScanState(db)).toEqual(written);

    const partial = {
      ...written,
      regionsOk: 64,
      regionsFailed: 1,
      lastError: '区域 10000060 采集失败',
      retryDueAt: iso(960_000),
    };
    await writeGlobalScanState(db, partial);
    expect(await readGlobalScanState(db)).toEqual(partial);

    const count = await db.select<{ n: number }>(
      'SELECT COUNT(*) AS n FROM market_global_scan_state',
    );
    expect(count[0].n).toBe(1);
  });

  it('中断判定：已开始未收尾、或收尾早于开始（应用被杀 / 页面重载）', () => {
    expect(isScanInterrupted(state())).toBe(false);
    expect(isScanInterrupted(state({ lastStartedAt: iso(-HOUR) }))).toBe(true);
    expect(isScanInterrupted(state({ lastStartedAt: iso(-HOUR), lastFinishedAt: iso(-2 * HOUR) }))).toBe(
      true,
    );
    expect(
      isScanInterrupted(state({ lastStartedAt: iso(-2 * HOUR), lastFinishedAt: iso(-HOUR) })),
    ).toBe(false);
  });

  it('到期判定：首启即扫 / 关闭档不扫 / 按期到期 / 重试到点 / 中断即扫', () => {
    // 从未扫描过 → 立即
    expect(isScanDue({ state: state(), tier: '6h', now: NOW })).toBe(true);
    // 关闭档：即使从未扫描也不自动扫
    expect(isScanDue({ state: state(), tier: 'off', now: NOW })).toBe(false);
    expect(
      isScanDue({ state: state({ lastFullOkAt: iso(-10 * HOUR) }), tier: 'off', now: NOW }),
    ).toBe(false);
    // 按期：满 6h 到期，差 6 分钟不到期
    expect(
      isScanDue({ state: state({ lastFullOkAt: iso(-6 * HOUR) }), tier: '6h', now: NOW }),
    ).toBe(true);
    expect(
      isScanDue({ state: state({ lastFullOkAt: iso(-5.9 * HOUR) }), tier: '6h', now: NOW }),
    ).toBe(false);
    expect(
      isScanDue({ state: state({ lastFullOkAt: iso(-24 * HOUR) }), tier: '24h', now: NOW }),
    ).toBe(true);
    // 重试时刻到点
    expect(
      isScanDue({
        state: state({ lastFullOkAt: iso(-HOUR), retryDueAt: iso(-1) }),
        tier: '6h',
        now: NOW,
      }),
    ).toBe(true);
    expect(
      isScanDue({
        state: state({ lastFullOkAt: iso(-HOUR), retryDueAt: iso(HOUR) }),
        tier: '6h',
        now: NOW,
      }),
    ).toBe(false);
    // 中断（24h 档也救不了：立即续扫）
    expect(
      isScanDue({
        state: state({ lastStartedAt: iso(-HOUR), lastFinishedAt: iso(-2 * HOUR), lastFullOkAt: iso(-2 * HOUR) }),
        tier: '24h',
        now: NOW,
      }),
    ).toBe(true);
  });

  it('下次到期时刻：关闭档为 null；已到期 / 中断 / 从未扫描返回 now', () => {
    expect(nextScanDueAt({ state: state(), tier: 'off', now: NOW })).toBeNull();
    expect(nextScanDueAt({ state: state(), tier: '6h', now: NOW })).toBe(NOW);
    expect(
      nextScanDueAt({ state: state({ lastFullOkAt: iso(-HOUR) }), tier: '6h', now: NOW }),
    ).toBe(NOW + 5 * HOUR);
    expect(
      nextScanDueAt({ state: state({ lastFullOkAt: iso(-7 * HOUR) }), tier: '6h', now: NOW }),
    ).toBe(NOW);
    // 重试时刻更早 → 取较早者
    expect(
      nextScanDueAt({
        state: state({ lastFullOkAt: iso(-HOUR), retryDueAt: iso(HOUR) }),
        tier: '6h',
        now: NOW,
      }),
    ).toBe(NOW + HOUR);
  });
});

describe('全域层区域清单', () => {
  it('已知空间区域 = 库内 [10000000, 10999999]（虫洞区排除）', async () => {
    const db = await createMigratedDb();
    await seedRegions(db, [10000002, 10000043, 10000001, 10000060, 11000001, 12000001]);
    expect(await listMarketRegionIds(db)).toEqual([10000001, 10000002, 10000043, 10000060]);
  });

  it('全域轮次清单排除 5 个枢纽区（方案 A）', async () => {
    const db = await createMigratedDb();
    await seedRegions(db, [10000002, 10000043, 10000001, 10000060]);
    const scanIds = await listGlobalScanRegionIds(db);
    expect(scanIds).toEqual([10000001, 10000060]);
    for (const hub of TRADE_HUBS) {
      expect(scanIds).not.toContain(hub.regionId);
    }
  });

  it('状态汇总：档位 / 下次到期 / 覆盖区域数与直采区域数', async () => {
    const db = await createMigratedDb();
    await seedRegions(db, [10000001, 10000002, 10000060]);
    await writeGlobalScanTier(db, '3h');
    await writeGlobalScanState(
      db,
      state({ lastStartedAt: iso(-HOUR), lastFinishedAt: iso(-HOUR), lastFullOkAt: iso(-HOUR) }),
    );

    const status = await getGlobalScanStatus(db, NOW);
    expect(status.tier).toBe('3h');
    expect(status.marketRegionCount).toBe(3);
    expect(status.scanRegionCount).toBe(2);
    expect(status.nextDueAt).toBe(NOW + 2 * HOUR);
  });
});
