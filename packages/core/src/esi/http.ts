/**
 * HTTP 抽象层：屏蔽运行时差异（WebView fetch / 测试 mock）。
 * 只暴露本模块需要的最小能力：带条件请求头的 GET。
 */

/** 归一化后的响应（响应头键统一小写） */
export interface HttpResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  /** 响应体文本；304 或空响应体时为空串 */
  text: string;
}

export interface HttpGetRequest {
  url: string;
  /** ETag 条件请求（命中则服务端返回 304 且无响应体） */
  ifNoneMatch?: string;
  signal?: AbortSignal;
}

/** 宿主注入的 HTTP 客户端 */
export interface HttpClient {
  get(request: HttpGetRequest): Promise<HttpResponse>;
}

/** 读取响应头（缺失或空串返回 null） */
export function readHeader(headers: Readonly<Record<string, string>>, name: string): string | null {
  const value = headers[name.toLowerCase()];
  return value === undefined || value.length === 0 ? null : value;
}

/** 读取数字响应头（缺失或非法返回 null） */
export function readNumberHeader(
  headers: Readonly<Record<string, string>>,
  name: string,
): number | null {
  const raw = readHeader(headers, name);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}
