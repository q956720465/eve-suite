import { describe, expect, it } from 'vitest';

import { SDE_IMPORTED_FILES, importSde } from '../../src/sde/import';
import type { SdeFileName, SdeFileSource, SdeImportProgress } from '../../src/sde/types';
import { countRows, createMigratedDb } from '../helpers/db';

import { SAMPLE_FILES, SAMPLE_VERSION, createMemorySource, generateTypeLines } from './fixtures';

describe('SDE 导入', () => {
  it('首次导入：各表行数与元信息正确', async () => {
    const db = await createMigratedDb();
    const summary = await importSde(db, createMemorySource());

    expect(summary.skipped).toBe(false);
    expect(summary.version.buildNumber).toBe(3542233);
    expect(summary.counts).toMatchObject({
      categories: 1,
      groups: 1,
      types: 4,
      regions: 1,
      constellations: 1,
      systems: 1,
      stations: 2,
      blueprints: 1,
      blueprint_activities: 4,
      blueprint_io: 2,
      // 1230 → 1 行；1228 → 2 行；其余样本行为空/非法 → 0 行
      type_materials: 3,
    });

    expect(await countRows(db, 'sde_types')).toBe(4);
    expect(await countRows(db, 'sde_stations')).toBe(2);
    expect(await countRows(db, 'sde_blueprint_io')).toBe(2);
    expect(await countRows(db, 'sde_type_materials')).toBe(3);

    const meta = await db.select<{ key: string; value: string }>('SELECT key, value FROM sde_meta');
    const metaMap = new Map(meta.map((row) => [row.key, row.value]));
    expect(metaMap.get('build_number')).toBe('3542233');
    expect(metaMap.get('release_date')).toBe('2026-09-24T11:12:47Z');
    expect(metaMap.get('rows_types')).toBe('4');
    expect(metaMap.get('rows_type_materials')).toBe('3');
    expect(metaMap.get('imported_files')).toBe(SDE_IMPORTED_FILES.join(','));
    expect(metaMap.get('imported_at')).toBeTruthy();
  });

  it('幂等：同版本且文件集一致时重复导入直接跳过', async () => {
    const db = await createMigratedDb();
    const source = createMemorySource();
    await importSde(db, source);

    const second = await importSde(db, source);
    expect(second.skipped).toBe(true);
    expect(await countRows(db, 'sde_types')).toBe(4);
  });

  it('文件集签名变化：构建号未变也要重新导入', async () => {
    const db = await createMigratedDb();
    const source = createMemorySource();
    await importSde(db, source);

    // 模拟「旧版本程序导入过、尚未包含新数据文件」
    await db.execute("UPDATE sde_meta SET value = 'blueprints.jsonl' WHERE key = 'imported_files'");

    const second = await importSde(db, source);
    expect(second.skipped).toBe(false);
    expect(await countRows(db, 'sde_type_materials')).toBe(3);

    const rows = await db.select<{ value: string }>(
      "SELECT value FROM sde_meta WHERE key = 'imported_files'",
    );
    expect(rows[0].value).toBe(SDE_IMPORTED_FILES.join(','));
  });

  it('force：强制重导先清空，不产生重复行', async () => {
    const db = await createMigratedDb();
    const source = createMemorySource();
    await importSde(db, source);

    const forced = await importSde(db, source, { force: true });
    expect(forced.skipped).toBe(false);
    expect(await countRows(db, 'sde_types')).toBe(4);
    expect(await countRows(db, 'sde_stations')).toBe(2);
  });

  it('分批写入：行数超过单批上限仍全部落库', async () => {
    const db = await createMigratedDb();
    const files = { ...SAMPLE_FILES, 'types.jsonl': generateTypeLines(1000) };
    const summary = await importSde(db, createMemorySource(files));

    expect(summary.counts.types).toBe(1000);
    expect(await countRows(db, 'sde_types')).toBe(1000);
  });

  it('失败回滚：中途出错则整体回滚，不留半成品', async () => {
    const db = await createMigratedDb();
    const brokenSource: SdeFileSource = {
      version: async () => SAMPLE_VERSION,
      lines: async function* lines(file: SdeFileName) {
        if (file === 'groups.jsonl') {
          yield SAMPLE_FILES['groups.jsonl']![0];
          throw new Error('模拟读取失败');
        }
        for (const line of SAMPLE_FILES[file] ?? []) {
          yield line;
        }
      },
    };

    await expect(importSde(db, brokenSource)).rejects.toThrow('模拟读取失败');
    // categories 在 groups 之前写入，回滚后应为空
    expect(await countRows(db, 'sde_categories')).toBe(0);
    expect(await countRows(db, 'sde_types')).toBe(0);
    expect(await countRows(db, 'sde_meta')).toBe(0);
  });

  it('市场分组：根节点 parent 为 null，子节点带 parent，缺名行丢弃', async () => {
    const db = await createMigratedDb();
    const summary = await importSde(db, createMemorySource());

    // 样本 5 行 → 缺 name 的 999 被丢弃
    expect(summary.counts.market_groups).toBe(4);
    expect(await countRows(db, 'sde_market_groups')).toBe(4);

    const rows = await db.select<{
      market_group_id: number;
      parent_group_id: number | null;
      name_en: string;
      name_zh: string | null;
      icon_id: number | null;
      has_types: number;
    }>(
      'SELECT market_group_id, parent_group_id, name_en, name_zh, icon_id, has_types FROM sde_market_groups ORDER BY market_group_id',
    );

    expect(rows).toEqual([
      {
        market_group_id: 2,
        parent_group_id: null,
        name_en: 'Blueprints & Reactions',
        name_zh: '蓝图和反应',
        icon_id: 2703,
        has_types: 0,
      },
      {
        market_group_id: 4,
        parent_group_id: null,
        name_en: 'Ships',
        name_zh: '舰船',
        icon_id: 1443,
        has_types: 0,
      },
      {
        market_group_id: 5,
        parent_group_id: 1361,
        name_en: 'Standard Frigates',
        name_zh: '标准护卫舰',
        icon_id: 1443,
        has_types: 0,
      },
      {
        market_group_id: 1857,
        parent_group_id: 533,
        name_en: 'Minerals',
        name_zh: '矿物',
        icon_id: 404,
        has_types: 1,
      },
    ]);

    // 元信息落 rows_market_groups，供数据页展示
    const meta = await db.select<{ value: string }>(
      "SELECT value FROM sde_meta WHERE key = 'rows_market_groups'",
    );
    expect(meta[0]?.value).toBe('4');
  });

  it('进度回调：按文件上报处理行数', async () => {
    const db = await createMigratedDb();
    const events: SdeImportProgress[] = [];
    await importSde(db, createMemorySource(), { onProgress: (progress) => events.push(progress) });

    const files = new Set(events.map((event) => event.file));
    expect(files.has('types.jsonl')).toBe(true);
    expect(files.has('npcStations.jsonl')).toBe(true);
    expect(files.has('blueprints.jsonl')).toBe(true);
    expect(files.has('typeMaterials.jsonl')).toBe(true);
    expect(files.has('marketGroups.jsonl')).toBe(true);
    const typeEvent = events.find((event) => event.file === 'types.jsonl');
    expect(typeEvent?.written).toBe(4);
  });
});
