// Folders on disk. With a base folder set, every folder row is a directory
// Base/<dirName>/ and every meeting gets its own directory inside it (or in
// Base/Unsorted/ when it has no folder), named "YYYY-MM-DD HH-mm Title". The
// meeting directory holds the media plus the bundle sidecar files (bundle.ts).
import { basename, dirname, extname, join } from '@tauri-apps/api/path';
import { exists, mkdir, readDir, readTextFile, remove } from '@tauri-apps/plugin-fs';
import { create } from 'zustand';
import * as db from './db';
import { BUNDLE_FILE, flushSidecars, importBundle, isInside, parseBundle, rebasePath, samePath, scheduleSidecar, writeMeetingSidecar } from './bundle';
import { safeFileName } from './export';
import { FOLDER_BUNDLE_FILE, parseFolderBundle, prepareFolderBundles, finishFolderBundles, type FolderBundle } from './folderBundle';
import * as native from './native';
import { emitMeetingChanged, ingestMedia } from './pipeline';
import { getSettings } from './settings';
import type { Folder, Meeting } from './types';

export const UNSORTED_DIR = 'Unsorted';

// Lets lists refresh when folders are created, renamed or deleted.
export const useFolders = create<{ folders: Folder[]; version: number }>(() => ({ folders: [], version: 0 }));

export async function refreshFolders(): Promise<Folder[]> {
  const folders = await db.listFolders();
  useFolders.setState((s) => ({ folders, version: s.version + 1 }));
  return folders;
}

export function baseFolder(): string | null {
  return getSettings().baseFolder.trim() || null;
}

// ---------- Names ----------

const pad = (n: number) => String(n).padStart(2, '0');

// "2026-10-31 14-05 Weekly sync" in local time.
export function meetingDirName(m: Pick<Meeting, 'createdAt' | 'title'>): string {
  const d = new Date(m.createdAt);
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}`;
  const title = safeFileName(m.title.trim() || 'Meeting').slice(0, 80).replace(/[. ]+$/, '');
  return `${stamp} ${title}`;
}

// Windows rejects names ending in a dot or space and a few device names.
function cleanDirName(name: string): string {
  let s = safeFileName(name).replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = `${s}_`;
  return s || 'Folder';
}

// "name", "name (2)", … whichever doesn't exist in `parent` yet.
async function freePath(parent: string, name: string, ext = ''): Promise<string> {
  let candidate = await join(parent, `${name}${ext}`);
  for (let n = 2; await exists(candidate); n++) candidate = await join(parent, `${name} (${n})${ext}`);
  return candidate;
}

// A directory name no other folder uses (and not "Unsorted"), free on disk too.
export async function freeFolderDirName(name: string, exceptFolderId?: number): Promise<string> {
  const base = cleanDirName(name);
  const taken = new Set(
    (await db.listFolders()).filter((f) => f.id !== exceptFolderId).map((f) => f.dirName.toLowerCase()),
  );
  taken.add(UNSORTED_DIR.toLowerCase());
  const root = baseFolder();
  let candidate = base;
  for (let n = 2; ; n++) {
    const onDisk = root ? await exists(await join(root, candidate)) : false;
    if (!taken.has(candidate.toLowerCase()) && !onDisk) return candidate;
    candidate = `${base} (${n})`;
  }
}

// Base/<dirName> or Base/Unsorted. Throws when no base folder is set.
export async function folderDirPath(folder: Pick<Folder, 'dirName'> | null): Promise<string> {
  const root = baseFolder();
  if (!root) throw new Error('Choose a base folder in Settings → Folders first.');
  return join(root, folder?.dirName ?? UNSORTED_DIR);
}

async function folderDirOf(folderId: number | null): Promise<string> {
  const folder = folderId != null ? await db.getFolder(folderId) : null;
  return folderDirPath(folder);
}

// ---------- Folders ----------

export async function createFolderWithDir(name: string): Promise<Folder> {
  const clean = name.trim() || 'Untitled folder';
  const folder = await db.createFolder(clean, await freeFolderDirName(clean));
  if (baseFolder()) await mkdir(await folderDirPath(folder), { recursive: true });
  await refreshFolders();
  return folder;
}

// Renames the folder and its directory, and repoints its meetings' paths.
export async function renameFolderWithDir(folderId: number, name: string): Promise<void> {
  const folder = await db.getFolder(folderId);
  const clean = name.trim();
  if (!folder || !clean || clean === folder.name) return;
  const root = baseFolder();
  const dirName = await freeFolderDirName(clean, folderId);
  if (root && dirName !== folder.dirName) {
    const oldDir = await join(root, folder.dirName);
    const newDir = await join(root, dirName);
    if (await exists(oldDir)) {
      await flushSidecars();
      await native.movePath(oldDir, newDir);
      for (const m of await db.listFolderMeetings(folderId)) {
        if (!m.dirPath || !isInside(m.dirPath, oldDir)) continue;
        await db.setMeetingLocation(m.id, {
          dirPath: rebasePath(m.dirPath, oldDir, newDir),
          mediaPath: rebasePath(m.mediaPath, oldDir, newDir),
          sourcePath: rebasePath(m.sourcePath, oldDir, newDir),
        });
      }
    }
  }
  await db.renameFolder(folderId, clean, dirName);
  // The folder name is part of each meeting.json.
  for (const m of await db.listFolderMeetings(folderId)) {
    scheduleSidecar(m.id);
    emitMeetingChanged(m.id);
  }
  await refreshFolders();
}

// Deletes the folder and its folder AI data. Its meetings stay, become
// unsorted, and their directories move to Base/Unsorted.
export async function deleteFolderKeepMeetings(folderId: number): Promise<void> {
  const folder = await db.getFolder(folderId);
  if (!folder) return;
  for (const m of await db.listFolderMeetings(folderId)) await moveMeetingToFolder(m.id, null);
  await db.deleteFolder(folderId);
  const root = baseFolder();
  if (root) {
    const dir = await join(root, folder.dirName);
    // Only remove it when nothing is left inside (the user's own files stay).
    try {
      // folder.json first, or a rescan would bring the folder back.
      const sidecar = await join(dir, FOLDER_BUNDLE_FILE);
      if (await exists(sidecar)) await remove(sidecar);
      if ((await exists(dir)) && (await readDir(dir)).length === 0) await remove(dir);
    } catch {
      /* not important */
    }
  }
  await refreshFolders();
}

// ---------- Meeting directories ----------

// The meeting's directory, created on first use under its folder. Null when
// no base folder is set (and the meeting has no directory yet).
export async function ensureMeetingDir(meetingId: number): Promise<string | null> {
  const m = await db.getMeeting(meetingId);
  if (!m) throw new Error('This meeting no longer exists.');
  if (m.dirPath) {
    await mkdir(m.dirPath, { recursive: true });
    return m.dirPath;
  }
  if (!baseFolder()) return null;
  const parent = await folderDirOf(m.folderId);
  await mkdir(parent, { recursive: true });
  const dir = await freePath(parent, meetingDirName(m));
  await mkdir(dir, { recursive: true });
  await db.setMeetingLocation(meetingId, { dirPath: dir, mediaPath: m.mediaPath, sourcePath: m.sourcePath });
  scheduleSidecar(meetingId);
  return dir;
}

// Moves the meeting's directory under its folder's directory if it isn't
// there (e.g. after the folder was changed while recording). The caller makes
// sure nothing is writing or reading the files (OBS stopped, no transcription).
export async function syncMeetingDir(meetingId: number, onProgress?: (p: native.CopyProgress) => void): Promise<void> {
  const m = await db.getMeeting(meetingId);
  if (!m?.dirPath || !baseFolder()) return;
  const parent = await folderDirOf(m.folderId);
  if (samePath(await dirname(m.dirPath), parent)) return;
  await flushSidecars();
  const newDir = (await exists(m.dirPath)) ? await freePath(parent, await basename(m.dirPath)) : null;
  if (newDir) await native.movePath(m.dirPath, newDir, onProgress);
  const target = newDir ?? (await freePath(parent, meetingDirName(m)));
  await db.setMeetingLocation(meetingId, {
    dirPath: target,
    mediaPath: rebasePath(m.mediaPath, m.dirPath, target),
    sourcePath: rebasePath(m.sourcePath, m.dirPath, target),
  });
  await writeMeetingSidecar(meetingId);
  emitMeetingChanged(meetingId);
}

// Puts the meeting in another folder (null = Unsorted) and moves its directory
// along. While it's recording only the folder changes; call syncMeetingDir
// after the recording stops to move the files.
export async function moveMeetingToFolder(
  meetingId: number,
  folderId: number | null,
  onProgress?: (p: native.CopyProgress) => void,
): Promise<void> {
  const m = await db.getMeeting(meetingId);
  if (!m) throw new Error('This meeting no longer exists.');
  const movesFiles = !!(m.dirPath && baseFolder());
  if (movesFiles && m.status === 'processing') throw new Error('Wait until processing finishes before moving this meeting.');
  if (m.folderId !== folderId) {
    await db.setMeetingFolder(meetingId, folderId);
    await db.moveMeetingActionItems(meetingId, folderId);
  }
  if (m.status !== 'recording') await syncMeetingDir(meetingId, onProgress);
  scheduleSidecar(meetingId);
  emitMeetingChanged(meetingId);
}

// Gives a meeting made before the base folder existed its own directory and
// moves its media files into it (as "recording.<ext>").
export async function adoptMeeting(meetingId: number, onProgress?: (p: native.CopyProgress) => void): Promise<void> {
  const before = await db.getMeeting(meetingId);
  if (!before || before.status === 'recording') return;
  if (before.status === 'processing') throw new Error('Still being transcribed; try again when it finishes.');
  const dir = await ensureMeetingDir(meetingId);
  if (!dir) throw new Error('Choose a base folder first.');
  const m = (await db.getMeeting(meetingId))!;
  const files = [...new Set([m.mediaPath, m.sourcePath].filter((p): p is string => !!p))];
  const moved = new Map<string, string>();
  for (const file of files) {
    if (isInside(file, dir) || !(await exists(file))) continue;
    const ext = await extname(file).catch(() => '');
    const target = await freePath(dir, 'recording', ext ? `.${ext}` : '');
    await native.movePath(file, target, onProgress);
    moved.set(file, target);
  }
  await db.setMeetingLocation(meetingId, {
    dirPath: dir,
    mediaPath: m.mediaPath ? (moved.get(m.mediaPath) ?? m.mediaPath) : null,
    sourcePath: m.sourcePath ? (moved.get(m.sourcePath) ?? m.sourcePath) : null,
  });
  await writeMeetingSidecar(meetingId);
  emitMeetingChanged(meetingId);
}

// Meetings that don't have a directory yet (candidates for adoptMeeting).
export async function listMeetingsWithoutDir(): Promise<Meeting[]> {
  return (await db.listMeetings()).filter((m) => !m.dirPath && m.status !== 'recording');
}

// ---------- Import ----------

// Copies a picked file into a new meeting's directory, then ingests the copy.
// The copy is ours, so ingest may replace an .mkv with its .mp4 remux.
export async function importRecordingIntoFolder(
  path: string,
  title: string,
  folderId: number | null,
  onProgress?: (p: native.CopyProgress) => void,
): Promise<number> {
  const id = await db.createMeeting({ title, sourcePath: null, mediaPath: null, status: 'queued' });
  let dir: string | null = null;
  let copy: string;
  try {
    if (folderId != null) await db.setMeetingFolder(id, folderId);
    emitMeetingChanged(id);
    dir = await ensureMeetingDir(id);
    if (!dir) throw new Error('Choose a base folder first.');
    const ext = await extname(path).catch(() => '');
    copy = await freePath(dir, 'recording', ext ? `.${ext}` : '');
    await native.copyFileProgress(path, copy, onProgress);
  } catch (err) {
    await db.deleteMeeting(id).catch(() => {});
    if (dir) await remove(dir, { recursive: true }).catch(() => {});
    emitMeetingChanged(id);
    throw err;
  }
  return ingestMedia(copy, title, { meetingId: id, fromRecording: true });
}

// ---------- Rescan ----------

export interface RescanResult {
  imported: number;
  updated: number;
  relocated: number; // known meetings whose directory had moved
  skipped: number;
  failed: { path: string; error: string }[];
}

// Finds Base/*/*/meeting.json and imports meetings the database doesn't have
// (or has an older version of). Known meetings found somewhere else than
// recorded (moved by hand, base folder changed) get their paths updated.
export async function rescanBaseFolder(onStep?: (done: number, total: number) => void): Promise<RescanResult> {
  const root = baseFolder();
  if (!root) throw new Error('Choose a base folder first.');
  await flushSidecars();
  const result: RescanResult = { imported: 0, updated: 0, relocated: 0, skipped: 0, failed: [] };

  const candidates: string[] = [];
  // Backup phase: folder.json files, imported around the meetings (folderBundle.ts).
  const folderBundles: FolderBundle[] = [];
  const folderDirNames = new Map<string, string>();
  for (const top of await readDir(root)) {
    if (!top.isDirectory) continue;
    const folderDir = await join(root, top.name);
    try {
      const fjson = await join(folderDir, FOLDER_BUNDLE_FILE);
      if (await exists(fjson)) {
        const fb = parseFolderBundle(JSON.parse(await readTextFile(fjson)));
        folderBundles.push(fb);
        folderDirNames.set(fb.folder.uid, top.name);
      }
    } catch (err) {
      result.failed.push({ path: folderDir, error: err instanceof Error ? err.message : String(err) });
    }
    let entries;
    try {
      entries = await readDir(folderDir);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory) continue;
      const dir = await join(folderDir, e.name);
      if (await exists(await join(dir, BUNDLE_FILE))) candidates.push(dir);
    }
  }

  const preparedFolders = await prepareFolderBundles(folderBundles, folderDirNames);
  for (const [i, dir] of candidates.entries()) {
    onStep?.(i, candidates.length);
    try {
      const bundle = parseBundle(JSON.parse(await readTextFile(await join(dir, BUNDLE_FILE))));
      const known = await db.getMeetingByUid(bundle.meeting.uid);
      if (known?.dirPath && !samePath(known.dirPath, dir) && (await exists(known.dirPath))) {
        // Two copies of one meeting; keep the one the database points at.
        result.skipped++;
        continue;
      }
      const res = await importBundle(bundle, dir);
      if (res.status === 'skipped' && known && (!known.dirPath || !samePath(known.dirPath, dir))) {
        const oldDir = known.dirPath;
        const media = async (p: string | null, rel: string | null) =>
          rel && (await exists(await join(dir, rel))) ? join(dir, rel) : oldDir ? rebasePath(p, oldDir, dir) : p;
        await db.setMeetingLocation(known.id, {
          dirPath: dir,
          mediaPath: await media(known.mediaPath, bundle.meeting.mediaFile),
          sourcePath: await media(known.sourcePath, bundle.meeting.sourceFile),
        });
        emitMeetingChanged(known.id);
        result.relocated++;
      } else if (res.status === 'imported') result.imported++;
      else if (res.status === 'updated') result.updated++;
      else result.skipped++;
    } catch (err) {
      result.failed.push({ path: dir, error: err instanceof Error ? err.message : String(err) });
    }
  }
  onStep?.(candidates.length, candidates.length);
  await finishFolderBundles(preparedFolders);
  await refreshFolders();
  return result;
}

// ---------- Deleting ----------

// Removes a deleted meeting's sidecar files, and its directory when nothing
// else is left in it (media the user chose to keep stays).
export async function removeMeetingSidecars(m: Pick<Meeting, 'dirPath'>): Promise<void> {
  if (!m.dirPath || !(await exists(m.dirPath))) return;
  for (const name of [BUNDLE_FILE, 'transcript.md', 'summary.md']) {
    const p = await join(m.dirPath, name);
    if (await exists(p)) await remove(p);
  }
  if ((await readDir(m.dirPath)).length === 0) await remove(m.dirPath);
}
