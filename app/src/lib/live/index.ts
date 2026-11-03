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
//   live://refresh-notes {}                               → update the notes now
//   live://set-model  { task: 'live'|'answer', model: string, makeDefault?: boolean }
// And one the other way: overlay://close {} asks the overlay to fade out and
// close itself (toggleOverlay force-closes it after 400 ms if it doesn't).
//
//   store.ts       session state
//   transcript.ts  tokens → lines, saving the live transcript
//   session.ts     start / stop with the recording, hotkey
//   ai.ts          rolling notes, help me answer, models and costs
//   broadcast.ts   the LiveSnapshot for other windows
//   overlay.ts     the overlay window
import { listen } from '@tauri-apps/api/event';
import { setMicMuted, setRecordingStopHook, useRecorder } from '../obs';
import { useSettings } from '../settings';
import { helpMeAnswer, loadModelOptions, refreshNotes, setLiveModel } from './ai';
import { broadcastNow, scheduleBroadcast } from './broadcast';
import { maybeAutoStart, onRecordingStopped, registerHotkey, restartNotesTimer } from './session';
import { useLive, type LiveAiTask } from './store';

export {
  useLive,
  type LiveAiTask,
  type LiveAnswer,
  type LiveLine,
  type LivePartial,
  type LiveSnapshot,
  type LiveTrack,
  type TrackState,
} from './store';
export { LIVE_MODEL } from './transcript';
export { retryLive, setLiveEnabled, startLive, stopLive } from './session';
export {
  answerCostEstimate,
  helpMeAnswer,
  liveModel,
  loadModelOptions,
  notesCostEstimate,
  refreshNotes,
  setLiveModel,
} from './ai';
export { getLiveSnapshot } from './broadcast';
export { OVERLAY_CLOSE_EVENT, OVERLAY_LABEL, setOverlayProtected, toggleOverlay } from './overlay';

const set = useLive.setState;
const get = useLive.getState;

let initialized = false;

// Called once from App.tsx in the main window.
export function initLive(): void {
  if (initialized) return;
  initialized = true;
  setRecordingStopHook(onRecordingStopped);
  useRecorder.subscribe(maybeAutoStart);
  useRecorder.subscribe((s, prev) => {
    if (s.setup?.micMuted !== prev.setup?.micMuted) scheduleBroadcast();
  });
  useSettings.subscribe((s, prev) => {
    if (s.settings.liveEnabled !== prev.settings.liveEnabled) maybeAutoStart();
    if (s.settings.liveHotkey !== prev.settings.liveHotkey && get().active) void registerHotkey();
    if (s.settings.liveNotesIntervalMin !== prev.settings.liveNotesIntervalMin) restartNotesTimer();
    if (s.settings.aiProvider !== prev.settings.aiProvider) {
      set({ overrides: {}, modelOptions: [] });
      void loadModelOptions();
    }
    else if (s.settings.aiModelList !== prev.settings.aiModelList || s.settings.aiCustomModels !== prev.settings.aiCustomModels) {
      void loadModelOptions();
    }
    scheduleBroadcast();
  });
  useLive.subscribe(scheduleBroadcast);

  // The overlay and phone show model pickers before any recording starts.
  // Reload on every open so they follow the current provider and list setting.
  void listen('live://hello', () => {
    void loadModelOptions();
    broadcastNow();
  });
  void listen('live://help', () => void helpMeAnswer());
  void listen<{ question?: string }>('live://ask', (e) => void helpMeAnswer(e.payload?.question ?? ''));
  void listen('live://refresh-notes', () => void refreshNotes());
  void listen<{ muted?: boolean }>('live://set-mute', (e) => {
    void setMicMuted(!!e.payload?.muted).catch((err) => console.warn('Could not change the mic mute', err));
  });
  // The overlay can't write settings itself.
  void listen<{ language?: string }>('live://set-language', (e) => {
    if (e.payload?.language) void useSettings.getState().update({ aiOutputLanguage: e.payload.language });
  });
  void listen<{ task?: LiveAiTask; model?: string; makeDefault?: boolean }>('live://set-model', (e) => {
    const { task, model, makeDefault } = e.payload ?? {};
    if (task === 'live' || task === 'answer') void setLiveModel(task, model ?? '', !!makeDefault);
  });
  maybeAutoStart();
  void loadModelOptions();
}
