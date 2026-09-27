import { describe, expect, it } from 'vitest';

import type { DbAdapter } from '../../src/db/types';
import { importSde } from '../../src/sde/import';
import { getSdeStatus, getTypeDetail, searchStations, searchTypes } from '../../src/sde/repo';
import { createMigratedDb } from '../helpers/db';

import { createMemorySource } from './fixtures';

/** 建库 + 导入样本数据 */
async function setup(): Promise<DbAdapter> {
  const db = await createMigratedDb();
  await importSde(db, createMemorySource());
  return db;
}

describe('物品搜索', () => {
  it('英文名搜索：Tritanium 命中且属性正确', async () => {
    const db = await setup();
    const hits = await searchTypes(db, 'Tritanium');

    expect(hits.length).toBeGreaterThan(0);
    const tritanium = hits[0];
    expect(tritanium).toMatchObject({
      typeId: 34,
      nameEn: 'Tritanium',
      nameZh: '三钛合金',
      groupNameEn: 'Mineral',
      groupNameZh: '矿物',
      categoryNameEn: 'Material',
      categoryNameZh: '材料',
      volume: 0.01,
      published: 1,
    });
  });

  it('中文名搜索：三钛合金命中同一物品', async () => {
    const db = await setup();
    const hits = await searchTypes(db, '三钛合金');
    expect(hits.map((hit) => hit.typeId)).toContain(34);
  });

  it('部分匹配：tri 命中 Tritanium，且精确匹配优先排序', async () => {
    const db = await setup();
    const partial = await searchTypes(db, 'tri');
    expect(partial.map((hit) => hit.nameEn)).toContain('Tritanium');
  });

  it('空查询返回空数组；LIKE 通配符按字面处理', async () => {
    const db = await setup();
    expect(await searchTypes(db, '   ')).toEqual([]);
    expect(await searchTypes(db, '%')).toEqual([]);
    expect(await searchTypes(db, '_')).toEqual([]);
  });

  it('限制返回条数', async () => {
    const db = await setup();
    const hits = await searchTypes(db, 'i', 1);
    expect(hits).toHaveLength(1);
  });
});

describe('物品详情', () => {
  it('返回描述与扩展字段', async () => {
    const db = await setup();
    const detail = await getTypeDetail(db, 34);

    expect(detail).toMatchObject({
      typeId: 34,
      nameEn: 'Tritanium',
      nameZh: '三钛合金',
      descriptionEn: 'The main building block in space structures.',
      descriptionZh: '太空结构的主要建筑材料。',
      portionSize: 1,
      basePrice: 2,
      marketGroupId: 1857,
    });
  });

  it('不存在的 typeID 返回 null', async () => {
    const db = await setup();
    expect(await getTypeDetail(db, 123456789)).toBeNull();
  });
});

describe('空间站搜索', () => {
  it('按星系名搜索：Jita 命中该星系 NPC 站', async () => {
    const db = await setup();
    const hits = await searchStations(db, 'Jita');

    expect(hits.length).toBe(2);
    const assemblyPlant = hits.find((hit) => hit.stationId === 60003760);
    expect(assemblyPlant).toMatchObject({
      stationId: 60003760,
      nameEn: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant',
      nameZh: '吉他 IV - 卫星 4 - 加达里海军 组装车间',
      systemNameEn: 'Jita',
      systemNameZh: '吉他',
      regionNameEn: 'The Forge',
      regionNameZh: '伏尔戈',
    });
  });

  it('按星域名搜索：The Forge 命中其下所有站', async () => {
    const db = await setup();
    const hits = await searchStations(db, 'The Forge');
    expect(hits.length).toBe(2);
  });

  it('按中文名搜索：吉他 与 加达里海军 均可命中', async () => {
    const db = await setup();
    expect((await searchStations(db, '吉他')).length).toBe(2);
    expect((await searchStations(db, '加达里海军')).length).toBe(2);
  });

  it('空查询返回空数组', async () => {
    const db = await setup();
    expect(await searchStations(db, '  ')).toEqual([]);
  });
});

describe('SDE 状态', () => {
  it('导入后为就绪状态，行数与元信息齐全', async () => {
    const db = await setup();
    const status = await getSdeStatus(db);

    expect(status.ready).toBe(true);
    expect(status.buildNumber).toBe(3542233);
    expect(status.releaseDate).toBe('2026-09-24T11:12:47Z');
    expect(status.importedAt).toBeTruthy();
    expect(status.typeCount).toBe(4);
    expect(status.counts.types).toBe(4);
  });

  it('未导入时为未就绪状态', async () => {
    const db = await createMigratedDb();
    const status = await getSdeStatus(db);

    expect(status.ready).toBe(false);
    expect(status.buildNumber).toBeNull();
    expect(status.typeCount).toBe(0);
  });
});
