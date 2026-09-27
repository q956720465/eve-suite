//! OAuth 本地回环授权（P3-1）：绑定 127.0.0.1 固定端口接收 SSO 回调，并调起系统浏览器。
//!
//! 职责边界：PKCE / state / 授权 URL 构造 / 令牌交换全部在 TypeScript 侧
//! （`@eve-suite/core` 的 `esi/oauth.ts` 与 `esi/oauth-flow.ts`）。本模块只做渲染进程
//! 无法完成的两件事：
//! 1. 监听本地回环端口接收浏览器重定向（WebView 无法监听端口）
//! 2. 调起系统默认浏览器（WebView 内直接跳转会被 CCP 登录页拒载）
//!
//! 回调地址形式：`http://127.0.0.1:{固定端口}/callback`。端口由 TS 侧传入
//! （`OAUTH_LOOPBACK_PORT`），**必须与 CCP 后台注册的回调地址完全一致**——P3-8
//! 实测 EVE SSO 要求精确匹配（含端口与路径），不采纳 RFC 8252 对 Native 应用
//! 的回环动态端口豁免，随机端口会报
//! `invalid_request: The redirect URL does not match any of the configured values`。

use std::process::Command;
use std::time::Duration;

use serde::Serialize;
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, Mutex};
use tokio::task::AbortHandle;
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

/// 授权会话状态（同一时刻至多一个进行中的授权）
#[derive(Default)]
pub struct OAuthState {
    /// 回调结果通道（`wait_callback` 取走；下一次 `prepare` 覆盖时丢弃旧的）
    receiver: Mutex<Option<oneshot::Receiver<CallbackPayload>>>,
    /// 当前监听任务的中止句柄（总是指向**最新**的监听器：固定端口下重新授权
    /// 必须先中止上一个监听器释放端口，哪怕旧流程还在等待回调）
    listener: Mutex<Option<AbortHandle>>,
}

/// 绑定本地回环端口并开始等待回调，返回端口与回调地址
///
/// 固定端口意味着旧监听器必须先释放：先中止上一个监听任务再绑定；
/// 中止到端口真正释放存在微小竞态，`AddrInUse` 时短暂重试。
pub async fn prepare(
    state: &OAuthState,
    port: u16,
    redirect_path: &str,
) -> Result<PrepareResult, String> {
    let path = normalize_path(redirect_path);

    abort_listener(state).await;
    let listener = bind_with_retry(port).await?;
    let redirect_uri = format!("http://127.0.0.1:{port}{path}");

    let (sender, receiver) = oneshot::channel();
    let task = tokio::spawn(serve(listener, path, sender));
    *state.listener.lock().await = Some(task.abort_handle());

    // 覆盖旧会话的回调通道（尚在等待的旧流程自此以「会话已结束」收场）
    drop(state.receiver.lock().await.replace(receiver));

    Ok(PrepareResult { port, redirect_uri })
}

/// 等待回调（超时后释放监听并报错）
pub async fn wait_callback(state: &OAuthState, timeout_ms: u64) -> Result<CallbackPayload, String> {
    let receiver = state
        .receiver
        .lock()
        .await
        .take()
        .ok_or_else(|| "没有进行中的授权会话，请先调用 oauth_prepare".to_string())?;

    match timeout(Duration::from_millis(timeout_ms), receiver).await {
        Ok(Ok(payload)) => Ok(payload),
        Ok(Err(_)) => Err("授权会话已结束，但未收到有效回调".to_string()),
        Err(_) => {
            abort_listener(state).await;
            Err(format!("授权超时（{timeout_ms} 毫秒），已释放本地回环端口"))
        }
    }
}

/// 取消进行中的授权会话并释放端口（无会话时视为成功）
pub async fn cancel(state: &OAuthState) {
    abort_listener(state).await;
    state.receiver.lock().await.take();
}

/// 中止当前监听任务（如有），使其释放回环端口
async fn abort_listener(state: &OAuthState) {
    if let Some(handle) = state.listener.lock().await.take() {
        handle.abort();
    }
}

/// 绑定回环端口；`AddrInUse` 时短暂重试（刚中止的上一个监听器释放端口有竞态窗口）
async fn bind_with_retry(port: u16) -> Result<TcpListener, String> {
    const RETRIES: u32 = 20;
    const RETRY_DELAY: Duration = Duration::from_millis(50);
    const BUSY_MESSAGE: &str = "可能被其他程序或本应用的另一实例占用";

    for _ in 0..RETRIES {
        match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(listener) => return Ok(listener),
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
                tokio::time::sleep(RETRY_DELAY).await;
            }
            Err(error) => {
                return Err(format!("无法绑定本地回环端口 {port}（{BUSY_MESSAGE}）：{error}"));
            }
        }
    }

    TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|error| format!("无法绑定本地回环端口 {port}（{BUSY_MESSAGE}）：{error}"))
}

/// 绑定本地回环端口（须与 CCP 注册的回调地址一致），返回端口与回调地址
#[tauri::command]
pub async fn oauth_prepare(
    state: State<'_, OAuthState>,
    port: u16,
    redirect_path: String,
) -> Result<PrepareResult, String> {
    prepare(state.inner(), port, &redirect_path).await
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
    let mut command = browser_command(url);

    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开系统浏览器失败：{error}"))
}

/// 构造打开浏览器的命令。
///
/// Windows 必须**绕过 cmd.exe**：授权 URL 里带 `&`（参数分隔）与 `%`
/// （percent-encoding），`cmd /C start` 会把 `&` 当命令分隔符把 URL 截断
/// （实测只留给浏览器 `?response_type=code`，SSO 返回 client_id is required），
/// `%` 还会被当变量展开。`rundll32` 由 CreateProcess 直接传 argv，URL 原样送达。
#[cfg(target_os = "windows")]
fn browser_command(url: &str) -> Command {
    let mut command = Command::new("rundll32");
    command.args(["url.dll,FileProtocolHandler", url]);
    command
}

#[cfg(target_os = "macos")]
fn browser_command(url: &str) -> Command {
    let mut command = Command::new("open");
    command.arg(url);
    command
}

#[cfg(all(unix, not(target_os = "macos")))]
fn browser_command(url: &str) -> Command {
    let mut command = Command::new("xdg-open");
    command.arg(url);
    command
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

    /// 回归：授权 URL 必须原样传给浏览器进程。
    /// 历史缺陷：Windows 走 `cmd /C start`，URL 里的 `&` 被当命令分隔符截断，
    /// 浏览器只收到 `?response_type=code`，SSO 报 client_id is required。
    #[test]
    fn browser_command_passes_authorize_url_verbatim() {
        let url = "https://login.eveonline.com/v2/oauth/authorize?response_type=code\
                   &redirect_uri=http%3A%2F%2F127.0.0.1%3A53210%2Fcallback\
                   &client_id=abc123&scope=esi-assets.read_assets.v1+esi-wallet.read_character_wallet.v1\
                   &state=xyz&code_challenge=chal&code_challenge_method=S256";
        let command = browser_command(url);

        #[cfg(target_os = "windows")]
        assert_eq!(command.get_program().to_string_lossy(), "rundll32");

        // 关键：URL 是**单个未修改**的参数（`&` 与 `%` 不做任何转义）
        let args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert!(
            args.iter().any(|arg| arg == url),
            "URL 未被原样传入（可能被 shell 截断/转义）：{args:?}"
        );
    }

    #[tokio::test]
    async fn loopback_receives_callback() {
        let state = OAuthState::default();
        let prepared = prepare(&state, 24565, "/callback").await.expect("绑定回环端口失败");
        assert_eq!(prepared.port, 24565);
        // 回调地址必须逐字等于 CCP 后台注册值（SSO 精确匹配）
        assert_eq!(prepared.redirect_uri, "http://127.0.0.1:24565/callback");

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
        let prepared = prepare(&state, 24566, "/callback").await.expect("绑定回环端口失败");

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
        let prepared = prepare(&state, 24567, "/callback").await.expect("绑定回环端口失败");

        let result = wait_callback(&state, 100).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("超时"));

        // 超时后端口应已释放：可重新绑定同一端口（中止到释放有竞态，短暂重试）
        let mut released = false;
        for _ in 0..20 {
            if TcpListener::bind(("127.0.0.1", prepared.port)).await.is_ok() {
                released = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(released, "超时后回环端口 {} 未被释放", prepared.port);
    }

    /// 固定端口的回归：重新授权必须先释放旧监听器再绑同一端口，
    /// 且只有**最新**监听器接收回调（旧流程以「会话已结束」收场）。
    #[tokio::test]
    async fn prepare_again_releases_previous_session() {
        let state = OAuthState::default();
        let first = prepare(&state, 24568, "/callback").await.expect("首次绑定失败");
        let second = prepare(&state, 24568, "/callback").await.expect("二次绑定失败");

        // 固定端口：两次应绑到同一端口
        assert_eq!(first.port, second.port);

        // 当前会话应是第二次：回调打到该端口由最新监听器接收
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
