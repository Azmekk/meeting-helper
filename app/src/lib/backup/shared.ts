// What backup, restore and zip have in common: the manifest, the progress
// store, and finding a meeting's media files on disk.
import { getVersion } from '@tauri-apps/api/app';
import { appDataDir, basename, join } from '@tauri-apps/api/path';
import { exists, stat } from '@tauri-apps/plugin-fs';
import { create } from 'zustand';
import { BUNDLE_SCHEMA, isInside, samePath, type MeetingBundle } from '../bundle';
import { ensureMeetingDir } from '../folders';
import type { Meeting } from '../types';

export const MANIFEST_FILE = 'manifest.json';

export interface ManifestFile {
  name: string;
  role: 'media' | 'source';
  size: number;
}

export interface ManifestMeeting {
  uid: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  folderUid: string | null;
  files: ManifestFile[];
}

export interface ManifestFolder {
  uid: string;
  name: string;
  updatedAt: string;
}

export interface BackupManifest {
  app: 'meeting-helper';
  // 'share': one meeting exported for someone else (exportZip with `share`).
  kind: 'backup' | 'zip' | 'share';
  exportedBy?: string | null;
  appVersion: string;
  bundleSchema: number;
  createdAt: string;
  updatedAt: string;
  meetings: ManifestMeeting[];
  folders: ManifestFolder[];
}

export interface BackupProgress {
  message: string;
  fraction: number | null; // 0..1, null = unknown
}

// Shared so the settings tab shows a backup started automatically too.
export const useBackup = create<{
  running: 'backup' | 'restore' | 'zip' | null;
  progress: BackupProgress | null;
  // Media downloads per meeting id.
  downloads: Record<number, { done: number; total: number }>;
}>(() => ({ running: null, progress: null, downloads: {} }));

export function setProgress(progress: BackupProgress | null, onProgress?: (p: BackupProgress) => void) {
  useBackup.setState({ progress });
  if (progress) onProgress?.(progress);
}

export const nowIso = () => new Date().toISOString();

// ---------- Manifest ----------

export async function newManifest(kind: BackupManifest['kind']): Promise<BackupManifest> {
  const at = nowIso();
  return { app: 'meeting-helper', kind, appVersion: await getVersion(), bundleSchema: BUNDLE_SCHEMA, createdAt: at, updatedAt: at, meetings: [], folders: [] };
}

export function parseManifest(text: string | null): BackupManifest | null {
  if (!text) return null;
  try {
    const m = JSON.parse(text) as Partial<BackupManifest>;
    if (m.app !== 'meeting-helper') return null;
    return { ...m, meetings: m.meetings ?? [], folders: m.folders ?? [] } as BackupManifest;
  } catch {
    return null;
  }
}

export function upsert<T extends { uid: string }>(list: T[], item: T): void {
  const i = list.findIndex((x) => x.uid === item.uid);
  if (i >= 0) list[i] = item;
  else list.push(item);
}

// ---------- Local media files ----------

export interface LocalFile {
  name: string; // name inside the bundle directory ('/'-separated)
  role: 'media' | 'source';
  path: string;
}

export const fileExists = (p: string | null) => (p ? exists(p).catch(() => false) : Promise.resolve(false));

// The meeting's media and source files that exist, named as they are inside
// its directory (or by file name when they live elsewhere).
export async function localMediaFiles(m: Meeting): Promise<LocalFile[]> {
  const out: LocalFile[] = [];
  const add = async (path: string | null, role: LocalFile['role']) => {
    if (!path || out.some((f) => samePath(f.path, path)) || !(await fileExists(path))) return;
    if (m.dirPath && isInside(path, m.dirPath)) {
      out.push({ name: path.slice(m.dirPath.replace(/[\\/]+$/, '').length + 1).replace(/\\/g, '/'), role, path });
      return;
    }
    let name = await basename(path);
    const taken = async (n: string) =>
      out.some((f) => f.name.toLowerCase() === n.toLowerCase()) || (!!m.dirPath && (await fileExists(await join(m.dirPath, n))));
    while (await taken(name)) name = `${role}-${name}`;
    out.push({ name, role, path });
  };
  await add(m.mediaPath, 'media');
  await add(m.sourcePath, 'source');
  return out;
}

export async function fileStat(path: string): Promise<{ size: number; mtime: string | null }> {
  const s = await stat(path);
  return { size: s.size, mtime: s.mtime ? new Date(s.mtime).toISOString() : null };
}

// meeting.json as stored in a backup or zip: media named as stored next to it.
export function withFileNames(b: MeetingBundle, files: { name: string; role: 'media' | 'source' }[], m: Meeting): MeetingBundle {
  const media = files.find((f) => f.role === 'media')?.name ?? null;
  const sameFile = !!m.mediaPath && !!m.sourcePath && samePath(m.mediaPath, m.sourcePath);
  const source = files.find((f) => f.role === 'source')?.name ?? (sameFile ? media : null);
  return { ...b, meeting: { ...b.meeting, mediaFile: media, sourceFile: source } };
}

// Where downloaded media goes: the meeting's directory (created in the base
// folder layout if there is one), otherwise appData/meetings/<id>/.
export async function mediaTargetDir(m: Meeting): Promise<{ dir: string; isMeetingDir: boolean }> {
  if (m.dirPath) return { dir: m.dirPath, isMeetingDir: true };
  const dir = await ensureMeetingDir(m.id);
  if (dir) return { dir, isMeetingDir: true };
  return { dir: await join(await appDataDir(), 'meetings', String(m.id)), isMeetingDir: false };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
