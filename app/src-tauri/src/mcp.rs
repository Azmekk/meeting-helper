//! A local MCP server, so Claude Code, Codex or another MCP client can read this
//! app's meetings and tasks. The same executable runs it when started with
//! `--mcp`: nothing extra to install, and it works while the app is closed. It
//! talks over stdin/stdout and opens the app's database directly (WAL mode lets
//! both run at once). Nothing here reaches the network.
//!
//! Protocol: newline-delimited JSON-RPC 2.0, the MCP stdio transport.

use serde_json::{Value, json};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};
use sqlx::Row;
use std::path::PathBuf;
use std::str::FromStr;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const IDENTIFIER: &str = "com.meetinghelper.app";
const PROTOCOL_VERSION: &str = "2025-06-18";
// The first database version with subtasks.
const MIN_DB_VERSION: i64 = 6;
// Long results get saved to a file by Claude Code, so keep each page below that.
const MAX_PAGE_CHARS: usize = 24_000;

const INSTRUCTIONS: &str = "Meetings recorded in Meeting Helper: transcripts, summaries and tasks. \
Search or list first, then read what you need; transcripts come in pages. \
A meeting listed as \"recording now\" is usually happening right now: its transcript keeps growing and its notes keep changing, so read them again for each question. \
When you state something from a meeting, include a link to that moment so the user can jump to it: \
meeting-helper://meeting/<meeting id>?t=<start in ms>&seg=<line id>. Results give these values, or the whole link. \
Keep such links in your answers. Change tasks only when the user asks you to.";

fn config_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"));
    #[cfg(all(unix, not(target_os = "macos")))]
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")));
    base.map(|b| b.join(IDENTIFIER))
}

fn data_dir() -> Option<PathBuf> {
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
            .map(|b| b.join(IDENTIFIER))
    }
    #[cfg(not(all(unix, not(target_os = "macos"))))]
    {
        config_dir()
    }
}

// Settings → MCP → "Allow task changes". Read per call, so switching it off
// applies to clients already connected.
fn writes_allowed() -> bool {
    let Some(path) = data_dir().map(|d| d.join("settings.json")) else {
        return true;
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return true;
    };
    serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| v.get("settings")?.get("mcpAllowWrites")?.as_bool())
        .unwrap_or(true)
}

async fn open_db() -> Result<SqlitePool, String> {
    let path = config_dir().ok_or("Couldn't find the app's data folder.")?.join("meeting-helper.db");
    if !path.exists() {
        return Err("Meeting Helper has no data yet. Open the app once first.".into());
    }
    let url = format!("sqlite:{}", path.display());
    let options = SqliteConnectOptions::from_str(&url)
        .map_err(|e| e.to_string())?
        .busy_timeout(Duration::from_secs(5));
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|e| format!("Couldn't open the database: {e}"))?;
    let version: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&pool)
        .await
        .map_err(|e| e.to_string())?;
    if version < MIN_DB_VERSION {
        return Err("The database is from an older version. Open Meeting Helper once to update it.".into());
    }
    Ok(pool)
}

fn timestamp(ms: i64) -> String {
    let s = ms.max(0) / 1000;
    let (h, m, s) = (s / 3600, (s % 3600) / 60, s % 60);
    if h > 0 { format!("{h}:{m:02}:{s:02}") } else { format!("{m:02}:{s:02}") }
}

fn link(meeting: i64, ms: i64, seg: Option<i64>) -> String {
    match seg {
        Some(seg) => format!("meeting-helper://meeting/{meeting}?t={ms}&seg={seg}"),
        None => format!("meeting-helper://meeting/{meeting}?t={ms}"),
    }
}

fn int(args: &Value, key: &str) -> Option<i64> {
    args.get(key).and_then(Value::as_i64)
}

fn text<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

// The search index matches text of 3+ characters. Same rules as the app's search
// (lib/search.ts), including the common Bulgarian word endings.
const BG_ENDINGS: [&str; 18] = ["ите", "ата", "ото", "ете", "ове", "ища", "ият", "ът", "ят", "та", "то", "те", "ия", "и", "а", "я", "о", "е"];

fn bulgarian_stem(term: &str) -> Option<String> {
    if term.chars().count() < 5 {
        return None;
    }
    BG_ENDINGS.iter().find_map(|ending| {
        let stem = term.strip_suffix(ending)?;
        (stem.chars().count() >= 4).then(|| stem.to_string())
    })
}

fn fts_query(query: &str) -> Option<String> {
    let quote = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
    let mut clauses = Vec::new();
    for (i, part) in query.split('"').enumerate() {
        if i % 2 == 1 {
            let phrase = part.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
            if phrase.chars().count() >= 3 {
                clauses.push(quote(&phrase));
            }
            continue;
        }
        for word in part.split_whitespace() {
            let term = word.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase();
            if term.chars().count() < 3 {
                continue;
            }
            clauses.push(match bulgarian_stem(&term) {
                Some(stem) => format!("({} OR {})", quote(&term), quote(&stem)),
                None => quote(&term),
            });
        }
    }
    (!clauses.is_empty()).then(|| clauses.join(" AND "))
}

async fn list_folders(db: &SqlitePool) -> Result<String, String> {
    let rows = sqlx::query(
        "SELECT f.id, f.name, (SELECT COUNT(*) FROM meetings m WHERE m.folder_id = f.id) AS meetings,
           (SELECT COUNT(*) FROM action_items a WHERE a.folder_id = f.id AND a.status = 'open') AS open_tasks
         FROM folders f ORDER BY f.name",
    )
    .fetch_all(db)
    .await
    .map_err(|e| e.to_string())?;
    if rows.is_empty() {
        return Ok("There are no folders.".into());
    }
    Ok(rows
        .iter()
        .map(|r| {
            format!(
                "folder {} | {} | {} meetings | {} open tasks",
                r.get::<i64, _>("id"),
                r.get::<String, _>("name"),
                r.get::<i64, _>("meetings"),
                r.get::<i64, _>("open_tasks")
            )
        })
        .collect::<Vec<_>>()
        .join("\n"))
}

async fn list_meetings(db: &SqlitePool, args: &Value) -> Result<String, String> {
    let limit = int(args, "limit").unwrap_or(50).clamp(1, 200);
    let folder = int(args, "folder_id");
    let rows = sqlx::query(
        "SELECT m.id, m.title, m.created_at, m.duration_ms, m.folder_id, m.status, f.name AS folder,
           EXISTS (SELECT 1 FROM ai_docs d WHERE d.scope = 'meeting' AND d.owner_id = m.id AND d.kind = 'summary') AS has_summary,
           EXISTS (SELECT 1 FROM ai_docs d WHERE d.scope = 'meeting' AND d.owner_id = m.id AND d.kind = 'notes') AS has_notes,
           m.active_transcript_id IS NOT NULL AS has_transcript
         FROM meetings m LEFT JOIN folders f ON f.id = m.folder_id
         WHERE ($1 IS NULL OR m.folder_id = $1)
         ORDER BY m.created_at DESC LIMIT $2",
    )
    .bind(folder)
    .bind(limit)
    .fetch_all(db)
    .await
    .map_err(|e| e.to_string())?;
    if rows.is_empty() {
        return Ok("No meetings.".into());
    }
    Ok(rows
        .iter()
        .map(|r| {
            let date: String = r.get("created_at");
            format!(
                "meeting {} | {} | {} | {} | folder: {} | transcript: {} | summary: {} | notes: {}{}",
                r.get::<i64, _>("id"),
                date.get(..10).unwrap_or(&date),
                r.get::<String, _>("title"),
                r.get::<Option<i64>, _>("duration_ms").map_or("?".into(), timestamp),
                r.get::<Option<String>, _>("folder").unwrap_or_else(|| "none".into()),
                if r.get::<bool, _>("has_transcript") { "yes" } else { "no" },
                if r.get::<bool, _>("has_summary") { "yes" } else { "no" },
                if r.get::<bool, _>("has_notes") { "yes" } else { "no" },
                if r.get::<String, _>("status") == "recording" { " | recording now" } else { "" },
            )
        })
        .collect::<Vec<_>>()
        .join("\n"))
}

async fn search(db: &SqlitePool, args: &Value) -> Result<String, String> {
    let query = text(args, "query").ok_or("Give words to search for.")?;
    let fts = fts_query(query).ok_or("Search needs at least one word of 3 or more characters.")?;
    let limit = int(args, "limit").unwrap_or(30).clamp(1, 80);
    let rows = sqlx::query(
        "SELECT m.id AS meeting_id, m.title, s.id AS segment_id, s.start_ms, s.text,
           COALESCE(NULLIF(TRIM(sp.name), ''), sp.label) AS speaker
         FROM segments s
         JOIN meetings m ON m.active_transcript_id = s.transcript_id
         LEFT JOIN speakers sp ON sp.id = s.speaker_id
         WHERE s.id IN (SELECT rowid FROM segments_fts WHERE segments_fts MATCH $1)
           AND ($2 IS NULL OR m.folder_id = $2)
         ORDER BY m.created_at DESC, m.id DESC, s.start_ms, s.id LIMIT $3",
    )
    .bind(fts)
    .bind(int(args, "folder_id"))
    .bind(limit)
    .fetch_all(db)
    .await
    .map_err(|e| e.to_string())?;
    if rows.is_empty() {
        return Ok("No matches.".into());
    }
    Ok(rows
        .iter()
        .map(|r| {
            let (meeting, ms, seg) = (r.get::<i64, _>("meeting_id"), r.get::<i64, _>("start_ms"), r.get::<i64, _>("segment_id"));
            format!(
                "meeting {meeting} \"{}\" {} {}: {}\n  {}",
                r.get::<String, _>("title"),
                timestamp(ms),
                r.get::<Option<String>, _>("speaker").unwrap_or_else(|| "Unknown".into()),
                r.get::<String, _>("text"),
                link(meeting, ms, Some(seg)),
            )
        })
        .collect::<Vec<_>>()
        .join("\n"))
}

async fn meeting_summary(db: &SqlitePool, args: &Value) -> Result<String, String> {
    let id = int(args, "meeting_id").ok_or("meeting_id is required.")?;
    let row = sqlx::query("SELECT content FROM ai_docs WHERE scope = 'meeting' AND owner_id = $1 AND kind = 'summary' ORDER BY id DESC LIMIT 1")
        .bind(id)
        .fetch_optional(db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(match row {
        Some(r) => format!("Citations like [#123] are line ids from get_transcript.\n\n{}", r.get::<String, _>("content")),
        None => format!("Meeting {id} has no summary yet; read it with get_transcript."),
    })
}

async fn meeting_notes(db: &SqlitePool, args: &Value) -> Result<String, String> {
    let id = int(args, "meeting_id").ok_or("meeting_id is required.")?;
    let row = sqlx::query(
        "SELECT d.content, d.created_at, m.status FROM ai_docs d JOIN meetings m ON m.id = d.owner_id
         WHERE d.scope = 'meeting' AND d.owner_id = $1 AND d.kind = 'notes' ORDER BY d.id DESC LIMIT 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await
    .map_err(|e| e.to_string())?;
    let Some(r) = row else {
        return Ok(format!("Meeting {id} has no live notes; read it with get_transcript."));
    };
    let content = r.get::<String, _>("content");
    Ok(if r.get::<String, _>("status") == "recording" {
        format!("Running notes, last updated {} (UTC). Newer lines may only be in get_transcript.\n\n{content}", r.get::<String, _>("created_at"))
    } else {
        format!("Notes taken during the meeting.\n\n{content}")
    })
}

async fn transcript(db: &SqlitePool, args: &Value) -> Result<String, String> {
    let id = int(args, "meeting_id").ok_or("meeting_id is required.")?;
    let offset = int(args, "offset").unwrap_or(0).max(0);
    let rows = sqlx::query(
        "SELECT s.id, s.start_ms, s.text, COALESCE(NULLIF(TRIM(sp.name), ''), sp.label) AS speaker
         FROM segments s
         JOIN meetings m ON m.active_transcript_id = s.transcript_id
         LEFT JOIN speakers sp ON sp.id = s.speaker_id
         WHERE m.id = $1 AND TRIM(s.text) <> ''
         ORDER BY s.start_ms, s.id LIMIT -1 OFFSET $2",
    )
    .bind(id)
    .bind(offset)
    .fetch_all(db)
    .await
    .map_err(|e| e.to_string())?;
    if rows.is_empty() {
        return Ok(if offset > 0 { "End of transcript.".into() } else { format!("Meeting {id} has no transcript text.") });
    }
    let mut out = format!("Meeting {id}, lines from {offset}. Format: [line id, start in ms, time, speaker]\n");
    let mut taken = 0;
    for r in &rows {
        let line = format!(
            "[#{} t={} {} {}] {}\n",
            r.get::<i64, _>("id"),
            r.get::<i64, _>("start_ms"),
            timestamp(r.get("start_ms")),
            r.get::<Option<String>, _>("speaker").unwrap_or_else(|| "Unknown".into()),
            r.get::<String, _>("text"),
        );
        if out.chars().count() + line.chars().count() > MAX_PAGE_CHARS && taken > 0 {
            break;
        }
        out.push_str(&line);
        taken += 1;
    }
    if taken < rows.len() {
        out.push_str(&format!("(more lines: call again with offset {})", offset + taken as i64));
    } else {
        out.push_str("(end of transcript)");
    }
    Ok(out)
}

async fn folder_of(db: &SqlitePool, args: &Value) -> Result<i64, String> {
    if let Some(id) = int(args, "folder_id") {
        return Ok(id);
    }
    let meeting = int(args, "meeting_id").ok_or("Give folder_id or meeting_id.")?;
    sqlx::query_scalar::<_, Option<i64>>("SELECT folder_id FROM meetings WHERE id = $1")
        .bind(meeting)
        .fetch_optional(db)
        .await
        .map_err(|e| e.to_string())?
        .flatten()
        .ok_or_else(|| format!("Meeting {meeting} isn't in a folder, so it has no tasks."))
}

async fn list_tasks(db: &SqlitePool, args: &Value) -> Result<String, String> {
    let folder = folder_of(db, args).await?;
    let meeting = int(args, "meeting_id");
    let rows = sqlx::query(
        "SELECT id, parent_id, text, description, owner, status, meeting_id, source_ms FROM action_items
         WHERE folder_id = $1 AND ($2 IS NULL OR meeting_id = $2 OR first_seen_meeting = $2 OR last_update_meeting = $2)
         ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'suggested' THEN 1 WHEN 'done' THEN 2 ELSE 3 END, created_at, id",
    )
    .bind(folder)
    .bind(meeting)
    .fetch_all(db)
    .await
    .map_err(|e| e.to_string())?;
    if rows.is_empty() {
        return Ok("No tasks.".into());
    }
    Ok(rows
        .iter()
        .map(|r| {
            let mut line = format!("task {} [{}]: {}", r.get::<i64, _>("id"), r.get::<String, _>("status"), r.get::<String, _>("text"));
            if let Some(owner) = r.get::<Option<String>, _>("owner") {
                line.push_str(&format!(" | owner: {owner}"));
            }
            if let Some(parent) = r.get::<Option<i64>, _>("parent_id") {
                line.push_str(&format!(" | subtask of {parent}"));
            }
            if let (Some(m), Some(ms)) = (r.get::<Option<i64>, _>("meeting_id"), r.get::<Option<i64>, _>("source_ms")) {
                line.push_str(&format!(" | {}", link(m, ms, None)));
            }
            if let Some(description) = r.get::<Option<String>, _>("description") {
                line.push_str(&format!("\n  {description}"));
            }
            line
        })
        .collect::<Vec<_>>()
        .join("\n"))
}

const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

// What backup and the sidecar files watch to see what changed.
async fn touch(db: &SqlitePool, folder: Option<i64>, meeting: Option<i64>) -> Result<(), String> {
    if let Some(id) = meeting {
        sqlx::query(&format!("UPDATE meetings SET updated_at = {NOW} WHERE id = $1")).bind(id).execute(db).await.map_err(|e| e.to_string())?;
    }
    if let Some(id) = folder {
        sqlx::query(&format!("UPDATE folders SET updated_at = {NOW} WHERE id = $1")).bind(id).execute(db).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

async fn add_task(db: &SqlitePool, args: &Value) -> Result<String, String> {
    let task = text(args, "text").ok_or("text is required.")?;
    let folder = folder_of(db, args).await?;
    let parent = int(args, "parent_id");
    if let Some(p) = parent {
        let parent_folder: Option<Option<i64>> = sqlx::query_scalar("SELECT folder_id FROM action_items WHERE id = $1")
            .bind(p)
            .fetch_optional(db)
            .await
            .map_err(|e| e.to_string())?;
        if parent_folder.flatten() != Some(folder) {
            return Err(format!("Task {p} isn't in this folder."));
        }
    }
    let meeting = int(args, "meeting_id");
    // Counts as added by hand: re-running action items leaves it alone.
    let res = sqlx::query(&format!(
        "INSERT INTO action_items (folder_id, meeting_id, text, owner, status, parent_id, description, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'open', $5, $6, {NOW}, {NOW})"
    ))
    .bind(folder)
    .bind(meeting)
    .bind(task)
    .bind(text(args, "owner"))
    .bind(parent)
    .bind(text(args, "description"))
    .execute(db)
    .await
    .map_err(|e| e.to_string())?;
    touch(db, Some(folder), meeting).await?;
    Ok(format!("Added task {}.", res.last_insert_rowid()))
}

async fn update_task(db: &SqlitePool, args: &Value) -> Result<String, String> {
    let id = int(args, "id").ok_or("id is required.")?;
    let status = text(args, "status");
    if let Some(s) = status
        && !["open", "done", "dropped"].contains(&s)
    {
        return Err("status must be open, done or dropped.".into());
    }
    let task = text(args, "text");
    let owner = text(args, "owner");
    let description = text(args, "description");
    if task.is_none() && owner.is_none() && status.is_none() && description.is_none() {
        return Err("Nothing to change: give text, owner, status or description.".into());
    }
    let row = sqlx::query(&format!(
        "UPDATE action_items SET text = COALESCE($1, text), owner = COALESCE($2, owner), status = COALESCE($3, status), description = COALESCE($4, description), updated_at = {NOW}
         WHERE id = $5 RETURNING folder_id, meeting_id"
    ))
    .bind(task)
    .bind(owner)
    .bind(status)
    .bind(description)
    .bind(id)
    .fetch_optional(db)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| format!("There is no task {id}."))?;
    touch(db, row.get("folder_id"), row.get("meeting_id")).await?;
    Ok(format!("Updated task {id}."))
}

fn tool(name: &str, description: &str, read_only: bool, properties: Value, required: &[&str]) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": { "type": "object", "properties": properties, "required": required, "additionalProperties": false },
        "annotations": { "readOnlyHint": read_only },
    })
}

fn tools() -> Value {
    let id = json!({ "type": "integer" });
    let mut list = vec![
        tool("list_folders", "Lists folders (a project, client or team) with their meeting and open task counts.", true, json!({}), &[]),
        tool(
            "list_meetings",
            "Lists meetings, newest first, optionally in one folder.",
            true,
            json!({ "folder_id": id, "limit": { "type": "integer", "description": "Default 50, max 200" } }),
            &[],
        ),
        tool(
            "search_transcripts",
            "Searches transcripts, newest meetings first. Matches words and word stems, Bulgarian endings too; \"quoted phrases\" match exactly. Each hit has a link to that moment.",
            true,
            json!({ "query": { "type": "string" }, "folder_id": id, "limit": { "type": "integer", "description": "Default 30, max 80" } }),
            &["query"],
        ),
        tool("get_meeting_summary", "Returns a meeting's AI summary, if it has one.", true, json!({ "meeting_id": id }), &["meeting_id"]),
        tool(
            "get_meeting_notes",
            "Returns the short running notes kept during a live meeting, including one still being recorded.",
            true,
            json!({ "meeting_id": id }),
            &["meeting_id"],
        ),
        tool(
            "get_transcript",
            "Returns transcript lines of a meeting, one page at a time. A page says which offset comes next.",
            true,
            json!({ "meeting_id": id, "offset": { "type": "integer", "description": "Line to start from, default 0" } }),
            &["meeting_id"],
        ),
        tool(
            "list_tasks",
            "Lists tasks with their ids, status and subtasks. With meeting_id: only tasks from that meeting. With folder_id: the whole folder.",
            true,
            json!({ "folder_id": id, "meeting_id": id }),
            &[],
        ),
    ];
    if writes_allowed() {
        list.push(tool(
            "add_task",
            "Adds a task to a folder, or a subtask with parent_id. Only when the user asks. Give folder_id or meeting_id.",
            false,
            json!({
                "text": { "type": "string", "description": "One short line" },
                "description": { "type": "string", "description": "A few sentences on what was said and the details" },
                "owner": { "type": "string" },
                "folder_id": id,
                "meeting_id": id,
                "parent_id": { "type": "integer", "description": "Makes this a subtask of that task" },
            }),
            &["text"],
        ));
        list.push(tool(
            "update_task",
            "Rewords a task, changes its description or owner, or sets its status. Only when the user asks. Tasks can't be deleted from here.",
            false,
            json!({
                "id": id,
                "text": { "type": "string" },
                "description": { "type": "string" },
                "owner": { "type": "string" },
                "status": { "type": "string", "enum": ["open", "done", "dropped"] },
            }),
            &["id"],
        ));
    }
    json!({ "tools": list })
}

async fn call_tool(params: &Value) -> Result<String, String> {
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
    let writes = matches!(name, "add_task" | "update_task");
    if writes && !writes_allowed() {
        return Err("Task changes are turned off in Meeting Helper → Settings → MCP.".into());
    }
    let db = open_db().await?;
    let result = match name {
        "list_folders" => list_folders(&db).await,
        "list_meetings" => list_meetings(&db, &args).await,
        "search_transcripts" => search(&db, &args).await,
        "get_meeting_summary" => meeting_summary(&db, &args).await,
        "get_meeting_notes" => meeting_notes(&db, &args).await,
        "get_transcript" => transcript(&db, &args).await,
        "list_tasks" => list_tasks(&db, &args).await,
        "add_task" => add_task(&db, &args).await,
        "update_task" => update_task(&db, &args).await,
        other => Err(format!("Unknown tool {other}")),
    };
    db.close().await;
    result
}

async fn handle(request: &Value) -> Option<Value> {
    // Notifications (no id) get no reply.
    let id = request.get("id")?.clone();
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
    let result = match request.get("method").and_then(Value::as_str).unwrap_or("") {
        "initialize" => json!({
            "protocolVersion": params.get("protocolVersion").and_then(Value::as_str).unwrap_or(PROTOCOL_VERSION),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "meeting-helper", "version": env!("CARGO_PKG_VERSION") },
            "instructions": INSTRUCTIONS,
        }),
        "ping" => json!({}),
        "tools/list" => tools(),
        "tools/call" => match call_tool(&params).await {
            Ok(text) => json!({ "content": [{ "type": "text", "text": text }] }),
            // A tool failure goes to the model, not to the protocol layer.
            Err(text) => json!({ "content": [{ "type": "text", "text": text }], "isError": true }),
        },
        method => {
            return Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("Unknown method {method}") } }));
        }
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

async fn serve() {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(request) => handle(&request).await,
            Err(e) => Some(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": e.to_string() } })),
        };
        if let Some(reply) = reply {
            let mut out = reply.to_string();
            out.push('\n');
            if stdout.write_all(out.as_bytes()).await.is_err() || stdout.flush().await.is_err() {
                break;
            }
        }
    }
}

/// Runs the server until the client closes stdin. Called instead of the app when
/// the executable is started with `--mcp`.
pub fn run() {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("couldn't start the MCP server");
    runtime.block_on(serve());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_search_queries() {
        assert_eq!(fts_query("ab").as_deref(), None);
        assert_eq!(fts_query("billing export").as_deref(), Some("\"billing\" AND \"export\""));
        assert_eq!(fts_query("\"billing export\"").as_deref(), Some("\"billing export\""));
        assert_eq!(fts_query("срещата").as_deref(), Some("(\"срещата\" OR \"срещ\")"));
    }

    #[test]
    fn formats_times_and_links() {
        assert_eq!(timestamp(75_000), "01:15");
        assert_eq!(timestamp(3_675_000), "1:01:15");
        assert_eq!(link(12, 75_000, Some(345)), "meeting-helper://meeting/12?t=75000&seg=345");
    }

    #[tokio::test]
    async fn shows_a_meeting_being_recorded_and_its_notes() {
        let db = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        for sql in [
            "CREATE TABLE folders (id INTEGER PRIMARY KEY, name TEXT)",
            "CREATE TABLE meetings (id INTEGER PRIMARY KEY, title TEXT, created_at TEXT, duration_ms INTEGER, folder_id INTEGER, status TEXT, active_transcript_id INTEGER)",
            "CREATE TABLE ai_docs (id INTEGER PRIMARY KEY, scope TEXT, owner_id INTEGER, kind TEXT, content TEXT, created_at TEXT)",
            "INSERT INTO meetings (id, title, created_at, status) VALUES (1, 'Old', '2026-11-01T10:00:00Z', 'ready'), (2, 'Now', '2026-11-03T10:00:00Z', 'recording')",
            "INSERT INTO ai_docs (scope, owner_id, kind, content, created_at) VALUES ('meeting', 2, 'notes', '- Budget', '2026-11-03T10:05:00Z')",
        ] {
            sqlx::query(sql).execute(&db).await.unwrap();
        }

        let list = list_meetings(&db, &json!({})).await.unwrap();
        let (now, old) = list.split_once('\n').unwrap();
        assert!(now.ends_with("notes: yes | recording now"));
        assert!(old.ends_with("notes: no"));

        let notes = meeting_notes(&db, &json!({ "meeting_id": 2 })).await.unwrap();
        assert!(notes.starts_with("Running notes, last updated 2026-11-03T10:05:00Z"));
        assert!(notes.ends_with("- Budget"));
        assert!(meeting_notes(&db, &json!({ "meeting_id": 1 })).await.unwrap().contains("no live notes"));
    }

    #[tokio::test]
    async fn answers_the_handshake() {
        let reply = handle(&json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26" } })).await.unwrap();
        assert_eq!(reply["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(reply["result"]["serverInfo"]["name"], "meeting-helper");
        assert!(handle(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await.is_none());
        let unknown = handle(&json!({ "jsonrpc": "2.0", "id": 2, "method": "nope" })).await.unwrap();
        assert_eq!(unknown["error"]["code"], -32601);
    }
}
