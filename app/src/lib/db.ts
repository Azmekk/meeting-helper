// SQLite through @tauri-apps/plugin-sql (`sqlite:meeting-helper.db`).
//
// plugin-sql caveats this module is written around:
// - It uses a connection pool, so BEGIN/COMMIT can't span several execute()
//   calls; multi-step writes clean up after themselves on failure instead.
// - PRAGMA foreign_keys is per connection, so child rows are deleted
//   explicitly rather than through ON DELETE CASCADE.
import Database from '@tauri-apps/plugin-sql';
import type {
  ActionItem,
  ActionItemStatus,
  AiDoc,
  AiDocKind,
  AiScope,
  ChatConversation,
  ChatMessage,
  TaskProposal,
  ExtractionField,
  ExtractionRow,
  ExtractionTemplate,
  Folder,
  Meeting,
  MeetingStatus,
  ProviderId,
  SearchHit,
  Segment,
  Speaker,
  Transcript,
  TranscriptDetail,
  TranscriptSource,
} from './types';
import { buildSearchSql } from './search';

let db: Database | null = null;

function conn(): Database {
  if (!db) throw new Error('Database not initialised (initDb was not called)');
  return db;
}

// ---------- Schema ----------

// Each entry migrates from version i to i+1. Steps run one at a time and are
// idempotent (IF NOT EXISTS, addColumn), so a migration interrupted halfway can
// be re-run safely. A step is SQL or a function for logic SQL can't express.
type MigrationStep = string | ((d: Database) => Promise<void>);

const MIGRATIONS: MigrationStep[][] = [
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

function conversationTitle(question: string): string {
  const text = question.replace(/\s+/g, ' ').trim();
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
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

// Opens the database and applies migrations. Called once at startup.
export async function initDb(): Promise<void> {
  if (db) return;
  const d = await Database.load('sqlite:meeting-helper.db');
  try {
    await d.execute('PRAGMA journal_mode = WAL');
  } catch {
    /* not essential */
  }
  const rows = await d.select<{ user_version: number }[]>('PRAGMA user_version');
  const current = Number(rows[0]?.user_version ?? 0);
  for (let v = current; v < MIGRATIONS.length; v++) {
    for (const step of MIGRATIONS[v]) {
      if (typeof step === 'string') await d.execute(step);
      else await step(d);
    }
    await d.execute(`PRAGMA user_version = ${v + 1}`);
  }
  db = d;
}

// ---------- Row mapping ----------

interface MeetingRow {
  id: number;
  uid: string;
  title: string;
  created_at: string;
  duration_ms: number | null;
  source_path: string | null;
  media_path: string | null;
  status: MeetingStatus;
  error: string | null;
  active_transcript_id: number | null;
  folder_id: number | null;
  dir_path: string | null;
  updated_at: string | null;
  briefing: string | null;
  split_tracks: number | null;
  terms: string | null;
}

interface FolderRow {
  id: number;
  uid: string;
  name: string;
  dir_name: string;
  created_at: string;
  briefing: string | null;
  terms: string | null;
}

interface TranscriptRow {
  id: number;
  meeting_id: number;
  provider: ProviderId;
  model: string;
  source: TranscriptSource | null;
  created_at: string;
  cost_usd: number | null;
  languages: string | null;
}

interface SpeakerRow {
  id: number;
  transcript_id: number;
  label: string;
  name: string | null;
  is_self: number;
}

interface SegmentRow {
  id: number;
  transcript_id: number;
  speaker_id: number | null;
  start_ms: number;
  end_ms: number;
  text: string;
  edited: number;
}

const toMeeting = (r: MeetingRow): Meeting => ({
  id: r.id,
  uid: r.uid,
  title: r.title,
  createdAt: r.created_at,
  durationMs: r.duration_ms,
  sourcePath: r.source_path,
  mediaPath: r.media_path,
  status: r.status,
  error: r.error,
  activeTranscriptId: r.active_transcript_id,
  folderId: r.folder_id,
  dirPath: r.dir_path,
  updatedAt: r.updated_at ?? r.created_at,
  briefing: r.briefing,
  splitTracks: r.split_tracks == null ? null : !!r.split_tracks,
  terms: splitTerms(r.terms),
});

const toFolder = (r: FolderRow): Folder => ({
  id: r.id,
  uid: r.uid,
  name: r.name,
  dirName: r.dir_name,
  createdAt: r.created_at,
  briefing: r.briefing,
  terms: splitTerms(r.terms),
});

const splitTerms = (text: string | null): string[] => (text ? text.split('\n').filter(Boolean) : []);
const joinTerms = (terms: string[]): string | null => (terms.length ? terms.join('\n') : null);

const toTranscript = (r: TranscriptRow): Transcript => ({
  id: r.id,
  meetingId: r.meeting_id,
  provider: r.provider,
  model: r.model,
  source: r.source ?? 'async',
  createdAt: r.created_at,
  costUsd: r.cost_usd,
  languages: r.languages,
});

const toSpeaker = (r: SpeakerRow): Speaker => ({
  id: r.id,
  transcriptId: r.transcript_id,
  label: r.label,
  name: r.name,
  isSelf: !!r.is_self,
});

const toSegment = (r: SegmentRow): Segment => ({
  id: r.id,
  transcriptId: r.transcript_id,
  speakerId: r.speaker_id,
  startMs: r.start_ms,
  endMs: r.end_ms,
  text: r.text,
  edited: !!r.edited,
});

const now = () => new Date().toISOString();

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---------- Change tracking ----------

// Every write that changes a meeting's content bumps meetings.updated_at so
// backup can tell what changed. Each entry resolves the meeting from a child id.
const TOUCH_SQL = {
  meeting: 'UPDATE meetings SET updated_at = $1 WHERE id = $2',
  transcript: 'UPDATE meetings SET updated_at = $1 WHERE id = (SELECT meeting_id FROM transcripts WHERE id = $2)',
  segment: `UPDATE meetings SET updated_at = $1 WHERE id = (
    SELECT t.meeting_id FROM segments s JOIN transcripts t ON t.id = s.transcript_id WHERE s.id = $2)`,
  speaker: `UPDATE meetings SET updated_at = $1 WHERE id = (
    SELECT t.meeting_id FROM speakers sp JOIN transcripts t ON t.id = sp.transcript_id WHERE sp.id = $2)`,
} as const;

async function touch(kind: keyof typeof TOUCH_SQL, id: number): Promise<void> {
  await conn().execute(TOUCH_SQL[kind], [now(), id]);
}

// ---------- Meetings ----------

export async function createMeeting(m: {
  title: string;
  sourcePath: string | null;
  mediaPath: string | null;
  status: MeetingStatus;
  durationMs?: number | null;
}): Promise<number> {
  const res = await conn().execute(
    `INSERT INTO meetings (uid, title, created_at, updated_at, duration_ms, source_path, media_path, status)
     VALUES ($1, $2, $3, $3, $4, $5, $6, $7)`,
    [crypto.randomUUID(), m.title, now(), m.durationMs ?? null, m.sourcePath, m.mediaPath, m.status],
  );
  if (res.lastInsertId == null) throw new Error('createMeeting: no id returned');
  return Number(res.lastInsertId);
}

const MEETING_COLUMNS: Record<string, string> = {
  title: 'title',
  durationMs: 'duration_ms',
  sourcePath: 'source_path',
  mediaPath: 'media_path',
  status: 'status',
  error: 'error',
  folderId: 'folder_id',
  dirPath: 'dir_path',
  briefing: 'briefing',
  splitTracks: 'split_tracks',
  terms: 'terms',
};

export async function updateMeeting(
  id: number,
  patch: Partial<
    Pick<
      Meeting,
      | 'title'
      | 'durationMs'
      | 'sourcePath'
      | 'mediaPath'
      | 'status'
      | 'error'
      | 'folderId'
      | 'dirPath'
      | 'briefing'
      | 'splitTracks'
      | 'terms'
    >
  >,
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const col = MEETING_COLUMNS[key];
    if (!col || value === undefined) continue;
    params.push(typeof value === 'boolean' ? Number(value) : Array.isArray(value) ? joinTerms(value) : value);
    sets.push(`${col} = $${params.length}`);
  }
  if (!sets.length) return;
  params.push(now());
  sets.push(`updated_at = $${params.length}`);
  params.push(id);
  await conn().execute(`UPDATE meetings SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
}

export async function getMeeting(id: number): Promise<Meeting | null> {
  const rows = await conn().select<MeetingRow[]>('SELECT * FROM meetings WHERE id = $1', [id]);
  return rows[0] ? toMeeting(rows[0]) : null;
}

// Newest first.
export async function listMeetings(): Promise<Meeting[]> {
  const rows = await conn().select<MeetingRow[]>('SELECT * FROM meetings ORDER BY created_at DESC, id DESC');
  return rows.map(toMeeting);
}

// Meetings still marked 'recording', newest first (normally at most one).
export async function listRecordingMeetings(): Promise<Meeting[]> {
  const rows = await conn().select<MeetingRow[]>(
    "SELECT * FROM meetings WHERE status = 'recording' ORDER BY created_at DESC, id DESC",
  );
  return rows.map(toMeeting);
}

// Meetings still marked 'processing'.
export async function listProcessingMeetings(): Promise<Meeting[]> {
  const rows = await conn().select<MeetingRow[]>("SELECT * FROM meetings WHERE status = 'processing'");
  return rows.map(toMeeting);
}

// Deletes the meeting with all transcripts/speakers/segments and its AI data.
// Does not touch files on disk (see deleteMeetingFiles in pipeline.ts).
export async function deleteMeeting(id: number): Promise<void> {
  const d = conn();
  const sub = 'SELECT id FROM transcripts WHERE meeting_id = $1';
  await d.execute(`DELETE FROM segments WHERE transcript_id IN (${sub})`, [id]);
  await d.execute(`DELETE FROM speakers WHERE transcript_id IN (${sub})`, [id]);
  await d.execute('DELETE FROM transcripts WHERE meeting_id = $1', [id]);
  await d.execute("DELETE FROM ai_docs WHERE scope = 'meeting' AND owner_id = $1", [id]);
  await d.execute("DELETE FROM chat_messages WHERE scope = 'meeting' AND owner_id = $1", [id]);
  await d.execute("DELETE FROM chat_conversations WHERE scope = 'meeting' AND owner_id = $1", [id]);
  await d.execute('DELETE FROM action_items WHERE meeting_id = $1', [id]);
  await d.execute('DELETE FROM extraction_rows WHERE meeting_id = $1', [id]);
  await d.execute('DELETE FROM meetings WHERE id = $1', [id]);
}

// ---------- Folders ----------

// Folder names become directory names, so drop characters Windows forbids.
function safeDirName(name: string): string {
  const clean = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return clean || 'Folder';
}

export async function createFolder(name: string, dirName?: string): Promise<Folder> {
  const clean = name.trim() || 'Untitled folder';
  const folder = { uid: crypto.randomUUID(), name: clean, dirName: dirName ?? safeDirName(clean), createdAt: now() };
  const res = await conn().execute('INSERT INTO folders (uid, name, dir_name, created_at) VALUES ($1, $2, $3, $4)', [
    folder.uid,
    folder.name,
    folder.dirName,
    folder.createdAt,
  ]);
  if (res.lastInsertId == null) throw new Error('createFolder: no id returned');
  return { id: Number(res.lastInsertId), ...folder, briefing: null, terms: [] };
}

// Alphabetical.
export async function listFolders(): Promise<Folder[]> {
  const rows = await conn().select<FolderRow[]>('SELECT * FROM folders ORDER BY name COLLATE NOCASE, id');
  return rows.map(toFolder);
}

export async function getFolder(id: number): Promise<Folder | null> {
  const rows = await conn().select<FolderRow[]>('SELECT * FROM folders WHERE id = $1', [id]);
  return rows[0] ? toFolder(rows[0]) : null;
}

// Renames the folder in the app only; moving the directory is the caller's job
// (pass the new `dirName` once it has been moved).
export async function renameFolder(id: number, name: string, dirName?: string): Promise<void> {
  const clean = name.trim();
  if (!clean) return;
  if (dirName !== undefined) {
    await conn().execute('UPDATE folders SET name = $1, dir_name = $2 WHERE id = $3', [clean, dirName, id]);
  } else {
    await conn().execute('UPDATE folders SET name = $1 WHERE id = $2', [clean, id]);
  }
  await touchFolder(id);
}

// Deletes the folder and its folder-level AI data. Its meetings are kept and
// become unassigned. Does not touch files on disk.
export async function deleteFolder(id: number): Promise<void> {
  const d = conn();
  await d.execute('UPDATE meetings SET folder_id = NULL, updated_at = $1 WHERE folder_id = $2', [now(), id]);
  await d.execute("DELETE FROM ai_docs WHERE scope = 'folder' AND owner_id = $1", [id]);
  await d.execute("DELETE FROM chat_messages WHERE scope = 'folder' AND owner_id = $1", [id]);
  await d.execute("DELETE FROM chat_conversations WHERE scope = 'folder' AND owner_id = $1", [id]);
  await d.execute('DELETE FROM action_items WHERE folder_id = $1', [id]);
  await d.execute(
    'DELETE FROM extraction_rows WHERE template_id IN (SELECT id FROM extraction_templates WHERE folder_id = $1)',
    [id],
  );
  await d.execute('DELETE FROM extraction_templates WHERE folder_id = $1', [id]);
  await d.execute('DELETE FROM folders WHERE id = $1', [id]);
}

// `folderId` null = unassigned ("Unsorted").
export async function setMeetingFolder(meetingId: number, folderId: number | null): Promise<void> {
  await updateMeeting(meetingId, { folderId });
}

// ---------- Transcripts ----------

const SEGMENT_CHUNK = 200;

// Saves a finished transcription and makes it the meeting's active one.
// Segments reference speakers by `speakerLabel` (matching `speakers[].label`).
export async function createTranscript(
  meetingId: number,
  t: {
    provider: ProviderId;
    model: string;
    costUsd: number | null;
    languages: string | null;
    source?: TranscriptSource; // default 'async'
  },
  speakers: { label: string; name: string | null; isSelf: boolean }[],
  segments: { speakerLabel: string | null; startMs: number; endMs: number; text: string }[],
): Promise<number> {
  const d = conn();
  const res = await d.execute(
    `INSERT INTO transcripts (meeting_id, provider, model, source, created_at, cost_usd, languages)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [meetingId, t.provider, t.model, t.source ?? 'async', now(), t.costUsd, t.languages],
  );
  if (res.lastInsertId == null) throw new Error('createTranscript: no id returned');
  const transcriptId = Number(res.lastInsertId);

  try {
    // Speakers (plus any label used by segments but missing from the list).
    const allSpeakers = [...speakers];
    const known = new Set(speakers.map((s) => s.label));
    for (const seg of segments) {
      if (seg.speakerLabel != null && !known.has(seg.speakerLabel)) {
        known.add(seg.speakerLabel);
        allSpeakers.push({ label: seg.speakerLabel, name: null, isSelf: false });
      }
    }
    for (const part of chunk(allSpeakers, SEGMENT_CHUNK)) {
      const params: unknown[] = [];
      const values = part.map((s) => {
        params.push(transcriptId, s.label, s.name, s.isSelf ? 1 : 0);
        const n = params.length;
        return `($${n - 3}, $${n - 2}, $${n - 1}, $${n})`;
      });
      await d.execute(`INSERT INTO speakers (transcript_id, label, name, is_self) VALUES ${values.join(', ')}`, params);
    }
    const speakerRows = await d.select<{ id: number; label: string }[]>(
      'SELECT id, label FROM speakers WHERE transcript_id = $1 ORDER BY id',
      [transcriptId],
    );
    const idByLabel = new Map<string, number>();
    for (const r of speakerRows) if (!idByLabel.has(r.label)) idByLabel.set(r.label, r.id);

    // Segments, in start order, many rows per statement.
    const sorted = [...segments].sort((a, b) => a.startMs - b.startMs);
    for (const part of chunk(sorted, SEGMENT_CHUNK)) {
      const params: unknown[] = [];
      const values = part.map((s) => {
        params.push(
          transcriptId,
          s.speakerLabel != null ? (idByLabel.get(s.speakerLabel) ?? null) : null,
          Math.round(s.startMs),
          Math.round(s.endMs),
          s.text,
        );
        const n = params.length;
        return `($${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}, $${n}, 0)`;
      });
      await d.execute(
        `INSERT INTO segments (transcript_id, speaker_id, start_ms, end_ms, text, edited) VALUES ${values.join(', ')}`,
        params,
      );
    }

    await d.execute('UPDATE meetings SET active_transcript_id = $1, updated_at = $2 WHERE id = $3', [
      transcriptId,
      now(),
      meetingId,
    ]);
  } catch (err) {
    // No cross-statement transactions with the pool: undo by hand.
    try {
      await d.execute('DELETE FROM segments WHERE transcript_id = $1', [transcriptId]);
      await d.execute('DELETE FROM speakers WHERE transcript_id = $1', [transcriptId]);
      await d.execute('DELETE FROM transcripts WHERE id = $1', [transcriptId]);
    } catch {
      /* keep the original error */
    }
    throw err;
  }
  return transcriptId;
}

// Newest first.
export async function listTranscripts(meetingId: number): Promise<Transcript[]> {
  const rows = await conn().select<TranscriptRow[]>(
    'SELECT * FROM transcripts WHERE meeting_id = $1 ORDER BY created_at DESC, id DESC',
    [meetingId],
  );
  return rows.map(toTranscript);
}

export async function setActiveTranscript(meetingId: number, transcriptId: number): Promise<void> {
  await conn().execute(
    `UPDATE meetings SET active_transcript_id = $1, updated_at = $3
     WHERE id = $2 AND EXISTS (SELECT 1 FROM transcripts WHERE id = $1 AND meeting_id = $2)`,
    [transcriptId, meetingId, now()],
  );
}

// If it was active, the newest remaining transcript becomes active (or none).
export async function deleteTranscript(transcriptId: number): Promise<void> {
  const d = conn();
  const rows = await d.select<{ meeting_id: number }[]>('SELECT meeting_id FROM transcripts WHERE id = $1', [
    transcriptId,
  ]);
  await d.execute('DELETE FROM segments WHERE transcript_id = $1', [transcriptId]);
  await d.execute('DELETE FROM speakers WHERE transcript_id = $1', [transcriptId]);
  await d.execute('DELETE FROM transcripts WHERE id = $1', [transcriptId]);
  const meetingId = rows[0]?.meeting_id;
  if (meetingId == null) return;
  await d.execute(
    `UPDATE meetings SET active_transcript_id = (
       SELECT id FROM transcripts WHERE meeting_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1
     ) WHERE id = $1 AND (active_transcript_id = $2 OR active_transcript_id IS NULL)`,
    [meetingId, transcriptId],
  );
  await touch('meeting', meetingId);
}

export async function getTranscriptDetail(transcriptId: number): Promise<TranscriptDetail | null> {
  const d = conn();
  const rows = await d.select<TranscriptRow[]>('SELECT * FROM transcripts WHERE id = $1', [transcriptId]);
  if (!rows[0]) return null;
  const [speakers, segments] = await Promise.all([
    d.select<SpeakerRow[]>('SELECT * FROM speakers WHERE transcript_id = $1 ORDER BY id', [transcriptId]),
    d.select<SegmentRow[]>('SELECT * FROM segments WHERE transcript_id = $1 ORDER BY start_ms, id', [transcriptId]),
  ]);
  return {
    transcript: toTranscript(rows[0]),
    speakers: speakers.map(toSpeaker),
    segments: segments.map(toSegment),
  };
}

// ---------- Segments ----------

// Text edits set `edited = true` and keep the search index in sync (triggers).
export async function updateSegment(id: number, patch: { text?: string; speakerId?: number | null }): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.text !== undefined) {
    params.push(patch.text);
    sets.push(`text = $${params.length}`, 'edited = 1');
  }
  if (patch.speakerId !== undefined) {
    params.push(patch.speakerId);
    sets.push(`speaker_id = $${params.length}`);
  }
  if (!sets.length) return;
  params.push(id);
  await conn().execute(`UPDATE segments SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
  await touch('segment', id);
}

export async function deleteSegment(id: number): Promise<void> {
  const d = conn();
  // Look up the owner first: once deleted, the segment can't be resolved.
  const rows = await d.select<{ transcript_id: number }[]>('SELECT transcript_id FROM segments WHERE id = $1', [id]);
  await d.execute('DELETE FROM segments WHERE id = $1', [id]);
  if (rows[0]) await touch('transcript', rows[0].transcript_id);
}

// Appends the next segment's text to this one, extends its end time, deletes
// the next one. No-op if it's the last segment.
export async function mergeWithNext(segmentId: number): Promise<void> {
  const d = conn();
  const cur = (await d.select<SegmentRow[]>('SELECT * FROM segments WHERE id = $1', [segmentId]))[0];
  if (!cur) return;
  const next = (
    await d.select<SegmentRow[]>(
      `SELECT * FROM segments
       WHERE transcript_id = $1 AND (start_ms > $2 OR (start_ms = $2 AND id > $3))
       ORDER BY start_ms, id LIMIT 1`,
      [cur.transcript_id, cur.start_ms, cur.id],
    )
  )[0];
  if (!next) return;
  const text = [cur.text.trim(), next.text.trim()].filter(Boolean).join(' ');
  await d.execute('UPDATE segments SET text = $1, end_ms = $2, edited = 1 WHERE id = $3', [
    text,
    Math.max(cur.end_ms, next.end_ms),
    cur.id,
  ]);
  await d.execute('DELETE FROM segments WHERE id = $1', [next.id]);
  await touch('transcript', cur.transcript_id);
}

// ---------- Speakers ----------

export async function renameSpeaker(speakerId: number, name: string | null): Promise<void> {
  const clean = name?.trim() || null;
  await conn().execute('UPDATE speakers SET name = $1 WHERE id = $2', [clean, speakerId]);
  await touch('speaker', speakerId);
}

export async function addSpeaker(transcriptId: number, name: string): Promise<Speaker> {
  const d = conn();
  const existing = await d.select<{ label: string }[]>('SELECT label FROM speakers WHERE transcript_id = $1', [
    transcriptId,
  ]);
  const labels = new Set(existing.map((r) => r.label));
  let n = existing.length + 1;
  while (labels.has(`Speaker ${n}`)) n++;
  const label = `Speaker ${n}`;
  const clean = name.trim() || null;
  const res = await d.execute('INSERT INTO speakers (transcript_id, label, name, is_self) VALUES ($1, $2, $3, 0)', [
    transcriptId,
    label,
    clean,
  ]);
  if (res.lastInsertId == null) throw new Error('addSpeaker: no id returned');
  await touch('transcript', transcriptId);
  return { id: Number(res.lastInsertId), transcriptId, label, name: clean, isSelf: false };
}

// Distinct names the user has given speakers before, for autocomplete.
export async function listKnownNames(): Promise<string[]> {
  const rows = await conn().select<{ name: string }[]>(
    `SELECT TRIM(name) AS name, MAX(id) AS last_id FROM speakers
     WHERE name IS NOT NULL AND TRIM(name) <> ''
     GROUP BY TRIM(name) ORDER BY last_id DESC`,
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    const key = r.name.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r.name);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

// ---------- Search ----------

interface SearchRow {
  meeting_id: number;
  meeting_title: string;
  meeting_created_at: string;
  transcript_id: number;
  segment_id: number;
  start_ms: number;
  end_ms: number;
  text: string;
  speaker_name: string | null;
}

// Full-text search over the active transcript of every meeting. Handles
// Bulgarian word endings, "quoted phrases" and short terms (see search.ts).
export async function search(query: string, limit = 200): Promise<SearchHit[]> {
  const built = buildSearchSql(query, limit);
  if (!built) return [];
  const rows = await conn().select<SearchRow[]>(built.sql, built.params);
  return rows.map((r) => ({
    meetingId: r.meeting_id,
    meetingTitle: r.meeting_title,
    meetingCreatedAt: r.meeting_created_at,
    transcriptId: r.transcript_id,
    segmentId: r.segment_id,
    startMs: r.start_ms,
    endMs: r.end_ms,
    speakerName: r.speaker_name,
    text: r.text,
  }));
}

// ---------- AI docs & chat ----------

interface AiDocRow {
  id: number;
  scope: AiScope;
  owner_id: number;
  kind: AiDocKind;
  content: string;
  model: string | null;
  created_at: string;
  cost_usd: number | null;
}

interface ChatMessageRow {
  id: number;
  scope: AiScope;
  owner_id: number;
  role: 'user' | 'assistant';
  content: string;
  conversation_id: number | null;
  proposal: string | null;
  created_at: string;
}

const toAiDoc = (r: AiDocRow): AiDoc => ({
  id: r.id,
  scope: r.scope,
  ownerId: r.owner_id,
  kind: r.kind,
  content: r.content,
  model: r.model,
  createdAt: r.created_at,
  costUsd: r.cost_usd,
});

const toChatMessage = (r: ChatMessageRow): ChatMessage => ({
  id: r.id,
  scope: r.scope,
  ownerId: r.owner_id,
  role: r.role,
  content: r.content,
  createdAt: r.created_at,
  conversationId: r.conversation_id,
  proposal: parseProposal(r.proposal),
});

function parseProposal(raw: string | null): TaskProposal | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TaskProposal;
  } catch {
    return null;
  }
}

// Only meeting-scoped data counts as meeting content for backup.
async function touchOwner(scope: AiScope, ownerId: number): Promise<void> {
  if (scope === 'meeting') await touch('meeting', ownerId);
  else await touchFolder(ownerId);
}

// Summaries keep their history until the user deletes them; other kinds hold
// one doc per (scope, owner, kind), so a new one replaces the old.
const KEEPS_HISTORY: AiDocKind[] = ['summary', 'folder_summary'];

export async function saveAiDoc(doc: {
  scope: AiScope;
  ownerId: number;
  kind: AiDocKind;
  content: string;
  model: string | null;
  costUsd: number | null;
}): Promise<AiDoc> {
  const d = conn();
  const createdAt = now();
  const res = await d.execute(
    `INSERT INTO ai_docs (scope, owner_id, kind, content, model, created_at, cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [doc.scope, doc.ownerId, doc.kind, doc.content, doc.model, createdAt, doc.costUsd],
  );
  if (res.lastInsertId == null) throw new Error('saveAiDoc: no id returned');
  const id = Number(res.lastInsertId);
  if (!KEEPS_HISTORY.includes(doc.kind)) {
    await d.execute('DELETE FROM ai_docs WHERE scope = $1 AND owner_id = $2 AND kind = $3 AND id <> $4', [
      doc.scope,
      doc.ownerId,
      doc.kind,
      id,
    ]);
  }
  await touchOwner(doc.scope, doc.ownerId);
  return { id, ...doc, createdAt };
}

// Newest first.
export async function listAiDocs(scope: AiScope, ownerId: number, kind: AiDocKind): Promise<AiDoc[]> {
  const rows = await conn().select<AiDocRow[]>(
    'SELECT * FROM ai_docs WHERE scope = $1 AND owner_id = $2 AND kind = $3 ORDER BY id DESC',
    [scope, ownerId, kind],
  );
  return rows.map(toAiDoc);
}

export async function deleteAiDocVersion(doc: Pick<AiDoc, 'id' | 'scope' | 'ownerId'>): Promise<void> {
  await conn().execute('DELETE FROM ai_docs WHERE id = $1', [doc.id]);
  await touchOwner(doc.scope, doc.ownerId);
}

// The newest one, for kinds with a history.
export async function getAiDoc(scope: AiScope, ownerId: number, kind: AiDocKind): Promise<AiDoc | null> {
  const rows = await conn().select<AiDocRow[]>(
    'SELECT * FROM ai_docs WHERE scope = $1 AND owner_id = $2 AND kind = $3 ORDER BY id DESC LIMIT 1',
    [scope, ownerId, kind],
  );
  return rows[0] ? toAiDoc(rows[0]) : null;
}

export async function deleteAiDoc(scope: AiScope, ownerId: number, kind: AiDocKind): Promise<void> {
  await conn().execute('DELETE FROM ai_docs WHERE scope = $1 AND owner_id = $2 AND kind = $3', [scope, ownerId, kind]);
  await touchOwner(scope, ownerId);
}

// Newest activity first.
export async function listConversations(scope: AiScope, ownerId: number): Promise<ChatConversation[]> {
  const rows = await conn().select<{ id: number; scope: AiScope; owner_id: number; title: string; created_at: string; updated_at: string }[]>(
    'SELECT * FROM chat_conversations WHERE scope = $1 AND owner_id = $2 ORDER BY updated_at DESC, id DESC',
    [scope, ownerId],
  );
  return rows.map((r) => ({ id: r.id, scope: r.scope, ownerId: r.owner_id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at }));
}

// Titled from the first question, so naming a chat costs nothing.
export async function createConversation(scope: AiScope, ownerId: number, question: string, createdAt = now()): Promise<number> {
  const res = await conn().execute(
    'INSERT INTO chat_conversations (scope, owner_id, title, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)',
    [scope, ownerId, conversationTitle(question), createdAt],
  );
  if (res.lastInsertId == null) throw new Error('createConversation: no id returned');
  return Number(res.lastInsertId);
}

export async function deleteConversation(conversation: Pick<ChatConversation, 'id' | 'scope' | 'ownerId'>): Promise<void> {
  const d = conn();
  await d.execute('DELETE FROM chat_messages WHERE conversation_id = $1', [conversation.id]);
  await d.execute('DELETE FROM chat_conversations WHERE id = $1', [conversation.id]);
  await touchOwner(conversation.scope, conversation.ownerId);
}

// Oldest first. Without a conversation: every chat of this meeting or folder.
export async function listChatMessages(scope: AiScope, ownerId: number, conversationId?: number): Promise<ChatMessage[]> {
  const rows = await conn().select<ChatMessageRow[]>(
    conversationId == null
      ? 'SELECT * FROM chat_messages WHERE scope = $1 AND owner_id = $2 ORDER BY id'
      : 'SELECT * FROM chat_messages WHERE scope = $1 AND owner_id = $2 AND conversation_id = $3 ORDER BY id',
    conversationId == null ? [scope, ownerId] : [scope, ownerId, conversationId],
  );
  return rows.map(toChatMessage);
}

export async function addChatMessage(
  scope: AiScope,
  ownerId: number,
  conversationId: number,
  role: ChatMessage['role'],
  content: string,
  proposal: TaskProposal | null = null,
): Promise<ChatMessage> {
  const createdAt = now();
  const res = await conn().execute(
    'INSERT INTO chat_messages (scope, owner_id, conversation_id, role, content, proposal, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [scope, ownerId, conversationId, role, content, proposal ? JSON.stringify(proposal) : null, createdAt],
  );
  if (res.lastInsertId == null) throw new Error('addChatMessage: no id returned');
  await conn().execute('UPDATE chat_conversations SET updated_at = $1 WHERE id = $2', [createdAt, conversationId]);
  await touchOwner(scope, ownerId);
  return { id: Number(res.lastInsertId), scope, ownerId, conversationId, role, content, proposal, createdAt };
}

export async function setMessageProposal(id: number, proposal: TaskProposal): Promise<void> {
  await conn().execute('UPDATE chat_messages SET proposal = $1 WHERE id = $2', [JSON.stringify(proposal), id]);
}

export type { Segment };

// ---------- Meeting/folder lookups ----------

export async function getMeetingByUid(uid: string): Promise<Meeting | null> {
  const rows = await conn().select<MeetingRow[]>('SELECT * FROM meetings WHERE uid = $1', [uid]);
  return rows[0] ? toMeeting(rows[0]) : null;
}

export async function getFolderByUid(uid: string): Promise<Folder | null> {
  const rows = await conn().select<FolderRow[]>('SELECT * FROM folders WHERE uid = $1', [uid]);
  return rows[0] ? toFolder(rows[0]) : null;
}

// Oldest first, which is the order folder AI reads them in.
export async function listFolderMeetings(folderId: number): Promise<Meeting[]> {
  const rows = await conn().select<MeetingRow[]>(
    'SELECT * FROM meetings WHERE folder_id = $1 ORDER BY created_at, id',
    [folderId],
  );
  return rows.map(toMeeting);
}

// A folder with a known uid (bundle import), unlike createFolder.
export async function insertFolder(f: Omit<Folder, 'id'>): Promise<Folder> {
  const res = await conn().execute(
    'INSERT INTO folders (uid, name, dir_name, created_at, briefing, terms) VALUES ($1, $2, $3, $4, $5, $6)',
    [f.uid, f.name, f.dirName, f.createdAt, f.briefing, joinTerms(f.terms)],
  );
  if (res.lastInsertId == null) throw new Error('insertFolder: no id returned');
  return { id: Number(res.lastInsertId), ...f };
}

export async function setFolderBriefing(id: number, briefing: string | null): Promise<void> {
  await conn().execute('UPDATE folders SET briefing = $1 WHERE id = $2', [briefing, id]);
  await touchFolder(id);
}

export async function setFolderTerms(id: number, terms: string[]): Promise<void> {
  await conn().execute('UPDATE folders SET terms = $1 WHERE id = $2', [joinTerms(terms), id]);
  await touchFolder(id);
}

// Where a meeting's files are. Not a content change, so updated_at stays
// (moving a folder on disk shouldn't make backup re-upload every meeting).
export async function setMeetingLocation(
  id: number,
  loc: { dirPath: string | null; mediaPath: string | null; sourcePath: string | null },
): Promise<void> {
  await conn().execute('UPDATE meetings SET dir_path = $1, media_path = $2, source_path = $3 WHERE id = $4', [
    loc.dirPath,
    loc.mediaPath,
    loc.sourcePath,
    id,
  ]);
}

// For the sidecar writer: meetings with a directory changed after `since`.
export async function listMeetingsChangedSince(since: string): Promise<{ id: number; updatedAt: string }[]> {
  const rows = await conn().select<{ id: number; updated_at: string }[]>(
    'SELECT id, updated_at FROM meetings WHERE dir_path IS NOT NULL AND updated_at > $1',
    [since],
  );
  return rows.map((r) => ({ id: r.id, updatedAt: r.updated_at }));
}

// Search limited to one folder's meetings.
export async function searchFolder(folderId: number, query: string, limit = 30): Promise<SearchHit[]> {
  const built = buildSearchSql(query, limit, { folderId });
  if (!built) return [];
  const rows = await conn().select<SearchRow[]>(built.sql, built.params);
  return rows.map((r) => ({
    meetingId: r.meeting_id,
    meetingTitle: r.meeting_title,
    meetingCreatedAt: r.meeting_created_at,
    transcriptId: r.transcript_id,
    segmentId: r.segment_id,
    startMs: r.start_ms,
    endMs: r.end_ms,
    speakerName: r.speaker_name,
    text: r.text,
  }));
}

export interface SegmentRef {
  segmentId: number;
  meetingId: number;
  meetingTitle: string;
  startMs: number;
  speaker: string;
  text: string;
}

// Resolves segment ids from any meeting (folder-level citations).
export async function getSegmentRefs(ids: number[]): Promise<SegmentRef[]> {
  const unique = [...new Set(ids)].filter((n) => Number.isInteger(n));
  const out: SegmentRef[] = [];
  for (const part of chunk(unique, 200)) {
    const ph = part.map((_, i) => `$${i + 1}`).join(', ');
    const rows = await conn().select<
      { segment_id: number; meeting_id: number; meeting_title: string; start_ms: number; speaker: string | null; text: string }[]
    >(
      `SELECT s.id AS segment_id, t.meeting_id, m.title AS meeting_title, s.start_ms, s.text,
              COALESCE(NULLIF(TRIM(sp.name), ''), sp.label) AS speaker
       FROM segments s
       JOIN transcripts t ON t.id = s.transcript_id
       JOIN meetings m ON m.id = t.meeting_id
       LEFT JOIN speakers sp ON sp.id = s.speaker_id
       WHERE s.id IN (${ph})`,
      part,
    );
    for (const r of rows) {
      out.push({
        segmentId: r.segment_id,
        meetingId: r.meeting_id,
        meetingTitle: r.meeting_title,
        startMs: r.start_ms,
        speaker: r.speaker ?? 'Unknown',
        text: r.text,
      });
    }
  }
  return out;
}

// ---------- Action items ----------

interface ActionItemRow {
  id: number;
  folder_id: number | null;
  meeting_id: number | null;
  text: string;
  owner: string | null;
  status: ActionItemStatus;
  first_seen_meeting: number | null;
  last_update_meeting: number | null;
  source_ms: number | null;
  parent_id: number | null;
  created_at: string;
  updated_at: string;
}

const toActionItem = (r: ActionItemRow): ActionItem => ({
  id: r.id,
  folderId: r.folder_id,
  meetingId: r.meeting_id,
  text: r.text,
  owner: r.owner,
  status: r.status,
  firstSeenMeeting: r.first_seen_meeting,
  lastUpdateMeeting: r.last_update_meeting,
  sourceMs: r.source_ms,
  parentId: r.parent_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

// Items are part of their meeting's bundle, so changes count as meeting content.
async function touchItemMeeting(meetingId: number | null): Promise<void> {
  if (meetingId != null) await touch('meeting', meetingId);
}

// Open first, then by when they came up.
export async function listActionItems(folderId: number): Promise<ActionItem[]> {
  const rows = await conn().select<ActionItemRow[]>(
    `SELECT * FROM action_items WHERE folder_id = $1
     ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'done' THEN 1 ELSE 2 END, created_at, id`,
    [folderId],
  );
  return rows.map(toActionItem);
}

export async function listMeetingActionItems(meetingId: number): Promise<ActionItem[]> {
  const rows = await conn().select<ActionItemRow[]>('SELECT * FROM action_items WHERE meeting_id = $1 ORDER BY id', [
    meetingId,
  ]);
  return rows.map(toActionItem);
}

export async function addActionItem(item: Omit<ActionItem, 'id' | 'createdAt' | 'updatedAt'> & Partial<Pick<ActionItem, 'createdAt' | 'updatedAt'>>): Promise<ActionItem> {
  const createdAt = item.createdAt ?? now();
  const updatedAt = item.updatedAt ?? createdAt;
  const res = await conn().execute(
    `INSERT INTO action_items (folder_id, meeting_id, text, owner, status, first_seen_meeting, last_update_meeting,
       source_ms, parent_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      item.folderId,
      item.meetingId,
      item.text,
      item.owner,
      item.status,
      item.firstSeenMeeting,
      item.lastUpdateMeeting,
      item.sourceMs,
      item.parentId ?? null,
      createdAt,
      updatedAt,
    ],
  );
  if (res.lastInsertId == null) throw new Error('addActionItem: no id returned');
  await touchItemMeeting(item.meetingId);
  if (item.meetingId == null) await touchFolder(item.folderId);
  return { ...item, id: Number(res.lastInsertId), createdAt, updatedAt };
}

const ACTION_ITEM_COLUMNS: Record<string, string> = {
  text: 'text',
  owner: 'owner',
  status: 'status',
  firstSeenMeeting: 'first_seen_meeting',
  lastUpdateMeeting: 'last_update_meeting',
  sourceMs: 'source_ms',
  meetingId: 'meeting_id',
  parentId: 'parent_id',
};

export async function updateActionItem(
  id: number,
  patch: Partial<Pick<ActionItem, 'text' | 'owner' | 'status' | 'firstSeenMeeting' | 'lastUpdateMeeting' | 'sourceMs' | 'meetingId' | 'parentId'>>,
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const col = ACTION_ITEM_COLUMNS[key];
    if (!col || value === undefined) continue;
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  }
  if (!sets.length) return;
  params.push(now());
  sets.push(`updated_at = $${params.length}`);
  params.push(id);
  await conn().execute(`UPDATE action_items SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
  const rows = await conn().select<{ meeting_id: number | null; folder_id: number | null }[]>(
    'SELECT meeting_id, folder_id FROM action_items WHERE id = $1',
    [id],
  );
  await touchItemMeeting(rows[0]?.meeting_id ?? null);
  await touchFolder(rows[0]?.folder_id ?? null);
}

export async function deleteActionItem(id: number): Promise<void> {
  const rows = await conn().select<{ meeting_id: number | null; folder_id: number | null }[]>(
    'SELECT meeting_id, folder_id FROM action_items WHERE id = $1',
    [id],
  );
  // Its subtasks stay, as ordinary tasks.
  await conn().execute('UPDATE action_items SET parent_id = NULL WHERE parent_id = $1', [id]);
  await conn().execute('DELETE FROM action_items WHERE id = $1', [id]);
  await touchItemMeeting(rows[0]?.meeting_id ?? null);
  await touchFolder(rows[0]?.folder_id ?? null);
}

// Moving a meeting to another folder takes the items it started along.
export async function moveMeetingActionItems(meetingId: number, folderId: number | null): Promise<void> {
  await conn().execute('UPDATE action_items SET folder_id = $1 WHERE meeting_id = $2', [folderId, meetingId]);
}

// ---------- Extraction ----------

interface TemplateRow {
  id: number;
  folder_id: number;
  name: string;
  fields_json: string;
  created_at: string;
}

interface ExtractionRowRow {
  id: number;
  template_id: number;
  meeting_id: number;
  values_json: string;
  created_at: string;
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

const toTemplate = (r: TemplateRow): ExtractionTemplate => ({
  id: r.id,
  folderId: r.folder_id,
  name: r.name,
  fields: parseJson<ExtractionField[]>(r.fields_json, []),
  createdAt: r.created_at,
});

const toExtractionRow = (r: ExtractionRowRow): ExtractionRow => ({
  id: r.id,
  templateId: r.template_id,
  meetingId: r.meeting_id,
  values: parseJson<Record<string, string | null>>(r.values_json, {}),
  createdAt: r.created_at,
});

export async function listExtractionTemplates(folderId: number): Promise<ExtractionTemplate[]> {
  const rows = await conn().select<TemplateRow[]>('SELECT * FROM extraction_templates WHERE folder_id = $1 ORDER BY id', [
    folderId,
  ]);
  return rows.map(toTemplate);
}

export async function getExtractionTemplate(id: number): Promise<ExtractionTemplate | null> {
  const rows = await conn().select<TemplateRow[]>('SELECT * FROM extraction_templates WHERE id = $1', [id]);
  return rows[0] ? toTemplate(rows[0]) : null;
}

export async function createExtractionTemplate(
  folderId: number,
  name: string,
  fields: ExtractionField[],
): Promise<ExtractionTemplate> {
  const createdAt = now();
  const res = await conn().execute(
    'INSERT INTO extraction_templates (folder_id, name, fields_json, created_at) VALUES ($1, $2, $3, $4)',
    [folderId, name, JSON.stringify(fields), createdAt],
  );
  if (res.lastInsertId == null) throw new Error('createExtractionTemplate: no id returned');
  await touchFolder(folderId);
  return { id: Number(res.lastInsertId), folderId, name, fields, createdAt };
}

export async function updateExtractionTemplate(id: number, name: string, fields: ExtractionField[]): Promise<void> {
  await conn().execute('UPDATE extraction_templates SET name = $1, fields_json = $2 WHERE id = $3', [
    name,
    JSON.stringify(fields),
    id,
  ]);
  await touchTemplateFolder(id);
}

export async function deleteExtractionTemplate(id: number): Promise<void> {
  await touchTemplateFolder(id);
  await conn().execute('DELETE FROM extraction_rows WHERE template_id = $1', [id]);
  await conn().execute('DELETE FROM extraction_templates WHERE id = $1', [id]);
}

export async function listExtractionRows(templateId: number): Promise<ExtractionRow[]> {
  const rows = await conn().select<ExtractionRowRow[]>('SELECT * FROM extraction_rows WHERE template_id = $1 ORDER BY id', [
    templateId,
  ]);
  return rows.map(toExtractionRow);
}

// With the template, so a bundle can recreate it elsewhere.
export async function listMeetingExtractionRows(
  meetingId: number,
): Promise<(ExtractionRow & { template: ExtractionTemplate | null })[]> {
  const rows = await conn().select<ExtractionRowRow[]>('SELECT * FROM extraction_rows WHERE meeting_id = $1 ORDER BY id', [
    meetingId,
  ]);
  const out = [];
  for (const r of rows) out.push({ ...toExtractionRow(r), template: await getExtractionTemplate(r.template_id) });
  return out;
}

// One row per (template, meeting): a re-run replaces the old values.
export async function saveExtractionRow(
  templateId: number,
  meetingId: number,
  values: Record<string, string | null>,
  createdAt: string = now(),
): Promise<void> {
  await conn().execute('DELETE FROM extraction_rows WHERE template_id = $1 AND meeting_id = $2', [templateId, meetingId]);
  await conn().execute(
    'INSERT INTO extraction_rows (template_id, meeting_id, values_json, created_at) VALUES ($1, $2, $3, $4)',
    [templateId, meetingId, JSON.stringify(values), createdAt],
  );
  await touch('meeting', meetingId);
}

// ---------- Bundle import ----------

// Inserts a meeting exactly as described (uid and timestamps kept).
export async function insertImportedMeeting(m: Omit<Meeting, 'id' | 'activeTranscriptId'>): Promise<number> {
  const res = await conn().execute(
    `INSERT INTO meetings (uid, title, created_at, updated_at, duration_ms, source_path, media_path, status, error,
       folder_id, dir_path, briefing, split_tracks, terms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      m.uid,
      m.title,
      m.createdAt,
      m.updatedAt,
      m.durationMs,
      m.sourcePath,
      m.mediaPath,
      m.status,
      m.error,
      m.folderId,
      m.dirPath,
      m.briefing,
      m.splitTracks == null ? null : Number(m.splitTracks),
      joinTerms(m.terms),
    ],
  );
  if (res.lastInsertId == null) throw new Error('insertImportedMeeting: no id returned');
  return Number(res.lastInsertId);
}

// Overwrites a meeting row with imported values, keeping its local id.
export async function replaceImportedMeeting(id: number, m: Omit<Meeting, 'id' | 'activeTranscriptId' | 'uid'>): Promise<void> {
  await conn().execute(
    `UPDATE meetings SET title = $1, created_at = $2, updated_at = $3, duration_ms = $4, source_path = $5,
       media_path = $6, status = $7, error = $8, folder_id = $9, dir_path = $10, briefing = $11,
       split_tracks = $12, terms = $13
     WHERE id = $14`,
    [
      m.title,
      m.createdAt,
      m.updatedAt,
      m.durationMs,
      m.sourcePath,
      m.mediaPath,
      m.status,
      m.error,
      m.folderId,
      m.dirPath,
      m.briefing,
      m.splitTracks == null ? null : Number(m.splitTracks),
      joinTerms(m.terms),
      id,
    ],
  );
}

// Everything deleteMeeting removes except the meeting row itself.
export async function deleteMeetingContent(id: number): Promise<void> {
  const d = conn();
  const sub = 'SELECT id FROM transcripts WHERE meeting_id = $1';
  await d.execute(`DELETE FROM segments WHERE transcript_id IN (${sub})`, [id]);
  await d.execute(`DELETE FROM speakers WHERE transcript_id IN (${sub})`, [id]);
  await d.execute('DELETE FROM transcripts WHERE meeting_id = $1', [id]);
  await d.execute('UPDATE meetings SET active_transcript_id = NULL WHERE id = $1', [id]);
  await d.execute("DELETE FROM ai_docs WHERE scope = 'meeting' AND owner_id = $1", [id]);
  await d.execute("DELETE FROM chat_messages WHERE scope = 'meeting' AND owner_id = $1", [id]);
  await d.execute("DELETE FROM chat_conversations WHERE scope = 'meeting' AND owner_id = $1", [id]);
  await d.execute('DELETE FROM action_items WHERE meeting_id = $1', [id]);
  await d.execute('DELETE FROM extraction_rows WHERE meeting_id = $1', [id]);
}

// Inserts a transcript with its own speaker/segment ids and returns old → new
// id maps, so the caller can fix references (active transcript, citations).
export async function insertImportedTranscript(
  meetingId: number,
  t: Omit<Transcript, 'id' | 'meetingId'>,
  speakers: Omit<Speaker, 'transcriptId'>[],
  segments: Omit<Segment, 'transcriptId'>[],
): Promise<{ transcriptId: number; speakerIds: Map<number, number>; segmentIds: Map<number, number> }> {
  const d = conn();
  const res = await d.execute(
    `INSERT INTO transcripts (meeting_id, provider, model, source, created_at, cost_usd, languages)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [meetingId, t.provider, t.model, t.source, t.createdAt, t.costUsd, t.languages],
  );
  if (res.lastInsertId == null) throw new Error('insertImportedTranscript: no id returned');
  const transcriptId = Number(res.lastInsertId);
  const speakerIds = new Map<number, number>();
  const segmentIds = new Map<number, number>();
  try {
    // One row at a time for speakers (few), so each new id is known exactly.
    for (const s of speakers) {
      const r = await d.execute('INSERT INTO speakers (transcript_id, label, name, is_self) VALUES ($1, $2, $3, $4)', [
        transcriptId,
        s.label,
        s.name,
        s.isSelf ? 1 : 0,
      ]);
      if (r.lastInsertId == null) throw new Error('insertImportedTranscript: no speaker id returned');
      speakerIds.set(s.id, Number(r.lastInsertId));
    }
    // Segments in batches; new ids are read back in insertion (= id) order
    // and paired with the inputs, rather than assumed consecutive.
    for (const part of chunk(segments, SEGMENT_CHUNK)) {
      const params: unknown[] = [];
      const values = part.map((s) => {
        params.push(
          transcriptId,
          s.speakerId != null ? (speakerIds.get(s.speakerId) ?? null) : null,
          Math.round(s.startMs),
          Math.round(s.endMs),
          s.text,
          s.edited ? 1 : 0,
        );
        const n = params.length;
        return `($${n - 5}, $${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}, $${n})`;
      });
      await d.execute(
        `INSERT INTO segments (transcript_id, speaker_id, start_ms, end_ms, text, edited) VALUES ${values.join(', ')}`,
        params,
      );
    }
    const ids = await d.select<{ id: number }[]>('SELECT id FROM segments WHERE transcript_id = $1 ORDER BY id', [
      transcriptId,
    ]);
    if (ids.length !== segments.length) throw new Error('insertImportedTranscript: segment count mismatch');
    segments.forEach((s, i) => segmentIds.set(s.id, ids[i].id));
  } catch (err) {
    try {
      await d.execute('DELETE FROM segments WHERE transcript_id = $1', [transcriptId]);
      await d.execute('DELETE FROM speakers WHERE transcript_id = $1', [transcriptId]);
      await d.execute('DELETE FROM transcripts WHERE id = $1', [transcriptId]);
    } catch {
      /* keep the original error */
    }
    throw err;
  }
  return { transcriptId, speakerIds, segmentIds };
}

// Final step of an import: active transcript and the bundle's updated_at
// (not "now", or the import itself would look like a newer edit).
export async function finishImportedMeeting(id: number, activeTranscriptId: number | null, updatedAt: string): Promise<void> {
  await conn().execute('UPDATE meetings SET active_transcript_id = $1, updated_at = $2 WHERE id = $3', [
    activeTranscriptId,
    updatedAt,
    id,
  ]);
}

export async function insertImportedAiDoc(doc: Omit<AiDoc, 'id'>): Promise<void> {
  await conn().execute(
    `INSERT INTO ai_docs (scope, owner_id, kind, content, model, created_at, cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [doc.scope, doc.ownerId, doc.kind, doc.content, doc.model, doc.createdAt, doc.costUsd],
  );
}

// Chats for a bundle. Proposals stay out: they point at this database's task
// ids, and applied ones are already in the tasks.
export async function exportChat(scope: AiScope, ownerId: number) {
  const titles = new Map((await listConversations(scope, ownerId)).map((c) => [c.id, c.title]));
  return (await listChatMessages(scope, ownerId)).map((m) => ({
    role: m.role,
    content: m.content,
    createdAt: m.createdAt,
    conversation: (m.conversationId != null && titles.get(m.conversationId)) || undefined,
  }));
}

export async function importChat(
  scope: AiScope,
  ownerId: number,
  messages: { role: ChatMessage['role']; content: string; createdAt: string; conversation?: string }[],
): Promise<void> {
  const ids = new Map<string, number>();
  for (const m of messages) {
    const key = m.conversation ?? '';
    let conversationId = ids.get(key);
    if (conversationId == null) {
      conversationId = await createConversation(scope, ownerId, m.conversation ?? m.content, m.createdAt);
      ids.set(key, conversationId);
    }
    await insertImportedChatMessage({ scope, ownerId, ...m, conversationId });
  }
}

export async function insertImportedChatMessage(m: Omit<ChatMessage, 'id'>): Promise<void> {
  await conn().execute(
    'INSERT INTO chat_messages (scope, owner_id, conversation_id, role, content, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [m.scope, m.ownerId, m.conversationId ?? null, m.role, m.content, m.createdAt],
  );
}

// All meeting-scoped AI docs (summary, notes, …) for the bundle.
export async function listMeetingAiDocs(meetingId: number): Promise<AiDoc[]> {
  const rows = await conn().select<AiDocRow[]>("SELECT * FROM ai_docs WHERE scope = 'meeting' AND owner_id = $1 ORDER BY id", [
    meetingId,
  ]);
  return rows.map(toAiDoc);
}

// ---------- Live transcript ----------
//
// The live transcript is created with createTranscript on its first segments
// and then grows in small batches while the meeting runs, so a crash loses
// only the last few seconds.

export async function hasLiveTranscript(meetingId: number): Promise<boolean> {
  const rows = await conn().select<{ n: number }[]>(
    "SELECT COUNT(*) AS n FROM transcripts WHERE meeting_id = $1 AND source = 'live'",
    [meetingId],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

// Speaker ids by label, creating the speaker if the transcript lacks it.
export async function ensureSpeakers(
  transcriptId: number,
  speakers: { label: string; isSelf: boolean }[],
): Promise<Map<string, number>> {
  const d = conn();
  const load = async () => {
    const rows = await d.select<{ id: number; label: string }[]>(
      'SELECT id, label FROM speakers WHERE transcript_id = $1 ORDER BY id',
      [transcriptId],
    );
    const map = new Map<string, number>();
    for (const r of rows) if (!map.has(r.label)) map.set(r.label, r.id);
    return map;
  };
  let ids = await load();
  const missing = speakers.filter((s, i) => !ids.has(s.label) && speakers.findIndex((x) => x.label === s.label) === i);
  if (missing.length) {
    for (const s of missing) {
      await d.execute('INSERT INTO speakers (transcript_id, label, name, is_self) VALUES ($1, $2, NULL, $3)', [
        transcriptId,
        s.label,
        s.isSelf ? 1 : 0,
      ]);
    }
    ids = await load();
  }
  return ids;
}

export async function appendSegments(
  transcriptId: number,
  segments: { speakerId: number | null; startMs: number; endMs: number; text: string }[],
): Promise<void> {
  if (!segments.length) return;
  const d = conn();
  for (const part of chunk(segments, SEGMENT_CHUNK)) {
    const params: unknown[] = [];
    const values = part.map((s) => {
      params.push(transcriptId, s.speakerId, Math.round(s.startMs), Math.round(s.endMs), s.text);
      const n = params.length;
      return `($${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}, $${n}, 0)`;
    });
    await d.execute(
      `INSERT INTO segments (transcript_id, speaker_id, start_ms, end_ms, text, edited) VALUES ${values.join(', ')}`,
      params,
    );
  }
  await touch('transcript', transcriptId);
}

export async function updateTranscriptStats(
  transcriptId: number,
  stats: { costUsd: number | null; languages: string | null },
): Promise<void> {
  await conn().execute('UPDATE transcripts SET cost_usd = $1, languages = $2 WHERE id = $3', [
    stats.costUsd,
    stats.languages,
    transcriptId,
  ]);
  await touch('transcript', transcriptId);
}

// ---------- Folder change tracking ----------

// Folder-level data (folder summary, chat, templates, unattached action items)
// lives in folder.json; folders.updated_at tells backup and the sidecar writer
// that it changed.
async function touchFolder(folderId: number | null): Promise<void> {
  if (folderId != null) await conn().execute('UPDATE folders SET updated_at = $1 WHERE id = $2', [now(), folderId]);
}

async function touchTemplateFolder(templateId: number): Promise<void> {
  await conn().execute(
    'UPDATE folders SET updated_at = $1 WHERE id = (SELECT folder_id FROM extraction_templates WHERE id = $2)',
    [now(), templateId],
  );
}

// '' for folders created by an import that hasn't brought their folder.json yet.
export async function getFolderUpdatedAt(id: number): Promise<string> {
  const rows = await conn().select<{ updated_at: string | null }[]>('SELECT updated_at FROM folders WHERE id = $1', [id]);
  return rows[0]?.updated_at ?? '';
}

export async function setFolderUpdatedAt(id: number, updatedAt: string): Promise<void> {
  await conn().execute('UPDATE folders SET updated_at = $1 WHERE id = $2', [updatedAt, id]);
}

export async function listFoldersChangedSince(since: string): Promise<{ id: number; updatedAt: string }[]> {
  const rows = await conn().select<{ id: number; updated_at: string }[]>(
    'SELECT id, COALESCE(updated_at, created_at) AS updated_at FROM folders WHERE COALESCE(updated_at, created_at) > $1',
    [since],
  );
  return rows.map((r) => ({ id: r.id, updatedAt: r.updated_at }));
}

export async function listFolderAiDocs(folderId: number): Promise<AiDoc[]> {
  const rows = await conn().select<AiDocRow[]>("SELECT * FROM ai_docs WHERE scope = 'folder' AND owner_id = $1 ORDER BY id", [
    folderId,
  ]);
  return rows.map(toAiDoc);
}

// Action items that no meeting bundle carries.
export async function listUnattachedActionItems(folderId: number): Promise<ActionItem[]> {
  const rows = await conn().select<ActionItemRow[]>(
    'SELECT * FROM action_items WHERE folder_id = $1 AND meeting_id IS NULL ORDER BY id',
    [folderId],
  );
  return rows.map(toActionItem);
}

// Clears what folder.json describes before an import writes it again.
// Templates are kept (their rows belong to meetings); see upsertFolderTemplates.
export async function deleteFolderContent(folderId: number): Promise<void> {
  const d = conn();
  await d.execute("DELETE FROM ai_docs WHERE scope = 'folder' AND owner_id = $1", [folderId]);
  await d.execute("DELETE FROM chat_messages WHERE scope = 'folder' AND owner_id = $1", [folderId]);
  await d.execute("DELETE FROM chat_conversations WHERE scope = 'folder' AND owner_id = $1", [folderId]);
  await d.execute('DELETE FROM action_items WHERE folder_id = $1 AND meeting_id IS NULL', [folderId]);
}

// Templates matched by name: existing ones get the bundle's fields, missing
// ones are created, and ones not in the bundle are dropped when no meeting has
// rows for them.
export async function upsertFolderTemplates(
  folderId: number,
  templates: { name: string; fields: ExtractionField[]; createdAt: string }[],
): Promise<void> {
  const d = conn();
  const existing = await listExtractionTemplates(folderId);
  for (const t of templates) {
    const match = existing.find((e) => e.name === t.name);
    if (match) {
      await d.execute('UPDATE extraction_templates SET fields_json = $1 WHERE id = $2', [JSON.stringify(t.fields), match.id]);
    } else {
      await d.execute('INSERT INTO extraction_templates (folder_id, name, fields_json, created_at) VALUES ($1, $2, $3, $4)', [
        folderId,
        t.name,
        JSON.stringify(t.fields),
        t.createdAt,
      ]);
    }
  }
  const names = new Set(templates.map((t) => t.name));
  for (const e of existing) {
    if (names.has(e.name)) continue;
    const rows = await d.select<{ n: number }[]>('SELECT COUNT(*) AS n FROM extraction_rows WHERE template_id = $1', [e.id]);
    if (!Number(rows[0]?.n)) await d.execute('DELETE FROM extraction_templates WHERE id = $1', [e.id]);
  }
}

// A segment of the meeting with `meetingUid` at `startMs`, preferring the same
// text and the active transcript. Remaps folder-level citations on import.
export async function findSegmentId(meetingUid: string, startMs: number, text: string): Promise<number | null> {
  const rows = await conn().select<{ id: number }[]>(
    `SELECT s.id FROM segments s
     JOIN transcripts t ON t.id = s.transcript_id
     JOIN meetings m ON m.id = t.meeting_id
     WHERE m.uid = $1 AND s.start_ms = $2
     ORDER BY (s.text = $3) DESC, (t.id = m.active_transcript_id) DESC, s.id
     LIMIT 1`,
    [meetingUid, Math.round(startMs), text],
  );
  return rows[0]?.id ?? null;
}

// ---------- Backup state ----------

export interface BackupFile {
  name: string; // file name inside the meeting's remote directory
  role: 'media' | 'source';
  size: number;
  mtime: string | null;
  etag: string | null;
  // An unfinished multipart upload of this file (resumed on the next run).
  uploadId?: string | null;
}

export interface BackupState {
  uid: string;
  kind: 'meeting' | 'folder';
  uploadedAt: string | null;
  updatedAt: string | null; // the meeting/folder updated_at that was uploaded
  files: BackupFile[];
}

interface BackupStateRow {
  uid: string;
  kind: 'meeting' | 'folder';
  uploaded_at: string | null;
  updated_at: string | null;
  files_json: string;
}

const toBackupState = (r: BackupStateRow): BackupState => ({
  uid: r.uid,
  kind: r.kind,
  uploadedAt: r.uploaded_at,
  updatedAt: r.updated_at,
  files: parseJson<BackupFile[]>(r.files_json, []),
});

export async function listBackupState(): Promise<BackupState[]> {
  const rows = await conn().select<BackupStateRow[]>('SELECT * FROM backup_state');
  return rows.map(toBackupState);
}

export async function getBackupState(uid: string): Promise<BackupState | null> {
  const rows = await conn().select<BackupStateRow[]>('SELECT * FROM backup_state WHERE uid = $1', [uid]);
  return rows[0] ? toBackupState(rows[0]) : null;
}

export async function saveBackupState(s: BackupState): Promise<void> {
  await conn().execute(
    `INSERT INTO backup_state (uid, kind, uploaded_at, updated_at, files_json) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT(uid) DO UPDATE SET kind = $2, uploaded_at = $3, updated_at = $4, files_json = $5`,
    [s.uid, s.kind, s.uploadedAt, s.updatedAt, JSON.stringify(s.files)],
  );
}

// Forgets everything uploaded (e.g. after switching to another bucket).
export async function clearBackupState(): Promise<void> {
  await conn().execute('DELETE FROM backup_state');
}
