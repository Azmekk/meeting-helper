// Tells the user when a newer release is on GitHub. It only notifies: the user
// downloads and installs the new version themselves.
import { getVersion } from '@tauri-apps/api/app';
import { fetch } from '@tauri-apps/plugin-http';
import { create } from 'zustand';
import { getSettings, useSettings } from './settings';

const LATEST_RELEASE = 'https://api.github.com/repos/Azmekk/meeting-helper/releases/latest';
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export interface UpdateInfo {
  version: string; // "0.2.0"
  url: string; // release page, lists every installer
  publishedAt: string;
}

interface UpdateState {
  current: string | null;
  available: UpdateInfo | null;
  // The popup is closed but the sidebar still shows the update.
  dismissed: boolean;
  checking: boolean;
  lastChecked: number | null;
  error: string | null;
}

export const useUpdate = create<UpdateState>(() => ({
  current: null,
  available: null,
  dismissed: false,
  checking: false,
  lastChecked: null,
  error: null,
}));

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

// Asks GitHub for the latest published release. `manual` checks also show a
// version the user chose to skip.
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
    const release = (await res.json()) as { tag_name: string; html_url: string; published_at: string };
    const version = release.tag_name.replace(/^v/i, '');

    const skipped = !manual && getSettings().skippedVersion === version;
    const available =
      isNewer(version, current) && !skipped
        ? { version, url: release.html_url, publishedAt: release.published_at }
        : null;
    const prev = useUpdate.getState().available;
    // Re-open the popup only for a version we haven't shown yet (or on a manual check).
    const dismissed = available && !manual && prev?.version === available.version ? useUpdate.getState().dismissed : false;
    useUpdate.setState({ current, available, dismissed });
    return available;
  } catch (err) {
    useUpdate.setState({ error: err instanceof Error ? err.message : String(err) });
    return null;
  } finally {
    useUpdate.setState({ checking: false, lastChecked: Date.now() });
  }
}

export function dismissUpdate(): void {
  useUpdate.setState({ dismissed: true });
}

export async function skipUpdate(version: string): Promise<void> {
  useUpdate.setState({ available: null, dismissed: false });
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
