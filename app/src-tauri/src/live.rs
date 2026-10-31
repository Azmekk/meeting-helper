//! Live transcription: reads audio tracks from the MKV OBS is still writing
//! (ffmpeg `-follow 1`) and streams them to Soniox real-time STT.
//!
//! Per track there are two tasks joined by a channel: the reader runs ffmpeg,
//! drops the backlog already in the file, and passes on PCM chunks tagged with
//! their byte position in the file; the socket task streams them to Soniox and
//! reports tokens with times relative to the start of the recording. The byte
//! position is what keeps times right across reconnects and ffmpeg restarts.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::ipc::Channel;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, mpsc};
use tokio::time::{Instant, sleep, timeout};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderValue, header::AUTHORIZATION};
use tokio_tungstenite::tungstenite::{self, Message};
use tokio_util::sync::CancellationToken;

use crate::media::Tools;

const SONIOX_URL: &str = "wss://stt-rt.soniox.com/transcribe-websocket";
const BYTES_PER_MS: u64 = 32; // 16 kHz, mono, 16-bit
// A pause this long in ffmpeg's output means it has read everything already in
// the growing file and now waits for OBS to write more.
const CATCH_UP_GAP_MS: u64 = 250;
// After a reconnect, audio older than this is dropped instead of replayed.
const MAX_REPLAY_BYTES: u64 = 30_000 * BYTES_PER_MS;
const KEEPALIVE_AFTER: Duration = Duration::from_secs(8);
const FINISH_TIMEOUT: Duration = Duration::from_secs(10);
// ffmpeg attempts in a row that never reach live audio before giving up.
const MAX_FFMPEG_FAILURES: u32 = 8;

// ---------------------------------------------------------------------------
// Events sent to the frontend

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveToken {
    pub text: String,
    pub start_ms: u64, // from the start of the recording
    pub end_ms: u64,
    pub is_final: bool,
    pub speaker: Option<String>,
    pub language: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum TrackState {
    CatchingUp, // ffmpeg is reading the part of the file recorded before we started
    Live,
    Reconnecting,
    Stopped,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum LiveEvent {
    Status {
        track: String,
        state: TrackState,
        message: Option<String>,
    },
    // `<end>` tokens (endpoint detected) are passed through as is.
    Tokens {
        track: String,
        tokens: Vec<LiveToken>,
    },
}

type Emit = Arc<dyn Fn(LiveEvent) + Send + Sync>;

fn status(emit: &Emit, track: &str, state: TrackState, message: Option<String>) {
    emit(LiveEvent::Status { track: track.to_string(), state, message });
}

// ---------------------------------------------------------------------------
// Backlog skipping (pure, unit tested)

/// Decides which ffmpeg output is backlog (already in the file when we
/// started) and which is live, and tracks the byte position in the PCM stream.
#[derive(Debug)]
pub struct BacklogSkipper {
    gap_ms: u64,
    last_chunk_at: Option<u64>,
    live: bool,
    pos: u64, // bytes of PCM seen so far
}

impl BacklogSkipper {
    pub fn new(gap_ms: u64) -> Self {
        BacklogSkipper { gap_ms, last_chunk_at: None, live: false, pos: 0 }
    }

    /// Feeds a chunk of `len` bytes that arrived at `now_ms`. Returns
    /// `Some((skip, pos))` when (part of) it should be streamed: drop the first
    /// `skip` bytes, and the rest starts at PCM byte `pos`. Streaming starts with
    /// the first chunk after a pause of more than `gap_ms`, aligned to a whole
    /// 16-bit sample.
    pub fn feed(&mut self, now_ms: u64, len: usize) -> Option<(usize, u64)> {
        let start = self.pos;
        self.pos += len as u64;
        if self.live {
            return Some((0, start));
        }
        let caught_up = self.last_chunk_at.is_some_and(|t| now_ms.saturating_sub(t) > self.gap_ms);
        self.last_chunk_at = Some(now_ms);
        if !caught_up {
            return None;
        }
        self.live = true;
        let skip = (start % 2) as usize;
        if skip >= len {
            return None;
        }
        Some((skip, start + skip as u64))
    }

    pub fn is_live(&self) -> bool {
        self.live
    }
}

// ---------------------------------------------------------------------------
// Configuration

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveConfig {
    pub path: String,
    pub api_key: String,
    pub model: String,
    pub languages: Vec<String>,
    pub terms: Vec<String>,
    // "mic" (audio track 2), "desktop" (track 3) or "mix" (track 1).
    pub tracks: Vec<String>,
    pub ffmpeg_path: String,
}

#[derive(Debug, Clone)]
struct TrackSpec {
    name: String,
    audio_index: u32,
    diarize: bool,
}

fn track_spec(name: &str) -> Result<TrackSpec, String> {
    // OBS tracks 1-3 are audio streams 0-2: mix, mic only, desktop only.
    let (audio_index, diarize) = match name {
        "mix" => (0, true),
        "mic" => (1, false), // the mic track is one known person
        "desktop" => (2, true),
        _ => return Err(format!("Unknown live track “{name}”.")),
    };
    Ok(TrackSpec { name: name.to_string(), audio_index, diarize })
}

fn soniox_config(cfg: &LiveConfig, spec: &TrackSpec) -> Value {
    let mut v = json!({
        "model": cfg.model,
        "audio_format": "pcm_s16le",
        "sample_rate": 16000,
        "num_channels": 1,
        "language_hints": cfg.languages,
        "enable_language_identification": true,
        "enable_speaker_diarization": spec.diarize,
        "enable_endpoint_detection": true,
    });
    let terms: Vec<&str> = cfg.terms.iter().map(|t| t.trim()).filter(|t| !t.is_empty()).collect();
    if !terms.is_empty() {
        v["context"] = json!({ "terms": terms });
    }
    v
}

// ---------------------------------------------------------------------------
// Reader: ffmpeg → PCM chunks

#[derive(Debug)]
struct Chunk {
    pos: u64, // byte position of data[0] in the track's PCM stream
    data: Vec<u8>,
}

fn ffmpeg_args(path: &Path, audio_index: u32) -> Vec<String> {
    // Small probe: the header already describes the streams, and a big probe
    // would sit waiting for the growing file to get longer.
    [
        "-hide_banner", "-loglevel", "error", "-fflags", "nobuffer", "-probesize", "32768",
        "-analyzeduration", "0", "-follow", "1", "-i",
    ]
    .iter()
    .map(|s| s.to_string())
    .chain([path.to_string_lossy().into_owned()])
    .chain(
        [
            "-map".to_string(),
            format!("0:a:{audio_index}"),
            "-ac".into(),
            "1".into(),
            "-ar".into(),
            "16000".into(),
            "-f".into(),
            "s16le".into(),
            // Otherwise the pipe holds back about a second of audio.
            "-flush_packets".into(),
            "1".into(),
            "pipe:1".into(),
        ],
    )
    .collect()
}

fn spawn_ffmpeg(ffmpeg: &Path, args: &[String]) -> Result<Child, String> {
    let mut cmd = Command::new(ffmpeg);
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!(
                "Could not find ffmpeg ({}). Install FFmpeg or set its path in Settings.",
                ffmpeg.display()
            )
        } else {
            format!("Could not start ffmpeg: {e}")
        }
    })
}

async fn read_tail(mut r: impl AsyncRead + Unpin) -> String {
    let mut buf = Vec::new();
    let _ = r.read_to_end(&mut buf).await;
    let text = String::from_utf8_lossy(&buf);
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(5)..].join("\n")
}

enum ReadEnd {
    Cancelled,
    Exited { went_live: bool, stderr: String },
}

// One ffmpeg run. On cancel it keeps reading briefly, so the last words OBS
// flushed at stop still reach Soniox, then kills ffmpeg.
async fn read_once(
    tools: &Tools,
    path: &Path,
    spec: &TrackSpec,
    tx: &mpsc::UnboundedSender<Chunk>,
    cancel: &CancellationToken,
    emit: &Emit,
) -> Result<ReadEnd, String> {
    let mut child = spawn_ffmpeg(&tools.ffmpeg, &ffmpeg_args(path, spec.audio_index))?;
    let mut stdout = child.stdout.take().ok_or("ffmpeg has no stdout")?;
    let stderr_task = child.stderr.take().map(|e| tokio::spawn(read_tail(e)));

    let started = Instant::now();
    let mut skipper = BacklogSkipper::new(CATCH_UP_GAP_MS);
    let mut buf = vec![0u8; 32 * 1024];
    let mut stop_deadline: Option<Instant> = None;
    loop {
        let n = if let Some(deadline) = stop_deadline {
            // Stop once output pauses (everything written is read), or after a
            // short grace if OBS is still recording (live turned off mid-meeting).
            let wait = Duration::from_millis(700).min(deadline.saturating_duration_since(Instant::now()));
            match timeout(wait, stdout.read(&mut buf)).await {
                Ok(r) => r,
                Err(_) => break,
            }
        } else {
            tokio::select! {
                r = stdout.read(&mut buf) => r,
                _ = cancel.cancelled() => {
                    stop_deadline = Some(Instant::now() + Duration::from_secs(2));
                    continue;
                }
            }
        };
        let n = match n {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        let was_live = skipper.is_live();
        if let Some((skip, pos)) = skipper.feed(started.elapsed().as_millis() as u64, n) {
            if !was_live {
                status(emit, &spec.name, TrackState::Live, None);
            }
            if tx.send(Chunk { pos, data: buf[skip..n].to_vec() }).is_err() {
                break; // socket task is gone
            }
        }
    }
    let _ = child.kill().await;
    let stderr = match stderr_task {
        Some(t) => t.await.unwrap_or_default(),
        None => String::new(),
    };
    if stop_deadline.is_some() || cancel.is_cancelled() {
        return Ok(ReadEnd::Cancelled);
    }
    Ok(ReadEnd::Exited { went_live: skipper.is_live(), stderr })
}

// Keeps ffmpeg running until cancelled. A file OBS has only just created may
// not be readable yet, so failed starts are retried for a while.
async fn run_reader(
    tools: Tools,
    path: PathBuf,
    spec: TrackSpec,
    tx: mpsc::UnboundedSender<Chunk>,
    cancel: CancellationToken,
    emit: Emit,
) {
    let mut failures = 0;
    while !cancel.is_cancelled() {
        status(&emit, &spec.name, TrackState::CatchingUp, None);
        match read_once(&tools, &path, &spec, &tx, &cancel, &emit).await {
            Ok(ReadEnd::Cancelled) => break,
            Ok(ReadEnd::Exited { went_live, stderr }) => {
                failures = if went_live { 0 } else { failures + 1 };
                if failures >= MAX_FFMPEG_FAILURES {
                    let detail = if stderr.is_empty() { "ffmpeg stopped".to_string() } else { stderr };
                    status(
                        &emit,
                        &spec.name,
                        TrackState::Error,
                        Some(format!("Couldn't read the recording for live transcription: {detail}")),
                    );
                    cancel.cancel();
                    break;
                }
            }
            Err(e) => {
                status(&emit, &spec.name, TrackState::Error, Some(e));
                cancel.cancel();
                break;
            }
        }
        tokio::select! {
            _ = sleep(Duration::from_secs(1)) => {}
            _ = cancel.cancelled() => break,
        }
    }
}

// ---------------------------------------------------------------------------
// Socket: PCM chunks → Soniox → tokens

#[derive(Debug, Deserialize)]
struct SonioxToken {
    text: String,
    start_ms: Option<u64>,
    end_ms: Option<u64>,
    #[serde(default)]
    is_final: bool,
    speaker: Option<String>,
    language: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SonioxResponse {
    #[serde(default)]
    tokens: Vec<SonioxToken>,
    #[serde(default)]
    finished: bool,
    error_code: Option<u16>,
    error_message: Option<String>,
}

enum SessionEnd {
    Finished,                       // audio ended and Soniox confirmed
    Gap(Chunk),                     // audio jumped (ffmpeg restarted); start a new session at this chunk
    Retry { msg: String, now: bool }, // connection problem; `now` = no backoff (e.g. stream length limit)
    Fatal(String),                  // bad key, no credit, bad request: retrying won't help
}

// Soniox reports HTTP-like codes; client errors other than timeouts, the
// stream length limit and rate limits are permanent.
fn classify_error(code: u16, message: &str) -> SessionEnd {
    match code {
        408 | 429 => SessionEnd::Retry { msg: message.to_string(), now: false },
        413 => SessionEnd::Retry { msg: message.to_string(), now: true },
        400..=499 => SessionEnd::Fatal(message.to_string()),
        _ => SessionEnd::Retry { msg: message.to_string(), now: false },
    }
}

fn error_text(code: u16, message: Option<&str>) -> String {
    match message {
        Some(m) if !m.trim().is_empty() => format!("Soniox: {m} ({code})"),
        _ => format!("Soniox error {code}"),
    }
}

fn to_live_tokens(tokens: Vec<SonioxToken>, base_ms: u64) -> Vec<LiveToken> {
    tokens
        .into_iter()
        .map(|t| LiveToken {
            start_ms: base_ms + t.start_ms.unwrap_or(0),
            end_ms: base_ms + t.end_ms.or(t.start_ms).unwrap_or(0),
            text: t.text,
            is_final: t.is_final,
            speaker: t.speaker,
            language: t.language,
        })
        .collect()
}

async fn session(
    cfg: &LiveConfig,
    spec: &TrackSpec,
    first: Chunk,
    rx: &mut mpsc::UnboundedReceiver<Chunk>,
    emit: &Emit,
    reconnected: bool,
) -> SessionEnd {
    let mut req = match SONIOX_URL.into_client_request() {
        Ok(r) => r,
        Err(e) => return SessionEnd::Fatal(e.to_string()),
    };
    let auth = match HeaderValue::from_str(&format!("Bearer {}", cfg.api_key.trim())) {
        Ok(v) => v,
        Err(_) => return SessionEnd::Fatal("The Soniox API key contains invalid characters.".into()),
    };
    req.headers_mut().insert(AUTHORIZATION, auth);

    let ws = match timeout(Duration::from_secs(15), tokio_tungstenite::connect_async(req)).await {
        Err(_) => return SessionEnd::Retry { msg: "Connecting to Soniox timed out.".into(), now: false },
        Ok(Err(tungstenite::Error::Http(resp))) => {
            let code = resp.status().as_u16();
            let body = resp.body().as_ref().map(|b| String::from_utf8_lossy(b).into_owned());
            return classify_error(code, &error_text(code, body.as_deref()));
        }
        Ok(Err(e)) => return SessionEnd::Retry { msg: format!("Couldn't connect to Soniox: {e}"), now: false },
        Ok(Ok((ws, _))) => ws,
    };
    let (mut write, mut read) = ws.split();

    let base_ms = first.pos / BYTES_PER_MS;
    let mut expected = first.pos + first.data.len() as u64;
    let setup = soniox_config(cfg, spec).to_string();
    if let Err(e) = write.send(Message::text(setup)).await {
        return SessionEnd::Retry { msg: e.to_string(), now: false };
    }
    if let Err(e) = write.send(Message::binary(first.data)).await {
        return SessionEnd::Retry { msg: e.to_string(), now: false };
    }
    if reconnected {
        status(emit, &spec.name, TrackState::Live, None);
    }

    let mut audio_done = false;
    let mut carry: Option<Chunk> = None;
    let mut last_send = Instant::now();
    let mut finish_deadline = Instant::now() + Duration::from_secs(3600 * 24);
    let mut keepalive = tokio::time::interval(Duration::from_secs(2));
    loop {
        tokio::select! {
            c = rx.recv(), if !audio_done => {
                let ended = match c {
                    Some(c) if c.pos == expected => {
                        expected += c.data.len() as u64;
                        last_send = Instant::now();
                        if let Err(e) = write.send(Message::binary(c.data)).await {
                            return SessionEnd::Retry { msg: e.to_string(), now: false };
                        }
                        false
                    }
                    Some(c) => {
                        carry = Some(c);
                        true
                    }
                    None => true,
                };
                if ended {
                    // Empty text frame = end of audio; Soniox finalizes and answers `finished`.
                    audio_done = true;
                    finish_deadline = Instant::now() + FINISH_TIMEOUT;
                    if write.send(Message::text("")).await.is_err() {
                        return match carry {
                            Some(c) => SessionEnd::Gap(c),
                            None => SessionEnd::Finished,
                        };
                    }
                }
            }
            m = read.next() => {
                let text = match m {
                    Some(Ok(Message::Text(t))) => t,
                    Some(Ok(Message::Close(frame))) => {
                        // Errors arrive as a JSON message first; a bare close is a dropped connection.
                        let why = frame.map(|f| f.reason.to_string()).filter(|r| !r.is_empty());
                        if audio_done {
                            return match carry { Some(c) => SessionEnd::Gap(c), None => SessionEnd::Finished };
                        }
                        return SessionEnd::Retry { msg: why.unwrap_or_else(|| "Soniox closed the connection.".into()), now: false };
                    }
                    Some(Ok(_)) => continue,
                    Some(Err(e)) => {
                        if audio_done {
                            return match carry { Some(c) => SessionEnd::Gap(c), None => SessionEnd::Finished };
                        }
                        return SessionEnd::Retry { msg: format!("Connection to Soniox lost: {e}"), now: false };
                    }
                    None => {
                        if audio_done {
                            return match carry { Some(c) => SessionEnd::Gap(c), None => SessionEnd::Finished };
                        }
                        return SessionEnd::Retry { msg: "Soniox closed the connection.".into(), now: false };
                    }
                };
                let resp: SonioxResponse = match serde_json::from_str(&text) {
                    Ok(r) => r,
                    Err(_) => continue,
                };
                if let Some(code) = resp.error_code {
                    return classify_error(code, &error_text(code, resp.error_message.as_deref()));
                }
                if !resp.tokens.is_empty() {
                    emit(LiveEvent::Tokens { track: spec.name.clone(), tokens: to_live_tokens(resp.tokens, base_ms) });
                }
                if resp.finished {
                    return match carry { Some(c) => SessionEnd::Gap(c), None => SessionEnd::Finished };
                }
            }
            _ = keepalive.tick(), if !audio_done => {
                // OBS writes no audio while paused; keep the stream from timing out.
                if last_send.elapsed() >= KEEPALIVE_AFTER {
                    last_send = Instant::now();
                    if let Err(e) = write.send(Message::text(r#"{"type":"keepalive"}"#)).await {
                        return SessionEnd::Retry { msg: e.to_string(), now: false };
                    }
                }
            }
            _ = tokio::time::sleep_until(finish_deadline), if audio_done => {
                return match carry { Some(c) => SessionEnd::Gap(c), None => SessionEnd::Finished };
            }
        }
    }
}

// After a reconnect wait, takes what queued up and drops all but the most
// recent MAX_REPLAY_BYTES, so the transcript catches up instead of lagging.
fn take_backlog(first: Chunk, rx: &mut mpsc::UnboundedReceiver<Chunk>) -> Chunk {
    let mut queue = vec![first];
    while let Ok(c) = rx.try_recv() {
        queue.push(c);
    }
    let newest_end = queue.last().map(|c| c.pos + c.data.len() as u64).unwrap_or(0);
    let keep_from = queue
        .iter()
        .position(|c| newest_end - c.pos <= MAX_REPLAY_BYTES)
        .unwrap_or(queue.len() - 1);
    let mut kept = queue.split_off(keep_from).into_iter();
    let mut merged = kept.next().expect("at least one chunk");
    // One frame for the contiguous run. A jump (ffmpeg restarted during the
    // outage) is rare; audio after it is dropped rather than misdated.
    for c in kept {
        if c.pos != merged.pos + merged.data.len() as u64 {
            break;
        }
        merged.data.extend_from_slice(&c.data);
    }
    merged
}

async fn run_socket(
    cfg: LiveConfig,
    spec: TrackSpec,
    mut rx: mpsc::UnboundedReceiver<Chunk>,
    cancel: CancellationToken,
    emit: Emit,
) {
    let mut pending: Option<Chunk> = None;
    let mut failures: u32 = 0;
    let mut reconnecting = false;
    loop {
        let first = match pending.take() {
            Some(c) => c,
            None => match rx.recv().await {
                Some(c) => c,
                None => break,
            },
        };
        let first = if reconnecting { take_backlog(first, &mut rx) } else { first };
        match session(&cfg, &spec, first, &mut rx, &emit, reconnecting).await {
            SessionEnd::Finished => break,
            SessionEnd::Gap(c) => {
                pending = Some(c);
                reconnecting = false;
            }
            SessionEnd::Fatal(msg) => {
                status(&emit, &spec.name, TrackState::Error, Some(msg));
                cancel.cancel();
                return;
            }
            SessionEnd::Retry { msg, now } => {
                reconnecting = true;
                if cancel.is_cancelled() && rx.is_closed() && rx.is_empty() {
                    break;
                }
                status(&emit, &spec.name, TrackState::Reconnecting, Some(msg));
                if !now {
                    failures += 1;
                    let wait = Duration::from_secs(u64::from(failures.min(5)) * 2);
                    sleep(wait).await;
                } else {
                    failures = 0;
                }
            }
        }
    }
    status(&emit, &spec.name, TrackState::Stopped, None);
}

// ---------------------------------------------------------------------------
// Session management

struct Running {
    cancel: CancellationToken,
    tasks: Vec<tauri::async_runtime::JoinHandle<()>>,
}

#[derive(Default)]
pub struct LiveState(Mutex<Option<Running>>);

/// Starts one reader + socket pair per track. Returns once they are spawned;
/// progress and errors arrive as events.
fn start_impl(cfg: LiveConfig, emit: Emit) -> Result<Running, String> {
    if cfg.api_key.trim().is_empty() {
        return Err("Add your Soniox API key in Settings first.".into());
    }
    let specs = cfg.tracks.iter().map(|t| track_spec(t)).collect::<Result<Vec<_>, _>>()?;
    if specs.is_empty() {
        return Err("No tracks to transcribe.".into());
    }
    let tools = Tools::resolve(&cfg.ffmpeg_path);
    let path = PathBuf::from(&cfg.path);
    let cancel = CancellationToken::new();
    let mut tasks = Vec::new();
    for spec in specs {
        // A fatal error on one track (e.g. bad key) stops all of them.
        let (tx, rx) = mpsc::unbounded_channel();
        tasks.push(tauri::async_runtime::spawn(run_reader(
            tools.clone(),
            path.clone(),
            spec.clone(),
            tx,
            cancel.clone(),
            emit.clone(),
        )));
        tasks.push(tauri::async_runtime::spawn(run_socket(cfg.clone(), spec, rx, cancel.clone(), emit.clone())));
    }
    Ok(Running { cancel, tasks })
}

async fn stop_running(running: Running) {
    running.cancel.cancel();
    // Readers drain for <1 s, sockets wait up to FINISH_TIMEOUT for the last words.
    let all = futures_util::future::join_all(running.tasks);
    let _ = timeout(FINISH_TIMEOUT + Duration::from_secs(5), all).await;
}

#[tauri::command]
pub async fn live_start(
    state: tauri::State<'_, LiveState>,
    config: LiveConfig,
    on_event: Channel<LiveEvent>,
) -> Result<(), String> {
    let mut guard = state.0.lock().await;
    if let Some(old) = guard.take() {
        stop_running(old).await;
    }
    let emit: Emit = Arc::new(move |ev| {
        let _ = on_event.send(ev);
    });
    *guard = Some(start_impl(config, emit)?);
    Ok(())
}

/// Lets the last audio through, waits for Soniox to finalize it, then returns.
#[tauri::command]
pub async fn live_stop(state: tauri::State<'_, LiveState>) -> Result<(), String> {
    let running = state.0.lock().await.take();
    if let Some(r) = running {
        stop_running(r).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_backlog_until_first_gap() {
        let mut s = BacklogSkipper::new(250);
        // Backlog arrives in a burst.
        assert_eq!(s.feed(0, 1000), None);
        assert_eq!(s.feed(5, 1000), None);
        assert_eq!(s.feed(250, 1000), None); // exactly the gap is still backlog
        assert!(!s.is_live());
        // First chunk after a real pause is live and starts at its file position.
        assert_eq!(s.feed(600, 640), Some((0, 3000)));
        assert!(s.is_live());
        // Live chunks pass regardless of timing.
        assert_eq!(s.feed(601, 640), Some((0, 3640)));
    }

    #[test]
    fn keeps_sample_alignment() {
        let mut s = BacklogSkipper::new(250);
        assert_eq!(s.feed(0, 999), None);
        // Odd backlog: drop one byte so streaming starts on a whole sample.
        assert_eq!(s.feed(1000, 100), Some((1, 1000)));
        // Later odd-sized live chunks are contiguous; Soniox sees one stream.
        assert_eq!(s.feed(1001, 3), Some((0, 1099)));
        assert_eq!(s.feed(1002, 4), Some((0, 1102)));
    }

    #[test]
    fn single_byte_after_odd_backlog_is_dropped() {
        let mut s = BacklogSkipper::new(250);
        s.feed(0, 1);
        assert_eq!(s.feed(1000, 1), None);
        assert!(s.is_live());
        assert_eq!(s.feed(1001, 2), Some((0, 2)));
    }

    #[test]
    fn backlog_keeps_only_recent_audio() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let chunk = 10_000 * BYTES_PER_MS; // 10 s each
        for i in 1..6u64 {
            tx.send(Chunk { pos: i * chunk, data: vec![0; chunk as usize] }).unwrap();
        }
        let merged = take_backlog(Chunk { pos: 0, data: vec![0; chunk as usize] }, &mut rx);
        // 60 s queued, 30 s kept: chunks 3, 4, 5 merged.
        assert_eq!(merged.pos, 3 * chunk);
        assert_eq!(merged.data.len() as u64, 3 * chunk);
    }

    #[test]
    fn error_classes() {
        assert!(matches!(classify_error(401, "x"), SessionEnd::Fatal(_)));
        assert!(matches!(classify_error(402, "x"), SessionEnd::Fatal(_)));
        assert!(matches!(classify_error(413, "x"), SessionEnd::Retry { now: true, .. }));
        assert!(matches!(classify_error(408, "x"), SessionEnd::Retry { now: false, .. }));
        assert!(matches!(classify_error(503, "x"), SessionEnd::Retry { now: false, .. }));
    }

    // Manual checks (need ffmpeg / network):
    //   LIVE_TEST_MKV=<growing.mkv> cargo test live_reader -- --ignored --nocapture
    //   cargo test live_bad_key -- --ignored --nocapture

    fn collector() -> (Emit, Arc<std::sync::Mutex<Vec<LiveEvent>>>) {
        let events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let e = events.clone();
        (Arc::new(move |ev| e.lock().unwrap().push(ev)), events)
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_reader_against_growing_file() {
        let path = std::env::var("LIVE_TEST_MKV").expect("set LIVE_TEST_MKV");
        let (emit, events) = collector();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let cancel = CancellationToken::new();
        let spec = track_spec("mic").unwrap();
        let reader = tokio::spawn(run_reader(Tools::resolve(""), path.into(), spec, tx, cancel.clone(), emit));
        let first = timeout(Duration::from_secs(10), rx.recv()).await.expect("no live audio").unwrap();
        println!("first live chunk at {} ms of the file, {} bytes", first.pos / BYTES_PER_MS, first.data.len());
        assert!(first.pos > 0, "backlog was not skipped");
        let mut expected = first.pos + first.data.len() as u64;
        let until = Instant::now() + Duration::from_secs(2);
        while Instant::now() < until {
            if let Ok(Some(c)) = timeout(Duration::from_millis(500), rx.recv()).await {
                assert_eq!(c.pos, expected, "chunks must be contiguous");
                expected += c.data.len() as u64;
            }
        }
        println!("streamed up to {} ms", expected / BYTES_PER_MS);
        cancel.cancel();
        timeout(Duration::from_secs(5), reader).await.unwrap().unwrap();
        println!("{:?}", events.lock().unwrap());
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_bad_key() {
        let cfg = LiveConfig {
            path: String::new(),
            api_key: "not-a-real-key".into(),
            model: "stt-rt-v5".into(),
            languages: vec!["en".into()],
            terms: vec![],
            tracks: vec!["mic".into()],
            ffmpeg_path: String::new(),
        };
        let (emit, _) = collector();
        let (_tx, mut rx) = mpsc::unbounded_channel();
        let first = Chunk { pos: 0, data: vec![0; 3200] };
        let end = session(&cfg, &track_spec("mic").unwrap(), first, &mut rx, &emit, false).await;
        match end {
            SessionEnd::Fatal(msg) => println!("fatal as expected: {msg}"),
            SessionEnd::Retry { msg, .. } => panic!("expected fatal, got retry: {msg}"),
            _ => panic!("expected fatal"),
        }
    }
}
