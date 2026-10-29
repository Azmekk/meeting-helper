import type { Segment, Token } from './types.ts';

// Start a new segment after this much silence, or once a segment is this long
// and the current sentence has ended.
const GAP_MS = 1500;
const MAX_SEGMENT_MS = 30_000;

export function buildSegments(tokens: Token[]): Segment[] {
  const segments: Segment[] = [];
  let cur: Segment | undefined;

  for (const t of tokens) {
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
      if (cur) segments.push({ ...cur, text: cur.text.trim() });
      cur = { speaker, startMs: t.startMs, endMs: t.endMs, text: t.text.trimStart() };
    } else {
      cur!.text += t.text;
      cur!.endMs = Math.max(cur!.endMs, t.endMs);
    }
  }
  if (cur) segments.push({ ...cur, text: cur.text.trim() });
  return segments;
}

// Providers use different speaker ids ("1", "speaker_0", ...). Rename them to
// "Speaker 1", "Speaker 2", ... in order of first appearance so outputs line up.
export function labelSpeakers(segments: Segment[]): Segment[] {
  const names = new Map<string, string>();
  return segments.map((s) => {
    if (s.speaker === '?') return { ...s, speaker: 'Unknown' };
    if (!names.has(s.speaker)) names.set(s.speaker, `Speaker ${names.size + 1}`);
    return { ...s, speaker: names.get(s.speaker)! };
  });
}

export function talkTime(segments: Segment[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const s of segments) totals.set(s.speaker, (totals.get(s.speaker) ?? 0) + (s.endMs - s.startMs) / 1000);
  return totals;
}

// Share of transcribed characters per language, e.g. "bg 91%, en 9%".
export function languageMix(tokens: Token[]): string | undefined {
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

export function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}
