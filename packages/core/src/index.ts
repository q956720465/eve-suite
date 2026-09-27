/**
 * @eve-suite/core 公共出口（typed command 层）。
 * 界面只允许通过本文件导出的 API 调用核心逻辑。
 */

/** 核心包版本号（P0 占位，后续由构建流程注入） */
export const CORE_VERSION = '0.0.0';

export * from './db/index';
export * from './sde/index';
export * from './esi/index';
export * from './market/index';
export * from './personal/index';