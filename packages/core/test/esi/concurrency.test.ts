import { describe, expect, it } from 'vitest';

import { PAGE_FETCH_CONCURRENCY, mapWithLimit } from '../../src/esi/concurrency';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('有界并发映射（B1 分页扇出）', () => {
  it('结果与输入同序（即使完成顺序相反）', async () => {
    const out = await mapWithLimit([30, 10, 20], 3, async (ms) => {
      await sleep(ms);
      return `#${ms}`;
    });
    expect(out).toEqual(['#30', '#10', '#20']);
  });

  it('在途任务数不超过 limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithLimit(Array.from({ length: 12 }, (_, index) => index), 3, async (index) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await sleep(5);
      inFlight -= 1;
      return index;
    });
    expect(peak).toBe(3);
  });

  it('一批完成后才启动下一批（有界扇出的核心断言）', async () => {
    const gate: Array<() => void> = [];
    const started: number[] = [];
    const task = mapWithLimit([1, 2, 3, 4, 5], 2, async (value) => {
      started.push(value);
      await new Promise<void>((resolve) => gate.push(resolve));
      return value;
    });

    const releaseBatch = async () => {
      for (const release of gate.splice(0)) release();
      await sleep(1);
    };

    await sleep(1);
    expect(started).toEqual([1, 2]);
    await releaseBatch();
    expect(started).toEqual([1, 2, 3, 4]);
    await releaseBatch();
    expect(started).toEqual([1, 2, 3, 4, 5]);
    await releaseBatch();
    await expect(task).resolves.toEqual([1, 2, 3, 4, 5]);
  });

  it('空输入返回空数组且不调用处理函数', async () => {
    let calls = 0;
    const out = await mapWithLimit([], 4, async () => {
      calls += 1;
      return 1;
    });
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });

  it('limit 非正数按 1 处理（退化为顺序执行）', async () => {
    const order: number[] = [];
    const out = await mapWithLimit([1, 2, 3], 0, async (value) => {
      order.push(value);
      await sleep(1);
      return value * 2;
    });
    expect(out).toEqual([2, 4, 6]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('limit 大于输入长度时全部并发且结果同序', async () => {
    const out = await mapWithLimit([1, 2], 100, async (value) => value);
    expect(out).toEqual([1, 2]);
  });

  it('处理函数抛出时整体 reject（与 Promise.all 语义一致）', async () => {
    await expect(
      mapWithLimit([1, 2, 3, 4], 2, async (value) => {
        if (value === 3) throw new Error('boom-3');
        await sleep(1);
        return value;
      }),
    ).rejects.toThrow('boom-3');
  });

  it('默认窗口是可用的小整数（防止被误调成大并发）', () => {
    expect(Number.isInteger(PAGE_FETCH_CONCURRENCY)).toBe(true);
    expect(PAGE_FETCH_CONCURRENCY).toBeGreaterThanOrEqual(1);
    expect(PAGE_FETCH_CONCURRENCY).toBeLessThanOrEqual(8);
  });
});
