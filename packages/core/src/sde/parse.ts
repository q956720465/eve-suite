import { buildStationName, pickEn, pickZh } from './normalize';
import type {
  RawBlueprint,
  RawCategory,
  RawConstellation,
  RawGroup,
  RawMarketGroup,
  RawNpcStation,
  RawRegion,
  RawSolarSystem,
  RawType,
  RawTypeMaterials,
  SdeBlueprintActivityRow,
  SdeBlueprintIoRow,
  SdeBlueprintRow,
  SdeCategoryRow,
  SdeConstellationRow,
  SdeGroupRow,
  SdeMarketGroupRow,
  SdeRegionRow,
  SdeStationRow,
  SdeSystemRow,
  SdeTypeMaterialRow,
  SdeTypeRow,
} from './types';

/** 可选数值字段：非有限数字一律落库为 null */
function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 可选整数字段 */
function intOrNull(value: unknown): number | null {
  const num = numOrNull(value);
  return num === null ? null : Math.trunc(num);
}

export function mapCategory(raw: RawCategory): SdeCategoryRow | null {
  const id = intOrNull(raw._key);
  const nameEn = pickEn(raw.name);
  if (id === null || nameEn === null) return null;
  return { category_id: id, name_en: nameEn, name_zh: pickZh(raw.name), published: raw.published === true ? 1 : 0 };
}

export function mapGroup(raw: RawGroup): SdeGroupRow | null {
  const id = intOrNull(raw._key);
  const nameEn = pickEn(raw.name);
  if (id === null || nameEn === null) return null;
  return {
    group_id: id,
    category_id: intOrNull(raw.categoryID) ?? 0,
    name_en: nameEn,
    name_zh: pickZh(raw.name),
    published: raw.published === true ? 1 : 0,
  };
}

export function mapType(raw: RawType): SdeTypeRow | null {
  const id = intOrNull(raw._key);
  const nameEn = pickEn(raw.name);
  if (id === null || nameEn === null) return null;
  return {
    type_id: id,
    group_id: intOrNull(raw.groupID) ?? 0,
    name_en: nameEn,
    name_zh: pickZh(raw.name),
    description_en: pickEn(raw.description),
    description_zh: pickZh(raw.description),
    volume: numOrNull(raw.volume),
    packaged_volume: numOrNull(raw.packagedVolume),
    mass: numOrNull(raw.mass),
    capacity: numOrNull(raw.capacity),
    portion_size: intOrNull(raw.portionSize),
    base_price: numOrNull(raw.basePrice),
    market_group_id: intOrNull(raw.marketGroupID),
    icon_id: intOrNull(raw.iconID),
    published: raw.published === true ? 1 : 0,
  };
}

export function mapRegion(raw: RawRegion): SdeRegionRow | null {
  const id = intOrNull(raw._key);
  const nameEn = pickEn(raw.name);
  if (id === null || nameEn === null) return null;
  return { region_id: id, name_en: nameEn, name_zh: pickZh(raw.name) };
}

export function mapConstellation(raw: RawConstellation): SdeConstellationRow | null {
  const id = intOrNull(raw._key);
  const regionId = intOrNull(raw.regionID);
  const nameEn = pickEn(raw.name);
  if (id === null || regionId === null || nameEn === null) return null;
  return {
    constellation_id: id,
    region_id: regionId,
    name_en: nameEn,
    name_zh: pickZh(raw.name),
  };
}

export function mapSystem(raw: RawSolarSystem): SdeSystemRow | null {
  const id = intOrNull(raw._key);
  const constellationId = intOrNull(raw.constellationID);
  const regionId = intOrNull(raw.regionID);
  const nameEn = pickEn(raw.name);
  if (id === null || constellationId === null || regionId === null || nameEn === null) return null;
  return {
    system_id: id,
    constellation_id: constellationId,
    region_id: regionId,
    name_en: nameEn,
    name_zh: pickZh(raw.name),
    security_status: numOrNull(raw.securityStatus),
    security_class: typeof raw.securityClass === 'string' ? raw.securityClass : null,
  };
}

/** 站名合成所需的外部数据（由导入流程在导入 stations 前备好） */
export interface StationContext {
  systems: Map<number, { nameEn: string; nameZh: string | null; regionId: number }>;
  regions: Map<number, { nameEn: string; nameZh: string | null }>;
  corporations: Map<number, { nameEn: string; nameZh: string | null }>;
  operations: Map<number, { nameEn: string; nameZh: string | null }>;
  stationTypes: Map<number, { nameEn: string; nameZh: string | null }>;
}

export function mapStation(raw: RawNpcStation, ctx: StationContext): SdeStationRow | null {
  const id = intOrNull(raw._key);
  const systemId = intOrNull(raw.solarSystemID);
  const typeId = intOrNull(raw.typeID);
  const ownerId = intOrNull(raw.ownerID);
  if (id === null || systemId === null || typeId === null || ownerId === null) return null;

  const system = ctx.systems.get(systemId);
  if (!system) return null; // 星系未知则无法合成站名，丢弃该行
  const region = ctx.regions.get(system.regionId);
  if (!region) return null;

  const corp = ctx.corporations.get(ownerId);
  const corpEn = corp?.nameEn ?? `Corporation ${ownerId}`;
  const corpZh = corp?.nameZh ?? null;

  const operationId = intOrNull(raw.operationID);
  const useOperationName = raw.useOperationName === true;
  const operation = operationId === null ? undefined : ctx.operations.get(operationId);
  const stationType = ctx.stationTypes.get(typeId);

  // useOperationName 且作业名可得时用作业名，否则退回空间站类型名
  const useOperation = useOperationName && operation !== undefined;
  const labelEn = useOperation ? operation.nameEn : (stationType?.nameEn ?? `Station ${typeId}`);
  const labelZh = useOperation ? operation.nameZh : (stationType?.nameZh ?? null);

  const names = buildStationName({
    systemEn: system.nameEn,
    systemZh: system.nameZh,
    corpEn,
    corpZh,
    labelEn,
    labelZh,
    celestialIndex: intOrNull(raw.celestialIndex),
    orbitIndex: intOrNull(raw.orbitIndex),
  });

  return {
    station_id: id,
    type_id: typeId,
    solar_system_id: systemId,
    region_id: system.regionId,
    owner_id: ownerId,
    operation_id: operationId,
    celestial_index: intOrNull(raw.celestialIndex),
    orbit_index: intOrNull(raw.orbitIndex),
    orbit_id: intOrNull(raw.orbitID),
    use_operation_name: useOperationName ? 1 : 0,
    name_en: names.en,
    name_zh: names.zh,
    system_name_en: system.nameEn,
    system_name_zh: system.nameZh,
    region_name_en: region.nameEn,
    region_name_zh: region.nameZh,
  };
}

export interface BlueprintRows {
  blueprint: SdeBlueprintRow;
  activities: SdeBlueprintActivityRow[];
  io: SdeBlueprintIoRow[];
}

/** 蓝图行展开：活动时间 → activities 表；materials/products → io 表（input/output） */
export function mapBlueprintRows(raw: RawBlueprint): BlueprintRows | null {
  const id = intOrNull(raw._key);
  if (id === null) return null;

  const blueprint: SdeBlueprintRow = {
    blueprint_type_id: id,
    max_production_limit: intOrNull(raw.maxProductionLimit),
  };
  const activities: SdeBlueprintActivityRow[] = [];
  const io: SdeBlueprintIoRow[] = [];

  for (const [activity, payload] of Object.entries(raw.activities ?? {})) {
    if (!payload) continue;
    const time = intOrNull(payload.time);
    if (time !== null) {
      activities.push({ blueprint_type_id: id, activity, time_seconds: time });
    }
    for (const material of payload.materials ?? []) {
      const typeId = intOrNull(material.typeID);
      const quantity = intOrNull(material.quantity);
      if (typeId === null || quantity === null) continue;
      io.push({ blueprint_type_id: id, activity, direction: 'input', type_id: typeId, quantity });
    }
    for (const product of payload.products ?? []) {
      const typeId = intOrNull(product.typeID);
      const quantity = intOrNull(product.quantity);
      if (typeId === null || quantity === null) continue;
      io.push({ blueprint_type_id: id, activity, direction: 'output', type_id: typeId, quantity });
    }
  }

  return { blueprint, activities, io };
}

/**
 * `typeMaterials.jsonl` 一行 → 多行材料（P4-4）。
 * 无效材料行（缺 typeID / 缺数量 / 数量非正）逐条跳过；整行无有效材料时返回空数组。
 */
export function mapTypeMaterialRows(raw: RawTypeMaterials): SdeTypeMaterialRow[] {
  const typeId = intOrNull(raw._key);
  if (typeId === null) return [];

  const rows: SdeTypeMaterialRow[] = [];
  for (const material of raw.materials ?? []) {
    const materialTypeId = intOrNull(material.materialTypeID);
    const quantity = intOrNull(material.quantity);
    if (materialTypeId === null || quantity === null || quantity <= 0) continue;
    rows.push({ type_id: typeId, material_type_id: materialTypeId, quantity });
  }
  return rows;
}

/**
 * 市场分组（P9-1 市场浏览页）。
 * 根节点无 `parentGroupID` → `parent_group_id` 落 null；缺 `name` 的行丢弃。
 */
export function mapMarketGroup(raw: RawMarketGroup): SdeMarketGroupRow | null {
  const id = intOrNull(raw._key);
  const nameEn = pickEn(raw.name);
  if (id === null || nameEn === null) return null;
  return {
    market_group_id: id,
    parent_group_id: intOrNull(raw.parentGroupID),
    name_en: nameEn,
    name_zh: pickZh(raw.name),
    icon_id: intOrNull(raw.iconID),
    has_types: raw.hasTypes === true ? 1 : 0,
  };
}
