/** 多语句迁移模式：statements 按顺序在同一事务内执行 */
export interface MigrationStatementsMode {
  statements: readonly string[];
  sql?: undefined;
}

/** 单语句迁移模式（等价于长度为 1 的 statements） */
export interface MigrationSqlMode {
  sql: string;
  statements?: undefined;
}

/**
 * 迁移定义：version 唯一且单调递增。
 *
 * 注意：运行时驱动（tauri-plugin-sql → sqlx）的 execute 只执行传入 SQL 的第一条语句，
 * 而测试用 node:sqlite 的 exec 支持多语句——为避免"测试通过但运行时静默失败"，
 * 含多条语句的迁移必须使用 statements 数组逐条下发。
 */
export type Migration = {
  version: number;
  name: string;
} & (MigrationStatementsMode | MigrationSqlMode);

/**
 * 数据库适配器：核心逻辑只依赖本接口，具体实现由宿主注入
 * （Tauri 应用经自有 sqlx 连接池命令，离线测试经 node:sqlite）。
 * 约定：参数占位符统一使用 `?`。
 */
export interface DbAdapter {
  /** 执行 DDL / DML（传入单条语句） */
  execute(sql: string, params?: readonly unknown[]): Promise<void>;
  /** 执行查询并返回行数组 */
  select<T>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /**
   * 原子事务：回调内所有 execute / select 落在同一连接上，正常返回即提交，抛错即回滚。
   *
   * 禁止在 core 中裸写 `BEGIN` / `COMMIT`：运行时驱动使用连接池，
   * 独立的语句会被分派到不同连接，导致原子性丢失或 `database is locked`
   * （这类缺陷在单连接的测试环境下不会暴露）。
   */
  transaction<T>(work: (tx: DbAdapter) => Promise<T>): Promise<T>;
}
