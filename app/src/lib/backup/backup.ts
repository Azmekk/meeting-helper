// Cloud backup: uploads what changed since the last run, and runs it on its
// own after meetings change when automatic backup is on.
import { getVersion } from '@tauri-apps/api/app';
import { errorMessage } from '../errors';
import { toast } from '../toast';
import * as db from '../db';
import type { BackupFile } from '../db';
import { BUNDLE_FILE, buildBundle } from '../bundle';
import { buildFolderBundle, initFolderSidecars } from '../folderBundle';
import * as native from '../native';
import { onMeetingChanged } from '../pipeline';
import { getSettings, useSettings } from '../settings';
import type { Meeting } from '../types';
import { folderKey, isBackupConfigured, loadS3Config, manifestKey, meetingKey } from './cloud';
import {
  fileStat,
  localMediaFiles,
  newManifest,
  nowIso,
  parseManifest,
  setProgress,
  upsert,
  useBackup,
  withFileNames,
  type BackupProgress,
  type LocalFile,
} from './shared';

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
