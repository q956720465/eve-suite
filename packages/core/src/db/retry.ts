/**
 * 写操作对 SQLite 瞬时锁的容错（踩坑：并发写入偶发 `database is locked`）。
 *
 * 为什么需要：连接池 + 多个写者（行情采集、个人同步、LP 报价、SDE 导入）会争用写锁。
 * 单机 SQLite 的 `busy_timeout`（Rust 侧 10s）只能覆盖「持锁时间短于超时」的情况；
 * 采集器整区替换这类大事务偶尔会超出，此时写语句直接失败、整轮作废。
 *
 * 口径：
 * - **只对幂等的单语句写操作 / 事务开启**做重试（SQLITE_BUSY 时语句并未执行，重试安全）
 * - **事务体内不重试**（一旦某条语句超时，事务语义已不可信，应由调用方整体回滚重来）
 * - 非锁类错误（UNIQUE / FOREIGN KEY / CHECK / 语法错误）**一律不重试**
 */

/** 重试间隔（毫秒）：两次尝试，指数退避 */
export const BUSY_RETRY_DELAYS_MS: readonly number[] = [120, 400];

const TRANSIENT_LOCK_PATTERN =
  /database is locked|database table is locked|SQLITE_BUSY|\(code: 5\)/i;

/** 是否为「瞬时锁」类错误（SQLITE_BUSY / database is locked） */
export function isTransientLockError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return TRANSIENT_LOCK_PATTERN.test(message);
}

/**
 * 执行一次写操作；命中瞬时锁时按 `delays` 退避重试。
 *
 * @param operation 需幂等的写操作（单语句执行 / 事务开启）
 * @param sleep 等待实现（默认 `setTimeout`；测试可注入）
 */
export async function retryOnBusy<T>(
  operation: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  delays: readonly number[] = BUSY_RETRY_DELAYS_MS,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= delays.length || !isTransientLockError(error)) throw error;
      await sleep(delays[attempt]);
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
