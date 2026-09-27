import type { Migration } from '../types';

import { MIGRATION_0001_SETTINGS } from './0001-settings';
import { MIGRATION_0002_SDE_TABLES } from './0002-sde-tables';
import { MIGRATION_0003_MARKET_TABLES } from './0003-market-tables';

/** 生产迁移清单：按 version 升序追加；已发布的迁移禁止修改，只能新增 */
export const MIGRATIONS: readonly Migration[] = [
  MIGRATION_0001_SETTINGS,
  MIGRATION_0002_SDE_TABLES,
  MIGRATION_0003_MARKET_TABLES,
];