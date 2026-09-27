//! SDE（静态数据）IO 层：下载 zip、解压指定 JSONL、分块读取文本。
//! 解析 / 入库 / 搜索等业务逻辑全部位于 TypeScript 侧（@eve-suite/core），
//! 本模块只提供宿主侧 IO 能力（WebView 受 CORS 限制，无法直接拉取 CCP 端点）。

use std::fs;
use std::io::{Read, Seek, SeekFrom};

use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// 下载进度事件名（前端通过 listen 订阅）
pub const DOWNLOAD_PROGRESS_EVENT: &str = "sde://download-progress";

/// 进度事件上报的最小间隔（字节），避免高频 IPC
const PROGRESS_STEP_BYTES: u64 = 512 * 1024;

#[derive(Serialize, Clone)]
pub struct DownloadProgress {
    pub received: u64,
    pub total: Option<u64>,
}

#[derive(Serialize)]
pub struct ExtractedFile {
    pub name: String,
    pub path: String,
    pub bytes: u64,
}

#[derive(Serialize)]
pub struct ChunkResult {
    pub data: String,
    pub next_offset: u64,
    pub eof: bool,
}

/// SDE 缓存目录（应用数据目录/sde-cache），不存在则创建
#[tauri::command]
pub fn sde_cache_dir(app: AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("sde-cache");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

/// 读取小型文本资源（用于 latest.jsonl 版本探测）
#[tauri::command]
pub async fn sde_http_get_text(url: String, max_bytes: usize) -> Result<String, String> {
    let client = build_client()?;
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|error| format!("请求失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("HTTP {} - {}", response.status().as_u16(), url));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("读取响应失败：{error}"))?;
    if bytes.len() > max_bytes {
        return Err(format!("响应体过大：{} 字节（上限 {}）", bytes.len(), max_bytes));
    }
    String::from_utf8(bytes.to_vec()).map_err(|error| format!("响应不是合法 UTF-8：{error}"))
}

/// 流式下载到本地文件，返回写入字节数；下载期间持续上报进度事件
#[tauri::command]
pub async fn sde_download(app: AppHandle, url: String, dest: String) -> Result<u64, String> {
    let client = build_client()?;
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|error| format!("请求失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("HTTP {} - {}", response.status().as_u16(), url));
    }

    let total = response.content_length();
    let dest_path = std::path::PathBuf::from(&dest);
    if let Some(parent) = dest_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let mut file = tokio::fs::File::create(&dest_path)
        .await
        .map_err(|error| format!("创建文件失败：{error}"))?;

    let mut stream = response.bytes_stream();
    let mut received: u64 = 0;
    let mut last_emitted: u64 = 0;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("下载中断：{error}"))?;
        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
            .await
            .map_err(|error| format!("写入失败：{error}"))?;
        received += chunk.len() as u64;
        if received - last_emitted >= PROGRESS_STEP_BYTES {
            last_emitted = received;
            let _ = app.emit(
                DOWNLOAD_PROGRESS_EVENT,
                DownloadProgress { received, total },
            );
        }
    }

    tokio::io::AsyncWriteExt::flush(&mut file)
        .await
        .map_err(|error| format!("刷新文件失败：{error}"))?;
    let _ = app.emit(DOWNLOAD_PROGRESS_EVENT, DownloadProgress { received, total });

    Ok(received)
}

/// 从 zip 中解压指定文件到目标目录（只解压清单内的文件）
#[tauri::command]
pub fn sde_extract(
    zip_path: String,
    dest_dir: String,
    files: Vec<String>,
) -> Result<Vec<ExtractedFile>, String> {
    let file = fs::File::open(&zip_path).map_err(|error| format!("打开 zip 失败：{error}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|error| format!("解析 zip 失败：{error}"))?;

    fs::create_dir_all(&dest_dir).map_err(|error| error.to_string())?;

    let wanted: Vec<&String> = files.iter().collect();
    let mut extracted = Vec::new();

    for name in wanted {
        let mut entry = match archive.by_name(name) {
            Ok(entry) => entry,
            Err(_) => return Err(format!("zip 中缺少文件：{name}")),
        };
        let target = std::path::Path::new(&dest_dir).join(name);
        let mut out_file =
            fs::File::create(&target).map_err(|error| format!("创建 {name} 失败：{error}"))?;
        let bytes = std::io::copy(&mut entry, &mut out_file)
            .map_err(|error| format!("解压 {name} 失败：{error}"))?;
        extracted.push(ExtractedFile {
            name: name.clone(),
            path: target.to_string_lossy().to_string(),
            bytes,
        });
    }

    Ok(extracted)
}

/// 分块读取文本（UTF-8 边界安全）：返回本次文本、下次偏移与是否到达末尾
#[tauri::command]
pub fn sde_read_chunk(path: String, offset: u64, len: u32) -> Result<ChunkResult, String> {
    let mut file = fs::File::open(&path).map_err(|error| format!("打开文件失败：{error}"))?;
    let size = file
        .metadata()
        .map_err(|error| error.to_string())?
        .len();

    if offset >= size {
        return Ok(ChunkResult {
            data: String::new(),
            next_offset: size,
            eof: true,
        });
    }

    file.seek(SeekFrom::Start(offset))
        .map_err(|error| format!("定位失败：{error}"))?;

    let want = (size - offset).min(len as u64) as usize;
    let mut buffer = vec![0u8; want];
    let read = file
        .read(&mut buffer)
        .map_err(|error| format!("读取失败：{error}"))?;
    buffer.truncate(read);

    // 块尾可能切断多字节字符：回退到最后一个完整字符边界，剩余留给下次读取
    let valid_len = match std::str::from_utf8(&buffer) {
        Ok(_) => buffer.len(),
        Err(error) => error.valid_up_to(),
    };
    if valid_len == 0 && read > 0 {
        return Err(format!(
            "读取块过小，无法容纳完整字符：offset={offset} len={len}"
        ));
    }

    let data = String::from_utf8(buffer[..valid_len].to_vec())
        .map_err(|error| format!("文本解码失败：{error}"))?;
    let next_offset = offset + valid_len as u64;

    Ok(ChunkResult {
        data,
        next_offset,
        eof: next_offset >= size,
    })
}

/// 批量查询文件大小（不存在返回 null），用于校验缓存完整性
#[tauri::command]
pub fn sde_file_sizes(paths: Vec<String>) -> Vec<Option<u64>> {
    paths
        .into_iter()
        .map(|path| fs::metadata(&path).ok().map(|meta| meta.len()))
        .collect()
}

/// 删除文件（文件不存在视为成功）
#[tauri::command]
pub fn sde_remove_file(path: String) -> Result<(), String> {
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("删除文件失败：{error}")),
    }
}

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("eve-suite/0.0.0 (+https://github.com/q956720465/eve-suite)")
        .build()
        .map_err(|error| format!("创建 HTTP 客户端失败：{error}"))
}
