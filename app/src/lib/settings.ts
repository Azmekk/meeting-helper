// User preferences, persisted with tauri-plugin-store (settings.json in the app
// data folder). Secrets are NOT here; see secrets.ts.
import { load, type Store } from '@tauri-apps/plugin-store';
import { create } from 'zustand';
import type { AiProviderId } from './ai/types';
import type { ProviderId } from './types';

export interface Settings {
  defaultProvider: ProviderId;
  // Language hints, main language first. Empty = let the provider auto-detect.
  languages: string[];
  // Names, product words and jargon to bias recognition towards.
  terms: string[];
  // Name used for the microphone-track speaker.
  selfName: string;
  // Transcribe the mic and desktop tracks separately (needs headphones, so the
  // mic doesn't also pick up the other people). Falls back to a single mixed
  // track automatically if the recording has only one audio track.
  splitTracks: boolean;
  // After remuxing an OBS .mkv to .mp4, keep the .mkv too.
  keepOriginalMkv: boolean;
  // '' = use ffmpeg/ffprobe from PATH; otherwise the full path to ffmpeg.exe.
  ffmpegPath: string;
  obsHost: string;
  obsPort: number;
  // Last OBS scene picked on the Record screen.
  obsScene: string;
  // OBS Noise Suppression (RNNoise) on the recorded mic, if it has no noise filter.
  micNoiseSuppression: boolean;
  // Look for a newer release on GitHub at start-up and every few hours.
  checkForUpdates: boolean;
  // A release the user said to skip; not announced again.
  skippedVersion: string;
  // AI assistant. Model settings: '' = the provider's recommended model.
  aiProvider: AiProviderId;
  aiCustomBaseUrl: string; // OpenAI-compatible base URL, e.g. https://openrouter.ai/api/v1
  aiLiveModel: string; // rolling live notes
  aiAnswerModel: string; // "help me answer"
  aiSummaryModel: string; // summaries, chat, folder work
  // Which models the pickers list: the newest of each family, everything, or
  // the ones ticked in Settings → AI (aiCustomModels).
  aiModelList: 'latest' | 'all' | 'custom';
  aiCustomModels: string[];
  // 'meeting' = same language as the meeting, otherwise a language code.
  aiOutputLanguage: string;
  // Live transcription (Soniox real-time) and live AI while recording.
  liveEnabled: boolean;
  // Global shortcut for "help me answer", in Tauri accelerator syntax.
  liveHotkey: string;
  // The user dismissed the caching/cost warning shown on a mid-meeting model switch.
  liveModelSwitchWarningOff: boolean;
  // Ask Windows to keep the overlay window out of screen shares and captures.
  overlayContentProtected: boolean;
  // What each rolling-notes update sends: 'notes' = current notes + the last
  // ~90 s (flat cost), 'full' = the whole transcript so far as cached context
  // (better recall of earlier parts; cost grows with meeting length).
  liveNotesContext: 'notes' | 'full';
  // Folders. '' = no base folder: meetings aren't kept in their own directories.
  baseFolder: string;
  // After a meeting in a folder gets its summary, update the folder summary,
  // action items and extraction tables in the background.
  folderAiAuto: boolean;
  // Cloud backup (S3/R2-compatible). Keys are in the keyring (secrets.ts).
  backupEndpoint: string;
  backupRegion: string; // 'auto' for R2
  backupBucket: string;
  backupPrefix: string; // folder inside the bucket, e.g. 'meeting-helper'
  backupPathStyle: boolean;
  // Back up shortly after a meeting is ready (never while recording).
  backupAuto: boolean;
  backupLastAt: string; // ISO time of the last finished backup, '' = never
  backupLastSummary: string;
  // Secret mode: the phone remote server (remote.rs) and the hide-window shortcut.
  remoteEnabled: boolean;
  remotePort: number;
  secretHotkey: string;
  // Appearance (applied by appearance.ts as attributes on <html>).
  appearanceTheme: 'system' | 'light' | 'dark';
  appearanceAccent: AccentId;
  // Translucent "liquid glass" sidebar and cards.
  appearanceGlass: boolean;
  // With glass on (Windows 11): let the desktop show through the window.
  appearanceMaterial: 'none' | 'mica' | 'acrylic';
  // The live overlay's capsules: slightly see-through, or fully opaque for readability.
  overlaySolid: boolean;
}

export type AccentId = 'teal' | 'blue' | 'indigo' | 'purple' | 'orange' | 'graphite';

export const DEFAULT_SETTINGS: Settings = {
  defaultProvider: 'soniox',
  languages: ['bg', 'en'],
  terms: [],
  selfName: 'Me',
  splitTracks: true,
  keepOriginalMkv: false,
  ffmpegPath: '',
  obsHost: '127.0.0.1',
  obsPort: 4455,
  obsScene: '',
  micNoiseSuppression: true,
  checkForUpdates: true,
  skippedVersion: '',
  aiProvider: 'anthropic',
  aiCustomBaseUrl: '',
  aiLiveModel: '',
  aiAnswerModel: '',
  aiSummaryModel: '',
  aiModelList: 'latest',
  aiCustomModels: [],
  aiOutputLanguage: 'meeting',
  liveEnabled: false,
  liveHotkey: 'CommandOrControl+Alt+H',
  liveModelSwitchWarningOff: false,
  overlayContentProtected: true,
  liveNotesContext: 'notes',
  baseFolder: '',
  folderAiAuto: true,
  backupEndpoint: '',
  backupRegion: 'auto',
  backupBucket: '',
  backupPrefix: 'meeting-helper',
  backupPathStyle: false,
  backupAuto: false,
  backupLastAt: '',
  backupLastSummary: '',
  remoteEnabled: false,
  remotePort: 4810,
  secretHotkey: 'CommandOrControl+Alt+M',
  appearanceTheme: 'system',
  appearanceAccent: 'teal',
  appearanceGlass: false,
  appearanceMaterial: 'mica',
  overlaySolid: false,
};

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  load(): Promise<void>;
  update(patch: Partial<Settings>): Promise<void>;
}

let store: Store | null = null;

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,

  async load() {
    store = await load('settings.json', { autoSave: false, defaults: {} });
    const saved = (await store.get<Partial<Settings>>('settings')) ?? {};
    set({ settings: { ...DEFAULT_SETTINGS, ...saved }, loaded: true });
  },

  async update(patch) {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    if (!store) return;
    await store.set('settings', settings);
    await store.save();
  },
}));

// For non-React code (pipeline, etc.).
export function getSettings(): Settings {
  return useSettings.getState().settings;
}
