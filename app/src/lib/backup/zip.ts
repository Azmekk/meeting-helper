// Zip export and import, including sharing one meeting with someone else
// (.meeting.zip). Same layout as the bucket, without the prefix (bundle.rs).
import { appDataDir, join } from '@tauri-apps/api/path';
import { mkdir, readTextFile, remove, writeTextFile } from '@tauri-apps/plugin-fs';
import { errorMessage } from '../errors';
import * as db from '../db';
import {
  BUNDLE_FILE,
  buildBundle,
  flushSidecars,
  importBundle,
  isInside,
  parseBundle,
  renameSharedSpeakers,
  writeMeetingSidecar,
  type MeetingBundle,
} from '../bundle';
import { baseFolder, ensureMeetingDir, refreshFolders, syncMeetingDir } from '../folders';
import {
  FOLDER_BUNDLE_FILE,
  buildFolderBundle,
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
import {
  MANIFEST_FILE,
  fileExists,
  fileStat,
  localMediaFiles,
  mediaTargetDir,
  newManifest,
  nowIso,
  parseManifest,
  setProgress,
  useBackup,
  withFileNames,
  type BackupManifest,
  type BackupProgress,
} from './shared';

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
