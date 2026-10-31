mod bundle;
mod files;
mod live;
mod media;
mod remote;
mod s3;
mod secrets;
mod upload;
mod window_bounds;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());
    builder
        .manage(live::LiveState::default())
        .manage(remote::RemoteState::default())
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
        ])
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
