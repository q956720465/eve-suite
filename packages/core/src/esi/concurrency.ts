/**
 * 有界并发映射（结果保持输入顺序）。
 *
 * 为什么需要它：采集体量最大的三个管道（枢纽分页 / 全域分页 / `fetchAllPages`）
 * 原先都用 `Promise.all` **一次性**把「一个区的全部页」入队 —— 枢纽一个区可达 **404 页**
 * （单页 orders 响应实测 ≈237 KB，合计 ≈96 MB 同时驻留内存）。这带来两个连锁问题：
 *
 * 1. **内存/GC 峰值随页数线性增长**（页面越大越明显）；
 * 2. 共享 `RequestScheduler` 按**严格优先级**派发（`hub` > `ondemand` > `personal` > `global`），
 *    一次入队数百个 `hub` 任务会让队列**长期非空** → 其它管道（历史初始化 / 全域 / 个人同步）
 *    **拿不到派发**（实测：共存期初始化掉到 0.5 pair/s）。改成滑窗后队列深度 ≤ limit。
 *
 * 语义与 `Promise.all` 一致：第一个失败即 reject（其余在途任务不取消，与原先行为相同），
 * 成功时结果为**输入顺序**。
 */

/** 分页拉取的默认并发窗口（页数 × 单页响应体会同时驻留，故不宜过大） */
export const PAGE_FETCH_CONCURRENCY = 6;

/**
 * 以最多 `limit` 路的并发对 `items` 依次执行 `fn`，返回与输入同序的结果数组。
 *
 * @param items 待处理项（只读，不会被修改）
 * @param limit 并发上限（≤ 0 或非整数时按 1 处理）
 * @param fn 单项处理（真正并发的是它的 `await` 部分）
 */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const size = Math.max(1, Math.floor(limit));
  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, () => worker()),
  );
  return results;
}
