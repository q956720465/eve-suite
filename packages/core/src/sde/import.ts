import type { DbAdapter } from '../db/types';

import { insertRows } from './batch';
import { pickEn, pickZh } from './normalize';
import {
  mapBlueprintRows,
  mapCategory,
  mapConstellation,
  mapGroup,
  mapRegion,
  mapStation,
  mapSystem,
  mapType,
  type StationContext,
} from './parse';
import type {
  RawBlueprint,
  RawCategory,
  RawConstellation,
  RawGroup,
  RawNpcCorporation,
  RawNpcStation,
  RawRegion,
  RawSolarSystem,
  RawStationOperation,
  RawType,
  SdeFileSource,
  SdeFileName,
  SdeImportProgress,
  SdeImportSummary,
} from './types';

export interface ImportSdeOptions {
  /** 强制重新导入（默认同版本跳过） */
  force?: boolean;
  onProgress?: (progress: SdeImportProgress) => void;
}

const CATEGORY_COLUMNS = ['category_id', 'name_en', 'name_zh', 'published'] as const;
const GROUP_COLUMNS = ['group_id', 'category_id', 'name_en', 'name_zh', 'published'] as const;
const TYPE_COLUMNS = [
  'type_id',
  'group_id',
  'name_en',
  'name_zh',
  'description_en',
  'description_zh',
  'volume',
  'packaged_volume',
  'mass',
  'capacity',
  'portion_size',
  'base_price',
  'market_group_id',
  'icon_id',
  'published',
] as const;
const REGION_COLUMNS = ['region_id', 'name_en', 'name_zh'] as const;
const CONSTELLATION_COLUMNS = ['constellation_id', 'region_id', 'name_en', 'name_zh'] as const;
const SYSTEM_COLUMNS = [
  'system_id',
  'constellation_id',
  'region_id',
  'name_en',
  'name_zh',
  'security_status',
  'security_class',
] as const;
const STATION_COLUMNS = [
  'station_id',
  'type_id',
  'solar_system_id',
  'region_id',
  'owner_id',
  'operation_id',
  'celestial_index',
  'orbit_index',
  'orbit_id',
  'use_operation_name',
  'name_en',
  'name_zh',
  'system_name_en',
  'system_name_zh',
  'region_name_en',
  'region_name_zh',
] as const;
const BLUEPRINT_COLUMNS = ['blueprint_type_id', 'max_production_limit'] as const;
const ACTIVITY_COLUMNS = ['blueprint_type_id', 'activity', 'time_seconds'] as const;
const IO_COLUMNS = ['blueprint_type_id', 'activity', 'direction', 'type_id', 'quantity'] as const;

/** 重新导入前需清空的表（无外键约束，顺序无关） */
const TABLES_TO_CLEAR = [
  'sde_blueprint_io',
  'sde_blueprint_activities',
  'sde_blueprints',
  'sde_stations',
  'sde_systems',
  'sde_constellations',
  'sde_regions',
  'sde_types',
  'sde_groups',
  'sde_categories',
  'sde_meta',
] as const;

const META_BUILD_NUMBER = 'build_number';

/**
 * 导入 SDE 静态数据。
 * 单事务执行：失败整体回滚，不留半成品；同版本重复调用直接跳过（除 force）。
 */
export async function importSde(
  db: DbAdapter,
  source: SdeFileSource,
  options: ImportSdeOptions = {},
): Promise<SdeImportSummary> {
  const startedAt = Date.now();
  const version = await source.version();
  const existing = await readMeta(db, META_BUILD_NUMBER);

  if (!options.force && existing === String(version.buildNumber)) {
    return { skipped: true, version, counts: {}, elapsedMs: Date.now() - startedAt };
  }

  const counts: Record<string, number> = {};

  // 整次导入在单个事务内完成：失败整体回滚，不留半成品数据
  await db.transaction(async (tx) => {
    for (const table of TABLES_TO_CLEAR) {
      await tx.execute(`DELETE FROM ${table}`);
    }

    counts.categories = await importSimple<RawCategory>(
      tx, source, 'categories.jsonl', mapCategory, CATEGORY_COLUMNS, 'sde_categories', options,
    );
    counts.groups = await importSimple<RawGroup>(
      tx, source, 'groups.jsonl', mapGroup, GROUP_COLUMNS, 'sde_groups', options,
    );
    counts.types = await importSimple<RawType>(
      tx, source, 'types.jsonl', mapType, TYPE_COLUMNS, 'sde_types', options,
    );
    counts.regions = await importSimple<RawRegion>(
      tx, source, 'mapRegions.jsonl', mapRegion, REGION_COLUMNS, 'sde_regions', options,
    );
    counts.constellations = await importSimple<RawConstellation>(
      tx, source, 'mapConstellations.jsonl', mapConstellation, CONSTELLATION_COLUMNS, 'sde_constellations', options,
    );
    counts.systems = await importSimple<RawSolarSystem>(
      tx, source, 'mapSolarSystems.jsonl', mapSystem, SYSTEM_COLUMNS, 'sde_systems', options,
    );
    counts.stations = await importStations(tx, source, options);

    const blueprints = await importBlueprints(tx, source, options);
    counts.blueprints = blueprints.blueprints;
    counts.blueprint_activities = blueprints.activities;
    counts.blueprint_io = blueprints.io;

    await writeMeta(tx, META_BUILD_NUMBER, String(version.buildNumber));
    await writeMeta(tx, 'release_date', version.releaseDate);
    await writeMeta(tx, 'imported_at', new Date().toISOString());
    for (const [table, rows] of Object.entries(counts)) {
      await writeMeta(tx, `rows_${table}`, String(rows));
    }
  });

  return { skipped: false, version, counts, elapsedMs: Date.now() - startedAt };
}

/** 读取 SDE 元信息值 */
export async function readMeta(db: DbAdapter, key: string): Promise<string | null> {
  const rows = await db.select<{ value: string }>('SELECT value FROM sde_meta WHERE key = ?', [key]);
  return rows[0]?.value ?? null;
}

async function writeMeta(db: DbAdapter, key: string, value: string): Promise<void> {
  await db.execute('INSERT INTO sde_meta (key, value) VALUES (?, ?)', [key, value]);
}

/** 逐行读取 → 映射 → 分批写入的通用流程 */
async function importSimple<TRaw>(
  db: DbAdapter,
  source: SdeFileSource,
  file: SdeFileName,
  mapper: (raw: TRaw) => object | null,
  columns: readonly string[],
  table: string,
  options: ImportSdeOptions,
): Promise<number> {
  const writer = new RowWriter(db, table, columns);
  let rows = 0;

  for await (const line of source.lines(file)) {
    if (line.trim().length === 0) continue;
    const raw = safeParse<TRaw>(line);
    if (raw === null) continue;

    const mapped = mapper(raw);
    if (mapped !== null) {
      await writer.add(toRowValues(mapped, columns));
    }
    rows += 1;
    if (rows % PROGRESS_INTERVAL_ROWS === 0) {
      options.onProgress?.({ file, rows, written: writer.written });
    }
  }

  await writer.flush();
  options.onProgress?.({ file, rows, written: writer.written });
  return writer.written;
}

/** 空间站：需先备好星系/星域/军团/作业/站类型名，方可合成站名 */
async function importStations(
  db: DbAdapter,
  source: SdeFileSource,
  options: ImportSdeOptions,
): Promise<number> {
  const raws: RawNpcStation[] = [];
  for await (const line of source.lines('npcStations.jsonl')) {
    if (line.trim().length === 0) continue;
    const raw = safeParse<RawNpcStation>(line);
    if (raw !== null) raws.push(raw);
  }

  const typeIds = new Set<number>();
  for (const raw of raws) {
    if (typeof raw.typeID === 'number') typeIds.add(raw.typeID);
  }

  const context: StationContext = {
    systems: await loadSystems(db),
    regions: await loadRegions(db),
    corporations: await loadNameMap<RawNpcCorporation>(source, 'npcCorporations.jsonl', (raw) => raw.name),
    operations: await loadNameMap<RawStationOperation>(source, 'stationOperations.jsonl', (raw) => raw.operationName),
    stationTypes: await loadTypeNames(db, [...typeIds]),
  };

  const writer = new RowWriter(db, 'sde_stations', STATION_COLUMNS);
  let rows = 0;
  for (const raw of raws) {
    const mapped = mapStation(raw, context);
    if (mapped !== null) {
      await writer.add(toRowValues(mapped, STATION_COLUMNS));
    }
    rows += 1;
  }
  await writer.flush();
  options.onProgress?.({ file: 'npcStations.jsonl', rows, written: writer.written });
  return writer.written;
}

/** 蓝图：主表 / 活动 / 投入产出 三表联动 */
async function importBlueprints(
  db: DbAdapter,
  source: SdeFileSource,
  options: ImportSdeOptions,
): Promise<{ blueprints: number; activities: number; io: number }> {
  const blueprintWriter = new RowWriter(db, 'sde_blueprints', BLUEPRINT_COLUMNS);
  const activityWriter = new RowWriter(db, 'sde_blueprint_activities', ACTIVITY_COLUMNS);
  const ioWriter = new RowWriter(db, 'sde_blueprint_io', IO_COLUMNS);
  let rows = 0;

  for await (const line of source.lines('blueprints.jsonl')) {
    if (line.trim().length === 0) continue;
    const raw = safeParse<RawBlueprint>(line);
    if (raw === null) continue;

    const mapped = mapBlueprintRows(raw);
    if (mapped !== null) {
      await blueprintWriter.add(toRowValues(mapped.blueprint, BLUEPRINT_COLUMNS));
      for (const activity of mapped.activities) {
        await activityWriter.add(toRowValues(activity, ACTIVITY_COLUMNS));
      }
      for (const io of mapped.io) {
        await ioWriter.add(toRowValues(io, IO_COLUMNS));
      }
    }
    rows += 1;
    if (rows % PROGRESS_INTERVAL_ROWS === 0) {
      options.onProgress?.({ file: 'blueprints.jsonl', rows, written: blueprintWriter.written });
    }
  }

  await blueprintWriter.flush();
  await activityWriter.flush();
  await ioWriter.flush();
  options.onProgress?.({ file: 'blueprints.jsonl', rows, written: blueprintWriter.written });

  return {
    blueprints: blueprintWriter.written,
    activities: activityWriter.written,
    io: ioWriter.written,
  };
}

async function loadSystems(
  db: DbAdapter,
): Promise<StationContext['systems']> {
  const rows = await db.select<{ system_id: number; name_en: string; name_zh: string | null; region_id: number }>(
    'SELECT system_id, name_en, name_zh, region_id FROM sde_systems',
  );
  return new Map(rows.map((row) => [row.system_id, {
    nameEn: row.name_en,
    nameZh: row.name_zh,
    regionId: row.region_id,
  }]));
}

async function loadRegions(db: DbAdapter): Promise<StationContext['regions']> {
  const rows = await db.select<{ region_id: number; name_en: string; name_zh: string | null }>(
    'SELECT region_id, name_en, name_zh FROM sde_regions',
  );
  return new Map(rows.map((row) => [row.region_id, { nameEn: row.name_en, nameZh: row.name_zh }]));
}

/** 按 typeID 批量取物品名（用于空间站类型名） */
async function loadTypeNames(
  db: DbAdapter,
  ids: readonly number[],
): Promise<StationContext['stationTypes']> {
  const map: StationContext['stationTypes'] = new Map();
  const chunkSize = 500;
  for (let offset = 0; offset < ids.length; offset += chunkSize) {
    const chunk = ids.slice(offset, offset + chunkSize);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await db.select<{ type_id: number; name_en: string; name_zh: string | null }>(
      `SELECT type_id, name_en, name_zh FROM sde_types WHERE type_id IN (${placeholders})`,
      chunk,
    );
    for (const row of rows) {
      map.set(row.type_id, { nameEn: row.name_en, nameZh: row.name_zh });
    }
  }
  return map;
}

/** 从数据源读取「id → 多语言名」映射（军团 / 站作业） */
async function loadNameMap<TRaw extends { _key?: number }>(
  source: SdeFileSource,
  file: SdeFileName,
  pick: (raw: TRaw) => LocalizedLike,
): Promise<Map<number, { nameEn: string; nameZh: string | null }>> {
  const map = new Map<number, { nameEn: string; nameZh: string | null }>();
  for await (const line of source.lines(file)) {
    if (line.trim().length === 0) continue;
    const raw = safeParse<TRaw>(line);
    if (raw === null) continue;
    const id = raw._key;
    const text = pick(raw);
    const nameEn = pickEn(text);
    if (typeof id !== 'number' || nameEn === null) continue;
    map.set(id, { nameEn, nameZh: pickZh(text) });
  }
  return map;
}

type LocalizedLike = Parameters<typeof pickEn>[0];

/** 按列顺序取出对象字段值（约定：列名即行对象的键名） */
function toRowValues(row: object, columns: readonly string[]): unknown[] {
  const record = row as unknown as Record<string, unknown>;
  return columns.map((column) => record[column]);
}

function safeParse<T>(line: string): T | null {
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}

/** 进度回调间隔（行） */
const PROGRESS_INTERVAL_ROWS = 2000;

/** 行缓冲写入器：攒够一批再落库 */
class RowWriter {
  private buffer: unknown[][] = [];
  private count = 0;

  constructor(
    private readonly db: DbAdapter,
    private readonly table: string,
    private readonly columns: readonly string[],
  ) {}

  get written(): number {
    return this.count;
  }

  async add(row: unknown[]): Promise<void> {
    this.buffer.push(row);
    if (this.buffer.length >= 1000) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    this.count += await insertRows(this.db, this.table, this.columns, this.buffer);
    this.buffer = [];
  }
}
