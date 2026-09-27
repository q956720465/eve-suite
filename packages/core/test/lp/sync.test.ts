import { describe, expect, it } from 'vitest';

import { EsiClient } from '../../src/esi/client';
import { RequestScheduler } from '../../src/esi/scheduler';
import { getLpStoreState, listLpOffers } from '../../src/lp/repo';
import { DEFAULT_LP_STORE_TTL_MS, LpStoreSyncer, resolveStoreExpiresAt } from '../../src/lp/sync';
import { countRows, createMigratedDb } from '../helpers/db';
import { createFakeClock } from '../helpers/fake-clock';
import { createMockHttp, emptyResponse, jsonResponse } from '../helpers/mock-http';
import { AMARR_NAVY, CEP_FORCE, insertLpBalance } from './fixtures';

const CHARACTER_ID = 2114553827;
/** 2026-09-28T00:00:00Z */
const START_AT = Date.parse('2026-09-28T00:00:00Z');

/** 与真实 ESI 响应同构的样本（CEP 军团） */
const OFFERS = [
  {
    offer_id: 15360,
    type_id: 3089,
    quantity: 1,
    lp_cost: 37500,
    isk_cost: 37_500_000,
    ak_cost: 0,
    required_items: [],
  },
  {
    offer_id: 15361,
    type_id: 3092,
    quantity: 1,
    lp_cost: 250_000,
    isk_cost: 250_000_000,
    ak_cost: 5,
    required_items: [{ type_id: 34, quantity: 100 }],
  },
];

async function setup(options: { maxAttempts?: number } = {}) {
  const clock = createFakeClock(START_AT);
  const db = await createMigratedDb();
  const http = createMockHttp();
  const client = new EsiClient({ http });
  const scheduler = new RequestScheduler({ clock, maxAttempts: options.maxAttempts });
  const syncer = new LpStoreSyncer({ db, client, scheduler, clock });
  return { clock, db, http, syncer };
}

describe('resolveStoreExpiresAt', () => {
  it('取服务端缓存声明与本地 TTL 的较晚者', () => {
    const ttlAt = new Date(START_AT + DEFAULT_LP_STORE_TTL_MS).toISOString();
    const laterAt = new Date(START_AT + 48 * 3600 * 1000).toISOString();

    // 无服务端声明 → 本地 TTL
    expect(resolveStoreExpiresAt(null, START_AT)).toBe(ttlAt);
    // 服务端更短（600s）→ 仍取 TTL（不早于服务端回源，且减少请求）
    expect(
      resolveStoreExpiresAt(
        { maxAgeSeconds: 600, expiresAtMs: null, noStore: false, mustRevalidate: false },
        START_AT,
      ),
    ).toBe(ttlAt);
    // 服务端更长（48h）→ 取服务端
    expect(
      resolveStoreExpiresAt(
        { maxAgeSeconds: 48 * 3600, expiresAtMs: null, noStore: false, mustRevalidate: false },
        START_AT,
      ),
    ).toBe(laterAt);
  });
});

describe('LpStoreSyncer', () => {
  it('首次抓取：整团写入报价与所需材料，并记录水位 / ETag', async () => {
    const { db, http, syncer } = await setup();
    http.enqueue(jsonResponse(200, OFFERS, { etag: 'W/"lp-1"', 'cache-control': 'public, max-age=600' }));

    const result = await syncer.syncStore(CEP_FORCE);

    expect(result).toEqual({
      corporationId: CEP_FORCE,
      ok: true,
      requests: 1,
      offersWritten: 2,
      skipped: false,
      skippedReason: null,
      error: null,
    });
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0].url).toBe('https://esi.evetech.net/latest/loyalty/stores/1000125/offers/');
    expect(http.calls[0].ifNoneMatch).toBeUndefined();

    const offers = await listLpOffers(db, CEP_FORCE);
    expect(offers.map((offer) => offer.offerId)).toEqual([15360, 15361]);
    expect(offers[0].requiredItems).toEqual([]);
    expect(offers[1].requiredItems).toEqual([{ typeId: 34, quantity: 100 }]);
    expect(offers[1]).toMatchObject({ lpCost: 250_000, iskCost: 250_000_000, akCost: 5, quantity: 1 });

    const state = await getLpStoreState(db, CEP_FORCE);
    expect(state).toMatchObject({ etag: 'W/"lp-1"', offersWritten: 2, requests: 1, lastError: null });
    expect(state?.lastOkAt).toBe(new Date(START_AT).toISOString());
    expect(state?.expiresAt).toBe(new Date(START_AT + DEFAULT_LP_STORE_TTL_MS).toISOString());
  });

  it('本地有效期内不重复请求（skippedReason=cache）', async () => {
    const { http, syncer } = await setup();
    http.enqueue(jsonResponse(200, OFFERS, { etag: 'e1' }));
    await syncer.syncStore(CEP_FORCE);

    const second = await syncer.syncStore(CEP_FORCE);

    expect(second).toMatchObject({ ok: true, requests: 0, skipped: true, skippedReason: 'cache' });
    expect(http.calls).toHaveLength(1);
  });

  it('force 回源且命中 304：只推水位，报价数据保留', async () => {
    const { db, http, syncer } = await setup();
    http.enqueue(jsonResponse(200, OFFERS, { etag: 'W/"lp-1"' }));
    await syncer.syncStore(CEP_FORCE);
    http.enqueue(emptyResponse(304, { 'cache-control': 'public' }));

    const forced = await syncer.syncStore(CEP_FORCE, { force: true });

    expect(forced).toMatchObject({
      ok: true,
      requests: 1,
      offersWritten: 0,
      skipped: true,
      skippedReason: 'not-modified',
    });
    expect(http.calls[1].ifNoneMatch).toBe('W/"lp-1"');
    expect(await listLpOffers(db, CEP_FORCE)).toHaveLength(2);
    const state = await getLpStoreState(db, CEP_FORCE);
    expect(state?.requests).toBe(2);
    expect(state?.offersWritten).toBe(2);
  });

  it('整团替换：新响应更少时清除旧报价与其所需材料', async () => {
    const { db, http, syncer } = await setup();
    http.enqueue(jsonResponse(200, OFFERS, { etag: 'e1' }));
    await syncer.syncStore(CEP_FORCE);
    expect(await countRows(db, 'lp_offer_items')).toBe(1);

    http.enqueue(jsonResponse(200, [OFFERS[0]], { etag: 'e2' }));
    const replaced = await syncer.syncStore(CEP_FORCE, { force: true });

    expect(replaced.offersWritten).toBe(1);
    expect((await listLpOffers(db, CEP_FORCE)).map((offer) => offer.offerId)).toEqual([15360]);
    expect(await countRows(db, 'lp_offer_items')).toBe(0);
  });

  it('失败隔离：单军团失败只写该行错误，旧数据与水位保留，其余军团照常', async () => {
    const { db, http, syncer } = await setup({ maxAttempts: 1 });
    http.enqueue(jsonResponse(200, OFFERS, { etag: 'e1' }));
    await syncer.syncStore(CEP_FORCE);

    http.enqueue(jsonResponse(500, { error: 'boom' }));
    http.enqueue(
      jsonResponse(200, [{ ...OFFERS[0], offer_id: 999, required_items: [] }], { etag: 'e2' }),
    );
    const summary = await syncer.syncStores([CEP_FORCE, AMARR_NAVY], { force: true });

    expect(summary.okCount).toBe(1);
    expect(summary.failedCount).toBe(1);
    expect(summary.results[0]).toMatchObject({ corporationId: CEP_FORCE, ok: false });
    expect(summary.results[0].error).toContain('500');
    expect(summary.results[1]).toMatchObject({ corporationId: AMARR_NAVY, ok: true, offersWritten: 1 });

    const failedState = await getLpStoreState(db, CEP_FORCE);
    expect(failedState?.lastError).toContain('500');
    expect(failedState?.lastOkAt).not.toBeNull();
    expect(await listLpOffers(db, CEP_FORCE)).toHaveLength(2);
    expect((await listLpOffers(db, AMARR_NAVY)).map((offer) => offer.offerId)).toEqual([999]);
  });

  it('同一 offer_id 在不同军团可共存（真实数据实测：offer_id 会跨军团重复）', async () => {
    const { db, http, syncer } = await setup();
    http.enqueue(
      jsonResponse(
        200,
        [
          {
            offer_id: 15360,
            type_id: 3089,
            quantity: 1,
            lp_cost: 100,
            isk_cost: 0,
            ak_cost: 0,
            required_items: [{ type_id: 34, quantity: 10 }],
          },
        ],
        { etag: 'e1' },
      ),
    );
    http.enqueue(
      jsonResponse(
        200,
        [
          {
            offer_id: 15360,
            type_id: 3092,
            quantity: 2,
            lp_cost: 200,
            isk_cost: 0,
            ak_cost: 0,
            required_items: [{ type_id: 35, quantity: 20 }],
          },
        ],
        { etag: 'e2' },
      ),
    );

    const summary = await syncer.syncStores([CEP_FORCE, AMARR_NAVY]);

    expect(summary.failedCount).toBe(0);
    expect((await listLpOffers(db, CEP_FORCE))[0]).toMatchObject({
      offerId: 15360,
      typeId: 3089,
      requiredItems: [{ typeId: 34, quantity: 10 }],
    });
    expect((await listLpOffers(db, AMARR_NAVY))[0]).toMatchObject({
      offerId: 15360,
      typeId: 3092,
      requiredItems: [{ typeId: 35, quantity: 20 }],
    });
  });

  it('syncCharacterStores 只抓「角色有 LP 余额」的军团', async () => {
    const { db, http, syncer } = await setup();
    await insertLpBalance(db, CHARACTER_ID, CEP_FORCE, 1000);
    await insertLpBalance(db, CHARACTER_ID, AMARR_NAVY, 0); // 0 LP 不抓
    http.enqueue(jsonResponse(200, OFFERS, { etag: 'e1' }));

    const summary = await syncer.syncCharacterStores(CHARACTER_ID);

    expect(summary.results.map((item) => item.corporationId)).toEqual([CEP_FORCE]);
    expect(http.calls).toHaveLength(1);
  });
});
