//! S3-compatible storage (AWS S3, Cloudflare R2, MinIO, Backblaze B2, …) for
//! cloud backup. Requests are presigned with rusty-s3 (SigV4 in the query
//! string) and sent with reqwest, streaming files from and to disk. All S3
//! traffic goes through here, so the webview needs no HTTP allowlist entry
//! for user-entered endpoints.
//!
//! Files over MULTIPART_THRESHOLD go up in parts. The upload id is reported
//! over the progress channel as soon as it exists; passing it back as
//! `resume_upload_id` continues an interrupted upload with the parts S3
//! already has.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use rusty_s3::actions::{
    CompleteMultipartUpload, CreateMultipartUpload, ListObjectsV2, ListParts, UploadPart,
};
use rusty_s3::{Bucket, Credentials, S3Action, UrlStyle};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio_util::io::ReaderStream;

const PRESIGN: Duration = Duration::from_secs(60 * 60);
const MULTIPART_THRESHOLD: u64 = 100 * 1024 * 1024;
const PART_SIZE: u64 = 64 * 1024 * 1024;
const PART_RETRIES: u32 = 3;
const PROGRESS_EVERY: Duration = Duration::from_millis(200);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3Config {
    /// e.g. https://<account>.r2.cloudflarestorage.com or https://s3.eu-central-1.amazonaws.com
    pub endpoint: String,
    /// "auto" for R2.
    pub region: String,
    pub bucket: String,
    /// Path-style URLs (endpoint/bucket/key) instead of bucket.endpoint/key.
    /// MinIO and most self-hosted servers need this; R2 accepts both.
    #[serde(default)]
    pub path_style: bool,
    pub access_key_id: String,
    pub secret_access_key: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub done: u64,
    pub total: u64,
    /// Set once a multipart upload has started; keep it to resume later.
    pub upload_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct S3Object {
    pub key: String,
    pub size: u64,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PutResult {
    pub etag: Option<String>,
    pub size: u64,
}

struct Client {
    bucket: Bucket,
    creds: Credentials,
    http: reqwest::Client,
}

fn client(cfg: &S3Config) -> Result<Client, String> {
    let endpoint = cfg.endpoint.trim().trim_end_matches('/');
    if endpoint.is_empty() {
        return Err("Enter the S3 endpoint URL.".into());
    }
    if cfg.bucket.trim().is_empty() {
        return Err("Enter the bucket name.".into());
    }
    if cfg.access_key_id.trim().is_empty() || cfg.secret_access_key.trim().is_empty() {
        return Err("Enter the access key ID and secret.".into());
    }
    let url = endpoint.parse().map_err(|e| format!("Invalid endpoint URL {endpoint}: {e}"))?;
    let style = if cfg.path_style { UrlStyle::Path } else { UrlStyle::VirtualHost };
    let region = if cfg.region.trim().is_empty() { "auto".to_string() } else { cfg.region.trim().to_string() };
    let bucket = Bucket::new(url, style, cfg.bucket.trim().to_string(), region)
        .map_err(|e| format!("Invalid bucket settings: {e}. Try turning on path-style URLs."))?;
    let http = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("Could not create HTTP client: {e}"))?;
    Ok(Client {
        bucket,
        creds: Credentials::new(cfg.access_key_id.trim(), cfg.secret_access_key.trim()),
        http,
    })
}

fn send_err(e: reqwest::Error) -> String {
    if e.is_connect() {
        format!("Could not connect to the storage server: {e}")
    } else if e.is_timeout() {
        format!("The storage server timed out: {e}")
    } else {
        format!("Storage request failed: {e}")
    }
}

fn xml_tag<'a>(body: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let start = body.find(&open)? + open.len();
    let end = body[start..].find(&format!("</{tag}>"))? + start;
    Some(body[start..end].trim())
}

/// "S3 error 403 (AccessDenied): Access Denied" from an S3 XML error body.
fn s3_error(status: u16, body: &str) -> String {
    let code = xml_tag(body, "Code");
    let msg = xml_tag(body, "Message");
    let hint = match status {
        403 => " Check the access key, secret and bucket permissions.",
        404 => " Check the bucket name and endpoint.",
        _ => "",
    };
    match (code, msg) {
        (Some(c), Some(m)) => format!("S3 error {status} ({c}): {m}.{hint}"),
        (Some(c), None) => format!("S3 error {status} ({c}).{hint}"),
        _ => format!("S3 error {status}.{hint}"),
    }
}

async fn check(resp: reqwest::Response) -> Result<reqwest::Response, String> {
    if resp.status().is_success() {
        return Ok(resp);
    }
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    Err(s3_error(status, &body))
}

fn etag_of(resp: &reqwest::Response) -> Option<String> {
    resp.headers().get("etag").and_then(|v| v.to_str().ok()).map(|s| s.to_string())
}

/// Calls `emit` at most every PROGRESS_EVERY; shared by the stream callbacks.
#[derive(Clone)]
struct Reporter {
    inner: Arc<Mutex<(u64, Option<Instant>)>>,
    total: u64,
    upload_id: Arc<Mutex<Option<String>>>,
    emit: Arc<dyn Fn(TransferProgress) + Send + Sync>,
}

impl Reporter {
    fn new(total: u64, emit: Arc<dyn Fn(TransferProgress) + Send + Sync>) -> Self {
        Reporter { inner: Arc::new(Mutex::new((0, None))), total, upload_id: Arc::new(Mutex::new(None)), emit }
    }

    fn progress(&self, done: u64) -> TransferProgress {
        TransferProgress { done, total: self.total, upload_id: self.upload_id.lock().unwrap().clone() }
    }

    fn set(&self, done: u64, force: bool) {
        let mut g = self.inner.lock().unwrap();
        g.0 = done;
        if force || g.1.is_none_or(|t| t.elapsed() >= PROGRESS_EVERY) {
            g.1 = Some(Instant::now());
            drop(g);
            (self.emit)(self.progress(done));
        }
    }

    fn add(&self, n: u64) {
        let done = self.inner.lock().unwrap().0 + n;
        self.set(done, false);
    }

    fn done(&self) -> u64 {
        self.inner.lock().unwrap().0
    }

    fn set_upload_id(&self, id: &str) {
        *self.upload_id.lock().unwrap() = Some(id.to_string());
        let done = self.done();
        self.set(done, true);
    }
}

/// A streaming body over `len` bytes of `file` starting at `offset`.
async fn file_body(path: &Path, offset: u64, len: u64, rep: Reporter) -> Result<reqwest::Body, String> {
    let mut file = tokio::fs::File::open(path).await.map_err(|e| format!("Could not open {}: {e}", path.display()))?;
    file.seek(std::io::SeekFrom::Start(offset))
        .await
        .map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    let stream = ReaderStream::with_capacity(file.take(len), 256 * 1024).inspect(move |chunk| {
        if let Ok(c) = chunk {
            rep.add(c.len() as u64);
        }
    });
    Ok(reqwest::Body::wrap_stream(stream))
}

// ---------- Small objects ----------

pub async fn put_bytes_impl(cfg: &S3Config, key: &str, body: Vec<u8>, content_type: &str) -> Result<PutResult, String> {
    let c = client(cfg)?;
    let size = body.len() as u64;
    let url = c.bucket.put_object(Some(&c.creds), key).sign(PRESIGN);
    let resp = c
        .http
        .put(url)
        .header("content-type", content_type)
        .body(body)
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .map_err(send_err)?;
    let resp = check(resp).await?;
    Ok(PutResult { etag: etag_of(&resp), size })
}

/// None when the object doesn't exist.
pub async fn get_bytes_impl(cfg: &S3Config, key: &str) -> Result<Option<Vec<u8>>, String> {
    let c = client(cfg)?;
    let url = c.bucket.get_object(Some(&c.creds), key).sign(PRESIGN);
    let resp = c.http.get(url).timeout(Duration::from_secs(120)).send().await.map_err(send_err)?;
    if resp.status().as_u16() == 404 {
        return Ok(None);
    }
    let resp = check(resp).await?;
    let bytes = resp.bytes().await.map_err(|e| format!("Could not read the download: {e}"))?;
    Ok(Some(bytes.to_vec()))
}

pub async fn delete_impl(cfg: &S3Config, key: &str) -> Result<(), String> {
    let c = client(cfg)?;
    let url = c.bucket.delete_object(Some(&c.creds), key).sign(PRESIGN);
    let resp = c.http.delete(url).timeout(Duration::from_secs(60)).send().await.map_err(send_err)?;
    // Deleting something that's already gone is fine.
    if resp.status().as_u16() == 404 {
        return Ok(());
    }
    check(resp).await.map(|_| ())
}

// ---------- Listing ----------

fn list_url(c: &Client, prefix: &str, token: Option<&str>, max_keys: Option<usize>) -> reqwest::Url {
    let mut action = ListObjectsV2::new(&c.bucket, Some(&c.creds));
    if !prefix.is_empty() {
        action.with_prefix(prefix);
    }
    if let Some(t) = token {
        action.with_continuation_token(t);
    }
    if let Some(n) = max_keys {
        action.with_max_keys(n);
    }
    action.sign(PRESIGN)
}

/// Every object under `prefix`, following continuation tokens.
pub async fn list_impl(cfg: &S3Config, prefix: &str) -> Result<Vec<S3Object>, String> {
    let c = client(cfg)?;
    let mut out = vec![];
    let mut token: Option<String> = None;
    loop {
        let url = list_url(&c, prefix, token.as_deref(), None);
        let resp = c.http.get(url).timeout(Duration::from_secs(60)).send().await.map_err(send_err)?;
        let text = check(resp).await?.text().await.map_err(|e| format!("Could not read the listing: {e}"))?;
        let parsed = ListObjectsV2::parse_response(&text).map_err(|e| format!("Unexpected listing from the server: {e}"))?;
        out.extend(parsed.contents.into_iter().map(|o| S3Object {
            key: o.key,
            size: o.size.unwrap_or(0),
            etag: o.etag,
            last_modified: o.last_modified,
        }));
        match parsed.next_continuation_token {
            Some(t) if token.as_deref() != Some(t.as_str()) => token = Some(t),
            _ => break,
        }
    }
    Ok(out)
}

/// Lists one key and writes then deletes a small test object, so both read
/// and write permissions are checked.
pub async fn test_impl(cfg: &S3Config, prefix: &str) -> Result<(), String> {
    let c = client(cfg)?;
    let url = list_url(&c, prefix, None, Some(1));
    let resp = c.http.get(url).timeout(Duration::from_secs(30)).send().await.map_err(send_err)?;
    check(resp).await?;
    let key = format!("{}.meeting-helper-test", prefix);
    put_bytes_impl(cfg, &key, b"ok".to_vec(), "text/plain").await?;
    delete_impl(cfg, &key).await
}

// ---------- Files ----------

async fn put_single(c: &Client, key: &str, path: &Path, size: u64, rep: &Reporter) -> Result<PutResult, String> {
    let url = c.bucket.put_object(Some(&c.creds), key).sign(PRESIGN);
    let body = file_body(path, 0, size, rep.clone()).await?;
    let resp = c
        .http
        .put(url)
        .header("content-length", size)
        .header("content-type", crate::upload::guess_mime(path))
        .body(body)
        .send()
        .await
        .map_err(send_err)?;
    let resp = check(resp).await?;
    Ok(PutResult { etag: etag_of(&resp), size })
}

/// Parts already uploaded for `upload_id`, by part number. Err when the upload
/// no longer exists (completed, aborted or expired).
async fn existing_parts(c: &Client, key: &str, upload_id: &str) -> Result<Vec<(u16, String, u64)>, String> {
    let mut parts = vec![];
    let mut marker: Option<u16> = None;
    loop {
        let mut action = ListParts::new(&c.bucket, Some(&c.creds), key, upload_id);
        if let Some(m) = marker {
            action.set_part_number_marker(m);
        }
        let resp = c.http.get(action.sign(PRESIGN)).timeout(Duration::from_secs(60)).send().await.map_err(send_err)?;
        let text = check(resp).await?.text().await.map_err(|e| e.to_string())?;
        let parsed = ListParts::parse_response(&text).map_err(|e| format!("Unexpected part listing: {e}"))?;
        parts.extend(parsed.parts.into_iter().map(|p| (p.number, p.etag, p.size)));
        match parsed.next_part_number_marker {
            Some(m) if Some(m) != marker => marker = Some(m),
            _ => break,
        }
    }
    Ok(parts)
}

fn part_count(size: u64) -> u64 {
    size.div_ceil(PART_SIZE).max(1)
}

async fn put_multipart(
    c: &Client,
    key: &str,
    path: &Path,
    size: u64,
    resume: Option<&str>,
    rep: &Reporter,
) -> Result<PutResult, String> {
    let count = part_count(size);
    if count > 10_000 {
        return Err("File is too large for a multipart upload.".into());
    }
    let mut etags: Vec<Option<String>> = vec![None; count as usize];

    // Resume: keep parts of the expected size that S3 already has.
    let mut upload_id = None;
    if let Some(id) = resume
        && let Ok(parts) = existing_parts(c, key, id).await
    {
        for (n, etag, part_size) in parts {
            let i = n as u64 - 1;
            if n >= 1 && i < count && part_size == PART_SIZE.min(size - i * PART_SIZE) {
                etags[i as usize] = Some(etag);
            }
        }
        upload_id = Some(id.to_string());
    }
    let upload_id = match upload_id {
        Some(id) => id,
        None => {
            let url = CreateMultipartUpload::new(&c.bucket, Some(&c.creds), key).sign(PRESIGN);
            let resp = c
                .http
                .post(url)
                .header("content-type", crate::upload::guess_mime(path))
                .timeout(Duration::from_secs(60))
                .send()
                .await
                .map_err(send_err)?;
            let text = check(resp).await?.text().await.map_err(|e| e.to_string())?;
            CreateMultipartUpload::parse_response(&text)
                .map_err(|e| format!("Unexpected reply to starting the upload: {e}"))?
                .upload_id()
                .to_string()
        }
    };
    rep.set_upload_id(&upload_id);
    let already: u64 = (0..count)
        .filter(|&i| etags[i as usize].is_some())
        .map(|i| PART_SIZE.min(size - i * PART_SIZE))
        .sum();
    rep.set(already, true);

    for i in 0..count {
        if etags[i as usize].is_some() {
            continue;
        }
        let offset = i * PART_SIZE;
        let len = PART_SIZE.min(size - offset);
        let mut attempt = 0;
        loop {
            attempt += 1;
            let before = rep.done();
            let url = UploadPart::new(&c.bucket, Some(&c.creds), key, (i + 1) as u16, &upload_id).sign(PRESIGN);
            let result = async {
                let body = file_body(path, offset, len, rep.clone()).await?;
                let resp = c.http.put(url).header("content-length", len).body(body).send().await.map_err(send_err)?;
                let resp = check(resp).await?;
                etag_of(&resp).ok_or_else(|| "The server returned no ETag for an uploaded part.".to_string())
            }
            .await;
            match result {
                Ok(etag) => {
                    etags[i as usize] = Some(etag);
                    break;
                }
                Err(e) if attempt >= PART_RETRIES => return Err(e),
                Err(_) => {
                    rep.set(before, true);
                    tokio::time::sleep(Duration::from_secs(2 * attempt as u64)).await;
                }
            }
        }
    }

    let tags: Vec<String> = etags.into_iter().map(|e| e.unwrap_or_default()).collect();
    let complete = CompleteMultipartUpload::new(&c.bucket, Some(&c.creds), key, &upload_id, tags.iter().map(|s| s.as_str()));
    let url = complete.sign(PRESIGN);
    let body = complete.body();
    let resp = c.http.post(url).body(body).timeout(Duration::from_secs(300)).send().await.map_err(send_err)?;
    let resp = check(resp).await?;
    let text = resp.text().await.unwrap_or_default();
    // Some servers answer 200 with an error document.
    if text.contains("<Error>") {
        return Err(s3_error(500, &text));
    }
    let etag = xml_tag(&text, "ETag").map(|s| s.replace("&quot;", "\""));
    Ok(PutResult { etag, size })
}

pub async fn put_file_impl(
    cfg: &S3Config,
    key: &str,
    path: &Path,
    resume_upload_id: Option<&str>,
    emit: Arc<dyn Fn(TransferProgress) + Send + Sync>,
) -> Result<PutResult, String> {
    let c = client(cfg)?;
    let size = tokio::fs::metadata(path)
        .await
        .map_err(|e| format!("Could not read {}: {e}", path.display()))?
        .len();
    let rep = Reporter::new(size, emit);
    let res = if size > MULTIPART_THRESHOLD {
        put_multipart(&c, key, path, size, resume_upload_id, &rep).await?
    } else {
        put_single(&c, key, path, size, &rep).await?
    };
    rep.set(size, true);
    Ok(res)
}

/// Downloads to `<path>.part`, then renames, so an interrupted download never
/// looks like a complete recording.
pub async fn get_file_impl(
    cfg: &S3Config,
    key: &str,
    path: &Path,
    emit: Arc<dyn Fn(TransferProgress) + Send + Sync>,
) -> Result<u64, String> {
    let c = client(cfg)?;
    let url = c.bucket.get_object(Some(&c.creds), key).sign(PRESIGN);
    let resp = c.http.get(url).send().await.map_err(send_err)?;
    let resp = check(resp).await?;
    let total = resp.content_length().unwrap_or(0);
    let rep = Reporter::new(total, emit);

    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
    }
    let mut part = PathBuf::from(path).into_os_string();
    part.push(".part");
    let part = PathBuf::from(part);
    let result = async {
        let mut file = tokio::fs::File::create(&part)
            .await
            .map_err(|e| format!("Could not create {}: {e}", part.display()))?;
        let mut stream = resp.bytes_stream();
        let mut written = 0u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("Download interrupted: {e}"))?;
            file.write_all(&chunk).await.map_err(|e| format!("Could not write {}: {e}", part.display()))?;
            written += chunk.len() as u64;
            rep.add(chunk.len() as u64);
        }
        file.flush().await.map_err(|e| e.to_string())?;
        file.sync_all().await.map_err(|e| e.to_string())?;
        if total > 0 && written != total {
            return Err(format!("Download incomplete: got {written} of {total} bytes."));
        }
        Ok::<u64, String>(written)
    }
    .await;
    match result {
        Ok(written) => {
            tokio::fs::rename(&part, path)
                .await
                .map_err(|e| format!("Could not save {}: {e}", path.display()))?;
            rep.set(written, true);
            Ok(written)
        }
        Err(e) => {
            let _ = tokio::fs::remove_file(&part).await;
            Err(e)
        }
    }
}

// ---------- Commands ----------

fn channel_emit(ch: Channel<TransferProgress>) -> Arc<dyn Fn(TransferProgress) + Send + Sync> {
    Arc::new(move |p| {
        let _ = ch.send(p);
    })
}

#[tauri::command]
pub async fn s3_test(config: S3Config, prefix: String) -> Result<(), String> {
    test_impl(&config, &prefix).await
}

#[tauri::command]
pub async fn s3_list(config: S3Config, prefix: String) -> Result<Vec<S3Object>, String> {
    list_impl(&config, &prefix).await
}

#[tauri::command]
pub async fn s3_put_file(
    config: S3Config,
    key: String,
    path: String,
    resume_upload_id: Option<String>,
    on_progress: Channel<TransferProgress>,
) -> Result<PutResult, String> {
    put_file_impl(&config, &key, Path::new(&path), resume_upload_id.as_deref(), channel_emit(on_progress)).await
}

#[tauri::command]
pub async fn s3_get_file(
    config: S3Config,
    key: String,
    path: String,
    on_progress: Channel<TransferProgress>,
) -> Result<u64, String> {
    get_file_impl(&config, &key, Path::new(&path), channel_emit(on_progress)).await
}

#[tauri::command]
pub async fn s3_put_bytes(config: S3Config, key: String, body: Vec<u8>, content_type: String) -> Result<PutResult, String> {
    put_bytes_impl(&config, &key, body, &content_type).await
}

#[tauri::command]
pub async fn s3_get_bytes(config: S3Config, key: String) -> Result<Option<Vec<u8>>, String> {
    get_bytes_impl(&config, &key).await
}

#[tauri::command]
pub async fn s3_delete(config: S3Config, key: String) -> Result<(), String> {
    delete_impl(&config, &key).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(endpoint: &str, path_style: bool) -> S3Config {
        S3Config {
            endpoint: endpoint.into(),
            region: "auto".into(),
            bucket: "meetings".into(),
            path_style,
            access_key_id: "AKIDEXAMPLE".into(),
            secret_access_key: "secret".into(),
        }
    }

    #[test]
    fn presigned_put_url_shape_path_style() {
        let c = client(&cfg("https://acc.r2.cloudflarestorage.com/", true)).unwrap();
        let url = c.bucket.put_object(Some(&c.creds), "backup/meetings/u 1/recording.mp4").sign(PRESIGN);
        let s = url.as_str();
        assert!(s.starts_with("https://acc.r2.cloudflarestorage.com/meetings/backup/meetings/u%201/recording.mp4?"), "{s}");
        assert!(s.contains("X-Amz-Algorithm=AWS4-HMAC-SHA256"));
        assert!(s.contains("X-Amz-Credential=AKIDEXAMPLE%2F"));
        assert!(s.contains("%2Fauto%2Fs3%2Faws4_request"));
        assert!(s.contains("X-Amz-Expires=3600"));
        assert!(s.contains("X-Amz-SignedHeaders=host"));
        assert!(s.contains("X-Amz-Signature="));
        assert!(!s.contains("secret"));
    }

    #[test]
    fn presigned_url_virtual_host_and_list() {
        let c = client(&cfg("https://s3.eu-central-1.amazonaws.com", false)).unwrap();
        let url = c.bucket.get_object(Some(&c.creds), "p/manifest.json").sign(PRESIGN);
        assert!(url.as_str().starts_with("https://meetings.s3.eu-central-1.amazonaws.com/p/manifest.json?"), "{url}");
        let url = list_url(&c, "p/meetings/", Some("tok"), Some(1));
        let s = url.as_str();
        assert!(s.contains("list-type=2"), "{s}");
        assert!(s.contains("prefix=p%2Fmeetings%2F"), "{s}");
        assert!(s.contains("continuation-token=tok"), "{s}");
        assert!(s.contains("max-keys=1"), "{s}");
    }

    #[test]
    fn config_errors_are_readable() {
        assert!(client(&cfg("", true)).err().unwrap().contains("endpoint"));
        assert!(client(&cfg("not a url", true)).err().unwrap().contains("Invalid endpoint"));
        let mut c = cfg("https://x.example", true);
        c.secret_access_key = String::new();
        assert!(client(&c).err().unwrap().contains("secret"));
    }

    #[test]
    fn parses_s3_errors() {
        let body = "<?xml version=\"1.0\"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>";
        let e = s3_error(403, body);
        assert!(e.starts_with("S3 error 403 (AccessDenied): Access Denied."), "{e}");
        assert_eq!(s3_error(500, "garbage"), "S3 error 500.");
    }

    #[test]
    fn parts() {
        assert_eq!(part_count(1), 1);
        assert_eq!(part_count(PART_SIZE), 1);
        assert_eq!(part_count(PART_SIZE + 1), 2);
        assert_eq!(part_count(10 * PART_SIZE), 10);
    }

    // Against a local MinIO:
    //   docker run -p 9000:9000 -e MINIO_ROOT_USER=minio -e MINIO_ROOT_PASSWORD=minio123 minio/minio server /data
    //   (create bucket "test"), then: cargo test s3::tests::minio -- --ignored
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn minio_round_trip() {
        let cfg = S3Config {
            endpoint: "http://127.0.0.1:9000".into(),
            region: "us-east-1".into(),
            bucket: "test".into(),
            path_style: true,
            access_key_id: "minio".into(),
            secret_access_key: "minio123".into(),
        };
        test_impl(&cfg, "mh-test/").await.unwrap();
        put_bytes_impl(&cfg, "mh-test/a.json", b"{}".to_vec(), "application/json").await.unwrap();
        assert_eq!(get_bytes_impl(&cfg, "mh-test/a.json").await.unwrap(), Some(b"{}".to_vec()));
        assert_eq!(get_bytes_impl(&cfg, "mh-test/missing").await.unwrap(), None);

        let dir = std::env::temp_dir().join(format!("mh-s3-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("big.bin");
        let data: Vec<u8> = (0..(MULTIPART_THRESHOLD + 5 * 1024 * 1024)).map(|i| (i % 251) as u8).collect();
        std::fs::write(&src, &data).unwrap();
        put_file_impl(&cfg, "mh-test/big.bin", &src, None, Arc::new(|_| {})).await.unwrap();
        let listed = list_impl(&cfg, "mh-test/").await.unwrap();
        assert!(listed.iter().any(|o| o.key == "mh-test/big.bin" && o.size == data.len() as u64));
        let dst = dir.join("down.bin");
        get_file_impl(&cfg, "mh-test/big.bin", &dst, Arc::new(|_| {})).await.unwrap();
        assert_eq!(std::fs::read(&dst).unwrap(), data);
        for k in ["mh-test/a.json", "mh-test/big.bin"] {
            delete_impl(&cfg, k).await.unwrap();
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
