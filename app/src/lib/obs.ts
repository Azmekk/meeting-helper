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
// FilePath / RecFormat2 / RecTracks are read when a recording starts. RecQuality,
// RecEncoder, RecType and Mode are only picked up when OBS rebuilds its outputs
// (OBS restart, profile switch, or OK in OBS Settings), so changing them
// through the websocket needs an OBS restart to take effect.
import OBSWebSocket from 'obs-websocket-js';
import { create } from 'zustand';
import { errorMessage, toast } from '../components/ui';
import { ingestMedia } from './pipeline';
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
}

export interface SetupCheck {
  id: 'mic' | 'desktop' | 'others' | 'output';
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
  Simple: { section: 'SimpleOutput', folder: 'FilePath' },
  Advanced: { section: 'AdvOut', folder: 'RecFilePath' },
} as const;

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

  await Promise.all([refreshScenes(), refreshOutput()]);
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
      set({ recording: true, startedAt: now, paused: false, pausedAt: null, busy: null, lastIngest: null });
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
      set({ recording: false, startedAt: null, paused: false, pausedAt: null, busy: null });
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
}

// Imports a finished recording exactly once, whether it was stopped from our
// button or from OBS's own UI.
async function handleFinishedRecording(path: string) {
  const key = path.replace(/\\/g, '/').toLowerCase();
  if (handledPaths.has(key)) return;
  handledPaths.add(key);

  const title = get().title.trim() || defaultMeetingTitle(new Date(recordingWallStart ?? Date.now()));
  recordingWallStart = null;
  set({ title: '', lastIngest: { title, path, status: 'processing' } });

  try {
    const meetingId = await ingestMedia(path, title, { fromRecording: true });
    set({ lastIngest: { title, path, status: 'done', meetingId } });
    toast(`“${title}” saved to Meetings.`, 'success');
  } catch (err) {
    const error = errorMessage(err);
    set({ lastIngest: { title, path, status: 'error', error } });
    toast(`Couldn't import the recording: ${error}. The file is at ${path}`, 'error');
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
    const scene = getSettings().obsScene;
    if (scene && get().scenes.includes(scene) && get().currentScene !== scene) {
      await obs.call('SetCurrentProgramScene', { sceneName: scene });
    }
    await obs.call('StartRecord');
    clearStaleBusy('starting');
  } catch (err) {
    set({ busy: null });
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
      set({ recording: false, startedAt: null, paused: false, pausedAt: null, busy: null });
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
  const { section, folder } = PROFILE_KEYS[mode];
  const [f, format, encoder, tracks, quality, recType] = await Promise.all([
    getParam(section, folder),
    getParam(section, 'RecFormat2'),
    getParam(section, 'RecEncoder'),
    getParam(section, 'RecTracks'),
    mode === 'Simple' ? getParam(section, 'RecQuality') : Promise.resolve(''),
    mode === 'Advanced' ? getParam(section, 'RecType') : Promise.resolve(''),
  ]);
  const output: ObsOutputConfig = {
    mode,
    folder: f ?? '',
    format: format ?? 'mkv',
    encoder: encoder ?? '',
    quality: quality ?? 'Stream',
    recTracks: Number(tracks ?? 1) || 0,
    recType: recType ?? 'Standard',
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
  const setup: ObsSetup = {
    micInput: mic,
    desktopInput: desktop,
    micMuted,
    desktopMuted,
    checks,
    ok: checks.every((c) => c.ok),
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
