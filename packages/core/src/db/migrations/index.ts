import type { Migration } from '../types';

import { MIGRATION_0001_SETTINGS } from './0001-settings';

/** 生产迁移清单：按 version 升序追加；已发布的迁移禁止修改，只能新增 */
export const MIGRATIONS: readonly Migration[] = [MIGRATION_0001_SETTINGS];