//! OAuth 本地回环授权（P3-1）：绑定 127.0.0.1 随机端口接收 SSO 回调，并调起系统浏览器。
//!
//! 职责边界：PKCE / state / 授权 URL 构造 / 令牌交换全部在 TypeScript 侧
//! （`@eve-suite/core` 的 `esi/oauth.ts` 与 `esi/oauth-flow.ts`）。本模块只做渲染进程
//! 无法完成的两件事：
//! 1. 监听本地回环端口接收浏览器重定向（WebView 无法监听端口）
//! 2. 调起系统默认浏览器（WebView 内直接跳转会被 CCP 登录页拒载）
//!
//! 回调地址形式：`http://127.0.0.1:{随机端口}/callback`（EVE SSO 对 Native/Desktop
//! 应用按 RFC 8252 允许回环动态端口）。

use std::process::Command;
use std::time::Duration;

use serde::Serialize;
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, Mutex};
use tokio::task::JoinHandle;
use tokio::time::timeout;

/// 默认回调路径（与 TypeScript 侧保持一致）
pub const DEFAULT_CALLBACK_PATH: &str = "/callback";

/// 读取单次请求头的最长等待时间：避免浏览器预连接占用 accept 循环
const READ_TIMEOUT: Duration = Duration::from_secs(5);

/// 单次读取的请求缓冲上限（回调请求行很短，8KB 足够）
const REQUEST_BUFFER_BYTES: usize = 8 * 1024;

/// `oauth_prepare` 的返回：随机端口与完整回调地址
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PrepareResult {
    pub port: u16,
    pub redirect_uri: String,
}

/// 回调参数（授权码或错误；缺失字段为 null）
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CallbackPayload {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
    pub error_description: Option<String>,
}

/// 进行中的授权会话
struct PendingFlow {
    receiver: oneshot::Receiver<CallbackPayload>,
    task: JoinHandle<()>,
}

/// 授权会话状态（同一时刻至多一个进行中的授权）
#[derive(Default)]
pub struct OAuthState {
    pending: Mutex<Option<PendingFlow>>,
}

/// 绑定本地回环端口并开始等待回调，返回随机端口与回调地址
pub async fn prepare(state: &OAuthState, redirect_path: &str) -> Result<PrepareResult, String> {
    let path = normalize_path(redirect_path);

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|error| format!("无法绑定本地回环端口：{error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("读取本地端口失败：{error}"))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}{path}");

    let (sender, receiver) = oneshot::channel();
    let task = tokio::spawn(serve(listener, path, sender));

    let mut guard = state.pending.lock().await;
    let previous = guard.replace(PendingFlow { receiver, task });
    drop(guard);
    // 覆盖前先释放上一个会话，避免端口泄漏（abort 后 await 确保监听器已真正释放）
    if let Some(previous) = previous {
        previous.task.abort();
        let _ = previous.task.await;
    }

    Ok(PrepareResult { port, redirect_uri })
}

/// 等待回调（超时后释放监听并报错）
pub async fn wait_callback(state: &OAuthState, timeout_ms: u64) -> Result<CallbackPayload, String> {
    let flow = state
        .pending
        .lock()
        .await
        .take()
        .ok_or_else(|| "没有进行中的授权会话，请先调用 oauth_prepare".to_string())?;

    let PendingFlow { receiver, task } = flow;

    match timeout(Duration::from_millis(timeout_ms), receiver).await {
        Ok(Ok(payload)) => Ok(payload),
        Ok(Err(_)) => Err("授权会话已结束，但未收到有效回调".to_string()),
        Err(_) => {
            task.abort();
            let _ = task.await;
            Err(format!("授权超时（{timeout_ms} 毫秒），已释放本地回环端口"))
        }
    }
}

/// 取消进行中的授权会话并释放端口（无会话时视为成功）
pub async fn cancel(state: &OAuthState) {
    if let Some(flow) = state.pending.lock().await.take() {
        flow.task.abort();
        let _ = flow.task.await;
    }
}

/// 绑定本地回环端口，返回随机端口与回调地址
#[tauri::command]
pub async fn oauth_prepare(
    state: State<'_, OAuthState>,
    redirect_path: String,
) -> Result<PrepareResult, String> {
    prepare(state.inner(), &redirect_path).await
}

/// 打开系统默认浏览器访问授权页
#[tauri::command]
pub fn oauth_open_browser(url: String) -> Result<(), String> {
    open_browser(&url)
}

/// 等待浏览器回调，返回授权码或错误信息
#[tauri::command]
pub async fn oauth_wait_callback(
    state: State<'_, OAuthState>,
    timeout_ms: u64,
) -> Result<CallbackPayload, String> {
    wait_callback(state.inner(), timeout_ms).await
}

/// 取消授权并释放端口
#[tauri::command]
pub async fn oauth_cancel(state: State<'_, OAuthState>) -> Result<(), String> {
    cancel(state.inner()).await;
    Ok(())
}

/// 用系统默认浏览器打开 URL（零依赖：调用各平台原生命令，不等待进程退出）
fn open_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let spawned = Command::new("cmd").args(["/C", "start", "", url]).spawn();
    #[cfg(target_os = "macos")]
    let spawned = Command::new("open").arg(url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let spawned = Command::new("xdg-open").arg(url).spawn();

    spawned
        .map(|_| ())
        .map_err(|error| format!("打开系统浏览器失败：{error}"))
}

/// accept 循环：命中回调路径则回写结果页并结束，其余请求回 404 后继续等待
async fn serve(
    listener: TcpListener,
    callback_path: String,
    sender: oneshot::Sender<CallbackPayload>,
) {
    let mut sender = Some(sender);

    loop {
        let (mut stream, _) = match listener.accept().await {
            Ok(pair) => pair,
            Err(_) => return,
        };

        let target = match read_request_target(&mut stream).await {
            Some(target) => target,
            None => {
                // 空请求或超时：不视为回调，直接丢弃连接
                continue;
            }
        };

        let (path, payload) = parse_callback_target(&target);
        if path != callback_path {
            let body = "<!doctype html><meta charset=\"utf-8\"><p>404 Not Found</p>";
            let _ = respond(&mut stream, "404 Not Found", body).await;
            continue;
        }

        let body = callback_page(&payload);
        let _ = respond(&mut stream, "200 OK", &body).await;
        if let Some(sender) = sender.take() {
            let _ = sender.send(payload);
        }
        return;
    }
}

/// 读取请求行并取出请求目标（如 `/callback?code=..&state=..`）
async fn read_request_target(stream: &mut TcpStream) -> Option<String> {
    let mut buffer = vec![0u8; REQUEST_BUFFER_BYTES];
    let read = timeout(READ_TIMEOUT, stream.read(&mut buffer))
        .await
        .ok()?
        .ok()?;
    if read == 0 {
        return None;
    }

    let text = String::from_utf8_lossy(&buffer[..read]);
    let line = text.lines().next()?;
    let mut parts = line.split_whitespace();
    let _method = parts.next()?;
    let target = parts.next()?;
    Some(target.to_string())
}

/// 回写完整 HTTP 响应（带正确的字节长度 Content-Length）
async fn respond(stream: &mut TcpStream, status: &str, html: &str) -> std::io::Result<()> {
    let body = html.as_bytes();
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body).await?;
    stream.flush().await
}

/// 解析请求目标：拆出路径与回调参数（`code` / `state` / `error` / `error_description`）
pub fn parse_callback_target(target: &str) -> (String, CallbackPayload) {
    let (path, query) = match target.split_once('?') {
        Some((path, query)) => (path.to_string(), query),
        None => (target.to_string(), ""),
    };

    let mut code = None;
    let mut state = None;
    let mut error = None;
    let mut error_description = None;

    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (key, raw) = match pair.split_once('=') {
            Some((key, value)) => (key, value),
            None => (pair, ""),
        };
        let value = percent_decode(raw);
        match key {
            "code" => code = Some(value),
            "state" => state = Some(value),
            "error" => error = Some(value),
            "error_description" => error_description = Some(value),
            _ => {}
        }
    }

    (
        path,
        CallbackPayload {
            code,
            state,
            error,
            error_description,
        },
    )
}

/// 回调结果页（成功提示可关闭窗口；失败展示错误原因）
fn callback_page(payload: &CallbackPayload) -> String {
    match &payload.error {
        Some(error) => {
            let detail = payload
                .error_description
                .clone()
                .unwrap_or_else(|| "未提供详细原因".to_string());
            format!(
                "<!doctype html><meta charset=\"utf-8\"><title>授权失败</title>\
                 <h2>授权失败</h2><p>错误：{}</p><p>原因：{}</p><p>请返回 EVE Suite 重试。</p>",
                escape_html(error),
                escape_html(&detail)
            )
        }
        None => "<!doctype html><meta charset=\"utf-8\"><title>授权成功</title>\
                 <h2>授权成功</h2><p>请返回 EVE Suite 窗口，可关闭本页面。</p>"
            .to_string(),
    }
}

/// 规范化回调路径（空值回落默认值，缺前导斜杠则补齐）
fn normalize_path(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return DEFAULT_CALLBACK_PATH.to_string();
    }
    if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{trimmed}")
    }
}

/// 查询串百分号解码（`+` 视作空格，符合 application/x-www-form-urlencoded）
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                match (hex_value(bytes[index + 1]), hex_value(bytes[index + 2])) {
                    (Some(high), Some(low)) => {
                        out.push(high * 16 + low);
                        index += 3;
                    }
                    _ => {
                        out.push(b'%');
                        index += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }

    String::from_utf8_lossy(&out).into_owned()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// 极简 HTML 转义（错误信息来自第三方，避免注入到结果页）
fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_callback_target_reads_code_and_state() {
        let (path, payload) = parse_callback_target("/callback?code=abc123&state=xyz789");
        assert_eq!(path, "/callback");
        assert_eq!(payload.code.as_deref(), Some("abc123"));
        assert_eq!(payload.state.as_deref(), Some("xyz789"));
        assert!(payload.error.is_none());
        assert!(payload.error_description.is_none());
    }

    #[test]
    fn parse_callback_target_reads_error() {
        let (path, payload) =
            parse_callback_target("/callback?error=access_denied&error_description=user+denied");
        assert_eq!(path, "/callback");
        assert!(payload.code.is_none());
        assert_eq!(payload.error.as_deref(), Some("access_denied"));
        assert_eq!(payload.error_description.as_deref(), Some("user denied"));
    }

    #[test]
    fn parse_callback_target_decodes_percent_and_handles_no_query() {
        let (_, payload) = parse_callback_target("/callback?state=a%2Bb%20c");
        assert_eq!(payload.state.as_deref(), Some("a+b c"));

        let (path, payload) = parse_callback_target("/callback");
        assert_eq!(path, "/callback");
        assert!(payload.code.is_none() && payload.state.is_none());
    }

    #[test]
    fn normalize_path_fills_default() {
        assert_eq!(normalize_path(""), "/callback");
        assert_eq!(normalize_path("  "), "/callback");
        assert_eq!(normalize_path("callback"), "/callback");
        assert_eq!(normalize_path("/cb"), "/cb");
    }

    #[tokio::test]
    async fn loopback_receives_callback() {
        let state = OAuthState::default();
        let prepared = prepare(&state, "/callback").await.expect("绑定回环端口失败");
        assert!(prepared.redirect_uri.starts_with("http://127.0.0.1:"));
        assert!(prepared.redirect_uri.ends_with("/callback"));

        // 模拟浏览器重定向：真实 TCP 连接访问回调地址
        let request = format!(
            "GET /callback?code=CODE-1&state=STATE-1 HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
            prepared.port
        );
        let mut client = TcpStream::connect(("127.0.0.1", prepared.port))
            .await
            .expect("连接回环端口失败");
        client
            .write_all(request.as_bytes())
            .await
            .expect("写入回调请求失败");

        let mut response = Vec::new();
        client
            .read_to_end(&mut response)
            .await
            .expect("读取回调响应失败");
        let response_text = String::from_utf8_lossy(&response);
        assert!(response_text.starts_with("HTTP/1.1 200 OK"));
        assert!(response_text.contains("授权成功"));

        let payload = wait_callback(&state, 3_000).await.expect("未收到回调");
        assert_eq!(payload.code.as_deref(), Some("CODE-1"));
        assert_eq!(payload.state.as_deref(), Some("STATE-1"));
    }

    #[tokio::test]
    async fn loopback_ignores_other_paths_then_accepts_callback() {
        let state = OAuthState::default();
        let prepared = prepare(&state, "/callback").await.expect("绑定回环端口失败");

        // 先来一个 favicon 请求（应被忽略）
        let mut noise = TcpStream::connect(("127.0.0.1", prepared.port))
            .await
            .expect("连接回环端口失败");
        noise
            .write_all(b"GET /favicon.ico HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .await
            .expect("写入噪声请求失败");
        let mut noise_response = Vec::new();
        let _ = noise.read_to_end(&mut noise_response).await;
        assert!(String::from_utf8_lossy(&noise_response).starts_with("HTTP/1.1 404"));

        // 随后真正的回调仍应被接收
        let mut client = TcpStream::connect(("127.0.0.1", prepared.port))
            .await
            .expect("连接回环端口失败");
        client
            .write_all(b"GET /callback?error=access_denied HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .await
            .expect("写入回调请求失败");
        let mut response = Vec::new();
        let _ = client.read_to_end(&mut response).await;

        let payload = wait_callback(&state, 3_000).await.expect("未收到回调");
        assert_eq!(payload.error.as_deref(), Some("access_denied"));
    }

    #[tokio::test]
    async fn wait_callback_timeout_releases_port() {
        let state = OAuthState::default();
        let prepared = prepare(&state, "/callback").await.expect("绑定回环端口失败");

        let result = wait_callback(&state, 100).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("超时"));

        // 超时后端口应已释放：可重新绑定同一端口
        assert!(TcpListener::bind(("127.0.0.1", prepared.port)).await.is_ok());
    }

    #[tokio::test]
    async fn prepare_again_releases_previous_session() {
        let state = OAuthState::default();
        let first = prepare(&state, "/callback").await.expect("首次绑定失败");
        let second = prepare(&state, "/callback").await.expect("二次绑定失败");

        assert_ne!(first.port, second.port);
        // 旧端口已释放
        assert!(TcpListener::bind(("127.0.0.1", first.port)).await.is_ok());

        // 当前会话应是第二次：回调打到第二个端口才能被收到
        let mut client = TcpStream::connect(("127.0.0.1", second.port))
            .await
            .expect("连接回环端口失败");
        client
            .write_all(b"GET /callback?code=CODE-2&state=STATE-2 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .await
            .expect("写入回调请求失败");
        let mut response = Vec::new();
        let _ = client.read_to_end(&mut response).await;

        let payload = wait_callback(&state, 3_000).await.expect("未收到回调");
        assert_eq!(payload.code.as_deref(), Some("CODE-2"));
    }
}
