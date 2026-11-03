//! Settings → MCP: finds Claude Code and Codex, connects them to this app's MCP
//! server (mcp.rs) using their own commands, and checks that the server answers.

use serde::Serialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

const SERVER_NAME: &str = "meeting-helper";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpClientStatus {
    installed: bool,
    connected: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    server_path: String,
    claude: McpClientStatus,
    codex: McpClientStatus,
}

fn server_path() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|e| format!("Couldn't find this app's executable: {e}"))
}

fn hidden(mut command: Command) -> Command {
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    command.stdin(Stdio::null());
    command
}

// Claude Code and Codex are often npm scripts on PATH, which a GUI app on macOS
// and Linux doesn't fully see, so ask a login shell there.
async fn find_cli(name: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    let lookup = {
        let mut c = hidden(Command::new("where.exe"));
        c.arg(name);
        c
    };
    #[cfg(not(windows))]
    let lookup = {
        let mut c = hidden(Command::new("sh"));
        c.args(["-lc", &format!("command -v {name}")]);
        c
    };
    let mut lookup = lookup;
    let output = tokio::time::timeout(Duration::from_secs(5), lookup.output()).await.ok()?.ok()?;
    if !output.status.success() {
        return None;
    }
    let found = String::from_utf8_lossy(&output.stdout).to_string();
    let paths: Vec<&str> = found.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    // `where` also lists a shell script next to the .cmd npm installs; only these can be started.
    let pick = if cfg!(windows) {
        paths.iter().find(|p| {
            let p = p.to_lowercase();
            p.ends_with(".exe") || p.ends_with(".cmd") || p.ends_with(".bat")
        })
    } else {
        paths.first()
    };
    pick.map(PathBuf::from)
}

async fn run_cli(path: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = hidden(Command::new(path));
    command.args(args);
    let output = tokio::time::timeout(Duration::from_secs(30), command.output())
        .await
        .map_err(|_| "The command took too long.".to_string())?
        .map_err(|e| e.to_string())?;
    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    if output.status.success() { Ok(text) } else { Err(text.trim().to_string()) }
}

async fn client_status(name: &str) -> McpClientStatus {
    let Some(path) = find_cli(name).await else {
        return McpClientStatus { installed: false, connected: false };
    };
    let connected = match name {
        "claude" => run_cli(&path, &["mcp", "get", SERVER_NAME]).await.is_ok(),
        _ => run_cli(&path, &["mcp", "list"]).await.is_ok_and(|out| out.contains(SERVER_NAME)),
    };
    McpClientStatus { installed: true, connected }
}

fn check_client(client: &str) -> Result<(), String> {
    match client {
        "claude" | "codex" => Ok(()),
        other => Err(format!("Unknown client {other}")),
    }
}

#[tauri::command]
pub async fn mcp_status() -> Result<McpStatus, String> {
    let (claude, codex) = tokio::join!(client_status("claude"), client_status("codex"));
    Ok(McpStatus { server_path: server_path()?.display().to_string(), claude, codex })
}

#[tauri::command]
pub async fn mcp_connect(client: String) -> Result<(), String> {
    check_client(&client)?;
    let cli = find_cli(&client).await.ok_or("This tool isn't installed, or isn't on the PATH.")?;
    let server = server_path()?.display().to_string();
    // Starting over keeps it working after the app has moved.
    let _ = run_cli(&cli, &["mcp", "remove", SERVER_NAME]).await;
    let args: Vec<&str> = match client.as_str() {
        "claude" => vec!["mcp", "add", "--scope", "user", SERVER_NAME, "--", &server, "--mcp"],
        _ => vec!["mcp", "add", SERVER_NAME, "--", &server, "--mcp"],
    };
    run_cli(&cli, &args).await.map(|_| ())
}

#[tauri::command]
pub async fn mcp_disconnect(client: String) -> Result<(), String> {
    check_client(&client)?;
    let cli = find_cli(&client).await.ok_or("This tool isn't installed, or isn't on the PATH.")?;
    run_cli(&cli, &["mcp", "remove", SERVER_NAME]).await.map(|_| ())
}

// Starts the server the way a client would and asks for its tools.
#[tauri::command]
pub async fn mcp_test() -> Result<u32, String> {
    let mut command = hidden(Command::new(server_path()?));
    let mut child = command
        .arg("--mcp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Couldn't start the server: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("No stdin")?;
    let mut lines = BufReader::new(child.stdout.take().ok_or("No stdout")?).lines();
    let requests = [
        json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "meeting-helper-test", "version": "1" } } }),
        json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
        json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
        json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "list_folders", "arguments": {} } }),
    ];
    for request in &requests {
        let mut line = request.to_string();
        line.push('\n');
        stdin.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
    }
    stdin.flush().await.map_err(|e| e.to_string())?;

    let answers = async {
        let mut tools = 0;
        for _ in 0..3 {
            let line = lines.next_line().await.map_err(|e| e.to_string())?.ok_or("The server closed early.")?;
            let reply: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
            if let Some(list) = reply.pointer("/result/tools").and_then(Value::as_array) {
                tools = list.len() as u32;
            }
            if reply.pointer("/result/isError").and_then(Value::as_bool) == Some(true) {
                let message = reply.pointer("/result/content/0/text").and_then(Value::as_str).unwrap_or("The database couldn't be read.");
                return Err(message.to_string());
            }
        }
        Ok::<u32, String>(tools)
    };
    tokio::time::timeout(Duration::from_secs(10), answers).await.map_err(|_| "The server didn't answer in time.".to_string())?
}

// Opens a terminal running the client in the user's home folder.
#[tauri::command]
pub async fn mcp_open_terminal(client: String) -> Result<(), String> {
    check_client(&client)?;
    if find_cli(&client).await.is_none() {
        return Err("This tool isn't installed, or isn't on the PATH.".into());
    }
    #[cfg(windows)]
    let mut command = {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", "", "cmd", "/K", &client]);
        if let Some(home) = std::env::var_os("USERPROFILE") {
            c.current_dir(home);
        }
        c
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut c = std::process::Command::new("osascript");
        c.args(["-e", &format!("tell application \"Terminal\" to do script \"{client}\""), "-e", "tell application \"Terminal\" to activate"]);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut c = std::process::Command::new("x-terminal-emulator");
        c.args(["-e", &client]);
        if let Some(home) = std::env::var_os("HOME") {
            c.current_dir(home);
        }
        c
    };
    command.spawn().map(|_| ()).map_err(|e| format!("Couldn't open a terminal: {e}"))
}
