/** 迁移定义：version 唯一且单调递增；sql 为一段或多段 SQLite 语句 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * 数据库适配器：核心逻辑只依赖本接口，具体实现由宿主注入
 * （Tauri 应用经 plugin-sql，离线测试经 node:sqlite）。
 * 约定：参数占位符统一使用 `?`。
 */
export interface DbAdapter {
  /** 执行 DDL / DML（允许包含多条语句） */
  execute(sql: string, params?: readonly unknown[]): Promise<void>;
  /** 执行查询并返回行数组 */
  select<T>(sql: string, params?: readonly unknown[]): Promise<T[]>;
}