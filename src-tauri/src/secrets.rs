//! 系统钥匙串（P3-2）：机密（OAuth 刷新令牌等）存平台安全存储，数据库不落明文。
//!
//! 平台后端由 `keyring` 的 feature 决定（Windows Credential Manager / macOS Keychain /
//! Linux Secret Service），本模块只暴露「设置 / 读取 / 删除」三个最小能力；
//! 账号命名约定（如 `refresh-token:<characterId>`）由 TypeScript 侧决定。
//!
//! 安全约定：错误信息与日志一律不回显密钥内容。

use keyring::Entry;

/// 钥匙串服务名（与 tauri.conf.json 的 identifier 一致，便于在系统凭据管理器辨认）
pub const KEYRING_SERVICE: &str = "com.eve-suite.desktop";

/// 写入机密（已存在则覆盖）
#[tauri::command]
pub fn secret_set(account: String, secret: String) -> Result<(), String> {
    let account = validate_account(&account)?;
    if secret.is_empty() {
        return Err("密钥内容不能为空".to_string());
    }
    entry(account)?
        .set_password(&secret)
        .map_err(|error| format!("写入钥匙串失败：{error}"))
}

/// 读取机密（不存在返回 None）
#[tauri::command]
pub fn secret_get(account: String) -> Result<Option<String>, String> {
    let account = validate_account(&account)?;
    match entry(account)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("读取钥匙串失败：{error}")),
    }
}

/// 删除机密（不存在视为已删除）
#[tauri::command]
pub fn secret_delete(account: String) -> Result<(), String> {
    let account = validate_account(&account)?;
    match entry(account)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("删除钥匙串条目失败：{error}")),
    }
}

/// 构造钥匙串条目
fn entry(account: &str) -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, account).map_err(|error| format!("创建钥匙串条目失败：{error}"))
}

/// 账号名不能为空（避免写入无法定位的条目）
fn validate_account(account: &str) -> Result<&str, String> {
    let trimmed = account.trim();
    if trimmed.is_empty() {
        return Err("钥匙串账号名不能为空".to_string());
    }
    Ok(trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reject_empty_account() {
        assert!(secret_set(String::new(), "value".to_string()).is_err());
        assert!(secret_set("   ".to_string(), "value".to_string()).is_err());
        assert!(secret_get(String::new()).is_err());
        assert!(secret_delete("  ".to_string()).is_err());
    }

    #[test]
    fn reject_empty_secret() {
        // 空账号先被拒；此处单独验证空密钥被拒
        let error = secret_set("some-account".to_string(), String::new()).unwrap_err();
        assert!(error.contains("不能为空"), "实际错误：{error}");
    }

    #[test]
    fn validate_account_trims() {
        assert_eq!(validate_account("  a  ").unwrap(), "a");
        assert!(validate_account("").is_err());
    }

    /// 真实系统钥匙串往返（需手动执行）：cargo test -- --ignored --nocapture
    /// 不打印密钥内容，只打印长度与状态。
    #[test]
    #[ignore = "访问真实系统钥匙串，需手动执行"]
    fn real_keyring_round_trip() {
        let account = format!("selftest-{}", std::process::id());
        let secret = "self-test-refresh-token-0123456789abcdef";

        // 先清理可能残留的同名条目
        let _ = secret_delete(account.clone());

        secret_set(account.clone(), secret.to_string()).expect("写入钥匙串失败");
        println!("[钥匙串自检] 已写入账号 {account}，密钥长度 {} 字节", secret.len());

        report_windows_credential(&account);

        let loaded = secret_get(account.clone()).expect("读取钥匙串失败");
        assert_eq!(loaded.as_deref(), Some(secret), "读回内容与写入不一致");
        println!("[钥匙串自检] 读取成功，长度 {} 字节，内容一致", loaded.unwrap().len());

        secret_delete(account.clone()).expect("删除钥匙串条目失败");
        let after = secret_get(account.clone()).expect("删除后读取失败");
        assert_eq!(after, None, "删除后仍能读到条目");
        println!("[钥匙串自检] 删除成功，再次读取为 None");
    }

    /// Windows：打印凭据管理器中本服务名的条目（可观测性证据；无 cmdkey 时不影响测试）
    #[cfg(target_os = "windows")]
    fn report_windows_credential(account: &str) {
        match std::process::Command::new("cmdkey").arg("/list").output() {
            Ok(output) => {
                let text = String::from_utf8_lossy(&output.stdout);
                match text.lines().find(|line| line.contains(KEYRING_SERVICE)) {
                    Some(line) => println!("[钥匙串自检] 凭据管理器条目：{}", line.trim()),
                    None => println!(
                        "[钥匙串自检] cmdkey 未列出 {KEYRING_SERVICE}（账号 {account}）"
                    ),
                }
            }
            Err(error) => println!("[钥匙串自检] 无法执行 cmdkey：{error}"),
        }
    }

    #[cfg(not(target_os = "windows"))]
    fn report_windows_credential(_account: &str) {}
}
