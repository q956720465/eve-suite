import type { SdeFileName, SdeFileSource, SdeVersion } from '../../src/sde/types';

/**
 * SDE 测试样本：字段与取值取自 CCP 官方 SDE 实测数据（2026-09-24 build 3542233），
 * 裁剪为少量行，覆盖中英文名、蓝图 BOM、空间站站名合成等关键场景。
 */
export const SAMPLE_VERSION: SdeVersion = {
  buildNumber: 3542233,
  releaseDate: '2026-09-24T11:12:47Z',
};

export const SAMPLE_FILES: Partial<Record<SdeFileName, string[]>> = {
  '_sde.jsonl': [
    JSON.stringify({ _key: 'sde', buildNumber: 3542233, releaseDate: '2026-09-24T11:12:47Z' }),
  ],

  'categories.jsonl': [
    JSON.stringify({ _key: 4, name: { en: 'Material', zh: '材料' }, published: true }),
  ],

  'groups.jsonl': [
    JSON.stringify({ _key: 18, categoryID: 4, name: { en: 'Mineral', zh: '矿物' }, published: true }),
  ],

  'types.jsonl': [
    // 真实 Tritanium 记录（裁剪 description 长度）
    JSON.stringify({
      _key: 34,
      basePrice: 2.0,
      description: {
        en: 'The main building block in space structures.',
        zh: '太空结构的主要建筑材料。',
      },
      groupID: 18,
      iconID: 22,
      marketGroupID: 1857,
      name: { en: 'Tritanium', zh: '三钛合金' },
      packagedVolume: 0.01,
      portionSize: 1,
      published: true,
      volume: 0.01,
    }),
    JSON.stringify({
      _key: 35,
      basePrice: 8.0,
      description: { en: 'A soft crystal-like mineral.', zh: '一种柔软的类晶体矿物。' },
      groupID: 18,
      iconID: 23,
      name: { en: 'Pyerite', zh: '类晶体胶矿' },
      portionSize: 1,
      published: true,
      volume: 0.01,
    }),
    // 空间站类型（用于 useOperationName=false 时的回退名）
    JSON.stringify({
      _key: 1531,
      groupID: 15,
      name: { en: 'Caldari Control Tower', zh: '加达里控制塔' },
      published: true,
    }),
    // 未发布物品（验证 published 标志落库）
    JSON.stringify({
      _key: 99999999,
      groupID: 18,
      name: { en: 'Hidden Test Item', zh: '隐藏测试物品' },
      published: false,
    }),
  ],

  'mapRegions.jsonl': [
    JSON.stringify({ _key: 10000002, name: { en: 'The Forge', zh: '伏尔戈' } }),
  ],

  'mapConstellations.jsonl': [
    JSON.stringify({ _key: 20000020, regionID: 10000002, name: { en: 'Kimotoro', zh: '木本' } }),
  ],

  'mapSolarSystems.jsonl': [
    JSON.stringify({
      _key: 30000142,
      constellationID: 20000020,
      regionID: 10000002,
      name: { en: 'Jita', zh: '吉他' },
      securityStatus: 0.9459131340980792,
      securityClass: 'B',
    }),
  ],

  'npcCorporations.jsonl': [
    JSON.stringify({ _key: 1000035, name: { en: 'Caldari Navy', zh: '加达里海军' } }),
  ],

  'stationOperations.jsonl': [
    JSON.stringify({ _key: 26, operationName: { en: 'Assembly Plant', zh: '组装车间' } }),
  ],

  'npcStations.jsonl': [
    // Jita IV - Moon 4 - Caldari Navy Assembly Plant（useOperationName = true）
    JSON.stringify({
      _key: 60003760,
      celestialIndex: 4,
      operationID: 26,
      orbitID: 40176406,
      orbitIndex: 4,
      ownerID: 1000035,
      solarSystemID: 30000142,
      typeID: 1531,
      useOperationName: true,
    }),
    // useOperationName = false → 回退空间站类型名
    JSON.stringify({
      _key: 60003761,
      celestialIndex: 2,
      orbitIndex: 0,
      ownerID: 1000035,
      solarSystemID: 30000142,
      typeID: 1531,
      useOperationName: false,
    }),
    // 星系未知 → 应被丢弃
    JSON.stringify({
      _key: 60003762,
      ownerID: 1000035,
      solarSystemID: 39999999,
      typeID: 1531,
      useOperationName: true,
    }),
  ],

  'blueprints.jsonl': [
    JSON.stringify({
      _key: 681,
      activities: {
        copying: { time: 480 },
        manufacturing: {
          materials: [{ quantity: 86, typeID: 38 }],
          products: [{ quantity: 1, typeID: 165 }],
          time: 600,
        },
        research_material: { time: 210 },
        research_time: { time: 210 },
      },
      blueprintTypeID: 681,
      maxProductionLimit: 300,
    }),
  ],

  // 真实取值：Veldspar 1230 → 400 三钛/100 单位；Scordite 1228 → 150 三钛 + 110 类晶体胶矿
  'typeMaterials.jsonl': [
    JSON.stringify({ _key: 1230, materials: [{ materialTypeID: 34, quantity: 400 }] }),
    JSON.stringify({
      _key: 1228,
      materials: [
        { materialTypeID: 34, quantity: 150 },
        { materialTypeID: 35, quantity: 110 },
      ],
    }),
    // 空材料 → 不产生行
    JSON.stringify({ _key: 99999, materials: [] }),
    // 非法材料行（缺字段 / 数量非正）→ 逐条跳过
    JSON.stringify({
      _key: 1231,
      materials: [{ materialTypeID: 34 }, { quantity: 5 }, { materialTypeID: 36, quantity: 0 }],
    }),
  ],
};

/** 内存数据源：测试用（不触网、不落盘） */
export function createMemorySource(
  files: Partial<Record<SdeFileName, string[]>> = SAMPLE_FILES,
  version: SdeVersion = SAMPLE_VERSION,
): SdeFileSource {
  return {
    version: async () => version,
    lines: async function* lines(fileName: SdeFileName) {
      for (const line of files[fileName] ?? []) {
        yield line;
      }
    },
  };
}

/** 生成指定行数的 types.jsonl，用于验证分批写入 */
export function generateTypeLines(count: number, startId = 1000000): string[] {
  const lines: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = startId + index;
    lines.push(
      JSON.stringify({
        _key: id,
        groupID: 18,
        name: { en: `Bulk Item ${id}`, zh: `批量物品 ${id}` },
        published: true,
        volume: 1,
      }),
    );
  }
  return lines;
}
