//! ESI 拉取的 Rust 侧实现（**HTTP/1.1 专用**）。
//!
//! 为什么把 ESI 换成 Rust 发请求（2026-09-30 实测，详见 DEV_STATUS）：
//! Tauri 的渲染进程是 Chromium，它对 `https://` 必然协商 **HTTP/2**；而实测 ESI 的
//! h2 路径对「大响应」比 h1 慢约 14 倍（同一 `orders` 页 237 KB：h1 1.26 s vs h2 17.5 s），
//! 枢纽层一个区 404 页会被拖到 20 分钟。Rust 侧 `reqwest` 在本项目是
//! `default-features = false`（不含 http2）→ 天然走 h1；这里再显式 `http1_only()`
//! 锁死，避免将来依赖特性变化把 h2 打开。
//!
//! 顺带补上渲染进程 fetch 缺失的能力：**请求超时**（此前挂住的请求会一直等）。
//!
//! 契约（与 `packages/core/src/esi/http.ts` 的 `HttpResponse` 对齐）：
//! - **非 2xx 不算错误**：状态码 / 响应头 / 响应体原样回传，由 core 的 `EsiClient` 分类；
//! - 仅「参数非法 / 传输失败 / 超时 / 建客户端失败」返回 `Err`；
//! - 响应头键**统一小写**，与渲染进程 fetch 实现一致。

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

use reqwest::header::{HeaderValue, AUTHORIZATION, IF_NONE_MATCH};
use serde::Serialize;

/// 单次请求总超时（渲染进程 fetch 此前无超时，是「挂住不动」的一半原因）
const ESI_TIMEOUT_SECS: u64 = 30;
/// 连接建立超时
const ESI_CONNECT_TIMEOUT_SECS: u64 = 10;
/// 空闲连接保活时长（枢纽层连续数百次请求同一主机，复用连接收益明显）
const ESI_POOL_IDLE_SECS: u64 = 90;

/// 与 SDE 下载保持一致的 UA（CCP 要求带可识别 UA）
const ESI_USER_AGENT: &str = "eve-suite/1.0 (+https://github.com/q956720465/eve-suite)";

#[derive(Debug, Serialize)]
pub struct EsiHttpResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
}

/// 进程内单例客户端：连接池跨请求复用（避免每次重建 TLS）
fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(existing) = CLIENT.get() {
        return Ok(existing);
    }
    let built = reqwest::Client::builder()
        .user_agent(ESI_USER_AGENT)
        // 显式锁死 HTTP/1.1：h2 对本项目的大响应慢 10 倍以上（见文件头）
        .http1_only()
        .timeout(Duration::from_secs(ESI_TIMEOUT_SECS))
        .connect_timeout(Duration::from_secs(ESI_CONNECT_TIMEOUT_SECS))
        .pool_idle_timeout(Duration::from_secs(ESI_POOL_IDLE_SECS))
        .build()
        .map_err(|error| format!("创建 ESI HTTP 客户端失败：{error}"))?;
    let _ = CLIENT.set(built);
    CLIENT
        .get()
        .ok_or_else(|| "创建 ESI HTTP 客户端失败：初始化竞争未取到实例".to_string())
}

/// ESI GET：返回状态码 / 响应头（小写键）/ 响应体文本。
///
/// - `if_none_match`：ETag 条件请求（命中时 ESI 返回 304 且无响应体）
/// - `bearer_token`：认证端点使用，以 `Authorization: Bearer <token>` 发送
#[tauri::command]
pub async fn esi_http_get(
    url: String,
    if_none_match: Option<String>,
    bearer_token: Option<String>,
) -> Result<EsiHttpResponse, String> {
    if !url.starts_with("https://") {
        return Err(format!("ESI 地址必须是 https：{url}"));
    }

    let mut request = client()?.get(&url);
    if let Some(etag) = if_none_match {
        let value = HeaderValue::try_from(etag)
            .map_err(|error| format!("If-None-Match 非法：{error}"))?;
        request = request.header(IF_NONE_MATCH, value);
    }
    if let Some(token) = bearer_token {
        let value = HeaderValue::try_from(format!("Bearer {token}"))
            .map_err(|error| format!("访问令牌非法：{error}"))?;
        request = request.header(AUTHORIZATION, value);
    }

    let response = request
        .send()
        .await
        .map_err(|error| format!("ESI 请求失败：{error}"))?;

    let status = response.status().as_u16();
    let mut headers: HashMap<String, String> = HashMap::new();
    for (name, value) in response.headers() {
        if let Ok(text) = value.to_str() {
            headers.insert(name.as_str().to_ascii_lowercase(), text.to_string());
        }
    }

    // 304 无响应体；gzip 由 reqwest 自动解压（Cargo.toml 已启用 gzip 特性）
    let body = if status == 304 {
        String::new()
    } else {
        response
            .text()
            .await
            .map_err(|error| format!("读取 ESI 响应体失败：{error}"))?
    };

    Ok(EsiHttpResponse {
        status,
        headers,
        body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// http:// 地址必须被拒绝（只允许 https）
    #[tokio::test]
    async fn rejects_non_https_url() {
        let error = esi_http_get("http://esi.evetech.net/latest/status/".to_string(), None, None)
            .await
            .expect_err("http 地址必须被拒绝");
        assert!(error.contains("https"), "错误信息应说明只接受 https：{error}");
    }

    /// 含换行的 ETag 非法（防请求头注入），且应在发起请求前就失败
    #[tokio::test]
    async fn rejects_invalid_etag_header() {
        let error = esi_http_get(
            "https://esi.evetech.net/latest/status/".to_string(),
            Some("bad\nvalue".to_string()),
            None,
        )
        .await
        .expect_err("含换行的 ETag 必须被拒绝");
        assert!(error.contains("If-None-Match"), "错误信息应指明头名：{error}");
    }

    /// 含换行的访问令牌非法
    #[tokio::test]
    async fn rejects_invalid_bearer_token() {
        let error = esi_http_get(
            "https://esi.evetech.net/latest/status/".to_string(),
            None,
            Some("bad\nvalue".to_string()),
        )
        .await
        .expect_err("含换行的令牌必须被拒绝");
        assert!(error.contains("令牌"), "错误信息应指明令牌非法：{error}");
    }
}
