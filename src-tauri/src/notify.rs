//! 提醒通道（P5-7）：系统桌面通知 + 通用 Webhook POST。
//!
//! 为什么 Webhook 放在 Rust 侧：钉钉 / 飞书 / 企业微信的机器人接口**不返回 CORS 头**，
//! 渲染进程的 `fetch`（JSON POST 必触发预检）会被浏览器拦截 —— 只有主进程直连才可靠。
//! 同时这也满足方案 §7 的红线：**只存 webhook 地址，不存任何用户凭据**（签名密钥在本地算）。

use std::collections::HashMap;
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use tauri_plugin_notification::NotificationExt;

/// Webhook 请求超时（秒）：机器人接口偶发慢，但不能拖住 UI
const WEBHOOK_TIMEOUT_SECS: u64 = 15;

/// 失败回执里附带的响应体长度上限（避免把整页 HTML 抛给 UI）
const ERROR_BODY_PREVIEW_CHARS: usize = 200;

/// 发送系统桌面通知（托盘 / 通知中心）。
///
/// 无用户配置，方案 §7 定为 v1 默认开启的通道。
#[tauri::command]
pub async fn notify_desktop(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|error| format!("发送桌面通知失败：{error}"))
}

/// 通用 Webhook POST（钉钉 / 企业微信 / 飞书 / 自定义）。
///
/// 返回 HTTP 状态码；非 2xx 视为失败并附带响应体摘要（便于界面直显错误）。
#[tauri::command]
pub async fn notify_webhook_post(
    url: String,
    headers: HashMap<String, String>,
    body: String,
) -> Result<u16, String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err(format!("Webhook 地址必须以 http:// 或 https:// 开头：{url}"));
    }

    let mut header_map = HeaderMap::new();
    for (name, value) in headers {
        let header_name = HeaderName::try_from(name.as_str())
            .map_err(|error| format!("非法请求头名 {name}：{error}"))?;
        let header_value = HeaderValue::try_from(value.as_str())
            .map_err(|error| format!("请求头 {name} 的值非法：{error}"))?;
        header_map.insert(header_name, header_value);
    }

    let client = reqwest::Client::builder()
        .user_agent("eve-suite/0.0.0 (+https://github.com/q956720465/eve-suite)")
        .timeout(Duration::from_secs(WEBHOOK_TIMEOUT_SECS))
        .build()
        .map_err(|error| format!("创建 HTTP 客户端失败：{error}"))?;

    let response = client
        .post(&url)
        .headers(header_map)
        .body(body)
        .send()
        .await
        .map_err(|error| format!("发送 Webhook 失败：{error}"))?;

    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        let preview: String = text.chars().take(ERROR_BODY_PREVIEW_CHARS).collect();
        return Err(format!("Webhook 返回 HTTP {}：{preview}", status.as_u16()));
    }

    Ok(status.as_u16())
}
