// Custom vocabulary comes in three layers: the default list (Settings →
// Language), the meeting's folder, and the meeting itself. Transcription
// (batch and live) gets all three combined.
import * as db from './db';
import { getSettings } from './settings';
import type { Meeting } from './types';

// One term per line; blank lines and repeats (ignoring case) dropped.
export function parseTerms(text: string): string[] {
  return mergeTerms(text.split(/\r?\n/));
}

export function mergeTerms(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of lists.flat()) {
    const t = raw.trim();
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push(t);
    }
  }
  return out;
}

export async function meetingTerms(meeting: Pick<Meeting, 'folderId' | 'terms'>): Promise<string[]> {
  const folder = meeting.folderId != null ? await db.getFolder(meeting.folderId) : null;
  return mergeTerms(getSettings().terms, folder?.terms ?? [], meeting.terms);
}
