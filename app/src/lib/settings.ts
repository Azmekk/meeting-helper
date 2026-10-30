// User preferences, persisted with tauri-plugin-store (settings.json in the app
// data folder). Secrets are NOT here; see secrets.ts.
import { load, type Store } from '@tauri-apps/plugin-store';
import { create } from 'zustand';
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
  // Start transcription as soon as a recording stops / a file is imported.
  autoTranscribe: boolean;
  // After remuxing an OBS .mkv to .mp4, keep the .mkv too.
  keepOriginalMkv: boolean;
  // '' = use ffmpeg/ffprobe from PATH; otherwise the full path to ffmpeg.exe.
  ffmpegPath: string;
  obsHost: string;
  obsPort: number;
  // Last OBS scene picked on the Record screen.
  obsScene: string;
  // Look for a newer release on GitHub at start-up and every few hours.
  checkForUpdates: boolean;
  // A release the user said to skip; not announced again.
  skippedVersion: string;
}

export const DEFAULT_SETTINGS: Settings = {
  defaultProvider: 'soniox',
  languages: ['bg', 'en'],
  terms: [],
  selfName: 'Me',
  splitTracks: true,
  autoTranscribe: true,
  keepOriginalMkv: false,
  ffmpegPath: '',
  obsHost: '127.0.0.1',
  obsPort: 4455,
  obsScene: '',
  checkForUpdates: true,
  skippedVersion: '',
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
