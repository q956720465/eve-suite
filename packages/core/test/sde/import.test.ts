import { describe, expect, it } from 'vitest';

import { importSde } from '../../src/sde/import';
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
    });

    expect(await countRows(db, 'sde_types')).toBe(4);
    expect(await countRows(db, 'sde_stations')).toBe(2);
    expect(await countRows(db, 'sde_blueprint_io')).toBe(2);

    const meta = await db.select<{ key: string; value: string }>('SELECT key, value FROM sde_meta');
    const metaMap = new Map(meta.map((row) => [row.key, row.value]));
    expect(metaMap.get('build_number')).toBe('3542233');
    expect(metaMap.get('release_date')).toBe('2026-09-24T11:12:47Z');
    expect(metaMap.get('rows_types')).toBe('4');
    expect(metaMap.get('imported_at')).toBeTruthy();
  });

  it('幂等：同版本重复导入直接跳过', async () => {
    const db = await createMigratedDb();
    const source = createMemorySource();
    await importSde(db, source);

    const second = await importSde(db, source);
    expect(second.skipped).toBe(true);
    expect(await countRows(db, 'sde_types')).toBe(4);
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

  it('进度回调：按文件上报处理行数', async () => {
    const db = await createMigratedDb();
    const events: SdeImportProgress[] = [];
    await importSde(db, createMemorySource(), { onProgress: (progress) => events.push(progress) });

    const files = new Set(events.map((event) => event.file));
    expect(files.has('types.jsonl')).toBe(true);
    expect(files.has('npcStations.jsonl')).toBe(true);
    expect(files.has('blueprints.jsonl')).toBe(true);
    const typeEvent = events.find((event) => event.file === 'types.jsonl');
    expect(typeEvent?.written).toBe(4);
  });
});
