// Meeting-level AI: the Markdown summary and transcript chat. Both send the
// whole active transcript as the cacheable context block.
import { create } from 'zustand';
import * as db from '../db';
import { formatDate } from '../format';
import { getSecret } from '../secrets';
import { getSettings } from '../settings';
import type { AiDoc, ChatMessage, Folder, Meeting, TranscriptDetail } from '../types';
import { estimateCost, getAiProvider, roughTokens, runAi, type AiMessage, type AiResult } from './index';
import { CITATION_RULES, formatTranscript, languageInstruction, toPromptLines } from './prompts';

export interface MeetingAiOptions {
  signal?: AbortSignal;
  onText?: (text: string) => void; // everything streamed so far
  model?: string; // instead of the summary model setting, for this call only
}

// Largest context any supported model takes is ~1M tokens; past that the call
// can't succeed, so say so instead of sending megabytes for an API error.
const MAX_CONTEXT_TOKENS = 950_000;

// True when the configured provider has a key (or doesn't need one).
export async function hasAiKey(): Promise<boolean> {
  const provider = getAiProvider(getSettings().aiProvider);
  if (provider.keyOptional) return true;
  return !!(await getSecret(provider.secret));
}

export interface MeetingContext {
  meeting: Meeting;
  folder: Folder | null;
  detail: TranscriptDetail;
  transcript: string; // formatted "[#id mm:ss Speaker] text" lines
}

// Loads the meeting with its active transcript; throws a readable error when
// there's nothing to work with.
export async function loadMeetingContext(meetingId: number): Promise<MeetingContext> {
  const meeting = await db.getMeeting(meetingId);
  if (!meeting) throw new Error('This meeting no longer exists.');
  const tid = meeting.activeTranscriptId ?? (await db.listTranscripts(meetingId))[0]?.id ?? null;
  const detail = tid != null ? await db.getTranscriptDetail(tid) : null;
  if (!detail) throw new Error('This meeting has no transcript yet. Transcribe it first.');
  const lines = toPromptLines(
    detail.segments.filter((s) => s.text.trim()),
    detail.speakers,
  );
  if (!lines.length) throw new Error('The transcript has no text to work with.');
  const transcript = formatTranscript(lines);
  if (roughTokens(transcript) > MAX_CONTEXT_TOKENS) {
    throw new Error('This transcript is too long for the AI to read in one go (over ~1M tokens).');
  }
  const folder = meeting.folderId != null ? await db.getFolder(meeting.folderId) : null;
  return { meeting, folder, detail, transcript };
}

// The user's "who I am / context / goals" notes, folder first, then meeting.
export function briefingText(meeting: Pick<Meeting, 'briefing'>, folder?: Pick<Folder, 'briefing' | 'name'> | null): string {
  const parts: string[] = [];
  if (folder?.briefing?.trim()) parts.push(`About this series of meetings ("${folder.name}"):\n${folder.briefing.trim()}`);
  if (meeting.briefing?.trim()) parts.push(`About this meeting:\n${meeting.briefing.trim()}`);
  return parts.length ? `Briefing from the user (who they are, context, goals):\n\n${parts.join('\n\n')}` : '';
}

// Title, date and transcript. Kept free of anything that changes between calls
// so the provider can cache it.
export function contextBlock(ctx: MeetingContext): string {
  const { meeting } = ctx;
  return `Meeting: ${meeting.title}\nDate: ${formatDate(meeting.createdAt)}\n\nTranscript:\n${ctx.transcript}`;
}

function systemPrompt(role: string, ctx: MeetingContext): string {
  return [role, CITATION_RULES, languageInstruction(getSettings().aiOutputLanguage), briefingText(ctx.meeting, ctx.folder)]
    .filter(Boolean)
    .join('\n\n');
}

function costOf(result: AiResult): number | null {
  return estimateCost(result.model, result.usage);
}

export function truncationNote(result: AiResult): string {
  return result.stopReason === 'max_tokens' ? '\n\n_(The answer was cut off because it reached the length limit.)_' : '';
}

const SUMMARY_ROLE = `You summarise a meeting from its transcript for someone who needs the outcome, not a retelling.
Write Markdown with exactly these sections, in this order, as level-2 headings (translated into the output language):
## Overview
2-5 sentences: purpose of the meeting, who took part, the main outcome.
## Decisions
Bullet list of what was decided or agreed.
## Action items
Bullet list. Start each item with the owner in bold when the transcript makes it clear (e.g. "**Maria**: send the draft by Friday"), otherwise just the task. Include due dates when mentioned.
## Open questions
Bullet list of unresolved points, disagreements and things deferred.

Rules:
- Every bullet and every sentence of the overview must cite the transcript lines it is based on.
- Write "None." under a section that has nothing; never invent content to fill it.
- Speaker labels like "Speaker 2" are not names; refer to them as written unless the transcript reveals a name.
- No tables, no preamble before the first heading, no closing remarks.`;

// Generates and stores the meeting summary (one per meeting; regenerating
// replaces it).
export async function summarizeMeeting(meetingId: number, opts: MeetingAiOptions = {}): Promise<AiDoc> {
  const ctx = await loadMeetingContext(meetingId);
  const result = await runAi(
    'summary',
    {
      system: systemPrompt(SUMMARY_ROLE, ctx),
      context: contextBlock(ctx),
      messages: [{ role: 'user', content: 'Summarise this meeting.' }],
      maxTokens: 16000,
      model: opts.model || undefined,
      signal: opts.signal,
    },
    { onText: (_delta, text) => opts.onText?.(text) },
  );
  const content = result.text.trim();
  if (!content) throw new Error(result.stopReason === 'refusal' ? 'The model declined to summarise this meeting.' : 'The model returned an empty summary.');
  const doc = await db.saveAiDoc({
    scope: 'meeting',
    ownerId: meetingId,
    kind: 'summary',
    content: content + truncationNote(result),
    model: result.model,
    costUsd: costOf(result),
  });
  for (const fn of summaryListeners) fn(meetingId);
  return doc;
}

// Summary runs live here, not in the Summary tab, so switching tabs or pages
// doesn't cancel a run that's already being paid for, and coming back shows
// its progress. One run per meeting; Stop is the only way to cancel.
export interface SummaryJob {
  text: string; // streamed so far
  model: string | null;
  error: string | null; // set when the run failed; cleared by the next run
  running: boolean;
}

export const useSummaryJobs = create<Record<number, SummaryJob>>(() => ({}));
const summaryAborts = new Map<number, AbortController>();

function setJob(meetingId: number, patch: Partial<SummaryJob>) {
  useSummaryJobs.setState((s) => ({
    [meetingId]: { ...(s[meetingId] ?? { text: '', model: null, error: null, running: false }), ...patch },
  }));
}

// Starts a summary unless one is already running for this meeting. Resolves
// with the saved doc, or null if it failed or was stopped (the error is in the job).
export async function startSummary(meetingId: number, opts: { model?: string } = {}): Promise<AiDoc | null> {
  if (summaryAborts.has(meetingId)) return null;
  const ctrl = new AbortController();
  summaryAborts.set(meetingId, ctrl);
  setJob(meetingId, { text: '', model: opts.model || null, error: null, running: true });
  try {
    const doc = await summarizeMeeting(meetingId, {
      model: opts.model,
      signal: ctrl.signal,
      onText: (text) => setJob(meetingId, { text }),
    });
    setJob(meetingId, { running: false, text: '' });
    return doc;
  } catch (err) {
    const aborted = ctrl.signal.aborted || isAbortError(err);
    setJob(meetingId, { running: false, text: '', error: aborted ? null : err instanceof Error ? err.message : String(err) });
    return null;
  } finally {
    summaryAborts.delete(meetingId);
  }
}

export function stopSummary(meetingId: number): void {
  summaryAborts.get(meetingId)?.abort();
}

// Folder AI listens here to fold new summaries into the folder (folder.ts).
// Listeners must not throw or block; they run their work in the background.
const summaryListeners = new Set<(meetingId: number) => void>();
export function onMeetingSummarized(fn: (meetingId: number) => void): () => void {
  summaryListeners.add(fn);
  return () => summaryListeners.delete(fn);
}

const CHAT_ROLE = `You answer the user's questions about a meeting, using its transcript.
Be direct and concise. Quote or paraphrase what was actually said and cite it. If the transcript doesn't cover the question, say so plainly instead of guessing; you may add general knowledge only when clearly marked as such.
Use Markdown sparingly (short paragraphs, bullet lists when listing things, no tables).`;

// Consecutive turns with the same role (e.g. after a failed reply) are merged
// so the history alternates as providers expect.
export function toAiMessages(history: ChatMessage[], question: string): AiMessage[] {
  const out: AiMessage[] = [];
  for (const m of [...history.map((h) => ({ role: h.role, content: h.content })), { role: 'user' as const, content: question }]) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${m.content}`;
    else out.push({ ...m });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

export interface ChatExchange {
  question: ChatMessage;
  answer: ChatMessage;
  costUsd: number | null;
  model: string;
}

// Asks a question about the meeting with the stored chat as history. Both
// turns are saved only once the answer is complete, so a failed or stopped
// request leaves the chat as it was.
export async function askMeeting(meetingId: number, question: string, opts: MeetingAiOptions = {}): Promise<ChatExchange> {
  const q = question.trim();
  if (!q) throw new Error('Type a question first.');
  const ctx = await loadMeetingContext(meetingId);
  const history = await db.listChatMessages('meeting', meetingId);
  const result = await runAi(
    'summary',
    {
      system: systemPrompt(CHAT_ROLE, ctx),
      context: contextBlock(ctx),
      messages: toAiMessages(history, q),
      maxTokens: 8000,
      effort: 'normal',
      signal: opts.signal,
    },
    { onText: (_delta, text) => opts.onText?.(text) },
  );
  const text = result.text.trim();
  if (!text) throw new Error(result.stopReason === 'refusal' ? 'The model declined to answer.' : 'The model returned an empty answer.');
  const saved = await db.addChatMessage('meeting', meetingId, 'user', q);
  const answer = await db.addChatMessage('meeting', meetingId, 'assistant', text + truncationNote(result));
  return { question: saved, answer, costUsd: costOf(result), model: result.model };
}

// True for errors caused by the user stopping a request.
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.constructor?.name ?? '') || /aborted/i.test(err.message));
}
