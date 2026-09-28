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
use std::time::{Duration, Instant};

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

/// 事务会话最长存活时间：超过即视为泄漏（典型成因：WebView 重载丢弃了 `db_tx_end`），
/// 主动回滚并归还连接，避免写锁被永久占用（表现：此后所有写入 `database is locked`）
const TX_SESSION_TTL: Duration = Duration::from_secs(300);

/// 数据库文件名（与历史版本一致，复用既有数据库文件）
const DB_FILE_NAME: &str = "eve-suite.db";

type Query<'q> = sqlx::query::Query<'q, Sqlite, SqliteArguments<'q>>;

/// 事务会话：创建时刻 + 独占连接（持写锁）
struct TxSession {
    created_at: Instant,
    conn: PoolConnection<Sqlite>,
}

#[derive(Default)]
pub struct DbState {
    pool: OnceCell<SqlitePool>,
    /// 活跃事务会话：会话 id → 会话
    transactions: Mutex<HashMap<u64, TxSession>>,
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
            let session = guard
                .get_mut(&id)
                .ok_or_else(|| format!("事务 {id} 不存在"))?;
            execute_on(&mut session.conn, &sql, &values).await
        }
        None => {
            // 非事务写入前顺手清理泄漏会话（自愈：WebView 重载等丢单场景）
            let mut conn = acquire(&app, &state).await?;
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
            let session = guard
                .get_mut(&id)
                .ok_or_else(|| format!("事务 {id} 不存在"))?;
            select_on(&mut session.conn, &sql, &values).await
        }
        None => {
            let mut conn = acquire(&app, &state).await?;
            select_on(&mut conn, &sql, &values).await
        }
    }
}

/// 取得一条可用连接；取用前先清理泄漏的事务会话，避免写锁被一直占着
async fn acquire<'a>(
    app: &AppHandle,
    state: &'a DbState,
) -> Result<PoolConnection<Sqlite>, String> {
    prune_stale_sessions(&mut *state.transactions.lock().await).await;
    pool(app, state)
        .await?
        .acquire()
        .await
        .map_err(|error| format!("获取连接失败：{error}"))
}

/// 清理超时未结束的事务会话（泄漏兜底）：回滚并归还连接
async fn prune_stale_sessions(sessions: &mut HashMap<u64, TxSession>) {
    let now = Instant::now();
    let stale: Vec<u64> = sessions
        .iter()
        .filter(|(_, session)| now.duration_since(session.created_at) >= TX_SESSION_TTL)
        .map(|(id, _)| *id)
        .collect();

    for id in stale {
        if let Some(session) = sessions.remove(&id) {
            let _ = finish_transaction(session.conn, false).await;
        }
    }
}

/// 开启事务会话：独占一条连接直至 `db_tx_end`，返回会话 id
#[tauri::command]
pub async fn db_tx_begin(app: AppHandle, state: tauri::State<'_, DbState>) -> Result<u64, String> {
    // BEGIN IMMEDIATE：立即取得写锁，避免后续语句升级锁时产生竞争
    let mut conn = acquire(&app, &state).await?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(|error| format!("开启事务失败：{error}"))?;

    let id = state.next_tx_id.fetch_add(1, Ordering::SeqCst) + 1;
    state.transactions.lock().await.insert(
        id,
        TxSession {
            created_at: Instant::now(),
            conn,
        },
    );
    Ok(id)
}

/// 结束事务会话：commit 为 true 时提交，否则回滚；连接随即归还连接池。
/// 会话不存在（重复结束 / 已被超时清理）视为已处理，保持幂等。
#[tauri::command]
pub async fn db_tx_end(
    state: tauri::State<'_, DbState>,
    tx_id: u64,
    commit: bool,
) -> Result<(), String> {
    // 先取出会话并释放会话表锁，再进行可能耗时的提交
    let session = state.transactions.lock().await.remove(&tx_id);
    let Some(session) = session else {
        return Ok(());
    };
    finish_transaction(session.conn, commit).await
}

/// 结束事务：执行 COMMIT / ROLLBACK。
/// - 提交失败时尝试回滚兜底
/// - 回滚失败（或已无事务却回滚失败）时：**连接状态不可信则丢弃连接**（不回池），
///   否则把「未结束的事务」带回连接池会让写锁被永久占用（踩坑：database is locked 长挂）
async fn finish_transaction(mut conn: PoolConnection<Sqlite>, commit: bool) -> Result<(), String> {
    let statement = if commit { "COMMIT" } else { "ROLLBACK" };
    match sqlx::query(statement).execute(&mut *conn).await {
        Ok(_) => Ok(()),
        Err(primary) => {
            if is_no_active_transaction(&primary.to_string()) {
                // 事务已结束：视为成功，避免把幂等结束当成错误
                return Ok(());
            }
            if commit {
                if let Err(error) = sqlx::query("ROLLBACK").execute(&mut *conn).await {
                    // 提交与回滚都失败：连接不可信 → detach 后随作用域结束关闭，杜绝写锁泄漏
                    let _ = conn.detach();
                    return Err(format!("COMMIT 失败且回滚失败：{primary} / {error}"));
                }
                return Err(format!("COMMIT 失败：{primary}"));
            }
            let _ = conn.detach();
            Err(format!("ROLLBACK 失败：{primary}"))
        }
    }
}

/// SQLite 在无活跃事务时执行 COMMIT/ROLLBACK 的报错特征
fn is_no_active_transaction(message: &str) -> bool {
    message.contains("no transaction is active")
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    /// 每个用例独立的临时库文件（内存库在池化下每连接各一份，故用文件）
    fn temp_db_path() -> std::path::PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let mut path = std::env::temp_dir();
        path.push(format!(
            "eve-suite-db-test-{}-{}.db",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::SeqCst)
        ));
        path
    }

    async fn open_pool(path: &std::path::Path, max_connections: u32) -> SqlitePool {
        SqlitePoolOptions::new()
            .max_connections(max_connections)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(path)
                    .create_if_missing(true),
            )
            .await
            .expect("打开测试库")
    }

    #[test]
    fn detects_no_active_transaction_message() {
        assert!(is_no_active_transaction(
            "error returned from database: cannot rollback - no transaction is active"
        ));
        assert!(!is_no_active_transaction("database is locked"));
    }

    /// 关键回归：会话回滚必须释放写锁（此前泄漏会让所有后续写入都 database is locked）
    #[tokio::test]
    async fn rollback_releases_write_lock_and_discards_data() {
        let path = temp_db_path();
        let pool = open_pool(&path, 3).await;

        let mut setup = pool.acquire().await.expect("建表连接");
        sqlx::query("CREATE TABLE t (id INTEGER PRIMARY KEY)")
            .execute(&mut *setup)
            .await
            .expect("建表");
        drop(setup);

        // 事务会话：写入一行但不提交
        let mut conn = pool.acquire().await.expect("会话连接");
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *conn)
            .await
            .expect("占写锁");
        sqlx::query("INSERT INTO t (id) VALUES (1)")
            .execute(&mut *conn)
            .await
            .expect("写入");

        // 未结束时，另一条连接拿不到写锁（复现 database is locked 的机制）
        let probe_pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&path)
                    .busy_timeout(Duration::from_millis(0)),
            )
            .await
            .expect("探测库");
        let mut probe = probe_pool.acquire().await.expect("探测连接");
        assert!(
            sqlx::query("BEGIN IMMEDIATE")
                .execute(&mut *probe)
                .await
                .is_err(),
            "会话未结束时探测连接不应取得写锁"
        );

        // 回滚后：写锁释放、数据未落库
        finish_transaction(conn, false).await.expect("回滚应成功");

        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *probe)
            .await
            .expect("回滚后应能取得写锁");
        let row = sqlx::query("SELECT COUNT(*) AS n FROM t")
            .fetch_one(&mut *probe)
            .await
            .expect("计数");
        assert_eq!(row.try_get::<i64, _>("n").expect("n"), 0, "回滚后不应有数据");
        sqlx::query("ROLLBACK").execute(&mut *probe).await.expect("收尾");

        drop(probe);
        probe_pool.close().await;
        pool.close().await;
        let _ = std::fs::remove_file(&path);
    }

    /// 幂等：会话对应的连接已无活跃事务时，结束操作视为成功
    #[tokio::test]
    async fn finish_without_active_transaction_is_ok() {
        let path = temp_db_path();
        let pool = open_pool(&path, 1).await;
        let conn = pool.acquire().await.expect("连接");
        finish_transaction(conn, false)
            .await
            .expect("无活跃事务时应视为成功");
        pool.close().await;
        let _ = std::fs::remove_file(&path);
    }

    /// 提交成功路径：数据落库且写锁释放
    #[tokio::test]
    async fn commit_persists_data_and_releases_lock() {
        let path = temp_db_path();
        let pool = open_pool(&path, 2).await;

        let mut setup = pool.acquire().await.expect("建表连接");
        sqlx::query("CREATE TABLE t (id INTEGER PRIMARY KEY)")
            .execute(&mut *setup)
            .await
            .expect("建表");
        drop(setup);

        let mut conn = pool.acquire().await.expect("会话连接");
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *conn)
            .await
            .expect("占写锁");
        sqlx::query("INSERT INTO t (id) VALUES (7)")
            .execute(&mut *conn)
            .await
            .expect("写入");
        finish_transaction(conn, true).await.expect("提交应成功");

        let row = sqlx::query("SELECT COUNT(*) AS n FROM t")
            .fetch_one(&pool)
            .await
            .expect("计数");
        assert_eq!(row.try_get::<i64, _>("n").expect("n"), 1, "提交后应落库");

        pool.close().await;
        let _ = std::fs::remove_file(&path);
    }
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
