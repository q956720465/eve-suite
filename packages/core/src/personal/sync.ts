import type { DbAdapter } from '../db/types';
import type { EsiClient } from '../esi/client';
import { systemClock, type Clock } from '../esi/clock';
import { fetchAllPages } from '../esi/paging';
import type { RequestScheduler } from '../esi/scheduler';
import { TokenManagerError } from '../esi/token-manager';
import type {
  CharacterAsset,
  CharacterContract,
  CharacterOrder,
  CharacterPublicInfo,
  EsiCacheControl,
  EsiResult,
  IndustryJob,
  LoyaltyPoints,
  MiningObservation,
  WalletJournalEntry,
} from '../esi/types';
import { insertRows } from '../sde/batch';

import {
  ASSET_COLUMNS,
  CONTRACT_COLUMNS,
  JOURNAL_COLUMNS,
  JOURNAL_CONFLICT_UPDATE,
  JOB_COLUMNS,
  LP_COLUMNS,
  MINING_COLUMNS,
  MINING_CONFLICT_UPDATE,
  MY_ORDER_COLUMNS,
  toAssetRow,
  toContractRow,
  toJobRow,
  toJournalRow,
  toLpRow,
  toMiningRow,
  toOrderRow,
} from './rows';
import { PAGED_SCOPES, PERSONAL_SCOPES, type PersonalScope } from './scopes';
import {
  loadPageEtags,
  loadScopeStates,
  markScopeError,
  markScopeOk,
  markScopeStarted,
  savePageEtags,
  type PersonalScopeState,
} from './state';

/** 分页端点的条目联合（仅用于端点分发时的类型收窄） */
type PersonalPageItem =
  | CharacterAsset
  | WalletJournalEntry
  | CharacterOrder
  | CharacterContract
  | IndustryJob
  | MiningObservation
  | LoyaltyPoints;

export interface PersonalSyncerOptions {
  db: DbAdapter;
  client: EsiClient;
  scheduler: RequestScheduler;
  clock?: Clock;
}

/** 单端点结果中由具体同步实现产出的部分 */
type ScopeSyncOutcome = Omit<
  PersonalScopeSyncResult,
  'scope' | 'ok' | 'error' | 'reauthRequired'
>;

export interface SyncScopeOptions {
  /** 忽略 Cache-Control 到期时间强制拉取（手动「立即同步」用） */
  force?: boolean;
}

export type SyncCharacterOptions = SyncScopeOptions;

export interface PersonalScopeSyncResult {
  scope: PersonalScope;
  ok: boolean;
  pages: number;
  requests: number;
  /** 写入行数（合并 upsert 时含覆盖的既有行） */
  itemsWritten: number;
  /** 未写入数据（命中 304 或仍在缓存有效期内） */
  skipped: boolean;
  /** 跳过原因：not-modified = ETag 304；cache = 未到 Cache-Control 到期时间 */
  skippedReason: 'not-modified' | 'cache' | null;
  /** 刷新令牌失效需重新授权（`reauth_required`）；本轮该角色剩余端点已停摆 */
  reauthRequired: boolean;
  error: string | null;
}

export interface PersonalSyncResult {
  characterId: number;
  /** 各端点结果（串行执行，单端点失败不影响其余；遇 reauth_required 则提前终止） */
  scopes: PersonalScopeSyncResult[];
  /** 因刷新令牌失效而中止本轮剩余端点 */
  reauthRequired: boolean;
  /** 公开端点 /characters/{id}/ 的 corporation_id 更新（非关键，失败不阻断） */
  corporationInfo: { ok: boolean; error: string | null };
}

/**
 * 依据响应缓存指令计算到期时间（ISO 8601）。
 *
 * 优先级（RFC 7234）：`no-store` → 不可缓存；`max-age` → 当前时刻 + maxAge；
 * 否则回退到 `Expires` 的绝对时刻。已过期的时刻统一记 null，
 * 视作「立即需要回源」（此时仍靠 ETag 304 省流量）。
 */
export function computeExpiresAt(
  cacheControl: EsiCacheControl | null | undefined,
  nowMs: number,
): string | null {
  if (cacheControl === null || cacheControl === undefined) return null;
  if (cacheControl.noStore) return null;

  let atMs: number | null = null;
  if (cacheControl.maxAgeSeconds !== null) {
    atMs = nowMs + cacheControl.maxAgeSeconds * 1000;
  } else if (cacheControl.expiresAtMs !== null) {
    atMs = cacheControl.expiresAtMs;
  }

  if (atMs === null || atMs <= nowMs) return null;
  return new Date(atMs).toISOString();
}

/** 是否仍在服务端声明的缓存有效期内 */
function isFresh(expiresAt: string | null | undefined, nowMs: number): boolean {
  if (expiresAt === null || expiresAt === undefined) return false;
  const at = Date.parse(expiresAt);
  return Number.isFinite(at) && at > nowMs;
}

/**
 * 个人数据同步器。
 *
 * 写入语义：
 * - 覆盖型（assets / orders / contracts / industry / loyalty）：按角色整体替换
 * - 合并型（wallet_journal 按 entry_id、mining 按复合键）：upsert，历史数据保留
 * - wallet_balance：单请求，写 characters.wallet_balance
 *
 * 错误契约：单端点失败只写该 scope 的 last_error（last_ok_at 不变），其余端点照常执行；
 * 认证类错误（TokenManagerError）在 EsiClient 层已原样穿透，本层只记录消息，不包装。
 */
export class PersonalSyncer {
  private readonly db: DbAdapter;
  private readonly client: EsiClient;
  private readonly scheduler: RequestScheduler;
  private readonly clock: Clock;

  constructor(options: PersonalSyncerOptions) {
    this.db = options.db;
    this.client = options.client;
    this.scheduler = options.scheduler;
    this.clock = options.clock ?? systemClock;
  }

  /** 同步单个角色的全部端点（串行，避免多端点数据同时在内存中叠加） */
  async syncCharacter(
    characterId: number,
    options: SyncCharacterOptions = {},
  ): Promise<PersonalSyncResult> {
    const corporationInfo = await this.syncPublicInfo(characterId);
    const results: PersonalScopeSyncResult[] = [];
    let anyOk = false;
    let reauthRequired = false;
    for (const scope of PERSONAL_SCOPES) {
      const result = await this.syncScope(characterId, scope, options);
      results.push(result);
      if (result.ok) anyOk = true;
      // 刷新令牌失效：不再尝试剩余端点（重试也不会成功），交由调度层提示重新授权
      if (result.reauthRequired) {
        reauthRequired = true;
        break;
      }
    }
    if (anyOk) {
      await this.db
        .execute('UPDATE characters SET last_sync_at = ? WHERE character_id = ?', [
          new Date(this.clock.now()).toISOString(),
          characterId,
        ])
        .catch(() => undefined);
    }
    return { characterId, scopes: results, reauthRequired, corporationInfo };
  }

  /**
   * 同步单个端点（失败隔离：异常只落水位，不向外抛）。
   * 仍在 Cache-Control 有效期内则整轮不发请求（force 可越过）。
   */
  async syncScope(
    characterId: number,
    scope: PersonalScope,
    options: SyncScopeOptions = {},
  ): Promise<PersonalScopeSyncResult> {
    const states = await loadScopeStates(this.db, characterId);
    const state = states.get(scope) ?? null;
    const nowMs = this.clock.now();

    if (options.force !== true && isFresh(state?.expiresAt, nowMs)) {
      return {
        scope,
        ok: true,
        pages: state?.pages ?? 0,
        requests: 0,
        itemsWritten: 0,
        skipped: true,
        skippedReason: 'cache',
        reauthRequired: false,
        error: null,
      };
    }

    await markScopeStarted(this.db, characterId, scope, new Date(nowMs).toISOString());
    try {
      const outcome =
        scope === 'wallet_balance'
          ? await this.syncWalletBalance(characterId, scope, state)
          : await this.syncPagedScope(characterId, scope, state);
      return {
        scope,
        ok: true,
        reauthRequired: false,
        error: null,
        ...outcome,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 只分类不包装（踩坑 #15）：认证错误由 EsiClient 原样抛出，此处仅识别其类型
      const reauthRequired =
        error instanceof TokenManagerError && error.kind === 'reauth_required';
      await markScopeError(this.db, characterId, scope, message).catch(() => undefined);
      return {
        scope,
        ok: false,
        pages: 0,
        requests: 0,
        itemsWritten: 0,
        skipped: false,
        skippedReason: null,
        reauthRequired,
        error: message,
      };
    }
  }

  /** 公开端点：更新 characters.corporation_id（P5 公司资产要用；失败不阻断同步） */
  private async syncPublicInfo(characterId: number): Promise<PersonalSyncResult['corporationInfo']> {
    try {
      const result = await this.runScheduled<CharacterPublicInfo>(() =>
        this.client.fetchCharacterPublicInfo(characterId),
      );
      if (result.data !== null) {
        await this.db
          .execute('UPDATE characters SET corporation_id = ? WHERE character_id = ?', [
            result.data?.corporation_id,
            characterId,
          ])
          .catch(() => undefined);
      }
      return { ok: true, error: null };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // ── wallet_balance（单请求；写 characters 表） ──

  private async syncWalletBalance(
    characterId: number,
    scope: PersonalScope,
    state: PersonalScopeState | null,
  ): Promise<ScopeSyncOutcome> {
    const etag = state?.etag ?? undefined;

    const result = await this.runScheduled<number>(() =>
      this.client.fetchWalletBalance(characterId, { etag }),
    );
    const nowMs = this.clock.now();
    const okAt = new Date(nowMs).toISOString();
    const expiresAt = computeExpiresAt(result.cacheControl, nowMs);

    if (result.notModified) {
      await markScopeOk(this.db, characterId, scope, { pages: 1, expiresAt }, okAt);
      return {
        pages: 1,
        requests: 1,
        itemsWritten: 0,
        skipped: true,
        skippedReason: 'not-modified',
      };
    }

    const balance = result.data;
    if (balance === null || typeof balance !== 'number') {
      throw new Error(`钱包余额响应异常：${JSON.stringify(balance)}`);
    }
    await this.db.execute(
      'UPDATE characters SET wallet_balance = ?, wallet_synced_at = ? WHERE character_id = ?',
      [balance, okAt, characterId],
    );
    await markScopeOk(
      this.db,
      characterId,
      scope,
      { etag: result.etag ?? undefined, pages: 1, expiresAt },
      okAt,
    );
    return {
      pages: 1,
      requests: 1,
      itemsWritten: 1,
      skipped: false,
      skippedReason: null,
    };
  }

  // ── 分页端点（assets / journal / orders / contracts / industry / mining / loyalty） ──

  private async syncPagedScope(
    characterId: number,
    scope: PersonalScope,
    state: PersonalScopeState | null,
  ): Promise<ScopeSyncOutcome> {
    if (!(PAGED_SCOPES as readonly string[]).includes(scope)) {
      throw new Error(`scope ${scope} 不是分页端点`);
    }

    const etags = await loadPageEtags(this.db, characterId, scope);

    const fetched = await fetchAllPages<PersonalPageItem>(
      (page, etag) => this.fetchScopePage(scope, characterId, page, etag),
      { etags, fallbackPages: state?.pages ?? null },
    );
    const nowMs = this.clock.now();
    const fetchedAt = new Date(nowMs).toISOString();
    const expiresAt = computeExpiresAt(fetched.cacheControl, nowMs);

    if (fetched.allNotModified) {
      await markScopeOk(
        this.db,
        characterId,
        scope,
        { pages: fetched.pages, expiresAt },
        fetchedAt,
      );
      return {
        pages: fetched.pages,
        requests: fetched.requests,
        itemsWritten: 0,
        skipped: true,
        skippedReason: 'not-modified',
      };
    }

    const written = await this.writeScope(characterId, scope, fetched.items, fetchedAt);

    await this.db.transaction(async (tx) => {
      await savePageEtags(tx, characterId, scope, fetched.etags, fetchedAt);
      await markScopeOk(tx, characterId, scope, { pages: fetched.pages, expiresAt }, fetchedAt);
    });

    return {
      pages: fetched.pages,
      requests: fetched.requests,
      itemsWritten: written,
      skipped: false,
      skippedReason: null,
    };
  }

  /** 按端点写入：覆盖型整体替换；合并型按主键 upsert */
  private async writeScope(
    characterId: number,
    scope: PersonalScope,
    items: readonly PersonalPageItem[],
    fetchedAt: string,
  ): Promise<number> {
    switch (scope) {
      case 'assets': {
        const rows = items.map((item) => toAssetRow(item as CharacterAsset, characterId, fetchedAt));
        return this.replaceScope(characterId, 'assets', ASSET_COLUMNS, rows);
      }
      case 'orders': {
        const rows = items.map((item) => toOrderRow(item as CharacterOrder, characterId, fetchedAt));
        return this.replaceScope(characterId, 'my_orders', MY_ORDER_COLUMNS, rows);
      }
      case 'contracts': {
        const rows = items.map((item) =>
          toContractRow(item as CharacterContract, characterId, fetchedAt),
        );
        return this.replaceScope(characterId, 'contracts', CONTRACT_COLUMNS, rows);
      }
      case 'industry': {
        const rows = items.map((item) => toJobRow(item as IndustryJob, characterId, fetchedAt));
        return this.replaceScope(characterId, 'industry_jobs', JOB_COLUMNS, rows);
      }
      case 'loyalty': {
        const rows = items.map((item) => toLpRow(item as LoyaltyPoints, characterId, fetchedAt));
        return this.replaceScope(characterId, 'lp_balances', LP_COLUMNS, rows);
      }
      case 'wallet_journal': {
        const rows = items.map((item) =>
          toJournalRow(item as WalletJournalEntry, characterId, fetchedAt),
        );
        return this.db.transaction(async (tx) =>
          insertRows(tx, 'wallet_journal', JOURNAL_COLUMNS, rows, undefined, {
            target: ['character_id', 'entry_id'],
            update: JOURNAL_CONFLICT_UPDATE,
          }),
        );
      }
      case 'mining': {
        const rows = items.map((item) => toMiningRow(item as MiningObservation, characterId, fetchedAt));
        return this.db.transaction(async (tx) =>
          insertRows(tx, 'mining_ledger', MINING_COLUMNS, rows, undefined, {
            target: ['character_id', 'date', 'solar_system_id', 'type_id'],
            update: MINING_CONFLICT_UPDATE,
          }),
        );
      }
      default:
        throw new Error(`scope ${scope} 不支持写入`);
    }
  }

  /** 覆盖型端点：单事务内先删后插（保证读侧永远看到一致快照） */
  private async replaceScope(
    characterId: number,
    table: string,
    columns: readonly string[],
    rows: readonly unknown[][],
  ): Promise<number> {
    return this.db.transaction(async (tx) => {
      await tx.execute(`DELETE FROM ${table} WHERE character_id = ?`, [characterId]);
      return insertRows(tx, table, columns, rows);
    });
  }

  /** 端点分发：绑定对应 client 方法并交给调度器（personal 优先级） */
  private async fetchScopePage(
    scope: PersonalScope,
    characterId: number,
    page: number,
    etag: string | undefined,
  ): Promise<EsiResult<PersonalPageItem[]>> {
    return this.runScheduled<PersonalPageItem[]>(() => {
      switch (scope) {
        case 'assets':
          return this.client.fetchCharacterAssets(characterId, page, { etag });
        case 'wallet_journal':
          return this.client.fetchWalletJournal(characterId, page, { etag });
        case 'orders':
          return this.client.fetchCharacterOrders(characterId, page, { etag });
        case 'contracts':
          return this.client.fetchCharacterContracts(characterId, page, { etag });
        case 'industry':
          return this.client.fetchIndustryJobs(characterId, page, { etag });
        case 'mining':
          return this.client.fetchMiningLedger(characterId, page, { etag });
        case 'loyalty':
          return this.client.fetchLoyaltyPoints(characterId, page, { etag });
        default:
          throw new Error(`scope ${scope} 不是分页端点`);
      }
    });
  }

  /** 统一经调度器下发并回传限流信息 */
  private async runScheduled<T>(run: () => Promise<EsiResult<T>>): Promise<EsiResult<T>> {
    const result = await this.scheduler.run<EsiResult<T>>('personal', run);
    this.scheduler.observe(result.rateLimit, result.errorLimit);
    return result;
  }
}
