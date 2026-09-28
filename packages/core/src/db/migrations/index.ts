import type { Migration } from '../types';

import { MIGRATION_0001_SETTINGS } from './0001-settings';
import { MIGRATION_0002_SDE_TABLES } from './0002-sde-tables';
import { MIGRATION_0003_MARKET_TABLES } from './0003-market-tables';
import { MIGRATION_0004_PERSONAL_TABLES } from './0004-personal-tables';
import { MIGRATION_0005_LP_TABLES } from './0005-lp-tables';
import { MIGRATION_0006_TYPE_MATERIALS } from './0006-type-materials';

/** 生产迁移清单：按 version 升序追加；已发布的迁移禁止修改，只能新增 */
export const MIGRATIONS: readonly Migration[] = [
  MIGRATION_0001_SETTINGS,
  MIGRATION_0002_SDE_TABLES,
  MIGRATION_0003_MARKET_TABLES,
  MIGRATION_0004_PERSONAL_TABLES,
  MIGRATION_0005_LP_TABLES,
  MIGRATION_0006_TYPE_MATERIALS,
];