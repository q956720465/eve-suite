import type { Clock } from '../../src/esi/clock';

export interface FakeClock extends Clock {
  /** 手动推进时间（毫秒） */
  advance(ms: number): void;
  /** 已发生的等待时长记录（按序） */
  readonly sleeps: number[];
}

/**
 * 假时钟：sleep 立即返回并推进「当前时间」，
 * 使限速与退避逻辑可在测试中瞬间跑完且可断言等待时长。
 */
export function createFakeClock(startAt = 1_000_000): FakeClock {
  let current = startAt;
  const sleeps: number[] = [];

  return {
    now: () => current,
    async sleep(ms: number): Promise<void> {
      sleeps.push(ms);
      current += ms;
      await Promise.resolve();
    },
    advance(ms: number): void {
      current += ms;
    },
    sleeps,
  };
}
