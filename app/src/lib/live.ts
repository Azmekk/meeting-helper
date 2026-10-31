// Live transcription and live AI while OBS records.
//
// Rust (live.rs) streams the recording's mic and desktop tracks to Soniox and
// sends tokens back over a Channel. This module turns them into lines, saves
// final lines to a source:'live' transcript every few seconds, keeps rolling
// notes, and answers "help me answer" requests.
//
// Everything other windows need is in one serializable LiveSnapshot, broadcast
// as `live://state`. Commands come back as events, so the overlay (and later
// the phone remote) never touch this state directly:
//   live://hello      {}                                  → re-broadcast state
//   live://help       {}                                  → help me answer
//   live://ask        { question: string }                → typed question
//   live://set-model  { task: 'live'|'answer', model: string, makeDefault?: boolean }
import { Channel, invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { register, unregister } from '@tauri-apps/plugin-global-shortcut';
import { create } from 'zustand';
import { errorMessage, toast } from '../components/ui';
import {
  effectiveModel,
  estimateCallCost,
  estimateCost,
  getAiAuth,
  getAiProvider,
  roughTokens,
  runAi,
  sortModels,
} from './ai';
import { briefingText, hasAiKey } from './ai/meeting';
import { formatTranscript, languageInstruction, type PromptLine } from './ai/prompts';
import * as db from './db';
import { setRecordingStopHook, useRecorder } from './obs';
import { emitMeetingChanged } from './pipeline';
import { getSecret } from './secrets';
import { meetingTerms } from './terms';
import { getSettings, useSettings } from './settings';

// ---------- Types ----------

export type LiveTrack = 'mic' | 'desktop' | 'mix';
export type TrackState = 'catchingUp' | 'live' | 'reconnecting' | 'stopped' | 'error';
export type LiveAiTask = 'live' | 'answer';

// Shapes sent by live.rs.
interface LiveToken {
  text: string;
  startMs: number; // from the start of the recording
  endMs: number;
  isFinal: boolean;
  speaker: string | null;
  language: string | null;
}

type LiveEvent =
  | { type: 'status'; track: LiveTrack; state: TrackState; message: string | null }
  | { type: 'tokens'; track: LiveTrack; tokens: LiveToken[] };

// A finished line. `id` is local to the session (the prompt's [#id]), not a db id.
export interface LiveLine {
  id: number;
  track: LiveTrack;
  speaker: string;
  isSelf: boolean;
  startMs: number;
  endMs: number;
  text: string;
}

// Text still being spoken: `final` won't change, `provisional` may.
export interface LivePartial {
  track: LiveTrack;
  speaker: string;
  final: string;
  provisional: string;
}

export interface LiveAnswer {
  id: number;
  question: string | null; // null = "help me answer" without a typed question
  text: string;
  busy: boolean;
  error: string | null;
  model: string;
}

export interface AfterStop {
  meetingId: number;
  durationMs: number;
}

// What the overlay and the phone remote get. Keep it JSON-serializable.
export interface LiveSnapshot {
  active: boolean;
  meetingId: number | null;
  error: string | null;
  tracks: Partial<Record<LiveTrack, { state: TrackState; message: string | null }>>;
  lines: LiveLine[]; // the most recent SNAPSHOT_LINES
  lineCount: number;
  partials: LivePartial[];
  notes: string;
  notesBusy: boolean;
  notesError: string | null;
  answer: LiveAnswer | null;
  models: Record<LiveAiTask, string>;
  modelOptions: string[];
  answerCostEstimate: number | null; // USD for the next answer; null = unknown model
  notesContext: 'notes' | 'full';
  notesCostEstimate: number | null; // USD per notes update
  aiCostUsd: number; // spent on live AI so far this meeting
  hotkey: string;
}

interface LiveState {
  active: boolean;
  starting: boolean;
  meetingId: number | null;
  error: string | null;
  tracks: LiveSnapshot['tracks'];
  lines: LiveLine[]; // all final lines of this meeting, in arrival order
  partials: Partial<Record<LiveTrack, LivePartial>>;
  notes: string;
  notesBusy: boolean;
  notesError: string | null;
  answer: LiveAnswer | null;
  overrides: Partial<Record<LiveAiTask, string>>; // per-meeting model choices
  modelOptions: string[];
  aiCostUsd: number;
  hotkeyError: string | null;
  overlayOpen: boolean;
  afterStop: AfterStop | null;
}

const INITIAL: LiveState = {
  active: false,
  starting: false,
  meetingId: null,
  error: null,
  tracks: {},
  lines: [],
  partials: {},
  notes: '',
  notesBusy: false,
  notesError: null,
  answer: null,
  overrides: {},
  modelOptions: [],
  aiCostUsd: 0,
  hotkeyError: null,
  overlayOpen: false,
  afterStop: null,
};

export const useLive = create<LiveState>(() => ({ ...INITIAL }));
const set = useLive.setState;
const get = useLive.getState;

// ---------- Constants ----------

export const LIVE_MODEL = 'stt-rt-v5';
// Soniox real-time list price per audio hour (per track), for the cost shown on the transcript.
const LIVE_USD_PER_HOUR = 0.12;
const SNAPSHOT_LINES = 60;
const SAVE_EVERY_MS = 4000;
const NOTES_EVERY_MS = 60_000;
const NOTES_WINDOW_MS = 90_000;
// Same grouping as segments.ts, so live and batch transcripts read alike.
const GAP_MS = 1500;
const MAX_LINE_MS = 30_000;
// Providers keep a prompt cache for about five minutes.
const CACHE_TTL_MS = 5 * 60_000;
const ANSWER_OUTPUT_TOKENS = 500;
const NOTES_OUTPUT_TOKENS = 350;

// ---------- Session bookkeeping (not part of the store) ----------

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
let streamedMs = 0; // audio streamed per track, summed over start/stop within the meeting
let streamStartedAt: number | null = null;
let trackCount = 0;
let notesLineCount = 0;
let lastAnswerModel = '';
let lastAnswerAt = 0;
let lastNotesModel = '';
let lastNotesAt = 0;
let answerSeq = 0;
let answerAbort: AbortController | null = null;
let saveTimer: ReturnType<typeof setInterval> | null = null;
let notesTimer: ReturnType<typeof setInterval> | null = null;
let stopping: Promise<void> | null = null;
let attemptedFor: number | null = null;
let registeredHotkey: string | null = null;

function selfLabel(): string {
  const name = getSettings().selfName.trim() || 'Me';
  // Labels must stay unique within the transcript.
  return /^Speaker \d+$/.test(name) || name === 'Unknown' ? `${name} (mic)` : name;
}

function resetMeeting(meetingId: number) {
  lineSeq = 0;
  for (const k of Object.keys(open)) delete open[k as LiveTrack];
  speakerNames.clear();
  languageChars.clear();
  pendingSave = [];
  transcriptId = null;
  streamedMs = 0;
  notesLineCount = 0;
  lastAnswerModel = '';
  lastAnswerAt = 0;
  lastNotesModel = '';
  lastNotesAt = 0;
  answerAbort?.abort();
  answerAbort = null;
  set({ ...INITIAL, meetingId, overlayOpen: get().overlayOpen, afterStop: get().afterStop });
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

function onTokens(track: LiveTrack, tokens: LiveToken[]) {
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

function onEvent(ev: LiveEvent) {
  if (ev.type === 'tokens') {
    onTokens(ev.track, ev.tokens);
    return;
  }
  set((s) => ({ tracks: { ...s.tracks, [ev.track]: { state: ev.state, message: ev.message } } }));
  if (ev.state === 'error' && ev.message) set({ error: ev.message });
  // Rust stops every track after a fatal error; wrap up once all are done.
  const states = Object.values(get().tracks);
  if (get().active && !stopping && states.length >= trackCount && states.every((t) => t && (t.state === 'stopped' || t.state === 'error'))) {
    void stopLive();
  }
}

// ---------- Saving ----------

function persist(): Promise<void> {
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

// ---------- Start / stop ----------

// In flight while live_start runs, so the recording-stop hook can wait for it
// (otherwise ffmpeg could still be reading the file when it is renamed).
let starting: Promise<void> | null = null;

export function startLive(): Promise<void> {
  starting ??= doStartLive().finally(() => {
    starting = null;
  });
  return starting;
}

async function doStartLive(): Promise<void> {
  const rec = useRecorder.getState();
  const s = get();
  const meetingId = rec.recordingMeetingId;
  const path = rec.recordingPath;
  if (s.active || s.starting || stopping || !rec.recording || meetingId == null || !path) return;
  if (s.meetingId !== meetingId) resetMeeting(meetingId);
  set({ starting: true, error: null, afterStop: null });

  try {
    if (!/\.mkv$/i.test(path)) throw new Error('Live transcription needs OBS to record MKV files. Change the container on the Record screen.');
    const apiKey = await getSecret('soniox_api_key');
    if (!apiKey) throw new Error('Live transcription uses Soniox. Add your Soniox API key in Settings first.');
    const settings = getSettings();
    const meeting = await db.getMeeting(meetingId);
    const split = meeting?.splitTracks ?? settings.splitTracks;
    const tracks: LiveTrack[] = split ? ['mic', 'desktop'] : ['mix'];
    trackCount = tracks.length;

    const channel = new Channel<LiveEvent>();
    channel.onmessage = onEvent;
    set({ tracks: Object.fromEntries(tracks.map((t) => [t, { state: 'catchingUp', message: null }])) });
    await invoke('live_start', {
      config: {
        path,
        apiKey,
        model: LIVE_MODEL,
        languages: settings.languages,
        terms: meeting ? await meetingTerms(meeting) : settings.terms,
        tracks,
        ffmpegPath: settings.ffmpegPath,
      },
      onEvent: channel,
    });
    streamStartedAt = Date.now();
    set({ active: true, starting: false });
    saveTimer = setInterval(() => void persist(), SAVE_EVERY_MS);
    // Without an AI key the transcript still works; notes would only fail every minute.
    const aiReady = await hasAiKey().catch(() => false);
    if (aiReady && get().active && !stopping) notesTimer = setInterval(() => void refreshNotes(), NOTES_EVERY_MS);
    void registerHotkey();
    void loadModelOptions();
  } catch (err) {
    set({ starting: false, error: errorMessage(err), tracks: {} });
  }
}

// Ends the session: lets Rust deliver the last words, saves everything.
// Shared promise, so the recording-stop hook and the switch can both await it.
export function stopLive(): Promise<void> {
  if (stopping) return stopping;
  if (!get().active) return Promise.resolve();
  stopping = (async () => {
    try {
      await invoke('live_stop');
    } catch (err) {
      console.warn('live_stop failed', err);
    }
    if (saveTimer) clearInterval(saveTimer);
    if (notesTimer) clearInterval(notesTimer);
    saveTimer = notesTimer = null;
    for (const t of Object.keys(open)) flushTrack(t as LiveTrack);
    if (streamStartedAt != null) streamedMs += Date.now() - streamStartedAt;
    streamStartedAt = null;
    set({ active: false, partials: {} });
    await persist();
    if (transcriptId != null) {
      const costUsd = (streamedMs / 3_600_000) * LIVE_USD_PER_HOUR * Math.max(1, trackCount);
      await db.updateTranscriptStats(transcriptId, { costUsd, languages: languageSummary() }).catch(() => {});
    }
    await unregisterHotkey();
  })().finally(() => {
    stopping = null;
  });
  return stopping;
}

// Runs before the finished recording is imported (see obs.ts).
async function onRecordingStopped(meetingId: number | null): Promise<void> {
  attemptedFor = null;
  if (starting) await starting;
  await stopLive();
  const s = get();
  if (meetingId == null || s.meetingId !== meetingId || transcriptId == null) return;
  const durationMs = Math.max(0, ...s.lines.map((l) => l.endMs));
  set({ afterStop: { meetingId, durationMs } });
  // A last notes pass covers the final minute, then the notes are kept with the meeting.
  void refreshNotes()
    .catch(() => {})
    .then(() => saveNotes(meetingId));
}

async function saveNotes(meetingId: number) {
  const notes = get().notes.trim();
  if (!notes || get().meetingId !== meetingId) return;
  try {
    await db.saveAiDoc({
      scope: 'meeting',
      ownerId: meetingId,
      kind: 'notes',
      content: notes,
      model: get().overrides.live || effectiveModel('live'),
      costUsd: get().aiCostUsd || null,
    });
    emitMeetingChanged(meetingId);
  } catch (err) {
    console.warn('Could not save live notes', err);
  }
}

export function dismissAfterStop(): void {
  set({ afterStop: null });
}

// The switch on the Record screen and in Settings.
export async function setLiveEnabled(on: boolean): Promise<void> {
  attemptedFor = null;
  await useSettings.getState().update({ liveEnabled: on });
}

function maybeAutoStart() {
  const rec = useRecorder.getState();
  if (!getSettings().liveEnabled) {
    if (get().active) void stopLive();
    return;
  }
  if (!rec.recording) {
    attemptedFor = null;
    return;
  }
  // One automatic attempt per recording; after an error the user retries.
  if (rec.recordingMeetingId != null && rec.recordingPath && attemptedFor !== rec.recordingMeetingId) {
    attemptedFor = rec.recordingMeetingId;
    void startLive();
  }
}

export function retryLive(): void {
  attemptedFor = null;
  maybeAutoStart();
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
      // 'full': the transcript goes in the cacheable context block (append-only).
      context: full ? answerContext(lines) : undefined,
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
    set((st) => ({
      notes: text || st.notes,
      notesBusy: false,
      aiCostUsd: st.aiCostUsd + (estimateCost(result.model, result.usage) ?? 0),
    }));
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

// Byte-identical between calls apart from new lines at the end, so providers
// can cache everything said so far.
function answerContext(lines: LiveLine[]): string {
  return `Live transcript so far:\n${formatTranscript(lines.map(toPromptLine))}`;
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
        context: answerContext(s.lines),
        messages: [{ role: 'user', content: latest ? `${ask}\n\nWords still being spoken (not final yet):\n${latest}` : ask }],
        maxTokens: 2000,
        signal: abort.signal,
      },
      { onText: (_delta, text) => update({ text }) },
    );
    lastAnswerModel = result.model;
    lastAnswerAt = Date.now();
    set((st) => ({ aiCostUsd: st.aiCostUsd + (estimateCost(result.model, result.usage) ?? 0) }));
    update({ text: result.text.trim(), busy: false, model: result.model });
  } catch (err) {
    if (abort.signal.aborted) return;
    update({ busy: false, error: errorMessage(err) });
  }
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
// to, or idle for five minutes) pays full price for the whole transcript.
export function answerCostEstimate(model = liveModel('answer')): number | null {
  const lines = get().lines;
  const tokens = roughTokens(answerContext(lines)) + 800; // + system prompt and briefing
  const cached = model === lastAnswerModel && Date.now() - lastAnswerAt < CACHE_TTL_MS;
  return estimateCallCost(model, tokens, ANSWER_OUTPUT_TOKENS, cached);
}

// Expected cost of one notes update in the current mode. In 'full' mode the
// transcript stays cached between the minute-apart updates.
export function notesCostEstimate(model = liveModel('live')): number | null {
  const s = get();
  const fixed = roughTokens(s.notes) + 500; // notes + system prompt
  if (getSettings().liveNotesContext === 'full') {
    const cached = model === lastNotesModel && Date.now() - lastNotesAt < CACHE_TTL_MS;
    const cost = estimateCallCost(model, roughTokens(answerContext(s.lines)), NOTES_OUTPUT_TOKENS, cached);
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
    const { recommended, rest } = sortModels(provider, ids);
    set({ modelOptions: ids.length ? [...recommended, ...rest] : fallback });
  } catch {
    set({ modelOptions: fallback });
  }
}

// ---------- Hotkey ----------

async function registerHotkey() {
  const key = getSettings().liveHotkey.trim();
  if (!key || registeredHotkey === key) return;
  await unregisterHotkey();
  try {
    await register(key, (e) => {
      if (e.state === 'Pressed') void helpMeAnswer();
    });
    registeredHotkey = key;
    set({ hotkeyError: null });
  } catch (err) {
    set({ hotkeyError: `Couldn't register ${key}: ${errorMessage(err)}` });
  }
}

async function unregisterHotkey() {
  if (!registeredHotkey) return;
  const key = registeredHotkey;
  registeredHotkey = null;
  await unregister(key).catch(() => {});
}

// ---------- Overlay window ----------

export const OVERLAY_LABEL = 'overlay';

export async function toggleOverlay(show?: boolean): Promise<void> {
  try {
    const existing = await WebviewWindow.getByLabel(OVERLAY_LABEL);
    if (existing) {
      if (show !== true) {
        await existing.close();
        set({ overlayOpen: false });
      }
      return;
    }
    if (show === false) return;
    const win = new WebviewWindow(OVERLAY_LABEL, {
      url: 'index.html#/overlay',
      title: 'Meeting Helper · Live',
      width: 380,
      height: 520,
      minWidth: 260,
      minHeight: 180,
      alwaysOnTop: true,
      decorations: false,
      resizable: true,
      focus: false,
      contentProtected: getSettings().overlayContentProtected,
    });
    void win.once('tauri://error', (e) => {
      set({ overlayOpen: false });
      toast(`Couldn't open the overlay: ${errorMessage(e.payload)}`, 'error');
    });
    void win.once('tauri://destroyed', () => set({ overlayOpen: false }));
    set({ overlayOpen: true });
  } catch (err) {
    toast(`Couldn't open the overlay: ${errorMessage(err)}`, 'error');
  }
}

export async function setOverlayProtected(on: boolean): Promise<void> {
  await useSettings.getState().update({ overlayContentProtected: on });
  const win = await WebviewWindow.getByLabel(OVERLAY_LABEL);
  await win?.setContentProtected(on).catch(() => {});
}

// ---------- Snapshot broadcast ----------

export function getLiveSnapshot(): LiveSnapshot {
  const s = get();
  const models = { live: liveModel('live'), answer: liveModel('answer') };
  return {
    active: s.active,
    meetingId: s.meetingId,
    error: s.error,
    tracks: s.tracks,
    lines: s.lines.slice(-SNAPSHOT_LINES),
    lineCount: s.lines.length,
    partials: Object.values(s.partials).filter((p): p is LivePartial => !!p),
    notes: s.notes,
    notesBusy: s.notesBusy,
    notesError: s.notesError,
    answer: s.answer,
    models,
    modelOptions: s.modelOptions,
    answerCostEstimate: answerCostEstimate(models.answer),
    notesContext: getSettings().liveNotesContext,
    notesCostEstimate: notesCostEstimate(models.live),
    aiCostUsd: s.aiCostUsd,
    hotkey: getSettings().liveHotkey,
  };
}

let broadcastTimer: ReturnType<typeof setTimeout> | null = null;

function broadcastNow() {
  if (broadcastTimer) clearTimeout(broadcastTimer);
  broadcastTimer = null;
  void emit('live://state', getLiveSnapshot()).catch(() => {});
}

// Provisional text changes several times a second; 5 updates/s is plenty.
function scheduleBroadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(broadcastNow, 200);
}

// ---------- Init ----------

let initialized = false;

// Called once from App.tsx in the main window.
export function initLive(): void {
  if (initialized) return;
  initialized = true;
  setRecordingStopHook(onRecordingStopped);
  useRecorder.subscribe(maybeAutoStart);
  useSettings.subscribe((s, prev) => {
    if (s.settings.liveEnabled !== prev.settings.liveEnabled) maybeAutoStart();
    if (s.settings.liveHotkey !== prev.settings.liveHotkey && get().active) void registerHotkey();
    if (s.settings.aiProvider !== prev.settings.aiProvider) {
      set({ overrides: {}, modelOptions: [] });
      if (get().active) void loadModelOptions();
    }
    scheduleBroadcast();
  });
  useLive.subscribe(scheduleBroadcast);

  void listen('live://hello', broadcastNow);
  void listen('live://help', () => void helpMeAnswer());
  void listen<{ question?: string }>('live://ask', (e) => void helpMeAnswer(e.payload?.question ?? ''));
  void listen<{ task?: LiveAiTask; model?: string; makeDefault?: boolean }>('live://set-model', (e) => {
    const { task, model, makeDefault } = e.payload ?? {};
    if (task === 'live' || task === 'answer') void setLiveModel(task, model ?? '', !!makeDefault);
  });
  maybeAutoStart();
}
