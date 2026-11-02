// Shared prompt pieces: transcript formatting, the [#segId] citation
// convention and its parser, and the output-language instruction.
import { formatTimestamp } from '../format';

// Structural so both saved segments (with a speaker lookup) and live lines fit.
export interface PromptLine {
  id: number;
  startMs: number;
  speaker: string;
  text: string;
}

// One line per segment: "[#123 04:56 Maria] text". Deterministic, so the same
// lines always produce the same bytes and stay cacheable.
export function formatTranscript(lines: PromptLine[]): string {
  return lines
    .map((l) => `[#${l.id} ${formatTimestamp(l.startMs)} ${l.speaker}] ${l.text.replace(/\s+/g, ' ').trim()}`)
    .join('\n');
}

// Helper for saved transcripts: speaker display name is `name ?? label`.
export function toPromptLines(
  segments: { id: number; startMs: number; speakerId: number | null; text: string }[],
  speakers: { id: number; label: string; name: string | null }[],
): PromptLine[] {
  const names = new Map(speakers.map((s) => [s.id, s.name ?? s.label]));
  return segments.map((s) => ({
    id: s.id,
    startMs: s.startMs,
    speaker: (s.speakerId != null && names.get(s.speakerId)) || 'Unknown',
    text: s.text,
  }));
}

export const CITATION_RULES =
  'Each transcript line starts with [#<id> <time> <speaker>]. When you state something from the transcript, ' +
  'cite the line(s) it comes from as [#<id>], e.g. "The launch moved to May [#123]." or "[#123][#140]". ' +
  'Always include the # and give each id its own brackets; for a run of lines, cite the first and the last, never a range like [#123-140]. ' +
  'Use only ids that appear in the transcript, and never cite times or speakers in place of ids.';

export type CitationPart = { type: 'text'; text: string } | { type: 'cite'; segId: number };

// Matches [#12], [#12, #15], [#12,15] and [#12; #15], plus what some models
// write despite the rules: ranges ([#12-15]) and a missing # ([12], [12-15]).
const CITE_RE = /\[(#?)(\d+(?:\s*[-–—,;]\s*#?\d+)*)\]/g;

// Splits model text into plain text and citation parts for click-to-seek links.
// A range becomes its first and last line. Without a # the brackets could be
// anything (e.g. [2024]), so they only count when `isKnown` accepts every id.
export function parseCitations(text: string, isKnown?: (id: number) => boolean): CitationPart[] {
  const parts: CitationPart[] = [];
  let last = 0;
  for (const m of text.matchAll(CITE_RE)) {
    const ids = m[2].split(/[-–—,;]/).map((id) => Number(id.trim().replace(/^#/, '')));
    if (!m[1] && !(isKnown && ids.every(isKnown))) continue;
    const at = m.index ?? 0;
    if (at > last) parts.push({ type: 'text', text: text.slice(last, at) });
    for (const n of ids) parts.push({ type: 'cite', segId: n });
    last = at + m[0].length;
  }
  if (last < text.length) parts.push({ type: 'text', text: text.slice(last) });
  return parts;
}

// All possibly cited segment ids, e.g. to look them up before rendering.
export function citedIds(text: string): number[] {
  return parseCitations(text, () => true).flatMap((p) => (p.type === 'cite' ? [p.segId] : []));
}

// Rewrites whatever form a model used to the standard [#id], so stored text
// works everywhere (exports, imports), not only on screen.
export function normalizeCitations(text: string, isKnown: (id: number) => boolean): string {
  return parseCitations(text, isKnown)
    .map((p) => (p.type === 'cite' ? `[#${p.segId}]` : p.text))
    .join('');
}

export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

// `setting` is Settings.aiOutputLanguage: 'meeting' or a language code.
export function languageInstruction(setting: string): string {
  // Headings come from English templates and earlier documents may be in
  // another language; without this the model mixes them or explains itself.
  const rest =
    'Translate the section headings too, and rewrite any earlier version you are given in that language. ' +
    'Never comment on the language you are writing in.';
  if (!setting || setting === 'meeting') {
    return `Write in the language the meeting is held in; if it mixes languages, use the one spoken most. ${rest}`;
  }
  return `Write in ${languageName(setting)}, whatever language the meeting is held in. ${rest}`;
}
