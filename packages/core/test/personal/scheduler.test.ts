import { describe, expect, it } from 'vitest';

import { systemClock } from '../../src/esi/clock';
import { PersonalSyncScheduler, type TimerHandle } from '../../src/personal/scheduler';
import type {
  PersonalScopeSyncResult,
  PersonalSyncResult,
  PersonalSyncer,
} from '../../src/personal/sync';

/** 手动定时器：测试中显式 `fire()` 触发周期回调，避免真实计时器带来的不确定性 */
function createManualTimer() {
  const callbacks: Array<() => void> = [];
  let lastMs = -1;
  return {
    setTimer: (callback: () => void, ms: number): TimerHandle => {
      lastMs = ms;
      callbacks.push(callback);
      return callbacks.length - 1;
    },
    clearTimer: (handle: TimerHandle): void => {
      callbacks[handle as number] = () => undefined;
    },
    fire(): void {
      for (const callback of [...callbacks]) callback();
    },
    get intervalMs(): number {
      return lastMs;
    },
  };
}

function scopeResult(overrides: Partial<PersonalScopeSyncResult> = {}): PersonalScopeSyncResult {
  return {
    scope: 'assets',
    ok: true,
    pages: 1,
    requests: 1,
    itemsWritten: 0,
    skipped: false,
    skippedReason: null,
    reauthRequired: false,
    error: null,
    ...overrides,
  };
}

/** 桩同步器：只实现调度层用到的 syncCharacter，便于精确控制返回值 */
function createStubSyncer(
  handler: (characterId: number) => Promise<Partial<PersonalSyncResult>> | Partial<PersonalSyncResult>,
) {
  const calls: number[] = [];
  const syncer = {
    async syncCharacter(characterId: number): Promise<PersonalSyncResult> {
      calls.push(characterId);
      const patch = await handler(characterId);
      return {
        characterId,
        scopes: [],
        reauthRequired: false,
        corporationInfo: { ok: true, error: null },
        ...patch,
      };
    },
  } as unknown as PersonalSyncer;
  return { syncer, calls };
}

/** 让已排入微任务队列的异步轮次推进到下一个可观测点 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('PersonalSyncScheduler', () => {
  it('启动即同步一轮，并按注入周期注册定时器', async () => {
    const timer = createManualTimer();
    const { syncer, calls } = createStubSyncer(() => ({ scopes: [scopeResult()] }));
    const scheduler = new PersonalSyncScheduler({
      syncer,
      listCharacterIds: async () => [1],
      clock: systemClock,
      intervalMs: 1234,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    scheduler.start();

    expect(scheduler.isRunning).toBe(true);
    expect(timer.intervalMs).toBe(1234);
    expect(scheduler.isSyncing).toBe(true);

    await scheduler.runOnce(); // 复用在途轮次
    expect(calls).toEqual([1]);

    timer.fire();
    await flush();
    expect(calls).toEqual([1, 1]);

    scheduler.stop();
    expect(scheduler.isRunning).toBe(false);

    calls.length = 0;
    timer.fire(); // 定时器已释放
    await flush();
    expect(calls).toEqual([]);
  });

  it('单飞：上一轮未结束时周期触发不叠加轮次', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const timer = createManualTimer();
    const { syncer, calls } = createStubSyncer(async () => {
      await gate;
      return { scopes: [scopeResult()] };
    });
    const scheduler = new PersonalSyncScheduler({
      syncer,
      listCharacterIds: async () => [1],
      intervalMs: 10,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    scheduler.start();
    timer.fire();
    timer.fire();
    await flush();

    expect(calls).toEqual([1]);

    release();
    await scheduler.runOnce();
    timer.fire();
    await flush();
    expect(calls).toEqual([1, 1]);

    scheduler.stop();
  });

  it('pause 期间不触发，resume 立即补一轮', async () => {
    const timer = createManualTimer();
    const { syncer, calls } = createStubSyncer(() => ({ scopes: [scopeResult()] }));
    const scheduler = new PersonalSyncScheduler({
      syncer,
      listCharacterIds: async () => [1],
      intervalMs: 10,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    scheduler.start();
    await scheduler.runOnce();
    expect(calls).toEqual([1]);

    scheduler.pause();
    expect(scheduler.isPaused).toBe(true);
    timer.fire();
    await flush();
    expect(calls).toEqual([1]);

    scheduler.resume();
    expect(scheduler.isPaused).toBe(false);
    await flush();
    expect(calls).toEqual([1, 1]);

    scheduler.stop();
  });

  it('reauth_required：该角色停摆、其它角色不受影响，回调与汇总均记录', async () => {
    const reauthEvents: Array<[number, string]> = [];
    const { syncer, calls } = createStubSyncer((characterId) =>
      characterId === 1
        ? {
            scopes: [
              scopeResult({
                scope: 'assets',
                ok: false,
                reauthRequired: true,
                error: '刷新令牌已失效，需要重新授权',
              }),
            ],
            reauthRequired: true,
          }
        : { scopes: [scopeResult()] },
    );
    const scheduler = new PersonalSyncScheduler({
      syncer,
      listCharacterIds: async () => [1, 2],
      onReauthRequired: (characterId, message) => reauthEvents.push([characterId, message]),
    });

    const first = await scheduler.runOnce();

    expect(first.syncedCharacters).toEqual([1, 2]);
    expect(first.reauthCharacters).toEqual([1]);
    expect(first.failedScopes).toBe(1);
    expect(reauthEvents).toEqual([[1, '刷新令牌已失效，需要重新授权']]);
    expect(scheduler.blockedCharacters).toEqual([1]);

    // 次轮：角色 1 被停摆跳过，角色 2 照常
    calls.length = 0;
    const second = await scheduler.runOnce();

    expect(calls).toEqual([2]);
    expect(second.blockedCharacters).toEqual([1]);
    expect(second.syncedCharacters).toEqual([2]);

    // 重新授权后解除停摆
    scheduler.clearReauthBlock(1);
    calls.length = 0;
    await scheduler.runOnce();
    expect(calls).toEqual([1, 2]);
  });

  it('汇总统计端点的失败数、缓存跳过数与写入行数', async () => {
    const timer = createManualTimer();
    const { syncer } = createStubSyncer(() => ({
      scopes: [
        scopeResult({ scope: 'assets', itemsWritten: 10 }),
        scopeResult({ scope: 'orders', skipped: true, skippedReason: 'cache', requests: 0 }),
        scopeResult({ scope: 'mining', ok: false, error: 'HTTP 500' }),
      ],
    }));
    const scheduler = new PersonalSyncScheduler({
      syncer,
      listCharacterIds: async () => [1],
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    const summary = await scheduler.runOnce();

    expect(summary.itemsWritten).toBe(10);
    expect(summary.cachedScopes).toBe(1);
    expect(summary.failedScopes).toBe(1);
    expect(summary.scopeResults).toHaveLength(1);
    expect(summary.scopeResults[0].results).toHaveLength(3);
  });
});
