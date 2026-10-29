//! Streaming multipart/form-data upload (audio files can be hundreds of MB).

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use reqwest::multipart::{Form, Part};
use serde::Serialize;
use tokio_util::io::ReaderStream;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

pub fn guess_mime(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "flac" => "audio/flac",
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/opus",
        "weba" => "audio/webm",
        "webm" => "video/webm",
        "mp4" => "video/mp4",
        "mkv" => "video/x-matroska",
        "mov" => "video/quicktime",
        _ => "application/octet-stream",
    }
}

pub async fn upload_multipart_impl(
    url: &str,
    headers: &HashMap<String, String>,
    fields: &[(String, String)],
    file_field: &str,
    file_path: &Path,
    timeout_secs: u64,
) -> Result<HttpResponse, String> {
    let file = tokio::fs::File::open(file_path)
        .await
        .map_err(|e| format!("Could not open {}: {e}", file_path.display()))?;
    let len = file
        .metadata()
        .await
        .map_err(|e| format!("Could not read {}: {e}", file_path.display()))?
        .len();
    let file_name = file_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "upload".into());

    let body = reqwest::Body::wrap_stream(ReaderStream::with_capacity(file, 256 * 1024));
    let part = Part::stream_with_length(body, len)
        .file_name(file_name)
        .mime_str(guess_mime(file_path))
        .map_err(|e| format!("Invalid content type: {e}"))?;

    let mut form = Form::new();
    for (k, v) in fields {
        form = form.text(k.clone(), v.clone());
    }
    form = form.part(file_field.to_string(), part);

    let mut builder = reqwest::Client::builder();
    if timeout_secs > 0 {
        builder = builder.timeout(Duration::from_secs(timeout_secs));
    }
    let client = builder
        .build()
        .map_err(|e| format!("Could not create HTTP client: {e}"))?;

    let mut req = client.post(url).multipart(form);
    for (k, v) in headers {
        req = req.header(k.as_str(), v.as_str());
    }
    let resp = req.send().await.map_err(|e| {
        if e.is_timeout() {
            format!("Upload timed out after {timeout_secs} s: {e}")
        } else if e.is_connect() {
            format!("Could not connect to {url}: {e}")
        } else {
            format!("Upload failed: {e}")
        }
    })?;
    let status = resp.status().as_u16();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("Could not read server response: {e}"))?;
    Ok(HttpResponse { status, body })
}

#[tauri::command]
pub async fn upload_multipart(
    url: String,
    headers: HashMap<String, String>,
    fields: Vec<(String, String)>,
    file_field: String,
    file_path: String,
    timeout_secs: u64,
) -> Result<HttpResponse, String> {
    upload_multipart_impl(
        &url,
        &headers,
        &fields,
        &file_field,
        Path::new(&file_path),
        timeout_secs,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mime_guess() {
        assert_eq!(guess_mime(Path::new("a/b.FLAC")), "audio/flac");
        assert_eq!(guess_mime(Path::new("x.mp4")), "video/mp4");
        assert_eq!(guess_mime(Path::new("noext")), "application/octet-stream");
    }
}
