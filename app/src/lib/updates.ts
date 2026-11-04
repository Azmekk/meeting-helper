// Tells the user when a newer release is on GitHub. Where this copy can replace
// itself the update downloads in the background and installs on "Restart to
// update"; otherwise, or if that fails, the user gets a link to the website.
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { fetch } from '@tauri-apps/plugin-http';
import { relaunch } from '@tauri-apps/plugin-process';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { create } from 'zustand';
import { useLive } from './live/store';
import { useRecorder } from './obs/store';
import { useJobs } from './pipeline';
import { getSettings, useSettings } from './settings';

const LATEST_RELEASE = 'https://api.github.com/repos/Azmekk/meeting-helper/releases/latest';
// Where "Download" sends the user; the site links the right installer per platform.
const DOWNLOAD_PAGE = 'https://meetinghelper.vexbyte.com/';
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export interface UpdateInfo {
  version: string; // "0.2.0"
  url: string; // download page on the website
  publishedAt: string;
}

// 'idle' with an update available means the user installs it from the website.
export type UpdatePhase = 'idle' | 'downloading' | 'ready' | 'installing';

interface UpdateState {
  current: string | null;
  available: UpdateInfo | null;
  phase: UpdatePhase;
  // The popup is closed but the sidebar still shows the update.
  dismissed: boolean;
  checking: boolean;
  lastChecked: number | null;
  error: string | null;
}

export const useUpdate = create<UpdateState>(() => ({
  current: null,
  available: null,
  phase: 'idle',
  dismissed: false,
  checking: false,
  lastChecked: null,
  error: null,
}));

// The downloaded update, waiting for the user to restart. Kept in memory, so
// closing the app without installing means downloading it again next time.
let pending: Update | null = null;
let downloadingVersion: string | null = null;

// "v1.2.3" / "1.2.3-beta" → [1, 2, 3]
function parse(version: string): number[] {
  return version
    .replace(/^v/i, '')
    .split(/[-+]/)[0]
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

function discardPending(): void {
  void pending?.close().catch(() => {});
  pending = null;
}

// Why the app can't close for an install right now, or null if it can. The
// installer exits the app without asking, so nothing here may be running.
function installBlocker(): string | null {
  const recorder = useRecorder.getState();
  const live = useLive.getState();
  if (recorder.recording || recorder.busy) return 'the recording';
  if (live.active || live.starting) return 'live transcription';
  if (recorder.lastIngest?.status === 'processing') return 'saving the recording';
  if (Object.values(useJobs.getState().jobs).some((j) => j.stage !== 'done' && j.stage !== 'error')) return 'the transcription';
  return null;
}

export function useInstallBlocker(): string | null {
  useRecorder(installBlocker);
  useLive(installBlocker);
  return useJobs(installBlocker);
}

async function downloadUpdate(version: string): Promise<void> {
  downloadingVersion = version;
  try {
    const update = await check();
    if (update?.version !== version) throw new Error(`The updater offered ${update?.version ?? 'nothing'} instead of ${version}`);
    await update.download();
    // Skipped, or a newer release appeared, while this one was downloading.
    if (useUpdate.getState().available?.version !== version) {
      void update.close().catch(() => {});
      return;
    }
    pending = update;
    // Don't interrupt a meeting with the popup; the sidebar shows it instead.
    useUpdate.setState({ phase: 'ready', dismissed: installBlocker() !== null });
  } catch (err) {
    // Falls back to the website link until the next check tries again.
    console.warn('Update download failed:', err);
    if (useUpdate.getState().available?.version === version) useUpdate.setState({ phase: 'idle' });
  } finally {
    if (downloadingVersion === version) downloadingVersion = null;
  }
}

// Asks GitHub for the latest published release and starts downloading it. `manual`
// checks also show a version the user chose to skip.
export async function checkForUpdate(manual = false): Promise<UpdateInfo | null> {
  useUpdate.setState({ checking: true, error: null });
  try {
    const current = await getVersion();
    // GitHub rejects API requests without a User-Agent (403).
    const res = await fetch(LATEST_RELEASE, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Meeting-Helper/${current}` },
    });
    // 404 = nothing published yet.
    if (res.status === 404) {
      useUpdate.setState({ current, available: null });
      return null;
    }
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const release = (await res.json()) as { tag_name: string; published_at: string };
    const version = release.tag_name.replace(/^v/i, '');

    const skipped = !manual && getSettings().skippedVersion === version;
    const available =
      isNewer(version, current) && !skipped
        ? { version, url: DOWNLOAD_PAGE, publishedAt: release.published_at }
        : null;
    const prev = useUpdate.getState().available;
    // Re-open the popup only for a version we haven't shown yet (or on a manual check).
    const dismissed = available && !manual && prev?.version === available.version ? useUpdate.getState().dismissed : false;

    const inHand = available && (pending?.version === available.version || downloadingVersion === available.version);
    const download = !!available && !inHand && (await invoke<boolean>('can_self_update'));
    if (!inHand) discardPending();
    // Set together with `available` so the popup doesn't flash before the download starts.
    useUpdate.setState({ current, available, dismissed, ...(!inHand && { phase: download ? 'downloading' : 'idle' }) });
    if (download) void downloadUpdate(available.version);
    return available;
  } catch (err) {
    useUpdate.setState({ error: err instanceof Error ? err.message : String(err) });
    return null;
  } finally {
    useUpdate.setState({ checking: false, lastChecked: Date.now() });
  }
}

// Closes the app, installs the downloaded update and starts the new version.
export async function installUpdate(): Promise<void> {
  const blocker = installBlocker();
  if (blocker) throw new Error(`Try again once ${blocker} has finished.`);
  if (!pending) return;
  useUpdate.setState({ phase: 'installing' });
  try {
    await pending.install();
    // Only reached on macOS and Linux: on Windows the installer has already closed the app.
    await relaunch();
  } catch (err) {
    // The install uses up the download, so all that's left is the website link.
    pending = null;
    useUpdate.setState({ phase: 'idle' });
    throw err;
  }
}

export function dismissUpdate(): void {
  useUpdate.setState({ dismissed: true });
}

export async function skipUpdate(version: string): Promise<void> {
  discardPending();
  useUpdate.setState({ available: null, phase: 'idle', dismissed: false });
  await useSettings.getState().update({ skippedVersion: version });
}

let timer: ReturnType<typeof setInterval> | null = null;

// Checks shortly after start-up and then every few hours, if enabled.
export function initUpdateCheck(): void {
  void getVersion().then((current) => useUpdate.setState({ current }));
  if (timer) return;
  const run = () => {
    if (getSettings().checkForUpdates) void checkForUpdate();
  };
  setTimeout(run, 3000);
  timer = setInterval(run, CHECK_EVERY_MS);
}
