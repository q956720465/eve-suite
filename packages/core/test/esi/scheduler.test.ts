import { describe, expect, it } from 'vitest';

import { RequestScheduler } from '../../src/esi/scheduler';
import { EsiError } from '../../src/esi/types';
import { createFakeClock } from '../helpers/fake-clock';

/** 构造一个不限速、可完全控制的调度器 */
function createScheduler(overrides: Partial<ConstructorParameters<typeof RequestScheduler>[0]> = {}) {
  const clock = createFakeClock();
  const scheduler = new RequestScheduler({
    clock,
    requestsPerSecond: 1000,
    burst: 1000,
    maxConcurrent: 4,
    maxAttempts: 3,
    ...overrides,
  });
  return { clock, scheduler };
}

describe('ESI 请求调度器', () => {
  it('执行任务并返回结果', async () => {
    const { scheduler } = createScheduler();
    await expect(scheduler.run('hub', async () => 42)).resolves.toBe(42);
    expect(scheduler.stats.completed).toBe(1);
  });

  it('按优先级派发：枢纽 > 按需 > 个人 > 全域', async () => {
    const { scheduler } = createScheduler({ maxConcurrent: 1 });
    const order: string[] = [];

    let releaseBlocker: () => void = () => undefined;
    const blocker = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });

    // 先占住唯一并发槽
    const first = scheduler.run('hub', async () => {
      await blocker;
      order.push('blocker');
    });
    // 其余按优先级入队
    const lowPriority = scheduler.run('global', async () => {
      order.push('global');
    });
    const highPriority = scheduler.run('hub', async () => {
      order.push('hub-2');
    });
    const midPriority = scheduler.run('personal', async () => {
      order.push('personal');
    });

    releaseBlocker();
    await Promise.all([first, lowPriority, highPriority, midPriority]);

    expect(order).toEqual(['blocker', 'hub-2', 'personal', 'global']);
  });

  it('并发上限：同时执行数不超过配置', async () => {
    const { scheduler } = createScheduler({ maxConcurrent: 2 });
    let active = 0;
    let maxActive = 0;

    const tasks = Array.from({ length: 6 }, () =>
      scheduler.run('hub', async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
      }),
    );

    await Promise.all(tasks);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(scheduler.stats.completed).toBe(6);
  });

  it('令牌桶限速：超出突发量后需要等待', async () => {
    const { clock, scheduler } = createScheduler({
      requestsPerSecond: 1,
      burst: 1,
      maxConcurrent: 4,
    });

    await Promise.all([1, 2, 3].map(() => scheduler.run('hub', async () => undefined)));

    // 首个任务用掉唯一令牌，后两个各需等待约 1 秒
    expect(clock.sleeps.filter((ms) => ms >= 900).length).toBeGreaterThanOrEqual(2);
  });

  it('可重试错误：退避后重试直至成功', async () => {
    const { scheduler } = createScheduler();
    let calls = 0;

    const result = await scheduler.run('hub', async () => {
      calls += 1;
      if (calls < 3) throw new EsiError('network', null, '连接中断');
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(scheduler.stats.retries).toBe(2);
  });

  it('429 带 Retry-After：按服务端建议时长等待', async () => {
    const { clock, scheduler } = createScheduler();
    let calls = 0;

    await scheduler.run('hub', async () => {
      calls += 1;
      if (calls === 1) throw new EsiError('throttled', 429, '稍后再试', 7);
      return 'ok';
    });

    expect(clock.sleeps).toContain(7000);
  });

  it('不可重试错误：立即失败', async () => {
    const { scheduler } = createScheduler();
    let calls = 0;

    await expect(
      scheduler.run('hub', async () => {
        calls += 1;
        throw new EsiError('client', 404, '物品不存在');
      }),
    ).rejects.toThrow('物品不存在');

    expect(calls).toBe(1);
  });

  it('超过最大尝试次数：失败并停止重试', async () => {
    const { scheduler } = createScheduler({ maxAttempts: 2 });
    let calls = 0;

    await expect(
      scheduler.run('hub', async () => {
        calls += 1;
        throw new EsiError('network', null, '仍然失败');
      }),
    ).rejects.toThrow('仍然失败');

    expect(calls).toBe(2);
  });

  it('暂停与恢复：暂停期间不派发任务', async () => {
    const { scheduler } = createScheduler();
    scheduler.pause();

    let ran = false;
    const pending = scheduler.run('hub', async () => {
      ran = true;
      return 'done';
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(ran).toBe(false);
    expect(scheduler.stats.queued).toBe(1);

    scheduler.resume();
    await expect(pending).resolves.toBe('done');
    expect(scheduler.paused).toBe(false);
  });

  it('错误预算自适应：预算偏低降速，耗尽几乎停摆，恢复后回到基础速率', async () => {
    const { scheduler } = createScheduler({ requestsPerSecond: 10, lowErrorBudget: 20 });

    scheduler.observe(null, { remain: 5, reset: 60 });
    expect(scheduler.stats.currentRate).toBeCloseTo(2.5);

    scheduler.observe(null, { remain: 0, reset: 60 });
    expect(scheduler.stats.currentRate).toBeCloseTo(0.5);

    scheduler.observe(null, { remain: 100, reset: 60 });
    expect(scheduler.stats.currentRate).toBe(10);
  });

  it('统计信息：按优先级展示排队数', async () => {
    const { scheduler } = createScheduler({ maxConcurrent: 1 });
    let release: () => void = () => undefined;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });

    const running = scheduler.run('hub', async () => {
      await blocker;
    });
    const a = scheduler.run('ondemand', async () => undefined);
    const b = scheduler.run('global', async () => undefined);
    const c = scheduler.run('global', async () => undefined);

    await Promise.resolve();
    const stats = scheduler.stats;
    expect(stats.running).toBe(1);
    expect(stats.queued).toBe(3);
    expect(stats.pendingByPriority.ondemand).toBe(1);
    expect(stats.pendingByPriority.global).toBe(2);

    release();
    await Promise.all([running, a, b, c]);
  });
});
