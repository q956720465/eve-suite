#!/usr/bin/env node
/**
 * 版本号同步（P6-1）。
 *
 * **唯一真源 = `src-tauri/tauri.conf.json` 的 `version`**（打包实际使用的版本）。
 * 本脚本把它同步到其余落点，消除「多处硬编码、改一处漏一处」的漂移：
 *   - `package.json`（根）
 *   - `packages/core/package.json`（`CORE_VERSION` 由此读取，见 `packages/core/src/index.ts`）
 *   - `packages/ui/package.json`
 *   - `src-tauri/Cargo.toml`（`[package] version`）
 *
 * 用法：
 *   node scripts/sync-version.mjs           # 写入（幂等）
 *   node scripts/sync-version.mjs --check   # 只校验一致性，不一致则退出码 1（供 CI 用）
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TAURI_CONF = join(ROOT, 'src-tauri', 'tauri.conf.json');

const CHECK_ONLY = process.argv.includes('--check');

/** 相对路径（日志更易读） */
const rel = (path) => relative(ROOT, path).replace(/\\/g, '/');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const source = readJson(TAURI_CONF);
const version = source.version;
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`✗ ${rel(TAURI_CONF)} 的 version 非法：${JSON.stringify(version)}`);
  process.exit(1);
}

console.log(`版本真源：${rel(TAURI_CONF)} → ${version}`);

const mismatches = [];
let changed = 0;

/** 同步 JSON 文件的 version 字段（保持 2 空格缩进 + 末尾换行，与仓库现状一致） */
function syncJsonVersion(path) {
  const raw = readFileSync(path, 'utf8');
  const json = JSON.parse(raw);
  if (json.version === version) return;
  mismatches.push(`${rel(path)}: ${json.version} → ${version}`);
  if (CHECK_ONLY) return;
  json.version = version;
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
  changed += 1;
}

/** 同步 Cargo.toml 的 `[package] version`（只替换 `[package]` 段内的第一处） */
function syncCargoVersion(path) {
  const raw = readFileSync(path, 'utf8');
  const match = /(\[package\][\s\S]*?^version\s*=\s*")([^"]*)(")/m.exec(raw);
  if (match === null) {
    console.error(`✗ 未在 ${rel(path)} 找到 [package] version`);
    process.exit(1);
  }
  if (match[2] === version) return;
  mismatches.push(`${rel(path)}: ${match[2]} → ${version}`);
  if (CHECK_ONLY) return;
  writeFileSync(path, raw.replace(match[0], `${match[1]}${version}${match[3]}`), 'utf8');
  changed += 1;
}

syncJsonVersion(join(ROOT, 'package.json'));
syncJsonVersion(join(ROOT, 'packages', 'core', 'package.json'));
syncJsonVersion(join(ROOT, 'packages', 'ui', 'package.json'));
syncCargoVersion(join(ROOT, 'src-tauri', 'Cargo.toml'));

if (mismatches.length === 0) {
  console.log('✓ 全部落点已一致（无改动）');
  process.exit(0);
}

if (CHECK_ONLY) {
  console.error('✗ 版本不一致：');
  for (const item of mismatches) console.error(`  - ${item}`);
  process.exit(1);
}

console.log(`✓ 已同步 ${changed} 个文件：`);
for (const item of mismatches) console.log(`  - ${item}`);
