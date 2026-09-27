import type { HttpClient, HttpGetRequest, HttpResponse } from '../../src/esi/http';

export interface MockHttp extends HttpClient {
  /** 已发出的请求（供断言 URL 与请求头） */
  readonly calls: HttpGetRequest[];
  /** 入队一个响应或异常；队列耗尽后复用最后一个 */
  enqueue(response: HttpResponse | Error): void;
}

/** 测试用 HTTP 客户端：按序返回预置响应，并记录请求 */
export function createMockHttp(): MockHttp {
  const queue: (HttpResponse | Error)[] = [];
  const calls: HttpGetRequest[] = [];
  let last: HttpResponse | Error | null = null;

  return {
    calls,
    enqueue(response: HttpResponse | Error): void {
      queue.push(response);
    },
    async get(request: HttpGetRequest): Promise<HttpResponse> {
      calls.push(request);
      const next = queue.shift() ?? last;
      if (next === null) throw new Error('mock HTTP 未配置响应');
      last = next;
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

/** 构造 JSON 响应 */
export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): HttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json', ...headers },
    text: JSON.stringify(body),
  };
}

/** 构造空响应体（304 等） */
export function emptyResponse(status: number, headers: Record<string, string> = {}): HttpResponse {
  return { status, headers, text: '' };
}
