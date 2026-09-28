import { describe, expect, it, vi } from 'vitest';

import { BUSY_RETRY_DELAYS_MS, isTransientLockError, retryOnBusy } from '../../src/db/retry';

describe('写操作瞬时锁容错', () => {
  it('识别瞬时锁错误（SQLITE_BUSY / database is locked / code: 5）', () => {
    expect(isTransientLockError(new Error('database is locked'))).toBe(true);
    expect(
      isTransientLockError(
        new Error('执行失败：error returned from database: (code: 5) database is locked'),
      ),
    ).toBe(true);
    expect(isTransientLockError('database table is locked: market_orders')).toBe(true);
    expect(isTransientLockError(new Error('SQLITE_BUSY'))).toBe(true);
  });

  it('非锁类错误不重试（UNIQUE / 语法错误原样抛出）', () => {
    expect(
      isTransientLockError(
        new Error('执行失败：error returned from database: (code: 1555) UNIQUE constraint failed'),
      ),
    ).toBe(false);
    expect(isTransientLockError(new Error('near "limit": syntax error'))).toBe(false);
  });

  it('命中瞬时锁时按退避重试并在成功后返回', async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    let calls = 0;
    const result = await retryOnBusy(
      async () => {
        calls += 1;
        if (calls <= 2) throw new Error('database is locked');
        return 'done';
      },
      sleep,
    );

    expect(result).toBe('done');
    expect(calls).toBe(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([...BUSY_RETRY_DELAYS_MS]);
  });

  it('重试次数用尽后抛出最后一次错误', async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    let calls = 0;
    await expect(
      retryOnBusy(async () => {
        calls += 1;
        throw new Error('database is locked');
      }, sleep),
    ).rejects.toThrow('database is locked');

    expect(calls).toBe(BUSY_RETRY_DELAYS_MS.length + 1);
  });

  it('非锁类错误立即抛出且不睡眠', async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    let calls = 0;
    await expect(
      retryOnBusy(async () => {
        calls += 1;
        throw new Error('UNIQUE constraint failed: market_orders.order_id');
      }, sleep),
    ).rejects.toThrow('UNIQUE constraint failed');

    expect(calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
