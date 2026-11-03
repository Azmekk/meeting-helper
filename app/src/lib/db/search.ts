// Full-text search over transcripts. The SQL is built in lib/search.ts.
import type { SearchHit } from '../types';
import { buildSearchSql } from '../search';
import { conn } from './connection';

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
