// OBS Studio control over obs-websocket v5. React reads everything through
// `useRecorder`.
//
//   store.ts       recorder state
//   connection.ts  the socket: connect, retry, profile parameters
//   setup.ts       output settings, scenes, audio track routing
//   recording.ts   a recording's meeting: row, import, recovery, record path
//   processing.ts  "transcribe / summarise?" after a recording
import { toast } from '../toast';
import { getSettings } from '../settings';
import { connectObs, obs, watchConnection } from './connection';
import { onObsNotRunning, reconcileRecordingRows, syncRecordStatus, watchRecording } from './recording';
import {
  configureObs,
  ensureDefaultScene,
  MEETING_SCENE,
  refreshOutput,
  refreshScenes,
  refreshSetup,
  watchSetup,
} from './setup';
import { useRecorder } from './store';

export * from './store';
export { connectObs, disconnectObs } from './connection';
export {
  configureObs,
  createMeetingScene,
  FORMAT_OPTIONS,
  MEETING_SCENE,
  QUALITY_OPTIONS,
  refreshOutput,
  refreshScenes,
  refreshSetup,
  selectScene,
  setMicMuted,
  setOutputOption,
  SIMPLE_ENCODER_OPTIONS,
  type OutputField,
} from './setup';
export {
  defaultMeetingTitle,
  discardExternalRecording,
  ignoreExternalRecording,
  importExternalRecording,
  pauseRecording,
  resumeRecording,
  setOthersInRoom,
  setRecordingFolder,
  setRecordingStopHook,
  setRecordingTerms,
  setRecordingTitle,
  startRecording,
  stopRecording,
  trackExternalRecording,
} from './recording';
export { dismissProcessing, offerProcessing } from './processing';

const set = useRecorder.setState;
const get = useRecorder.getState;

let initialized = false;
let autoConfiguredThisSession = false;

// Called once at app startup (App.tsx). Tries to connect to OBS quietly in the
// background and keeps retrying with backoff while OBS is closed; never throws.
export function initRecorder(): void {
  if (initialized) return;
  initialized = true;
  watchConnection({ onConnected, onNotRunning: onObsNotRunning });
  watchRecording();
  watchSetup();
  void connectObs({ quiet: true });
}

async function onConnected() {
  const version = await obs.call('GetVersion');
  set({ obsVersion: version.obsVersion });

  const recording = await syncRecordStatus();
  await Promise.all([refreshScenes(), refreshOutput()]);
  await reconcileRecordingRows(recording).catch((err) => console.warn('Recording cleanup failed', err));
  await refreshSetup();

  if (autoConfiguredThisSession || get().recording) return;
  // No scene chosen yet: set up our own (that runs configureObs too).
  if (!getSettings().obsScene) {
    autoConfiguredThisSession = true;
    if (await ensureDefaultScene()) {
      toast(`Set up a “${MEETING_SCENE}” scene in OBS. See the Record screen for details.`, 'info');
      return;
    }
  }
  const setup = get().setup;
  if (setup && !setup.ok) {
    autoConfiguredThisSession = true;
    try {
      const changes = await configureObs({ auto: true });
      if (changes.length) toast('Configured OBS for Meeting Helper. See the Record screen for details.', 'info');
    } catch (err) {
      console.warn('OBS: automatic setup failed', err);
    }
  }
}
