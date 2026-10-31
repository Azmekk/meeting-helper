// Folder-level AI: rolling folder summary, action item tracking (reconcile),
// tool-using chat over all meetings in a folder, and custom extraction. The
// whole folder never fits in one prompt, so each step reads one meeting (or
// summaries) and chat fetches what it needs through read-only tools.
import { create } from 'zustand';
import { toast } from '../../components/ui';
import * as db from '../db';
import { formatDate, formatDuration, formatTimestamp } from '../format';
import { getSettings } from '../settings';
import type { ActionItem, ActionItemStatus, AiDoc, ChatMessage, ExtractionTemplate, Folder, Meeting } from '../types';
import { estimateCost, runAi, type AiResult, type AiTool, type AiToolCall } from './index';
import {
  briefingText,
  contextBlock,
  isAbortError,
  loadMeetingContext,
  onMeetingSummarized,
  toAiMessages,
  truncationNote,
  type ChatExchange,
} from './meeting';
import { formatTranscript, languageInstruction, toPromptLines } from './prompts';

export interface FolderAiOptions {
  signal?: AbortSignal;
  onText?: (text: string) => void;
}

function costOf(result: AiResult): number | null {
  return estimateCost(result.model, result.usage);
}

async function requireFolder(folderId: number): Promise<Folder> {
  const folder = await db.getFolder(folderId);
  if (!folder) throw new Error('This folder no longer exists.');
  return folder;
}

function folderBriefing(folder: Folder): string {
  return briefingText({ briefing: null }, folder);
}

function meetingLabel(m: Pick<Meeting, 'title' | 'createdAt'>): string {
  return `"${m.title || 'Untitled meeting'}" (${formatDate(m.createdAt)})`;
}

const FOLDER_CITATIONS =
  'Meeting material contains citations like [#123] that point at transcript lines. Keep the citations that support ' +
  'what you write, exactly as given, and never invent new ids.';

// ---------- Bookkeeping ----------

// Which meetings have been folded into the summary / reconciled into the
// action items, so automatic updates don't process one twice.
interface FolderState {
  summaryMeetings: number[];
  progressMeetings: number[];
}

export async function getFolderState(folderId: number): Promise<FolderState> {
  const doc = await db.getAiDoc('folder', folderId, 'folder_state');
  try {
    const s = doc ? (JSON.parse(doc.content) as Partial<FolderState>) : {};
    return { summaryMeetings: s.summaryMeetings ?? [], progressMeetings: s.progressMeetings ?? [] };
  } catch {
    return { summaryMeetings: [], progressMeetings: [] };
  }
}

async function updateFolderState(folderId: number, fn: (s: FolderState) => FolderState): Promise<void> {
  const next = fn(await getFolderState(folderId));
  await db.saveAiDoc({ scope: 'folder', ownerId: folderId, kind: 'folder_state', content: JSON.stringify(next), model: null, costUsd: null });
}

const addId = (ids: number[], id: number) => (ids.includes(id) ? ids : [...ids, id]);

// ---------- Folder summary ----------

const FOLDER_SUMMARY_ROLE = `You keep a running summary of a series of related meetings (a project, client or team), for someone who needs to know where things stand without rereading every meeting.
Write Markdown with these level-2 headings (translated into the output language):
## Where things stand
A short paragraph on the current state and direction.
## Key decisions
Bullets, newest last, each with the meeting date in parentheses.
## Open threads
Unresolved questions, risks, pending work.
## People
Who is involved and their role, when known.

Rules:
- Merge new information into the existing summary: update what changed, drop what is no longer relevant, keep what still is. Don't just append.
- Write "None." under a heading with nothing; never invent content.
- No preamble, no closing remarks.`;

async function meetingSummaryText(m: Meeting): Promise<string | null> {
  return (await db.getAiDoc('meeting', m.id, 'summary'))?.content ?? null;
}

function systemFor(role: string, folder: Folder): string {
  return [role, FOLDER_CITATIONS, languageInstruction(getSettings().aiOutputLanguage), folderBriefing(folder)].filter(Boolean).join('\n\n');
}

// Folds one meeting's summary into the folder summary.
export async function updateFolderSummary(folderId: number, meetingId: number, opts: FolderAiOptions = {}): Promise<AiDoc> {
  const folder = await requireFolder(folderId);
  const meeting = await db.getMeeting(meetingId);
  if (!meeting) throw new Error('This meeting no longer exists.');
  const summary = await meetingSummaryText(meeting);
  if (!summary) throw new Error('Summarise the meeting first.');
  const previous = (await db.getAiDoc('folder', folderId, 'folder_summary'))?.content ?? '';

  const result = await runAi(
    'summary',
    {
      system: systemFor(FOLDER_SUMMARY_ROLE, folder),
      messages: [
        {
          role: 'user',
          content:
            `Folder: ${folder.name}\n\nCurrent folder summary:\n${previous.trim() || '(none yet: this is the first meeting)'}\n\n` +
            `New meeting ${meetingLabel(meeting)}, its summary:\n${summary}\n\nWrite the updated folder summary.`,
        },
      ],
      maxTokens: 8000,
      signal: opts.signal,
    },
    { onText: (_d, text) => opts.onText?.(text) },
  );
  return saveFolderSummary(folderId, result, (s) => ({ ...s, summaryMeetings: addId(s.summaryMeetings, meetingId) }));
}

// Rebuilds the folder summary from every meeting summary in the folder at once.
export async function rebuildFolderSummary(folderId: number, opts: FolderAiOptions = {}): Promise<AiDoc> {
  const folder = await requireFolder(folderId);
  const parts: string[] = [];
  const ids: number[] = [];
  for (const m of await db.listFolderMeetings(folderId)) {
    const summary = await meetingSummaryText(m);
    if (!summary) continue;
    parts.push(`### Meeting ${meetingLabel(m)}\n${summary}`);
    ids.push(m.id);
  }
  if (!parts.length) throw new Error('No meeting in this folder has a summary yet. Summarise a meeting first.');
  const result = await runAi(
    'summary',
    {
      system: systemFor(FOLDER_SUMMARY_ROLE, folder),
      context: `Folder: ${folder.name}\n\nMeeting summaries, oldest first:\n\n${parts.join('\n\n')}`,
      messages: [{ role: 'user', content: 'Write the folder summary from these meetings.' }],
      maxTokens: 8000,
      signal: opts.signal,
    },
    { onText: (_d, text) => opts.onText?.(text) },
  );
  return saveFolderSummary(folderId, result, (s) => ({ ...s, summaryMeetings: ids }));
}

async function saveFolderSummary(folderId: number, result: AiResult, state: (s: FolderState) => FolderState): Promise<AiDoc> {
  const content = result.text.trim();
  if (!content) throw new Error(result.stopReason === 'refusal' ? 'The model declined to write the summary.' : 'The model returned an empty summary.');
  const doc = await db.saveAiDoc({
    scope: 'folder',
    ownerId: folderId,
    kind: 'folder_summary',
    content: content + truncationNote(result),
    model: result.model,
    costUsd: costOf(result),
  });
  await updateFolderState(folderId, state);
  return doc;
}

// ---------- Progress (action items) ----------

const RECONCILE_ROLE = `You track action items across a series of meetings. You get the currently open items and one new meeting (summary and transcript).
- For each open item the new meeting says something about, return an update: "done" when it was completed, "dropped" when it was cancelled or is no longer relevant, "open" when it is still pending but its wording or owner should change. Give the new text/owner, or null to keep them. Leave items the meeting doesn't mention out of "updates".
- Add new commitments and tasks from the meeting as new_items, with the owner when the transcript makes it clear and the id of the transcript line where it came up. Don't add duplicates of open items.
- Keep item texts short and concrete (a task, not a sentence about the meeting).`;

const RECONCILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['updates', 'new_items'],
  properties: {
    updates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'status', 'text', 'owner'],
        properties: {
          id: { type: 'integer', description: 'Id of an open item' },
          status: { type: 'string', enum: ['open', 'done', 'dropped'] },
          text: { type: ['string', 'null'], description: 'New wording, or null to keep it' },
          owner: { type: ['string', 'null'], description: 'New owner, or null to keep it' },
        },
      },
    },
    new_items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'owner', 'segment_id'],
        properties: {
          text: { type: 'string' },
          owner: { type: ['string', 'null'] },
          segment_id: { type: ['integer', 'null'], description: 'Transcript line id where it came up' },
        },
      },
    },
  },
} as const;

interface ReconcileOutput {
  updates: { id: number; status: ActionItemStatus; text: string | null; owner: string | null }[];
  new_items: { text: string; owner: string | null; segment_id: number | null }[];
}

export interface ReconcileResult {
  updated: number;
  added: number;
  costUsd: number | null;
}

function itemLine(a: ActionItem): string {
  return `- id ${a.id}: ${a.text}${a.owner ? ` (owner: ${a.owner})` : ''}`;
}

// Applies one meeting to the folder's action items.
export async function reconcileActionItems(folderId: number, meetingId: number, opts: FolderAiOptions = {}): Promise<ReconcileResult> {
  const folder = await requireFolder(folderId);
  const ctx = await loadMeetingContext(meetingId);
  const open = (await db.listActionItems(folderId)).filter((a) => a.status === 'open' && a.meetingId !== meetingId);
  const summary = await meetingSummaryText(ctx.meeting);

  const result = await runAi('summary', {
    system: [RECONCILE_ROLE, languageInstruction(getSettings().aiOutputLanguage), briefingText(ctx.meeting, folder)].filter(Boolean).join('\n\n'),
    context: contextBlock(ctx),
    messages: [
      {
        role: 'user',
        content:
          `Open action items in "${folder.name}":\n${open.map(itemLine).join('\n') || '(none)'}\n\n` +
          (summary ? `Summary of this meeting:\n${summary}\n\n` : '') +
          'Return the updates and new items as JSON.',
      },
    ],
    maxTokens: 8000,
    json: { name: 'action_items', schema: RECONCILE_SCHEMA as unknown as Record<string, unknown> },
    signal: opts.signal,
  });
  const out = result.json as ReconcileOutput | undefined;
  if (!out || !Array.isArray(out.updates) || !Array.isArray(out.new_items)) throw new Error('The model returned no usable action items.');

  // Re-running for the same meeting replaces the items it added before.
  for (const a of await db.listMeetingActionItems(meetingId)) {
    if (a.folderId === folderId && a.firstSeenMeeting === meetingId) await db.deleteActionItem(a.id);
  }

  const openIds = new Map(open.map((a) => [a.id, a]));
  let updated = 0;
  for (const u of out.updates) {
    const item = openIds.get(u.id);
    if (!item || !['open', 'done', 'dropped'].includes(u.status)) continue;
    const text = u.text?.trim() || item.text;
    const owner = u.owner?.trim() || item.owner;
    if (u.status === item.status && text === item.text && owner === item.owner) continue;
    await db.updateActionItem(item.id, { status: u.status, text, owner, lastUpdateMeeting: meetingId });
    updated++;
  }
  const startOf = new Map(ctx.detail.segments.map((s) => [s.id, s.startMs]));
  let added = 0;
  for (const n of out.new_items) {
    const text = n.text?.trim();
    if (!text) continue;
    await db.addActionItem({
      folderId,
      meetingId,
      text,
      owner: n.owner?.trim() || null,
      status: 'open',
      firstSeenMeeting: meetingId,
      lastUpdateMeeting: meetingId,
      sourceMs: n.segment_id != null ? (startOf.get(n.segment_id) ?? null) : null,
    });
    added++;
  }
  await updateFolderState(folderId, (s) => ({ ...s, progressMeetings: addId(s.progressMeetings, meetingId) }));
  return { updated, added, costUsd: costOf(result) };
}

// ---------- Extraction ----------

function extractionSchema(t: ExtractionTemplate): Record<string, unknown> {
  // Field names are free text; f1…fn keys keep the schema valid for every provider.
  const properties: Record<string, unknown> = {};
  t.fields.forEach((f, i) => {
    properties[`f${i + 1}`] = {
      type: ['string', 'null'],
      description: `${f.name}${f.description ? `: ${f.description}` : ''}. null if the meeting doesn't say.`,
    };
  });
  return { type: 'object', additionalProperties: false, required: Object.keys(properties), properties };
}

const EXTRACT_ROLE = `You extract structured information from a meeting transcript into the fields described by the JSON schema.
Use only what the meeting says. Keep values short (a phrase or a sentence); use null when the meeting doesn't cover a field. Don't include citations.`;

// Runs a template over one meeting and stores the row.
export async function extractMeeting(templateId: number, meetingId: number, opts: FolderAiOptions = {}): Promise<number | null> {
  const t = await db.getExtractionTemplate(templateId);
  if (!t) throw new Error('This template no longer exists.');
  if (!t.fields.length) throw new Error('Add at least one field to the template.');
  const ctx = await loadMeetingContext(meetingId);
  const result = await runAi('summary', {
    system: [EXTRACT_ROLE, languageInstruction(getSettings().aiOutputLanguage), briefingText(ctx.meeting, ctx.folder)].filter(Boolean).join('\n\n'),
    context: contextBlock(ctx),
    messages: [
      {
        role: 'user',
        content: `Fields:\n${t.fields.map((f, i) => `f${i + 1} = ${f.name}${f.description ? `: ${f.description}` : ''}`).join('\n')}\n\nReturn the JSON object.`,
      },
    ],
    maxTokens: 4000,
    effort: 'normal',
    json: { name: 'extraction', schema: extractionSchema(t) },
    signal: opts.signal,
  });
  const out = result.json as Record<string, unknown> | undefined;
  if (!out || typeof out !== 'object') throw new Error('The model returned no usable values.');
  const values: Record<string, string | null> = {};
  t.fields.forEach((f, i) => {
    const v = out[`f${i + 1}`];
    values[f.name] = v == null || v === '' ? null : String(v);
  });
  await db.saveExtractionRow(templateId, meetingId, values);
  return costOf(result);
}

export interface ExtractionRun {
  done: number;
  failed: { meetingId: number; error: string }[];
  costUsd: number;
}

// Runs a template over several meetings, one at a time. `onStep` reports
// progress; stops early when the signal aborts.
export async function runExtraction(
  templateId: number,
  meetingIds: number[],
  opts: { signal?: AbortSignal; onStep?: (done: number, total: number) => void } = {},
): Promise<ExtractionRun> {
  const run: ExtractionRun = { done: 0, failed: [], costUsd: 0 };
  for (const [i, id] of meetingIds.entries()) {
    if (opts.signal?.aborted) break;
    opts.onStep?.(i, meetingIds.length);
    try {
      run.costUsd += (await extractMeeting(templateId, id, { signal: opts.signal })) ?? 0;
      run.done++;
    } catch (err) {
      if (isAbortError(err)) break;
      run.failed.push({ meetingId: id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  opts.onStep?.(meetingIds.length, meetingIds.length);
  return run;
}

// ---------- Chat ----------

const FOLDER_TOOLS: AiTool[] = [
  {
    name: 'list_meetings',
    description: 'Lists the meetings in this folder (id, date, title, length, whether a summary exists), oldest first.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'search_meetings',
    description:
      'Full-text search over the transcripts of this folder\'s meetings. Matches words and word stems (Bulgarian endings too); "quoted phrases" match exactly. Returns matching transcript lines with ids for citation, newest meetings first.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to find' },
        limit: { type: 'integer', description: 'Max lines (default 30, max 80)' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_meeting_summary',
    description: 'Returns the AI summary of one meeting in this folder.',
    parameters: {
      type: 'object',
      properties: { meeting_id: { type: 'integer' } },
      required: ['meeting_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_transcript_excerpt',
    description:
      'Returns transcript lines of one meeting between two times (milliseconds from the start). Use it to read around search hits or a part of a meeting. Long ranges are cut off.',
    parameters: {
      type: 'object',
      properties: {
        meeting_id: { type: 'integer' },
        from_ms: { type: 'integer' },
        to_ms: { type: 'integer' },
      },
      required: ['meeting_id', 'from_ms', 'to_ms'],
      additionalProperties: false,
    },
  },
];

const MAX_EXCERPT_CHARS = 40_000;

// Implements the read-only folder tools. Meetings outside the folder are refused.
async function runFolderTool(folderId: number, call: AiToolCall): Promise<string> {
  const input = call.input;
  const inFolder = async (raw: unknown): Promise<Meeting> => {
    const m = await db.getMeeting(Number(raw));
    if (!m || m.folderId !== folderId) throw new Error(`Meeting ${String(raw)} is not in this folder.`);
    return m;
  };
  switch (call.name) {
    case 'list_meetings': {
      const meetings = await db.listFolderMeetings(folderId);
      if (!meetings.length) return 'This folder has no meetings.';
      const lines = [];
      for (const m of meetings) {
        const hasSummary = !!(await db.getAiDoc('meeting', m.id, 'summary'));
        lines.push(`meeting ${m.id} | ${formatDate(m.createdAt)} | ${m.title} | ${formatDuration(m.durationMs)} | summary: ${hasSummary ? 'yes' : 'no'}`);
      }
      return lines.join('\n');
    }
    case 'search_meetings': {
      const limit = Math.min(80, Math.max(1, Number(input.limit) || 30));
      const hits = await db.searchFolder(folderId, String(input.query ?? ''), limit);
      if (!hits.length) return 'No matches.';
      const out: string[] = [];
      let last = -1;
      for (const h of hits) {
        if (h.meetingId !== last) {
          out.push(`\nmeeting ${h.meetingId}: ${meetingLabel({ title: h.meetingTitle, createdAt: h.meetingCreatedAt })}`);
          last = h.meetingId;
        }
        out.push(`[#${h.segmentId} ${formatTimestamp(h.startMs)} ${h.speakerName ?? 'Unknown'}] ${h.text}`);
      }
      return out.join('\n').trim();
    }
    case 'get_meeting_summary': {
      const m = await inFolder(input.meeting_id);
      const s = await meetingSummaryText(m);
      return s ? `Summary of meeting ${m.id} ${meetingLabel(m)}:\n${s}` : `Meeting ${m.id} has no summary yet; read its transcript with get_transcript_excerpt.`;
    }
    case 'get_transcript_excerpt': {
      const m = await inFolder(input.meeting_id);
      const tid = m.activeTranscriptId ?? (await db.listTranscripts(m.id))[0]?.id;
      const detail = tid != null ? await db.getTranscriptDetail(tid) : null;
      if (!detail) return `Meeting ${m.id} has no transcript.`;
      const from = Number(input.from_ms) || 0;
      const to = Number(input.to_ms) || Number.MAX_SAFE_INTEGER;
      const lines = toPromptLines(
        detail.segments.filter((s) => s.endMs >= from && s.startMs <= to && s.text.trim()),
        detail.speakers,
      );
      if (!lines.length) return 'No transcript lines in that range.';
      let text = formatTranscript(lines);
      if (text.length > MAX_EXCERPT_CHARS) {
        text = text.slice(0, MAX_EXCERPT_CHARS);
        text = `${text.slice(0, text.lastIndexOf('\n'))}\n(cut off: ask for a later range to continue)`;
      }
      return `Meeting ${m.id} ${meetingLabel(m)}, ${formatTimestamp(from)}–${to === Number.MAX_SAFE_INTEGER ? 'end' : formatTimestamp(to)}:\n${text}`;
    }
    default:
      throw new Error(`Unknown tool ${call.name}`);
  }
}

const FOLDER_CHAT_ROLE = `You answer questions about a series of meetings kept in one folder. You can't see the transcripts directly: use the tools to list meetings, search transcripts, read summaries and read transcript excerpts. Search before saying something wasn't discussed, and read around hits when you need context.
Transcript lines look like [#<id> <time> <speaker>] text. When you state something from a meeting, cite the line ids as [#<id>] (e.g. "The launch moved to May [#123]."), and mention which meeting (title or date) it comes from. Use only ids you have seen in tool results or the material below.
Be direct and concise. Use Markdown sparingly (short paragraphs, bullet lists, no tables).`;

async function folderChatContext(folder: Folder): Promise<string> {
  const meetings = await db.listFolderMeetings(folder.id);
  const summary = await db.getAiDoc('folder', folder.id, 'folder_summary');
  const items = (await db.listActionItems(folder.id)).filter((a) => a.status === 'open');
  return [
    `Folder: ${folder.name}`,
    `Meetings (oldest first):\n${meetings.map((m) => `- meeting ${m.id}: ${meetingLabel(m)}`).join('\n') || '(none)'}`,
    summary ? `Folder summary:\n${summary.content}` : '',
    items.length ? `Open action items:\n${items.map((a) => `- ${a.text}${a.owner ? ` (${a.owner})` : ''}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

// One chat turn with the folder tools. Both turns are saved once the answer
// is complete, like askMeeting.
export async function askFolder(
  folderId: number,
  question: string,
  opts: FolderAiOptions & { onTool?: (call: AiToolCall) => void } = {},
): Promise<ChatExchange> {
  const q = question.trim();
  if (!q) throw new Error('Type a question first.');
  const folder = await requireFolder(folderId);
  const history: ChatMessage[] = await db.listChatMessages('folder', folderId);
  const result = await runAi(
    'summary',
    {
      system: [FOLDER_CHAT_ROLE, languageInstruction(getSettings().aiOutputLanguage), folderBriefing(folder)].filter(Boolean).join('\n\n'),
      context: await folderChatContext(folder),
      messages: toAiMessages(history, q),
      tools: FOLDER_TOOLS,
      runTool: (call) => runFolderTool(folderId, call),
      maxToolRounds: 10,
      maxTokens: 8000,
      effort: 'normal',
      signal: opts.signal,
    },
    { onText: (_d, text) => opts.onText?.(text), onToolCall: opts.onTool },
  );
  const text = result.text.trim();
  if (!text) throw new Error(result.stopReason === 'refusal' ? 'The model declined to answer.' : 'The model returned an empty answer.');
  const saved = await db.addChatMessage('folder', folderId, 'user', q);
  const answer = await db.addChatMessage('folder', folderId, 'assistant', text + truncationNote(result));
  return { question: saved, answer, costUsd: costOf(result), model: result.model };
}

// ---------- Automatic updates ----------

// What's running per folder, for the folder screen.
export const useFolderAi = create<{ busy: Record<number, string> }>(() => ({ busy: {} }));

function setBusy(folderId: number, message: string | null): void {
  useFolderAi.setState((s) => {
    const busy = { ...s.busy };
    if (message) busy[folderId] = message;
    else delete busy[folderId];
    return { busy };
  });
}

// Folder steps run one at a time per folder (they read and write the same state).
const queues = new Map<number, Promise<unknown>>();

export function runInFolderQueue<T>(folderId: number, task: () => Promise<T>): Promise<T> {
  const prev = queues.get(folderId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(task);
  queues.set(folderId, next);
  return next;
}

// After a meeting summary: fold it into the folder summary, reconcile action
// items and fill extraction rows the meeting doesn't have yet.
export function updateFolderAfterMeeting(meetingId: number): Promise<void> {
  return (async () => {
    const meeting = await db.getMeeting(meetingId);
    if (meeting?.folderId == null) return;
    const folderId = meeting.folderId;
    await runInFolderQueue(folderId, async () => {
      const problems: string[] = [];
      const step = async (label: string, fn: () => Promise<unknown>) => {
        setBusy(folderId, label);
        try {
          await fn();
        } catch (err) {
          problems.push(`${label.replace(/…$/, '')}: ${err instanceof Error ? err.message : String(err)}`);
        }
      };
      const state = await getFolderState(folderId);
      await step('Updating the folder summary…', () =>
        state.summaryMeetings.includes(meetingId) ? rebuildFolderSummary(folderId) : updateFolderSummary(folderId, meetingId),
      );
      await step('Updating action items…', () => reconcileActionItems(folderId, meetingId));
      for (const t of await db.listExtractionTemplates(folderId)) {
        await step(`Extracting "${t.name}"…`, () => extractMeeting(t.id, meetingId));
      }
      setBusy(folderId, null);
      if (problems.length) toast(`Folder update incomplete. ${problems.join(' · ')}`, 'error');
    });
  })().catch((err) => console.warn('Folder update failed', err));
}

let started = false;

// Called once at startup.
export function initFolderAi(): void {
  if (started) return;
  started = true;
  onMeetingSummarized((meetingId) => {
    if (getSettings().folderAiAuto) void updateFolderAfterMeeting(meetingId);
  });
}
