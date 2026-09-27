import { describe, expect, it } from 'vitest';

import { buildStationName, pickEn, pickZh, toRoman } from '../../src/sde/normalize';
import {
  mapBlueprintRows,
  mapCategory,
  mapStation,
  mapType,
  type StationContext,
} from '../../src/sde/parse';
import type { RawType } from '../../src/sde/types';

describe('名称与罗马数字', () => {
  it('pickEn / pickZh：取对应语言，缺失或空串返回 null', () => {
    expect(pickEn({ en: 'Tritanium', zh: '三钛合金' })).toBe('Tritanium');
    expect(pickZh({ en: 'Tritanium', zh: '三钛合金' })).toBe('三钛合金');
    expect(pickZh({ en: 'Tritanium' })).toBeNull();
    expect(pickZh({ en: 'X', zh: '' })).toBeNull();
    expect(pickEn(undefined)).toBeNull();
  });

  it('toRoman：站名行星序号转换', () => {
    expect(toRoman(1)).toBe('I');
    expect(toRoman(4)).toBe('IV');
    expect(toRoman(9)).toBe('IX');
    expect(toRoman(14)).toBe('XIV');
    expect(toRoman(0)).toBe('0');
  });
});

describe('站名合成', () => {
  it('含行星序号与卫星序号：还原 Jita IV - Moon 4 命名规则', () => {
    const names = buildStationName({
      systemEn: 'Jita',
      systemZh: '吉他',
      corpEn: 'Caldari Navy',
      corpZh: '加达里海军',
      labelEn: 'Assembly Plant',
      labelZh: '组装车间',
      celestialIndex: 4,
      orbitIndex: 4,
    });
    expect(names.en).toBe('Jita IV - Moon 4 - Caldari Navy Assembly Plant');
    expect(names.zh).toBe('吉他 IV - 卫星 4 - 加达里海军 组装车间');
  });

  it('无卫星序号时省略 Moon 段；无中文星系名时中文为 null', () => {
    const names = buildStationName({
      systemEn: 'Amarr',
      systemZh: null,
      corpEn: 'Emperor Family',
      corpZh: null,
      labelEn: 'Academy',
      labelZh: null,
      celestialIndex: 8,
      orbitIndex: 0,
    });
    expect(names.en).toBe('Amarr VIII - Emperor Family Academy');
    expect(names.zh).toBeNull();
  });
});

describe('物品映射', () => {
  it('mapType：Tritanium 关键字段正确落库', () => {
    const raw: RawType = {
      _key: 34,
      basePrice: 2.0,
      description: { en: 'The main building block.', zh: '主要建筑材料。' },
      groupID: 18,
      iconID: 22,
      marketGroupID: 1857,
      name: { en: 'Tritanium', zh: '三钛合金' },
      packagedVolume: 0.01,
      portionSize: 1,
      published: true,
      volume: 0.01,
    };
    const row = mapType(raw);
    expect(row).not.toBeNull();
    expect(row).toMatchObject({
      type_id: 34,
      group_id: 18,
      name_en: 'Tritanium',
      name_zh: '三钛合金',
      volume: 0.01,
      packaged_volume: 0.01,
      portion_size: 1,
      base_price: 2.0,
      market_group_id: 1857,
      icon_id: 22,
      published: 1,
    });
  });

  it('mapType：缺少 _key 或英文名时返回 null', () => {
    expect(mapType({ name: { en: 'X' } })).toBeNull();
    expect(mapType({ _key: 1, name: { zh: '只有中文' } })).toBeNull();
  });

  it('mapCategory：未发布类别 published 记 0', () => {
    expect(mapCategory({ _key: 0, name: { en: '#System', zh: '#星系' }, published: false })).toEqual({
      category_id: 0,
      name_en: '#System',
      name_zh: '#星系',
      published: 0,
    });
  });
});

describe('空间站映射', () => {
  const context: StationContext = {
    systems: new Map([[30000142, { nameEn: 'Jita', nameZh: '吉他', regionId: 10000002 }]]),
    regions: new Map([[10000002, { nameEn: 'The Forge', nameZh: '域' }]]),
    corporations: new Map([[1000035, { nameEn: 'Caldari Navy', nameZh: '加达里海军' }]]),
    operations: new Map([[26, { nameEn: 'Assembly Plant', nameZh: '组装车间' }]]),
    stationTypes: new Map([[1531, { nameEn: 'Caldari Control Tower', nameZh: '加达里控制塔' }]]),
  };

  it('useOperationName：站名含作业名，并冗余星系与星域名', () => {
    const row = mapStation(
      {
        _key: 60003760,
        celestialIndex: 4,
        operationID: 26,
        orbitID: 40176406,
        orbitIndex: 4,
        ownerID: 1000035,
        solarSystemID: 30000142,
        typeID: 1531,
        useOperationName: true,
      },
      context,
    );
    expect(row).not.toBeNull();
    expect(row).toMatchObject({
      station_id: 60003760,
      solar_system_id: 30000142,
      region_id: 10000002,
      owner_id: 1000035,
      operation_id: 26,
      use_operation_name: 1,
      name_en: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant',
      system_name_en: 'Jita',
      system_name_zh: '吉他',
      region_name_en: 'The Forge',
    });
  });

  it('useOperationName=false：回退到空间站类型名', () => {
    const row = mapStation(
      {
        _key: 60003761,
        celestialIndex: 2,
        ownerID: 1000035,
        solarSystemID: 30000142,
        typeID: 1531,
        useOperationName: false,
      },
      context,
    );
    expect(row?.name_en).toBe('Jita II - Caldari Navy Caldari Control Tower');
    expect(row?.use_operation_name).toBe(0);
  });

  it('星系未知：丢弃该行（无法合成站名）', () => {
    expect(
      mapStation({ _key: 1, ownerID: 1000035, solarSystemID: 39999999, typeID: 1531 }, context),
    ).toBeNull();
  });
});

describe('蓝图映射', () => {
  it('展开活动时间、材料（input）与产品（output）', () => {
    const rows = mapBlueprintRows({
      _key: 681,
      maxProductionLimit: 300,
      activities: {
        copying: { time: 480 },
        manufacturing: {
          materials: [{ quantity: 86, typeID: 38 }],
          products: [{ quantity: 1, typeID: 165 }],
          time: 600,
        },
      },
    });

    expect(rows).not.toBeNull();
    expect(rows?.blueprint).toEqual({ blueprint_type_id: 681, max_production_limit: 300 });
    expect(rows?.activities).toContainEqual({
      blueprint_type_id: 681,
      activity: 'manufacturing',
      time_seconds: 600,
    });
    expect(rows?.io).toContainEqual({
      blueprint_type_id: 681,
      activity: 'manufacturing',
      direction: 'input',
      type_id: 38,
      quantity: 86,
    });
    expect(rows?.io).toContainEqual({
      blueprint_type_id: 681,
      activity: 'manufacturing',
      direction: 'output',
      type_id: 165,
      quantity: 1,
    });
  });

  it('缺少 _key 时返回 null', () => {
    expect(mapBlueprintRows({ activities: {} })).toBeNull();
  });
});
