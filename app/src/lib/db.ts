// OWNER: data agent.
// SQLite through @tauri-apps/plugin-sql (`sqlite:meeting-helper.db`).
//
// plugin-sql caveats this module is written around:
// - It uses a connection pool, so BEGIN/COMMIT can't span several execute()
//   calls; multi-step writes clean up after themselves on failure instead.
// - PRAGMA foreign_keys is per connection, so child rows are deleted
//   explicitly rather than through ON DELETE CASCADE.
import Database from '@tauri-apps/plugin-sql';
import type { Meeting, MeetingStatus, ProviderId, SearchHit, Segment, Speaker, Transcript, TranscriptDetail } from './types';
import { buildSearchSql } from './search';

let db: Database | null = null;

function conn(): Database {
  if (!db) throw new Error('Database not initialised (initDb was not called)');
  return db;
}

// ---------- Schema ----------

// Each entry migrates from version i to i+1. Statements run one at a time and
// are idempotent (IF NOT EXISTS), so a migration interrupted halfway can be
// re-run safely. To add v2, append another array.
const MIGRATIONS: string[][] = [
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
    // FTS (trigram). Created by createFtsTable() below so a failure gets a clear message.
    'FTS',
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
];

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
    for (const stmt of MIGRATIONS[v]) {
      if (stmt === 'FTS') await createFtsTable(d);
      else await d.execute(stmt);
    }
    await d.execute(`PRAGMA user_version = ${v + 1}`);
  }
  db = d;
}

// ---------- Row mapping ----------

interface MeetingRow {
  id: number;
  title: string;
  created_at: string;
  duration_ms: number | null;
  source_path: string | null;
  media_path: string | null;
  status: MeetingStatus;
  error: string | null;
  active_transcript_id: number | null;
}

interface TranscriptRow {
  id: number;
  meeting_id: number;
  provider: ProviderId;
  model: string;
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
  title: r.title,
  createdAt: r.created_at,
  durationMs: r.duration_ms,
  sourcePath: r.source_path,
  mediaPath: r.media_path,
  status: r.status,
  error: r.error,
  activeTranscriptId: r.active_transcript_id,
});

const toTranscript = (r: TranscriptRow): Transcript => ({
  id: r.id,
  meetingId: r.meeting_id,
  provider: r.provider,
  model: r.model,
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

// ---------- Meetings ----------

export async function createMeeting(m: {
  title: string;
  sourcePath: string | null;
  mediaPath: string | null;
  status: MeetingStatus;
  durationMs?: number | null;
}): Promise<number> {
  const res = await conn().execute(
    `INSERT INTO meetings (title, created_at, duration_ms, source_path, media_path, status)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [m.title, now(), m.durationMs ?? null, m.sourcePath, m.mediaPath, m.status],
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
};

export async function updateMeeting(
  id: number,
  patch: Partial<Pick<Meeting, 'title' | 'durationMs' | 'sourcePath' | 'mediaPath' | 'status' | 'error'>>,
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const col = MEETING_COLUMNS[key];
    if (!col || value === undefined) continue;
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  }
  if (!sets.length) return;
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

// Deletes the meeting with all transcripts/speakers/segments. Does not touch
// files on disk.
export async function deleteMeeting(id: number): Promise<void> {
  const d = conn();
  const sub = 'SELECT id FROM transcripts WHERE meeting_id = $1';
  await d.execute(`DELETE FROM segments WHERE transcript_id IN (${sub})`, [id]);
  await d.execute(`DELETE FROM speakers WHERE transcript_id IN (${sub})`, [id]);
  await d.execute('DELETE FROM transcripts WHERE meeting_id = $1', [id]);
  await d.execute('DELETE FROM meetings WHERE id = $1', [id]);
}

// ---------- Transcripts ----------

const SEGMENT_CHUNK = 200;

// Saves a finished transcription and makes it the meeting's active one.
// Segments reference speakers by `speakerLabel` (matching `speakers[].label`).
export async function createTranscript(
  meetingId: number,
  t: { provider: ProviderId; model: string; costUsd: number | null; languages: string | null },
  speakers: { label: string; name: string | null; isSelf: boolean }[],
  segments: { speakerLabel: string | null; startMs: number; endMs: number; text: string }[],
): Promise<number> {
  const d = conn();
  const res = await d.execute(
    `INSERT INTO transcripts (meeting_id, provider, model, created_at, cost_usd, languages)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [meetingId, t.provider, t.model, now(), t.costUsd, t.languages],
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

    await d.execute('UPDATE meetings SET active_transcript_id = $1 WHERE id = $2', [transcriptId, meetingId]);
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
    `UPDATE meetings SET active_transcript_id = $1
     WHERE id = $2 AND EXISTS (SELECT 1 FROM transcripts WHERE id = $1 AND meeting_id = $2)`,
    [transcriptId, meetingId],
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
}

export async function deleteSegment(id: number): Promise<void> {
  await conn().execute('DELETE FROM segments WHERE id = $1', [id]);
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
}

// ---------- Speakers ----------

export async function renameSpeaker(speakerId: number, name: string | null): Promise<void> {
  const clean = name?.trim() || null;
  await conn().execute('UPDATE speakers SET name = $1 WHERE id = $2', [clean, speakerId]);
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

export type { Segment };
