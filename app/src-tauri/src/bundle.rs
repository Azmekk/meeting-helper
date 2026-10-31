//! Zip export and import of meeting bundles. The TS side decides what goes in
//! (meeting directories, staged meeting.json/folder.json files, manifest) and
//! reads what comes out; this module only streams bytes in and out of the zip,
//! so recordings are never held in memory.
//!
//! Zip layout (same shape as the cloud backup):
//!   manifest.json
//!   folders/<folder uid>/folder.json
//!   meetings/<meeting uid>/meeting.json, recording.mp4, transcript.md, …
//! Each meetings/<uid>/ directory is a copy of the meeting's bundle directory,
//! so meeting.json's file names resolve relative to it after extraction.

use std::fs::{self, File};
use std::io::{self, BufReader, BufWriter, Read, Seek, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::ipc::Channel;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::files::Progress;

const BUF_SIZE: usize = 1 << 20;
const PROGRESS_EVERY: Duration = Duration::from_millis(150);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZipDirEntry {
    pub src_dir: String,
    pub zip_prefix: String,
    /// Top-level names in `src_dir` to leave out (e.g. a meeting.json that a
    /// staged copy replaces).
    #[serde(default)]
    pub skip: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZipExtraFile {
    pub src: String,
    pub zip_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportZipArgs {
    pub entries: Vec<ZipDirEntry>,
    #[serde(default)]
    pub extra_files: Vec<ZipExtraFile>,
    pub out_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportZipArgs {
    pub zip_path: String,
    pub dest_dir: String,
}

/// Calls `emit` at most every PROGRESS_EVERY, plus once at the end.
struct Reporter<F: FnMut(Progress)> {
    emit: F,
    total: u64,
    done: u64,
    last: Option<Instant>,
}

impl<F: FnMut(Progress)> Reporter<F> {
    fn new(total: u64, emit: F) -> Self {
        Reporter { emit, total, done: 0, last: None }
    }

    fn add(&mut self, n: u64) {
        self.done += n;
        if self.last.is_none_or(|t| t.elapsed() >= PROGRESS_EVERY) {
            self.last = Some(Instant::now());
            (self.emit)(Progress { done: self.done, total: self.total });
        }
    }

    fn finish(&mut self) {
        (self.emit)(Progress { done: self.total, total: self.total });
    }
}

/// A zip entry name as a safe relative path: no `..`, no root or drive, no
/// empty name. Backslashes count as separators (zips made on Windows).
pub fn safe_relative(name: &str) -> Option<PathBuf> {
    let name = name.replace('\\', "/");
    if name.is_empty() || name.starts_with('/') || name.contains(':') || name.contains('\0') {
        return None;
    }
    let mut out = PathBuf::new();
    for part in name.split('/') {
        match part {
            "" | "." => continue,
            ".." => return None,
            p => out.push(p),
        }
    }
    // Belt and braces: the joined path must have only normal components.
    if out.as_os_str().is_empty() || !out.components().all(|c| matches!(c, Component::Normal(_))) {
        return None;
    }
    Some(out)
}

fn zip_name(rel: &Path) -> String {
    rel.components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

// Recordings are already compressed; deflating them only costs time.
fn is_compressed(path: &Path) -> bool {
    let ext = path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).unwrap_or_default();
    matches!(
        ext.as_str(),
        "mp4" | "mkv" | "mov" | "webm" | "m4a" | "mp3" | "aac" | "ogg" | "oga" | "opus" | "flac" | "weba" | "jpg"
            | "jpeg" | "png" | "zip" | "gz"
    )
}

fn walk(dir: &Path, rel: &Path, skip: &[String], out: &mut Vec<(PathBuf, PathBuf)>) -> io::Result<()> {
    let mut entries: Vec<_> = fs::read_dir(dir)?.collect::<Result<_, _>>()?;
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let name = entry.file_name();
        if rel.as_os_str().is_empty() && skip.iter().any(|s| *s == name.to_string_lossy()) {
            continue;
        }
        let path = entry.path();
        let meta = fs::symlink_metadata(&path)?;
        if meta.is_dir() {
            walk(&path, &rel.join(&name), skip, out)?;
        } else if meta.is_file() {
            out.push((path, rel.join(&name)));
        }
    }
    Ok(())
}

/// Files to write as (source, zip name), in a stable order.
fn collect(args: &ExportZipArgs) -> Result<Vec<(PathBuf, String)>, String> {
    let mut files = vec![];
    for e in &args.entries {
        let prefix = safe_relative(&e.zip_prefix).ok_or_else(|| format!("Unsafe zip path: {}", e.zip_prefix))?;
        let src = Path::new(&e.src_dir);
        let mut found = vec![];
        walk(src, Path::new(""), &e.skip, &mut found).map_err(|err| format!("Couldn't read {}: {err}", src.display()))?;
        for (path, rel) in found {
            files.push((path, zip_name(&prefix.join(rel))));
        }
    }
    for f in &args.extra_files {
        let rel = safe_relative(&f.zip_path).ok_or_else(|| format!("Unsafe zip path: {}", f.zip_path))?;
        files.push((PathBuf::from(&f.src), zip_name(&rel)));
    }
    let mut seen = std::collections::HashSet::new();
    for (_, name) in &files {
        if !seen.insert(name.to_ascii_lowercase()) {
            return Err(format!("Two files would be stored as {name}"));
        }
    }
    Ok(files)
}

fn write_zip<F: FnMut(Progress)>(files: &[(PathBuf, String)], out: &Path, emit: F) -> Result<(), String> {
    let mut sizes = vec![];
    for (path, _) in files {
        sizes.push(fs::metadata(path).map_err(|e| format!("Couldn't read {}: {e}", path.display()))?.len());
    }
    let mut rep = Reporter::new(sizes.iter().sum(), emit);
    let file = File::create(out).map_err(|e| format!("Couldn't create {}: {e}", out.display()))?;
    let mut zip = ZipWriter::new(BufWriter::with_capacity(BUF_SIZE, file));
    let mut buf = vec![0u8; BUF_SIZE];
    for ((path, name), size) in files.iter().zip(sizes) {
        let method = if is_compressed(path) { CompressionMethod::Stored } else { CompressionMethod::Deflated };
        let options = SimpleFileOptions::default()
            .compression_method(method)
            .large_file(size >= u32::MAX as u64);
        zip.start_file(name.as_str(), options).map_err(|e| format!("Couldn't add {name}: {e}"))?;
        let mut input = File::open(path).map_err(|e| format!("Couldn't open {}: {e}", path.display()))?;
        loop {
            let n = input.read(&mut buf).map_err(|e| format!("Couldn't read {}: {e}", path.display()))?;
            if n == 0 {
                break;
            }
            zip.write_all(&buf[..n]).map_err(|e| format!("Couldn't write the zip: {e}"))?;
            rep.add(n as u64);
        }
    }
    let mut inner = zip.finish().map_err(|e| format!("Couldn't finish the zip: {e}"))?;
    inner.flush().map_err(|e| format!("Couldn't write the zip: {e}"))?;
    inner
        .into_inner()
        .map_err(|e| format!("Couldn't write the zip: {e}"))?
        .sync_all()
        .map_err(|e| format!("Couldn't write the zip: {e}"))?;
    rep.finish();
    Ok(())
}

/// Writes the zip next to `out_path` first and renames it at the end, so a
/// failed export never leaves a half-written file under the chosen name.
pub fn export_zip_impl(args: &ExportZipArgs, emit: impl FnMut(Progress)) -> Result<u64, String> {
    let files = collect(args)?;
    let out = PathBuf::from(&args.out_path);
    let part = out.with_extension("zip.part");
    if let Err(e) = write_zip(&files, &part, emit) {
        let _ = fs::remove_file(&part);
        return Err(e);
    }
    if out.exists() {
        // The save dialog already asked about overwriting.
        fs::remove_file(&out).map_err(|e| format!("Couldn't replace {}: {e}", out.display()))?;
    }
    fs::rename(&part, &out).map_err(|e| format!("Couldn't save {}: {e}", out.display()))?;
    Ok(files.len() as u64)
}

fn extract<R: Read + Seek, F: FnMut(Progress)>(zip: &mut ZipArchive<R>, dest: &Path, emit: F) -> Result<Vec<String>, String> {
    // Check every name before writing anything.
    let mut plan = vec![];
    let mut total = 0;
    for i in 0..zip.len() {
        let f = zip.by_index(i).map_err(|e| format!("Couldn't read the zip: {e}"))?;
        let rel = safe_relative(f.name()).ok_or_else(|| format!("The zip contains an unsafe path: {}", f.name()))?;
        if f.enclosed_name().is_none() {
            return Err(format!("The zip contains an unsafe path: {}", f.name()));
        }
        if !f.is_dir() {
            total += f.size();
        }
        plan.push((i, rel, f.is_dir()));
    }

    let mut rep = Reporter::new(total, emit);
    let mut buf = vec![0u8; BUF_SIZE];
    let mut written = vec![];
    for (i, rel, is_dir) in plan {
        let target = dest.join(&rel);
        if is_dir {
            fs::create_dir_all(&target).map_err(|e| format!("Couldn't create {}: {e}", target.display()))?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
        }
        let mut f = zip.by_index(i).map_err(|e| format!("Couldn't read the zip: {e}"))?;
        let mut out = File::create(&target).map_err(|e| format!("Couldn't create {}: {e}", target.display()))?;
        loop {
            let n = f.read(&mut buf).map_err(|e| format!("Couldn't unpack {}: {e}", rel.display()))?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n]).map_err(|e| format!("Couldn't write {}: {e}", target.display()))?;
            rep.add(n as u64);
        }
        written.push(zip_name(&rel));
    }
    rep.finish();
    Ok(written)
}

/// Unpacks the zip into `dest_dir` (created if missing). Returns the relative
/// paths of the extracted files ('/'-separated). Unsafe names (`..`, absolute
/// paths) fail the whole import before anything is written.
pub fn import_zip_impl(args: &ImportZipArgs, emit: impl FnMut(Progress)) -> Result<Vec<String>, String> {
    let path = Path::new(&args.zip_path);
    let file = File::open(path).map_err(|e| format!("Couldn't open {}: {e}", path.display()))?;
    let mut zip = ZipArchive::new(BufReader::with_capacity(BUF_SIZE, file)).map_err(|e| format!("Not a valid zip file: {e}"))?;
    let dest = Path::new(&args.dest_dir);
    fs::create_dir_all(dest).map_err(|e| format!("Couldn't create {}: {e}", dest.display()))?;
    extract(&mut zip, dest, emit)
}

/// Reads one text entry (e.g. manifest.json) without unpacking the zip, so the
/// importer can look inside first. None when the entry isn't there.
pub fn read_zip_text_impl(zip_path: &str, name: &str) -> Result<Option<String>, String> {
    const MAX_TEXT: u64 = 256 << 20;
    let path = Path::new(zip_path);
    let file = File::open(path).map_err(|e| format!("Couldn't open {}: {e}", path.display()))?;
    let mut zip = ZipArchive::new(BufReader::new(file)).map_err(|e| format!("Not a valid zip file: {e}"))?;
    let mut f = match zip.by_name(name) {
        Ok(f) => f,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(e) => return Err(format!("Couldn't read the zip: {e}")),
    };
    if f.size() > MAX_TEXT {
        return Err(format!("{name} is too large"));
    }
    let mut text = String::new();
    f.read_to_string(&mut text).map_err(|e| format!("Couldn't read {name}: {e}"))?;
    Ok(Some(text))
}

#[tauri::command]
pub async fn read_zip_text(zip_path: String, name: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || read_zip_text_impl(&zip_path, &name))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn export_zip(args: ExportZipArgs, on_progress: Channel<Progress>) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        export_zip_impl(&args, |p| {
            let _ = on_progress.send(p);
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn import_zip(args: ImportZipArgs, on_progress: Channel<Progress>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        import_zip_impl(&args, |p| {
            let _ = on_progress.send(p);
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> TempDir {
            static N: AtomicU32 = AtomicU32::new(0);
            let p = std::env::temp_dir().join(format!(
                "mh-bundle-test-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::SeqCst)
            ));
            let _ = fs::remove_dir_all(&p);
            fs::create_dir_all(&p).unwrap();
            TempDir(p)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn safe_relative_rejects_traversal_and_absolute() {
        assert_eq!(safe_relative("meetings/a/meeting.json"), Some(PathBuf::from("meetings").join("a").join("meeting.json")));
        assert_eq!(safe_relative("a\\b.txt"), Some(PathBuf::from("a").join("b.txt")));
        assert_eq!(safe_relative("./a//b"), Some(PathBuf::from("a").join("b")));
        for bad in ["../x", "a/../../x", "a/..", "/etc/passwd", "\\x", "C:/x", "C:x", "", "./", "a\0b"] {
            assert_eq!(safe_relative(bad), None, "{bad:?} should be rejected");
        }
    }

    #[test]
    fn round_trip() {
        let t = TempDir::new();
        let meeting = t.0.join("Base").join("Work").join("2026-10-31 10-00 Weekly");
        fs::create_dir_all(meeting.join("sub")).unwrap();
        let big = vec![3u8; 2 * BUF_SIZE + 17];
        fs::write(meeting.join("recording.mp4"), &big).unwrap();
        fs::write(meeting.join("meeting.json"), b"old").unwrap();
        fs::write(meeting.join("transcript.md"), b"# Weekly").unwrap();
        fs::write(meeting.join("sub").join("x.txt"), b"x").unwrap();
        let staged = t.0.join("staged-meeting.json");
        fs::write(&staged, b"{\"new\":true}").unwrap();
        let manifest = t.0.join("manifest.json");
        fs::write(&manifest, b"{}").unwrap();

        let out = t.0.join("export.zip");
        let args = ExportZipArgs {
            entries: vec![ZipDirEntry { src_dir: s(&meeting), zip_prefix: "meetings/uid-1".into(), skip: vec!["meeting.json".into()] }],
            extra_files: vec![
                ZipExtraFile { src: s(&staged), zip_path: "meetings/uid-1/meeting.json".into() },
                ZipExtraFile { src: s(&manifest), zip_path: "manifest.json".into() },
            ],
            out_path: s(&out),
        };
        let mut events = vec![];
        assert_eq!(export_zip_impl(&args, |p| events.push(p)).unwrap(), 5);
        assert!(out.exists());
        assert!(!out.with_extension("zip.part").exists());
        let total = (big.len() + 8 + 1 + 12 + 2) as u64;
        assert_eq!(events.last(), Some(&Progress { done: total, total }));

        let dest = t.0.join("import");
        let mut events = vec![];
        let mut files = import_zip_impl(&ImportZipArgs { zip_path: s(&out), dest_dir: s(&dest) }, |p| events.push(p)).unwrap();
        files.sort();
        assert_eq!(
            files,
            vec![
                "manifest.json",
                "meetings/uid-1/meeting.json",
                "meetings/uid-1/recording.mp4",
                "meetings/uid-1/sub/x.txt",
                "meetings/uid-1/transcript.md",
            ]
        );
        let m = dest.join("meetings").join("uid-1");
        assert_eq!(fs::read(m.join("recording.mp4")).unwrap(), big);
        assert_eq!(fs::read(m.join("meeting.json")).unwrap(), b"{\"new\":true}");
        assert_eq!(fs::read(m.join("sub").join("x.txt")).unwrap(), b"x");
        assert_eq!(events.last(), Some(&Progress { done: total, total }));
    }

    #[test]
    fn export_rejects_bad_paths_and_duplicates() {
        let t = TempDir::new();
        let f = t.0.join("a.txt");
        fs::write(&f, b"a").unwrap();
        let mk = |zip_path: &str| ExportZipArgs {
            entries: vec![],
            extra_files: vec![ZipExtraFile { src: s(&f), zip_path: zip_path.into() }],
            out_path: s(&t.0.join("o.zip")),
        };
        assert!(export_zip_impl(&mk("../a.txt"), |_| {}).unwrap_err().contains("Unsafe"));
        let mut dup = mk("x/a.txt");
        dup.extra_files.push(ZipExtraFile { src: s(&f), zip_path: "X/A.txt".into() });
        assert!(export_zip_impl(&dup, |_| {}).unwrap_err().contains("Two files"));
        assert!(!t.0.join("o.zip").exists());
    }

    fn evil_zip(path: &Path, name: &str) {
        let mut zip = ZipWriter::new(File::create(path).unwrap());
        zip.start_file("ok.txt", SimpleFileOptions::default()).unwrap();
        zip.write_all(b"fine").unwrap();
        zip.start_file(name, SimpleFileOptions::default()).unwrap();
        zip.write_all(b"evil").unwrap();
        zip.finish().unwrap();
    }

    #[test]
    fn import_rejects_traversal_before_writing() {
        let t = TempDir::new();
        for (i, name) in ["../evil.txt", "a/../../evil.txt", "/abs-evil.txt", "C:/evil.txt"].iter().enumerate() {
            let z = t.0.join(format!("evil{i}.zip"));
            evil_zip(&z, name);
            let dest = t.0.join(format!("dest{i}"));
            let err = import_zip_impl(&ImportZipArgs { zip_path: s(&z), dest_dir: s(&dest) }, |_| {}).unwrap_err();
            assert!(err.contains("unsafe path"), "{name}: {err}");
            assert!(!dest.join("ok.txt").exists(), "nothing is written when a name is unsafe");
            assert!(!t.0.join("evil.txt").exists());
        }
    }
}
