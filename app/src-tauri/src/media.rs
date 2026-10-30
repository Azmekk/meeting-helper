//! ffmpeg / ffprobe helpers: version check, probing, audio extraction, remux.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStream {
    pub audio_index: u32,
    pub codec: String,
    pub channels: u32,
    pub title: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub duration_ms: u64,
    pub has_video: bool,
    pub video_codec: Option<String>,
    pub audio_streams: Vec<AudioStream>,
}

/// Resolved ffmpeg / ffprobe executables.
#[derive(Debug, Clone)]
pub struct Tools {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
}

impl Tools {
    /// Empty setting = use PATH; otherwise the given ffmpeg.exe and the
    /// ffprobe.exe in the same folder.
    pub fn resolve(ffmpeg_path: &str) -> Tools {
        let p = ffmpeg_path.trim().trim_matches('"');
        if p.is_empty() {
            // Apps opened from Finder don't get the shell's PATH, so Homebrew's
            // folders aren't searched; look there before falling back to PATH.
            #[cfg(target_os = "macos")]
            for dir in ["/opt/homebrew/bin", "/usr/local/bin"] {
                let ffmpeg = Path::new(dir).join("ffmpeg");
                if ffmpeg.is_file() {
                    return Tools { ffprobe: Path::new(dir).join("ffprobe"), ffmpeg };
                }
            }
            return Tools {
                ffmpeg: "ffmpeg".into(),
                ffprobe: "ffprobe".into(),
            };
        }
        let ffmpeg = PathBuf::from(p);
        let probe_name = if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" };
        let ffprobe = match ffmpeg.parent() {
            Some(dir) if !dir.as_os_str().is_empty() => dir.join(probe_name),
            _ => PathBuf::from(probe_name),
        };
        Tools { ffmpeg, ffprobe }
    }
}

fn command(program: &Path) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn tool_name(program: &Path) -> String {
    program
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| program.display().to_string())
}

fn not_found_message(program: &Path) -> String {
    format!(
        "Could not find {} ({}). Install FFmpeg (for example `winget install Gyan.FFmpeg`, then restart the app) \
         or set the full path to ffmpeg.exe in Settings (ffprobe.exe must be in the same folder).",
        tool_name(program),
        program.display()
    )
}

fn stderr_tail(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let start = lines.len().saturating_sub(15);
    lines[start..].join("\n")
}

const SPAWN_ERR_PREFIXES: [&str; 2] = ["Could not find ", "Could not start "];

/// Runs a command to completion, mapping spawn failures and non-zero exits to
/// readable errors that include the tail of stderr.
fn run(program: &Path, args: &[String], what: &str) -> Result<Output, String> {
    let out = command(program).args(args).output().map_err(|e| {
        if e.kind() == ErrorKind::NotFound {
            not_found_message(program)
        } else {
            format!("Could not start {}: {e}", program.display())
        }
    })?;
    if !out.status.success() {
        let tail = stderr_tail(&out.stderr);
        let code = out
            .status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "?".into());
        let name = tool_name(program);
        return Err(if tail.is_empty() {
            format!("{what} failed ({name} exited with code {code}).")
        } else {
            format!("{what} failed ({name} exited with code {code}):\n{tail}")
        });
    }
    Ok(out)
}

fn ensure_parent(output: &Path) -> Result<(), String> {
    if let Some(dir) = output.parent()
        && !dir.as_os_str().is_empty()
    {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("Could not create folder {}: {e}", dir.display()))?;
    }
    Ok(())
}

fn s(v: impl Into<String>) -> String {
    v.into()
}

fn path_arg(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn require_file(p: &Path) -> Result<(), String> {
    if p.is_file() {
        Ok(())
    } else {
        Err(format!("File not found: {}", p.display()))
    }
}

// ---------------------------------------------------------------------------

pub fn ffmpeg_version_impl(ffmpeg_path: &str) -> Result<String, String> {
    let tools = Tools::resolve(ffmpeg_path);
    let out = run(&tools.ffmpeg, &[s("-version")], "ffmpeg -version")?;
    run(&tools.ffprobe, &[s("-version")], "ffprobe -version")?;
    let text = String::from_utf8_lossy(&out.stdout);
    Ok(text.lines().next().unwrap_or("").trim().to_string())
}

fn tag_title(stream: &Value) -> Option<String> {
    stream
        .get("tags")?
        .as_object()?
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("title"))
        .and_then(|(_, v)| v.as_str())
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
}

fn as_num(x: Option<&Value>) -> Option<f64> {
    let x = x?;
    x.as_f64().or_else(|| x.as_str()?.trim().parse().ok())
}

/// Parses `ffprobe -show_streams -show_format -of json` output.
pub fn parse_probe(json: &str) -> Result<MediaInfo, String> {
    let v: Value =
        serde_json::from_str(json).map_err(|e| format!("Could not parse ffprobe output: {e}"))?;
    let empty = Vec::new();
    let streams = v
        .get("streams")
        .and_then(|s| s.as_array())
        .unwrap_or(&empty);

    let mut duration = as_num(v.get("format").and_then(|f| f.get("duration")));
    let mut has_video = false;
    let mut video_codec = None;
    let mut audio_streams = Vec::new();
    for st in streams {
        let codec = st
            .get("codec_name")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string();
        match st.get("codec_type").and_then(|t| t.as_str()) {
            Some("video") => {
                let attached = st
                    .get("disposition")
                    .and_then(|d| d.get("attached_pic"))
                    .and_then(|a| a.as_i64())
                    .unwrap_or(0)
                    != 0;
                if !attached && !has_video {
                    has_video = true;
                    video_codec = Some(codec).filter(|c| !c.is_empty());
                }
            }
            Some("audio") => {
                audio_streams.push(AudioStream {
                    audio_index: audio_streams.len() as u32,
                    codec,
                    channels: st.get("channels").and_then(|c| c.as_u64()).unwrap_or(0) as u32,
                    title: tag_title(st),
                });
            }
            _ => {}
        }
        // Fallback when the container reports no duration.
        if duration.is_none() {
            duration = as_num(st.get("duration"));
        }
    }
    let duration_ms = duration
        .filter(|d| d.is_finite() && *d > 0.0)
        .map(|d| (d * 1000.0).round() as u64)
        .unwrap_or(0);
    Ok(MediaInfo {
        duration_ms,
        has_video,
        video_codec,
        audio_streams,
    })
}

pub fn probe_media_impl(path: &Path, ffmpeg_path: &str) -> Result<MediaInfo, String> {
    require_file(path)?;
    let tools = Tools::resolve(ffmpeg_path);
    let args = [
        s("-v"),
        s("error"),
        s("-show_streams"),
        s("-show_format"),
        s("-of"),
        s("json"),
        path_arg(path),
    ];
    let out = run(&tools.ffprobe, &args, "Reading media info")?;
    parse_probe(&String::from_utf8_lossy(&out.stdout))
}

fn amix_supports_normalize(tools: &Tools) -> bool {
    run(
        &tools.ffmpeg,
        &[s("-hide_banner"), s("-h"), s("filter=amix")],
        "ffmpeg -h",
    )
    .map(|o| String::from_utf8_lossy(&o.stdout).contains("normalize"))
    .unwrap_or(false)
}

pub fn extract_audio_impl(
    input: &Path,
    output: &Path,
    audio_index: Option<u32>,
    ffmpeg_path: &str,
) -> Result<(), String> {
    require_file(input)?;
    let tools = Tools::resolve(ffmpeg_path);
    ensure_parent(output)?;

    let mut args = vec![
        s("-y"),
        s("-hide_banner"),
        s("-loglevel"),
        s("error"),
        s("-i"),
        path_arg(input),
    ];
    match audio_index {
        Some(n) => args.extend([s("-map"), format!("0:a:{n}")]),
        None => {
            let info = probe_media_impl(input, ffmpeg_path)?;
            let count = info.audio_streams.len();
            match count {
                0 => return Err(format!("{} has no audio.", input.display())),
                1 => args.extend([s("-map"), s("0:a:0")]),
                _ => {
                    let inputs: String = (0..count).map(|i| format!("[0:a:{i}]")).collect();
                    let normalize = if amix_supports_normalize(&tools) {
                        ":normalize=0"
                    } else {
                        ""
                    };
                    args.extend([
                        s("-filter_complex"),
                        format!(
                            "{inputs}amix=inputs={count}:duration=longest:dropout_transition=0{normalize}[mix]"
                        ),
                        s("-map"),
                        s("[mix]"),
                    ]);
                }
            }
        }
    }
    args.extend([
        s("-vn"),
        s("-ac"),
        s("1"),
        s("-ar"),
        s("16000"),
        s("-c:a"),
        s("flac"),
        path_arg(output),
    ]);
    run(&tools.ffmpeg, &args, "Extracting audio")?;
    Ok(())
}

pub fn remux_to_mp4_impl(input: &Path, output: &Path, ffmpeg_path: &str) -> Result<(), String> {
    require_file(input)?;
    let tools = Tools::resolve(ffmpeg_path);
    ensure_parent(output)?;

    let build = |codec_args: &[&str]| -> Vec<String> {
        let mut a = vec![
            s("-y"),
            s("-hide_banner"),
            s("-loglevel"),
            s("error"),
            s("-i"),
            path_arg(input),
            s("-map"),
            s("0:v?"),
            s("-map"),
            s("0:a?"),
        ];
        a.extend(codec_args.iter().map(|x| s(*x)));
        a.extend([s("-movflags"), s("+faststart"), path_arg(output)]);
        a
    };

    match run(&tools.ffmpeg, &build(&["-c", "copy"]), "Converting to MP4") {
        Ok(_) => Ok(()),
        Err(copy_err) => {
            // Re-encoding won't help if ffmpeg can't even be started.
            if SPAWN_ERR_PREFIXES.iter().any(|p| copy_err.starts_with(p)) {
                return Err(copy_err);
            }
            run(
                &tools.ffmpeg,
                &build(&["-c:v", "copy", "-c:a", "aac", "-b:a", "160k"]),
                "Converting to MP4",
            )
            .map(|_| ())
            .map_err(|e| format!("{e}\n(Stream copy had also failed: {copy_err})"))
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri commands: the blocking work runs on a background thread.

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("Background task failed: {e}"))?
}

#[tauri::command]
pub async fn ffmpeg_version(ffmpeg_path: String) -> Result<String, String> {
    blocking(move || ffmpeg_version_impl(&ffmpeg_path)).await
}

#[tauri::command]
pub async fn probe_media(path: String, ffmpeg_path: String) -> Result<MediaInfo, String> {
    blocking(move || probe_media_impl(Path::new(&path), &ffmpeg_path)).await
}

#[tauri::command]
pub async fn extract_audio(
    input: String,
    output: String,
    audio_index: Option<u32>,
    ffmpeg_path: String,
) -> Result<(), String> {
    blocking(move || {
        extract_audio_impl(
            Path::new(&input),
            Path::new(&output),
            audio_index,
            &ffmpeg_path,
        )
    })
    .await
}

#[tauri::command]
pub async fn remux_to_mp4(
    input: String,
    output: String,
    ffmpeg_path: String,
) -> Result<(), String> {
    blocking(move || remux_to_mp4_impl(Path::new(&input), Path::new(&output), &ffmpeg_path)).await
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::OnceLock;

    fn test_dir() -> PathBuf {
        let d = std::env::temp_dir().join("meeting-helper-media-tests");
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn ffmpeg(args: &[&str], out: &Path) {
        let mut a: Vec<String> = args.iter().map(|x| x.to_string()).collect();
        a.push(path_arg(out));
        run(Path::new("ffmpeg"), &a, "Generating test file").unwrap();
    }

    /// 3 s testsrc video + three sine tracks (titled like OBS tracks) in .mkv.
    fn sample_mkv() -> &'static PathBuf {
        static SAMPLE: OnceLock<PathBuf> = OnceLock::new();
        SAMPLE.get_or_init(|| {
            let out = test_dir().join("sample.mkv");
            ffmpeg(
                &[
                    "-y", "-hide_banner", "-loglevel", "error",
                    "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=15",
                    "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
                    "-f", "lavfi", "-i", "sine=frequency=660:duration=3",
                    "-f", "lavfi", "-i", "sine=frequency=880:duration=3",
                    "-map", "0:v", "-map", "1:a", "-map", "2:a", "-map", "3:a",
                    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
                    "-c:a", "aac",
                    "-metadata:s:a:0", "title=Mix",
                    "-metadata:s:a:1", "title=Mic",
                    "-metadata:s:a:2", "title=Desktop",
                ],
                &out,
            );
            out
        })
    }

    #[test]
    fn version() {
        let v = ffmpeg_version_impl("").unwrap();
        assert!(v.starts_with("ffmpeg version"), "{v}");
    }

    #[test]
    fn missing_ffmpeg_message() {
        let e = ffmpeg_version_impl(r"C:\nope\ffmpeg.exe").unwrap_err();
        assert!(e.contains("winget install Gyan.FFmpeg"), "{e}");
    }

    #[test]
    fn probe() {
        let info = probe_media_impl(sample_mkv(), "").unwrap();
        assert!(info.has_video);
        assert_eq!(info.video_codec.as_deref(), Some("h264"));
        assert_eq!(info.audio_streams.len(), 3);
        assert!((2900..=3200).contains(&info.duration_ms), "{}", info.duration_ms);
        let titles: Vec<_> = info.audio_streams.iter().map(|a| a.title.clone()).collect();
        assert_eq!(
            titles,
            vec![Some("Mix".into()), Some("Mic".into()), Some("Desktop".into())]
        );
        for (i, a) in info.audio_streams.iter().enumerate() {
            assert_eq!(a.audio_index, i as u32);
            assert_eq!(a.codec, "aac");
            assert_eq!(a.channels, 1);
        }
    }

    #[test]
    fn probe_ignores_attached_pic() {
        let json = r#"{"streams":[
            {"codec_type":"audio","codec_name":"mp3","channels":2,"tags":{"TITLE":"x"}},
            {"codec_type":"video","codec_name":"mjpeg","disposition":{"attached_pic":1}}],
            "format":{"duration":"12.345"}}"#;
        let info = parse_probe(json).unwrap();
        assert!(!info.has_video);
        assert_eq!(info.duration_ms, 12345);
        assert_eq!(info.audio_streams[0].title.as_deref(), Some("x"));
    }

    fn assert_mono_16k(path: &Path) {
        assert!(path.exists());
        let info = probe_media_impl(path, "").unwrap();
        assert!(!info.has_video);
        assert_eq!(info.audio_streams.len(), 1);
        assert_eq!(info.audio_streams[0].codec, "flac");
        assert_eq!(info.audio_streams[0].channels, 1);
        assert!((2900..=3200).contains(&info.duration_ms), "{}", info.duration_ms);
        let args: Vec<String> = [
            "-v", "error", "-select_streams", "a:0",
            "-show_entries", "stream=sample_rate", "-of", "csv=p=0",
        ]
        .iter()
        .map(|x| x.to_string())
        .chain([path_arg(path)])
        .collect();
        let out = run(Path::new("ffprobe"), &args, "probe").unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "16000");
    }

    #[test]
    fn extract_single_track() {
        let out = test_dir().join("sub").join("track2.flac");
        let _ = std::fs::remove_file(&out);
        extract_audio_impl(sample_mkv(), &out, Some(2), "").unwrap();
        assert_mono_16k(&out);
    }

    #[test]
    fn extract_mix_all() {
        let out = test_dir().join("mix.flac");
        let _ = std::fs::remove_file(&out);
        extract_audio_impl(sample_mkv(), &out, None, "").unwrap();
        assert_mono_16k(&out);
    }

    #[test]
    fn extract_bad_index_errors() {
        let out = test_dir().join("bad.flac");
        let e = extract_audio_impl(sample_mkv(), &out, Some(7), "").unwrap_err();
        assert!(e.starts_with("Extracting audio failed"), "{e}");
    }

    #[test]
    fn remux_keeps_all_audio() {
        let out = test_dir().join("remux").join("sample.mp4");
        let _ = std::fs::remove_file(&out);
        remux_to_mp4_impl(sample_mkv(), &out, "").unwrap();
        let info = probe_media_impl(&out, "").unwrap();
        assert!(info.has_video);
        assert_eq!(info.audio_streams.len(), 3);
    }

    #[test]
    fn remux_falls_back_to_aac() {
        // mu-law PCM can't be stream-copied into MP4, so this exercises the retry.
        let src = test_dir().join("pcm.mkv");
        ffmpeg(
            &[
                "-y", "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "testsrc=duration=1:size=160x120:rate=10",
                "-f", "lavfi", "-i", "sine=duration=1",
                "-map", "0:v", "-map", "1:a",
                "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
                "-c:a", "pcm_mulaw",
            ],
            &src,
        );
        let out = test_dir().join("pcm.mp4");
        remux_to_mp4_impl(&src, &out, "").unwrap();
        let info = probe_media_impl(&out, "").unwrap();
        assert!(info.has_video);
        assert_eq!(info.audio_streams[0].codec, "aac");
    }
}
