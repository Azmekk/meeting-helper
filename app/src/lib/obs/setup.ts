// OBS configuration for Meeting Helper: the recording output, scenes, and the
// audio track routing the transcription pipeline depends on:
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
import { getSettings, useSettings } from '../settings';
import { getParam, obs, requireConnected, setParam } from './connection';
import { useRecorder, type ObsOutputConfig, type ObsSetup, type SetupCheck } from './store';

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

export const PROFILE_KEYS = {
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

// ---------- Watching OBS ----------

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

// Keeps scenes and the setup checks current as the user changes things in OBS.
export function watchSetup(): void {
  obs.on('CurrentProgramSceneChanged', (e) => set({ currentScene: e.sceneName }));
  obs.on('SceneListChanged', () => void refreshScenes().catch(() => {}));
  obs.on('InputAudioTracksChanged', () => scheduleSetupRefresh());
  obs.on('InputMuteStateChanged', (e) => {
    // Show the mic's mute at once (the app's button, OBS's mixer or a hotkey).
    const setup = get().setup;
    if (setup && e.inputName === setup.micInput) set({ setup: { ...setup, micMuted: e.inputMuted } });
    scheduleSetupRefresh();
  });
  obs.on('InputCreated', () => scheduleSetupRefresh());
  obs.on('InputRemoved', () => scheduleSetupRefresh());
  obs.on('InputNameChanged', () => scheduleSetupRefresh());
  obs.on('CurrentProfileChanged', () => {
    void refreshOutput()
      .then(() => refreshSetup())
      .catch(() => {});
  });
}

// ---------- Output ----------

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

// The scene Meeting Helper sets up for itself. (Older versions made "Meeting";
// users who picked that keep it.)
export const MEETING_SCENE = 'Meeting Helper';
const AUDIO_SCENE = 'Meeting Helper Audio';

// With no scene chosen yet, sets up and selects the Meeting Helper scene. A
// scene the user picked is never replaced. Never throws.
export async function ensureDefaultScene(): Promise<boolean> {
  if (getSettings().obsScene || get().recording) return false;
  try {
    await createMeetingScene({ auto: true });
    return true;
  } catch (err) {
    console.warn('OBS: could not set up the default scene', err);
    return false;
  }
}

// Creates (or reuses) the "Meeting Helper" scene with a display capture of the
// primary monitor and selects it. configureObs then gives it its own mic source
// (and desktop audio if OBS has none) and routes the tracks.
export async function createMeetingScene(opts: { auto?: boolean } = {}): Promise<string> {
  requireConnected();
  const sceneName = MEETING_SCENE;
  const made: string[] = [];
  await refreshScenes();
  if (!get().scenes.includes(sceneName)) {
    await obs.call('CreateScene', { sceneName });
    made.push(`Created scene “${sceneName}”`);
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
      made.push(`Added a capture of your main display (“${inputName}”) to scene “${sceneName}”`);
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
  await configureObs({ auto: !!opts.auto, prior: made });
  return sceneName;
}

// Audio-only recording: an empty scene, so OBS captures no screen. Global audio
// devices play in every scene; sources that live in a scene are added here too,
// or they'd go silent. Returns the scene to go back to afterwards.
export async function switchToAudioScene(): Promise<string | null> {
  const sceneName = AUDIO_SCENE;
  const { currentProgramSceneName: previous } = await obs.call('GetCurrentProgramScene');
  await refreshScenes();
  if (!get().scenes.includes(sceneName)) await obs.call('CreateScene', { sceneName });
  const inputs = await listInputs();
  const { mic, desktop } = await findAudioInputs(inputs);
  const specials = Object.values(await getSpecialInputs());
  const items = (await obs.call('GetSceneItemList', { sceneName })).sceneItems as { sourceName?: string }[];
  for (const sourceName of [mic, desktop]) {
    if (sourceName && !specials.includes(sourceName) && !items.some((i) => i.sourceName === sourceName)) {
      await obs.call('CreateSceneItem', { sceneName, sourceName });
    }
  }
  await obs.call('SetCurrentProgramScene', { sceneName });
  return previous === sceneName ? null : previous;
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

// Mutes the mic source in OBS, so neither the recording nor live transcription
// gets it. It doesn't mute you in the call itself.
export async function setMicMuted(muted: boolean): Promise<void> {
  requireConnected();
  const setup = get().setup ?? (await refreshSetup());
  if (!setup.micInput) throw new Error('No microphone input in OBS.');
  await obs.call('SetInputMute', { inputName: setup.micInput, inputMuted: muted });
  const now = get().setup;
  if (now) set({ setup: { ...now, micMuted: muted } });
}

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

// The global audio devices from OBS → Settings → Audio (desktop1-2, mic1-4).
// They play in every scene.
async function getSpecialInputs(): Promise<Record<string, string | null>> {
  try {
    return (await obs.call('GetSpecialInputs')) as unknown as Record<string, string | null>;
  } catch {
    return {};
  }
}

// Which inputs to route: the mic the user already has (the global Mic/Aux
// first), so the Meeting Helper scene never captures the same mic twice.
async function findAudioInputs(inputs: InputInfo[]): Promise<{
  mic: string | null;
  desktop: string | null;
}> {
  const specials = await getSpecialInputs();
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

// Earlier versions gave the Meeting Helper scene its own mic source, which
// captured the same mic as the user's existing one. Removes those (by their
// name) when another mic exists. Returns the names removed.
async function removeExtraSceneMics(inputs: InputInfo[]): Promise<string[]> {
  const ours = (i: InputInfo) => i.kind === 'wasapi_input_capture' && /^Meeting Helper Mic( \d+)?$/.test(i.name);
  if (!inputs.some((i) => i.kind === 'wasapi_input_capture' && !ours(i))) return [];
  const removed: string[] = [];
  for (const i of inputs.filter(ours)) {
    await obs.call('RemoveInput', { inputName: i.name });
    removed.push(i.name);
  }
  return removed;
}

const NOISE_FILTER_KINDS = ['noise_suppress_filter', 'noise_suppress_filter_v2'];

// RNNoise on the recorded mic. A filter belongs to its source, so on a global
// Mic/Aux device it applies in every scene. Leaves an existing noise filter
// alone. Returns the source if a filter was added.
export async function ensureNoiseSuppression(source?: string | null): Promise<string | null> {
  if (!getSettings().micNoiseSuppression) return null;
  const setup = get().setup;
  const sourceName = source !== undefined ? source : (setup?.micInput ?? null);
  if (!sourceName) return null;
  const r = await obs.call('GetSourceFilterList', { sourceName });
  const filters = r.filters as { filterName?: string; filterKind?: string }[];
  if (filters.some((f) => NOISE_FILTER_KINDS.includes(String(f.filterKind ?? '')))) return null;
  const names = new Set(filters.map((f) => String(f.filterName ?? '')));
  let filterName = 'Noise Suppression';
  for (let n = 2; names.has(filterName); n++) filterName = `Noise Suppression ${n}`;
  await obs.call('CreateSourceFilter', {
    sourceName,
    filterName,
    filterKind: 'noise_suppress_filter_v2',
    filterSettings: { method: 'rnnoise' },
  });
  return sourceName;
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
export async function ensureLiveMuxer(): Promise<void> {
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
    // Neither can be fixed by configureObs, so neither triggers it.
    ok: checks.every((c) => c.ok || c.id === 'live' || c.id === 'doubleMic'),
  };
  set({ setup });
  return setup;
}

// "Configure OBS for Meeting Helper". Idempotent; returns what it changed.
// `prior`: changes already made by the caller (createMeetingScene), for the report.
export async function configureObs(opts: { auto?: boolean; prior?: string[] } = {}): Promise<string[]> {
  requireConnected();
  if (get().recording) throw new Error("OBS can't be reconfigured while recording.");
  configuring = true;
  const changes: string[] = [...(opts.prior ?? [])];
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
    const scene = await targetSceneForInputs();
    const removed = await removeExtraSceneMics(inputs);
    if (removed.length) {
      changes.push(`Removed ${removed.map((n) => `“${n}”`).join(', ')}: it captured the same mic as your existing one`);
      inputs = await listInputs();
    }
    let { mic, desktop } = await findAudioInputs(inputs);
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
    if (mic) {
      try {
        const filtered = await ensureNoiseSuppression(mic);
        if (filtered) changes.push(`Microphone “${filtered}”: added Noise Suppression (RNNoise)`);
      } catch (err) {
        console.warn('OBS: could not add noise suppression', err);
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
