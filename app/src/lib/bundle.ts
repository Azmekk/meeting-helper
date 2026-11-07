// Meeting bundles: one self-contained description of a meeting (meeting.json)
// used by the folders on disk, zip export/import and cloud backup. SQLite stays
// the source of truth; the sidecar files in a meeting's directory are rewritten
// shortly after it changes. Every importer goes through importBundle, which
// matches meetings by uid.
import { join } from '@tauri-apps/api/path';
import { exists, mkdir, remove, writeTextFile } from '@tauri-apps/plugin-fs';
import * as db from './db';
import { formatTranscript, type ExportMeta } from './export';
import { formatTimestamp } from './format';
import { onMeetingChanged } from './pipeline';
import type {
  ActionItemStatus,
  AiDocKind,
  ExtractionField,
  Meeting,
  MeetingStatus,
  ProviderId,
  TranscriptSource,
} from './types';

export const BUNDLE_SCHEMA = 1;
export const BUNDLE_FILE = 'meeting.json';

// Ids inside a bundle (transcript, speaker, segment) are the exporting
// database's ids. They only link things within the bundle and are remapped on
// import; meetings are identified across machines by uid.
export interface MeetingBundle {
  schema: number;
  app: 'meeting-helper';
  exportedAt: string;
  // The sender's own name (Settings → selfName) in a meeting shared with
  // someone; absent in backups and sidecars.
  exportedBy?: string | null;
  meeting: {
    uid: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    durationMs: number | null;
    status: MeetingStatus;
    error: string | null;
    briefing: string | null;
    splitTracks?: boolean | null; // absent in older bundles
    terms?: string[];
    activeTranscriptId: number | null;
    // File names relative to the bundle directory, when the files live there.
    mediaFile: string | null;
    sourceFile: string | null;
    // Absolute paths at export time (informational; used when the files are
    // outside the meeting directory and still exist on this machine).
    mediaPath: string | null;
    sourcePath: string | null;
  };
  folder: { uid: string; name: string; dirName: string; briefing: string | null } | null;
  transcripts: BundleTranscript[];
  aiDocs: { kind: AiDocKind; content: string; model: string | null; createdAt: string; costUsd: number | null }[];
  // `conversation` is the chat's title; missing in bundles from older versions.
  chat: { role: 'user' | 'assistant'; content: string; createdAt: string; conversation?: string }[];
  // Items first raised in this meeting. Meeting references are uids.
  actionItems: {
    key?: number; // links subtasks to their parent within this bundle
    parentKey?: number | null;
    text: string;
    description?: string | null; // missing in bundles from older versions
    owner: string | null;
    status: ActionItemStatus;
    firstSeenMeeting: string | null;
    lastUpdateMeeting: string | null;
    sourceMs: number | null;
    createdAt: string;
    updatedAt: string;
  }[];
  extractions: { template: { name: string; fields: ExtractionField[] }; values: Record<string, string | null>; createdAt: string }[];
}

export interface BundleTranscript {
  id: number;
  provider: ProviderId;
  model: string;
  source: TranscriptSource;
  createdAt: string;
  costUsd: number | null;
  languages: string | null;
  speakers: { id: number; label: string; name: string | null; isSelf: boolean }[];
  segments: { id: number; speakerId: number | null; startMs: number; endMs: number; text: string; edited: boolean }[];
}

// ---------- Paths ----------

function normalize(p: string): string {
  const s = p.replace(/[\\/]+/g, '/').replace(/\/$/, '');
  // Windows paths compare case-insensitively.
  return /^[a-z]:\//i.test(s) || p.includes('\\') ? s.toLowerCase() : s;
}

export function isInside(path: string, dir: string): boolean {
  return normalize(path).startsWith(normalize(dir) + '/');
}

export function samePath(a: string, b: string): boolean {
  return normalize(a) === normalize(b);
}

// The path relative to `dir`, if it's inside it.
function relativeTo(path: string | null, dir: string | null): string | null {
  if (!path || !dir || !isInside(path, dir)) return null;
  return path.slice(dir.replace(/[\\/]+$/, '').length + 1);
}

// "<oldDir>/x/y.mp4" → "<newDir>/x/y.mp4"; other paths unchanged.
export function rebasePath(path: string | null, oldDir: string, newDir: string): string | null {
  if (!path || !isInside(path, oldDir)) return path;
  return newDir.replace(/[\\/]+$/, '') + path.slice(oldDir.replace(/[\\/]+$/, '').length);
}

// ---------- Build ----------

export async function buildBundle(meetingId: number): Promise<MeetingBundle> {
  const meeting = await db.getMeeting(meetingId);
  if (!meeting) throw new Error(`Meeting ${meetingId} doesn't exist`);
  const folder = meeting.folderId != null ? await db.getFolder(meeting.folderId) : null;

  const transcripts: BundleTranscript[] = [];
  for (const t of await db.listTranscripts(meetingId)) {
    const detail = await db.getTranscriptDetail(t.id);
    if (!detail) continue;
    transcripts.push({
      id: t.id,
      provider: t.provider,
      model: t.model,
      source: t.source,
      createdAt: t.createdAt,
      costUsd: t.costUsd,
      languages: t.languages,
      speakers: detail.speakers.map((s) => ({ id: s.id, label: s.label, name: s.name, isSelf: s.isSelf })),
      segments: detail.segments.map((s) => ({
        id: s.id,
        speakerId: s.speakerId,
        startMs: s.startMs,
        endMs: s.endMs,
        text: s.text,
        edited: s.edited,
      })),
    });
  }

  const uidOf = new Map<number, string | null>([[meeting.id, meeting.uid]]);
  const meetingUid = async (id: number | null) => {
    if (id == null) return null;
    if (!uidOf.has(id)) uidOf.set(id, (await db.getMeeting(id))?.uid ?? null);
    return uidOf.get(id) ?? null;
  };
  const actionItems: MeetingBundle['actionItems'] = [];
  for (const a of await db.listMeetingActionItems(meetingId)) {
    actionItems.push({
      key: a.id,
      parentKey: a.parentId ?? null,
      text: a.text,
      description: a.description ?? null,
      owner: a.owner,
      status: a.status,
      firstSeenMeeting: await meetingUid(a.firstSeenMeeting),
      lastUpdateMeeting: await meetingUid(a.lastUpdateMeeting),
      sourceMs: a.sourceMs,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    });
  }

  const extractions = (await db.listMeetingExtractionRows(meetingId))
    .filter((r) => r.template)
    .map((r) => ({ template: { name: r.template!.name, fields: r.template!.fields }, values: r.values, createdAt: r.createdAt }));

  return {
    schema: BUNDLE_SCHEMA,
    app: 'meeting-helper',
    exportedAt: new Date().toISOString(),
    meeting: {
      uid: meeting.uid,
      title: meeting.title,
      createdAt: meeting.createdAt,
      updatedAt: meeting.updatedAt,
      durationMs: meeting.durationMs,
      status: meeting.status,
      error: meeting.error,
      briefing: meeting.briefing,
      splitTracks: meeting.splitTracks,
      terms: meeting.terms,
      activeTranscriptId: meeting.activeTranscriptId,
      mediaFile: relativeTo(meeting.mediaPath, meeting.dirPath),
      sourceFile: relativeTo(meeting.sourcePath, meeting.dirPath),
      mediaPath: meeting.mediaPath,
      sourcePath: meeting.sourcePath,
    },
    folder: folder ? { uid: folder.uid, name: folder.name, dirName: folder.dirName, briefing: folder.briefing } : null,
    transcripts,
    aiDocs: (await db.listMeetingAiDocs(meetingId)).map((d) => ({
      kind: d.kind,
      content: d.content,
      model: d.model,
      createdAt: d.createdAt,
      costUsd: d.costUsd,
    })),
    chat: await db.exportChat('meeting', meetingId),
    actionItems,
    extractions,
  };
}

// Throws a readable error for anything that isn't a bundle this version reads.
export function parseBundle(value: unknown): MeetingBundle {
  const b = value as Partial<MeetingBundle> | null;
  if (!b || typeof b !== 'object' || b.app !== 'meeting-helper' || typeof b.schema !== 'number') {
    throw new Error('Not a Meeting Helper meeting file');
  }
  if (b.schema > BUNDLE_SCHEMA) throw new Error('This meeting was saved by a newer version of Meeting Helper. Update the app first.');
  if (!b.meeting?.uid || !b.meeting.createdAt) throw new Error('The meeting file has no meeting id');
  return {
    ...b,
    transcripts: b.transcripts ?? [],
    aiDocs: b.aiDocs ?? [],
    chat: b.chat ?? [],
    actionItems: b.actionItems ?? [],
    extractions: b.extractions ?? [],
    folder: b.folder ?? null,
  } as MeetingBundle;
}

// ---------- Citation remapping ----------

const CITE_RE = /\[#(\d+(?:\s*[,;]\s*#?\d+)*)\]/g;

// Rewrites [#oldId] citations to the imported segment ids. Ids that aren't in
// the map are left alone (they render as "not in this transcript").
export function remapCitations(text: string, ids: Map<number, number>): string {
  if (!ids.size) return text;
  return text.replace(CITE_RE, (_m, list: string) => {
    const mapped = list.split(/\s*[,;]\s*/).map((part) => {
      const n = Number(part.replace(/^#/, ''));
      return `#${ids.get(n) ?? n}`;
    });
    return `[${mapped.join(', ')}]`;
  });
}

// ---------- Shared meetings ----------

// A meeting exported for someone else: its speakers grouped across transcripts
// so the recipient can name each person once. The sender's mic speaker (isSelf)
// is one group, whatever it was labelled.
export interface BundleSpeaker {
  key: string;
  label: string;
  name: string | null;
  isSelf: boolean;
}

const speakerKey = (s: { label: string; name: string | null; isSelf: boolean }) => (s.isSelf ? 'self' : `s:${s.name ?? s.label}`);

export function bundleSpeakers(b: MeetingBundle): BundleSpeaker[] {
  // Active transcript first so its order wins.
  const ordered = [...b.transcripts].sort(
    (x, y) => Number(y.id === b.meeting.activeTranscriptId) - Number(x.id === b.meeting.activeTranscriptId),
  );
  const out = new Map<string, BundleSpeaker>();
  for (const t of ordered) {
    for (const s of t.speakers) {
      const key = speakerKey(s);
      if (!out.has(key)) out.set(key, { key, label: s.label, name: s.name, isSelf: s.isSelf });
    }
  }
  return [...out.values()];
}

// The bundle as the recipient stores it: speakers renamed by key, nobody is
// "you" (the sender's mic is not the recipient's), and no sender folder.
export function renameSharedSpeakers(b: MeetingBundle, names: Record<string, string>): MeetingBundle {
  return {
    ...b,
    folder: null,
    transcripts: b.transcripts.map((t) => ({
      ...t,
      speakers: t.speakers.map((s) => {
        const name = names[speakerKey(s)]?.trim();
        return { ...s, name: name || s.name, isSelf: false };
      }),
    })),
  };
}

// ---------- Import ----------

export type ImportStatus = 'imported' | 'updated' | 'skipped';

async function pathIfExists(dir: string | null, rel: string | null, abs: string | null): Promise<string | null> {
  if (dir && rel) {
    const p = await join(dir, rel);
    if (await exists(p)) return p;
  }
  if (abs && (await exists(abs).catch(() => false))) return abs;
  return null;
}

async function resolveFolder(f: MeetingBundle['folder']): Promise<number | null> {
  if (!f) return null;
  const known = await db.getFolderByUid(f.uid);
  if (known) return known.id;
  // Keep directory names unique; two folders can't share one directory.
  const taken = new Set((await db.listFolders()).map((x) => x.dirName.toLowerCase()));
  let dirName = f.dirName || f.name;
  for (let n = 2; taken.has(dirName.toLowerCase()); n++) dirName = `${f.dirName} (${n})`;
  const created = await db.insertFolder({
    uid: f.uid,
    name: f.name,
    dirName,
    createdAt: new Date().toISOString(),
    briefing: f.briefing,
    terms: [], // folder.json carries the folder's vocabulary
  });
  return created.id;
}

// Statuses that describe work in progress on the exporting machine.
function settledStatus(b: MeetingBundle): { status: MeetingStatus; error: string | null } {
  const { status, error } = b.meeting;
  if (status === 'ready' || status === 'error') return { status, error };
  return b.transcripts.length ? { status: 'ready', error: null } : { status: 'error', error: 'Imported without a transcript.' };
}

// Imports one bundle. `dir` is the directory holding meeting.json and the media
// (it becomes the meeting's dirPath); null when there is none (e.g. restored
// data whose media comes later). A meeting that already exists (same uid) is
// replaced only when the bundle's updatedAt is newer (or `force`); otherwise
// skipped. `folderId` (null = Unsorted) overrides the bundle's folder.
export async function importBundle(
  bundle: MeetingBundle,
  dir: string | null,
  opts: { force?: boolean; folderId?: number | null } = {},
): Promise<{ status: ImportStatus; meetingId: number }> {
  const b = parseBundle(bundle);
  const existing = await db.getMeetingByUid(b.meeting.uid);
  if (existing && !opts.force && existing.updatedAt >= b.meeting.updatedAt) return { status: 'skipped', meetingId: existing.id };

  const folderId = opts.folderId !== undefined ? opts.folderId : await resolveFolder(b.folder);
  const { status, error } = settledStatus(b);
  // Without a directory (data-only restore) keep what this machine already has.
  const dirPath = dir ?? existing?.dirPath ?? null;
  const keep = async (p: string | null | undefined) => (p && (await exists(p).catch(() => false)) ? p : null);
  const row: Omit<Meeting, 'id' | 'activeTranscriptId' | 'uid'> = {
    title: b.meeting.title,
    createdAt: b.meeting.createdAt,
    updatedAt: b.meeting.updatedAt,
    durationMs: b.meeting.durationMs,
    status,
    error,
    briefing: b.meeting.briefing,
    splitTracks: b.meeting.splitTracks ?? null,
    terms: b.meeting.terms ?? [],
    folderId,
    dirPath,
    mediaPath: (await pathIfExists(dirPath, b.meeting.mediaFile, b.meeting.mediaPath)) ?? (await keep(existing?.mediaPath)),
    sourcePath: (await pathIfExists(dirPath, b.meeting.sourceFile, b.meeting.sourcePath)) ?? (await keep(existing?.sourcePath)),
  };

  let meetingId: number;
  if (existing) {
    meetingId = existing.id;
    await db.deleteMeetingContent(meetingId);
    await db.replaceImportedMeeting(meetingId, row);
  } else {
    meetingId = await db.insertImportedMeeting({ ...row, uid: b.meeting.uid });
  }

  try {
    // Transcripts first: everything else may cite their segments.
    const transcriptIds = new Map<number, number>();
    const segmentIds = new Map<number, number>();
    for (const t of b.transcripts) {
      const res = await db.insertImportedTranscript(
        meetingId,
        { provider: t.provider, model: t.model, source: t.source ?? 'async', createdAt: t.createdAt, costUsd: t.costUsd, languages: t.languages },
        t.speakers,
        t.segments,
      );
      transcriptIds.set(t.id, res.transcriptId);
      for (const [from, to] of res.segmentIds) segmentIds.set(from, to);
    }

    for (const d of b.aiDocs) {
      await db.insertImportedAiDoc({ scope: 'meeting', ownerId: meetingId, ...d, content: remapCitations(d.content, segmentIds) });
    }
    await db.importChat('meeting', meetingId, b.chat.map((m) => ({ ...m, content: remapCitations(m.content, segmentIds) })));

    const localId = async (uid: string | null): Promise<number | null> => {
      if (!uid) return null;
      if (uid === b.meeting.uid) return meetingId;
      return (await db.getMeetingByUid(uid))?.id ?? null;
    };
    const itemIds = new Map<number, number>();
    for (const a of b.actionItems) {
      const item = await db.addActionItem({
        folderId,
        meetingId,
        text: a.text,
        description: a.description ?? null,
        owner: a.owner,
        status: a.status,
        // null = added by hand; the AI's re-runs leave those alone.
        firstSeenMeeting: await localId(a.firstSeenMeeting),
        lastUpdateMeeting: await localId(a.lastUpdateMeeting),
        sourceMs: a.sourceMs,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      });
      if (a.key != null) itemIds.set(a.key, item.id);
    }
    for (const a of b.actionItems) {
      const parent = a.parentKey != null ? itemIds.get(a.parentKey) : undefined;
      if (a.key != null && parent != null) await db.updateActionItem(itemIds.get(a.key)!, { parentId: parent });
    }

    // Templates belong to folders; rows of an unfiled meeting have nowhere to go.
    if (folderId != null && b.extractions.length) {
      const templates = await db.listExtractionTemplates(folderId);
      for (const e of b.extractions) {
        let t = templates.find((x) => x.name === e.template.name);
        if (!t) {
          t = await db.createExtractionTemplate(folderId, e.template.name, e.template.fields);
          templates.push(t);
        }
        await db.saveExtractionRow(t.id, meetingId, e.values, e.createdAt);
      }
    }

    const active = b.meeting.activeTranscriptId != null ? (transcriptIds.get(b.meeting.activeTranscriptId) ?? null) : null;
    const fallback = [...transcriptIds.values()].pop() ?? null;
    await db.finishImportedMeeting(meetingId, active ?? fallback, b.meeting.updatedAt);
  } catch (err) {
    // A half-imported new meeting would block a retry (same uid, same date).
    if (!existing) await db.deleteMeeting(meetingId).catch(() => {});
    throw err;
  }
  return { status: existing ? 'updated' : 'imported', meetingId };
}

// ---------- Sidecar files ----------

// Citations mean nothing outside the app; show the time instead.
function citationsToTimes(text: string, startMs: Map<number, number>): string {
  return text.replace(CITE_RE, (_m, list: string) => {
    const times = list
      .split(/\s*[,;]\s*/)
      .map((p) => startMs.get(Number(p.replace(/^#/, ''))))
      .filter((ms): ms is number => ms != null)
      .map(formatTimestamp);
    return times.length ? `(${times.join(', ')})` : '';
  });
}

async function writeOrRemove(path: string, content: string | null): Promise<void> {
  if (content != null) await writeTextFile(path, content);
  else if (await exists(path)) await remove(path);
}

// Writes meeting.json, transcript.md and summary.md into the meeting's
// directory. No-op for meetings without one.
export async function writeMeetingSidecar(meetingId: number): Promise<void> {
  const meeting = await db.getMeeting(meetingId);
  if (!meeting?.dirPath) return;
  const bundle = await buildBundle(meetingId);
  await mkdir(meeting.dirPath, { recursive: true });
  await writeTextFile(await join(meeting.dirPath, BUNDLE_FILE), JSON.stringify(bundle, null, 1));

  const active = bundle.transcripts.find((t) => t.id === meeting.activeTranscriptId) ?? bundle.transcripts[0];
  const meta: ExportMeta = { title: meeting.title, createdAt: meeting.createdAt };
  const transcriptMd = active
    ? formatTranscript(
        'md',
        {
          transcript: { ...active, meetingId },
          speakers: active.speakers.map((s) => ({ ...s, transcriptId: active.id })),
          segments: active.segments.map((s) => ({ ...s, transcriptId: active.id })),
        },
        meta,
      )
    : null;
  await writeOrRemove(await join(meeting.dirPath, 'transcript.md'), transcriptMd);

  // Oldest first, so the last one is the newest.
  const summary = bundle.aiDocs.filter((d) => d.kind === 'summary').pop();
  const startMs = new Map<number, number>();
  for (const t of bundle.transcripts) for (const s of t.segments) startMs.set(s.id, s.startMs);
  const summaryMd = summary ? `# ${meeting.title}\n\n${citationsToTimes(summary.content, startMs).trim()}\n` : null;
  await writeOrRemove(await join(meeting.dirPath, 'summary.md'), summaryMd);
}

// Debounced rewrites. Besides explicit schedules and meeting-changed events, a
// poll on meetings.updated_at catches every db write path (segment edits,
// speaker renames, AI docs) without hooking each one.
const SIDECAR_DELAY_MS = 2000;
const POLL_MS = 3000;
const timers = new Map<number, ReturnType<typeof setTimeout>>();
let watermark = '';
let started = false;

export function scheduleSidecar(meetingId: number): void {
  clearTimeout(timers.get(meetingId));
  timers.set(
    meetingId,
    setTimeout(() => {
      timers.delete(meetingId);
      writeMeetingSidecar(meetingId).catch((err) => console.warn(`Couldn't write meeting.json for ${meetingId}`, err));
    }, SIDECAR_DELAY_MS),
  );
}

// Writes any pending sidecars now (e.g. before moving directories).
export async function flushSidecars(): Promise<void> {
  const ids = [...timers.keys()];
  for (const id of ids) {
    clearTimeout(timers.get(id));
    timers.delete(id);
    await writeMeetingSidecar(id).catch((err) => console.warn(`Couldn't write meeting.json for ${id}`, err));
  }
}

async function poll(): Promise<void> {
  const rows = await db.listMeetingsChangedSince(watermark);
  for (const r of rows) {
    if (r.updatedAt > watermark) watermark = r.updatedAt;
    scheduleSidecar(r.id);
  }
}

// Called once at startup, after initDb.
export function initSidecars(): void {
  if (started) return;
  started = true;
  watermark = new Date().toISOString();
  onMeetingChanged(scheduleSidecar);
  setInterval(() => void poll().catch(() => {}), POLL_MS);
}
