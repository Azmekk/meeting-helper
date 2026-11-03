// The schema: one list of migrations, run in order by initDb.
import type Database from '@tauri-apps/plugin-sql';
import { conversationTitle, now } from './helpers';

// Each entry migrates from version i to i+1. Steps run one at a time and are
// idempotent (IF NOT EXISTS, addColumn), so a migration interrupted halfway can
// be re-run safely. A step is SQL or a function for logic SQL can't express.
type MigrationStep = string | ((d: Database) => Promise<void>);

export const MIGRATIONS: MigrationStep[][] = [
  // v1
  [
    `CREATE TABLE IF NOT EXISTS meetings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      duration_ms INTEGER,
      source_path TEXT,
      media_path TEXT,
      status TEXT NOT NULL,
      error TEXT,
      active_transcript_id INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS transcripts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id INTEGER NOT NULL REFERENCES meetings(id),
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      created_at TEXT NOT NULL,
      cost_usd REAL,
      languages TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS speakers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transcript_id INTEGER NOT NULL REFERENCES transcripts(id),
      label TEXT NOT NULL,
      name TEXT,
      is_self INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transcript_id INTEGER NOT NULL REFERENCES transcripts(id),
      speaker_id INTEGER REFERENCES speakers(id),
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      text TEXT NOT NULL,
      edited INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_meetings_created ON meetings(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_transcripts_meeting ON transcripts(meeting_id)`,
    `CREATE INDEX IF NOT EXISTS idx_speakers_transcript ON speakers(transcript_id)`,
    `CREATE INDEX IF NOT EXISTS idx_segments_transcript_start ON segments(transcript_id, start_ms)`,
    `CREATE INDEX IF NOT EXISTS idx_segments_speaker ON segments(speaker_id)`,
    // FTS (trigram). A function so a failure gets a clear message.
    createFtsTable,
    `CREATE TRIGGER IF NOT EXISTS segments_ai AFTER INSERT ON segments BEGIN
      INSERT INTO segments_fts(rowid, text) VALUES (new.id, new.text);
    END`,
    `CREATE TRIGGER IF NOT EXISTS segments_ad AFTER DELETE ON segments BEGIN
      INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', old.id, old.text);
    END`,
    `CREATE TRIGGER IF NOT EXISTS segments_au AFTER UPDATE OF text ON segments BEGIN
      INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', old.id, old.text);
      INSERT INTO segments_fts(rowid, text) VALUES (new.id, new.text);
    END`,
  ],
  // v2: folders, change tracking, AI data, live transcripts
  [
    (d) => addColumn(d, 'meetings', 'uid', 'TEXT'),
    (d) => addColumn(d, 'meetings', 'folder_id', 'INTEGER'),
    (d) => addColumn(d, 'meetings', 'dir_path', 'TEXT'),
    (d) => addColumn(d, 'meetings', 'updated_at', 'TEXT'),
    (d) => addColumn(d, 'meetings', 'briefing', 'TEXT'),
    backfillMeetingUids,
    `UPDATE meetings SET updated_at = created_at WHERE updated_at IS NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_meetings_uid ON meetings(uid)`,
    `CREATE INDEX IF NOT EXISTS idx_meetings_folder ON meetings(folder_id)`,
    `CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      dir_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      briefing TEXT
    )`,
    (d) => addColumn(d, 'transcripts', 'source', "TEXT NOT NULL DEFAULT 'async'"),
    `CREATE TABLE IF NOT EXISTS ai_docs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      owner_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      model TEXT,
      created_at TEXT NOT NULL,
      cost_usd REAL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ai_docs_owner ON ai_docs(scope, owner_id, kind)`,
    `CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      owner_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_chat_messages_owner ON chat_messages(scope, owner_id, id)`,
    `CREATE TABLE IF NOT EXISTS action_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_id INTEGER,
      meeting_id INTEGER,
      text TEXT NOT NULL,
      owner TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      first_seen_meeting INTEGER,
      last_update_meeting INTEGER,
      source_ms INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_action_items_folder ON action_items(folder_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_action_items_meeting ON action_items(meeting_id)`,
    `CREATE TABLE IF NOT EXISTS extraction_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      fields_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_extraction_templates_folder ON extraction_templates(folder_id)`,
    `CREATE TABLE IF NOT EXISTS extraction_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id INTEGER NOT NULL,
      meeting_id INTEGER NOT NULL,
      values_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_extraction_rows_template ON extraction_rows(template_id, meeting_id)`,
    `CREATE INDEX IF NOT EXISTS idx_extraction_rows_meeting ON extraction_rows(meeting_id)`,
  ],
  // v3: backup state, folder change tracking (folder.json)
  [
    (d) => addColumn(d, 'folders', 'updated_at', 'TEXT'),
    `UPDATE folders SET updated_at = created_at WHERE updated_at IS NULL`,
    // One row per backed-up meeting or folder (kind), keyed by its uid.
    // files_json: [{ name, size, mtime, etag, uploadId? }] for the media files.
    `CREATE TABLE IF NOT EXISTS backup_state (
      uid TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'meeting',
      uploaded_at TEXT,
      updated_at TEXT,
      files_json TEXT NOT NULL DEFAULT '[]'
    )`,
  ],
  // v4: per-meeting override of the split-mic setting
  [(d) => addColumn(d, 'meetings', 'split_tracks', 'INTEGER')],
  // v5: vocabulary per folder and per meeting (one term per line)
  [(d) => addColumn(d, 'meetings', 'terms', 'TEXT'), (d) => addColumn(d, 'folders', 'terms', 'TEXT')],
  // v6: several chats per meeting or folder, task proposals in chat, subtasks
  [
    `CREATE TABLE IF NOT EXISTS chat_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      owner_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_chat_conversations_owner ON chat_conversations(scope, owner_id)`,
    (d) => addColumn(d, 'chat_messages', 'conversation_id', 'INTEGER'),
    (d) => addColumn(d, 'chat_messages', 'proposal', 'TEXT'),
    (d) => addColumn(d, 'action_items', 'parent_id', 'INTEGER'),
    backfillConversations,
  ],
  // v7: what each chat answer cost, kept for its line and the conversation total
  [
    (d) => addColumn(d, 'chat_messages', 'model', 'TEXT'),
    (d) => addColumn(d, 'chat_messages', 'cost_usd', 'REAL'),
    (d) => addColumn(d, 'chat_messages', 'cached_percent', 'INTEGER'),
  ],
];

// SQLite has no ADD COLUMN IF NOT EXISTS; check first so re-runs are safe.
async function addColumn(d: Database, table: string, column: string, decl: string): Promise<void> {
  const cols = await d.select<{ name: string }[]>(`PRAGMA table_info(${table})`);
  if (cols.some((c) => c.name === column)) return;
  await d.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

// Existing messages become each meeting's or folder's first conversation.
async function backfillConversations(d: Database): Promise<void> {
  const owners = await d.select<{ scope: string; owner_id: number }[]>(
    'SELECT DISTINCT scope, owner_id FROM chat_messages WHERE conversation_id IS NULL',
  );
  for (const o of owners) {
    const first = await d.select<{ content: string; created_at: string }[]>(
      `SELECT content, created_at FROM chat_messages WHERE scope = $1 AND owner_id = $2 AND conversation_id IS NULL
       ORDER BY CASE role WHEN 'user' THEN 0 ELSE 1 END, id LIMIT 1`,
      [o.scope, o.owner_id],
    );
    const res = await d.execute(
      'INSERT INTO chat_conversations (scope, owner_id, title, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)',
      [o.scope, o.owner_id, conversationTitle(first[0]?.content ?? 'Chat'), first[0]?.created_at ?? now()],
    );
    await d.execute('UPDATE chat_messages SET conversation_id = $1 WHERE scope = $2 AND owner_id = $3 AND conversation_id IS NULL', [
      Number(res.lastInsertId),
      o.scope,
      o.owner_id,
    ]);
  }
}

async function backfillMeetingUids(d: Database): Promise<void> {
  const rows = await d.select<{ id: number }[]>('SELECT id FROM meetings WHERE uid IS NULL');
  for (const r of rows) {
    await d.execute('UPDATE meetings SET uid = $1 WHERE id = $2', [crypto.randomUUID(), r.id]);
  }
}

async function createFtsTable(d: Database): Promise<void> {
  try {
    await d.execute(
      `CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts USING fts5(
        text, content='segments', content_rowid='id', tokenize='trigram'
      )`,
    );
  } catch (err) {
    let version = 'unknown';
    try {
      const rows = await d.select<{ v: string }[]>('SELECT sqlite_version() AS v');
      version = rows[0]?.v ?? version;
    } catch {
      /* ignore */
    }
    throw new Error(
      `Could not create the search index: this SQLite build (version ${version}) lacks FTS5 with the ` +
        `trigram tokenizer (needs SQLite 3.34+). Details: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
