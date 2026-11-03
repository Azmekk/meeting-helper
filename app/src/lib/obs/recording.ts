// A recording's life as a meeting: the 'recording' row made when OBS starts,
// importing the file when it stops (from our button or OBS's own UI), crash
// recovery, recordings started in OBS itself, and pointing OBS's record path at
// the meeting's directory.
import { extname, join } from '@tauri-apps/api/path';
import { exists } from '@tauri-apps/plugin-fs';
import { errorMessage } from '../errors';
import { toast } from '../toast';
import { isInside, rebasePath, samePath } from '../bundle';
import * as db from '../db';
import type { Meeting } from '../types';
import { baseFolder, ensureMeetingDir, moveMeetingToFolder, removeMeetingSidecars, syncMeetingDir } from '../folders';
import * as native from '../native';
import { emitMeetingChanged, ingestMedia } from '../pipeline';
import { getSettings } from '../settings';
import { getParam, obs, requireConnected, setParam } from './connection';
import { offerFinished } from './processing';
import {
  configureObs,
  ensureDefaultScene,
  ensureLiveMuxer,
  ensureNoiseSuppression,
  PROFILE_KEYS,
  refreshOutput,
  refreshSetup,
  switchToAudioScene,
} from './setup';
import { useRecorder } from './store';

const set = useRecorder.setState;
const get = useRecorder.getState;

let recordingWallStart: number | null = null;
const handledPaths = new Set<string>();
// Stopped external recordings the user hasn't answered about yet: never imported automatically.
const heldPaths = new Set<string>();
// Set right before our own StartRecord, so the STARTED event knows the recording is ours.
let appStarting = false;
// This recording keeps only its audio when it's imported.
let audioOnlyRun = false;

export function watchRecording(): void {
  obs.on('RecordStateChanged', (e) => {
    onRecordState(e.outputState, e.outputPath);
  });
}

// After (re)connecting: adopts a recording OBS is already making, or clears
// state from one that ended while we were disconnected. Returns whether OBS is
// recording.
export async function syncRecordStatus(): Promise<boolean> {
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
  // An unanswered external recording that ended unseen: we don't know its file.
  const ext = get().externalRecording;
  if (!status.outputActive && ext && !ext.stopped) set({ externalRecording: null });
  // Undo a record path left pointing at a meeting directory (app closed mid-recording).
  if (!status.outputActive) {
    await restoreRecordPath();
    await restoreScene();
  }
  return !!status.outputActive;
}

// OBS is closed, so any meeting still marked 'recording' will never finish.
export function onObsNotRunning(): void {
  if (staleRowsChecked && get().recordingMeetingId == null) return;
  void reconcileRecordingRows(false).catch((err) => console.warn('Recording cleanup failed', err));
}

// ---------- Recording state ----------

function onRecordState(state: string, outputPath: string | null) {
  const now = Date.now();
  switch (state) {
    case 'OBS_WEBSOCKET_OUTPUT_STARTING':
      set({ busy: 'starting' });
      break;
    case 'OBS_WEBSOCKET_OUTPUT_STARTED': {
      const ours = appStarting || !!preparedRow;
      appStarting = false;
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
      // Started from OBS itself: ask before turning it into a meeting.
      if (ours) createRecordingRow(outputPath);
      else set({ externalRecording: { path: outputPath ?? null, startedAt: now, stopped: false, ignored: false } });
      break;
    }
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
      void restoreScene();
      onRecordingEnded(outputPath);
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
export async function reconcileRecordingRows(obsRecording: boolean) {
  staleRowsChecked = true;
  if (recordingRow) await recordingRow;
  const rows = (await db.listRecordingMeetings()).filter((m) => !finishingIds.has(m.id));
  let keep = obsRecording ? get().recordingMeetingId : null;
  if (obsRecording && keep == null) {
    if (rows[0]) {
      keep = rows[0].id;
      set({ recordingMeetingId: keep, recordingPath: get().recordingPath ?? rows[0].sourcePath });
    } else if (!get().externalRecording) {
      // Recording started while the app was closed: ask whether it's a meeting.
      set({ externalRecording: { path: null, startedAt: get().startedAt ?? Date.now(), stopped: false, ignored: false } });
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
    await offerFinished(m.id);
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
  // Ignored, or an external recording still waiting for an answer.
  if (handledPaths.has(key) || heldPaths.has(key)) return;
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

    const audioOnly = audioOnlyRun;
    audioOnlyRun = false;
    const meetingId = await ingestMedia(file, title, { fromRecording: true, meetingId: row?.id, audioOnly });
    set({ lastIngest: { title, path: file, status: 'done', meetingId } });
    toast(`“${title}” saved to Meetings.`, 'success');
    await offerFinished(meetingId);
  } catch (err) {
    const error = errorMessage(err);
    const where = get().lastIngest?.path ?? path;
    set({ lastIngest: { title, path: where, status: 'error', error } });
    toast(`Couldn't import the recording: ${error}. The file is at ${where}`, 'error');
  } finally {
    if (rowId != null) finishingIds.delete(rowId);
  }
}

// Both the STOPPED event and stopRecording() land here (imports are deduped by path).
function onRecordingEnded(path: string | null) {
  const ext = get().externalRecording;
  if (ext && !ext.stopped) {
    if (ext.ignored) {
      if (path) handledPaths.add(normPath(path));
      set({ externalRecording: null });
      return;
    }
    // Not answered yet: ask about the file instead of importing it.
    const file = path ?? ext.path;
    if (file) heldPaths.add(normPath(file));
    set({ externalRecording: { ...ext, path: file, stopped: true } });
    return;
  }
  if (path) void handleFinishedRecording(path);
}

// ---------- External recordings (started in OBS itself) ----------

// "Track as meeting" (or "Track it" after ignoring it) while it records: from
// here on it's handled like a recording started from the app.
export function trackExternalRecording(): void {
  const ext = get().externalRecording;
  if (!ext || ext.stopped) return;
  const path = ext.path ?? get().recordingPath;
  if (path) handledPaths.delete(normPath(path));
  set({ externalRecording: null });
  if (get().recording) createRecordingRow(path);
}

// "Ignore": OBS keeps recording; stopping it won't import anything.
export function ignoreExternalRecording(): void {
  const ext = get().externalRecording;
  if (!ext || ext.stopped) return;
  if (ext.path) handledPaths.add(normPath(ext.path));
  set({ externalRecording: { ...ext, ignored: true } });
}

// "Import" after it stopped unanswered: the normal finished-recording import.
export async function importExternalRecording(): Promise<void> {
  const ext = get().externalRecording;
  if (!ext?.stopped || !ext.path) return;
  const path = ext.path;
  const key = normPath(path);
  set({ externalRecording: null });
  heldPaths.delete(key);
  if (handledPaths.has(key)) return;
  handledPaths.add(key);

  const title = defaultMeetingTitle(new Date(ext.startedAt));
  set({ lastIngest: { title, path, status: 'processing' } });
  try {
    const meetingId = await ingestMedia(path, title, { fromRecording: true });
    // Same as a row made when OBS started: no directory, but keep the chosen folder.
    const folderId = get().folderId;
    if (folderId != null && baseFolder() && (await db.getFolder(folderId))) {
      await db.setMeetingFolder(meetingId, folderId);
      emitMeetingChanged(meetingId);
    }
    set({ lastIngest: { title, path, status: 'done', meetingId } });
    toast(`“${title}” saved to Meetings.`, 'success');
    await offerFinished(meetingId);
  } catch (err) {
    const error = errorMessage(err);
    set({ lastIngest: { title, path, status: 'error', error } });
    toast(`Couldn't import the recording: ${error}. The file is at ${path}`, 'error');
  }
}

// "Discard": forgets it; the file stays in OBS's recording folder.
export function discardExternalRecording(): void {
  const ext = get().externalRecording;
  if (!ext) return;
  if (ext.path) {
    heldPaths.delete(normPath(ext.path));
    handledPaths.add(normPath(ext.path));
  }
  set({ externalRecording: null });
}

// If OBS never reports the state change (e.g. it showed an error dialog),
// don't leave the buttons spinning forever.
function clearStaleBusy(kind: 'starting' | 'stopping') {
  setTimeout(() => {
    if (get().busy === kind) set({ busy: null });
  }, 10000);
}

export async function startRecording(): Promise<void> {
  requireConnected();
  if (get().recording) return;
  set({ busy: 'starting', error: null });
  try {
    if (!getSettings().obsScene) await ensureDefaultScene();
    // Make sure the track convention holds before every recording.
    if (!get().setup?.ok) {
      await refreshSetup();
      if (!get().setup?.ok) await configureObs({ auto: true });
    }
    // The setting may have been switched on since the last configure.
    await ensureNoiseSuppression().catch((err) => console.warn('OBS: could not add noise suppression', err));
    if (getSettings().liveEnabled) await ensureLiveMuxer();
    const scene = getSettings().obsScene;
    if (scene && get().scenes.includes(scene) && get().currentScene !== scene) {
      await obs.call('SetCurrentProgramScene', { sceneName: scene });
    }
    audioOnlyRun = getSettings().recordAudioOnly;
    if (audioOnlyRun) saveSceneToRestore(await switchToAudioScene());
    await prepareMeetingDir();
    appStarting = true;
    await obs.call('StartRecord');
    clearStaleBusy('starting');
    discardIfNeverStarted();
  } catch (err) {
    appStarting = false;
    audioOnlyRun = false;
    set({ busy: null });
    await discardPreparedRow();
    await restoreRecordPath();
    await restoreScene();
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
      void restoreScene();
      onRecordingEnded(res.outputPath);
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

// ---------- The scene to go back to after an audio-only recording ----------
//
// Kept in localStorage, so a scene left switched by a crash is restored on next
// connect, like the record path below.

const SCENE_RESTORE_KEY = 'obsSceneToRestore';

function saveSceneToRestore(scene: string | null) {
  try {
    if (scene) localStorage.setItem(SCENE_RESTORE_KEY, scene);
    else localStorage.removeItem(SCENE_RESTORE_KEY);
  } catch {
    /* worst case OBS stays on the empty scene after a crash */
  }
}

async function restoreScene(): Promise<void> {
  let scene: string | null = null;
  try {
    scene = localStorage.getItem(SCENE_RESTORE_KEY);
  } catch {
    return;
  }
  if (!scene || !get().connected) return;
  try {
    await obs.call('SetCurrentProgramScene', { sceneName: scene });
  } catch (err) {
    console.warn('Could not switch OBS back to its scene', err);
  }
  saveSceneToRestore(null);
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
  setTimeout(() => {
    if (!get().recording) appStarting = false;
  }, 20000);
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
