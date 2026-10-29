//! API keys and passwords in the Windows Credential Manager.

use keyring::{Entry, Error};

const SERVICE: &str = "com.meetinghelper.app";

fn entry(name: &str) -> Result<Entry, String> {
    if name.trim().is_empty() {
        return Err("Secret name must not be empty.".into());
    }
    Entry::new(SERVICE, name).map_err(|e| format!("Could not open credential store: {e}"))
}

#[tauri::command]
pub fn secret_get(name: String) -> Result<Option<String>, String> {
    match entry(&name)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Could not read secret '{name}': {e}")),
    }
}

#[tauri::command]
pub fn secret_set(name: String, value: String) -> Result<(), String> {
    entry(&name)?
        .set_password(&value)
        .map_err(|e| format!("Could not save secret '{name}': {e}"))
}

#[tauri::command]
pub fn secret_delete(name: String) -> Result<(), String> {
    match entry(&name)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Could not delete secret '{name}': {e}")),
    }
}
