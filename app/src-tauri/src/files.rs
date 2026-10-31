//! Moving and copying meeting directories and media with progress. Moving
//! between folders on one drive is a cheap rename; across drives (base folder
//! on D:, app data on C:) it becomes copy-then-delete, which for recordings
//! can take minutes, hence the progress channel.

use std::fs::{self, File};
use std::io::{self, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::ipc::Channel;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub done: u64,
    pub total: u64,
}

const BUF_SIZE: usize = 1 << 20;
const PROGRESS_EVERY: Duration = Duration::from_millis(150);

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

fn is_cross_device(err: &io::Error) -> bool {
    if err.kind() == ErrorKind::CrossesDevices {
        return true;
    }
    // ERROR_NOT_SAME_DEVICE on Windows, EXDEV on Unix.
    matches!(err.raw_os_error(), Some(17) if cfg!(windows)) || matches!(err.raw_os_error(), Some(18) if cfg!(unix))
}

fn tree_size(path: &Path) -> io::Result<u64> {
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_dir() {
        return Ok(meta.len());
    }
    let mut total = 0;
    for entry in fs::read_dir(path)? {
        total += tree_size(&entry?.path())?;
    }
    Ok(total)
}

fn copy_file_into<F: FnMut(Progress)>(src: &Path, dst: &Path, rep: &mut Reporter<F>) -> io::Result<()> {
    let mut input = File::open(src)?;
    // create_new: never overwrite something that appeared in the meantime.
    let mut output = File::options().write(true).create_new(true).open(dst)?;
    let mut buf = vec![0u8; BUF_SIZE];
    loop {
        let n = input.read(&mut buf)?;
        if n == 0 {
            break;
        }
        output.write_all(&buf[..n])?;
        rep.add(n as u64);
    }
    output.sync_all()?;
    if let Ok(modified) = input.metadata().and_then(|m| m.modified()) {
        let _ = output.set_modified(modified);
    }
    Ok(())
}

fn copy_tree<F: FnMut(Progress)>(src: &Path, dst: &Path, rep: &mut Reporter<F>) -> io::Result<()> {
    if fs::symlink_metadata(src)?.is_dir() {
        fs::create_dir(dst)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            copy_tree(&entry.path(), &dst.join(entry.file_name()), rep)?;
        }
        Ok(())
    } else {
        copy_file_into(src, dst, rep)
    }
}

fn remove_tree(path: &Path) -> io::Result<()> {
    if fs::symlink_metadata(path)?.is_dir() { fs::remove_dir_all(path) } else { fs::remove_file(path) }
}

fn prepare(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.exists() {
        return Err(format!("{} doesn't exist", src.display()));
    }
    if dst.exists() {
        return Err(format!("{} already exists", dst.display()));
    }
    if dst.starts_with(src) {
        return Err("Can't move a folder into itself".into());
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
    }
    Ok(())
}

/// Copies `src` (file or directory) to `dst`. On failure the partial copy is
/// removed so a retry starts clean.
pub fn copy_impl(src: &Path, dst: &Path, emit: impl FnMut(Progress)) -> Result<(), String> {
    prepare(src, dst)?;
    let total = tree_size(src).map_err(|e| format!("Couldn't read {}: {e}", src.display()))?;
    let mut rep = Reporter::new(total, emit);
    if let Err(e) = copy_tree(src, dst, &mut rep) {
        let _ = remove_tree(dst);
        return Err(format!("Couldn't copy {} to {}: {e}", src.display(), dst.display()));
    }
    rep.finish();
    Ok(())
}

/// Moves `src` to `dst` (which must not exist): a rename when possible,
/// otherwise copy then delete. `force_copy` exercises the fallback in tests.
pub fn move_impl(src: &Path, dst: &Path, force_copy: bool, emit: impl FnMut(Progress)) -> Result<(), String> {
    prepare(src, dst)?;
    let mut emit = emit;
    if !force_copy {
        match fs::rename(src, dst) {
            Ok(()) => {
                emit(Progress { done: 1, total: 1 });
                return Ok(());
            }
            Err(e) if is_cross_device(&e) => {}
            Err(e) => return Err(format!("Couldn't move {} to {}: {e}", src.display(), dst.display())),
        }
    }
    copy_impl(src, dst, emit)?;
    // The copy is complete; a source that won't delete (a file open in a
    // player) is left behind rather than failing the move.
    if let Err(e) = remove_tree(src) {
        eprintln!("move_path: copied, but couldn't remove {}: {e}", src.display());
    }
    Ok(())
}

#[tauri::command]
pub async fn move_path(src: String, dst: String, on_progress: Channel<Progress>) -> Result<(), String> {
    let (src, dst) = (PathBuf::from(src), PathBuf::from(dst));
    tauri::async_runtime::spawn_blocking(move || {
        move_impl(&src, &dst, false, |p| {
            let _ = on_progress.send(p);
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn copy_file_progress(src: String, dst: String, on_progress: Channel<Progress>) -> Result<(), String> {
    let (src, dst) = (PathBuf::from(src), PathBuf::from(dst));
    tauri::async_runtime::spawn_blocking(move || {
        copy_impl(&src, &dst, |p| {
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

    // A fresh empty directory under the system temp dir, removed on drop.
    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> TempDir {
            static N: AtomicU32 = AtomicU32::new(0);
            let p = std::env::temp_dir().join(format!(
                "mh-files-test-{}-{}",
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

    fn sample_meeting(dir: &Path) -> PathBuf {
        let m = dir.join("2026-10-31 10-00 Weekly");
        fs::create_dir_all(m.join("sub")).unwrap();
        fs::write(m.join("recording.mp4"), vec![7u8; 3 * BUF_SIZE + 5]).unwrap();
        fs::write(m.join("meeting.json"), b"{}").unwrap();
        fs::write(m.join("sub").join("notes.txt"), b"hi").unwrap();
        m
    }

    fn assert_sample(m: &Path) {
        assert_eq!(fs::read(m.join("recording.mp4")).unwrap().len(), 3 * BUF_SIZE + 5);
        assert_eq!(fs::read(m.join("meeting.json")).unwrap(), b"{}");
        assert_eq!(fs::read(m.join("sub").join("notes.txt")).unwrap(), b"hi");
    }

    #[test]
    fn renames_directory_into_new_parent() {
        let t = TempDir::new();
        let src = sample_meeting(&t.0);
        let dst = t.0.join("Base").join("Unsorted").join("moved");
        let mut events = vec![];
        move_impl(&src, &dst, false, |p| events.push(p)).unwrap();
        assert!(!src.exists());
        assert_sample(&dst);
        assert_eq!(events.last(), Some(&Progress { done: 1, total: 1 }));
    }

    #[test]
    fn copy_fallback_moves_everything_and_reports_bytes() {
        let t = TempDir::new();
        let src = sample_meeting(&t.0);
        let dst = t.0.join("other").join("moved");
        let mut events = vec![];
        move_impl(&src, &dst, true, |p| events.push(p)).unwrap();
        assert!(!src.exists());
        assert_sample(&dst);
        let total = (3 * BUF_SIZE + 5 + 2 + 2) as u64;
        assert_eq!(events.last(), Some(&Progress { done: total, total }));
        assert!(events.windows(2).all(|w| w[0].done <= w[1].done));
    }

    #[test]
    fn moves_single_file() {
        let t = TempDir::new();
        let src = t.0.join("a.m4a");
        fs::write(&src, b"audio").unwrap();
        let dst = t.0.join("x").join("b.m4a");
        move_impl(&src, &dst, true, |_| {}).unwrap();
        assert_eq!(fs::read(&dst).unwrap(), b"audio");
        assert!(!src.exists());
    }

    #[test]
    fn refuses_existing_destination_and_missing_source() {
        let t = TempDir::new();
        let src = sample_meeting(&t.0);
        let dst = t.0.join("taken");
        fs::create_dir_all(&dst).unwrap();
        assert!(move_impl(&src, &dst, false, |_| {}).unwrap_err().contains("already exists"));
        assert!(src.exists());
        assert!(move_impl(&t.0.join("nope"), &t.0.join("y"), false, |_| {}).unwrap_err().contains("doesn't exist"));
    }

    #[test]
    fn refuses_moving_into_itself() {
        let t = TempDir::new();
        let src = sample_meeting(&t.0);
        let dst = src.join("inner");
        assert!(move_impl(&src, &dst, true, |_| {}).is_err());
        assert_sample(&src);
    }

    #[test]
    fn copy_keeps_source() {
        let t = TempDir::new();
        let src = t.0.join("in.mp3");
        fs::write(&src, b"abc").unwrap();
        let dst = t.0.join("meeting").join("recording.mp3");
        let mut last = None;
        copy_impl(&src, &dst, |p| last = Some(p)).unwrap();
        assert_eq!(fs::read(&dst).unwrap(), b"abc");
        assert!(src.exists());
        assert_eq!(last, Some(Progress { done: 3, total: 3 }));
    }
}
