import type { Migration } from '../types';

/**
 * P5-2.8 历史数据全量初始化：给 `market_history_daily` 补 `date` 单列索引。
 *
 * 为什么需要：全量初始化后本表约 1,400 万行（400 天保留期 × 约 3.65 万对）。
 * 全局裁剪使用 `DELETE ... WHERE date < ?`（不带 region_id / type_id），
 * 主键 `(region_id, type_id, date)` 无法服务该谓词 → 只能全表扫描；
 * 而「启动裁剪 + 轮次前后裁剪」都会走这条 SQL。加 `date` 索引后降为索引区间扫描。
 *
 * 注：per-pair 裁剪（带 region_id + type_id）继续走主键前缀，不受影响。
 */
export const MIGRATION_0009_HISTORY_DATE_INDEX: Migration = {
  version: 9,
  name: 'history-date-index',
  statements: [
    `CREATE INDEX IF NOT EXISTS idx_market_history_date ON market_history_daily (date);`,
  ],
};
