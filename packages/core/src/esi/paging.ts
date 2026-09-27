import type { EsiResult } from './types';

/**
 * 取单页：由调用方注入端点绑定与调度（页码从 1 起）。
 * `etag` 为该页上次缓存的 ETag；`undefined` 表示无条件请求（skipEtag 强制重取时传 undefined）。
 * `T` 为条目类型，单页数据为 `T[]`。
 */
export type PageFetcher<T> = (page: number, etag: string | undefined) => Promise<EsiResult<T[]>>;

export interface FetchAllPagesOptions {
  /** 各页上次缓存的 ETag（页码 → ETag），无缓存的页以无条件请求 */
  etags?: ReadonlyMap<number, string>;
  /** 首页 304 且回退时使用的页数（水位表 pages）；无记录时视为 1 */
  fallbackPages?: number | null;
}

export interface FetchAllPagesResult<T> {
  /** 全部页合并后的数据（allNotModified 时为空数组） */
  items: T[];
  /** 本轮确认的总页数（调用方写回水位） */
  pages: number;
  requests: number;
  notModifiedPages: number;
  /** 全部页命中 304（数据未变化，调用方可跳过写入） */
  allNotModified: boolean;
  /** 本轮各页 ETag（含 304 回显），供回写缓存 */
  etags: Map<number, string>;
}

/**
 * 分页拉取全部数据（与 P2 MarketCollector 等价的共享实现，P2 将来复用时另行重构）。
 *
 * 流程：首页确定 X-Pages（304 时回退水位页数）→ 并发拉取其余页（带 ETag）
 * → 全部 304 则返回 allNotModified；部分 304 时对缺页无条件重取补齐。
 */
export async function fetchAllPages<T>(
  fetchPage: PageFetcher<T>,
  options: FetchAllPagesOptions = {},
): Promise<FetchAllPagesResult<T>> {
  const cached = options.etags ?? new Map<number, string>();
  const etagUpdates = new Map<number, string>();
  let requests = 0;
  let notModifiedPages = 0;

  const fetch = async (page: number, useEtag: boolean): Promise<EsiResult<T[]>> => {
    const result = await fetchPage(page, useEtag ? cached.get(page) : undefined);
    requests += 1;
    return result;
  };

  // 首页用于确定总页数。注意：304 响应不携带 X-Pages，此时回退水位页数
  // （页数变化必然导致首页内容变化，因此不会出现「首页 304 但页数已变」的情况）。
  const first = await fetch(1, true);
  if (first.etag !== null) etagUpdates.set(1, first.etag);
  const totalPages =
    first.pages !== null
      ? Math.max(1, first.pages)
      : Math.max(1, options.fallbackPages ?? 1);

  const pages: (T[] | null)[] = new Array<T[] | null>(totalPages).fill(null);
  pages[0] = first.notModified ? null : (first.data ?? []);
  if (first.notModified) notModifiedPages += 1;

  if (totalPages > 1) {
    const rest = await Promise.all(
      Array.from({ length: totalPages - 1 }, (_, index) => index + 2).map(async (page) => ({
        page,
        result: await fetch(page, true),
      })),
    );
    for (const { page, result } of rest) {
      pages[page - 1] = result.notModified ? null : (result.data ?? []);
      if (result.notModified) notModifiedPages += 1;
      if (result.etag !== null) etagUpdates.set(page, result.etag);
    }
  }

  if (notModifiedPages === totalPages) {
    return {
      items: [],
      pages: totalPages,
      requests,
      notModifiedPages,
      allNotModified: true,
      etags: etagUpdates,
    };
  }

  // 部分页命中 304 时需要完整数据：对这些页无条件下重新拉取
  const refillPages = pages
    .map((page, index) => (page === null ? index + 1 : 0))
    .filter((page) => page > 0);
  for (const page of refillPages) {
    const result = await fetch(page, false);
    pages[page - 1] = result.data ?? [];
    if (result.etag !== null) etagUpdates.set(page, result.etag);
  }

  const items: T[] = [];
  for (const page of pages) {
    if (page !== null) items.push(...page);
  }

  return {
    items,
    pages: totalPages,
    requests,
    notModifiedPages,
    allNotModified: false,
    etags: etagUpdates,
  };
}
