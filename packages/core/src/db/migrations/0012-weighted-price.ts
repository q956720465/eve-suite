import type { Migration } from '../types';

/**
 * P11-1 新增两个**挂单量加权**价格口径（`market_stats` 纯新增列，旧列语义与数值不变）：
 *
 * - `wavg_sell`：挂单量加权均价 `Σ(price × volume_remain) / Σ(volume_remain)`
 *   —— 与 Fuzzwork `/aggregates` 的 `weightedAverage` 字段同定义（2026-09-29 实测反推锁定）。
 * - `w5_sell`：挂单量加权 5% 分位（按价格升序累积挂单量，累计量首次 ≥ 总量的 5% 时的价位，不插值）
 *   —— **我方自定义口径**，与 Fuzzwork 的 `percentile` 不同（其定义未锁死，实测无法复现）。
 *
 * 为什么要加列而不是按需算：`market_stats` 是**整区替换写**（采集每轮 `DELETE` + 整批插入），
 * 加列后**新列随下一轮采集自动补齐**，无需回填脚本；若按需从订单簿算，会把所有批量估值
 * （净值 1000+ 物品、缺口清单）从 stats 快路径退化成订单簿查询。
 *
 * 注意：`ALTER TABLE ADD COLUMN` 无 `IF NOT EXISTS`，依赖迁移版本表保证只执行一次。
 */
export const MIGRATION_0012_WEIGHTED_PRICE: Migration = {
  version: 12,
  name: 'weighted-price',
  statements: [
    `ALTER TABLE market_stats ADD COLUMN wavg_sell REAL;`,
    `ALTER TABLE market_stats ADD COLUMN w5_sell REAL;`,
  ],
};
