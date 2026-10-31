// Restoring from the bucket: listing what it holds, importing meetings and
// folders, and downloading media when it's wanted.
import { join } from '@tauri-apps/api/path';
import { mkdir } from '@tauri-apps/plugin-fs';
import { errorMessage } from '../errors';
import * as db from '../db';
import type { BackupFile } from '../db';
import { BUNDLE_FILE, importBundle, parseBundle, writeMeetingSidecar } from '../bundle';
import { ensureMeetingDir, refreshFolders } from '../folders';
import {
  FOLDER_BUNDLE_FILE,
  finishFolderBundles,
  parseFolderBundle,
  prepareFolderBundles,
  writeFolderSidecar,
  type FolderBundle,
} from '../folderBundle';
import * as native from '../native';
import { emitMeetingChanged } from '../pipeline';
import { getSettings } from '../settings';
import type { Meeting } from '../types';
import { folderKey, loadS3Config, manifestKey, meetingKey, remotePrefix } from './cloud';
import {
  fileExists,
  fileStat,
  localMediaFiles,
  mediaTargetDir,
  nowIso,
  parseManifest,
  setProgress,
  useBackup,
  type BackupProgress,
  type ManifestFile,
  type ManifestFolder,
  type ManifestMeeting,
} from './shared';

export interface RemoteMeeting extends ManifestMeeting {
  folderName: string | null;
  mediaSize: number;
  // How the local copy compares: not here, older, same, newer.
  local: 'missing' | 'older' | 'same' | 'newer';
}

export interface RemoteListing {
  meetings: RemoteMeeting[];
  folders: ManifestFolder[];
  appVersion: string | null;
}

// What the bucket holds. Sizes come from the object listing; titles from the
// manifest, or from each meeting.json when there is no manifest.
export async function listRemote(): Promise<RemoteListing> {
  const cfg = await loadS3Config();
  const manifest = parseManifest(await native.s3GetText(cfg, manifestKey()));
  const base = `${remotePrefix()}meetings/`;
  const groups = new Map<string, native.S3Object[]>();
  for (const o of await native.s3List(cfg, base)) {
    const [uid, ...rest] = o.key.slice(base.length).split('/');
    if (!uid || !rest.length) continue;
    groups.set(uid, [...(groups.get(uid) ?? []), { ...o, key: rest.join('/') }]);
  }

  const folders = [...(manifest?.folders ?? [])];
  if (!manifest) {
    const fbase = `${remotePrefix()}folders/`;
    for (const o of await native.s3List(cfg, fbase)) {
      if (!o.key.endsWith(`/${FOLDER_BUNDLE_FILE}`)) continue;
      try {
        const fb = parseFolderBundle(JSON.parse((await native.s3GetText(cfg, o.key)) ?? ''));
        folders.push({ uid: fb.folder.uid, name: fb.folder.name, updatedAt: fb.folder.updatedAt });
      } catch {
        /* listed below as unreadable meetings, if any */
      }
    }
  }

  const meetings: RemoteMeeting[] = [];
  for (const [uid, objects] of groups) {
    if (!objects.some((o) => o.key === BUNDLE_FILE)) continue;
    let info = manifest?.meetings.find((m) => m.uid === uid);
    if (!info) {
      try {
        const b = parseBundle(JSON.parse((await native.s3GetText(cfg, meetingKey(uid, BUNDLE_FILE))) ?? ''));
        info = {
          uid,
          title: b.meeting.title,
          createdAt: b.meeting.createdAt,
          updatedAt: b.meeting.updatedAt,
          folderUid: b.folder?.uid ?? null,
          files: objects
            .filter((o) => o.key !== BUNDLE_FILE)
            .map((o) => ({ name: o.key, role: o.key === b.meeting.sourceFile && o.key !== b.meeting.mediaFile ? 'source' : 'media', size: o.size })),
        };
      } catch {
        continue;
      }
    }
    const files = objects
      .filter((o) => o.key !== BUNDLE_FILE)
      .map((o) => ({ name: o.key, size: o.size, role: info.files.find((f) => f.name === o.key)?.role ?? ('media' as const) }));
    const local = await db.getMeetingByUid(uid);
    meetings.push({
      ...info,
      files,
      folderName: folders.find((f) => f.uid === info.folderUid)?.name ?? null,
      mediaSize: files.reduce((s, f) => s + f.size, 0),
      local: !local ? 'missing' : local.updatedAt < info.updatedAt ? 'older' : local.updatedAt === info.updatedAt ? 'same' : 'newer',
    });
  }
  meetings.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { meetings, folders, appVersion: manifest?.appVersion ?? null };
}

export interface RestoreResult {
  imported: number;
  updated: number;
  skipped: number;
  folders: number;
  failed: { title: string; error: string }[];
}

// Imports meeting and folder data right away. Media stays in the bucket until
// the meeting is opened ("Download recording") or downloadAllMedia runs.
export async function restoreFromCloud(
  listing: RemoteListing,
  uids: string[] | 'all',
  onProgress?: (p: BackupProgress) => void,
): Promise<RestoreResult> {
  if (useBackup.getState().running) throw new Error('Another backup task is running.');
  useBackup.setState({ running: 'restore' });
  try {
    const cfg = await loadS3Config();
    const selected = uids === 'all' ? listing.meetings : listing.meetings.filter((m) => uids.includes(m.uid));
    const folderUids = new Set(
      uids === 'all' ? listing.folders.map((f) => f.uid) : selected.map((m) => m.folderUid).filter((u): u is string => !!u),
    );
    const result: RestoreResult = { imported: 0, updated: 0, skipped: 0, folders: 0, failed: [] };

    const bundles: FolderBundle[] = [];
    for (const uid of folderUids) {
      try {
        const text = await native.s3GetText(cfg, folderKey(uid));
        if (text) bundles.push(parseFolderBundle(JSON.parse(text)));
      } catch (err) {
        result.failed.push({ title: `Folder ${listing.folders.find((f) => f.uid === uid)?.name ?? uid}`, error: errorMessage(err) });
      }
    }
    const prepared = await prepareFolderBundles(bundles);

    for (const [i, rm] of selected.entries()) {
      setProgress({ message: `Restoring ${i + 1} of ${selected.length}: ${rm.title}`, fraction: i / selected.length }, onProgress);
      try {
        const text = await native.s3GetText(cfg, meetingKey(rm.uid, BUNDLE_FILE));
        if (!text) throw new Error('meeting.json is missing in the bucket');
        const bundle = parseBundle(JSON.parse(text));
        const res = await importBundle(bundle, null);
        if (res.status === 'skipped') {
          result.skipped++;
          continue;
        }
        res.status === 'imported' ? result.imported++ : result.updated++;
        if (getSettings().baseFolder.trim()) await ensureMeetingDir(res.meetingId).catch(() => null);
        await recordRemoteFiles(res.meetingId, bundle.meeting.updatedAt, rm.files);
        emitMeetingChanged(res.meetingId);
      } catch (err) {
        result.failed.push({ title: rm.title, error: errorMessage(err) });
      }
    }

    result.folders = await finishFolderBundles(prepared);
    for (const p of prepared) {
      await db.saveBackupState({ uid: p.bundle.folder.uid, kind: 'folder', uploadedAt: nowIso(), updatedAt: p.bundle.folder.updatedAt, files: [] });
      await writeFolderSidecar(p.folderId).catch(() => {});
    }
    await refreshFolders();
    return result;
  } finally {
    useBackup.setState({ running: null, progress: null });
  }
}

// Marks a restored meeting as backed up, with the bucket's files. Files that
// already exist locally (same machine) get their size/mtime so the next backup
// doesn't upload them again.
async function recordRemoteFiles(meetingId: number, updatedAt: string, remote: ManifestFile[]): Promise<void> {
  const m = await db.getMeeting(meetingId);
  if (!m) return;
  const local = await localMediaFiles(m);
  const files: BackupFile[] = [];
  for (const f of remote) {
    const match = local.find((l) => l.role === f.role);
    const st = match ? await fileStat(match.path) : null;
    const same = st && st.size === f.size;
    files.push({ name: same ? match!.name : f.name, role: f.role, size: f.size, mtime: same ? st.mtime : null, etag: null, uploadId: null });
  }
  await db.saveBackupState({ uid: m.uid, kind: 'meeting', uploadedAt: nowIso(), updatedAt, files });
}

// The bucket's copy of the meeting's media, when it's missing locally.
export async function remoteMediaFor(m: Meeting): Promise<{ files: BackupFile[]; size: number } | null> {
  if (m.status === 'recording' || (await fileExists(m.mediaPath))) return null;
  const state = await db.getBackupState(m.uid);
  const files = state?.files ?? [];
  if (!files.length) return null;
  return { files, size: files.reduce((s, f) => s + f.size, 0) };
}

export async function downloadMedia(meetingId: number, onProgress?: (p: { done: number; total: number }) => void): Promise<void> {
  const m = await db.getMeeting(meetingId);
  if (!m) throw new Error('This meeting no longer exists.');
  const remote = await remoteMediaFor(m);
  if (!remote) return;
  const cfg = await loadS3Config();
  const { dir, isMeetingDir } = await mediaTargetDir(m);
  await mkdir(dir, { recursive: true });

  const total = remote.size;
  let before = 0;
  const report = (done: number) => {
    useBackup.setState((s) => ({ downloads: { ...s.downloads, [meetingId]: { done, total } } }));
    onProgress?.({ done, total });
  };
  const placed = new Map<'media' | 'source', string>();
  const files: BackupFile[] = [];
  try {
    for (const f of remote.files) {
      const dest = await join(dir, ...f.name.split('/'));
      if (!(await fileExists(dest))) {
        await native.s3GetFile(cfg, meetingKey(m.uid, f.name), dest, (p) => report(before + p.done));
      }
      before += f.size;
      report(before);
      placed.set(f.role, dest);
      const st = await fileStat(dest);
      files.push({ ...f, size: st.size, mtime: st.mtime, uploadId: null });
    }
  } finally {
    useBackup.setState((s) => {
      const { [meetingId]: _, ...rest } = s.downloads;
      return { downloads: rest };
    });
  }

  const fresh = (await db.getMeeting(meetingId))!;
  const mediaPath = placed.get('media') ?? placed.get('source') ?? null;
  const keepSource = (await fileExists(fresh.sourcePath)) ? fresh.sourcePath : null;
  await db.setMeetingLocation(meetingId, {
    dirPath: isMeetingDir ? (fresh.dirPath ?? dir) : fresh.dirPath,
    mediaPath,
    sourcePath: placed.get('source') ?? keepSource ?? mediaPath,
  });
  // The files now match the bucket; remember their local size/mtime.
  const state = await db.getBackupState(m.uid);
  if (state) await db.saveBackupState({ ...state, files });
  if (isMeetingDir) await writeMeetingSidecar(meetingId).catch(() => {});
  emitMeetingChanged(meetingId);
}

// Downloads every meeting's missing media, one meeting at a time.
export async function downloadAllMedia(onProgress?: (p: BackupProgress) => void): Promise<{ downloaded: number; failed: { title: string; error: string }[] }> {
  const todo: { m: Meeting; size: number }[] = [];
  for (const m of await db.listMeetings()) {
    const r = await remoteMediaFor(m);
    if (r) todo.push({ m, size: r.size });
  }
  const total = todo.reduce((s, t) => s + t.size, 0);
  let done = 0;
  const result = { downloaded: 0, failed: [] as { title: string; error: string }[] };
  for (const [i, { m, size }] of todo.entries()) {
    const message = `Downloading ${i + 1} of ${todo.length}: ${m.title}`;
    try {
      await downloadMedia(m.id, (p) => setProgress({ message, fraction: total ? (done + p.done) / total : null }, onProgress));
      result.downloaded++;
    } catch (err) {
      result.failed.push({ title: m.title, error: errorMessage(err) });
    }
    done += size;
  }
  setProgress(null);
  return result;
}
