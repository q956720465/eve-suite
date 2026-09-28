import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { SDE_IMPORTED_FILES } from './import';
import type { SdeFileName, SdeFileSource, SdeVersion } from './types';

/** 版本探测地址：单行 JSON，含 buildNumber / releaseDate */
export const SDE_LATEST_URL =
  'https://developers.eveonline.com/static-data/tranquility/latest.jsonl';

/** 官方 SDE 全量 zip（始终为最新构建，无版本化地址） */
export const SDE_ZIP_URL =
  'https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip';

/**
 * 导入所需文件（与 `SdeFileName` 一一对应）。
 * 直接引用导入器的文件集常量：**新增导入文件时只改 `SDE_IMPORTED_FILES` 一处**，
 * 缓存完整性检查与导入文件集会同步变化（从而在构建号未变时也能触发重导）。
 */
export const SDE_REQUIRED_FILES: readonly SdeFileName[] = SDE_IMPORTED_FILES;

/** 单次分块读取字节数（4MB：types.jsonl 约 37 块） */
const READ_CHUNK_BYTES = 4 * 1024 * 1024;

/** 下载进度事件名（与 Rust 端一致） */
const DOWNLOAD_PROGRESS_EVENT = 'sde://download-progress';

interface ChunkResult {
  data: string;
  next_offset: number;
  eof: boolean;
}

interface DownloadProgress {
  received: number;
  total: number | null;
}

export interface SdeDownloadProgress {
  received: number;
  total: number | null;
}

export interface SdeCacheResult {
  cacheDir: string;
  version: SdeVersion;
  /** 本次是否执行了下载（false 表示命中本地缓存） */
  downloaded: boolean;
}

/** 解析版本探测响应（单行 JSON），纯函数便于测试 */
export function parseLatestVersion(text: string): SdeVersion {
  const line = text
    .split('\n')
    .map((value) => value.trim())
    .find((value) => value.length > 0);
  if (line === undefined) {
    throw new Error('SDE 版本探测响应为空');
  }

  let parsed: { buildNumber?: unknown; releaseDate?: unknown };
  try {
    parsed = JSON.parse(line) as { buildNumber?: unknown; releaseDate?: unknown };
  } catch (error) {
    throw new Error(`SDE 版本响应不是合法 JSON：${String(error)}`);
  }

  if (typeof parsed.buildNumber !== 'number' || !Number.isFinite(parsed.buildNumber)) {
    throw new Error('SDE 版本响应缺少 buildNumber');
  }

  return {
    buildNumber: parsed.buildNumber,
    releaseDate: typeof parsed.releaseDate === 'string' ? parsed.releaseDate : '',
  };
}

/** 远端最新 SDE 版本 */
export async function fetchLatestVersion(): Promise<SdeVersion> {
  const text = await invoke<string>('sde_http_get_text', {
    url: SDE_LATEST_URL,
    maxBytes: 64 * 1024,
  });
  return parseLatestVersion(text);
}

/** SDE 缓存目录（应用数据目录下，Rust 侧确保存在） */
export async function getSdeCacheDir(): Promise<string> {
  return invoke<string>('sde_cache_dir');
}

/** 读取本地缓存版本；无缓存或读取失败返回 null */
export async function readCachedVersion(cacheDir: string): Promise<SdeVersion | null> {
  try {
    const chunk = await invoke<ChunkResult>('sde_read_chunk', {
      path: joinPath(cacheDir, '_sde.jsonl'),
      offset: 0,
      len: 64 * 1024,
    });
    return parseLatestVersion(chunk.data);
  } catch {
    return null;
  }
}

/**
 * 确保本地缓存可用于导入：版本一致且文件齐全时直接返回，否则下载并解压。
 * 下载过程通过 onProgress 上报字节进度。
 */
export async function ensureSdeCache(
  onProgress?: (progress: SdeDownloadProgress) => void,
): Promise<SdeCacheResult> {
  const cacheDir = await getSdeCacheDir();
  const target = await fetchLatestVersion();
  const cached = await readCachedVersion(cacheDir);

  if (cached?.buildNumber === target.buildNumber && (await areFilesPresent(cacheDir))) {
    return { cacheDir, version: target, downloaded: false };
  }

  const zipPath = joinPath(cacheDir, `sde-${target.buildNumber}.zip`);
  const unlisten = onProgress
    ? await listen<DownloadProgress>(DOWNLOAD_PROGRESS_EVENT, (event) => {
        onProgress({ received: event.payload.received, total: event.payload.total });
      })
    : undefined;

  try {
    await invoke<number>('sde_download', { url: SDE_ZIP_URL, dest: zipPath });
  } finally {
    unlisten?.();
  }

  await invoke<unknown>('sde_extract', {
    zipPath,
    destDir: cacheDir,
    files: [...SDE_REQUIRED_FILES],
  });
  await invoke<unknown>('sde_remove_file', { path: zipPath });

  return { cacheDir, version: target, downloaded: true };
}

/** 基于缓存目录构造 SDE 数据源（逐块读取并按行产出） */
export function createTauriSdeSource(cacheDir: string): SdeFileSource {
  return {
    version: async () => {
      const version = await readCachedVersion(cacheDir);
      if (version === null) {
        throw new Error('本地 SDE 缓存缺少版本信息，请先执行同步');
      }
      return version;
    },
    lines: (fileName: SdeFileName) => readLines(cacheDir, fileName),
  };
}

/** 逐块读取文本文件并按行产出（跨块自动拼接，UTF-8 边界由 Rust 侧保证） */
async function* readLines(cacheDir: string, fileName: SdeFileName): AsyncIterable<string> {
  const path = joinPath(cacheDir, fileName);
  let offset = 0;
  let remainder = '';

  for (;;) {
    const chunk = await invoke<ChunkResult>('sde_read_chunk', {
      path,
      offset,
      len: READ_CHUNK_BYTES,
    });

    const text = remainder + chunk.data;
    let start = 0;
    for (;;) {
      const newline = text.indexOf('\n', start);
      if (newline === -1) break;
      yield stripCarriageReturn(text.slice(start, newline));
      start = newline + 1;
    }
    remainder = text.slice(start);
    offset = chunk.next_offset;

    if (chunk.eof) break;
  }

  if (remainder.length > 0) {
    yield stripCarriageReturn(remainder);
  }
}

async function areFilesPresent(cacheDir: string): Promise<boolean> {
  const sizes = await invoke<(number | null)[]>('sde_file_sizes', {
    paths: SDE_REQUIRED_FILES.map((fileName) => joinPath(cacheDir, fileName)),
  });
  return sizes.every((size) => size !== null && size > 0);
}

function stripCarriageReturn(value: string): string {
  return value.endsWith('\r') ? value.slice(0, -1) : value;
}

function joinPath(dir: string, name: string): string {
  return `${dir.replace(/[\\/]+$/, '')}/${name}`;
}
