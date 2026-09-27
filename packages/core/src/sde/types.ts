/**
 * SDE 领域类型。
 * 原始类型（Raw*）对应 CCP 官方 JSONL 的字段结构（2026-09 build 3542233 实测）；
 * 行类型（*Row）对应数据库列（snake_case）。
 */

/** SDE 多语言文本对象（官方含 de/en/es/fr/ja/ko/ru/zh 八种语言） */
export interface LocalizedText {
  en?: string;
  zh?: string;
  de?: string;
  es?: string;
  fr?: string;
  ja?: string;
  ko?: string;
  ru?: string;
}

// ---------- 原始行（JSONL 反序列化后） ----------

export interface RawSdeInfo {
  _key?: string;
  buildNumber?: number;
  releaseDate?: string;
}

export interface RawCategory {
  _key?: number;
  name?: LocalizedText;
  published?: boolean;
}

export interface RawGroup {
  _key?: number;
  categoryID?: number;
  name?: LocalizedText;
  published?: boolean;
}

export interface RawType {
  _key?: number;
  groupID?: number;
  name?: LocalizedText;
  description?: LocalizedText;
  volume?: number;
  packagedVolume?: number;
  mass?: number;
  capacity?: number;
  portionSize?: number;
  basePrice?: number;
  marketGroupID?: number;
  iconID?: number;
  published?: boolean;
}

export interface RawRegion {
  _key?: number;
  name?: LocalizedText;
}

export interface RawConstellation {
  _key?: number;
  regionID?: number;
  name?: LocalizedText;
}

export interface RawSolarSystem {
  _key?: number;
  constellationID?: number;
  regionID?: number;
  name?: LocalizedText;
  securityStatus?: number;
  securityClass?: string;
}

export interface RawNpcStation {
  _key?: number;
  typeID?: number;
  solarSystemID?: number;
  ownerID?: number;
  operationID?: number;
  celestialIndex?: number;
  orbitIndex?: number;
  orbitID?: number;
  useOperationName?: boolean;
}

export interface RawNpcCorporation {
  _key?: number;
  name?: LocalizedText;
}

export interface RawStationOperation {
  _key?: number;
  operationName?: LocalizedText;
}

export interface RawBlueprintMaterial {
  quantity?: number;
  typeID?: number;
}

export interface RawBlueprintActivity {
  materials?: RawBlueprintMaterial[];
  products?: RawBlueprintMaterial[];
  time?: number;
}

export interface RawBlueprint {
  _key?: number;
  maxProductionLimit?: number;
  activities?: Record<string, RawBlueprintActivity | undefined>;
}

// ---------- 数据库行 ----------

export interface SdeCategoryRow {
  category_id: number;
  name_en: string;
  name_zh: string | null;
  published: number;
}

export interface SdeGroupRow {
  group_id: number;
  category_id: number;
  name_en: string;
  name_zh: string | null;
  published: number;
}

export interface SdeTypeRow {
  type_id: number;
  group_id: number;
  name_en: string;
  name_zh: string | null;
  description_en: string | null;
  description_zh: string | null;
  volume: number | null;
  packaged_volume: number | null;
  mass: number | null;
  capacity: number | null;
  portion_size: number | null;
  base_price: number | null;
  market_group_id: number | null;
  icon_id: number | null;
  published: number;
}

export interface SdeRegionRow {
  region_id: number;
  name_en: string;
  name_zh: string | null;
}

export interface SdeConstellationRow {
  constellation_id: number;
  region_id: number;
  name_en: string;
  name_zh: string | null;
}

export interface SdeSystemRow {
  system_id: number;
  constellation_id: number;
  region_id: number;
  name_en: string;
  name_zh: string | null;
  security_status: number | null;
  security_class: string | null;
}

export interface SdeStationRow {
  station_id: number;
  type_id: number;
  solar_system_id: number;
  region_id: number;
  owner_id: number;
  operation_id: number | null;
  celestial_index: number | null;
  orbit_index: number | null;
  orbit_id: number | null;
  use_operation_name: number;
  name_en: string;
  name_zh: string | null;
  system_name_en: string;
  system_name_zh: string | null;
  region_name_en: string;
  region_name_zh: string | null;
}

export interface SdeBlueprintRow {
  blueprint_type_id: number;
  max_production_limit: number | null;
}

export interface SdeBlueprintActivityRow {
  blueprint_type_id: number;
  activity: string;
  time_seconds: number | null;
}

export interface SdeBlueprintIoRow {
  blueprint_type_id: number;
  activity: string;
  direction: 'input' | 'output';
  type_id: number;
  quantity: number;
}

/** SDE 版本信息（来自 _sde.jsonl） */
export interface SdeVersion {
  buildNumber: number;
  releaseDate: string;
}

/** SDE 数据源抽象：宿主注入（Tauri 侧读本地缓存文件；测试侧读内存样本） */
export interface SdeFileSource {
  /** 读取并解析 _sde.jsonl，得到版本信息 */
  version(): Promise<SdeVersion>;
  /** 按顺序产出指定 JSONL 文件的原始文本行 */
  lines(fileName: SdeFileName): AsyncIterable<string>;
}

export type SdeFileName =
  | '_sde.jsonl'
  | 'categories.jsonl'
  | 'groups.jsonl'
  | 'types.jsonl'
  | 'mapRegions.jsonl'
  | 'mapConstellations.jsonl'
  | 'mapSolarSystems.jsonl'
  | 'npcStations.jsonl'
  | 'npcCorporations.jsonl'
  | 'stationOperations.jsonl'
  | 'blueprints.jsonl';

/** 导入进度回调载荷 */
export interface SdeImportProgress {
  /** 当前处理的文件 */
  file: SdeFileName;
  /** 该文件已处理行数 */
  rows: number;
  /** 已写入数据库的行数（累计） */
  written: number;
}

/** 导入结果摘要 */
export interface SdeImportSummary {
  /** 是否跳过（本地已是同版本） */
  skipped: boolean;
  version: SdeVersion;
  /** 各表写入行数 */
  counts: Record<string, number>;
  /** 耗时（毫秒） */
  elapsedMs: number;
}
