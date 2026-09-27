import { describe, expect, it } from 'vitest';

import { EsiClient } from '../../src/esi/client';
import { RequestScheduler } from '../../src/esi/scheduler';
import { computeExpiresAt, PersonalSyncer } from '../../src/personal/sync';
import { createMigratedDb } from '../helpers/db';
import { createFakeClock } from '../helpers/fake-clock';
import { createMockHttp, jsonResponse } from '../helpers/mock-http';
import { asset, CHARACTER_ID } from './fixtures';

const START_AT = 1_000_000;

describe('computeExpiresAt', () => {
  it('max-age 秒 → 当前时刻 + maxAge', () => {
    expect(
      computeExpiresAt(
        { maxAgeSeconds: 300, expiresAtMs: null, noStore: false, mustRevalidate: false },
        START_AT,
      ),
    ).toBe(new Date(START_AT + 300_000).toISOString());
  });

  it('无 max-age 时回退 Expires 绝对时刻', () => {
    const expiresAtMs = START_AT + 175_000;
    expect(
      computeExpiresAt(
        { maxAgeSeconds: null, expiresAtMs, noStore: false, mustRevalidate: false },
        START_AT,
      ),
    ).toBe(new Date(expiresAtMs).toISOString());
  });

  it('max-age 优先于 Expires', () => {
    expect(
      computeExpiresAt(
        {
          maxAgeSeconds: 60,
          expiresAtMs: START_AT + 999_000,
          noStore: false,
          mustRevalidate: false,
        },
        START_AT,
      ),
    ).toBe(new Date(START_AT + 60_000).toISOString());
  });

  it('无缓存指令 / no-store / 无任何到期来源 / 已过期 → null（视作立即到期）', () => {
    const cacheable = {
      maxAgeSeconds: 60,
      expiresAtMs: null,
      noStore: false,
      mustRevalidate: false,
    };
    expect(computeExpiresAt(null, START_AT)).toBeNull();
    expect(computeExpiresAt(undefined, START_AT)).toBeNull();
    expect(computeExpiresAt({ ...cacheable, noStore: true }, START_AT)).toBeNull();
    expect(
      computeExpiresAt({ ...cacheable, maxAgeSeconds: null }, START_AT),
    ).toBeNull();
    // Expires 已过去 → 视作不可缓存，不把过去的时刻写进水位
    expect(
      computeExpiresAt(
        { maxAgeSeconds: null, expiresAtMs: START_AT - 1_000, noStore: false, mustRevalidate: false },
        START_AT,
      ),
    ).toBeNull();
  });
});

async function setup() {
  const db = await createMigratedDb();
  const http = createMockHttp();
  const client = new EsiClient({
    http,
    auth: { getAccessToken: async () => 'test-token', invalidate: () => undefined },
  });
  const clock = createFakeClock(START_AT);
  const scheduler = new RequestScheduler({
    clock,
    requestsPerSecond: 1000,
    burst: 1000,
    maxConcurrent: 10,
  });
  const syncer = new PersonalSyncer({ db, client, scheduler, clock });
  return { db, http, clock, syncer };
}

function assetsRequestCount(http: ReturnType<typeof createMockHttp>): number {
  return http.calls.filter((call) => call.url.includes('/assets/')).length;
}

async function readAssetsState(
  db: Awaited<ReturnType<typeof createMigratedDb>>,
): Promise<{ expires_at: string | null; pages: number }> {
  const rows = await db.select<{ expires_at: string | null; pages: number }>(
    'SELECT expires_at, pages FROM personal_sync_state WHERE character_id = ? AND scope = ?',
    [CHARACTER_ID, 'assets'],
  );
  return rows[0];
}

describe('PersonalSyncer 遵守 Cache-Control', () => {
  it('响应带 max-age：写入到期时间；未到期时整轮不发请求', async () => {
    const { db, http, clock, syncer } = await setup();
    http.enqueue(
      jsonResponse(200, [asset({ item_id: 1001 })], {
        'x-pages': '1',
        etag: 'W/"a1"',
        'cache-control': 'public, max-age=600',
      }),
    );

    const first = await syncer.syncScope(CHARACTER_ID, 'assets');

    expect(first.ok).toBe(true);
    expect(first.skipped).toBe(false);
    expect(assetsRequestCount(http)).toBe(1);
    expect(await readAssetsState(db)).toEqual({
      expires_at: new Date(START_AT + 600_000).toISOString(),
      pages: 1,
    });

    // 未推进时间：仍在有效期内 → 不发请求直接跳过
    const second = await syncer.syncScope(CHARACTER_ID, 'assets');

    expect(second.ok).toBe(true);
    expect(second.skipped).toBe(true);
    expect(second.skippedReason).toBe('cache');
    expect(second.requests).toBe(0);
    expect(second.pages).toBe(1);
    expect(assetsRequestCount(http)).toBe(1);

    // 到期后照常请求（带 ETag，服务端回 304）
    clock.advance(600_001);
    http.enqueue(jsonResponse(200, [asset({ item_id: 1001 })], { 'x-pages': '1', etag: 'W/"a2"' }));
    const third = await syncer.syncScope(CHARACTER_ID, 'assets');

    expect(third.skipped).toBe(false);
    expect(third.skippedReason).toBeNull();
    expect(assetsRequestCount(http)).toBe(2);
  });

  it('force 可越过未到期的缓存', async () => {
    const { http, syncer } = await setup();
    http.enqueue(
      jsonResponse(200, [asset()], {
        'x-pages': '1',
        etag: 'W/"a1"',
        'cache-control': 'public, max-age=600',
      }),
    );
    await syncer.syncScope(CHARACTER_ID, 'assets');
    expect(assetsRequestCount(http)).toBe(1);

    http.enqueue(
      jsonResponse(200, [asset({ quantity: 7 })], { 'x-pages': '1', etag: 'W/"a2"' }),
    );
    const forced = await syncer.syncScope(CHARACTER_ID, 'assets', { force: true });

    expect(forced.skipped).toBe(false);
    expect(assetsRequestCount(http)).toBe(2);
  });

  it('服务端不再给出 max-age：旧到期时间被清空（不残留）', async () => {
    const { db, http, clock, syncer } = await setup();
    http.enqueue(
      jsonResponse(200, [asset()], {
        'x-pages': '1',
        etag: 'W/"a1"',
        'cache-control': 'public, max-age=600',
      }),
    );
    await syncer.syncScope(CHARACTER_ID, 'assets');
    expect((await readAssetsState(db)).expires_at).not.toBeNull();

    clock.advance(600_001);
    http.enqueue(jsonResponse(200, [asset()], { 'x-pages': '1', etag: 'W/"a2"' }));
    await syncer.syncScope(CHARACTER_ID, 'assets');

    expect((await readAssetsState(db)).expires_at).toBeNull();
  });

  it('no-store：写入空到期时间（每轮都会回源，靠 ETag 省流量）', async () => {
    const { db, http, syncer } = await setup();
    http.enqueue(
      jsonResponse(200, [asset()], {
        'x-pages': '1',
        etag: 'W/"a1"',
        'cache-control': 'no-store',
      }),
    );

    await syncer.syncScope(CHARACTER_ID, 'assets');

    expect((await readAssetsState(db)).expires_at).toBeNull();
    expect(assetsRequestCount(http)).toBe(1);
  });

  it('实测形态（public + Expires）：按 Expires 写入到期时间并跳过后续轮次', async () => {
    const { db, http, syncer } = await setup();
    const expiresAt = START_AT + 175_000;
    http.enqueue(
      jsonResponse(200, [asset()], {
        'x-pages': '1',
        etag: 'W/"a1"',
        'cache-control': 'public',
        expires: new Date(expiresAt).toUTCString(),
      }),
    );

    const first = await syncer.syncScope(CHARACTER_ID, 'assets');

    expect(first.skipped).toBe(false);
    expect((await readAssetsState(db)).expires_at).toBe(new Date(expiresAt).toISOString());

    const second = await syncer.syncScope(CHARACTER_ID, 'assets');

    expect(second.skippedReason).toBe('cache');
    expect(second.requests).toBe(0);
    expect(assetsRequestCount(http)).toBe(1);
  });

  it('304 响应也刷新到期时间', async () => {
    const { db, http, syncer } = await setup();
    http.enqueue(
      jsonResponse(200, [asset()], {
        'x-pages': '1',
        etag: 'W/"a1"',
        'cache-control': 'public, max-age=600',
      }),
    );
    await syncer.syncScope(CHARACTER_ID, 'assets');

    // 到期后回源命中 304，且 304 携带新的 max-age
    http.enqueue({
      status: 304,
      headers: { etag: 'W/"a1"', 'cache-control': 'public, max-age=120' },
      text: '',
    });
    const result = await syncer.syncScope(CHARACTER_ID, 'assets', { force: true });

    expect(result.skipped).toBe(true);
    expect(result.skippedReason).toBe('not-modified');
    expect((await readAssetsState(db)).expires_at).toBe(
      new Date(START_AT + 120_000).toISOString(),
    );
  });
});
