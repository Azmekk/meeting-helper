// Transcripts with their segments and speakers, including the live transcript.
import type { ProviderId, Speaker, Transcript, TranscriptDetail, TranscriptSource } from '../types';
import { conn, touch } from './connection';
import { SEGMENT_CHUNK, chunk, now } from './helpers';
import { toSegment, toSpeaker, toTranscript, type SegmentRow, type SpeakerRow, type TranscriptRow } from './rows';

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

// Their segments move to `reassignTo` (null leaves them with no speaker), so they
// no longer point at the speaker by the time it goes.
export async function deleteSpeaker(speakerId: number, reassignTo: number | null): Promise<void> {
  const d = conn();
  const rows = await d.select<{ transcript_id: number }[]>('SELECT transcript_id FROM speakers WHERE id = $1', [speakerId]);
  await d.execute('UPDATE segments SET speaker_id = $1 WHERE speaker_id = $2', [reassignTo, speakerId]);
  await d.execute('DELETE FROM speakers WHERE id = $1', [speakerId]);
  if (rows[0]) await touch('transcript', rows[0].transcript_id);
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
