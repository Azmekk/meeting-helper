// Turns provider tokens into transcript segments. Ported from
// tools/stt-compare/segments.ts so the app groups text the same way the
// comparison tool did.
import type { ProviderToken } from './providers/types';

// A run of consecutive tokens from one speaker, before it's saved to the db.
export interface BuiltSegment {
  speaker: string; // raw provider id until labelSpeakers() renames it
  startMs: number;
  endMs: number;
  text: string;
}

// Start a new segment after this much silence, or once a segment is this long
// and the current sentence has ended.
const GAP_MS = 1500;
const MAX_SEGMENT_MS = 30_000;

// Tokens without a speaker (e.g. diarization off) are grouped under '?'.
export function buildSegments(tokens: ProviderToken[]): BuiltSegment[] {
  const segments: BuiltSegment[] = [];
  let cur: BuiltSegment | undefined;

  for (const t of tokens) {
    // Whitespace-only tokens (ElevenLabs "spacing") only glue words together.
    if (t.text.trim() === '') {
      if (cur) cur.text += t.text;
      continue;
    }
    const speaker = t.speaker ?? '?';
    const startsNew =
      !cur ||
      speaker !== cur.speaker ||
      t.startMs - cur.endMs > GAP_MS ||
      (cur.endMs - cur.startMs > MAX_SEGMENT_MS && /[.?!…]$/.test(cur.text.trim()));

    if (startsNew) {
      if (cur) pushSegment(segments, cur);
      cur = { speaker, startMs: t.startMs, endMs: t.endMs, text: t.text.trimStart() };
    } else {
      cur!.text += t.text;
      cur!.endMs = Math.max(cur!.endMs, t.endMs);
    }
  }
  if (cur) pushSegment(segments, cur);
  return segments;
}

function pushSegment(segments: BuiltSegment[], seg: BuiltSegment): void {
  const text = seg.text.replace(/\s+/g, ' ').trim();
  if (text) segments.push({ ...seg, text });
}

// Providers use different speaker ids ("1", "speaker_0", ...). Rename them to
// "Speaker 1", "Speaker 2", ... in order of first appearance.
export function labelSpeakers(segments: BuiltSegment[]): BuiltSegment[] {
  const names = new Map<string, string>();
  return segments.map((s) => {
    if (s.speaker === '?') return { ...s, speaker: 'Unknown' };
    if (!names.has(s.speaker)) names.set(s.speaker, `Speaker ${names.size + 1}`);
    return { ...s, speaker: names.get(s.speaker)! };
  });
}

// Share of transcribed characters per language, e.g. "bg 91%, en 9%".
// Undefined when the provider didn't tag languages.
export function languageMix(tokens: ProviderToken[]): string | undefined {
  const chars = new Map<string, number>();
  let total = 0;
  for (const t of tokens) {
    if (!t.language) continue;
    const n = t.text.trim().length;
    chars.set(t.language, (chars.get(t.language) ?? 0) + n);
    total += n;
  }
  if (!total) return undefined;
  return [...chars]
    .sort((a, b) => b[1] - a[1])
    .map(([lang, n]) => `${lang} ${Math.round((100 * n) / total)}%`)
    .join(', ');
}
