// Checks for the outside tools the app relies on: ffmpeg for everything,
// OBS only for recording.
import { homeDir, join } from '@tauri-apps/api/path';
import { exists } from '@tauri-apps/plugin-fs';
import { create } from 'zustand';
import { errorMessage } from '../components/ui';
import { ffmpegVersion } from './native';
import { IS_MAC, IS_WINDOWS } from './platform';
import { getSettings } from './settings';

interface FfmpegState {
  status: 'unknown' | 'checking' | 'ok' | 'missing';
  error: string | null;
  // "Later" in the startup dialog: don't ask again until the app restarts.
  dismissed: boolean;
}

export const useFfmpeg = create<FfmpegState>(() => ({ status: 'unknown', error: null, dismissed: false }));

// Whether the "install ffmpeg" dialog is showing. It stays open while "Check
// again" runs after a failed check.
export function ffmpegDialogOpen(s: FfmpegState): boolean {
  return !s.dismissed && (s.status === 'missing' || (s.status === 'checking' && s.error !== null));
}

export async function checkFfmpeg(): Promise<boolean> {
  useFfmpeg.setState({ status: 'checking' });
  try {
    await ffmpegVersion(getSettings().ffmpegPath);
    useFfmpeg.setState({ status: 'ok', error: null });
    return true;
  } catch (err) {
    useFfmpeg.setState({ status: 'missing', error: errorMessage(err) });
    return false;
  }
}

export const OBS_DOWNLOAD_URL = 'https://obsproject.com/download';

// Where the official installers and common packages put OBS.
async function obsCandidates(): Promise<string[]> {
  if (IS_WINDOWS) {
    return [
      'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe',
      'C:\\Program Files (x86)\\obs-studio\\bin\\64bit\\obs64.exe',
      'C:\\Program Files (x86)\\Steam\\steamapps\\common\\OBS Studio\\bin\\64bit\\obs64.exe',
    ];
  }
  if (IS_MAC) return ['/Applications/OBS.app'];
  const home = await homeDir().catch(() => null);
  return [
    '/usr/bin/obs',
    '/usr/local/bin/obs',
    '/snap/bin/obs-studio',
    '/var/lib/flatpak/exports/bin/com.obsproject.Studio',
    ...(home ? [await join(home, '.local/share/flatpak/exports/bin/com.obsproject.Studio')] : []),
  ];
}

// true = found, false = not in any usual place (it may still be installed
// somewhere unusual), null = couldn't tell.
export async function isObsInstalled(): Promise<boolean | null> {
  try {
    for (const path of await obsCandidates()) {
      if (await exists(path)) return true;
    }
    return false;
  } catch {
    return null;
  }
}
