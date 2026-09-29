import type { DbAdapter } from '../db/types';
import { systemClock, type Clock } from '../esi/clock';

import { refineOre } from './refining';
import { getValuationPrice, type ValuationOptions } from './valuation';

/**
 * 采矿时薪引擎（方案 §6.2「采矿时薪」）。
 *
 * 口径（P5-5 定稿，经用户确认）：
 * - **时间基准 = 用户输入的「采矿速率 m³/小时」**（唯一时间基准）：
 *   测算器直接 `ISK/h = 速率 × 每 m³ 净产值`；账簿复盘用 `时长 = 体积 ÷ 速率` 反推时薪
 * - **EVE 日边界 = 每日停机（11:00 UTC / 北京 19:00）**：一天以停机为界，
 *   **未结束的当天不算一天** → 统计默认排除「当前进行中的 EVE 日」（见 `eveDayOf`）
 * - **收益口径完全复用 P4-4 精炼引擎**（产出率 preset + 税率），即「矿石精炼值（矿物价 − 损耗/税）」
 * - **账簿取整口径**：按 **（日期 + 矿石）汇总后**精炼（整份数只取整一次，贴近「集中精炼」）；
 *   于是 `总额 = Σ 日 = Σ 月 = Σ 矿石` 严格相等
 * - **未映射类型**（冰 / 月矿等无精炼映射）→ 用**原矿直卖价兜底**并标注
 * - **原矿直卖对照**：同时给出不精炼直接卖的收益，用于判断「该不该精炼」
 * - **零 ESI**：只读本地库
 */

/** EVE 每日停机时间（UTC 小时）—— EVE 的「一天」以停机为界 */
export const EVE_DOWNTIME_UTC_HOUR = 11;

/**
 * 求「当前 EVE 日」：把 UTC 时间**前移停机小时**后取 UTC 日期。
 *
 * 例（停机 11:00 UTC）：`2026-09-29T02:00Z` 仍属 EVE 日 `2026-09-28`
 * （该日到 09-29 11:00 停机才结束）；`2026-09-29T12:00Z` 才是 `2026-09-29`。
 */
export function eveDayOf(nowMs: number): string {
  return new Date(nowMs - EVE_DOWNTIME_UTC_HOUR * 3_600_000).toISOString().slice(0, 10);
}

/** 「上一个已结束的 EVE 日」（= 当前 EVE 日再前移一天） */
export function previousEveDay(nowMs: number): string {
  return new Date(nowMs - (EVE_DOWNTIME_UTC_HOUR + 24) * 3_600_000).toISOString().slice(0, 10);
}

/** 单一矿石的估值 / 精炼参数（复用精炼引擎） */
export interface MiningValuationOptions {
  /** 精炼产出率 0–1，默认精炼引擎默认（NPC 站 50%） */
  yieldRate?: number;
  /** 税率 0–1（按产值扣减），默认 0 */
  taxRate?: number;
  /** 价格口径（区域 / 站点 / basis / 离群过滤） */
  valuation?: ValuationOptions;
}

/**
 * 测算「每单位净产值」时使用的份数。
 * 取足够大以**摊薄整份取整偏差**（产出量按份 floor，只在份级发生一次）。
 */
const UNIT_VALUE_PORTIONS = 1000;

/** 单批 character_id 数量（保守低于 SQLite 变量上限） */
const CHARACTER_ID_CHUNK = 900;

export interface MiningRateInput extends MiningValuationOptions {
  oreTypeId: number;
  /** 采矿速率（m³/小时）—— 唯一时间基准 */
  cubicMetersPerHour: number;
}

export interface MiningRateResult {
  oreTypeId: number;
  cubicMetersPerHour: number;
  /** SDE 单位体积（m³）；缺失为 null → 无法折算单位数与时薪 */
  volume: number | null;
  /** 每小时采矿单位数 = floor(速率 ÷ 体积) */
  unitsPerHour: number | null;
  portionSize: number;
  yieldRate: number;
  taxRate: number;
  /** 精炼后：每单位净产值 / 每 m³ 净产值 */
  valuePerUnit: number;
  valuePerCubicMeter: number | null;
  /** 原矿直卖：每单位价 / 每 m³ 价 */
  rawUnitPrice: number | null;
  rawValuePerCubicMeter: number | null;
  /** 精炼后每小时收益（未映射或无体积时为 null） */
  refinedIskPerHour: number | null;
  /** 原矿直卖每小时收益 */
  rawIskPerHour: number | null;
  /** 实际采用值：优先精炼；未映射时退回原矿直卖 */
  iskPerHour: number | null;
  /** 采用路径：`refined` 精炼 / `raw` 原矿直卖兜底 / `none` 无价 */
  basis: 'refined' | 'raw' | 'none';
  /** 精炼相对直卖的倍率（两者都有正价时给值；用于判断是否值得精炼） */
  refineGainFactor: number | null;
  /** 该类型在 SDE 无精炼映射 */
  unmapped: boolean;
  /** 精炼产物中无报价的类型 */
  missingTypeIds: number[];
}

export interface MiningLedgerOptions extends MiningValuationOptions {
  /** 采矿速率（m³/小时）；**给了才算时薪**，不给则只出收益与体积（不编造数字） */
  cubicMetersPerHour?: number;
  /** 起始日期（含），`YYYY-MM-DD`（EVE 日口径） */
  fromDate?: string;
  /** 结束日期（含），`YYYY-MM-DD`（EVE 日口径） */
  toDate?: string;
  /** 时钟（默认系统时钟）：用于判定「当前进行中的 EVE 日」 */
  clock?: Clock;
  /**
   * 是否排除「**当前尚未结束的 EVE 日**」，默认 `true`。
   *
   * EVE 的一天以每日停机（11:00 UTC）为界，未结束的当天数据仍在增长、
   * 计入会让「有效天数 / 日均 / 时薪」不可比 —— 故默认只统计**已结束**的 EVE 日，
   * 进行中的那天单独放在 `unfinishedDay`（只给量与体积，不给收益）。
   */
  excludeUnfinishedDay?: boolean;
}

/** 被排除的「进行中 EVE 日」（只给量与体积，不给收益与年月聚合） */
export interface MiningUnfinishedDay {
  date: string;
  quantity: number;
  volume: number | null;
  volumeComplete: boolean;
}

export interface MiningLedgerOreLine {
  typeId: number;
  quantity: number;
  /** 合计体积（m³）；体积缺失为 null */
  volume: number | null;
  netValue: number;
  /** 原矿直卖对照值（同一数量） */
  rawValue: number;
  /** 是否走了「原矿直卖兜底」（无精炼映射） */
  fallbackToRaw: boolean;
}

export interface MiningLedgerDay {
  date: string;
  quantity: number;
  volume: number | null;
  /** 当日体积是否完整（任一矿石缺体积则为 false，此时不推时薪） */
  volumeComplete: boolean;
  netValue: number;
  /** 推算时长（小时）= 体积 ÷ 速率 */
  hours: number | null;
  /** 时薪 = netValue ÷ hours */
  iskPerHour: number | null;
  /** 当日涉及的星系 / 矿石种类数 */
  systems: number;
  ores: number;
}

export interface MiningLedgerMonth {
  /** `YYYY-MM` */
  month: string;
  quantity: number;
  volume: number | null;
  netValue: number;
  /** 该月有采矿记录的天数 */
  days: number;
  hours: number | null;
  iskPerHour: number | null;
}

export interface MiningLedgerSystemLine {
  solarSystemId: number;
  quantity: number;
  volume: number | null;
  /**
   * 净收益**按体积占比分摊**（同一体积口径下合计严格等于总收益）。
   * 星系比「日期+矿石」更细，无法复用主口径的取整结果，故用分摊而非独立精炼。
   */
  netValueAllocated: number;
}

export interface MiningLedgerResult {
  characterIds: number[];
  fromDate: string | null;
  toDate: string | null;
  cubicMetersPerHour: number | null;
  /** 当前 EVE 日（停机边界口径，`YYYY-MM-DD`） */
  currentEveDay: string;
  /** 上一个已结束的 EVE 日 —— 统计上真正的「昨天」 */
  lastFinishedEveDay: string;
  /** 是否已排除进行中的 EVE 日 */
  excludeUnfinishedDay: boolean;
  /** 被排除的进行中 EVE 日（该日无记录时为 null） */
  unfinishedDay: MiningUnfinishedDay | null;
  /** 合计：净收益 / 原矿直卖对照 / 数量 / 体积 */
  netValue: number;
  rawValue: number;
  quantity: number;
  volume: number | null;
  volumeComplete: boolean;
  /** 有采矿记录的天数 */
  activeDays: number;
  hours: number | null;
  iskPerHour: number | null;
  /** 精炼相对直卖的总倍率 */
  refineGainFactor: number | null;
  /** 按日期升序 */
  days: MiningLedgerDay[];
  /** 按月升序 */
  months: MiningLedgerMonth[];
  /** 按净收益降序 */
  ores: MiningLedgerOreLine[];
  /** 按数量降序 */
  systems: MiningLedgerSystemLine[];
  /** 精炼产物缺价类型（去重，按首次出现顺序） */
  missingTypeIds: number[];
  /** 无精炼映射（已按原矿直卖兜底）的类型 */
  unmappedTypeIds: number[];
}

function safeUnits(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

/** 取 SDE 单位体积（批量缓存由调用方维护） */
async function loadVolume(db: DbAdapter, typeId: number): Promise<number | null> {
  const rows = await db.select<{ volume: number | null }>(
    'SELECT volume AS volume FROM sde_types WHERE type_id = ?',
    [typeId],
  );
  const volume = rows[0]?.volume ?? null;
  return volume !== null && Number.isFinite(volume) && volume > 0 ? volume : null;
}

/**
 * 时薪测算器：给定矿石与**采矿速率（m³/小时）**，算出每小时 ISK 收益。
 *
 * `ISK/h = 速率 × 每 m³ 净精炼产值`；无精炼映射时退回**原矿直卖**并标注。
 */
export async function computeMiningRate(
  db: DbAdapter,
  input: MiningRateInput,
): Promise<MiningRateResult> {
  const cubicMetersPerHour =
    Number.isFinite(input.cubicMetersPerHour) && input.cubicMetersPerHour > 0
      ? input.cubicMetersPerHour
      : 0;
  const valuation = input.valuation ?? {};

  const volume = await loadVolume(db, input.oreTypeId);
  const rawPrice = (await getValuationPrice(db, input.oreTypeId, valuation)).price;

  // 先取份数，再用「足够多份」精炼以摊薄整份取整偏差
  const probe = await refineOre(db, {
    oreTypeId: input.oreTypeId,
    quantity: 0,
    ...(input.yieldRate === undefined ? {} : { yieldRate: input.yieldRate }),
    ...(input.taxRate === undefined ? {} : { taxRate: input.taxRate }),
    valuation,
  });
  const portionSize = safeUnits(probe.portionSize, 1);
  const refined = await refineOre(db, {
    oreTypeId: input.oreTypeId,
    quantity: portionSize * UNIT_VALUE_PORTIONS,
    ...(input.yieldRate === undefined ? {} : { yieldRate: input.yieldRate }),
    ...(input.taxRate === undefined ? {} : { taxRate: input.taxRate }),
    valuation,
  });

  const unmapped = refined.unmapped;
  const valuePerCubicMeter = unmapped ? null : refined.valuePerCubicMeter;
  const rawValuePerCubicMeter = rawPrice !== null && volume !== null ? rawPrice * volume : null;

  const refinedIskPerHour =
    valuePerCubicMeter !== null && volume !== null ? valuePerCubicMeter * cubicMetersPerHour : null;
  const rawIskPerHour = rawValuePerCubicMeter === null ? null : rawValuePerCubicMeter * cubicMetersPerHour;

  const basis: MiningRateResult['basis'] =
    refinedIskPerHour !== null ? 'refined' : rawIskPerHour !== null ? 'raw' : 'none';
  const iskPerHour =
    basis === 'refined' ? refinedIskPerHour : basis === 'raw' ? rawIskPerHour : null;

  const refineGainFactor =
    valuePerCubicMeter !== null && rawValuePerCubicMeter !== null && rawValuePerCubicMeter > 0
      ? valuePerCubicMeter / rawValuePerCubicMeter
      : null;

  return {
    oreTypeId: input.oreTypeId,
    cubicMetersPerHour,
    volume,
    unitsPerHour: volume === null ? null : Math.floor(cubicMetersPerHour / volume),
    portionSize,
    yieldRate: refined.yieldRate,
    taxRate: refined.taxRate,
    valuePerUnit: unmapped ? 0 : refined.valuePerUnit,
    valuePerCubicMeter,
    rawUnitPrice: rawPrice,
    rawValuePerCubicMeter,
    refinedIskPerHour,
    rawIskPerHour,
    iskPerHour,
    basis,
    refineGainFactor,
    unmapped,
    missingTypeIds: refined.missingTypeIds,
  };
}

/**
 * 采矿账簿复盘：按（日期 + 矿石）汇总后精炼，输出日 / 月 / 矿石 / 星系视角。
 *
 * 若给了 `cubicMetersPerHour`，则用 `时长 = 体积 ÷ 速率` 推算**时薪**；否则时薪为 null。
 */
export async function computeMiningLedger(
  db: DbAdapter,
  characterIds: readonly number[],
  options: MiningLedgerOptions = {},
): Promise<MiningLedgerResult> {
  const ids = [...characterIds];
  const valuation = options.valuation ?? {};
  const rate =
    options.cubicMetersPerHour !== undefined &&
    Number.isFinite(options.cubicMetersPerHour) &&
    options.cubicMetersPerHour > 0
      ? options.cubicMetersPerHour
      : null;

  // EVE 日边界：一天以每日停机（11:00 UTC）为界，未结束的当天不算一天
  const nowMs = (options.clock ?? systemClock).now();
  const currentEveDay = eveDayOf(nowMs);
  const lastFinishedEveDay = previousEveDay(nowMs);
  const excludeUnfinishedDay = options.excludeUnfinishedDay !== false;

  const empty: MiningLedgerResult = {
    characterIds: ids,
    fromDate: options.fromDate ?? null,
    toDate: options.toDate ?? null,
    cubicMetersPerHour: rate,
    currentEveDay,
    lastFinishedEveDay,
    excludeUnfinishedDay,
    unfinishedDay: null,
    netValue: 0,
    rawValue: 0,
    quantity: 0,
    volume: null,
    volumeComplete: true,
    activeDays: 0,
    hours: null,
    iskPerHour: null,
    refineGainFactor: null,
    days: [],
    months: [],
    ores: [],
    systems: [],
    missingTypeIds: [],
    unmappedTypeIds: [],
  };
  if (ids.length === 0) return empty;

  const filters: string[] = [];
  const params: unknown[] = [];
  if (options.fromDate !== undefined) {
    filters.push('date >= ?');
    params.push(options.fromDate);
  }
  if (options.toDate !== undefined) {
    filters.push('date <= ?');
    params.push(options.toDate);
  }
  if (excludeUnfinishedDay) {
    // 只统计已结束的 EVE 日；进行中的当天单独查（见下方 unfinishedDay）
    filters.push('date < ?');
    params.push(currentEveDay);
  }
  const extra = filters.length > 0 ? ` AND ${filters.join(' AND ')}` : '';

  interface LedgerRow {
    date: string;
    typeId: number;
    quantity: number;
  }
  interface SystemRow {
    solarSystemId: number;
    typeId: number;
    quantity: number;
  }
  interface DaySystemRow {
    date: string;
    systems: number;
  }

  const byDateType: LedgerRow[] = [];
  const bySystemType: SystemRow[] = [];
  const systemsPerDay = new Map<string, number>();

  for (let offset = 0; offset < ids.length; offset += CHARACTER_ID_CHUNK) {
    const chunk = ids.slice(offset, offset + CHARACTER_ID_CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    byDateType.push(
      ...(await db.select<LedgerRow>(
        `SELECT date AS date, type_id AS typeId, SUM(quantity) AS quantity
           FROM mining_ledger
          WHERE character_id IN (${placeholders})${extra}
          GROUP BY date, type_id
          ORDER BY date, type_id`,
        [...chunk, ...params],
      )),
    );
    bySystemType.push(
      ...(await db.select<SystemRow>(
        `SELECT solar_system_id AS solarSystemId, type_id AS typeId, SUM(quantity) AS quantity
           FROM mining_ledger
          WHERE character_id IN (${placeholders})${extra}
          GROUP BY solar_system_id, type_id`,
        [...chunk, ...params],
      )),
    );
    const dayRows = await db.select<DaySystemRow>(
      `SELECT date AS date, COUNT(DISTINCT solar_system_id) AS systems
         FROM mining_ledger
        WHERE character_id IN (${placeholders})${extra}
        GROUP BY date`,
      [...chunk, ...params],
    );
    for (const row of dayRows) {
      systemsPerDay.set(row.date, (systemsPerDay.get(row.date) ?? 0) + row.systems);
    }
  }

  if (byDateType.length === 0) return empty;

  // 同类型只算一次「每单位净产值」的辅助数据：体积缓存
  const volumeCache = new Map<number, number | null>();
  const volumeOf = async (typeId: number): Promise<number | null> => {
    if (!volumeCache.has(typeId)) volumeCache.set(typeId, await loadVolume(db, typeId));
    return volumeCache.get(typeId) ?? null;
  };
  const rawPriceCache = new Map<number, number | null>();
  const rawPriceOf = async (typeId: number): Promise<number | null> => {
    if (!rawPriceCache.has(typeId)) {
      rawPriceCache.set(typeId, (await getValuationPrice(db, typeId, valuation)).price);
    }
    return rawPriceCache.get(typeId) ?? null;
  };

  interface DailyRow {
    date: string;
    typeId: number;
    quantity: number;
    volume: number | null;
    netValue: number;
    rawValue: number;
    unmapped: boolean;
  }

  const missing = new Set<number>();
  const unmapped = new Set<number>();
  const daily: DailyRow[] = [];

  for (const row of byDateType) {
    // 口径：按（日期 + 矿石）汇总后精炼（跨星系合并）
    const refined = await refineOre(db, {
      oreTypeId: row.typeId,
      quantity: row.quantity,
      ...(options.yieldRate === undefined ? {} : { yieldRate: options.yieldRate }),
      ...(options.taxRate === undefined ? {} : { taxRate: options.taxRate }),
      valuation,
    });
    for (const typeId of refined.missingTypeIds) missing.add(typeId);

    const volume = await volumeOf(row.typeId);
    const rawPrice = await rawPriceOf(row.typeId);
    const rawValue = rawPrice === null ? 0 : rawPrice * row.quantity;

    let netValue: number;
    if (refined.unmapped) {
      // 无精炼映射 → 原矿直卖兜底
      unmapped.add(row.typeId);
      netValue = rawValue;
      if (rawPrice === null) missing.add(row.typeId);
    } else {
      netValue = refined.netValue;
    }

    daily.push({
      date: row.date,
      typeId: row.typeId,
      quantity: row.quantity,
      volume: volume === null ? null : volume * row.quantity,
      netValue,
      rawValue,
      unmapped: refined.unmapped,
    });
  }

  const sum = (pick: (row: DailyRow) => number): number =>
    daily.reduce((total, row) => total + pick(row), 0);

  const netValueTotal = sum((row) => row.netValue);
  const rawValueTotal = sum((row) => row.rawValue);
  const quantityTotal = sum((row) => row.quantity);
  const volumeComplete = daily.every((row) => row.volume !== null);
  const volumeTotal = volumeComplete ? sum((row) => row.volume ?? 0) : null;

  // 日聚合
  const dayMap = new Map<string, MiningLedgerDay>();
  for (const row of daily) {
    const existing = dayMap.get(row.date) ?? {
      date: row.date,
      quantity: 0,
      volume: 0,
      volumeComplete: true,
      netValue: 0,
      hours: null,
      iskPerHour: null,
      systems: systemsPerDay.get(row.date) ?? 0,
      ores: 0,
    };
    existing.quantity += row.quantity;
    existing.netValue += row.netValue;
    existing.ores += 1;
    if (row.volume === null) existing.volumeComplete = false;
    else existing.volume = (existing.volume ?? 0) + row.volume;
    dayMap.set(row.date, existing);
  }
  const days = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const day of days) {
    if (!day.volumeComplete || day.volume === null) {
      day.volume = day.volumeComplete ? day.volume : null;
      day.hours = null;
      day.iskPerHour = null;
      continue;
    }
    if (rate === null) continue;
    day.hours = day.volume / rate;
    day.iskPerHour = day.hours > 0 ? day.netValue / day.hours : null;
  }

  // 月聚合（用显式完整性标记：任一天缺体积 / 缺时薪都记为「不可算」，且不回填）
  interface MonthAcc {
    month: string;
    quantity: number;
    volume: number;
    volumeComplete: boolean;
    netValue: number;
    days: number;
    hours: number;
    hoursComplete: boolean;
  }
  const monthMap = new Map<string, MonthAcc>();
  for (const day of days) {
    const month = day.date.slice(0, 7);
    const existing = monthMap.get(month) ?? {
      month,
      quantity: 0,
      volume: 0,
      volumeComplete: true,
      netValue: 0,
      days: 0,
      hours: 0,
      hoursComplete: true,
    };
    existing.quantity += day.quantity;
    existing.netValue += day.netValue;
    existing.days += 1;
    if (day.volume === null) existing.volumeComplete = false;
    else existing.volume += day.volume;
    if (day.hours === null) existing.hoursComplete = false;
    else existing.hours += day.hours;
    monthMap.set(month, existing);
  }
  const months: MiningLedgerMonth[] = [...monthMap.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((acc) => {
      const hours = acc.hoursComplete ? acc.hours : null;
      return {
        month: acc.month,
        quantity: acc.quantity,
        volume: acc.volumeComplete ? acc.volume : null,
        netValue: acc.netValue,
        days: acc.days,
        hours,
        iskPerHour: hours !== null && hours > 0 ? acc.netValue / hours : null,
      };
    });

  // 矿石视角（与总额严格自洽：Σ 矿石 = 总额）
  const oreMap = new Map<number, MiningLedgerOreLine>();
  for (const row of daily) {
    const existing = oreMap.get(row.typeId) ?? {
      typeId: row.typeId,
      quantity: 0,
      volume: 0,
      netValue: 0,
      rawValue: 0,
      fallbackToRaw: row.unmapped,
    };
    existing.quantity += row.quantity;
    existing.netValue += row.netValue;
    existing.rawValue += row.rawValue;
    if (row.volume === null) existing.volume = null;
    else if (existing.volume !== null) existing.volume += row.volume;
    oreMap.set(row.typeId, existing);
  }
  const ores = [...oreMap.values()].sort(
    (a, b) => b.netValue - a.netValue || a.typeId - b.typeId,
  );

  // 星系视角：按体积占比分摊总额（合计严格等于总收益）
  const systemQuantity = new Map<number, number>();
  const systemVolume = new Map<number, number>();
  const systemVolumeComplete = new Map<number, boolean>();
  for (const row of bySystemType) {
    systemQuantity.set(row.solarSystemId, (systemQuantity.get(row.solarSystemId) ?? 0) + row.quantity);
    const volume = await volumeOf(row.typeId);
    if (volume === null) systemVolumeComplete.set(row.solarSystemId, false);
    else if (systemVolumeComplete.get(row.solarSystemId) !== false) {
      systemVolume.set(
        row.solarSystemId,
        (systemVolume.get(row.solarSystemId) ?? 0) + volume * row.quantity,
      );
    }
  }
  const totalWeight =
    volumeTotal !== null ? volumeTotal : quantityTotal; // 体积不全时退回按数量占比
  const systems: MiningLedgerSystemLine[] = [...systemQuantity.entries()]
    .map(([solarSystemId, quantity]) => {
      const complete = systemVolumeComplete.get(solarSystemId) !== false;
      const volume = complete ? (systemVolume.get(solarSystemId) ?? 0) : null;
      const weight = volumeTotal !== null && volume !== null ? volume : quantity;
      return {
        solarSystemId,
        quantity,
        volume,
        netValueAllocated: totalWeight > 0 ? (netValueTotal * weight) / totalWeight : 0,
      };
    })
    .sort((a, b) => b.quantity - a.quantity);

  // 进行中的 EVE 日（默认被排除在统计外）：只给量与体积，不给收益
  let unfinishedDay: MiningUnfinishedDay | null = null;
  if (excludeUnfinishedDay) {
    const uFilters = ['date = ?'];
    const uParams: unknown[] = [currentEveDay];
    if (options.fromDate !== undefined) {
      uFilters.push('date >= ?');
      uParams.push(options.fromDate);
    }
    if (options.toDate !== undefined) {
      uFilters.push('date <= ?');
      uParams.push(options.toDate);
    }
    let unfinishedQuantity = 0;
    let unfinishedVolume = 0;
    let unfinishedComplete = true;
    let hasRows = false;
    for (let offset = 0; offset < ids.length; offset += CHARACTER_ID_CHUNK) {
      const chunk = ids.slice(offset, offset + CHARACTER_ID_CHUNK);
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = await db.select<{ typeId: number; quantity: number }>(
        `SELECT type_id AS typeId, SUM(quantity) AS quantity
           FROM mining_ledger
          WHERE character_id IN (${placeholders}) AND ${uFilters.join(' AND ')}
          GROUP BY type_id`,
        [...chunk, ...uParams],
      );
      for (const row of rows) {
        hasRows = true;
        unfinishedQuantity += row.quantity;
        const volume = await volumeOf(row.typeId);
        if (volume === null) unfinishedComplete = false;
        else unfinishedVolume += volume * row.quantity;
      }
    }
    if (hasRows) {
      unfinishedDay = {
        date: currentEveDay,
        quantity: unfinishedQuantity,
        volume: unfinishedComplete ? unfinishedVolume : null,
        volumeComplete: unfinishedComplete,
      };
    }
  }

  const hoursTotal = (() => {
    if (rate === null || volumeTotal === null) return null;
    return volumeTotal / rate;
  })();

  return {
    characterIds: ids,
    fromDate: options.fromDate ?? null,
    toDate: options.toDate ?? null,
    cubicMetersPerHour: rate,
    currentEveDay,
    lastFinishedEveDay,
    excludeUnfinishedDay,
    unfinishedDay,
    netValue: netValueTotal,
    rawValue: rawValueTotal,
    quantity: quantityTotal,
    volume: volumeTotal,
    volumeComplete,
    activeDays: days.length,
    hours: hoursTotal,
    iskPerHour: hoursTotal !== null && hoursTotal > 0 ? netValueTotal / hoursTotal : null,
    refineGainFactor:
      rawValueTotal > 0 && !daily.every((row) => row.unmapped)
        ? netValueTotal / rawValueTotal
        : null,
    days,
    months,
    ores,
    systems,
    missingTypeIds: [...missing],
    unmappedTypeIds: [...unmapped],
  };
}
