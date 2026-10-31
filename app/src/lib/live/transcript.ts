// Tokens from live.rs → lines, and saving final lines to the meeting's
// source:'live' transcript.
import * as db from '../db';
import { emitMeetingChanged } from '../pipeline';
import { getSettings } from '../settings';
import { useLive, type LiveLine, type LiveToken, type LiveTrack } from './store';

const set = useLive.setState;
const get = useLive.getState;

export const LIVE_MODEL = 'stt-rt-v5';
// Same grouping as segments.ts, so live and batch transcripts read alike.
const GAP_MS = 1500;
const MAX_LINE_MS = 30_000;

interface OpenLine {
  speaker: string;
  isSelf: boolean;
  startMs: number;
  endMs: number;
  text: string;
}

let lineSeq = 0;
const open: Partial<Record<LiveTrack, OpenLine>> = {};
const speakerNames = new Map<string, string>(); // Soniox id → "Speaker N"
const languageChars = new Map<string, number>();
let pendingSave: LiveLine[] = [];
let transcriptId: number | null = null;
let saving: Promise<void> = Promise.resolve();

export function resetTranscript() {
  lineSeq = 0;
  for (const k of Object.keys(open)) delete open[k as LiveTrack];
  speakerNames.clear();
  languageChars.clear();
  pendingSave = [];
  transcriptId = null;
}

export function selfLabel(): string {
  const name = getSettings().selfName.trim() || 'Me';
  // Labels must stay unique within the transcript.
  return /^Speaker \d+$/.test(name) || name === 'Unknown' ? `${name} (mic)` : name;
}

// ---------- Tokens → lines ----------

function speakerFor(track: LiveTrack, raw: string | null): { speaker: string; isSelf: boolean } {
  if (track === 'mic') return { speaker: selfLabel(), isSelf: true };
  if (!raw) return { speaker: 'Unknown', isSelf: false };
  let name = speakerNames.get(raw);
  if (!name) {
    name = `Speaker ${speakerNames.size + 1}`;
    speakerNames.set(raw, name);
  }
  return { speaker: name, isSelf: false };
}

function flushTrack(track: LiveTrack) {
  const cur = open[track];
  delete open[track];
  const text = cur?.text.replace(/\s+/g, ' ').trim();
  if (!cur || !text) return;
  const line: LiveLine = { id: ++lineSeq, track, ...cur, text };
  pendingSave.push(line);
  set((s) => ({ lines: [...s.lines, line] }));
}

export function onTokens(track: LiveTrack, tokens: LiveToken[]) {
  // Soniox resends all provisional tokens with every message.
  let provisional = '';
  let provisionalSpeaker: string | null = null;
  for (const t of tokens) {
    if (!t.isFinal) {
      if (t.text !== '<end>') provisional += t.text;
      provisionalSpeaker ??= speakerFor(track, t.speaker).speaker;
      continue;
    }
    if (t.text === '<end>') {
      flushTrack(track);
      continue;
    }
    const cur = open[track];
    if (!t.text.trim()) {
      if (cur) cur.text += t.text;
      continue;
    }
    if (t.language) languageChars.set(t.language, (languageChars.get(t.language) ?? 0) + t.text.trim().length);
    const who = speakerFor(track, t.speaker);
    if (
      cur &&
      (who.speaker !== cur.speaker ||
        t.startMs - cur.endMs > GAP_MS ||
        (cur.endMs - cur.startMs > MAX_LINE_MS && /[.?!…]$/.test(cur.text.trim())))
    ) {
      flushTrack(track);
    }
    const now = open[track];
    if (now) {
      now.text += t.text;
      now.endMs = Math.max(now.endMs, t.endMs);
    } else {
      open[track] = { ...who, startMs: t.startMs, endMs: t.endMs, text: t.text.trimStart() };
    }
  }
  const cur = open[track];
  const partials = { ...get().partials };
  if (cur || provisional.trim()) {
    partials[track] = {
      track,
      speaker: cur?.speaker ?? provisionalSpeaker ?? speakerFor(track, null).speaker,
      final: cur?.text.trimStart() ?? '',
      provisional: cur ? provisional : provisional.trimStart(),
    };
  } else {
    delete partials[track];
  }
  set({ partials });
}

// Ends every line still being spoken.
export function flushOpenLines() {
  for (const t of Object.keys(open)) flushTrack(t as LiveTrack);
}

// ---------- Saving ----------

export function persist(): Promise<void> {
  saving = saving.then(saveBatch, saveBatch);
  return saving;
}

async function saveBatch(): Promise<void> {
  const meetingId = get().meetingId;
  if (!pendingSave.length || meetingId == null) return;
  const batch = pendingSave;
  pendingSave = [];
  try {
    const speakers = [...new Map(batch.map((l) => [l.speaker, l.isSelf])).entries()].map(([label, isSelf]) => ({
      label,
      isSelf,
    }));
    if (transcriptId == null) {
      transcriptId = await db.createTranscript(
        meetingId,
        { provider: 'soniox', model: LIVE_MODEL, costUsd: null, languages: null, source: 'live' },
        speakers.map((s) => ({ ...s, name: null })),
        batch.map((l) => ({ speakerLabel: l.speaker, startMs: l.startMs, endMs: l.endMs, text: l.text })),
      );
      emitMeetingChanged(meetingId);
    } else {
      const ids = await db.ensureSpeakers(transcriptId, speakers);
      await db.appendSegments(
        transcriptId,
        batch.map((l) => ({ speakerId: ids.get(l.speaker) ?? null, startMs: l.startMs, endMs: l.endMs, text: l.text })),
      );
    }
  } catch (err) {
    // Try again with the next batch.
    pendingSave = [...batch, ...pendingSave];
    console.warn('Could not save live transcript lines', err);
  }
}

function languageSummary(): string | null {
  const total = [...languageChars.values()].reduce((a, b) => a + b, 0);
  if (!total) return null;
  return [...languageChars]
    .sort((a, b) => b[1] - a[1])
    .map(([lang, n]) => `${lang} ${Math.round((100 * n) / total)}%`)
    .join(', ');
}

export function hasSavedTranscript(): boolean {
  return transcriptId != null;
}

// Cost and language mix, once the session has stopped.
export async function saveTranscriptStats(costUsd: number): Promise<void> {
  if (transcriptId == null) return;
  await db.updateTranscriptStats(transcriptId, { costUsd, languages: languageSummary() }).catch(() => {});
}
