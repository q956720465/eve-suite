import { systemClock, type Clock } from './clock';
import { EsiError, type EsiErrorLimit, type EsiRateLimit } from './types';

/** 请求优先级：枢纽层 > 按需 > 个人数据 > 全域层 */
export type RequestPriority = 'hub' | 'ondemand' | 'personal' | 'global';

const PRIORITY_ORDER: Record<RequestPriority, number> = {
  hub: 0,
  ondemand: 1,
  personal: 2,
  global: 3,
};

export interface QueueStats {
  /** 排队中的任务数 */
  queued: number;
  /** 执行中的任务数 */
  running: number;
  pendingByPriority: Record<RequestPriority, number>;
  completed: number;
  retries: number;
  /** 当前生效速率（请求/秒） */
  currentRate: number;
  paused: boolean;
}

export interface SchedulerOptions {
  /** 时间源（测试注入假时钟） */
  clock?: Clock;
  /** 基础速率（请求/秒）；ESI market-order 组上限为 12000/15m ≈ 13.3/s，默认取保守值 */
  requestsPerSecond?: number;
  /** 令牌桶容量（允许的突发量） */
  burst?: number;
  /** 并发上限 */
  maxConcurrent?: number;
  /** 单任务最大尝试次数（含首次） */
  maxAttempts?: number;
  /** 错误预算低于该值时降速 */
  lowErrorBudget?: number;
  /** 每次请求后回传配额信息（供 UI 展示） */
  onObserve?: (rateLimit: EsiRateLimit | null, errorLimit: EsiErrorLimit | null) => void;
  /** 重试通知（诊断用） */
  onRetry?: (error: EsiError, attempt: number, delayMs: number) => void;
}

interface QueuedTask {
  priority: RequestPriority;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  sequence: number;
}

/**
 * ESI 请求调度器：全局单例使用。
 * 负责「优先级排队 → 令牌桶限速 → 并发控制 → 失败退避重试」，
 * 并根据响应携带的错误预算自适应降速（预算接近耗尽时几乎停摆）。
 */
export class RequestScheduler {
  private readonly clock: Clock;
  private readonly baseRate: number;
  private readonly burst: number;
  private readonly maxConcurrent: number;
  private readonly maxAttempts: number;
  private readonly lowErrorBudget: number;
  private readonly onObserve: SchedulerOptions['onObserve'];
  private readonly onRetry: SchedulerOptions['onRetry'];

  private readonly queue: QueuedTask[] = [];
  private sequence = 0;
  private running = 0;
  private completed = 0;
  private retries = 0;

  private tokens: number;
  private lastRefillAt: number;
  private rate: number;
  private isPaused = false;
  private waitingForToken = false;

  constructor(options: SchedulerOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.baseRate = options.requestsPerSecond ?? 10;
    this.burst = options.burst ?? 20;
    this.maxConcurrent = options.maxConcurrent ?? 4;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.lowErrorBudget = options.lowErrorBudget ?? 20;
    this.onObserve = options.onObserve;
    this.onRetry = options.onRetry;

    this.rate = this.baseRate;
    this.tokens = this.burst;
    this.lastRefillAt = this.clock.now();
  }

  /** 提交任务：按优先级排队执行，失败按策略重试 */
  run<T>(priority: RequestPriority, run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.sequence += 1;
      this.queue.push({
        priority,
        run: run as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
        sequence: this.sequence,
      });
      this.queue.sort(compareTasks);
      this.pump();
    });
  }

  /** 根据响应配额信息自适应调整速率 */
  observe(rateLimit: EsiRateLimit | null, errorLimit: EsiErrorLimit | null): void {
    this.onObserve?.(rateLimit, errorLimit);
    if (errorLimit === null) return;

    if (errorLimit.remain <= 0) {
      // 预算耗尽：几乎停摆，等待服务端重置
      this.setRate(this.baseRate * 0.05);
      return;
    }
    if (errorLimit.remain < this.lowErrorBudget) {
      this.setRate(this.baseRate * 0.25);
      return;
    }
    this.setRate(this.baseRate);
  }

  /** 用户级暂停（如计量网络模式） */
  pause(): void {
    this.isPaused = true;
  }

  resume(): void {
    if (!this.isPaused) return;
    this.isPaused = false;
    this.pump();
  }

  get paused(): boolean {
    return this.isPaused;
  }

  get stats(): QueueStats {
    const pendingByPriority: Record<RequestPriority, number> = {
      hub: 0,
      ondemand: 0,
      personal: 0,
      global: 0,
    };
    for (const task of this.queue) {
      pendingByPriority[task.priority] += 1;
    }
    return {
      queued: this.queue.length,
      running: this.running,
      pendingByPriority,
      completed: this.completed,
      retries: this.retries,
      currentRate: this.rate,
      paused: this.isPaused,
    };
  }

  private setRate(rate: number): void {
    const next = Math.max(0.1, rate);
    if (next === this.rate) return;
    this.refillTokens();
    this.rate = next;
  }

  private refillTokens(): void {
    const now = this.clock.now();
    const elapsedSeconds = Math.max(0, (now - this.lastRefillAt) / 1000);
    if (elapsedSeconds <= 0) return;
    this.tokens = Math.min(this.burst, this.tokens + elapsedSeconds * this.rate);
    this.lastRefillAt = now;
  }

  private tryConsumeToken(): boolean {
    this.refillTokens();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  private pump(): void {
    if (this.isPaused) return;

    while (this.running < this.maxConcurrent && this.queue.length > 0) {
      if (!this.tryConsumeToken()) {
        this.waitForToken();
        return;
      }
      const task = this.queue.shift();
      if (task === undefined) return;
      this.running += 1;
      void this.execute(task).finally(() => {
        this.running -= 1;
        this.completed += 1;
        this.pump();
      });
    }
  }

  /** 等待下一个令牌可用后继续派发 */
  private waitForToken(): void {
    if (this.waitingForToken) return;
    this.waitingForToken = true;
    const deficit = Math.max(0, 1 - this.tokens);
    const waitMs = Math.max(1, Math.ceil((deficit / this.rate) * 1000));
    void this.clock
      .sleep(waitMs)
      .catch(() => undefined)
      .then(() => {
        this.waitingForToken = false;
        this.pump();
      });
  }

  private async execute(task: QueuedTask): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        task.resolve(await task.run());
        return;
      } catch (error) {
        const retryable = error instanceof EsiError && error.retryable;
        if (!retryable || attempt >= this.maxAttempts) {
          task.reject(error);
          return;
        }
        const esiError = error as EsiError;
        const delayMs =
          esiError.retryAfterSeconds !== undefined
            ? esiError.retryAfterSeconds * 1000
            : this.backoffMs(attempt);
        this.retries += 1;
        this.onRetry?.(esiError, attempt, delayMs);
        await this.clock.sleep(delayMs).catch(() => undefined);
      }
    }
  }

  /** 指数退避（带抖动），上限 30 秒 */
  private backoffMs(attempt: number): number {
    const base = Math.min(30_000, 1000 * 2 ** (attempt - 1));
    return base + Math.floor(base * 0.1 * Math.random());
  }
}

function compareTasks(a: QueuedTask, b: QueuedTask): number {
  const byPriority = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
  return byPriority !== 0 ? byPriority : a.sequence - b.sequence;
}
