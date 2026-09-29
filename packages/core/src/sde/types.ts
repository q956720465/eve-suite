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

/** `typeMaterials.jsonl` 的单条材料（官方字段名 materialTypeID） */
export interface RawTypeMaterialEntry {
  materialTypeID?: number;
  quantity?: number;
}

/** `typeMaterials.jsonl` 一行：某类型精炼/拆解可得哪些材料 */
export interface RawTypeMaterials {
  _key?: number;
  materials?: RawTypeMaterialEntry[];
}

/**
 * `marketGroups.jsonl` 一行：游戏内市场左侧的「市场分组」。
 * 实测（build 3552227 共 2,114 行）：`parentGroupID` 只出现在非根节点上（2,095 行），
 * 且位于行尾；19 个根节点无该字段。
 */
export interface RawMarketGroup {
  _key?: number;
  name?: LocalizedText;
  hasTypes?: boolean;
  iconID?: number;
  parentGroupID?: number;
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

/** 类型 → 精炼/拆解产出（P4-4 矿石精炼值引擎的数据基础） */
export interface SdeTypeMaterialRow {
  type_id: number;
  material_type_id: number;
  quantity: number;
}

/** 市场分组（游戏内市场左侧树；P9-1 市场浏览页的数据基础） */
export interface SdeMarketGroupRow {
  market_group_id: number;
  /** 根节点为 null */
  parent_group_id: number | null;
  name_en: string;
  name_zh: string | null;
  icon_id: number | null;
  /**
   * SDE 的 `hasTypes` 标志（0/1）。
   * **不可当作「叶子节点」判据**：build 3552227 实测 1,670 个分组为 1，但与
   * `sde_types.market_group_id` 实际引用的 1,621 个分组并非同一集合——存在同时带子分组
   * 与物品的分组，也存在无子分组却为 0 的分组。展示层应以「有无子分组 / 是否查到物品」为准。
   */
  has_types: number;
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
  | 'blueprints.jsonl'
  | 'typeMaterials.jsonl'
  | 'marketGroups.jsonl';

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
