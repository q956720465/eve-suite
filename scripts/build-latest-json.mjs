#!/usr/bin/env node
/**
 * 生成 Tauri v2 更新清单 `latest.json`（P6-6）。
 *
 * 为什么自己生成：本项目不用 `tauri-apps/tauri-action`（它会接管 Release 创建），
 * 而是在 tag 构建后由本脚本把各平台的**签名文件**与**产物地址**组装成清单，随 Release 一起上传。
 *
 * 用法：
 *   node scripts/build-latest-json.mjs \
 *     --bundle <bundle 根目录> \
 *     --version <x.y.z> \
 *     --base-url <产物下载前缀，如 https://github.com/o/r/releases/download/v1.0.0> \
 *     [--notes <发行说明>] [--out <输出文件>]
 *
 * 平台 key 约定（Tauri updater）：
 *   windows-x86_64 / linux-x86_64 / darwin-aarch64 / darwin-x86_64
 *   —— **universal 的 dmg 会同时登记到 darwin-aarch64 与 darwin-x86_64**（两种 Mac 拿到同一个包），
 *      不依赖客户端对 `darwin-universal` 的回退语义。
 *
 * 产物选择：Windows 优先 NSIS（可静默安装），无则退回 MSI；Linux 用 AppImage；macOS 用 dmg。
 * 没有对应 `.sig` 的产物会被**跳过并告警**（而不是写入一个无法校验的条目）。
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

function parseArgs(argv) {
  const options = { notes: '', out: null, bundle: null, version: null, baseUrl: null };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    const value = argv[index + 1];
    index += 1;
    if (key === '--bundle') options.bundle = value;
    else if (key === '--version') options.version = value;
    else if (key === '--base-url') options.baseUrl = value;
    else if (key === '--notes') options.notes = value;
    else if (key === '--out') options.out = value;
    else throw new Error(`未知参数：${key}`);
  }
  if (options.bundle === null || options.version === null || options.baseUrl === null) {
    throw new Error('缺少必需参数：--bundle / --version / --base-url');
  }
  return options;
}

/** 递归列出目录下所有文件（相对路径，统一用 / 分隔） */
function walk(dir, base = dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, acc);
    else acc.push(full.slice(base.length + 1).replace(/\\/g, '/'));
  }
  return acc;
}

const options = parseArgs(process.argv.slice(2));
if (!existsSync(options.bundle)) throw new Error(`bundle 目录不存在：${options.bundle}`);

const files = walk(options.bundle);
const warnings = [];

/** 读取产物的签名（`<artifact>.sig`）；缺失返回 null */
function signatureOf(artifact) {
  const sigPath = `${artifact}.sig`;
  if (!files.includes(sigPath)) return null;
  return readFileSync(join(options.bundle, sigPath), 'utf8').trim();
}

const platforms = {};

function register(key, artifact) {
  if (platforms[key] !== undefined) return;
  const signature = signatureOf(artifact);
  if (signature === null || signature.length === 0) {
    warnings.push(`跳过 ${key}：缺少签名文件 ${artifact}.sig`);
    return;
  }
  platforms[key] = {
    signature,
    url: `${options.baseUrl}/${encodeURIComponent(basename(artifact))}`,
  };
}

// Windows：优先 NSIS，其次 MSI
for (const file of files) {
  if (file.startsWith('nsis/') && file.endsWith('.exe')) register('windows-x86_64', file);
}
for (const file of files) {
  if (file.startsWith('msi/') && file.endsWith('.msi')) register('windows-x86_64', file);
}

// Linux：AppImage
for (const file of files) {
  if (file.startsWith('appimage/') && file.endsWith('.AppImage')) register('linux-x86_64', file);
}

// macOS：dmg（universal 同时登记两种架构）
for (const file of files) {
  if (!file.startsWith('dmg/') || !file.endsWith('.dmg')) continue;
  const name = basename(file).toLowerCase();
  if (name.includes('universal')) {
    register('darwin-aarch64', file);
    register('darwin-x86_64', file);
  } else if (name.includes('aarch64') || name.includes('arm64')) {
    register('darwin-aarch64', file);
  } else if (name.includes('x64') || name.includes('intel')) {
    register('darwin-x86_64', file);
  } else {
    warnings.push(`无法判断架构，已跳过：${file}`);
  }
}

const manifest = {
  version: options.version,
  notes: options.notes,
  pub_date: new Date().toISOString(),
  platforms,
};

const text = `${JSON.stringify(manifest, null, 2)}\n`;
if (options.out === null) process.stdout.write(text);
else writeFileSync(options.out, text, 'utf8');

for (const warning of warnings) process.stderr.write(`[warn] ${warning}\n`);
const keys = Object.keys(platforms);
process.stderr.write(
  keys.length === 0
    ? '[error] 没有生成任何平台条目（是不是没有 .sig？）\n'
    : `[ok] latest.json 已生成：${keys.join(', ')}${options.out === null ? '' : ` → ${options.out}`}\n`,
);
if (keys.length === 0) process.exit(1);
