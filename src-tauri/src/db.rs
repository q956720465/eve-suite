//! 数据库连接层：自管 sqlx SQLite 连接池 + 事务会话。
//!
//! 取代 tauri-plugin-sql 的原因：其 JS API 只有 `execute` / `select`（底层 `sqlx::query` 单语句），
//! 既无法表达事务，也会把同一批语句分派到连接池的不同连接上——手写 BEGIN/COMMIT 的
//! 多语句操作会因跨连接而失败（database is locked）或静默丢失原子性。
//!
//! 本模块提供：
//! - `db_execute` / `db_select`：常规单语句操作（自动获取连接）
//! - `db_tx_begin` / `db_tx_end`：事务会话；会话内所有操作绑定同一连接，保证原子性

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde_json::{Map, Value};
use sqlx::pool::PoolConnection;
use sqlx::sqlite::{
    SqliteArguments, SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteRow,
    SqliteSynchronous,
};
use sqlx::{Column, Row, Sqlite, SqliteConnection, SqlitePool, TypeInfo, ValueRef};
use tauri::{AppHandle, Manager};
use tokio::sync::{Mutex, OnceCell};

/// 连接池大小：单机应用足够；批量导入是串行写入，多连接只服务于读
const MAX_CONNECTIONS: u32 = 5;

/// 写锁等待时长：批量导入期间偶发竞争时等待而非直接报错
const BUSY_TIMEOUT: Duration = Duration::from_secs(10);

/// 数据库文件名（与历史版本一致，复用既有数据库文件）
const DB_FILE_NAME: &str = "eve-suite.db";

type Query<'q> = sqlx::query::Query<'q, Sqlite, SqliteArguments<'q>>;

#[derive(Default)]
pub struct DbState {
    pool: OnceCell<SqlitePool>,
    /// 活跃事务会话：会话 id → 独占连接
    transactions: Mutex<HashMap<u64, PoolConnection<Sqlite>>>,
    next_tx_id: AtomicU64,
}

/// 数据库文件绝对路径（应用配置目录下，与旧实现保持一致）
pub fn database_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("无法解析应用配置目录：{error}"))?;
    std::fs::create_dir_all(&dir).map_err(|error| format!("创建数据目录失败：{error}"))?;
    Ok(dir.join(DB_FILE_NAME))
}

/// 获取（首次调用时创建）连接池；连接级 PRAGMA 统一通过连接选项设置，对所有连接生效
async fn pool<'a>(app: &AppHandle, state: &'a DbState) -> Result<&'a SqlitePool, String> {
    state
        .pool
        .get_or_try_init(|| async {
            let path = database_path(app)?;
            let options = SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true)
                .journal_mode(SqliteJournalMode::Wal)
                .synchronous(SqliteSynchronous::Normal)
                .busy_timeout(BUSY_TIMEOUT)
                .foreign_keys(true);

            SqlitePoolOptions::new()
                .max_connections(MAX_CONNECTIONS)
                .connect_with(options)
                .await
                .map_err(|error| format!("连接数据库失败：{error}"))
        })
        .await
}

/// 执行单条语句（DDL / DML），返回受影响行数；`tx_id` 为空时自动获取连接
#[tauri::command]
pub async fn db_execute(
    app: AppHandle,
    state: tauri::State<'_, DbState>,
    sql: String,
    params: Option<Vec<Value>>,
    tx_id: Option<u64>,
) -> Result<u64, String> {
    let values = params.unwrap_or_default();
    match tx_id {
        Some(id) => {
            let mut guard = state.transactions.lock().await;
            let conn = guard
                .get_mut(&id)
                .ok_or_else(|| format!("事务 {id} 不存在"))?;
            execute_on(conn, &sql, &values).await
        }
        None => {
            let mut conn = pool(&app, &state)
                .await?
                .acquire()
                .await
                .map_err(|error| format!("获取连接失败：{error}"))?;
            execute_on(&mut conn, &sql, &values).await
        }
    }
}

/// 执行查询，返回 JSON 对象数组；`tx_id` 为空时自动获取连接
#[tauri::command]
pub async fn db_select(
    app: AppHandle,
    state: tauri::State<'_, DbState>,
    sql: String,
    params: Option<Vec<Value>>,
    tx_id: Option<u64>,
) -> Result<Vec<Value>, String> {
    let values = params.unwrap_or_default();
    match tx_id {
        Some(id) => {
            let mut guard = state.transactions.lock().await;
            let conn = guard
                .get_mut(&id)
                .ok_or_else(|| format!("事务 {id} 不存在"))?;
            select_on(conn, &sql, &values).await
        }
        None => {
            let mut conn = pool(&app, &state)
                .await?
                .acquire()
                .await
                .map_err(|error| format!("获取连接失败：{error}"))?;
            select_on(&mut conn, &sql, &values).await
        }
    }
}

/// 开启事务会话：独占一条连接直至 `db_tx_end`，返回会话 id
#[tauri::command]
pub async fn db_tx_begin(app: AppHandle, state: tauri::State<'_, DbState>) -> Result<u64, String> {
    let mut conn = pool(&app, &state)
        .await?
        .acquire()
        .await
        .map_err(|error| format!("获取连接失败：{error}"))?;

    // BEGIN IMMEDIATE：立即取得写锁，避免后续语句升级锁时产生竞争
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(|error| format!("开启事务失败：{error}"))?;

    let id = state.next_tx_id.fetch_add(1, Ordering::SeqCst) + 1;
    state.transactions.lock().await.insert(id, conn);
    Ok(id)
}

/// 结束事务会话：commit 为 true 时提交，否则回滚；连接随即归还连接池
#[tauri::command]
pub async fn db_tx_end(
    state: tauri::State<'_, DbState>,
    tx_id: u64,
    commit: bool,
) -> Result<(), String> {
    // 先取出连接并释放会话表锁，再进行可能耗时的提交
    let mut conn = state
        .transactions
        .lock()
        .await
        .remove(&tx_id)
        .ok_or_else(|| format!("事务 {tx_id} 不存在"))?;

    let statement = if commit { "COMMIT" } else { "ROLLBACK" };
    sqlx::query(statement)
        .execute(&mut *conn)
        .await
        .map_err(|error| format!("{statement} 失败：{error}"))?;

    Ok(())
}

async fn execute_on(
    conn: &mut SqliteConnection,
    sql: &str,
    params: &[Value],
) -> Result<u64, String> {
    let query = bind_params(sqlx::query(sql), params);
    let result = query
        .execute(conn)
        .await
        .map_err(|error| format!("执行失败：{error}"))?;
    Ok(result.rows_affected())
}

async fn select_on(
    conn: &mut SqliteConnection,
    sql: &str,
    params: &[Value],
) -> Result<Vec<Value>, String> {
    let query = bind_params(sqlx::query(sql), params);
    let rows = query
        .fetch_all(conn)
        .await
        .map_err(|error| format!("查询失败：{error}"))?;
    Ok(rows.iter().map(row_to_json).collect())
}

/// 按 JSON 值类型绑定参数（null / bool / number / string）
fn bind_params<'q>(mut query: Query<'q>, params: &[Value]) -> Query<'q> {
    for value in params {
        query = match value {
            Value::Null => query.bind(None::<String>),
            Value::Bool(flag) => query.bind(*flag),
            Value::Number(number) => {
                if let Some(int) = number.as_i64() {
                    query.bind(int)
                } else if let Some(float) = number.as_f64() {
                    query.bind(float)
                } else {
                    query.bind(number.to_string())
                }
            }
            Value::String(text) => query.bind(text.clone()),
            other => query.bind(other.to_string()),
        };
    }
    query
}

/// 行 → JSON 对象（按 SQLite 列类型还原为 JSON 值）
fn row_to_json(row: &SqliteRow) -> Value {
    let mut map = Map::new();
    for (index, column) in row.columns().iter().enumerate() {
        let value = match row.try_get_raw(index) {
            Ok(raw) if raw.is_null() => Value::Null,
            Ok(raw) => match raw.type_info().name() {
                "INTEGER" | "INT" | "BIGINT" => row
                    .try_get::<i64, _>(index)
                    .map(Value::from)
                    .unwrap_or(Value::Null),
                "REAL" | "FLOAT" | "DOUBLE" => row
                    .try_get::<f64, _>(index)
                    .map(Value::from)
                    .unwrap_or(Value::Null),
                "TEXT" => row
                    .try_get::<String, _>(index)
                    .map(Value::from)
                    .unwrap_or(Value::Null),
                "BLOB" => row
                    .try_get::<Vec<u8>, _>(index)
                    .map(|bytes| Value::Array(bytes.into_iter().map(Value::from).collect()))
                    .unwrap_or(Value::Null),
                _ => Value::Null,
            },
            Err(_) => Value::Null,
        };
        map.insert(column.name().to_string(), value);
    }
    Value::Object(map)
}
