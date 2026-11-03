// Live AI during a recording: rolling notes, "help me answer", the per-meeting
// model choices and their cost estimates.
import { errorMessage } from '../errors';
import {
  cacheWindowMs,
  effectiveModel,
  estimateCallCost,
  estimateCost,
  getAiAuth,
  getAiProvider,
  roughTokens,
  runAi,
  pickerModels,
  type AiResult,
} from '../ai';
import { briefingText } from '../ai/meeting';
import { formatTranscript, languageInstruction, type PromptLine } from '../ai/prompts';
import * as db from '../db';
import { emitMeetingChanged } from '../pipeline';
import { getSettings, useSettings } from '../settings';
import { useLive, type LiveAiTask, type LiveAnswer, type LiveLine } from './store';
import { selfLabel } from './transcript';

const set = useLive.setState;
const get = useLive.getState;

const NOTES_WINDOW_MS = 90_000;
// A transcript chunk closes once it reaches this size, about 1,300 tokens: above
// every provider's minimum cacheable length, and a few minutes of talking.
const CHUNK_CHARS = 4500;
const ANSWER_OUTPUT_TOKENS = 500;
const NOTES_OUTPUT_TOKENS = 350;

let notesLineCount = 0;
let lastAnswerModel = '';
let lastAnswerAt = 0;
let lastNotesModel = '';
let lastNotesAt = 0;
let answerSeq = 0;
let answerAbort: AbortController | null = null;
let notesSaving: Promise<boolean> = Promise.resolve(false);

export function resetAi() {
  notesLineCount = 0;
  lastAnswerModel = '';
  lastAnswerAt = 0;
  lastNotesModel = '';
  lastNotesAt = 0;
  answerAbort?.abort();
  answerAbort = null;
}

// ---------- Rolling notes ----------

const NOTES_ROLE = `You keep short running notes of a meeting that is happening right now, for the user to glance at.
You get the current notes and the newest transcript lines. Return the complete updated notes and nothing else.
Format: Markdown bullet lists under these headings (translated into the output language), omitting empty ones:
**Topics**, **Decisions**, **Action items**, **Open questions**.
Rules: keep it under about 200 words; merge and drop stale points rather than growing forever; only include what was actually said; never cite line ids.`;

// The lines a 'notes'-mode update sends: everything since the last update,
// and at least the last ~90 s for continuity.
function notesExcerpt(lines: LiveLine[]): LiveLine[] {
  if (!lines.length) return [];
  const fresh = lines.slice(notesLineCount);
  const latestEnd = Math.max(...lines.map((l) => l.endMs));
  const recent = lines.filter((l) => l.endMs >= latestEnd - NOTES_WINDOW_MS);
  return [...new Map([...recent, ...fresh].map((l) => [l.id, l])).values()].sort((a, b) => a.startMs - b.startMs);
}

// Adds a finished call to the meeting's running totals.
function addSpend(st: ReturnType<typeof get>, result: AiResult) {
  const u = result.usage;
  return {
    aiCostUsd: st.aiCostUsd + (estimateCost(result.model, u) ?? 0),
    aiPromptTokens: st.aiPromptTokens + u.inputTokens + u.cachedInputTokens + u.cacheWriteTokens,
    aiCachedTokens: st.aiCachedTokens + u.cachedInputTokens,
  };
}

export async function refreshNotes(): Promise<void> {
  const s = get();
  if (s.notesBusy || s.lines.length === notesLineCount) return;
  const lines = s.lines;
  const model = s.overrides.live || undefined;
  const notes = s.notes.trim() || '(none yet)';
  // Read at each update, so switching mode mid-meeting applies from the next one.
  const full = getSettings().liveNotesContext === 'full';
  const firstNew = lines[notesLineCount]?.id;
  set({ notesBusy: true, notesError: null });
  try {
    const result = await runAi('live', {
      model,
      system: [NOTES_ROLE, selfNote(), languageInstruction(getSettings().aiOutputLanguage)].join('\n\n'),
      // 'full': finished transcript chunks are cached; only the newest lines aren't.
      ...(full ? transcriptContext(lines) : {}),
      messages: [
        {
          role: 'user',
          content: full
            ? `Current notes:\n${notes}\n\nUpdate the notes from the transcript above${firstNew != null ? `; lines from [#${firstNew}] on are new since the last update` : ''}.`
            : `Current notes:\n${notes}\n\nNewest transcript lines:\n${formatTranscript(notesExcerpt(lines).map(toPromptLine))}`,
        },
      ],
      maxTokens: 1500,
    });
    notesLineCount = lines.length;
    lastNotesModel = result.model;
    lastNotesAt = Date.now();
    const text = result.text.trim();
    set((st) => ({ notes: text || st.notes, notesBusy: false, ...addSpend(st, result) }));
    // Saved at every update, so MCP clients can read them during the meeting.
    if (s.meetingId != null) void storeNotes(s.meetingId);
  } catch (err) {
    set({ notesBusy: false, notesError: errorMessage(err) });
  }
}

function toPromptLine(l: LiveLine): PromptLine {
  return { id: l.id, startMs: l.startMs, speaker: l.speaker, text: l.text };
}

function selfNote(): string {
  return `Lines from "${selfLabel()}" are the user (me); everyone else is "Speaker N".`;
}

// ---------- Help me answer ----------

const ANSWER_ROLE = `You help the user during a live meeting. They glance at your reply while talking, so be brief.
When asked to help answer: work out what was just asked of the user or is being discussed, and give a reply they can say in their own words: lead with the answer in 1-3 short sentences, then at most 3 bullet points of supporting facts from the meeting or the briefing.
When the user types a question, answer it directly and briefly.
Never invent facts about the user, their company or the meeting; if something isn't known, say what to ask or check. Do not include line ids or citations.`;

// Splits the transcript into closed chunks, which never change again, and the
// newest lines. Providers only reuse a prefix up to a block boundary, so one
// growing block would miss the cache on every call. Lines only ever arrive at
// the end, so the same lines always make the same chunks.
function transcriptContext(lines: LiveLine[]): { context: string[]; contextTail: string } {
  const context: string[] = [];
  let open: LiveLine[] = [];
  let size = 0;
  for (const line of lines) {
    open.push(line);
    size += line.text.length + 24; // + the "[#id mm:ss Speaker] " prefix
    if (size >= CHUNK_CHARS) {
      context.push(formatTranscript(open.map(toPromptLine)));
      open = [];
      size = 0;
    }
  }
  if (context.length) context[0] = `Live transcript so far:\n${context[0]}`;
  const tail = formatTranscript(open.map(toPromptLine));
  return { context, contextTail: context.length ? tail : `Live transcript so far:\n${tail}` };
}

function transcriptTokens(lines: LiveLine[]): number {
  return roughTokens(formatTranscript(lines.map(toPromptLine))) + 10;
}

export async function helpMeAnswer(question?: string): Promise<void> {
  const s = get();
  const q = question?.trim() || null;
  if (!s.lines.length && !Object.keys(s.partials).length && !q) {
    set({ answer: { id: ++answerSeq, question: q, text: '', busy: false, error: 'Nothing has been transcribed yet.', model: '' } });
    return;
  }
  answerAbort?.abort();
  const abort = new AbortController();
  answerAbort = abort;
  const id = ++answerSeq;
  const model = s.overrides.answer || effectiveModel('answer');
  set({ answer: { id, question: q, text: '', busy: true, error: null, model } });
  const update = (patch: Partial<LiveAnswer>) => {
    const a = get().answer;
    if (a?.id === id) set({ answer: { ...a, ...patch } });
  };

  try {
    const meeting = s.meetingId != null ? await db.getMeeting(s.meetingId) : null;
    const folder = meeting?.folderId != null ? await db.getFolder(meeting.folderId) : null;
    const items = folder ? (await db.listActionItems(folder.id)).filter((i) => i.status === 'open') : [];
    const system = [
      ANSWER_ROLE,
      selfNote(),
      languageInstruction(getSettings().aiOutputLanguage),
      meeting ? `Meeting: ${meeting.title}` : '',
      meeting ? briefingText(meeting, folder) : '',
      items.length
        ? `Open action items from earlier meetings in this series:\n${items.map((i) => `- ${i.owner ? `${i.owner}: ` : ''}${i.text}`).join('\n')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const latest = Object.values(get().partials)
      .map((p) => p && `${p.speaker}: ${(p.final + p.provisional).trim()}`)
      .filter(Boolean)
      .join('\n');
    const ask = q ? `My question: ${q}` : 'Help me answer what was just asked or said.';
    const result = await runAi(
      'answer',
      {
        model,
        system,
        ...transcriptContext(s.lines),
        messages: [{ role: 'user', content: latest ? `${ask}\n\nWords still being spoken (not final yet):\n${latest}` : ask }],
        maxTokens: 2000,
        signal: abort.signal,
      },
      { onText: (_delta, text) => update({ text }) },
    );
    lastAnswerModel = result.model;
    lastAnswerAt = Date.now();
    set((st) => addSpend(st, result));
    update({ text: result.text.trim(), busy: false, model: result.model });
  } catch (err) {
    if (abort.signal.aborted) return;
    update({ busy: false, error: errorMessage(err) });
  }
}

async function writeNotes(meetingId: number): Promise<boolean> {
  const notes = get().notes.trim();
  if (!notes || get().meetingId !== meetingId) return false;
  try {
    // "Delete recording" may have removed the meeting meanwhile.
    if (!(await db.getMeeting(meetingId))) return false;
    await db.saveAiDoc({
      scope: 'meeting',
      ownerId: meetingId,
      kind: 'notes',
      content: notes,
      model: get().overrides.live || effectiveModel('live'),
      costUsd: get().aiCostUsd || null,
    });
    return true;
  } catch (err) {
    console.warn('Could not save live notes', err);
    return false;
  }
}

// One write at a time: each replaces the last, so two at once could delete each other.
function storeNotes(meetingId: number): Promise<boolean> {
  notesSaving = notesSaving.then(() => writeNotes(meetingId));
  return notesSaving;
}

// Keeps the final notes with the meeting.
export async function saveNotes(meetingId: number) {
  if (await storeNotes(meetingId)) emitMeetingChanged(meetingId);
}

// ---------- Models ----------

export function liveModel(task: LiveAiTask): string {
  return get().overrides[task] || effectiveModel(task);
}

// '' resets to the settings default. `makeDefault` also saves it to settings.
export async function setLiveModel(task: LiveAiTask, model: string, makeDefault = false): Promise<void> {
  if (makeDefault) {
    await useSettings.getState().update(task === 'live' ? { aiLiveModel: model } : { aiAnswerModel: model });
    set((s) => ({ overrides: { ...s.overrides, [task]: undefined } }));
    return;
  }
  set((s) => ({ overrides: { ...s.overrides, [task]: model || undefined } }));
}

// Expected cost of the next answer. A model whose cache is cold (just switched
// to, or idle past the cache's lifetime) pays full price for the whole transcript.
export function answerCostEstimate(model = liveModel('answer')): number | null {
  const lines = get().lines;
  const tokens = transcriptTokens(lines) + 800; // + system prompt and briefing
  const cached = model === lastAnswerModel && Date.now() - lastAnswerAt < cacheWindowMs(model);
  return estimateCallCost(model, tokens, ANSWER_OUTPUT_TOKENS, cached);
}

// Expected cost of one notes update in the current mode. In 'full' mode the
// transcript stays cached between updates.
export function notesCostEstimate(model = liveModel('live')): number | null {
  const s = get();
  const fixed = roughTokens(s.notes) + 500; // notes + system prompt
  if (getSettings().liveNotesContext === 'full') {
    const cached = model === lastNotesModel && Date.now() - lastNotesAt < cacheWindowMs(model);
    const cost = estimateCallCost(model, transcriptTokens(s.lines), NOTES_OUTPUT_TOKENS, cached);
    const extra = estimateCallCost(model, fixed, 0, false);
    return cost == null || extra == null ? null : cost + extra;
  }
  const excerpt = formatTranscript(notesExcerpt(s.lines).map(toPromptLine));
  return estimateCallCost(model, fixed + roughTokens(excerpt), NOTES_OUTPUT_TOKENS, false);
}

export async function loadModelOptions(): Promise<void> {
  const settings = getSettings();
  const provider = getAiProvider(settings.aiProvider);
  const { default: d, budget, others } = provider.recommendedModels;
  const fallback = [d, budget, ...others].filter(Boolean);
  try {
    const ids = await provider.listModels(await getAiAuth(provider.id, settings));
    const { recommended, rest } = pickerModels(provider, ids, settings);
    set({ modelOptions: ids.length ? [...recommended, ...rest] : fallback });
  } catch {
    set({ modelOptions: fallback });
  }
}
