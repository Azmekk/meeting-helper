mod bundle;
mod files;
mod live;
mod mcp;
mod mcp_connect;
mod media;
mod remote;
mod s3;
mod secrets;
mod upload;
mod window_bounds;

use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// `--mcp`: serve Claude Code, Codex or another MCP client instead of opening the app.
pub fn run_mcp() {
    mcp::run();
}

// meeting-helper:// links that arrive before the page is ready to take them.
#[derive(Default)]
struct PendingLinks(Mutex<Vec<String>>);

fn open_links(app: &tauri::AppHandle, urls: Vec<String>) {
    let links: Vec<String> = urls.into_iter().filter(|u| u.starts_with("meeting-helper://")).collect();
    if links.is_empty() {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    app.state::<PendingLinks>().0.lock().unwrap().extend(links);
    let _ = app.emit("app://links", ());
}

#[tauri::command]
fn take_links(state: tauri::State<'_, PendingLinks>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap())
}

/// Whether this copy can replace itself. Dev builds and Linux .deb/.rpm installs
/// (updated through the package manager, needing root) only get told about new versions.
#[tauri::command]
fn can_self_update() -> bool {
    !cfg!(debug_assertions) && (!cfg!(target_os = "linux") || std::env::var_os("APPIMAGE").is_some())
}

pub fn run() {
    let builder = tauri::Builder::default();
    // First: a link opened while the app runs reaches this window, not a second copy.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
        open_links(app, args);
    }));
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());
    builder
        .manage(live::LiveState::default())
        .manage(remote::RemoteState::default())
        .manage(PendingLinks::default())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_sql::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            secrets::secret_get,
            secrets::secret_set,
            secrets::secret_delete,
            media::ffmpeg_version,
            media::probe_media,
            media::extract_audio,
            media::remux_to_mp4,
            media::remux_audio_only,
            upload::upload_multipart,
            files::move_path,
            files::copy_file_progress,
            // Backup (zip + S3)
            bundle::export_zip,
            bundle::import_zip,
            bundle::read_zip_text,
            s3::s3_test,
            s3::s3_list,
            s3::s3_put_file,
            s3::s3_get_file,
            s3::s3_put_bytes,
            s3::s3_get_bytes,
            s3::s3_delete,
            live::live_start,
            live::live_stop,
            remote::remote_start,
            remote::remote_stop,
            remote::remote_status,
            remote::remote_pair,
            remote::remote_broadcast,
            window_bounds::set_window_bounds,
            mcp_connect::mcp_status,
            mcp_connect::mcp_connect,
            mcp_connect::mcp_disconnect,
            mcp_connect::mcp_test,
            mcp_connect::mcp_open_terminal,
            take_links,
            can_self_update,
        ])
        .setup(|app| {
            // The installer registers the link scheme; this also covers portable and dev runs.
            #[cfg(any(windows, target_os = "linux"))]
            let _ = app.deep_link().register("meeting-helper");
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                open_links(&handle, event.urls().iter().map(|u| u.to_string()).collect());
            });
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                open_links(app.handle(), urls.iter().map(|u| u.to_string()).collect());
            }
            Ok(())
        })
        // The overlay would otherwise keep the app running after the main window closes.
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed)
                && let Some(overlay) = window.app_handle().get_webview_window("overlay")
            {
                let _ = overlay.close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
