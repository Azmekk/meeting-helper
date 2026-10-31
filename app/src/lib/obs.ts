// OBS Studio control over obs-websocket v5.
//
// One module-level connection, so recording state survives moving between
// screens. React reads everything through `useRecorder`.
//
// Audio track convention the transcription pipeline depends on:
//   track 1 = mic + desktop mix, track 2 = mic only, track 3 = desktop only,
// and the recording must write exactly tracks 1-3.
//
// Profile keys (verified against OBS 32 source, frontend/utility/SimpleOutput.cpp
// and AdvancedOutput.cpp, and a real basic.ini):
//   [Output] Mode = Simple | Advanced
//   [SimpleOutput] FilePath, RecFormat2, RecEncoder, RecQuality (Stream|Small|HQ|Lossless),
//                  RecTracks (bitmask; ignored when RecQuality=Stream or RecFormat2=flv)
//   [AdvOut] RecType (Standard|FFmpeg), RecFilePath, RecFormat2, RecEncoder, RecTracks
//   Muxer settings: [SimpleOutput] MuxerCustom, [AdvOut] RecMuxerCustom
//     (space-separated key=value pairs passed to the ffmpeg muxer). The Simple
//     key name is from memory of SimpleOutput.cpp and not yet checked against a
//     real basic.ini; both are read when a recording starts.
// FilePath / RecFormat2 / RecTracks are read when a recording starts. RecQuality,
// RecEncoder, RecType and Mode are only picked up when OBS rebuilds its outputs
// (OBS restart, profile switch, or OK in OBS Settings), so changing them
// through the websocket needs an OBS restart to take effect.
import { extname, join } from '@tauri-apps/api/path';
import { exists } from '@tauri-apps/plugin-fs';
import OBSWebSocket from 'obs-websocket-js';
import { create } from 'zustand';
import { errorMessage, toast } from '../components/ui';
import { isInside, rebasePath, samePath } from './bundle';
import * as db from './db';
import type { Meeting } from './types';
import { baseFolder, ensureMeetingDir, moveMeetingToFolder, removeMeetingSidecars, syncMeetingDir } from './folders';
import * as native from './native';
import { emitMeetingChanged, ingestMedia } from './pipeline';
import { getSecret } from './secrets';
import { getSettings, useSettings } from './settings';

// ---------- Types ----------

export type ObsStatus = 'disconnected' | 'connecting' | 'connected';

export interface ObsOutputConfig {
  mode: 'Simple' | 'Advanced';
  folder: string;
  format: string; // RecFormat2
  encoder: string; // RecEncoder (Simple values like "x264", "nvenc"; Advanced: encoder ids)
  quality: string; // Simple RecQuality; '' in Advanced mode
  recTracks: number; // bitmask
  recType: string; // Advanced RecType; '' in Simple mode
  muxer: string; // custom muxer settings, e.g. "cluster_time_limit=1000"
}

export interface SetupCheck {
  id: 'mic' | 'desktop' | 'others' | 'output' | 'live';
  label: string;
  ok: boolean;
  detail?: string;
}

export interface ObsSetup {
  micInput: string | null;
  desktopInput: string | null;
  micMuted: boolean;
  desktopMuted: boolean;
  checks: SetupCheck[];
  ok: boolean;
}

export interface IngestInfo {
  title: string;
  path: string;
  status: 'processing' | 'done' | 'error';
  meetingId?: number;
  error?: string;
}

export interface RecorderState {
  connected: boolean;
  recording: boolean;
  startedAt: number | null; // Date.now() when recording started (shifted forward by paused time)

  status: ObsStatus;
  error: string | null; // last connection problem, human readable
  obsVersion: string | null;
  paused: boolean;
  pausedAt: number | null;
  busy: 'starting' | 'stopping' | null;
  // Meeting title typed on the Record screen; kept here so it survives navigation.
  title: string;
  // Folder for the next (or current) recording; null = Unsorted. Session-only.
  folderId: number | null;
  // Someone else is at the desk, so the mic isn't just the user: transcribe the
  // mixed track instead of the mic on its own. Resets after each recording.
  othersInRoom: boolean;
  // Vocabulary for this recording only (folder and default lists apply too).
  terms: string[];
  // The 'recording' meetings row for the recording in progress.
  recordingMeetingId: number | null;
  // The file OBS is writing (from the STARTED event); live transcription reads it.
  recordingPath: string | null;
  output: ObsOutputConfig | null;
  setup: ObsSetup | null;
  scenes: string[];
  currentScene: string | null;
  lastConfigure: { changes: string[]; at: number; auto: boolean } | null;
  // Encoder/quality/mode changed while OBS was running; OBS needs a restart.
  restartNeeded: boolean;
  lastIngest: IngestInfo | null;
}

// Lives outside any screen so a recording keeps going (and stays visible in
// the sidebar) while the user moves around the app.
export const useRecorder = create<RecorderState>(() => ({
  connected: false,
  recording: false,
  startedAt: null,

  status: 'disconnected',
  error: null,
  obsVersion: null,
  paused: false,
  pausedAt: null,
  busy: null,
  title: '',
  folderId: null,
  othersInRoom: false,
  terms: [],
  recordingMeetingId: null,
  recordingPath: null,
  output: null,
  setup: null,
  scenes: [],
  currentScene: null,
  lastConfigure: null,
  restartNeeded: false,
  lastIngest: null,
}));

const set = useRecorder.setState;
const get = useRecorder.getState;

// ---------- Option lists (values verified against OBS 32 source) ----------

export const FORMAT_OPTIONS: { value: string; label: string; hint: string }[] = [
  { value: 'mkv', label: 'MKV (recommended)', hint: 'Survives crashes; converted to MP4 automatically afterwards.' },
  { value: 'mp4', label: 'MP4', hint: 'The file is unreadable if OBS or Windows crashes mid-recording.' },
  { value: 'fragmented_mp4', label: 'Fragmented MP4', hint: 'Crash-safe MP4, written in chunks.' },
  { value: 'mov', label: 'MOV', hint: 'QuickTime container; not crash-safe.' },
];

// Simple output mode RecEncoder values (OBSBasic.hpp SIMPLE_ENCODER_*), Windows.
export const SIMPLE_ENCODER_OPTIONS: { value: string; label: string }[] = [
  { value: 'x264', label: 'Software (x264)' },
  { value: 'x264_lowcpu', label: 'Software (x264, low CPU usage)' },
  { value: 'nvenc', label: 'NVIDIA NVENC H.264' },
  { value: 'nvenc_hevc', label: 'NVIDIA NVENC HEVC' },
  { value: 'nvenc_av1', label: 'NVIDIA NVENC AV1' },
  { value: 'qsv', label: 'Intel Quick Sync H.264' },
  { value: 'qsv_av1', label: 'Intel Quick Sync AV1' },
  { value: 'amd', label: 'AMD AMF H.264' },
  { value: 'amd_hevc', label: 'AMD AMF HEVC' },
  { value: 'amd_av1', label: 'AMD AMF AV1' },
];

export const QUALITY_OPTIONS: { value: string; label: string; hint: string }[] = [
  { value: 'Small', label: 'High quality, medium file', hint: 'Plenty for meetings. Roughly 1–3 GB per hour.' },
  { value: 'HQ', label: 'Indistinguishable, large file', hint: 'Visually lossless. Several GB per hour.' },
  {
    value: 'Lossless',
    label: 'Lossless, huge file',
    hint: 'Uncompressed AVI (ignores the container choice). Tens of GB per hour; rarely worth it.',
  },
];

const PROFILE_KEYS = {
  Simple: { section: 'SimpleOutput', folder: 'FilePath', muxer: 'MuxerCustom' },
  Advanced: { section: 'AdvOut', folder: 'RecFilePath', muxer: 'RecMuxerCustom' },
} as const;

// Makes OBS write a Matroska cluster at least every second, so live
// transcription reading the growing file lags by ~1 s instead of ~5 s.
const LIVE_MUXER_KEY = 'cluster_time_limit';
const LIVE_MUXER_VALUE = '1000';

function muxerHasLiveSetting(muxer: string): boolean {
  return muxer.split(/\s+/).some((kv) => kv === `${LIVE_MUXER_KEY}=${LIVE_MUXER_VALUE}`);
}

// Sets our key in a space-separated key=value list, keeping the user's others.
function mergeMuxerSetting(muxer: string): string {
  const parts = muxer.split(/\s+/).filter((kv) => kv && !kv.startsWith(`${LIVE_MUXER_KEY}=`));
  return [...parts, `${LIVE_MUXER_KEY}=${LIVE_MUXER_VALUE}`].join(' ');
}

const RESTART_HINT = 'restart OBS to apply';

// ---------- Connection ----------

const obs = new OBSWebSocket();
let initialized = false;
let manualDisconnect = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 3000;
let autoConfiguredThisSession = false;
let recordingWallStart: number | null = null;
const handledPaths = new Set<string>();

class ObsConnectError extends Error {
  constructor(
    message: string,
    public retry: boolean,
    // Nothing is listening: OBS is closed (so it can't be recording).
    public notRunning = false,
  ) {
    super(message);
  }
}

function describeConnectError(err: unknown, hadPassword: boolean): ObsConnectError {
  const code = typeof err === 'object' && err && 'code' in err ? Number((err as { code: unknown }).code) : NaN;
  if (code === 4009) {
    return new ObsConnectError(
      hadPassword
        ? 'Wrong password. Copy the Server Password again from OBS → Tools → WebSocket Server Settings → Show Connect Info.'
        : 'OBS asks for a password. Paste the Server Password from OBS → Tools → WebSocket Server Settings → Show Connect Info.',
      false,
    );
  }
  if (code === 4010) {
    return new ObsConnectError('This OBS version is too old for Meeting Helper. Install OBS 30 or newer.', false);
  }
  if (code === 4008) {
    return new ObsConnectError('OBS is shutting down.', true);
  }
  const msg = errorMessage(err);
  if (msg === 'timeout') {
    return new ObsConnectError("OBS didn't answer. Check the host and port.", true);
  }
  return new ObsConnectError(
    "OBS isn't running, or its WebSocket server is off (OBS → Tools → WebSocket Server Settings).",
    true,
    true,
  );
}

function clearRetry() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

function scheduleRetry() {
  clearRetry();
  if (manualDisconnect) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void connectObs({ quiet: true });
  }, retryDelay);
  retryDelay = Math.min(Math.round(retryDelay * 1.6), 30000);
}

// Connects using host/port from settings and the stored password, unless a
// password is passed in. Resolves true on success; never throws.
// `quiet`: background attempt; doesn't flip the status badge to "connecting".
let inFlight: Promise<boolean> | null = null;

export async function connectObs(opts: { password?: string; quiet?: boolean } = {}): Promise<boolean> {
  if (inFlight) {
    const ok = await inFlight;
    if (ok || opts.quiet) return ok;
  }
  if (get().connected) return true;
  inFlight = doConnect(opts);
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

async function doConnect(opts: { password?: string; quiet?: boolean }): Promise<boolean> {
  clearRetry();
  manualDisconnect = false;
  if (!opts.quiet) set({ status: 'connecting', error: null });

  const { obsHost, obsPort } = getSettings();
  let password = opts.password;
  if (password === undefined) {
    try {
      password = (await getSecret('obs_password')) ?? '';
    } catch {
      password = '';
    }
  }

  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      obs.connect(`ws://${obsHost || '127.0.0.1'}:${obsPort || 4455}`, password || undefined),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), 8000);
      }),
    ]).finally(() => clearTimeout(timer));
  } catch (err) {
    const e = describeConnectError(err, !!password);
    try {
      await obs.disconnect();
    } catch {
      /* ignore */
    }
    set({ status: 'disconnected', connected: false, error: e.message });
    // OBS is closed, so any meeting still marked 'recording' will never finish.
    if (e.notRunning && (!staleRowsChecked || get().recordingMeetingId != null)) {
      void reconcileRecordingRows(false).catch((err) => console.warn('Recording cleanup failed', err));
    }
    if (e.retry) scheduleRetry();
    return false;
  }

  retryDelay = 3000;
  set({ status: 'connected', connected: true, error: null });
  try {
    await onConnected();
  } catch (err) {
    // Connected, but reading state failed; keep the connection.
    console.warn('OBS: reading state failed', err);
  }
  return true;
}

export async function disconnectObs(): Promise<void> {
  manualDisconnect = true;
  clearRetry();
  try {
    await obs.disconnect();
  } catch {
    /* ignore */
  }
  set({ status: 'disconnected', connected: false, error: null });
}

// Called once at app startup (App.tsx). Tries to connect to OBS quietly in the
// background and keeps retrying with backoff while OBS is closed; never throws.
export function initRecorder(): void {
  if (initialized) return;
  initialized = true;

  obs.on('ConnectionClosed', () => {
    const wasConnected = get().connected;
    set({ connected: false, status: 'disconnected', busy: null });
    if (!wasConnected) return;
    if (!manualDisconnect) {
      // OBS closed (or restarted): pending output changes are applied on its next start.
      set({ restartNeeded: false });
      if (get().recording) {
        // If OBS is still recording, reconnecting restores the state from GetRecordStatus.
        set({
          recording: false,
          startedAt: null,
          paused: false,
          pausedAt: null,
          error:
            'Lost the connection to OBS during a recording. If OBS closed, import the file from its recording folder on the Meetings screen.',
        });
      }
      retryDelay = 3000;
      scheduleRetry();
    }
  });

  obs.on('RecordStateChanged', (e) => {
    onRecordState(e.outputState, e.outputPath);
  });
  obs.on('CurrentProgramSceneChanged', (e) => set({ currentScene: e.sceneName }));
  obs.on('SceneListChanged', () => void refreshScenes().catch(() => {}));
  obs.on('InputAudioTracksChanged', () => scheduleSetupRefresh());
  obs.on('InputMuteStateChanged', () => scheduleSetupRefresh());
  obs.on('InputCreated', () => scheduleSetupRefresh());
  obs.on('InputRemoved', () => scheduleSetupRefresh());
  obs.on('InputNameChanged', () => scheduleSetupRefresh());
  obs.on('CurrentProfileChanged', () => {
    void refreshOutput()
      .then(() => refreshSetup())
      .catch(() => {});
  });

  void connectObs({ quiet: true });
}

let setupRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let configuring = false;
function scheduleSetupRefresh() {
  if (configuring) return;
  if (setupRefreshTimer) clearTimeout(setupRefreshTimer);
  setupRefreshTimer = setTimeout(() => {
    setupRefreshTimer = null;
    void refreshSetup().catch(() => {});
  }, 400);
}

async function onConnected() {
  const version = await obs.call('GetVersion');
  set({ obsVersion: version.obsVersion });

  const status = await obs.call('GetRecordStatus');
  if (status.outputActive) {
    const startedAt = Date.now() - (status.outputDuration ?? 0);
    recordingWallStart ??= startedAt;
    set({
      recording: true,
      startedAt,
      paused: !!status.outputPaused,
      pausedAt: status.outputPaused ? Date.now() : null,
    });
  } else if (get().recording) {
    // Recording ended while we were disconnected; we can't know its file.
    set({ recording: false, startedAt: null, paused: false, pausedAt: null });
  }
  // Undo a record path left pointing at a meeting directory (app closed mid-recording).
  if (!status.outputActive) await restoreRecordPath();

  await Promise.all([refreshScenes(), refreshOutput()]);
  await reconcileRecordingRows(!!status.outputActive).catch((err) => console.warn('Recording cleanup failed', err));
  await refreshSetup();

  const s = get();
  if (!autoConfiguredThisSession && !s.recording && s.setup && !s.setup.ok) {
    autoConfiguredThisSession = true;
    try {
      const changes = await configureObs({ auto: true });
      if (changes.length) toast('Configured OBS for Meeting Helper. See the Record screen for details.', 'info');
    } catch (err) {
      console.warn('OBS: automatic setup failed', err);
    }
  }
}

// ---------- Recording state ----------

function onRecordState(state: string, outputPath: string | null) {
  const now = Date.now();
  switch (state) {
    case 'OBS_WEBSOCKET_OUTPUT_STARTING':
      set({ busy: 'starting' });
      break;
    case 'OBS_WEBSOCKET_OUTPUT_STARTED':
      recordingWallStart = now;
      set({
        recording: true,
        startedAt: now,
        paused: false,
        pausedAt: null,
        busy: null,
        lastIngest: null,
        recordingPath: outputPath ?? null,
      });
      createRecordingRow(outputPath);
      break;
    case 'OBS_WEBSOCKET_OUTPUT_PAUSED':
      set({ paused: true, pausedAt: now });
      break;
    case 'OBS_WEBSOCKET_OUTPUT_RESUMED': {
      const { startedAt, pausedAt } = get();
      set({
        paused: false,
        pausedAt: null,
        startedAt: startedAt != null && pausedAt != null ? startedAt + (now - pausedAt) : startedAt,
      });
      break;
    }
    case 'OBS_WEBSOCKET_OUTPUT_STOPPING':
      set({ busy: 'stopping' });
      break;
    case 'OBS_WEBSOCKET_OUTPUT_STOPPED':
      set({ recording: false, startedAt: null, paused: false, pausedAt: null, busy: null, recordingPath: null });
      void restoreRecordPath();
      if (outputPath) void handleFinishedRecording(outputPath);
      break;
  }
}

export function defaultMeetingTitle(at: Date = new Date()): string {
  const stamp = at.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `Meeting ${stamp}`;
}

export function setRecordingTitle(title: string): void {
  set({ title });
  if (get().recordingMeetingId != null || recordingRow) scheduleTitleSync();
}

// ---------- Meeting row while recording ----------
//
// A meetings row with status 'recording' exists from the moment OBS starts, so
// the meeting shows up in the list right away. handleFinishedRecording fills
// it in; reconcileRecordingRows fails rows whose recording can't finish.

let recordingRow: Promise<number | null> | null = null;
let titleSyncTimer: ReturnType<typeof setTimeout> | null = null;
let staleRowsChecked = false;
const finishingIds = new Set<number>();

const normPath = (p: string) => p.replace(/\\/g, '/').toLowerCase();

function recordingTitle(): string {
  return get().title.trim() || defaultMeetingTitle(new Date(recordingWallStart ?? Date.now()));
}

function createRecordingRow(outputPath: string | null) {
  if (get().recordingMeetingId != null || recordingRow) return;
  if (preparedRow) {
    // startRecording already made the row (and its directory); adopt it.
    const { id } = preparedRow;
    preparedRow = null;
    set({ recordingMeetingId: id });
    void db
      .updateMeeting(id, { sourcePath: outputPath ?? null, title: recordingTitle() })
      .then(() => emitMeetingChanged(id))
      .catch((err) => console.warn('Could not update the recording meeting', err));
    return;
  }
  const pending = insertRecordingRow(outputPath);
  recordingRow = pending;
  void pending.then((id) => {
    // A very short recording may already have been handled by now.
    if (recordingRow !== pending) return;
    recordingRow = null;
    if (id != null) set({ recordingMeetingId: id });
  });
}

async function insertRecordingRow(outputPath: string | null): Promise<number | null> {
  try {
    const id = await db.createMeeting({
      title: recordingTitle(),
      sourcePath: outputPath ?? null,
      mediaPath: null,
      status: 'recording',
    });
    await applyRecordingOptions(id);
    // Started from OBS's own UI: no directory, but keep the chosen folder.
    const folderId = get().folderId;
    if (folderId != null && baseFolder() && (await db.getFolder(folderId))) await db.setMeetingFolder(id, folderId);
    emitMeetingChanged(id);
    return id;
  } catch (err) {
    console.warn('Could not create the meeting for this recording', err);
    return null;
  }
}

function scheduleTitleSync() {
  if (titleSyncTimer) clearTimeout(titleSyncTimer);
  titleSyncTimer = setTimeout(() => {
    titleSyncTimer = null;
    void syncRecordingTitle();
  }, 600);
}

async function syncRecordingTitle() {
  const id = get().recordingMeetingId ?? (await recordingRow);
  if (id == null || get().recordingMeetingId !== id) return;
  try {
    await db.updateMeeting(id, { title: recordingTitle() });
    emitMeetingChanged(id);
  } catch (err) {
    console.warn('Could not update the recording title', err);
  }
}

// Fails meetings stuck in 'recording' whose recording we'll never see finish
// (the app or OBS closed mid-recording). While OBS is still recording, the
// newest such row is adopted as the current one instead.
async function reconcileRecordingRows(obsRecording: boolean) {
  staleRowsChecked = true;
  if (recordingRow) await recordingRow;
  const rows = (await db.listRecordingMeetings()).filter((m) => !finishingIds.has(m.id));
  let keep = obsRecording ? get().recordingMeetingId : null;
  if (obsRecording && keep == null) {
    if (rows[0]) {
      keep = rows[0].id;
      set({ recordingMeetingId: keep, recordingPath: get().recordingPath ?? rows[0].sourcePath });
    } else {
      // Recording started while the app was closed: give it a row now.
      createRecordingRow(null);
    }
  }
  if (!obsRecording && get().recordingMeetingId != null) set({ recordingMeetingId: null, recordingPath: null });

  const folder = get().output?.folder;
  for (const m of rows) {
    if (m.id === keep) continue;
    // OBS kept writing after we died, so the file is usually complete: finish
    // the import a normal stop would have done (the live transcript is lost).
    if (m.sourcePath && !handledPaths.has(normPath(m.sourcePath)) && (await exists(m.sourcePath).catch(() => false))) {
      await recoverRecording(m);
      continue;
    }
    const where = m.sourcePath ?? (folder ? `OBS's recording folder (${folder})` : "OBS's recording folder");
    await db.updateMeeting(m.id, {
      status: 'error',
      error:
        'Meeting Helper or OBS closed during this recording, so it was never processed. ' +
        `The recording may still be at ${where}; import it from the Meetings screen.`,
    });
    emitMeetingChanged(m.id);
  }
}

async function recoverRecording(m: Meeting) {
  const path = m.sourcePath!;
  handledPaths.add(normPath(path));
  finishingIds.add(m.id);
  try {
    const file = await placeRecording(m.id, path);
    const title = (await db.getMeeting(m.id))?.title ?? m.title;
    await ingestMedia(file, title, { fromRecording: true, meetingId: m.id });
    toast(`Recovered “${title}”, which was still recording when Meeting Helper closed.`, 'success');
  } catch (err) {
    // ingestMedia marks the row failed when it can't read the file.
    console.warn('Could not recover the recording', err);
    const row = await db.getMeeting(m.id);
    if (row?.status === 'recording') {
      await db.updateMeeting(m.id, { status: 'error', error: `Couldn't recover this recording: ${errorMessage(err)}` });
      emitMeetingChanged(m.id);
    }
  } finally {
    finishingIds.delete(m.id);
  }
}

async function findRecordingRow(path: string): Promise<number | undefined> {
  const key = normPath(path);
  const rows = await db.listRecordingMeetings();
  return rows.find((m) => m.sourcePath && normPath(m.sourcePath) === key)?.id;
}

// Runs before a finished recording is imported, with the recording's meeting
// id. Live transcription uses it to finish and release the file first (the
// import may delete the .mkv). Registered by live.ts to avoid an import cycle.
type StopHook = (meetingId: number | null) => Promise<void>;
let recordingStopHook: StopHook | null = null;
export function setRecordingStopHook(fn: StopHook | null): void {
  recordingStopHook = fn;
}

// Imports a finished recording exactly once, whether it was stopped from our
// button or from OBS's own UI.
async function handleFinishedRecording(path: string) {
  const key = normPath(path);
  if (handledPaths.has(key)) return;
  handledPaths.add(key);

  // A title typed on the Record screen wins; otherwise keep the row's title
  // (the user may have renamed the meeting elsewhere while recording).
  const typed = get().title.trim();
  const known = get().recordingMeetingId;
  const pending = recordingRow;
  let title = typed || defaultMeetingTitle(new Date(recordingWallStart ?? Date.now()));
  if (titleSyncTimer) clearTimeout(titleSyncTimer);
  titleSyncTimer = null;
  recordingRow = null;
  recordingWallStart = null;
  set({ title: '', othersInRoom: false, terms: [], recordingMeetingId: null, lastIngest: { title, path, status: 'processing' } });

  let rowId: number | undefined;
  try {
    rowId = known ?? (await pending) ?? (await findRecordingRow(path));
    if (rowId != null) finishingIds.add(rowId);
    if (recordingStopHook) {
      await recordingStopHook(rowId ?? null).catch((err) => console.warn('Live transcription did not stop cleanly', err));
    }
    let file = path;
    if (rowId != null) {
      file = await placeRecording(rowId, path);
      if (file !== path) set({ lastIngest: { title, path: file, status: 'processing' } });
    }
    const row = rowId != null ? await db.getMeeting(rowId) : null;
    if (!typed && row?.title) {
      title = row.title;
      set({ lastIngest: { title, path: file, status: 'processing' } });
    }

    const meetingId = await ingestMedia(file, title, { fromRecording: true, meetingId: row?.id });
    set({ lastIngest: { title, path: file, status: 'done', meetingId } });
    toast(`“${title}” saved to Meetings.`, 'success');
  } catch (err) {
    const error = errorMessage(err);
    const where = get().lastIngest?.path ?? path;
    set({ lastIngest: { title, path: where, status: 'error', error } });
    toast(`Couldn't import the recording: ${error}. The file is at ${where}`, 'error');
  } finally {
    if (rowId != null) finishingIds.delete(rowId);
  }
}

// If OBS never reports the state change (e.g. it showed an error dialog),
// don't leave the buttons spinning forever.
function clearStaleBusy(kind: 'starting' | 'stopping') {
  setTimeout(() => {
    if (get().busy === kind) set({ busy: null });
  }, 10000);
}

function requireConnected() {
  if (!get().connected) throw new Error("Not connected to OBS.");
}

export async function startRecording(): Promise<void> {
  requireConnected();
  if (get().recording) return;
  set({ busy: 'starting', error: null });
  try {
    // Make sure the track convention holds before every recording.
    if (!get().setup?.ok) {
      await refreshSetup();
      if (!get().setup?.ok) await configureObs({ auto: true });
    }
    if (getSettings().liveEnabled) await ensureLiveMuxer();
    const scene = getSettings().obsScene;
    if (scene && get().scenes.includes(scene) && get().currentScene !== scene) {
      await obs.call('SetCurrentProgramScene', { sceneName: scene });
    }
    await prepareMeetingDir();
    await obs.call('StartRecord');
    clearStaleBusy('starting');
    discardIfNeverStarted();
  } catch (err) {
    set({ busy: null });
    await discardPreparedRow();
    await restoreRecordPath();
    throw err;
  }
}

export async function stopRecording(): Promise<void> {
  requireConnected();
  set({ busy: 'stopping' });
  try {
    const res = await obs.call('StopRecord');
    clearStaleBusy('stopping');
    // The RecordStateChanged event normally handles this; deduped either way.
    if (res.outputPath) {
      set({ recording: false, startedAt: null, paused: false, pausedAt: null, busy: null, recordingPath: null });
      void restoreRecordPath();
      void handleFinishedRecording(res.outputPath);
    }
  } catch (err) {
    set({ busy: null });
    throw err;
  }
}

export async function pauseRecording(): Promise<void> {
  requireConnected();
  await obs.call('PauseRecord');
}

export async function resumeRecording(): Promise<void> {
  requireConnected();
  await obs.call('ResumeRecord');
}

// ---------- Recording into the meeting's directory ----------
//
// With a base folder set, startRecording creates the meeting row and its
// directory first and points OBS's record path there (OBS reads it at start).
// The user's own path is restored when the recording stops. It's also kept in
// localStorage, so a path left behind by a crash is restored on next connect.

const PATH_OVERRIDE_KEY = 'obsRecordPathOverride';

interface PathOverride {
  section: string;
  name: string;
  original: string; // the user's record path
  dir: string; // what we set it to
}

// The row startRecording made, until the STARTED event adopts it.
let preparedRow: { id: number; dir: string | null } | null = null;

function loadOverride(): PathOverride | null {
  try {
    const raw = localStorage.getItem(PATH_OVERRIDE_KEY);
    return raw ? (JSON.parse(raw) as PathOverride) : null;
  } catch {
    return null;
  }
}

function saveOverride(o: PathOverride | null) {
  try {
    if (o) localStorage.setItem(PATH_OVERRIDE_KEY, JSON.stringify(o));
    else localStorage.removeItem(PATH_OVERRIDE_KEY);
  } catch {
    /* worst case the path isn't restored after a crash */
  }
}

// Puts the user's record path back, unless they changed it in OBS since.
let restoring: Promise<void> | null = null;
function restoreRecordPath(): Promise<void> {
  restoring ??= (async () => {
    const o = loadOverride();
    if (!o || !get().connected) return;
    try {
      const current = (await getParam(o.section, o.name)) ?? '';
      const root = baseFolder();
      if (samePath(current, o.dir) || (root && isInside(current, root))) await setParam(o.section, o.name, o.original);
      saveOverride(null);
      await refreshOutput();
    } catch (err) {
      console.warn('Could not restore the OBS recording path', err);
    }
  })().finally(() => {
    restoring = null;
  });
  return restoring;
}

async function prepareMeetingDir(): Promise<void> {
  if (!baseFolder()) return;
  await discardPreparedRow();
  await restoreRecordPath();
  const out = await refreshOutput();
  const { section, folder: name } = PROFILE_KEYS[out.mode];

  let folderId = get().folderId;
  if (folderId != null && !(await db.getFolder(folderId))) {
    folderId = null;
    set({ folderId });
  }
  const id = await db.createMeeting({ title: recordingTitle(), sourcePath: null, mediaPath: null, status: 'recording' });
  preparedRow = { id, dir: null };
  await applyRecordingOptions(id);
  if (folderId != null) await db.setMeetingFolder(id, folderId);
  const dir = await ensureMeetingDir(id);
  if (!dir) throw new Error('Could not create the meeting folder.');
  preparedRow.dir = dir;
  emitMeetingChanged(id);

  const prev = loadOverride();
  const original = prev && prev.section === section && prev.name === name ? prev.original : out.folder;
  saveOverride({ section, name, original, dir });
  await setParam(section, name, dir);
}

// Deletes the row (and empty directory) made for a recording that didn't start.
async function discardPreparedRow(): Promise<void> {
  const p = preparedRow;
  if (!p) return;
  preparedRow = null;
  try {
    await db.deleteMeeting(p.id);
    emitMeetingChanged(p.id);
    if (p.dir) await removeMeetingSidecars({ dirPath: p.dir });
  } catch (err) {
    console.warn('Could not remove the unused meeting', err);
  }
}

// StartRecord succeeded but OBS never reported STARTED (e.g. it showed an error).
function discardIfNeverStarted() {
  const id = preparedRow?.id;
  if (id == null) return;
  setTimeout(() => {
    if (preparedRow?.id !== id || get().recording) return;
    void discardPreparedRow().then(() => restoreRecordPath());
  }, 20000);
}

// After the recording stops: moves the meeting directory if its folder changed
// while recording, and names the file recording.<ext> (the bundle layout).
// Returns where the recording is now; never throws.
async function placeRecording(meetingId: number, path: string): Promise<string> {
  let file = path;
  try {
    const before = await db.getMeeting(meetingId);
    if (!before?.dirPath || !baseFolder() || !isInside(path, before.dirPath)) return path;
    await syncMeetingDir(meetingId);
    const after = await db.getMeeting(meetingId);
    const dir = after?.dirPath ?? before.dirPath;
    file = rebasePath(path, before.dirPath, dir) ?? path;
    const ext = await extname(file).catch(() => '');
    const target = await join(dir, ext ? `recording.${ext}` : 'recording');
    if (!samePath(target, file) && !(await exists(target))) {
      await native.movePath(file, target);
      file = target;
      await db.updateMeeting(meetingId, { sourcePath: file });
    }
  } catch (err) {
    console.warn('Could not move the recording into its folder', err);
  }
  return file;
}

// Folder picker on the Record screen. During a recording it moves the meeting
// (its files follow when the recording stops).
export async function setRecordingFolder(folderId: number | null): Promise<void> {
  set({ folderId });
  const id = get().recordingMeetingId ?? preparedRow?.id ?? null;
  if (id != null) await moveMeetingToFolder(id, folderId);
}

// Record-screen choices made before the meeting row existed.
async function applyRecordingOptions(id: number) {
  const { othersInRoom, terms } = get();
  if (othersInRoom || terms.length) {
    await db.updateMeeting(id, { ...(othersInRoom ? { splitTracks: false } : {}), terms });
  }
}

// Mid-recording changes reach the batch transcript; live transcription keeps
// the vocabulary it started with.
export async function setRecordingTerms(terms: string[]): Promise<void> {
  set({ terms });
  const id = get().recordingMeetingId ?? preparedRow?.id ?? null;
  if (id == null) return;
  await db.updateMeeting(id, { terms });
  emitMeetingChanged(id);
}

// Applies to the batch transcript even mid-recording; live transcription keeps
// the tracks it started with.
export async function setOthersInRoom(othersInRoom: boolean): Promise<void> {
  set({ othersInRoom });
  const id = get().recordingMeetingId ?? preparedRow?.id ?? null;
  if (id == null) return;
  await db.updateMeeting(id, { splitTracks: othersInRoom ? false : null });
  emitMeetingChanged(id);
}

// ---------- Profile parameters ----------

async function getParam(section: string, name: string): Promise<string | null> {
  const r = await obs.call('GetProfileParameter', { parameterCategory: section, parameterName: name });
  return r.parameterValue ?? r.defaultParameterValue ?? null;
}

async function setParam(section: string, name: string, value: string): Promise<void> {
  await obs.call('SetProfileParameter', { parameterCategory: section, parameterName: name, parameterValue: value });
}

export async function refreshOutput(): Promise<ObsOutputConfig> {
  const mode = (await getParam('Output', 'Mode'))?.toLowerCase() === 'advanced' ? 'Advanced' : 'Simple';
  const { section, folder, muxer: muxerKey } = PROFILE_KEYS[mode];
  const [f, format, encoder, tracks, quality, recType, muxer] = await Promise.all([
    getParam(section, folder),
    getParam(section, 'RecFormat2'),
    getParam(section, 'RecEncoder'),
    getParam(section, 'RecTracks'),
    mode === 'Simple' ? getParam(section, 'RecQuality') : Promise.resolve(''),
    mode === 'Advanced' ? getParam(section, 'RecType') : Promise.resolve(''),
    getParam(section, muxerKey),
  ]);
  const output: ObsOutputConfig = {
    mode,
    folder: f ?? '',
    format: format ?? 'mkv',
    encoder: encoder ?? '',
    quality: quality ?? 'Stream',
    recTracks: Number(tracks ?? 1) || 0,
    recType: recType ?? 'Standard',
    muxer: muxer ?? '',
  };
  set({ output });
  return output;
}

export type OutputField = 'folder' | 'format' | 'encoder' | 'quality';

// Writes one output setting back to the OBS profile.
export async function setOutputOption(field: OutputField, value: string): Promise<void> {
  requireConnected();
  if (get().recording) throw new Error("Output settings can't change while recording.");
  const out = get().output ?? (await refreshOutput());
  const { section, folder } = PROFILE_KEYS[out.mode];
  const name = { folder, format: 'RecFormat2', encoder: 'RecEncoder', quality: 'RecQuality' }[field];
  if (field === 'quality' && out.mode !== 'Simple') return;
  const before = { folder: out.folder, format: out.format, encoder: out.encoder, quality: out.quality }[field];
  if (before === value) return;
  await setParam(section, name, value);
  if (field === 'encoder' || field === 'quality') set({ restartNeeded: true });
  await refreshOutput();
  await refreshSetup();
}

// ---------- Scenes ----------

export async function refreshScenes(): Promise<void> {
  const r = await obs.call('GetSceneList');
  // OBS lists scenes bottom-up; show them in the same order as OBS's Scenes dock.
  const scenes = (r.scenes as { sceneName?: string }[])
    .map((s) => String(s.sceneName ?? ''))
    .filter(Boolean)
    .reverse();
  set({ scenes, currentScene: r.currentProgramSceneName ?? null });
}

export async function selectScene(name: string): Promise<void> {
  requireConnected();
  await useSettings.getState().update({ obsScene: name });
  if (name && get().currentScene !== name) {
    await obs.call('SetCurrentProgramScene', { sceneName: name });
    set({ currentScene: name });
  }
}

// Creates (or reuses) a "Meeting" scene with a display capture of the primary
// monitor, adds audio inputs if OBS has none, and selects it.
export async function createMeetingScene(): Promise<string> {
  requireConnected();
  const sceneName = 'Meeting';
  await refreshScenes();
  if (!get().scenes.includes(sceneName)) {
    await obs.call('CreateScene', { sceneName });
  }

  const items = await obs.call('GetSceneItemList', { sceneName });
  const inputs = await listInputs();
  const hasDisplay = (items.sceneItems as { inputKind?: string }[]).some((i) => i.inputKind === 'monitor_capture');
  if (!hasDisplay) {
    const existing = inputs.find((i) => i.kind === 'monitor_capture');
    if (existing) {
      await obs.call('CreateSceneItem', { sceneName, sourceName: existing.name });
    } else {
      const inputName = uniqueName('Screen', inputs);
      await obs.call('CreateInput', { sceneName, inputName, inputKind: 'monitor_capture', inputSettings: {} });
      await pickPrimaryMonitor(inputName);
      // Fit the capture to the canvas.
      try {
        const { sceneItemId } = await obs.call('GetSceneItemId', { sceneName, sourceName: inputName });
        const video = await obs.call('GetVideoSettings');
        await obs.call('SetSceneItemTransform', {
          sceneName,
          sceneItemId,
          sceneItemTransform: {
            boundsType: 'OBS_BOUNDS_SCALE_INNER',
            boundsWidth: video.baseWidth,
            boundsHeight: video.baseHeight,
            boundsAlignment: 0,
            positionX: 0,
            positionY: 0,
          },
        });
      } catch {
        /* cosmetic */
      }
    }
  }

  await obs.call('SetCurrentProgramScene', { sceneName });
  await useSettings.getState().update({ obsScene: sceneName });
  await refreshScenes();
  // Audio inputs are created in the program scene by configureObs if missing.
  await configureObs({ auto: false });
  return sceneName;
}

async function pickPrimaryMonitor(inputName: string) {
  try {
    const r = await obs.call('GetInputPropertiesListPropertyItems', { inputName, propertyName: 'monitor_id' });
    const items = (r.propertyItems as { itemName?: string; itemValue?: unknown; itemEnabled?: boolean }[]).filter(
      (i) => typeof i.itemValue === 'string' && i.itemValue !== 'DUMMY' && i.itemEnabled !== false,
    );
    const pick =
      items.find((i) => /primary/i.test(i.itemName ?? '')) ??
      items.find((i) => /@ 0,0$/.test(i.itemName ?? '')) ??
      items[0];
    if (pick) await obs.call('SetInputSettings', { inputName, inputSettings: { monitor_id: pick.itemValue as string } });
  } catch {
    /* the user can pick the display in OBS */
  }
}

// ---------- Audio track setup ----------

interface InputInfo {
  name: string;
  kind: string;
}

async function listInputs(): Promise<InputInfo[]> {
  const r = await obs.call('GetInputList');
  return (r.inputs as { inputName?: string; unversionedInputKind?: string; inputKind?: string }[]).map((i) => ({
    name: String(i.inputName ?? ''),
    kind: String(i.unversionedInputKind || i.inputKind || ''),
  }));
}

function uniqueName(base: string, inputs: InputInfo[]): string {
  const names = new Set(inputs.map((i) => i.name));
  if (!names.has(base)) return base;
  for (let n = 2; ; n++) if (!names.has(`${base} ${n}`)) return `${base} ${n}`;
}

type Tracks = Record<string, boolean>;

const MIC_TRACKS: Tracks = { '1': true, '2': true, '3': false, '4': false, '5': false, '6': false };
const DESKTOP_TRACKS: Tracks = { '1': true, '2': false, '3': true, '4': false, '5': false, '6': false };

function tracksMatch(actual: Tracks | null, want: Tracks): boolean {
  if (!actual) return false;
  return Object.keys(want).every((k) => !!actual[k] === want[k]);
}

function describeTracks(t: Tracks | null): string {
  if (!t) return 'none';
  const on = Object.keys(t)
    .filter((k) => t[k])
    .sort();
  return on.length ? on.join(' + ') : 'none';
}

async function getTracks(inputName: string): Promise<Tracks | null> {
  try {
    const r = await obs.call('GetInputAudioTracks', { inputName });
    return r.inputAudioTracks as Tracks;
  } catch {
    return null; // not an audio input
  }
}

async function getMuted(inputName: string): Promise<boolean> {
  try {
    return (await obs.call('GetInputMute', { inputName })).inputMuted;
  } catch {
    return false;
  }
}

async function findAudioInputs(inputs: InputInfo[]): Promise<{ mic: string | null; desktop: string | null }> {
  let specials: Record<string, string | null> = {};
  try {
    specials = (await obs.call('GetSpecialInputs')) as unknown as Record<string, string | null>;
  } catch {
    /* ignore */
  }
  const names = new Set(inputs.map((i) => i.name));
  const desktop =
    (specials.desktop1 && names.has(specials.desktop1) ? specials.desktop1 : null) ??
    inputs.find((i) => i.kind === 'wasapi_output_capture')?.name ??
    null;
  const mic =
    (specials.mic1 && names.has(specials.mic1) ? specials.mic1 : null) ??
    inputs.find((i) => i.kind === 'wasapi_input_capture')?.name ??
    null;
  return { mic, desktop };
}

function outputOk(out: ObsOutputConfig): { ok: boolean; detail?: string } {
  if (out.format === 'flv') return { ok: false, detail: 'FLV can only hold one audio track.' };
  if (out.mode === 'Simple' && out.quality === 'Stream')
    return { ok: false, detail: 'Quality “Same as stream” records only one audio track.' };
  if (out.mode === 'Advanced' && out.recType !== 'Standard')
    return { ok: false, detail: 'Advanced output uses a custom FFmpeg recording.' };
  if (out.recTracks !== 7) {
    const on = [1, 2, 3, 4, 5, 6].filter((n) => out.recTracks & (1 << (n - 1)));
    return { ok: false, detail: `Currently records track${on.length === 1 ? '' : 's'} ${on.join(', ') || 'none'}.` };
  }
  return { ok: true };
}

// Recordings started outside "Configure OBS" still get the live muxer setting.
async function ensureLiveMuxer(): Promise<void> {
  const out = await refreshOutput();
  if (muxerHasLiveSetting(out.muxer)) return;
  await setParam(PROFILE_KEYS[out.mode].section, PROFILE_KEYS[out.mode].muxer, mergeMuxerSetting(out.muxer));
  await refreshOutput();
}

function liveOk(out: ObsOutputConfig): { ok: boolean; detail?: string } {
  if (out.format !== 'mkv') return { ok: false, detail: 'Live transcription needs the MKV container.' };
  if (!muxerHasLiveSetting(out.muxer))
    return {
      ok: false,
      detail: `Muxer setting ${LIVE_MUXER_KEY}=${LIVE_MUXER_VALUE} is missing, so live text would lag by several seconds.`,
    };
  return { ok: true };
}

export async function refreshSetup(): Promise<ObsSetup> {
  const inputs = await listInputs();
  const { mic, desktop } = await findAudioInputs(inputs);
  const [micTracks, deskTracks, micMuted, desktopMuted] = await Promise.all([
    mic ? getTracks(mic) : null,
    desktop ? getTracks(desktop) : null,
    mic ? getMuted(mic) : false,
    desktop ? getMuted(desktop) : false,
  ]);

  const rest = inputs.filter((i) => i.name !== mic && i.name !== desktop);
  const restTracks = await Promise.all(rest.map((i) => getTracks(i.name)));
  const others = rest.filter((_, n) => {
    const t = restTracks[n];
    return !!t && (t['2'] || t['3']);
  }).map((i) => i.name);

  const out = get().output ?? (await refreshOutput());
  const o = outputOk(out);

  const checks: SetupCheck[] = [
    {
      id: 'mic',
      label: 'Microphone on tracks 1 and 2',
      ok: !!mic && tracksMatch(micTracks, MIC_TRACKS),
      detail: mic ? `“${mic}” is on track ${describeTracks(micTracks)}.` : 'No microphone input in OBS.',
    },
    {
      id: 'desktop',
      label: 'Desktop audio on tracks 1 and 3',
      ok: !!desktop && tracksMatch(deskTracks, DESKTOP_TRACKS),
      detail: desktop ? `“${desktop}” is on track ${describeTracks(deskTracks)}.` : 'No desktop audio input in OBS.',
    },
    {
      id: 'others',
      label: 'Nothing else on tracks 2 and 3',
      ok: others.length === 0,
      detail: others.length ? `Also on tracks 2/3: ${others.join(', ')}.` : undefined,
    },
    {
      id: 'output',
      label: 'Recording writes audio tracks 1–3',
      ok: o.ok,
      detail: o.detail,
    },
  ];
  // Only shown with live transcription on; it doesn't block recording.
  if (getSettings().liveEnabled) checks.push({ id: 'live', label: 'Ready for live transcription', ...liveOk(out) });
  const setup: ObsSetup = {
    micInput: mic,
    desktopInput: desktop,
    micMuted,
    desktopMuted,
    checks,
    ok: checks.every((c) => c.ok || c.id === 'live'),
  };
  set({ setup });
  return setup;
}

// "Configure OBS for Meeting Helper". Idempotent; returns what it changed.
export async function configureObs(opts: { auto?: boolean } = {}): Promise<string[]> {
  requireConnected();
  if (get().recording) throw new Error("OBS can't be reconfigured while recording.");
  configuring = true;
  const changes: string[] = [];
  try {
    // 1. Output: record tracks 1-3.
    const out = await refreshOutput();
    const { section } = PROFILE_KEYS[out.mode];
    if (out.mode === 'Simple' && (out.quality === 'Stream' || !out.quality)) {
      await setParam(section, 'RecQuality', 'Small');
      set({ restartNeeded: true });
      changes.push(`Recording quality: “High quality, medium file” (was “Same as stream”, which records one track) — ${RESTART_HINT}`);
    }
    if (out.mode === 'Advanced' && out.recType !== 'Standard') {
      await setParam(section, 'RecType', 'Standard');
      set({ restartNeeded: true });
      changes.push(`Recording type: Standard (was ${out.recType || 'custom'}) — ${RESTART_HINT}`);
    }
    if (out.format === 'flv') {
      await setParam(section, 'RecFormat2', 'mkv');
      changes.push('Recording format: MKV (FLV holds only one audio track)');
    }
    if (out.recTracks !== 7) {
      await setParam(section, 'RecTracks', '7');
      changes.push(`Recorded audio tracks: 1, 2, 3 (was ${describeMask(out.recTracks)})`);
    }
    // Harmless for normal recordings; OBS reads it when each recording starts.
    if (!muxerHasLiveSetting(out.muxer)) {
      await setParam(section, PROFILE_KEYS[out.mode].muxer, mergeMuxerSetting(out.muxer));
      changes.push(`Muxer settings: ${LIVE_MUXER_KEY}=${LIVE_MUXER_VALUE} (lets live transcription follow the recording closely)`);
    }

    // 2. Audio inputs: create if missing, then route to tracks.
    let inputs = await listInputs();
    let { mic, desktop } = await findAudioInputs(inputs);
    const scene = await targetSceneForInputs();
    if (!desktop && scene) {
      const inputName = uniqueName('Desktop Audio', inputs);
      await obs.call('CreateInput', {
        sceneName: scene,
        inputName,
        inputKind: 'wasapi_output_capture',
        inputSettings: { device_id: 'default' },
      });
      desktop = inputName;
      changes.push(`Created desktop audio input “${inputName}” (default speakers) in scene “${scene}”`);
      inputs = await listInputs();
    }
    if (!mic && scene) {
      const inputName = uniqueName('Mic', inputs);
      await obs.call('CreateInput', {
        sceneName: scene,
        inputName,
        inputKind: 'wasapi_input_capture',
        inputSettings: { device_id: 'default' },
      });
      mic = inputName;
      changes.push(`Created microphone input “${inputName}” (default mic) in scene “${scene}”`);
      inputs = await listInputs();
    }

    if (mic) {
      const t = await getTracks(mic);
      if (!tracksMatch(t, MIC_TRACKS)) {
        await obs.call('SetInputAudioTracks', { inputName: mic, inputAudioTracks: MIC_TRACKS });
        changes.push(`Microphone “${mic}”: tracks 1 + 2 (was ${describeTracks(t)})`);
      }
    }
    if (desktop) {
      const t = await getTracks(desktop);
      if (!tracksMatch(t, DESKTOP_TRACKS)) {
        await obs.call('SetInputAudioTracks', { inputName: desktop, inputAudioTracks: DESKTOP_TRACKS });
        changes.push(`Desktop audio “${desktop}”: tracks 1 + 3 (was ${describeTracks(t)})`);
      }
    }

    // 3. Keep tracks 2 and 3 clean: other audio sources stay on the mix only.
    for (const i of inputs) {
      if (i.name === mic || i.name === desktop) continue;
      const t = await getTracks(i.name);
      if (t && (t['2'] || t['3'])) {
        await obs.call('SetInputAudioTracks', { inputName: i.name, inputAudioTracks: { '2': false, '3': false } });
        changes.push(`“${i.name}”: removed from tracks 2 and 3`);
      }
    }
  } finally {
    configuring = false;
  }

  set({ lastConfigure: { changes, at: Date.now(), auto: !!opts.auto } });
  await refreshOutput();
  await refreshSetup();
  return changes;
}

function describeMask(mask: number): string {
  const on = [1, 2, 3, 4, 5, 6].filter((n) => mask & (1 << (n - 1)));
  return on.length ? on.join(', ') : 'none';
}

async function targetSceneForInputs(): Promise<string | null> {
  await refreshScenes();
  const { scenes, currentScene } = get();
  const wanted = getSettings().obsScene;
  if (wanted && scenes.includes(wanted)) return wanted;
  return currentScene ?? scenes[0] ?? null;
}
