// Recorder state shared by the OBS modules and read by React via `useRecorder`.
import { create } from 'zustand';

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
  id: 'mic' | 'desktop' | 'others' | 'output' | 'live' | 'doubleMic';
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

// A recording OBS started on its own (its UI, a hotkey, or already running when
// we connected). It isn't a meeting until the user says so.
export interface ExternalRecording {
  path: string | null; // null when OBS was already recording when we connected
  startedAt: number;
  stopped: boolean; // stopped before the user answered
  ignored: boolean; // "Ignore": still recording, not tracked
}

// A finished recording waiting for "transcribe / summarise?" (ProcessingDialog).
export interface ProcessingOffer {
  meetingId: number;
  durationMs: number;
  live: boolean; // it has a live transcript
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
  externalRecording: ExternalRecording | null;
  // Shown one at a time, oldest first.
  processing: ProcessingOffer[];
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
  externalRecording: null,
  processing: [],
}));
