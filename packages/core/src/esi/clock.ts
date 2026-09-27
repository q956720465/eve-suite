/**
 * 时间抽象：限流等待与退避重试依赖时间，
 * 抽象后测试可注入假时钟，避免真实等待拖慢测试。
 */
export interface Clock {
  /** 当前时间戳（毫秒） */
  now(): number;
  /** 等待指定毫秒（可被 signal 取消） */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new Error('等待被取消'));
        return;
      }
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        cleanup();
        reject(new Error('等待被取消'));
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};
