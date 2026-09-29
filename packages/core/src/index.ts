import pkg from '../package.json';

/**
 * @eve-suite/core 公共出口（typed command 层）。
 * 界面只允许通过本文件导出的 API 调用核心逻辑。
 */

/**
 * 核心包版本号。
 *
 * **真源 = `src-tauri/tauri.conf.json`**（打包实际使用的版本），由 `scripts/sync-version.mjs`
 * 同步到本包 `package.json`；此处只读不写 —— **源码内不再出现版本字面量**，杜绝版本漂移。
 */
export const CORE_VERSION: string = pkg.version;

export * from './db/index';
export * from './sde/index';
export * from './esi/index';
export * from './market/index';
export * from './engines/index';
export * from './lp/index';
export * from './notify/index';
export * from './personal/index';