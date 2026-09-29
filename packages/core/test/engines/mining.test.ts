import { describe, expect, it } from 'vitest';

import type { DbAdapter } from '../../src/db/types';
import {
  EVE_DOWNTIME_UTC_HOUR,
  computeMiningLedger as computeMiningLedgerRaw,
  computeMiningRate,
  eveDayOf,
  previousEveDay,
  type MiningLedgerOptions,
  type MiningLedgerResult,
} from '../../src/engines/mining';
import { createMigratedDb } from '../helpers/db';
import { createFakeClock } from '../helpers/fake-clock';

import { insertStats } from './fixtures';

/**
 * 固定时钟 = 2026-09-20T00:00Z（EVE 日 2026-09-19）：
 * 让「进行中 EVE 日」过滤不随真实时间漂移（本文件的账簿日期都在 09-01 ~ 09-08）。
 */
const NOW = Date.parse('2026-09-20T00:00:00Z');

/** 固定时钟包装（默认排除进行中的 EVE 日） */
function computeMiningLedger(
  db: DbAdapter,
  characterIds: readonly number[],
  options: MiningLedgerOptions = {},
): Promise<MiningLedgerResult> {
  return computeMiningLedgerRaw(db, characterIds, { clock: createFakeClock(NOW), ...options });
}

const TRITANIUM = 34;
const PYERITE = 35;
const VELDSPAR = 1230;
const SCORDITE = 1228;
const NO_MAPPING_ORE = 1239;
const ZERO_VOLUME_ORE = 1240;

const VELDSPAR_GROUP = 462;
const MINERAL_GROUP = 18;
const ASTEROID_CATEGORY = 25;
const MATERIAL_CATEGORY = 4;

const CHARACTER_ID = 2114553827;
const SYSTEM_A = 30000142;
const SYSTEM_B = 30000143;

async function insertCategory(db: DbAdapter, id: number, nameEn: string): Promise<void> {
  await db.execute(
    'INSERT INTO sde_categories (category_id, name_en, name_zh, published) VALUES (?, ?, NULL, 1)',
    [id, nameEn],
  );
}

async function insertGroup(db: DbAdapter, id: number, categoryId: number, nameEn: string): Promise<void> {
  await db.execute(
    'INSERT INTO sde_groups (group_id, category_id, name_en, name_zh, published) VALUES (?, ?, ?, NULL, 1)',
    [id, categoryId, nameEn],
  );
}

async function insertType(
  db: DbAdapter,
  options: { typeId: number; groupId: number; nameEn: string; portionSize: number; volume: number },
): Promise<void> {
  await db.execute(
    `INSERT INTO sde_types (type_id, group_id, name_en, name_zh, volume, portion_size, published)
     VALUES (?, ?, ?, NULL, ?, ?, 1)`,
    [options.typeId, options.groupId, options.nameEn, options.volume, options.portionSize],
  );
}

async function insertMaterials(
  db: DbAdapter,
  typeId: number,
  materials: readonly { typeId: number; quantity: number }[],
): Promise<void> {
  for (const material of materials) {
    await db.execute(
      'INSERT INTO sde_type_materials (type_id, material_type_id, quantity) VALUES (?, ?, ?)',
      [typeId, material.typeId, material.quantity],
    );
  }
}

async function insertMiningRow(
  db: DbAdapter,
  input: { date: string; solarSystemId: number; typeId: number; quantity: number; characterId?: number },
): Promise<void> {
  await db.execute(
    `INSERT INTO mining_ledger (character_id, date, solar_system_id, type_id, quantity, fetched_at)
     VALUES (?, ?, ?, ?, ?, '2026-09-27T00:00:00Z')`,
    [input.characterId ?? CHARACTER_ID, input.date, input.solarSystemId, input.typeId, input.quantity],
  );
}

/**
 * 测试库：
 * - Veldspar 1230（volume 0.1，每 100 单位 → 400 三钛），原矿直卖 6
 * - Scordite 1228（volume 0.15，每 100 单位 → 150 三钛 + 110 类晶体胶矿），原矿直卖 10
 * - 三角矿 1239 有类型但**无精炼映射**，原矿直卖 3
 * - 零体积矿 1240 有映射但 volume 0（体积缺失场景）
 * 三钛 5 / 类晶体胶矿 8
 */
async function setupDb(): Promise<DbAdapter> {
  const db = await createMigratedDb();
  await insertCategory(db, ASTEROID_CATEGORY, 'Asteroid');
  await insertCategory(db, MATERIAL_CATEGORY, 'Material');
  await insertGroup(db, VELDSPAR_GROUP, ASTEROID_CATEGORY, 'Veldspar');
  await insertGroup(db, MINERAL_GROUP, MATERIAL_CATEGORY, 'Mineral');

  await insertType(db, { typeId: TRITANIUM, groupId: MINERAL_GROUP, nameEn: 'Tritanium', portionSize: 1, volume: 0.01 });
  await insertType(db, { typeId: PYERITE, groupId: MINERAL_GROUP, nameEn: 'Pyerite', portionSize: 1, volume: 0.01 });
  await insertType(db, { typeId: VELDSPAR, groupId: VELDSPAR_GROUP, nameEn: 'Veldspar', portionSize: 100, volume: 0.1 });
  await insertType(db, { typeId: SCORDITE, groupId: VELDSPAR_GROUP, nameEn: 'Scordite', portionSize: 100, volume: 0.15 });
  await insertType(db, { typeId: NO_MAPPING_ORE, groupId: VELDSPAR_GROUP, nameEn: 'No Mapping Ore', portionSize: 100, volume: 0.2 });
  await insertType(db, { typeId: ZERO_VOLUME_ORE, groupId: VELDSPAR_GROUP, nameEn: 'Zero Volume Ore', portionSize: 100, volume: 0 });

  await insertMaterials(db, VELDSPAR, [{ typeId: TRITANIUM, quantity: 400 }]);
  await insertMaterials(db, SCORDITE, [
    { typeId: TRITANIUM, quantity: 150 },
    { typeId: PYERITE, quantity: 110 },
  ]);
  await insertMaterials(db, ZERO_VOLUME_ORE, [{ typeId: TRITANIUM, quantity: 400 }]);

  await insertStats(db, { typeId: TRITANIUM, p5Sell: 5 });
  await insertStats(db, { typeId: PYERITE, p5Sell: 8 });
  await insertStats(db, { typeId: VELDSPAR, p5Sell: 6 });
  await insertStats(db, { typeId: SCORDITE, p5Sell: 10 });
  await insertStats(db, { typeId: NO_MAPPING_ORE, p5Sell: 3 });
  await insertStats(db, { typeId: ZERO_VOLUME_ORE, p5Sell: 4 });
  return db;
}

describe('computeMiningRate（时薪测算器）', () => {
  it('精炼路径：ISK/h = 速率 × 每 m³ 净产值，并给出原矿直卖对照与增益倍率', async () => {
    const db = await setupDb();

    const result = await computeMiningRate(db, { oreTypeId: VELDSPAR, cubicMetersPerHour: 1000 });

    // 每 100 单位 → 400 三钛；产出率 50% → 每单位 2 三钛 × 5 ISK = 10 ISK/单位
    expect(result.valuePerUnit).toBe(10);
    expect(result.valuePerCubicMeter).toBe(100); // 10 ÷ 0.1
    expect(result.unitsPerHour).toBe(10000); // 1000 ÷ 0.1
    expect(result.refinedIskPerHour).toBe(100000); // 100 × 1000
    expect(result.rawUnitPrice).toBe(6);
    expect(result.rawValuePerCubicMeter).toBeCloseTo(0.6, 8); // 6 × 0.1
    expect(result.rawIskPerHour).toBeCloseTo(600, 6);
    expect(result.basis).toBe('refined');
    expect(result.iskPerHour).toBe(100000);
    expect(result.refineGainFactor).toBeCloseTo(100 / 0.6, 8);
    expect(result.unmapped).toBe(false);
    expect(result.yieldRate).toBe(0.5);
    expect(result.taxRate).toBe(0);
    expect(result.missingTypeIds).toEqual([]);
  });

  it('精炼产出率与税率可切（复用精炼引擎口径）', async () => {
    const db = await setupDb();

    // 产出率 100% → 每单位 4 三钛 × 5 = 20 ISK/单位；税率 10% → 18
    const result = await computeMiningRate(db, {
      oreTypeId: VELDSPAR,
      cubicMetersPerHour: 100,
      yieldRate: 1,
      taxRate: 0.1,
    });

    expect(result.valuePerUnit).toBeCloseTo(18, 8);
    expect(result.valuePerCubicMeter).toBeCloseTo(180, 8);
    expect(result.iskPerHour).toBeCloseTo(18000, 6);
  });

  it('无精炼映射：退回原矿直卖并标注', async () => {
    const db = await setupDb();

    const result = await computeMiningRate(db, { oreTypeId: NO_MAPPING_ORE, cubicMetersPerHour: 1000 });

    expect(result.unmapped).toBe(true);
    expect(result.valuePerCubicMeter).toBeNull();
    expect(result.refinedIskPerHour).toBeNull();
    expect(result.rawIskPerHour).toBeCloseTo(600, 6); // 3 × 0.2 × 1000
    expect(result.basis).toBe('raw');
    expect(result.iskPerHour).toBeCloseTo(600, 6);
    expect(result.refineGainFactor).toBeNull();
  });

  it('体积缺失：明确给出 null（不静默为 0），并标注缺失', async () => {
    const db = await setupDb();

    const result = await computeMiningRate(db, { oreTypeId: ZERO_VOLUME_ORE, cubicMetersPerHour: 1000 });

    expect(result.volume).toBeNull();
    expect(result.unitsPerHour).toBeNull();
    expect(result.valuePerCubicMeter).toBeNull();
    expect(result.refinedIskPerHour).toBeNull();
    expect(result.rawIskPerHour).toBeNull();
    expect(result.basis).toBe('none');
    expect(result.iskPerHour).toBeNull();
  });

  it('速率为 0 / 负数：按 0 处理，不产生 Infinity', async () => {
    const db = await setupDb();

    const result = await computeMiningRate(db, { oreTypeId: VELDSPAR, cubicMetersPerHour: -5 });

    expect(result.cubicMetersPerHour).toBe(0);
    expect(result.iskPerHour).toBe(0);
    expect(Number.isFinite(result.iskPerHour ?? Number.NaN)).toBe(true);
  });
});

describe('EVE 日边界（停机 11:00 UTC / 北京 19:00）', () => {
  it('一天以停机为界：停机前仍属前一天，过后才是新的一天', () => {
    expect(EVE_DOWNTIME_UTC_HOUR).toBe(11);
    expect(eveDayOf(Date.parse('2026-09-29T02:00:00Z'))).toBe('2026-09-28'); // 停机前
    expect(eveDayOf(Date.parse('2026-09-29T10:59:00Z'))).toBe('2026-09-28'); // 停机前一分钟
    expect(eveDayOf(Date.parse('2026-09-29T11:00:00Z'))).toBe('2026-09-29'); // 停机瞬间
    expect(eveDayOf(Date.parse('2026-09-29T23:00:00Z'))).toBe('2026-09-29');
    expect(previousEveDay(Date.parse('2026-09-29T12:00:00Z'))).toBe('2026-09-28');
    expect(previousEveDay(Date.parse('2026-09-29T02:00:00Z'))).toBe('2026-09-27');
  });

  it('进行中的 EVE 日不计入统计，单独放在 unfinishedDay；可选包含', async () => {
    const db = await setupDb();
    await insertMiningRow(db, { date: '2026-09-07', solarSystemId: SYSTEM_A, typeId: VELDSPAR, quantity: 100000 });
    await insertMiningRow(db, { date: '2026-09-08', solarSystemId: SYSTEM_A, typeId: VELDSPAR, quantity: 50000 });
    // 2026-09-09T02:00Z → 停机 11:00 UTC，此刻 EVE 日仍是 09-08（进行中）
    const clock = createFakeClock(Date.parse('2026-09-09T02:00:00Z'));

    const excluded = await computeMiningLedgerRaw(db, [CHARACTER_ID], { clock, cubicMetersPerHour: 1000 });

    expect(excluded.currentEveDay).toBe('2026-09-08');
    expect(excluded.lastFinishedEveDay).toBe('2026-09-07');
    expect(excluded.excludeUnfinishedDay).toBe(true);
    expect(excluded.days.map((day) => day.date)).toEqual(['2026-09-07']);
    expect(excluded.activeDays).toBe(1);
    expect(excluded.netValue).toBe(1000000); // 只算 09-07
    expect(excluded.unfinishedDay?.date).toBe('2026-09-08');
    expect(excluded.unfinishedDay?.quantity).toBe(50000);
    expect(excluded.unfinishedDay?.volume).toBeCloseTo(5000, 8);
    // 时薪只按已结束的日算：1,000,000 / (10,000 ÷ 1000) = 100,000
    expect(excluded.hours).toBeCloseTo(10, 8);
    expect(excluded.iskPerHour).toBeCloseTo(100000, 6);

    const included = await computeMiningLedgerRaw(db, [CHARACTER_ID], {
      clock,
      excludeUnfinishedDay: false,
    });
    expect(included.days.map((day) => day.date)).toEqual(['2026-09-07', '2026-09-08']);
    expect(included.netValue).toBe(1500000);
    expect(included.unfinishedDay).toBeNull();
  });

  it('停机后（同一天 11:00 UTC 之后）：该 EVE 日刚好变为「已结束」', () => {
    // 2026-09-09T11:30Z → EVE 日 09-09（进行中），已结束的最新日 = 09-08
    expect(eveDayOf(Date.parse('2026-09-09T11:30:00Z'))).toBe('2026-09-09');
    expect(previousEveDay(Date.parse('2026-09-09T11:30:00Z'))).toBe('2026-09-08');
    // 2026-09-10T11:30Z → 已结束的最新日 = 09-09（即 09-09 这天到此时才算一天）
    expect(previousEveDay(Date.parse('2026-09-10T11:30:00Z'))).toBe('2026-09-09');
  });
});

describe('computeMiningLedger（账簿复盘）', () => {
  async function seedLedger(db: DbAdapter): Promise<void> {
    // 09-01 星系 A：Veldspar 100,000 + Scordite 100,000
    await insertMiningRow(db, { date: '2026-09-01', solarSystemId: SYSTEM_A, typeId: VELDSPAR, quantity: 100000 });
    await insertMiningRow(db, { date: '2026-09-01', solarSystemId: SYSTEM_A, typeId: SCORDITE, quantity: 100000 });
    // 09-02 星系 B：Veldspar 50,000
    await insertMiningRow(db, { date: '2026-09-02', solarSystemId: SYSTEM_B, typeId: VELDSPAR, quantity: 50000 });
  }

  it('日 / 月 / 总额严格自洽，且给速率时按「体积 ÷ 速率」算时薪', async () => {
    const db = await setupDb();
    await seedLedger(db);

    const result = await computeMiningLedger(db, [CHARACTER_ID], { cubicMetersPerHour: 1000 });

    // 09-01：Veldspar 1,000,000（1000 份 × 400 × 0.5 × 5）+ Scordite 815,000（75,000×5 + 55,000×8）
    const day1 = result.days[0];
    expect(day1.date).toBe('2026-09-01');
    expect(day1.quantity).toBe(200000);
    expect(day1.volume).toBeCloseTo(25000, 8); // 100,000×0.1 + 100,000×0.15
    expect(day1.netValue).toBe(1815000);
    expect(day1.hours).toBeCloseTo(25, 8);
    expect(day1.iskPerHour).toBeCloseTo(72600, 6);
    expect(day1.ores).toBe(2);
    expect(day1.systems).toBe(1);

    const day2 = result.days[1];
    expect(day2.date).toBe('2026-09-02');
    expect(day2.netValue).toBe(500000);
    expect(day2.volume).toBeCloseTo(5000, 8);
    expect(day2.hours).toBeCloseTo(5, 8);
    expect(day2.iskPerHour).toBeCloseTo(100000, 6);

    // 合计
    expect(result.quantity).toBe(250000);
    expect(result.volume).toBeCloseTo(30000, 8);
    expect(result.netValue).toBe(2315000);
    expect(result.activeDays).toBe(2);
    expect(result.hours).toBeCloseTo(30, 8);
    expect(result.iskPerHour).toBeCloseTo(2315000 / 30, 6);

    // 月聚合 = Σ 日
    expect(result.months).toHaveLength(1);
    const month = result.months[0];
    expect(month.month).toBe('2026-09');
    expect(month.netValue).toBe(day1.netValue + day2.netValue);
    expect(month.quantity).toBe(day1.quantity + day2.quantity);
    expect(month.days).toBe(2);
    expect(month.hours).toBeCloseTo(30, 8);
    expect(month.iskPerHour).toBeCloseTo(2315000 / 30, 6);

    // 矿石视角 = 总额
    expect(result.ores.reduce((sum, ore) => sum + ore.netValue, 0)).toBeCloseTo(result.netValue, 6);
    expect(result.ores[0].typeId).toBe(VELDSPAR); // 1,500,000 > 815,000
    expect(result.ores[0].netValue).toBe(1500000);
    expect(result.ores[1].netValue).toBe(815000);

    // 原矿直卖对照：Veldspar 150,000×6 + Scordite 100,000×10
    expect(result.rawValue).toBe(1900000);
    expect(result.refineGainFactor).toBeCloseTo(2315000 / 1900000, 8);

    // 星系分摊之和 = 总额
    expect(result.systems).toHaveLength(2);
    expect(result.systems.reduce((sum, item) => sum + item.netValueAllocated, 0)).toBeCloseTo(
      result.netValue,
      6,
    );
    expect(result.systems[0].solarSystemId).toBe(SYSTEM_A); // 数量更多者在前
  });

  it('不给速率：不出时薪（null），收益与体积照常', async () => {
    const db = await setupDb();
    await seedLedger(db);

    const result = await computeMiningLedger(db, [CHARACTER_ID]);

    expect(result.netValue).toBe(2315000);
    expect(result.hours).toBeNull();
    expect(result.iskPerHour).toBeNull();
    expect(result.days.every((day) => day.hours === null && day.iskPerHour === null)).toBe(true);
    expect(result.months[0].iskPerHour).toBeNull();
  });

  it('取整口径：同一（日期 + 矿石）跨星系先合并再精炼（整份数只取整一次）', async () => {
    const db = await setupDb();
    // 两个星系各 150 单位：合并 300 → 3 份 → 600 三钛；若各自精炼只有 1 份 ×2 = 400 三钛
    await insertMiningRow(db, { date: '2026-09-05', solarSystemId: SYSTEM_A, typeId: VELDSPAR, quantity: 150 });
    await insertMiningRow(db, { date: '2026-09-05', solarSystemId: SYSTEM_B, typeId: VELDSPAR, quantity: 150 });

    const result = await computeMiningLedger(db, [CHARACTER_ID]);

    expect(result.days).toHaveLength(1);
    expect(result.days[0].quantity).toBe(300);
    expect(result.days[0].netValue).toBe(3000); // 600 × 5（而非 2,000）
    expect(result.days[0].systems).toBe(2);
    expect(result.systems).toHaveLength(2);
  });

  it('无精炼映射：按原矿直卖兜底并标注', async () => {
    const db = await setupDb();
    await insertMiningRow(db, { date: '2026-09-06', solarSystemId: SYSTEM_A, typeId: NO_MAPPING_ORE, quantity: 1000 });

    const result = await computeMiningLedger(db, [CHARACTER_ID]);

    expect(result.netValue).toBe(3000); // 1000 × 3
    expect(result.unmappedTypeIds).toEqual([NO_MAPPING_ORE]);
    expect(result.ores[0].fallbackToRaw).toBe(true);
    expect(result.ores[0].rawValue).toBe(3000);
  });

  it('体积不全：volumeComplete=false 且不出时薪（即便给了速率）', async () => {
    const db = await setupDb();
    await insertMiningRow(db, { date: '2026-09-07', solarSystemId: SYSTEM_A, typeId: VELDSPAR, quantity: 10000 });
    await insertMiningRow(db, { date: '2026-09-07', solarSystemId: SYSTEM_A, typeId: ZERO_VOLUME_ORE, quantity: 10000 });

    const result = await computeMiningLedger(db, [CHARACTER_ID], { cubicMetersPerHour: 1000 });

    expect(result.volumeComplete).toBe(false);
    expect(result.volume).toBeNull();
    expect(result.hours).toBeNull();
    expect(result.iskPerHour).toBeNull();
    expect(result.days[0].volumeComplete).toBe(false);
    expect(result.days[0].hours).toBeNull();
    expect(result.netValue).toBeGreaterThan(0); // 收益仍照常
  });

  it('日期范围过滤：只统计范围内的记录', async () => {
    const db = await setupDb();
    await seedLedger(db);

    const result = await computeMiningLedger(db, [CHARACTER_ID], { fromDate: '2026-09-02' });

    expect(result.activeDays).toBe(1);
    expect(result.days[0].date).toBe('2026-09-02');
    expect(result.netValue).toBe(500000);
  });

  it('空账簿 / 空角色列表：返回全零空结果，不报错', async () => {
    const db = await setupDb();

    const emptyLedger = await computeMiningLedger(db, [CHARACTER_ID]);
    expect(emptyLedger.netValue).toBe(0);
    expect(emptyLedger.activeDays).toBe(0);
    expect(emptyLedger.days).toEqual([]);
    expect(emptyLedger.months).toEqual([]);
    expect(emptyLedger.iskPerHour).toBeNull();

    const emptyChars = await computeMiningLedger(db, []);
    expect(emptyChars.netValue).toBe(0);
    expect(emptyChars.days).toEqual([]);
  });

  it('多角色合并记账', async () => {
    const db = await setupDb();
    const other = 96099999;
    await insertMiningRow(db, { date: '2026-09-08', solarSystemId: SYSTEM_A, typeId: VELDSPAR, quantity: 100000 });
    await insertMiningRow(db, {
      date: '2026-09-08',
      solarSystemId: SYSTEM_A,
      typeId: VELDSPAR,
      quantity: 100000,
      characterId: other,
    });

    const result = await computeMiningLedger(db, [CHARACTER_ID, other]);

    expect(result.quantity).toBe(200000);
    expect(result.netValue).toBe(2000000);
    expect(result.characterIds).toEqual([CHARACTER_ID, other]);
  });
});
