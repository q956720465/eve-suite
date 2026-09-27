mod db;
mod oauth;
mod sde;
mod secrets;

/// 应用版本（P0-2 建立，用于验证 UI → Rust IPC 链路）
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(db::DbState::default())
        .manage(oauth::OAuthState::default())
        .invoke_handler(tauri::generate_handler![
            app_version,
            db::db_execute,
            db::db_select,
            db::db_tx_begin,
            db::db_tx_end,
            sde::sde_cache_dir,
            sde::sde_http_get_text,
            sde::sde_download,
            sde::sde_extract,
            sde::sde_read_chunk,
            sde::sde_file_sizes,
            sde::sde_remove_file,
            oauth::oauth_prepare,
            oauth::oauth_open_browser,
            oauth::oauth_wait_callback,
            oauth::oauth_cancel,
            secrets::secret_set,
            secrets::secret_get,
            secrets::secret_delete
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
