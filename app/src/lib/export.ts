// Pure transcript formatters for export (TXT, Markdown, SRT, WebVTT).
import { formatTimestamp } from './format';
import { speakerName, type Speaker, type TranscriptDetail } from './types';

export type ExportFormat = 'txt' | 'md' | 'srt' | 'vtt';

export const EXPORT_FORMATS: { id: ExportFormat; label: string; ext: string }[] = [
  { id: 'txt', label: 'Plain text', ext: 'txt' },
  { id: 'md', label: 'Markdown', ext: 'md' },
  { id: 'srt', label: 'SubRip subtitles (SRT)', ext: 'srt' },
  { id: 'vtt', label: 'WebVTT subtitles', ext: 'vtt' },
];

export interface ExportMeta {
  title: string;
  createdAt?: string; // ISO 8601
}

function nameLookup(detail: TranscriptDetail): (id: number | null) => string | null {
  const byId = new Map<number, Speaker>(detail.speakers.map((s) => [s.id, s]));
  return (id) => {
    if (id == null) return null;
    const s = byId.get(id);
    return s ? speakerName(s) : null;
  };
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

// 01:02:03,456 (SRT) / 01:02:03.456 (VTT)
function cueTime(ms: number, sep: ',' | '.'): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(t % 1000, 3)}`;
}

function dateLine(meta: ExportMeta): string | null {
  if (!meta.createdAt) return null;
  return new Date(meta.createdAt).toLocaleString(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Consecutive segments by the same speaker are grouped into one paragraph.
function paragraphs(detail: TranscriptDetail) {
  const name = nameLookup(detail);
  const out: { speaker: string | null; startMs: number; texts: string[] }[] = [];
  for (const seg of detail.segments) {
    const text = seg.text.trim();
    if (!text) continue;
    const speaker = name(seg.speakerId);
    const last = out[out.length - 1];
    if (last && last.speaker === speaker) last.texts.push(text);
    else out.push({ speaker, startMs: seg.startMs, texts: [text] });
  }
  return out;
}

export function toTxt(detail: TranscriptDetail, meta: ExportMeta): string {
  const lines: string[] = [meta.title];
  const d = dateLine(meta);
  if (d) lines.push(d);
  lines.push('');
  for (const p of paragraphs(detail)) {
    const who = p.speaker ? `${p.speaker}: ` : '';
    lines.push(`[${formatTimestamp(p.startMs)}] ${who}${p.texts.join(' ')}`, '');
  }
  return lines.join('\n').trimEnd() + '\n';
}

export function toMarkdown(detail: TranscriptDetail, meta: ExportMeta): string {
  const lines: string[] = [`# ${meta.title}`, ''];
  const d = dateLine(meta);
  if (d) lines.push(`_${d}_`, '');
  for (const p of paragraphs(detail)) {
    const who = p.speaker ? `**${p.speaker}**` : '**Unknown**';
    lines.push(`${who} · \`${formatTimestamp(p.startMs)}\``, '', p.texts.join(' '), '');
  }
  return lines.join('\n').trimEnd() + '\n';
}

function cues(detail: TranscriptDetail) {
  const name = nameLookup(detail);
  return detail.segments
    .filter((s) => s.text.trim())
    .map((s) => ({
      start: s.startMs,
      end: Math.max(s.endMs, s.startMs + 500),
      speaker: name(s.speakerId),
      text: s.text.trim(),
    }));
}

export function toSrt(detail: TranscriptDetail): string {
  return (
    cues(detail)
      .map(
        (c, i) =>
          `${i + 1}\n${cueTime(c.start, ',')} --> ${cueTime(c.end, ',')}\n${c.speaker ? `${c.speaker}: ` : ''}${c.text}\n`,
      )
      .join('\n') || ''
  );
}

export function toVtt(detail: TranscriptDetail): string {
  const body = cues(detail)
    .map((c) => {
      const text = c.text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const voice = c.speaker ? `<v ${c.speaker.replace(/[<>]/g, '')}>` : '';
      return `${cueTime(c.start, '.')} --> ${cueTime(c.end, '.')}\n${voice}${text}\n`;
    })
    .join('\n');
  return `WEBVTT\n\n${body}`;
}

export function formatTranscript(format: ExportFormat, detail: TranscriptDetail, meta: ExportMeta): string {
  switch (format) {
    case 'txt':
      return toTxt(detail, meta);
    case 'md':
      return toMarkdown(detail, meta);
    case 'srt':
      return toSrt(detail);
    case 'vtt':
      return toVtt(detail);
  }
}

// A filesystem-safe default file name from the meeting title.
export function safeFileName(title: string): string {
  return title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'transcript';
}
