// What importing a meeting bundle needs on top of the other modules.
import type { Meeting, Segment, Speaker, Transcript } from '../types';
import { conn } from './connection';
import { SEGMENT_CHUNK, chunk, joinTerms } from './helpers';

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
