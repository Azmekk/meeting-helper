// Meetings.
import type { Meeting, MeetingStatus } from '../types';
import { conn } from './connection';
import { joinTerms, now } from './helpers';
import { toMeeting, type MeetingRow } from './rows';

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

export async function getMeetingByUid(uid: string): Promise<Meeting | null> {
  const rows = await conn().select<MeetingRow[]>('SELECT * FROM meetings WHERE uid = $1', [uid]);
  return rows[0] ? toMeeting(rows[0]) : null;
}

// Oldest first, which is the order folder AI reads them in.
export async function listFolderMeetings(folderId: number): Promise<Meeting[]> {
  const rows = await conn().select<MeetingRow[]>(
    'SELECT * FROM meetings WHERE folder_id = $1 ORDER BY created_at, id',
    [folderId],
  );
  return rows.map(toMeeting);
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
