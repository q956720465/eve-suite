import { systemClock, type Clock } from '../esi/clock';

import type { PersonalScopeSyncResult, PersonalSyncer } from './sync';

/** 默认同步周期（方案 §4.2「个人数据 15–30 分钟」取中位） */
export const DEFAULT_PERSONAL_SYNC_INTERVAL_MS = 20 * 60_000;

/** 定时器句柄（浏览器为 number，Node 为 Timeout，故用 unknown） */
export type TimerHandle = unknown;
/** 定时器工厂：默认 setInterval，测试注入手动触发器以获得确定性 */
export type TimerFactory = (callback: () => void, ms: number) => TimerHandle;
export type TimerClearer = (handle: TimerHandle) => void;

const defaultSetTimer: TimerFactory = (callback, ms) => setInterval(callback, ms);
const defaultClearTimer: TimerClearer = (handle) => {
  clearInterval(handle as ReturnType<typeof setInterval>);
};

export interface PersonalSyncSchedulerOptions {
  syncer: PersonalSyncer;
  /** 每轮读取已授权角色 ID：不缓存，避免授权/登出后清单陈旧 */
  listCharacterIds: () => Promise<number[]>;
  clock?: Clock;
  intervalMs?: number;
  setTimer?: TimerFactory;
  clearTimer?: TimerClearer;
  onRoundStart?: (characterIds: number[]) => void;
  onScopeResult?: (characterId: number, result: PersonalScopeSyncResult) => void;
  onRoundComplete?: (summary: PersonalSyncRoundSummary) => void;
  /**
   * 刷新令牌失效需用户重新授权。该角色在 `clearReauthBlock` 之前不再自动同步
   * （重试不可能成功，且每轮都打令牌端点没有意义）。
   */
  onReauthRequired?: (characterId: number, message: string) => void;
}

export interface PersonalSyncRoundSummary {
  startedAt: string;
  finishedAt: string;
  /** 本轮实际同步的角色 */
  syncedCharacters: number[];
  /** 因待重新授权被跳过（停摆）的角色 */
  blockedCharacters: number[];
  /** 本轮新判定需重新授权的角色 */
  reauthCharacters: number[];
  /** 失败端点数 */
  failedScopes: number;
  /** 因 Cache-Control 未到期而跳过的端点数 */
  cachedScopes: number;
  itemsWritten: number;
  scopeResults: Array<{ characterId: number; results: PersonalScopeSyncResult[] }>;
}

/**
 * 个人数据同步调度器（core 层，纯逻辑可测；UI 生命周期钩子归 P3-7）。
 *
 * 行为：
 * - `start()` 立即同步一轮，其后按 `intervalMs` 周期触发
 * - **单飞**：上一轮未结束时复用其 Promise，不叠加轮次
 * - `pause()` / `resume()`：计量网络 / 电池模式（方案 §4.4）；恢复时立即补一轮
 * - **停摆**：遇 `reauth_required` 记录并停止该角色的后续轮次，直到 `clearReauthBlock`
 *
 * 限流由各端点请求经 `RequestScheduler`（personal 优先级）统一排队，本类不另行限速。
 */
export class PersonalSyncScheduler {
  private readonly syncer: PersonalSyncer;
  private readonly listCharacterIds: () => Promise<number[]>;
  private readonly clock: Clock;
  private readonly intervalMs: number;
  private readonly setTimer: TimerFactory;
  private readonly clearTimer: TimerClearer;
  private readonly onRoundStart: PersonalSyncSchedulerOptions['onRoundStart'];
  private readonly onScopeResult: PersonalSyncSchedulerOptions['onScopeResult'];
  private readonly onRoundComplete: PersonalSyncSchedulerOptions['onRoundComplete'];
  private readonly onReauthRequired: PersonalSyncSchedulerOptions['onReauthRequired'];

  private readonly reauthBlocked = new Set<number>();
  private timer: TimerHandle = null;
  private running = false;
  private paused = false;
  private inFlight: Promise<PersonalSyncRoundSummary> | null = null;

  constructor(options: PersonalSyncSchedulerOptions) {
    this.syncer = options.syncer;
    this.listCharacterIds = options.listCharacterIds;
    this.clock = options.clock ?? systemClock;
    this.intervalMs = options.intervalMs ?? DEFAULT_PERSONAL_SYNC_INTERVAL_MS;
    this.setTimer = options.setTimer ?? defaultSetTimer;
    this.clearTimer = options.clearTimer ?? defaultClearTimer;
    this.onRoundStart = options.onRoundStart;
    this.onScopeResult = options.onScopeResult;
    this.onRoundComplete = options.onRoundComplete;
    this.onReauthRequired = options.onReauthRequired;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get isSyncing(): boolean {
    return this.inFlight !== null;
  }

  /** 当前处于停摆（待重新授权）的角色 */
  get blockedCharacters(): number[] {
    return [...this.reauthBlocked];
  }

  /** 启动调度：立即同步一轮 + 周期触发（重复调用无副作用） */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    void this.runOnce();
    this.timer = this.setTimer(() => {
      if (!this.running || this.paused) return;
      void this.runOnce();
    }, this.intervalMs);
  }

  /** 停止调度并释放定时器（在途的一轮让其自然结束） */
  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  pause(): void {
    this.paused = true;
  }

  /** 恢复并立即补一轮（不等下个周期） */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (this.running) void this.runOnce();
  }

  /** 用户重新授权后解除停摆；不传角色则解除全部 */
  clearReauthBlock(characterId?: number): void {
    if (characterId === undefined) this.reauthBlocked.clear();
    else this.reauthBlocked.delete(characterId);
  }

  /** 执行一轮（单飞：已有在途轮次时复用其 Promise） */
  runOnce(): Promise<PersonalSyncRoundSummary> {
    if (this.inFlight !== null) return this.inFlight;
    const round = this.runRound().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = round;
    return round;
  }

  private async runRound(): Promise<PersonalSyncRoundSummary> {
    const startedAt = new Date(this.clock.now()).toISOString();
    const characterIds = await this.listCharacterIds();
    this.onRoundStart?.(characterIds);

    const summary: PersonalSyncRoundSummary = {
      startedAt,
      finishedAt: startedAt,
      syncedCharacters: [],
      blockedCharacters: [],
      reauthCharacters: [],
      failedScopes: 0,
      cachedScopes: 0,
      itemsWritten: 0,
      scopeResults: [],
    };

    for (const characterId of characterIds) {
      if (this.reauthBlocked.has(characterId)) {
        summary.blockedCharacters.push(characterId);
        continue;
      }

      const result = await this.syncer.syncCharacter(characterId);
      summary.syncedCharacters.push(characterId);
      summary.scopeResults.push({ characterId, results: result.scopes });

      for (const scopeResult of result.scopes) {
        if (!scopeResult.ok) summary.failedScopes += 1;
        if (scopeResult.skippedReason === 'cache') summary.cachedScopes += 1;
        summary.itemsWritten += scopeResult.itemsWritten;
        this.onScopeResult?.(characterId, scopeResult);
      }

      if (result.reauthRequired) {
        const failure = result.scopes.find((scopeResult) => scopeResult.reauthRequired);
        this.reauthBlocked.add(characterId);
        summary.reauthCharacters.push(characterId);
        this.onReauthRequired?.(characterId, failure?.error ?? '刷新令牌已失效，需要重新授权');
      }
    }

    summary.finishedAt = new Date(this.clock.now()).toISOString();
    this.onRoundComplete?.(summary);
    return summary;
  }
}
