// Backup and restore: cloud backup to S3-compatible storage (AWS S3, R2, MinIO,
// …) and zip export/import. Both use the bundle format (bundle.ts,
// folderBundle.ts) and go through the common importers, which match meetings
// and folders by uid. It's backup for one computer at a time, not two-way
// sync: meetings deleted here stay in the bucket, and a restore never deletes
// anything locally.
//
// Bucket layout, under the configured prefix:
//   <prefix>/manifest.json                    titles, sizes, versions (BackupManifest)
//   <prefix>/meetings/<uid>/meeting.json      the meeting bundle
//   <prefix>/meetings/<uid>/<media files>     recording (and original, if kept)
//   <prefix>/folders/<uid>/folder.json        the folder bundle
// Zip layout: the same without the prefix (bundle.rs).
import { getVersion } from '@tauri-apps/api/app';
import { appDataDir, basename, join } from '@tauri-apps/api/path';
import { exists, mkdir, readTextFile, remove, stat, writeTextFile } from '@tauri-apps/plugin-fs';
import { create } from 'zustand';
import { errorMessage, toast } from '../components/ui';
import * as db from './db';
import type { BackupFile } from './db';
import {
  BUNDLE_FILE,
  BUNDLE_SCHEMA,
  buildBundle,
  flushSidecars,
  importBundle,
  isInside,
  parseBundle,
  renameSharedSpeakers,
  samePath,
  writeMeetingSidecar,
  type MeetingBundle,
} from './bundle';
import { baseFolder, ensureMeetingDir, refreshFolders, syncMeetingDir } from './folders';
import {
  FOLDER_BUNDLE_FILE,
  buildFolderBundle,
  finishFolderBundles,
  initFolderSidecars,
  parseFolderBundle,
  prepareFolderBundles,
  writeFolderSidecar,
  type FolderBundle,
} from './folderBundle';
import * as native from './native';
import { emitMeetingChanged, onMeetingChanged } from './pipeline';
import { getSecret } from './secrets';
import { getSettings, useSettings } from './settings';
import type { Meeting } from './types';

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

function setProgress(progress: BackupProgress | null, onProgress?: (p: BackupProgress) => void) {
  useBackup.setState({ progress });
  if (progress) onProgress?.(progress);
}

const nowIso = () => new Date().toISOString();

// ---------- Config ----------

export async function loadS3Config(): Promise<native.S3Config> {
  const s = getSettings();
  const [accessKeyId, secretAccessKey] = await Promise.all([getSecret('s3_access_key_id'), getSecret('s3_secret_access_key')]);
  if (!s.backupEndpoint.trim() || !s.backupBucket.trim()) throw new Error('Set up the bucket in Settings → Backup first.');
  if (!accessKeyId || !secretAccessKey) throw new Error('Add the access key ID and secret in Settings → Backup.');
  return {
    endpoint: s.backupEndpoint.trim(),
    region: s.backupRegion.trim() || 'auto',
    bucket: s.backupBucket.trim(),
    pathStyle: s.backupPathStyle,
    accessKeyId,
    secretAccessKey,
  };
}

export async function isBackupConfigured(): Promise<boolean> {
  try {
    await loadS3Config();
    return true;
  } catch {
    return false;
  }
}

// "meeting-helper/" ('' for the bucket root).
export function remotePrefix(): string {
  const p = getSettings().backupPrefix.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return p ? `${p}/` : '';
}

const meetingKey = (uid: string, name: string) => `${remotePrefix()}meetings/${uid}/${name}`;
const folderKey = (uid: string) => `${remotePrefix()}folders/${uid}/${FOLDER_BUNDLE_FILE}`;
const manifestKey = () => `${remotePrefix()}${MANIFEST_FILE}`;

// ---------- Manifest ----------

async function newManifest(kind: BackupManifest['kind']): Promise<BackupManifest> {
  const at = nowIso();
  return { app: 'meeting-helper', kind, appVersion: await getVersion(), bundleSchema: BUNDLE_SCHEMA, createdAt: at, updatedAt: at, meetings: [], folders: [] };
}

function parseManifest(text: string | null): BackupManifest | null {
  if (!text) return null;
  try {
    const m = JSON.parse(text) as Partial<BackupManifest>;
    if (m.app !== 'meeting-helper') return null;
    return { ...m, meetings: m.meetings ?? [], folders: m.folders ?? [] } as BackupManifest;
  } catch {
    return null;
  }
}

function upsert<T extends { uid: string }>(list: T[], item: T): void {
  const i = list.findIndex((x) => x.uid === item.uid);
  if (i >= 0) list[i] = item;
  else list.push(item);
}

// ---------- Local media files ----------

interface LocalFile {
  name: string; // name inside the bundle directory ('/'-separated)
  role: 'media' | 'source';
  path: string;
}

const fileExists = (p: string | null) => (p ? exists(p).catch(() => false) : Promise.resolve(false));

// The meeting's media and source files that exist, named as they are inside
// its directory (or by file name when they live elsewhere).
async function localMediaFiles(m: Meeting): Promise<LocalFile[]> {
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

async function fileStat(path: string): Promise<{ size: number; mtime: string | null }> {
  const s = await stat(path);
  return { size: s.size, mtime: s.mtime ? new Date(s.mtime).toISOString() : null };
}

// meeting.json as stored in a backup or zip: media named as stored next to it.
function withFileNames(b: MeetingBundle, files: { name: string; role: 'media' | 'source' }[], m: Meeting): MeetingBundle {
  const media = files.find((f) => f.role === 'media')?.name ?? null;
  const sameFile = !!m.mediaPath && !!m.sourcePath && samePath(m.mediaPath, m.sourcePath);
  const source = files.find((f) => f.role === 'source')?.name ?? (sameFile ? media : null);
  return { ...b, meeting: { ...b.meeting, mediaFile: media, sourceFile: source } };
}

// ---------- Backup ----------

export interface BackupResult {
  meetings: number; // meetings uploaded
  folders: number;
  files: number; // media files uploaded
  bytes: number;
  upToDate: number;
  failed: { title: string; error: string }[];
}

interface PlannedMeeting {
  meeting: Meeting;
  files: (LocalFile & { size: number; mtime: string | null })[];
  prev: db.BackupState | null;
}

const sameFile = (a: BackupFile | undefined, b: { size: number; mtime: string | null }) =>
  !!a && !a.uploadId && a.size === b.size && a.mtime === b.mtime;

let current: Promise<BackupResult> | null = null;

// Uploads what changed since the last backup. A second call while one runs
// gets the running one.
export function backupNow(onProgress?: (p: BackupProgress) => void): Promise<BackupResult> {
  if (current) return current;
  if (useBackup.getState().running) return Promise.reject(new Error('Another backup task is running.'));
  useBackup.setState({ running: 'backup' });
  current = runBackup(onProgress).finally(() => {
    current = null;
    useBackup.setState({ running: null, progress: null });
  });
  return current;
}

async function runBackup(onProgress?: (p: BackupProgress) => void): Promise<BackupResult> {
  const cfg = await loadS3Config();
  setProgress({ message: 'Reading the backup…', fraction: null }, onProgress);
  const remoteManifest = parseManifest(await native.s3GetText(cfg, manifestKey()));
  const manifest = remoteManifest ?? (await newManifest('backup'));
  const states = new Map((await db.listBackupState()).map((s) => [s.uid, s]));
  const result: BackupResult = { meetings: 0, folders: 0, files: 0, bytes: 0, upToDate: 0, failed: [] };

  // Plan: meetings whose data or media changed since their last upload.
  setProgress({ message: 'Looking for changes…', fraction: null }, onProgress);
  const planned: PlannedMeeting[] = [];
  for (const meeting of await db.listMeetings()) {
    // Recording/transcribing meetings go in a later backup, once settled.
    // 'queued' with media is settled (untranscribed, autoTranscribe off).
    const settled = meeting.status === 'ready' || meeting.status === 'error' || (meeting.status === 'queued' && !!meeting.mediaPath);
    if (!settled) continue;
    const prev = states.get(meeting.uid) ?? null;
    const files: PlannedMeeting['files'] = [];
    for (const f of await localMediaFiles(meeting)) files.push({ ...f, ...(await fileStat(f.path)) });
    const changed =
      !prev ||
      prev.updatedAt !== meeting.updatedAt ||
      files.some((f) => !sameFile(prev.files.find((p) => p.name === f.name), f)) ||
      (files.length > 0 && prev.files.some((p) => !files.some((f) => f.name === p.name)));
    if (changed) planned.push({ meeting, files, prev });
    else result.upToDate++;
  }
  const folders: { id: number; uid: string; name: string; updatedAt: string }[] = [];
  for (const f of await db.listFolders()) {
    const updatedAt = (await db.getFolderUpdatedAt(f.id)) || f.createdAt;
    if (states.get(f.uid)?.updatedAt !== updatedAt) folders.push({ id: f.id, uid: f.uid, name: f.name, updatedAt });
  }

  const bytesTotal = planned.reduce(
    (sum, p) => sum + p.files.filter((f) => !sameFile(p.prev?.files.find((x) => x.name === f.name), f)).reduce((s, f) => s + f.size, 0),
    0,
  );
  let bytesDone = 0;
  const fraction = (i: number, extra = 0) =>
    bytesTotal > 0 ? Math.min(1, (bytesDone + extra) / bytesTotal) : planned.length ? i / planned.length : null;

  for (const [i, { meeting: m, files, prev }] of planned.entries()) {
    const label = `${i + 1} of ${planned.length}: ${m.title}`;
    setProgress({ message: `Backing up ${label}`, fraction: fraction(i) }, onProgress);
    try {
      const state: db.BackupState = prev ?? { uid: m.uid, kind: 'meeting', uploadedAt: null, updatedAt: null, files: [] };
      // Without local media (restored, not downloaded yet) keep what the bucket has.
      const next: BackupFile[] = files.length ? [] : [...state.files];
      for (const f of files) {
        const old = state.files.find((x) => x.name === f.name);
        if (sameFile(old, f)) {
          next.push({ ...old!, role: f.role });
          continue;
        }
        const resume = old?.uploadId && old.size === f.size && old.mtime === f.mtime ? old.uploadId : null;
        let pendingId = resume;
        const res = await native.s3PutFile(cfg, meetingKey(m.uid, f.name), f.path, resume, (p) => {
          setProgress({ message: `Uploading ${f.name} (${label})`, fraction: fraction(i, p.done) }, onProgress);
          // Remember the multipart upload so a later run can resume it.
          if (p.uploadId && p.uploadId !== pendingId) {
            pendingId = p.uploadId;
            const pending = { name: f.name, role: f.role, size: f.size, mtime: f.mtime, etag: null, uploadId: p.uploadId };
            void db.saveBackupState({ ...state, files: [...state.files.filter((x) => x.name !== f.name), pending] }).catch(() => {});
          }
        });
        bytesDone += f.size;
        result.files++;
        result.bytes += f.size;
        next.push({ name: f.name, role: f.role, size: f.size, mtime: f.mtime, etag: res.etag, uploadId: null });
      }
      // Files replaced under another name (e.g. .mkv remuxed to .mp4).
      if (files.length) {
        for (const old of state.files) {
          if (!next.some((x) => x.name === old.name)) await native.s3Delete(cfg, meetingKey(m.uid, old.name)).catch(() => {});
        }
      }
      const bundle = withFileNames(await buildBundle(m.id), next, m);
      await native.s3PutText(cfg, meetingKey(m.uid, BUNDLE_FILE), JSON.stringify(bundle));
      await db.saveBackupState({ uid: m.uid, kind: 'meeting', uploadedAt: nowIso(), updatedAt: bundle.meeting.updatedAt, files: next });
      upsert(manifest.meetings, {
        uid: m.uid,
        title: bundle.meeting.title,
        createdAt: bundle.meeting.createdAt,
        updatedAt: bundle.meeting.updatedAt,
        folderUid: bundle.folder?.uid ?? null,
        files: next.map((f) => ({ name: f.name, role: f.role, size: f.size })),
      });
      result.meetings++;
    } catch (err) {
      result.failed.push({ title: m.title, error: errorMessage(err) });
    }
  }

  for (const [i, f] of folders.entries()) {
    setProgress({ message: `Backing up folder ${i + 1} of ${folders.length}: ${f.name}`, fraction: null }, onProgress);
    try {
      const bundle = await buildFolderBundle(f.id);
      await native.s3PutText(cfg, folderKey(f.uid), JSON.stringify(bundle));
      await db.saveBackupState({ uid: f.uid, kind: 'folder', uploadedAt: nowIso(), updatedAt: bundle.folder.updatedAt, files: [] });
      upsert(manifest.folders, { uid: f.uid, name: bundle.folder.name, updatedAt: bundle.folder.updatedAt });
      result.folders++;
    } catch (err) {
      result.failed.push({ title: `Folder ${f.name}`, error: errorMessage(err) });
    }
  }

  if (!remoteManifest || result.meetings || result.folders) {
    setProgress({ message: 'Saving the backup index…', fraction: 1 }, onProgress);
    manifest.updatedAt = nowIso();
    manifest.appVersion = await getVersion();
    await native.s3PutText(cfg, manifestKey(), JSON.stringify(manifest, null, 1));
  }

  const parts = [`${result.meetings} meeting(s) and ${result.folders} folder(s) uploaded`, `${result.upToDate} already up to date`];
  if (result.failed.length) parts.push(`${result.failed.length} failed`);
  await useSettings.getState().update({ backupLastAt: nowIso(), backupLastSummary: parts.join(', ') });
  return result;
}

// ---------- Automatic backup ----------

const AUTO_DELAY_MS = 60_000;
let autoTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleAuto(delay = AUTO_DELAY_MS): void {
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => void runAuto(), delay);
}

async function runAuto(): Promise<void> {
  if (!getSettings().backupAuto || !(await isBackupConfigured())) return;
  // Never compete with a recording (disk and network) or a transcription.
  // 'queued' without media is mid-import; with media it just isn't transcribed
  // (autoTranscribe off) and may stay that way forever.
  const busy = (await db.listMeetings()).some(
    (m) => m.status === 'recording' || m.status === 'processing' || (m.status === 'queued' && !m.mediaPath),
  );
  if (busy || useBackup.getState().running) return scheduleAuto();
  try {
    const res = await backupNow();
    if (res.failed.length) toast(`Automatic backup: ${res.failed.length} item(s) failed. See Settings → Backup.`, 'error');
  } catch (err) {
    toast(`Automatic backup failed: ${errorMessage(err)}`, 'error');
  }
}

let started = false;

// Called once at startup, after initDb.
export function initBackup(): void {
  if (started) return;
  started = true;
  initFolderSidecars();
  onMeetingChanged((id) => {
    if (!getSettings().backupAuto) return;
    void db
      .getMeeting(id)
      .then((m) => m?.status === 'ready' && scheduleAuto())
      .catch(() => {});
  });
}

// ---------- Restore ----------

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

// Where downloaded media goes: the meeting's directory (created in the base
// folder layout if there is one), otherwise appData/meetings/<id>/.
async function mediaTargetDir(m: Meeting): Promise<{ dir: string; isMeetingDir: boolean }> {
  if (m.dirPath) return { dir: m.dirPath, isMeetingDir: true };
  const dir = await ensureMeetingDir(m.id);
  if (dir) return { dir, isMeetingDir: true };
  return { dir: await join(await appDataDir(), 'meetings', String(m.id)), isMeetingDir: false };
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

// ---------- Zip ----------

export interface ZipSelection {
  meetingIds: number[] | 'all';
  folderIds: number[] | 'all';
  // Exporting one meeting for someone else: no folders, no local paths, and
  // only the parts chosen here (transcripts always go).
  share?: ShareOptions;
}

export interface ShareOptions {
  recording: boolean;
  aiDocs: boolean; // summary and other AI docs, action items, extractions
  chat: boolean;
}

export const SHARE_EXT = '.meeting.zip';

// The user's own name for the recipient to see, unless it's still the default.
function senderName(): string | null {
  const name = getSettings().selfName.trim();
  return name && name !== 'Me' ? name : null;
}

function shareBundle(b: MeetingBundle, opts: ShareOptions): MeetingBundle {
  return {
    ...b,
    exportedBy: senderName(),
    meeting: { ...b.meeting, mediaPath: null, sourcePath: null },
    folder: null,
    aiDocs: opts.aiDocs ? b.aiDocs : [],
    actionItems: opts.aiDocs ? b.actionItems : [],
    extractions: opts.aiDocs ? b.extractions : [],
    chat: opts.chat ? b.chat : [],
  };
}

async function tempDir(kind: string): Promise<string> {
  const dir = await join(await appDataDir(), 'backup-tmp', `${kind}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

// Writes the selected meetings (plus every meeting of the selected folders)
// and their folders into a zip at `outPath`.
export async function exportZip(sel: ZipSelection, outPath: string, onProgress?: (p: BackupProgress) => void): Promise<{ meetings: number; folders: number }> {
  if (useBackup.getState().running) throw new Error('Another backup task is running.');
  useBackup.setState({ running: 'zip' });
  const staging = await tempDir('export');
  try {
    await flushSidecars();
    const allFolders = await db.listFolders();
    const folderIds = new Set(sel.folderIds === 'all' ? allFolders.map((f) => f.id) : sel.folderIds);
    const meetings = (await db.listMeetings()).filter(
      (m) => m.status !== 'recording' && (sel.meetingIds === 'all' || sel.meetingIds.includes(m.id) || (m.folderId != null && folderIds.has(m.folderId))),
    );
    const { share } = sel;
    if (share) {
      if (meetings.length !== 1) throw new Error('Choose one meeting to share.');
      folderIds.clear();
    } else {
      for (const m of meetings) if (m.folderId != null) folderIds.add(m.folderId);
    }

    const manifest = await newManifest(share ? 'share' : 'zip');
    if (share) manifest.exportedBy = senderName();
    const entries: { srcDir: string; zipPrefix: string; skip?: string[] }[] = [];
    const extraFiles: { src: string; zipPath: string }[] = [];
    for (const [i, m] of meetings.entries()) {
      setProgress({ message: `Preparing ${i + 1} of ${meetings.length}: ${m.title}`, fraction: null }, onProgress);
      let files = await localMediaFiles(m);
      // A shared meeting carries one recording at most (not the original too).
      if (share) files = !share.recording ? [] : files.some((f) => f.role === 'media') ? files.filter((f) => f.role === 'media') : files.slice(0, 1);
      let bundle = withFileNames(await buildBundle(m.id), files, m);
      if (share) bundle = shareBundle(bundle, share);
      const staged = await join(staging, 'meetings', m.uid);
      await mkdir(staged, { recursive: true });
      const json = await join(staged, BUNDLE_FILE);
      await writeTextFile(json, JSON.stringify(bundle, null, 1));
      const prefix = `meetings/${m.uid}`;
      const hasDir = !share && !!m.dirPath && (await fileExists(m.dirPath));
      // Shared: only the readable copies go along, nothing else from the directory.
      if (share && m.dirPath) {
        for (const name of share.aiDocs ? ['transcript.md', 'summary.md'] : ['transcript.md']) {
          const p = await join(m.dirPath, name);
          if (await fileExists(p)) extraFiles.push({ src: p, zipPath: `${prefix}/${name}` });
        }
      }
      // The whole directory (transcript.md, summary.md, …) with the staged
      // meeting.json instead of the one on disk.
      if (hasDir) entries.push({ srcDir: m.dirPath!, zipPrefix: prefix, skip: [BUNDLE_FILE] });
      for (const f of files) {
        if (!hasDir || !isInside(f.path, m.dirPath!)) extraFiles.push({ src: f.path, zipPath: `${prefix}/${f.name}` });
      }
      extraFiles.push({ src: json, zipPath: `${prefix}/${BUNDLE_FILE}` });
      manifest.meetings.push({
        uid: m.uid,
        title: m.title,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        folderUid: bundle.folder?.uid ?? null,
        files: await Promise.all(files.map(async (f) => ({ name: f.name, role: f.role, size: (await fileStat(f.path)).size }))),
      });
    }
    for (const f of allFolders.filter((x) => folderIds.has(x.id))) {
      const bundle = await buildFolderBundle(f.id);
      const staged = await join(staging, 'folders', f.uid);
      await mkdir(staged, { recursive: true });
      const json = await join(staged, FOLDER_BUNDLE_FILE);
      await writeTextFile(json, JSON.stringify(bundle, null, 1));
      extraFiles.push({ src: json, zipPath: `folders/${f.uid}/${FOLDER_BUNDLE_FILE}` });
      manifest.folders.push({ uid: f.uid, name: f.name, updatedAt: bundle.folder.updatedAt });
    }
    const manifestPath = await join(staging, MANIFEST_FILE);
    await writeTextFile(manifestPath, JSON.stringify(manifest, null, 1));
    extraFiles.push({ src: manifestPath, zipPath: MANIFEST_FILE });

    await native.exportZip({ entries, extraFiles, outPath }, (p) =>
      setProgress({ message: 'Writing the zip…', fraction: p.total ? p.done / p.total : null }, onProgress),
    );
    return { meetings: meetings.length, folders: manifest.folders.length };
  } finally {
    await remove(staging, { recursive: true }).catch(() => {});
    useBackup.setState({ running: null, progress: null });
  }
}

export interface ZipImportResult {
  imported: number;
  updated: number;
  skipped: number;
  folders: number;
  failed: { title: string; error: string }[];
  meetingId?: number; // the last meeting imported or updated
}

// Moves the bundle's media from an unpacked directory to where the meeting
// keeps its files, unless the meeting already has them.
async function placeMedia(meetingId: number, srcDir: string, bundle: MeetingBundle): Promise<void> {
  const m = await db.getMeeting(meetingId);
  if (!m) return;
  const wanted: { rel: string; role: 'media' | 'source' }[] = [];
  const { mediaFile, sourceFile } = bundle.meeting;
  if (mediaFile && !(await fileExists(m.mediaPath))) wanted.push({ rel: mediaFile, role: 'media' });
  if (sourceFile && sourceFile !== mediaFile && !(await fileExists(m.sourcePath))) wanted.push({ rel: sourceFile, role: 'source' });
  if (!wanted.length) return;

  const { dir, isMeetingDir } = await mediaTargetDir(m);
  await mkdir(dir, { recursive: true });
  const placed = new Map<'media' | 'source', string>();
  for (const w of wanted) {
    const src = await join(srcDir, ...w.rel.split('/'));
    if (!(await fileExists(src))) continue;
    const dst = await join(dir, ...w.rel.split('/'));
    if (!(await fileExists(dst))) await native.movePath(src, dst);
    placed.set(w.role, dst);
  }
  if (!placed.size) return;
  const fresh = (await db.getMeeting(meetingId))!;
  const mediaPath = placed.get('media') ?? ((await fileExists(fresh.mediaPath)) ? fresh.mediaPath : null);
  const sourcePath =
    placed.get('source') ?? ((await fileExists(fresh.sourcePath)) ? fresh.sourcePath : sourceFile === mediaFile ? mediaPath : null);
  await db.setMeetingLocation(meetingId, { dirPath: isMeetingDir ? (fresh.dirPath ?? dir) : fresh.dirPath, mediaPath, sourcePath });
  if (isMeetingDir) await writeMeetingSidecar(meetingId).catch(() => {});
}

// A meeting someone shared with you (.meeting.zip): imported through a dialog
// that names the speakers. Your own zip exports restore as they are, so your
// speaker stays marked as you.
export interface SingleMeetingZip {
  zipPath: string;
  kind: BackupManifest['kind'];
  exportedBy: string | null;
  bundle: MeetingBundle;
  existing: Meeting | null; // imported before (same uid)
  recordingSize: number | null;
}

// Looks inside without unpacking. Null for anything else (backups with many
// meetings, zips without a manifest), which importZip handles as before.
export async function inspectZip(zipPath: string): Promise<SingleMeetingZip | null> {
  const manifest = parseManifest(await native.readZipText(zipPath, MANIFEST_FILE));
  if (!manifest || manifest.kind !== 'share' || manifest.meetings.length !== 1) return null;
  const info = manifest.meetings[0];
  const text = await native.readZipText(zipPath, `meetings/${info.uid}/${BUNDLE_FILE}`);
  if (!text) return null;
  const bundle = parseBundle(JSON.parse(text));
  const media = info.files.find((f) => f.role === 'media') ?? info.files[0];
  return {
    zipPath,
    kind: manifest.kind,
    exportedBy: bundle.exportedBy ?? manifest.exportedBy ?? null,
    bundle,
    existing: await db.getMeetingByUid(bundle.meeting.uid),
    recordingSize: media?.size ?? null,
  };
}

// Choices from the import dialog for a single-meeting zip.
export interface SharedImportOptions {
  folderId: number | null; // null = Unsorted
  speakerNames: Record<string, string>; // BundleSpeaker.key → name
}

// Unpacks the zip into a temporary directory under app data, imports folders
// and meetings through the common importers, and moves media into place. With
// `shared`, the (single) meeting goes into the chosen folder with its speakers
// renamed, replacing an earlier import of it, and the zip's folders are ignored.
export async function importZip(
  zipPath: string,
  onProgress?: (p: BackupProgress) => void,
  shared?: SharedImportOptions,
): Promise<ZipImportResult> {
  if (useBackup.getState().running) throw new Error('Another backup task is running.');
  useBackup.setState({ running: 'zip' });
  const dest = await tempDir('import');
  try {
    const files = await native.importZip({ zipPath, destDir: dest }, (p) =>
      setProgress({ message: 'Unpacking…', fraction: p.total ? p.done / p.total : null }, onProgress),
    );
    const meetingDirs = files.filter((f) => /^meetings\/[^/]+\/meeting\.json$/.test(f)).map((f) => f.split('/')[1]);
    const folderFiles = files.filter((f) => /^folders\/[^/]+\/folder\.json$/.test(f));
    if (!meetingDirs.length && !folderFiles.length) throw new Error('This zip has no Meeting Helper meetings in it.');
    const result: ZipImportResult = { imported: 0, updated: 0, skipped: 0, folders: 0, failed: [] };

    const bundles: FolderBundle[] = [];
    for (const f of shared ? [] : folderFiles) {
      try {
        bundles.push(parseFolderBundle(JSON.parse(await readTextFile(await join(dest, ...f.split('/'))))));
      } catch (err) {
        result.failed.push({ title: f, error: errorMessage(err) });
      }
    }
    const prepared = await prepareFolderBundles(bundles);

    for (const [i, dirName] of meetingDirs.entries()) {
      const dir = await join(dest, 'meetings', dirName);
      let title = dirName;
      try {
        let bundle = parseBundle(JSON.parse(await readTextFile(await join(dir, BUNDLE_FILE))));
        title = bundle.meeting.title;
        setProgress({ message: `Importing ${i + 1} of ${meetingDirs.length}: ${title}`, fraction: i / meetingDirs.length }, onProgress);
        if (shared) {
          const ex = await db.getMeetingByUid(bundle.meeting.uid);
          if (ex && (ex.status === 'recording' || ex.status === 'processing')) throw new Error('This meeting is busy here; try again when it finishes.');
          // The renames are this machine's edit, so newer than the sender's copy.
          bundle = renameSharedSpeakers(bundle, shared.speakerNames);
          bundle = { ...bundle, meeting: { ...bundle.meeting, updatedAt: nowIso() } };
        }
        const res = await importBundle(bundle, null, shared ? { force: true, folderId: shared.folderId } : {});
        if (res.status === 'skipped') {
          result.skipped++;
          continue;
        }
        res.status === 'imported' ? result.imported++ : result.updated++;
        if (shared) {
          // An earlier import may sit under another folder's directory.
          if (res.status === 'updated') await syncMeetingDir(res.meetingId).catch(() => {});
          if (baseFolder()) await ensureMeetingDir(res.meetingId).catch(() => null);
        }
        await placeMedia(res.meetingId, dir, bundle);
        result.meetingId = res.meetingId;
        emitMeetingChanged(res.meetingId);
      } catch (err) {
        result.failed.push({ title, error: errorMessage(err) });
      }
    }

    result.folders = await finishFolderBundles(prepared);
    for (const p of prepared) await writeFolderSidecar(p.folderId).catch(() => {});
    await refreshFolders();
    return result;
  } finally {
    await remove(dest, { recursive: true }).catch(() => {});
    useBackup.setState({ running: null, progress: null });
  }
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
