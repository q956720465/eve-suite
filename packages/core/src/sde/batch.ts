import type { DbAdapter } from '../db/types';

/** 单批写入行数：与列数相乘需远低于 SQLite 变量上限（32766） */
export const DEFAULT_BATCH_ROWS = 300;

/**
 * 批量插入：以多值 VALUES 分片下发，显著减少 IPC 往返。
 * table/columns 由本包内部常量提供，不接受外部输入。
 * 返回实际写入行数。
 */
export async function insertRows(
  db: DbAdapter,
  table: string,
  columns: readonly string[],
  rows: readonly unknown[][],
  batchSize: number = DEFAULT_BATCH_ROWS,
): Promise<number> {
  if (rows.length === 0) return 0;
  if (batchSize <= 0) throw new Error('batchSize 必须为正整数');

  const columnList = columns.join(', ');
  const rowPlaceholder = `(${columns.map(() => '?').join(', ')})`;
  let written = 0;

  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const chunk = rows.slice(offset, offset + batchSize);
    const sql = `INSERT INTO ${table} (${columnList}) VALUES ${chunk
      .map(() => rowPlaceholder)
      .join(', ')}`;
    const params: unknown[] = [];
    for (const row of chunk) {
      if (row.length !== columns.length) {
        throw new Error(
          `插入 ${table} 失败：行参数个数 ${row.length} 与列数 ${columns.length} 不一致`,
        );
      }
      params.push(...row);
    }
    await db.execute(sql, params);
    written += chunk.length;
  }

  return written;
}
