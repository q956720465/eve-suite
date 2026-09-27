import { describe, expect, it } from 'vitest';

import { fetchAllPages } from '../../src/esi/paging';

describe('fetchAllPages 分页拉取', () => {
  it('首页 304 且无水位：视为 1 页且 allNotModified', async () => {
    const calls: Array<[number, string | undefined]> = [];
    const result = await fetchAllPages(async (page, etag) => {
      calls.push([page, etag]);
      return { notModified: true, data: null, etag: 'W/"a"', pages: null, rateLimit: null, errorLimit: null };
    });

    expect(calls).toEqual([[1, undefined]]);
    expect(result.allNotModified).toBe(true);
    expect(result.pages).toBe(1);
    expect(result.items).toEqual([]);
    expect(result.etags.get(1)).toBe('W/"a"');
  });

  it('部分页 304：仅对缺页无条件重取（etag = undefined）', async () => {
    const calls: Array<[number, string | undefined]> = [];
    const result = await fetchAllPages(
      async (page, etag) => {
        calls.push([page, etag]);
        if (page === 1) {
          // 带 ETag 首次请求命中 304；无条件重取（etag = undefined）返回 200
          if (etag !== undefined) {
            return { notModified: true, data: null, etag: 'W/"p1"', pages: 2, rateLimit: null, errorLimit: null };
          }
          return { notModified: false, data: ['item-1'], etag: 'W/"p1"', pages: 2, rateLimit: null, errorLimit: null };
        }
        // 第 2 页内容已变化 → 200
        return { notModified: false, data: ['item-2'], etag: 'W/"p2b"', pages: null, rateLimit: null, errorLimit: null };
      },
      { etags: new Map([[1, 'W/"p1"'], [2, 'W/"p2"']]) },
    );

    // 第 1 页带缓存 ETag 请求（304）→ 第 2 页带缓存 ETag 请求（200）→ 第 1 页无条件重取
    expect(calls).toEqual([
      [1, 'W/"p1"'],
      [2, 'W/"p2"'],
      [1, undefined],
    ]);
    expect(result.allNotModified).toBe(false);
    expect(result.items).toEqual(['item-1', 'item-2']);
    expect(result.requests).toBe(3);
    expect(result.notModifiedPages).toBe(1);
    expect(result.etags.get(1)).toBe('W/"p1"');
    expect(result.etags.get(2)).toBe('W/"p2b"');
  });

  it('X-Pages 大于水位页数：按新页数拉全，新增页无缓存 ETag', async () => {
    const calls: Array<[number, string | undefined]> = [];
    const result = await fetchAllPages(
      async (page, etag) => {
        calls.push([page, etag]);
        return {
          notModified: false,
          data: [`i${page}`],
          etag: `W/"n${page}"`,
          pages: page === 1 ? 3 : null,
          rateLimit: null,
          errorLimit: null,
        };
      },
      { etags: new Map([[1, 'W/"n1"']]), fallbackPages: 2 },
    );

    expect(calls).toEqual([
      [1, 'W/"n1"'],
      [2, undefined],
      [3, undefined],
    ]);
    expect(result.pages).toBe(3);
    expect(result.items).toEqual(['i1', 'i2', 'i3']);
    expect(result.allNotModified).toBe(false);
  });
});
