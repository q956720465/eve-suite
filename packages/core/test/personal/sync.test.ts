import { describe, expect, it } from 'vitest';

import type { DbAdapter } from '../../src/db/types';
import { EsiClient } from '../../src/esi/client';
import { RequestScheduler } from '../../src/esi/scheduler';
import { TokenManagerError } from '../../src/esi/token-manager';
import { PersonalSyncer } from '../../src/personal/sync';
import { PERSONAL_SCOPES } from '../../src/personal/scopes';
import { countRows, createMigratedDb } from '../helpers/db';
import { createFakeClock, type FakeClock } from '../helpers/fake-clock';
import { createMockHttp, emptyResponse, jsonResponse, type MockHttp } from '../helpers/mock-http';
import {
  asset,
  CHARACTER_ID,
  CORPORATION_ID,
  contract,
  job,
  journalEntry,
  loyaltyPoints,
  miningObservation,
  order,
} from './fixtures';

const PAGED_ETAGS = {
  assets: 'W/"a1"',
  wallet_journal: 'W/"j1"',
  orders: 'W/"o1"',
  contracts: 'W/"c1"',
  industry: 'W/"i1"',
  mining: 'W/"m1"',
  loyalty: 'W/"l1"',
} as const;

async function insertCharacter(db: DbAdapter, characterId: number, name = '测试角色'): Promise<void> {
  await db.execute(
    'INSERT INTO characters (character_id, name, scopes, added_at) VALUES (?, ?, ?, ?)',
    [characterId, name, 'esi-assets esi-wallet', '2026-09-27T00:00:00Z'],
  );
}

interface TestContext {
  db: DbAdapter;
  http: MockHttp;
  client: EsiClient;
  clock: FakeClock;
  syncer: PersonalSyncer;
}

async function setup(): Promise<TestContext> {
  const db = await createMigratedDb();
  await insertCharacter(db, CHARACTER_ID);
  const http = createMockHttp();
  const client = new EsiClient({
    http,
    auth: { getAccessToken: async () => 'test-token', invalidate: () => undefined },
  });
  const clock = createFakeClock();
  const scheduler = new RequestScheduler({
    clock,
    requestsPerSecond: 1000,
    burst: 1000,
    maxConcurrent: 100,
  });
  const syncer = new PersonalSyncer({ db, client, scheduler, clock });
  return { db, http, client, clock, syncer };
}

/** 首轮（全量）响应：公开信息 + 8 端点各 1 页 */
function enqueueFirstRound(http: MockHttp): void {
  http.enqueue(jsonResponse(200, { corporation_id: CORPORATION_ID }));
  http.enqueue(
    jsonResponse(200, [asset({ item_id: 1001 }), asset({ item_id: 1002, is_blueprint_copy: true })], {
      'x-pages': '1',
      etag: PAGED_ETAGS.assets,
    }),
  );
  http.enqueue(jsonResponse(200, 12345.67, { etag: 'W/"w1"' }));
  http.enqueue(
    jsonResponse(200, [journalEntry({ id: 100 }), journalEntry({ id: 101 })], {
      'x-pages': '1',
      etag: PAGED_ETAGS.wallet_journal,
    }),
  );
  http.enqueue(jsonResponse(200, [order({ order_id: 2001 })], { 'x-pages': '1', etag: PAGED_ETAGS.orders }));
  http.enqueue(
    jsonResponse(200, [contract({ contract_id: 3001 })], { 'x-pages': '1', etag: PAGED_ETAGS.contracts }),
  );
  http.enqueue(jsonResponse(200, [job({ job_id: 4001 })], { 'x-pages': '1', etag: PAGED_ETAGS.industry }));
  http.enqueue(
    jsonResponse(200, [miningObservation({ quantity: 5000 })], {
      'x-pages': '1',
      etag: PAGED_ETAGS.mining,
    }),
  );
  http.enqueue(
    jsonResponse(200, [loyaltyPoints({ loyalty_points: 2000 })], {
      'x-pages': '1',
      etag: PAGED_ETAGS.loyalty,
    }),
  );
}

/** 次轮（全 304）响应：公开信息恒 200，8 端点全部命中缓存 */
function enqueueAllNotModified(http: MockHttp): void {
  http.enqueue(jsonResponse(200, { corporation_id: CORPORATION_ID }));
  http.enqueue(emptyResponse(304, { etag: PAGED_ETAGS.assets }));
  http.enqueue(emptyResponse(304, { etag: 'W/"w1"' }));
  http.enqueue(emptyResponse(304, { etag: PAGED_ETAGS.wallet_journal }));
  http.enqueue(emptyResponse(304, { etag: PAGED_ETAGS.orders }));
  http.enqueue(emptyResponse(304, { etag: PAGED_ETAGS.contracts }));
  http.enqueue(emptyResponse(304, { etag: PAGED_ETAGS.industry }));
  http.enqueue(emptyResponse(304, { etag: PAGED_ETAGS.mining }));
  http.enqueue(emptyResponse(304, { etag: PAGED_ETAGS.loyalty }));
}

describe('个人数据同步器', () => {
  it('首轮全量同步：8 端点写入各自表，余额与军团写入 characters，水位齐全', async () => {
    const ctx = await setup();
    enqueueFirstRound(ctx.http);

    const result = await ctx.syncer.syncCharacter(CHARACTER_ID);

    // 结果：8 端点全部成功
    expect(result.corporationInfo).toEqual({ ok: true, error: null });
    expect(result.scopes).toHaveLength(8);
    for (const scope of result.scopes) {
      expect(scope.ok, `scope ${scope.scope}`).toBe(true);
      expect(scope.error).toBeNull();
      expect(scope.skipped).toBe(false);
    }

    // 各表行数
    expect(await countRows(ctx.db, 'assets')).toBe(2);
    expect(await countRows(ctx.db, 'wallet_journal')).toBe(2);
    expect(await countRows(ctx.db, 'my_orders')).toBe(1);
    expect(await countRows(ctx.db, 'contracts')).toBe(1);
    expect(await countRows(ctx.db, 'industry_jobs')).toBe(1);
    expect(await countRows(ctx.db, 'mining_ledger')).toBe(1);
    expect(await countRows(ctx.db, 'lp_balances')).toBe(1);

    // characters：余额 / 军团 / 同步时间
    const character = await ctx.db.select<{
      corporation_id: number | null;
      wallet_balance: number | null;
      wallet_synced_at: string | null;
      last_sync_at: string | null;
    }>('SELECT corporation_id, wallet_balance, wallet_synced_at, last_sync_at FROM characters WHERE character_id = ?', [
      CHARACTER_ID,
    ]);
    expect(character[0].corporation_id).toBe(CORPORATION_ID);
    expect(character[0].wallet_balance).toBe(12345.67);
    expect(character[0].wallet_synced_at).not.toBeNull();
    expect(character[0].last_sync_at).not.toBeNull();

    // 水位：8 行，成功时间与页数记录齐全
    const states = await ctx.db.select<{
      scope: string;
      last_ok_at: string | null;
      last_error: string | null;
      pages: number;
    }>('SELECT scope, last_ok_at, last_error, pages FROM personal_sync_state WHERE character_id = ? ORDER BY scope', [
      CHARACTER_ID,
    ]);
    expect(states.map((row) => row.scope).sort()).toEqual([...PERSONAL_SCOPES].sort());
    for (const row of states) {
      expect(row.last_ok_at, `scope ${row.scope}`).not.toBeNull();
      expect(row.last_error).toBeNull();
      expect(row.pages).toBe(1);
    }

    // 分页端点的逐页 ETag 复用 market_etag_cache KV（7 个分页端点各 1 页）
    const etagRows = await ctx.db.select<{ scope: string }>(
      "SELECT scope FROM market_etag_cache WHERE scope LIKE 'personal:%'",
    );
    expect(etagRows).toHaveLength(7);

    // 认证端点带 Bearer，公开端点不带
    expect(ctx.http.calls[0]?.bearerToken).toBeUndefined();
    expect(ctx.http.calls[1]?.bearerToken).toBe('test-token');
  });

  it('次轮全部 304：跳过写入且数据保持不变', async () => {
    const ctx = await setup();
    enqueueFirstRound(ctx.http);
    await ctx.syncer.syncCharacter(CHARACTER_ID);
    ctx.clock.advance(600_000);

    enqueueAllNotModified(ctx.http);
    const second = await ctx.syncer.syncCharacter(CHARACTER_ID);

    for (const scope of second.scopes) {
      expect(scope.ok, `scope ${scope.scope}`).toBe(true);
      expect(scope.skipped, `scope ${scope.scope}`).toBe(true);
      expect(scope.itemsWritten).toBe(0);
    }
    expect(await countRows(ctx.db, 'assets')).toBe(2);
    expect(await countRows(ctx.db, 'wallet_journal')).toBe(2);
    expect(await countRows(ctx.db, 'my_orders')).toBe(1);
  });

  it('部分页 304：对缺页无条件重取并完整替换（assets 两页）', async () => {
    const ctx = await setup();
    // 第 1 轮：2 页
    ctx.http.enqueue(
      jsonResponse(200, [asset({ item_id: 1001 }), asset({ item_id: 1002 })], {
        'x-pages': '2',
        etag: 'W/"a1"',
      }),
    );
    ctx.http.enqueue(jsonResponse(200, [asset({ item_id: 2001 })], { etag: 'W/"a2"' }));
    await ctx.syncer.syncScope(CHARACTER_ID, 'assets');
    expect(await countRows(ctx.db, 'assets')).toBe(3);

    // 第 2 轮：第 1 页 304、第 2 页变化 → 补齐第 1 页
    ctx.http.enqueue(emptyResponse(304, { etag: 'W/"a1"' }));
    ctx.http.enqueue(
      jsonResponse(200, [asset({ item_id: 2002 })], { etag: 'W/"a2b"' }),
    );
    ctx.http.enqueue(
      jsonResponse(200, [asset({ item_id: 1001 }), asset({ item_id: 1002 })], {
        etag: 'W/"a1"',
      }),
    );

    const result = await ctx.syncer.syncScope(CHARACTER_ID, 'assets');

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.pages).toBe(2);
    expect(result.requests).toBe(3);
    expect(result.itemsWritten).toBe(3);
    expect(await countRows(ctx.db, 'assets')).toBe(3);
    const ids = await ctx.db.select<{ item_id: number }>(
      'SELECT item_id FROM assets WHERE character_id = ? ORDER BY item_id',
      [CHARACTER_ID],
    );
    expect(ids.map((row) => row.item_id)).toEqual([1001, 1002, 2002]);

    // 补齐请求（第 3 次 assets 请求）不带 If-None-Match
    const assetsCalls = ctx.http.calls.filter((call) => call.url.includes('/assets/'));
    expect(assetsCalls).toHaveLength(5); // 首轮 2 次 + 次轮 3 次
    expect(assetsCalls[4]?.ifNoneMatch).toBeUndefined();
  });

  it('wallet_journal 合并 upsert：既有条目不重复，修订覆盖，历史保留', async () => {
    const ctx = await setup();
    ctx.http.enqueue(
      jsonResponse(200, [journalEntry({ id: 100, description: '原始' }), journalEntry({ id: 101 })], {
        'x-pages': '1',
        etag: 'W/"j1"',
      }),
    );
    await ctx.syncer.syncScope(CHARACTER_ID, 'wallet_journal');

    const before = await ctx.db.select<{ entry_id: number; description: string; fetched_at: string }>(
      'SELECT entry_id, description, fetched_at FROM wallet_journal WHERE character_id = ? ORDER BY entry_id',
      [CHARACTER_ID],
    );
    expect(before.map((row) => row.entry_id)).toEqual([100, 101]);

    // 第 2 轮：101 描述修订 + 102 新增 + 100 不再返回（ESI 只带最近若干条）
    ctx.http.enqueue(
      jsonResponse(
        200,
        [journalEntry({ id: 101, description: '修订后' }), journalEntry({ id: 102 })],
        { 'x-pages': '1', etag: 'W/"j2"' },
      ),
    );
    const result = await ctx.syncer.syncScope(CHARACTER_ID, 'wallet_journal');

    expect(result.ok).toBe(true);
    expect(result.itemsWritten).toBe(2);
    const after = await ctx.db.select<{ entry_id: number; description: string; fetched_at: string }>(
      'SELECT entry_id, description, fetched_at FROM wallet_journal WHERE character_id = ? ORDER BY entry_id',
      [CHARACTER_ID],
    );
    expect(after.map((row) => row.entry_id)).toEqual([100, 101, 102]);
    expect(after[1].description).toBe('修订后');
    // 100 未在本轮响应中：保留原行（含原 fetched_at），不被删除也不被改写
    expect(after[0].description).toBe('原始');
    expect(after[0].fetched_at).toBe(before[0].fetched_at);
  });

  it('mining 合并 upsert：同键数量变化覆盖，新键追加', async () => {
    const ctx = await setup();
    ctx.http.enqueue(
      jsonResponse(200, [miningObservation({ quantity: 5000 })], {
        'x-pages': '1',
        etag: 'W/"m1"',
      }),
    );
    await ctx.syncer.syncScope(CHARACTER_ID, 'mining');

    ctx.http.enqueue(
      jsonResponse(
        200,
        [miningObservation({ quantity: 7500 }), miningObservation({ type_id: 35, quantity: 100 })],
        { 'x-pages': '1', etag: 'W/"m2"' },
      ),
    );
    const result = await ctx.syncer.syncScope(CHARACTER_ID, 'mining');

    expect(result.ok).toBe(true);
    const rows = await ctx.db.select<{ type_id: number; quantity: number }>(
      'SELECT type_id, quantity FROM mining_ledger WHERE character_id = ? ORDER BY type_id',
      [CHARACTER_ID],
    );
    expect(rows).toEqual([
      { type_id: 34, quantity: 7500 },
      { type_id: 35, quantity: 100 },
    ]);
  });

  it('失败隔离：orders 端点 500（调度器重试后仍失败）只记该 scope，其余照常', async () => {
    const ctx = await setup();
    enqueueFirstRound(ctx.http);
    await ctx.syncer.syncCharacter(CHARACTER_ID);

    const ordersStateBefore = await ctx.db.select<{ last_ok_at: string | null }>(
      'SELECT last_ok_at FROM personal_sync_state WHERE character_id = ? AND scope = ?',
      [CHARACTER_ID, 'orders'],
    );

    // 次轮：orders 持续 500（调度器共尝试 3 次），其余端点正常
    ctx.http.enqueue(jsonResponse(200, { corporation_id: CORPORATION_ID }));
    ctx.http.enqueue(emptyResponse(304, { etag: PAGED_ETAGS.assets }));
    ctx.http.enqueue(emptyResponse(304, { etag: 'W/"w1"' }));
    ctx.http.enqueue(emptyResponse(304, { etag: PAGED_ETAGS.wallet_journal }));
    ctx.http.enqueue(emptyResponse(500));
    ctx.http.enqueue(emptyResponse(500));
    ctx.http.enqueue(emptyResponse(500));
    ctx.http.enqueue(emptyResponse(304, { etag: PAGED_ETAGS.contracts }));
    ctx.http.enqueue(emptyResponse(304, { etag: PAGED_ETAGS.industry }));
    ctx.http.enqueue(emptyResponse(304, { etag: PAGED_ETAGS.mining }));
    ctx.http.enqueue(emptyResponse(304, { etag: PAGED_ETAGS.loyalty }));

    const second = await ctx.syncer.syncCharacter(CHARACTER_ID);

    const ordersResult = second.scopes.find((scope) => scope.scope === 'orders');
    expect(ordersResult?.ok).toBe(false);
    expect(ordersResult?.error).toContain('500');
    expect(ordersResult?.skipped).toBe(false);
    for (const scope of second.scopes) {
      if (scope.scope !== 'orders') {
        expect(scope.ok, `scope ${scope.scope}`).toBe(true);
      }
    }

    // 水位：orders 只写 last_error，last_ok_at 保持首轮值；其它 scope 无错误
    const ordersStateAfter = await ctx.db.select<{
      last_ok_at: string | null;
      last_error: string | null;
    }>(
      'SELECT last_ok_at, last_error FROM personal_sync_state WHERE character_id = ? AND scope = ?',
      [CHARACTER_ID, 'orders'],
    );
    expect(ordersStateAfter[0].last_error).not.toBeNull();
    expect(ordersStateAfter[0].last_ok_at).toBe(ordersStateBefore[0].last_ok_at);

    const contractsState = await ctx.db.select<{ last_error: string | null }>(
      'SELECT last_error FROM personal_sync_state WHERE character_id = ? AND scope = ?',
      [CHARACTER_ID, 'contracts'],
    );
    expect(contractsState[0].last_error).toBeNull();

    // 订单数据保持首轮快照
    expect(await countRows(ctx.db, 'my_orders')).toBe(1);
  });

  it('认证失败原样穿透：TokenManagerError 不被包装，水位只记错误', async () => {
    const ctx = await setup();
    const client = new EsiClient({
      http: ctx.http,
      auth: {
        getAccessToken: async () => {
          throw new TokenManagerError('reauth_required', '刷新令牌已失效，需要重新授权');
        },
        invalidate: () => undefined,
      },
    });
    // 客户端层契约：原样抛出 TokenManagerError（不包装成 EsiError）
    await expect(client.fetchWalletBalance(CHARACTER_ID)).rejects.toBeInstanceOf(TokenManagerError);

    const scheduler = new RequestScheduler({
      clock: ctx.clock,
      requestsPerSecond: 1000,
      burst: 1000,
      maxConcurrent: 100,
    });
    const syncer = new PersonalSyncer({ db: ctx.db, client, scheduler, clock: ctx.clock });

    const result = await syncer.syncScope(CHARACTER_ID, 'wallet_balance');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('刷新令牌已失效，需要重新授权');
    const state = await ctx.db.select<{ last_error: string | null; last_ok_at: string | null }>(
      'SELECT last_error, last_ok_at FROM personal_sync_state WHERE character_id = ? AND scope = ?',
      [CHARACTER_ID, 'wallet_balance'],
    );
    expect(state[0].last_error).toBe('刷新令牌已失效，需要重新授权');
    expect(state[0].last_ok_at).toBeNull();
  });

  it('角色隔离：同步另一角色不影响已有角色数据', async () => {
    const ctx = await setup();
    const otherId = 96099999;
    await insertCharacter(ctx.db, otherId, '另一角色');

    ctx.http.enqueue(
      jsonResponse(200, [asset({ item_id: 1001 })], { 'x-pages': '1', etag: 'W/"a1"' }),
    );
    await ctx.syncer.syncScope(CHARACTER_ID, 'assets');

    ctx.http.enqueue(
      jsonResponse(200, [asset({ item_id: 9001 }), asset({ item_id: 9002 })], {
        'x-pages': '1',
        etag: 'W/"b1"',
      }),
    );
    const result = await ctx.syncer.syncScope(otherId, 'assets');

    expect(result.ok).toBe(true);
    const mine = await ctx.db.select<{ item_id: number }>(
      'SELECT item_id FROM assets WHERE character_id = ?',
      [CHARACTER_ID],
    );
    const theirs = await ctx.db.select<{ item_id: number }>(
      'SELECT item_id FROM assets WHERE character_id = ? ORDER BY item_id',
      [otherId],
    );
    expect(mine.map((row) => row.item_id)).toEqual([1001]);
    expect(theirs.map((row) => row.item_id)).toEqual([9001, 9002]);

    // 水位也按角色隔离
    const stateRows = await ctx.db.select<{ character_id: number; scope: string }>(
      'SELECT character_id, scope FROM personal_sync_state WHERE scope = ? ORDER BY character_id',
      ['assets'],
    );
    expect(stateRows).toEqual([
      { character_id: otherId, scope: 'assets' },
      { character_id: CHARACTER_ID, scope: 'assets' },
    ]);
  });
});
