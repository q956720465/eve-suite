import type { DbAdapter } from '../db/types';

/** SDE 数据就绪状态（供界面状态卡展示） */
export interface SdeStatus {
  /** 已入库的 SDE 构建号（未导入为 null） */
  buildNumber: number | null;
  releaseDate: string | null;
  importedAt: string | null;
  /** 各表行数（来自导入时记录） */
  counts: Record<string, number>;
  /** 物品表实际行数（实时统计，用于校验） */
  typeCount: number;
  /** 是否已有可用数据 */
  ready: boolean;
}

/** 物品搜索命中行 */
export interface TypeSearchHit {
  typeId: number;
  nameEn: string;
  nameZh: string | null;
  groupNameEn: string | null;
  groupNameZh: string | null;
  categoryNameEn: string | null;
  categoryNameZh: string | null;
  volume: number | null;
  published: number;
}

/** 物品详情 */
export interface TypeDetail extends TypeSearchHit {
  descriptionEn: string | null;
  descriptionZh: string | null;
  mass: number | null;
  packagedVolume: number | null;
  portionSize: number | null;
  basePrice: number | null;
  marketGroupId: number | null;
}

/** 空间站搜索命中行 */
export interface StationSearchHit {
  stationId: number;
  nameEn: string;
  nameZh: string | null;
  systemNameEn: string;
  systemNameZh: string | null;
  regionNameEn: string;
  regionNameZh: string | null;
  typeId: number;
}

/** 默认返回条数上限 */
export const DEFAULT_SEARCH_LIMIT = 50;

export async function getSdeStatus(db: DbAdapter): Promise<SdeStatus> {
  const metaRows = await db.select<{ key: string; value: string }>(
    'SELECT key, value FROM sde_meta',
  );
  const meta = new Map(metaRows.map((row) => [row.key, row.value]));

  const countRows = await db.select<{ n: number }>('SELECT COUNT(*) AS n FROM sde_types');
  const typeCount = countRows[0]?.n ?? 0;

  const counts: Record<string, number> = {};
  for (const [key, value] of meta) {
    if (key.startsWith('rows_')) {
      counts[key.slice('rows_'.length)] = Number(value);
    }
  }

  const buildNumber = meta.get('build_number');
  return {
    buildNumber: buildNumber === undefined ? null : Number(buildNumber),
    releaseDate: meta.get('release_date') ?? null,
    importedAt: meta.get('imported_at') ?? null,
    counts,
    typeCount,
    ready: buildNumber !== undefined && typeCount > 0,
  };
}

/** 物品搜索：中英文名模糊匹配（名称字段有索引；LIKE 含前导通配符时走全表扫描，53k 行量级可接受） */
export async function searchTypes(
  db: DbAdapter,
  query: string,
  limit: number = DEFAULT_SEARCH_LIMIT,
): Promise<TypeSearchHit[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const pattern = toLikePattern(trimmed);
  return db.select<TypeSearchHit>(
    `SELECT t.type_id       AS typeId,
            t.name_en       AS nameEn,
            t.name_zh       AS nameZh,
            g.name_en       AS groupNameEn,
            g.name_zh       AS groupNameZh,
            c.name_en       AS categoryNameEn,
            c.name_zh       AS categoryNameZh,
            t.volume        AS volume,
            t.published     AS published
       FROM sde_types t
       LEFT JOIN sde_groups g ON g.group_id = t.group_id
       LEFT JOIN sde_categories c ON c.category_id = g.category_id
      WHERE t.name_en LIKE ? ESCAPE '\\' OR t.name_zh LIKE ? ESCAPE '\\'
      ORDER BY (t.name_en = ?) DESC,
               (t.name_zh = ?) DESC,
               t.published DESC,
               length(t.name_en),
               t.name_en
      LIMIT ?`,
    [pattern, pattern, trimmed, trimmed, limit],
  );
}

export async function getTypeDetail(db: DbAdapter, typeId: number): Promise<TypeDetail | null> {
  const rows = await db.select<TypeDetail>(
    `SELECT t.type_id         AS typeId,
            t.name_en         AS nameEn,
            t.name_zh         AS nameZh,
            t.description_en  AS descriptionEn,
            t.description_zh  AS descriptionZh,
            t.volume          AS volume,
            t.packaged_volume AS packagedVolume,
            t.mass            AS mass,
            t.portion_size    AS portionSize,
            t.base_price      AS basePrice,
            t.market_group_id AS marketGroupId,
            t.published       AS published,
            g.name_en         AS groupNameEn,
            g.name_zh         AS groupNameZh,
            c.name_en         AS categoryNameEn,
            c.name_zh         AS categoryNameZh
       FROM sde_types t
       LEFT JOIN sde_groups g ON g.group_id = t.group_id
       LEFT JOIN sde_categories c ON c.category_id = g.category_id
      WHERE t.type_id = ?`,
    [typeId],
  );
  return rows[0] ?? null;
}

/** 物品名（批量查询结果） */
export interface TypeNameEntry {
  nameEn: string;
  nameZh: string | null;
}

/** 单次批量查询的 id 数（与 SQLite 变量上限保持安全距离） */
const TYPE_NAME_CHUNK = 500;

/**
 * 批量取物品名（资产 / 挂单等列表展示用）。
 * 未收录于 SDE 的 id 不会出现在结果中，调用方自行兜底显示 `type_id`。
 */
export async function getTypeNames(
  db: DbAdapter,
  typeIds: readonly number[],
): Promise<Map<number, TypeNameEntry>> {
  const result = new Map<number, TypeNameEntry>();
  const unique = [...new Set(typeIds)];
  for (let offset = 0; offset < unique.length; offset += TYPE_NAME_CHUNK) {
    const chunk = unique.slice(offset, offset + TYPE_NAME_CHUNK);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await db.select<{ typeId: number; nameEn: string; nameZh: string | null }>(
      `SELECT type_id AS typeId, name_en AS nameEn, name_zh AS nameZh
         FROM sde_types
        WHERE type_id IN (${placeholders})`,
      chunk,
    );
    for (const row of rows) {
      result.set(row.typeId, { nameEn: row.nameEn, nameZh: row.nameZh });
    }
  }
  return result;
}

/** 空间站名（批量查询结果，含所在星系与所在区域） */
export interface StationNameEntry {
  nameEn: string;
  nameZh: string | null;
  systemNameEn: string;
  systemNameZh: string | null;
  /** 所在区域 ID：供「站点必须属于所选区域」这类联动过滤（如净值基准站点） */
  regionId: number;
}

/**
 * 批量取空间站名（资产 / 挂单的地点展示用）。
 * 未收录的 id 不会出现在结果中（资产地点也可能是集装箱等物品，调用方兜底显示 id）。
 */
export async function getStationNames(
  db: DbAdapter,
  stationIds: readonly number[],
): Promise<Map<number, StationNameEntry>> {
  const result = new Map<number, StationNameEntry>();
  const unique = [...new Set(stationIds)];
  for (let offset = 0; offset < unique.length; offset += TYPE_NAME_CHUNK) {
    const chunk = unique.slice(offset, offset + TYPE_NAME_CHUNK);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await db.select<{
      stationId: number;
      nameEn: string;
      nameZh: string | null;
      systemNameEn: string;
      systemNameZh: string | null;
      regionId: number;
    }>(
      `SELECT station_id AS stationId, name_en AS nameEn, name_zh AS nameZh,
              system_name_en AS systemNameEn, system_name_zh AS systemNameZh,
              region_id AS regionId
         FROM sde_stations
        WHERE station_id IN (${placeholders})`,
      chunk,
    );
    for (const row of rows) {
      result.set(row.stationId, {
        nameEn: row.nameEn,
        nameZh: row.nameZh,
        systemNameEn: row.systemNameEn,
        systemNameZh: row.systemNameZh,
        regionId: row.regionId,
      });
    }
  }
  return result;
}

/** 星系名（批量查询结果，含安全等级与所属区域） */
export interface SystemNameEntry {
  nameEn: string;
  nameZh: string | null;
  regionId: number;
  securityStatus: number | null;
}

/**
 * 批量取星系名（采矿账簿的「按星系」视角等展示用）。
 * 未收录的 id 不会出现在结果中（调用方兜底显示 id）。
 */
export async function getSystemNames(
  db: DbAdapter,
  systemIds: readonly number[],
): Promise<Map<number, SystemNameEntry>> {
  const result = new Map<number, SystemNameEntry>();
  const unique = [...new Set(systemIds)];
  for (let offset = 0; offset < unique.length; offset += TYPE_NAME_CHUNK) {
    const chunk = unique.slice(offset, offset + TYPE_NAME_CHUNK);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await db.select<{
      systemId: number;
      nameEn: string;
      nameZh: string | null;
      regionId: number;
      securityStatus: number | null;
    }>(
      `SELECT system_id AS systemId, name_en AS nameEn, name_zh AS nameZh,
              region_id AS regionId, security_status AS securityStatus
         FROM sde_systems
        WHERE system_id IN (${placeholders})`,
      chunk,
    );
    for (const row of rows) {
      result.set(row.systemId, {
        nameEn: row.nameEn,
        nameZh: row.nameZh,
        regionId: row.regionId,
        securityStatus: row.securityStatus,
      });
    }
  }
  return result;
}

/** 空间站搜索：站名 / 星系名 / 星域名 三处匹配（如搜 Jita 可命中 The Forge 的站） */
export async function searchStations(
  db: DbAdapter,
  query: string,
  limit: number = DEFAULT_SEARCH_LIMIT,
): Promise<StationSearchHit[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const pattern = toLikePattern(trimmed);
  return db.select<StationSearchHit>(
    `SELECT station_id      AS stationId,
            name_en         AS nameEn,
            name_zh         AS nameZh,
            system_name_en  AS systemNameEn,
            system_name_zh  AS systemNameZh,
            region_name_en  AS regionNameEn,
            region_name_zh  AS regionNameZh,
            type_id         AS typeId
       FROM sde_stations
      WHERE name_en LIKE ? ESCAPE '\\'
         OR name_zh LIKE ? ESCAPE '\\'
         OR system_name_en LIKE ? ESCAPE '\\'
         OR system_name_zh LIKE ? ESCAPE '\\'
         OR region_name_en LIKE ? ESCAPE '\\'
      ORDER BY (system_name_en = ?) DESC,
               (name_en = ?) DESC,
               length(name_en),
               name_en
      LIMIT ?`,
    [pattern, pattern, pattern, pattern, pattern, trimmed, trimmed, limit],
  );
}

/** 转义 LIKE 通配符并包裹 %（用户输入中的 % _ \ 按字面处理） */
function toLikePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}
