//! Secret mode: a small HTTP + WebSocket server on the LAN so a phone can show
//! the live transcript, notes and answers while the PC screen shows nothing.
//!
//! `GET /` serves the phone page (Vite's `remote.html` entry); `/ws` is the
//! WebSocket. The main window does all the work: it pushes snapshot JSON with
//! `remote_broadcast`, and phone commands come back as `remote://message`
//! events.
//!
//! Every WebSocket message is encrypted with XChaCha20-Poly1305 under a key that
//! only travels in the QR code's URL fragment (never over the network):
//!   frame     = nonce (24 bytes) | ciphertext
//!   plaintext = direction (1 byte, b'S' to the phone, b'P' from it)
//!             | counter (u64 big-endian, must increase) | JSON
//! The direction byte stops a server frame being reflected back to the server;
//! the counter stops replays. Having the key is the authentication.
//!
//! Where the page comes from: in release builds it's read from the frontend
//! assets Tauri embeds (`dist/remote.html` + `dist/assets/*`) via the asset
//! resolver; under `tauri dev` requests are proxied to the Vite dev server so
//! the page hot-reloads like the app (falling back to `dist/` if Vite is down).

use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chacha20poly1305::aead::{Aead, AeadCore, KeyInit, OsRng};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Mutex, broadcast, watch};
use tokio::time::{Instant, interval, sleep, timeout};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::protocol::frame::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::{Bytes, Message};

pub const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 24;
const TAG_LEN: usize = 16;
const HEADER_LEN: usize = 1 + 8;
pub const TO_PHONE: u8 = b'S';
pub const FROM_PHONE: u8 = b'P';

// Close codes the phone page understands (see src/remote/connection.ts).
const CLOSE_REPAIRED: u16 = 4001; // a new key was made; scan the new QR code
const CLOSE_BAD_KEY: u16 = 4002; // the phone's key doesn't match

const MAX_HEAD: usize = 8 * 1024;
const MAX_INBOUND: usize = 64 * 1024;
const PING_EVERY: Duration = Duration::from_secs(15);
// A phone that went away without closing (Wi-Fi dropped, screen locked) is
// dropped after this long, so the connected count stays honest.
const IDLE_LIMIT: Duration = Duration::from_secs(45);

// ---------------------------------------------------------------------------
// Crypto framing

#[derive(Debug, PartialEq)]
pub enum Reject {
    BadKey, // too short, wrong key, tampered or wrong direction
    Replay, // counter didn't increase
}

pub fn parse_key(b64: &str) -> Result<[u8; KEY_LEN], String> {
    let bytes = URL_SAFE_NO_PAD
        .decode(b64.trim().trim_end_matches('='))
        .map_err(|_| "The remote key isn't valid base64url.".to_string())?;
    bytes.try_into().map_err(|_| "The remote key must be 32 bytes.".to_string())
}

pub fn encode_key(key: &[u8; KEY_LEN]) -> String {
    URL_SAFE_NO_PAD.encode(key)
}

pub fn new_key() -> [u8; KEY_LEN] {
    XChaCha20Poly1305::generate_key(&mut OsRng).into()
}

pub fn seal(cipher: &XChaCha20Poly1305, direction: u8, counter: u64, msg: &[u8]) -> Vec<u8> {
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let mut plain = Vec::with_capacity(HEADER_LEN + msg.len());
    plain.push(direction);
    plain.extend_from_slice(&counter.to_be_bytes());
    plain.extend_from_slice(msg);
    // Only fails for messages far beyond anything we send (~256 GiB).
    let sealed = cipher.encrypt(&nonce, plain.as_slice()).expect("message too large to encrypt");
    let mut frame = Vec::with_capacity(NONCE_LEN + sealed.len());
    frame.extend_from_slice(&nonce);
    frame.extend_from_slice(&sealed);
    frame
}

pub fn open(cipher: &XChaCha20Poly1305, direction: u8, frame: &[u8]) -> Result<(u64, Vec<u8>), Reject> {
    if frame.len() < NONCE_LEN + TAG_LEN + HEADER_LEN {
        return Err(Reject::BadKey);
    }
    let (nonce, sealed) = frame.split_at(NONCE_LEN);
    let plain = cipher.decrypt(XNonce::from_slice(nonce), sealed).map_err(|_| Reject::BadKey)?;
    if plain[0] != direction {
        return Err(Reject::BadKey);
    }
    let counter = u64::from_be_bytes(plain[1..HEADER_LEN].try_into().unwrap());
    Ok((counter, plain[HEADER_LEN..].to_vec()))
}

// One pairing: the key plus both counters. Inbound counters are tracked per key
// (not per connection), so a message captured earlier can't be replayed on a
// fresh connection either. The phone uses microseconds since 1970 as its
// counter base so it keeps increasing across page reloads.
pub struct Session {
    key: [u8; KEY_LEN],
    cipher: XChaCha20Poly1305,
    last_in: u64,
    next_out: u64,
}

impl Session {
    pub fn new(key: [u8; KEY_LEN]) -> Self {
        // Time-based start, so counters still increase after an app restart.
        let now_us = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_micros() as u64).unwrap_or(0);
        Session { key, cipher: XChaCha20Poly1305::new(&key.into()), last_in: 0, next_out: now_us }
    }

    pub fn encrypt(&mut self, msg: &[u8]) -> Vec<u8> {
        self.next_out += 1;
        seal(&self.cipher, TO_PHONE, self.next_out, msg)
    }

    pub fn decrypt(&mut self, frame: &[u8]) -> Result<Vec<u8>, Reject> {
        let (counter, msg) = open(&self.cipher, FROM_PHONE, frame)?;
        if counter <= self.last_in {
            return Err(Reject::Replay);
        }
        self.last_in = counter;
        Ok(msg)
    }
}

// ---------------------------------------------------------------------------
// Server

pub struct Page {
    pub mime: String,
    pub body: Vec<u8>,
}

pub type PageFuture = Pin<Box<dyn Future<Output = Option<Page>> + Send>>;

// What the server needs from its host; the app wires these to Tauri, tests to channels.
#[derive(Clone)]
pub struct Hooks {
    pub page: Arc<dyn Fn(String) -> PageFuture + Send + Sync>, // path without the leading '/'
    pub on_message: Arc<dyn Fn(Value) + Send + Sync>,
    pub on_clients: Arc<dyn Fn(usize) + Send + Sync>,
}

#[derive(Clone)]
enum Out {
    Frame(Bytes),
    Close(u16, &'static str),
}

struct Shared {
    session: StdMutex<Session>,
    tx: broadcast::Sender<Out>,
    clients: AtomicUsize,
    hooks: Hooks,
}

pub struct Server {
    shared: Arc<Shared>,
    port: u16,
    shutdown: watch::Sender<bool>,
}

impl Server {
    pub async fn start(port: u16, key: [u8; KEY_LEN], hooks: Hooks) -> Result<Server, String> {
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, port)))
            .await
            .map_err(|e| format!("Couldn't listen on port {port}: {e}. Pick another port."))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let (tx, _) = broadcast::channel(16);
        let shared = Arc::new(Shared { session: StdMutex::new(Session::new(key)), tx, clients: AtomicUsize::new(0), hooks });
        let (shutdown, mut stop) = watch::channel(false);
        let accept_shared = shared.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = stop.changed() => break,
                    conn = listener.accept() => {
                        if let Ok((stream, _)) = conn {
                            tokio::spawn(handle_conn(stream, accept_shared.clone()));
                        }
                    }
                }
            }
        });
        Ok(Server { shared, port, shutdown })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn clients(&self) -> usize {
        self.shared.clients.load(Ordering::SeqCst)
    }

    pub fn has_key(&self, key: &[u8; KEY_LEN]) -> bool {
        self.shared.session.lock().unwrap().key == *key
    }

    // A new pairing: phones on the old key are disconnected.
    pub fn set_key(&self, key: [u8; KEY_LEN]) {
        *self.shared.session.lock().unwrap() = Session::new(key);
        let _ = self.shared.tx.send(Out::Close(CLOSE_REPAIRED, "re-paired"));
    }

    // Encrypts once and sends the same frame to every phone.
    pub fn broadcast(&self, json: &[u8]) -> usize {
        let frame = self.shared.session.lock().unwrap().encrypt(json);
        let _ = self.shared.tx.send(Out::Frame(Bytes::from(frame)));
        self.clients()
    }

    pub fn stop(self) {
        let _ = self.shutdown.send(true);
        let _ = self.shared.tx.send(Out::Close(1001, "stopped"));
    }
}

async fn handle_conn(stream: TcpStream, shared: Arc<Shared>) {
    let _ = stream.set_nodelay(true);
    let Some(head) = peek_head(&stream).await else { return };
    let (method, path, websocket) = parse_head(&head);
    if websocket && path == "/ws" {
        // The handshake re-reads the request we only peeked at.
        let config = WebSocketConfig::default().max_message_size(Some(MAX_INBOUND)).max_frame_size(Some(MAX_INBOUND));
        if let Ok(ws) = tokio_tungstenite::accept_async_with_config(stream, Some(config)).await {
            run_socket(ws, shared).await;
        }
        return;
    }
    let mut stream = stream;
    let mut consumed = vec![0u8; head.len()];
    if stream.read_exact(&mut consumed).await.is_err() {
        return;
    }
    let response = if method != "GET" && method != "HEAD" {
        http_response(405, "text/plain", b"Method not allowed".to_vec())
    } else {
        let path = if path == "/" { "remote.html".to_string() } else { path.trim_start_matches('/').to_string() };
        match (shared.hooks.page)(path).await {
            Some(page) => http_response(200, &page.mime, page.body),
            None => http_response(404, "text/plain", b"Not found".to_vec()),
        }
    };
    let _ = stream.write_all(&response).await;
    let _ = stream.shutdown().await;
}

// Waits until the whole request head has arrived without consuming it, so a
// WebSocket upgrade can still be handed to tungstenite untouched.
async fn peek_head(stream: &TcpStream) -> Option<Vec<u8>> {
    let mut buf = vec![0u8; MAX_HEAD];
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut seen = 0;
    loop {
        let n = timeout(deadline.saturating_duration_since(Instant::now()), stream.peek(&mut buf)).await.ok()?.ok()?;
        if n == 0 {
            return None;
        }
        if let Some(end) = buf[..n].windows(4).position(|w| w == b"\r\n\r\n") {
            return Some(buf[..end + 4].to_vec());
        }
        if n == buf.len() || Instant::now() >= deadline {
            return None;
        }
        // peek returns at once while the same bytes are buffered; give the rest time to arrive.
        if n == seen {
            sleep(Duration::from_millis(5)).await;
        }
        seen = n;
    }
}

// (method, path without query, is a WebSocket upgrade)
fn parse_head(head: &[u8]) -> (String, String, bool) {
    let text = String::from_utf8_lossy(head);
    let mut lines = text.split("\r\n");
    let mut first = lines.next().unwrap_or("").split(' ');
    let method = first.next().unwrap_or("").to_string();
    let target = first.next().unwrap_or("/");
    let path = target.split(['?', '#']).next().unwrap_or("/").to_string();
    let websocket = lines.any(|l| {
        l.split_once(':')
            .is_some_and(|(k, v)| k.trim().eq_ignore_ascii_case("upgrade") && v.trim().eq_ignore_ascii_case("websocket"))
    });
    (method, path, websocket)
}

fn http_response(status: u16, mime: &str, body: Vec<u8>) -> Vec<u8> {
    let reason = match status {
        200 => "OK",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Error",
    };
    // no-referrer: the URL fragment never leaves the browser anyway, but keep the page from leaking anything else.
    let mut out = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    out.extend_from_slice(&body);
    out
}

async fn run_socket(ws: tokio_tungstenite::WebSocketStream<TcpStream>, shared: Arc<Shared>) {
    let (mut sink, mut stream) = ws.split();
    let mut rx = shared.tx.subscribe();
    let count = shared.clients.fetch_add(1, Ordering::SeqCst) + 1;
    (shared.hooks.on_clients)(count);
    let mut ping = interval(PING_EVERY);
    let mut last_seen = Instant::now();

    let close = |code: u16, reason: &'static str| {
        Message::Close(Some(CloseFrame { code: CloseCode::from(code), reason: reason.into() }))
    };

    loop {
        tokio::select! {
            out = rx.recv() => match out {
                Ok(Out::Frame(frame)) => {
                    if sink.send(Message::Binary(frame)).await.is_err() { break; }
                }
                Ok(Out::Close(code, reason)) => {
                    let _ = sink.send(close(code, reason)).await;
                    break;
                }
                // Snapshots are full state, so skipping some is harmless.
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => break,
            },
            msg = stream.next() => {
                last_seen = Instant::now();
                match msg {
                    Some(Ok(Message::Binary(frame))) => {
                        let result = shared.session.lock().unwrap().decrypt(&frame);
                        match result {
                            Ok(plain) => {
                                if let Ok(value) = serde_json::from_slice::<Value>(&plain) {
                                    (shared.hooks.on_message)(value);
                                }
                            }
                            // Dropped silently; the connection itself is still the phone's.
                            Err(Reject::Replay) => {}
                            Err(Reject::BadKey) => {
                                let _ = sink.send(close(CLOSE_BAD_KEY, "bad key")).await;
                                break;
                            }
                        }
                    }
                    // Unencrypted messages are never accepted.
                    Some(Ok(Message::Text(_))) => {
                        let _ = sink.send(close(CLOSE_BAD_KEY, "encryption required")).await;
                        break;
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(_)) => {} // ping/pong, answered by tungstenite
                }
            }
            _ = ping.tick() => {
                if last_seen.elapsed() > IDLE_LIMIT || sink.send(Message::Ping(Bytes::new())).await.is_err() {
                    break;
                }
            }
        }
    }
    let count = shared.clients.fetch_sub(1, Ordering::SeqCst) - 1;
    (shared.hooks.on_clients)(count);
}

// ---------------------------------------------------------------------------
// LAN addresses

// Names of adapters that are almost never the network the phone is on.
const VIRTUAL_HINTS: &[&str] =
    &["vethernet", "virtual", "vmware", "vbox", "hyper-v", "wsl", "docker", "loopback", "tailscale", "zerotier", "vpn", "tap", "tun", "utun", "bridge", "br-", "veth"];

// IPv4 LAN addresses, the likely Wi-Fi/Ethernet one first.
pub fn rank_addresses(ifaces: Vec<(String, IpAddr)>) -> Vec<String> {
    let mut ranked: Vec<(u8, String)> = ifaces
        .into_iter()
        .filter_map(|(name, ip)| {
            let IpAddr::V4(v4) = ip else { return None };
            if v4.is_loopback() || v4.is_link_local() || v4.is_unspecified() {
                return None;
            }
            let lower = name.to_lowercase();
            let rank = if VIRTUAL_HINTS.iter().any(|h| lower.contains(h)) {
                4
            } else if lower.contains("wi-fi") || lower.contains("wifi") || lower.contains("wlan") || lower.starts_with("wl") {
                0
            } else if lower.contains("ethernet") || lower.starts_with("en") || lower.starts_with("eth") {
                1
            } else if v4.is_private() {
                2
            } else {
                3
            };
            Some((rank, v4.to_string()))
        })
        .collect();
    ranked.sort_by_key(|(rank, _)| *rank);
    let mut out: Vec<String> = Vec::new();
    for (_, ip) in ranked {
        if !out.contains(&ip) {
            out.push(ip);
        }
    }
    out
}

fn lan_addresses() -> Vec<String> {
    local_ip_address::list_afinet_netifas().map(rank_addresses).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Tauri commands

#[derive(Default)]
pub struct RemoteState {
    server: Mutex<Option<Server>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    running: bool,
    port: Option<u16>,
    addresses: Vec<String>,
    clients: usize,
}

fn status_of(server: Option<&Server>) -> RemoteStatus {
    RemoteStatus {
        running: server.is_some(),
        port: server.map(Server::port),
        addresses: lan_addresses(),
        clients: server.map(Server::clients).unwrap_or(0),
    }
}

fn app_hooks(app: AppHandle) -> Hooks {
    let page_app = app.clone();
    let msg_app = app.clone();
    Hooks {
        page: Arc::new(move |path| {
            let app = page_app.clone();
            Box::pin(async move { load_page(&app, &path).await })
        }),
        on_message: Arc::new(move |value| {
            let _ = msg_app.emit_to("main", "remote://message", value);
        }),
        on_clients: Arc::new(move |count| {
            let _ = app.emit_to("main", "remote://clients", count);
        }),
    }
}

async fn load_page(app: &AppHandle, path: &str) -> Option<Page> {
    if path.contains("..") {
        return None;
    }
    #[cfg(dev)]
    if let Some(dev_url) = app.config().build.dev_url.clone()
        && let Some(page) = proxy_dev(dev_url, path).await
    {
        return Some(page);
    }
    // Only the phone page and its bundles; the asset resolver would answer
    // unknown paths with the main app's index.html.
    if path != "remote.html" && !path.starts_with("assets/") {
        return None;
    }
    let asset = app.asset_resolver().get(path.to_string())?;
    Some(Page { mime: asset.mime_type, body: asset.bytes })
}

#[cfg(dev)]
async fn proxy_dev(dev_url: tauri::Url, path: &str) -> Option<Page> {
    let url = dev_url.join(path).ok()?;
    let res = reqwest::get(url).await.ok()?;
    if !res.status().is_success() {
        return None;
    }
    let mime = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let body = res.bytes().await.ok()?.to_vec();
    Some(Page { mime, body })
}

// Starts the server (or keeps the running one if the port is the same) with the
// given pairing key. Binding 0.0.0.0 is what makes Windows Firewall ask.
#[tauri::command]
pub async fn remote_start(app: AppHandle, state: State<'_, RemoteState>, port: u16, key: String) -> Result<RemoteStatus, String> {
    let key = parse_key(&key)?;
    let mut guard = state.server.lock().await;
    if let Some(server) = guard.as_ref()
        && server.port() == port
    {
        if !server.has_key(&key) {
            server.set_key(key);
        }
        return Ok(status_of(guard.as_ref()));
    }
    if let Some(old) = guard.take() {
        old.stop();
    }
    *guard = Some(Server::start(port, key, app_hooks(app.clone())).await?);
    Ok(status_of(guard.as_ref()))
}

#[tauri::command]
pub async fn remote_stop(state: State<'_, RemoteState>) -> Result<(), String> {
    if let Some(server) = state.server.lock().await.take() {
        server.stop();
    }
    Ok(())
}

#[tauri::command]
pub async fn remote_status(state: State<'_, RemoteState>) -> Result<RemoteStatus, String> {
    Ok(status_of(state.server.lock().await.as_ref()))
}

// A fresh key; phones paired with the old one are disconnected. The frontend
// stores the result in the keyring.
#[tauri::command]
pub async fn remote_pair(state: State<'_, RemoteState>) -> Result<String, String> {
    let key = new_key();
    if let Some(server) = state.server.lock().await.as_ref() {
        server.set_key(key);
    }
    Ok(encode_key(&key))
}

// Sends one JSON message to every connected phone; returns how many there are.
#[tauri::command]
pub async fn remote_broadcast(state: State<'_, RemoteState>, payload: String) -> Result<usize, String> {
    Ok(state.server.lock().await.as_ref().map(|s| s.broadcast(payload.as_bytes())).unwrap_or(0))
}

// ---------------------------------------------------------------------------
// Tests

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;
    use tokio_tungstenite::connect_async;

    fn phone_seal(key: &[u8; KEY_LEN], counter: u64, msg: &[u8]) -> Vec<u8> {
        seal(&XChaCha20Poly1305::new(&(*key).into()), FROM_PHONE, counter, msg)
    }

    #[test]
    fn key_round_trips_as_base64url() {
        let key = new_key();
        let text = encode_key(&key);
        assert_eq!(text.len(), 43);
        assert!(!text.contains(['+', '/', '=']));
        assert_eq!(parse_key(&text).unwrap(), key);
        assert!(parse_key("short").is_err());
    }

    #[test]
    fn frame_layout_and_round_trip() {
        let key = new_key();
        let mut server = Session::new(key);
        let frame = server.encrypt(b"{\"a\":1}");
        assert_eq!(frame.len(), NONCE_LEN + HEADER_LEN + 7 + TAG_LEN);
        let (counter, msg) = open(&XChaCha20Poly1305::new(&key.into()), TO_PHONE, &frame).unwrap();
        assert_eq!(msg, b"{\"a\":1}");
        let (next, _) = open(&XChaCha20Poly1305::new(&key.into()), TO_PHONE, &server.encrypt(b"x")).unwrap();
        assert_eq!(next, counter + 1);
        // Nonces are random: the same message never encrypts the same way twice.
        assert_ne!(server.encrypt(b"x")[..NONCE_LEN], server.encrypt(b"x")[..NONCE_LEN]);
    }

    #[test]
    fn rejects_replays_wrong_keys_tampering_and_reflection() {
        let key = new_key();
        let mut server = Session::new(key);
        let first = phone_seal(&key, 100, b"{}");
        assert_eq!(server.decrypt(&first).unwrap(), b"{}");
        assert_eq!(server.decrypt(&first), Err(Reject::Replay));
        assert_eq!(server.decrypt(&phone_seal(&key, 99, b"{}")), Err(Reject::Replay));
        assert!(server.decrypt(&phone_seal(&key, 101, b"{}")).is_ok());

        assert_eq!(server.decrypt(&phone_seal(&new_key(), 200, b"{}")), Err(Reject::BadKey));
        let mut tampered = phone_seal(&key, 201, b"{}");
        let last = tampered.len() - 1;
        tampered[last] ^= 1;
        assert_eq!(server.decrypt(&tampered), Err(Reject::BadKey));
        assert_eq!(server.decrypt(&[0u8; 10]), Err(Reject::BadKey));
        // A frame the server sent can't be bounced back at it.
        let reflected = server.encrypt(b"{}");
        assert_eq!(server.decrypt(&reflected), Err(Reject::BadKey));
    }

    #[test]
    fn parses_request_heads() {
        let (m, p, ws) = parse_head(b"GET /ws?x=1 HTTP/1.1\r\nHost: a\r\nUpgrade: WebSocket\r\nConnection: Upgrade\r\n\r\n");
        assert_eq!((m.as_str(), p.as_str(), ws), ("GET", "/ws", true));
        let (_, p, ws) = parse_head(b"GET /assets/a.js HTTP/1.1\r\nHost: a\r\n\r\n");
        assert_eq!((p.as_str(), ws), ("/assets/a.js", false));
    }

    #[test]
    fn ranks_wifi_before_virtual_adapters() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        let ranked = rank_addresses(vec![
            ("vEthernet (WSL)".into(), ip("172.20.0.1")),
            ("Loopback".into(), ip("127.0.0.1")),
            ("Ethernet".into(), ip("10.0.0.5")),
            ("Wi-Fi".into(), ip("192.168.1.20")),
            ("Wi-Fi".into(), ip("fe80::1")),
            ("Wi-Fi".into(), ip("169.254.3.3")),
        ]);
        assert_eq!(ranked, vec!["192.168.1.20", "10.0.0.5", "172.20.0.1"]);
    }

    fn test_hooks() -> (Hooks, mpsc::UnboundedReceiver<Value>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let hooks = Hooks {
            page: Arc::new(|path| {
                Box::pin(async move {
                    (path == "remote.html").then(|| Page { mime: "text/html".into(), body: b"<html>phone</html>".to_vec() })
                })
            }),
            on_message: Arc::new(move |v| {
                let _ = tx.send(v);
            }),
            on_clients: Arc::new(|_| {}),
        };
        (hooks, rx)
    }

    async fn http_get(port: u16, path: &str) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        s.write_all(format!("GET {path} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes()).await.unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        out
    }

    #[tokio::test]
    async fn serves_page_and_round_trips_encrypted_messages() {
        let key = new_key();
        let (hooks, mut inbox) = test_hooks();
        let server = Server::start(0, key, hooks).await.unwrap();
        let port = server.port();

        let page = http_get(port, "/").await;
        assert!(page.starts_with("HTTP/1.1 200"));
        assert!(page.ends_with("<html>phone</html>"));
        assert!(http_get(port, "/secret.txt").await.starts_with("HTTP/1.1 404"));

        let (mut ws, _) = connect_async(format!("ws://127.0.0.1:{port}/ws")).await.unwrap();
        let wait_clients = async {
            while server.clients() == 0 {
                sleep(Duration::from_millis(10)).await;
            }
        };
        timeout(Duration::from_secs(5), wait_clients).await.unwrap();

        // Phone → server: delivered once, the replay is dropped.
        let hello = phone_seal(&key, 1_000, br#"{"type":"hello"}"#);
        ws.send(Message::Binary(hello.clone().into())).await.unwrap();
        ws.send(Message::Binary(hello.into())).await.unwrap();
        ws.send(Message::Binary(phone_seal(&key, 1_001, br#"{"type":"help"}"#).into())).await.unwrap();
        let first = timeout(Duration::from_secs(5), inbox.recv()).await.unwrap().unwrap();
        let second = timeout(Duration::from_secs(5), inbox.recv()).await.unwrap().unwrap();
        assert_eq!(first["type"], "hello");
        assert_eq!(second["type"], "help");

        // Server → phone.
        assert_eq!(server.broadcast(br#"{"type":"state"}"#), 1);
        let frame = loop {
            match timeout(Duration::from_secs(5), ws.next()).await.unwrap().unwrap().unwrap() {
                Message::Binary(b) => break b,
                _ => continue,
            }
        };
        let (_, msg) = open(&XChaCha20Poly1305::new(&key.into()), TO_PHONE, &frame).unwrap();
        assert_eq!(msg, br#"{"type":"state"}"#);

        // Plain text is refused and the socket closed.
        ws.send(Message::Text("{\"type\":\"help\"}".into())).await.unwrap();
        let closed = loop {
            match timeout(Duration::from_secs(5), ws.next()).await.unwrap() {
                Some(Ok(Message::Close(frame))) => break frame.map(|f| u16::from(f.code)),
                Some(Ok(_)) => continue,
                _ => break None,
            }
        };
        assert_eq!(closed, Some(CLOSE_BAD_KEY));
        assert!(inbox.try_recv().is_err());
        server.stop();
    }

    #[tokio::test]
    async fn repairing_disconnects_old_phones() {
        let key = new_key();
        let (hooks, _inbox) = test_hooks();
        let server = Server::start(0, key, hooks).await.unwrap();
        let (mut ws, _) = connect_async(format!("ws://127.0.0.1:{}/ws", server.port())).await.unwrap();
        let wait_clients = async {
            while server.clients() == 0 {
                sleep(Duration::from_millis(10)).await;
            }
        };
        timeout(Duration::from_secs(5), wait_clients).await.unwrap();
        server.set_key(new_key());
        let code = loop {
            match timeout(Duration::from_secs(5), ws.next()).await.unwrap() {
                Some(Ok(Message::Close(frame))) => break frame.map(|f| u16::from(f.code)),
                Some(Ok(_)) => continue,
                _ => break None,
            }
        };
        assert_eq!(code, Some(CLOSE_REPAIRED));
        server.stop();
    }
}
