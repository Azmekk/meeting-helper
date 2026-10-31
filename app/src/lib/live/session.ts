// Starting and stopping live transcription with the recording: live_start /
// live_stop in Rust (live.rs), the save and notes timers, and the hotkey.
import { Channel, invoke } from '@tauri-apps/api/core';
import { register, unregister } from '@tauri-apps/plugin-global-shortcut';
import { errorMessage } from '../errors';
import { hasAiKey } from '../ai/meeting';
import * as db from '../db';
import { offerProcessing, useRecorder } from '../obs';
import { getSecret } from '../secrets';
import { meetingTerms } from '../terms';
import { getSettings, useSettings } from '../settings';
import { helpMeAnswer, loadModelOptions, refreshNotes, resetAi, saveNotes } from './ai';
import { INITIAL, useLive, type LiveEvent, type LiveTrack } from './store';
import {
  flushOpenLines,
  hasSavedTranscript,
  LIVE_MODEL,
  onTokens,
  persist,
  resetTranscript,
  saveTranscriptStats,
} from './transcript';

const set = useLive.setState;
const get = useLive.getState;

// Soniox real-time list price per audio hour (per track), for the cost shown on the transcript.
const LIVE_USD_PER_HOUR = 0.12;
const SAVE_EVERY_MS = 4000;
const NOTES_EVERY_MS = 60_000;

let streamedMs = 0; // audio streamed per track, summed over start/stop within the meeting
let streamStartedAt: number | null = null;
let trackCount = 0;
let saveTimer: ReturnType<typeof setInterval> | null = null;
let notesTimer: ReturnType<typeof setInterval> | null = null;
let stopping: Promise<void> | null = null;
let attemptedFor: number | null = null;
let registeredHotkey: string | null = null;

function resetMeeting(meetingId: number) {
  resetTranscript();
  resetAi();
  streamedMs = 0;
  set({ ...INITIAL, meetingId, overlayOpen: get().overlayOpen });
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
  set({ starting: true, error: null });

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
    flushOpenLines();
    if (streamStartedAt != null) streamedMs += Date.now() - streamStartedAt;
    streamStartedAt = null;
    set({ active: false, partials: {} });
    await persist();
    await saveTranscriptStats((streamedMs / 3_600_000) * LIVE_USD_PER_HOUR * Math.max(1, trackCount));
    await unregisterHotkey();
  })().finally(() => {
    stopping = null;
  });
  return stopping;
}

// Runs before the finished recording is imported (see obs/recording.ts).
export async function onRecordingStopped(meetingId: number | null): Promise<void> {
  attemptedFor = null;
  if (starting) await starting;
  await stopLive();
  const s = get();
  if (meetingId == null || s.meetingId !== meetingId || !hasSavedTranscript()) return;
  const durationMs = Math.max(0, ...s.lines.map((l) => l.endMs));
  // Asked right away; the dialog waits for the import to finish.
  offerProcessing({ meetingId, durationMs, live: true });
  // A last notes pass covers the final minute, then the notes are kept with the meeting.
  void refreshNotes()
    .catch(() => {})
    .then(() => saveNotes(meetingId));
}

// The switch on the Record screen and in Settings.
export async function setLiveEnabled(on: boolean): Promise<void> {
  attemptedFor = null;
  await useSettings.getState().update({ liveEnabled: on });
}

export function maybeAutoStart() {
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

// ---------- Hotkey ----------

export async function registerHotkey() {
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
