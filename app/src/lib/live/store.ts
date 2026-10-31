// Live session state, read by React via `useLive` and by the other live modules.
import { create } from 'zustand';

export type LiveTrack = 'mic' | 'desktop' | 'mix';
export type TrackState = 'catchingUp' | 'live' | 'reconnecting' | 'stopped' | 'error';
export type LiveAiTask = 'live' | 'answer';

// Shapes sent by live.rs.
export interface LiveToken {
  text: string;
  startMs: number; // from the start of the recording
  endMs: number;
  isFinal: boolean;
  speaker: string | null;
  language: string | null;
}

export type LiveEvent =
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
  outputLanguage: string; // Settings.aiOutputLanguage: 'meeting' or a language code
  micMuted: boolean | null; // the OBS mic source; null when unknown (not connected)
  overlaySolid: boolean; // Settings → Appearance → Overlay background
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
}

export const INITIAL: LiveState = {
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
};

export const useLive = create<LiveState>(() => ({ ...INITIAL }));
