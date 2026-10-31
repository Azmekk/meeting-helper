// Folder bundles (folder.json): the folder-level data no meeting bundle holds,
// i.e. the folder summary and its bookkeeping, folder chat, extraction
// templates (also those without rows), action items not tied to a meeting, and
// the folder briefing. Written to Base/<folder dir>/folder.json like the
// meeting sidecars, and included in zip and cloud backups.
//
// Import runs in two steps around the meeting imports: prepareFolderBundles
// makes sure the folder rows exist (so meetings land in them), and
// finishFolderBundles fills in the content once the meetings, whose segments
// the folder summary cites, are there.
import { join } from '@tauri-apps/api/path';
import { mkdir, writeTextFile } from '@tauri-apps/plugin-fs';
import * as db from './db';
import { remapCitations } from './bundle';
import { getSettings } from './settings';
import type { ActionItemStatus, AiDocKind, ExtractionField, Folder } from './types';

export const FOLDER_BUNDLE_SCHEMA = 1;
export const FOLDER_BUNDLE_FILE = 'folder.json';

export interface FolderBundle {
  schema: number;
  app: 'meeting-helper';
  kind: 'folder';
  exportedAt: string;
  folder: {
    uid: string;
    name: string;
    dirName: string;
    createdAt: string;
    updatedAt: string;
    briefing: string | null;
    terms?: string[]; // absent in older bundles
  };
  aiDocs: { kind: AiDocKind; content: string; model: string | null; createdAt: string; costUsd: number | null }[];
  // Folder AI bookkeeping, with meeting uids instead of local ids.
  state: { summaryMeetings: string[]; progressMeetings: string[] } | null;
  chat: { role: 'user' | 'assistant'; content: string; createdAt: string }[];
  actionItems: {
    text: string;
    owner: string | null;
    status: ActionItemStatus;
    firstSeenMeeting: string | null;
    lastUpdateMeeting: string | null;
    sourceMs: number | null;
    createdAt: string;
    updatedAt: string;
  }[];
  templates: { name: string; fields: ExtractionField[]; createdAt: string }[];
  // Folder text cites segments of many meetings; segment ids differ per
  // database, so each cited id is described by meeting uid + position.
  segments: Record<string, { meeting: string; startMs: number; text: string }>;
}

const CITE_ID_RE = /\[#(\d+(?:\s*[,;]\s*#?\d+)*)\]/g;

function citedIds(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(CITE_ID_RE)) {
    for (const part of m[1].split(/\s*[,;]\s*/)) out.push(Number(part.replace(/^#/, '')));
  }
  return out;
}

export async function buildFolderBundle(folderId: number): Promise<FolderBundle> {
  const folder = await db.getFolder(folderId);
  if (!folder) throw new Error(`Folder ${folderId} doesn't exist`);
  const uidCache = new Map<number, string | null>();
  const uidOf = async (id: number | null) => {
    if (id == null) return null;
    if (!uidCache.has(id)) uidCache.set(id, (await db.getMeeting(id))?.uid ?? null);
    return uidCache.get(id) ?? null;
  };

  const docs = await db.listFolderAiDocs(folderId);
  let state: FolderBundle['state'] = null;
  const stateDoc = docs.find((d) => d.kind === 'folder_state');
  if (stateDoc) {
    try {
      const s = JSON.parse(stateDoc.content) as { summaryMeetings?: number[]; progressMeetings?: number[] };
      const toUids = async (ids: number[] = []) => (await Promise.all(ids.map(uidOf))).filter((u): u is string => !!u);
      state = { summaryMeetings: await toUids(s.summaryMeetings), progressMeetings: await toUids(s.progressMeetings) };
    } catch {
      /* broken bookkeeping: folder AI rebuilds it */
    }
  }
  const aiDocs = docs
    .filter((d) => d.kind !== 'folder_state')
    .map((d) => ({ kind: d.kind, content: d.content, model: d.model, createdAt: d.createdAt, costUsd: d.costUsd }));
  const chat = (await db.listChatMessages('folder', folderId)).map((m) => ({ role: m.role, content: m.content, createdAt: m.createdAt }));

  const segments: FolderBundle['segments'] = {};
  const ids = [...aiDocs, ...chat].flatMap((x) => citedIds(x.content));
  for (const ref of await db.getSegmentRefs(ids)) {
    const meeting = await uidOf(ref.meetingId);
    if (meeting) segments[ref.segmentId] = { meeting, startMs: ref.startMs, text: ref.text };
  }

  const actionItems: FolderBundle['actionItems'] = [];
  for (const a of await db.listUnattachedActionItems(folderId)) {
    actionItems.push({
      text: a.text,
      owner: a.owner,
      status: a.status,
      firstSeenMeeting: await uidOf(a.firstSeenMeeting),
      lastUpdateMeeting: await uidOf(a.lastUpdateMeeting),
      sourceMs: a.sourceMs,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    });
  }

  return {
    schema: FOLDER_BUNDLE_SCHEMA,
    app: 'meeting-helper',
    kind: 'folder',
    exportedAt: new Date().toISOString(),
    folder: {
      uid: folder.uid,
      name: folder.name,
      dirName: folder.dirName,
      createdAt: folder.createdAt,
      updatedAt: (await db.getFolderUpdatedAt(folderId)) || folder.createdAt,
      briefing: folder.briefing,
      terms: folder.terms,
    },
    aiDocs,
    state,
    chat,
    actionItems,
    templates: (await db.listExtractionTemplates(folderId)).map((t) => ({ name: t.name, fields: t.fields, createdAt: t.createdAt })),
    segments,
  };
}

export function parseFolderBundle(value: unknown): FolderBundle {
  const b = value as Partial<FolderBundle> | null;
  if (!b || typeof b !== 'object' || b.app !== 'meeting-helper' || b.kind !== 'folder' || typeof b.schema !== 'number') {
    throw new Error('Not a Meeting Helper folder file');
  }
  if (b.schema > FOLDER_BUNDLE_SCHEMA) throw new Error('This folder was saved by a newer version of Meeting Helper. Update the app first.');
  if (!b.folder?.uid || !b.folder.name) throw new Error('The folder file has no folder id');
  return {
    ...b,
    aiDocs: b.aiDocs ?? [],
    state: b.state ?? null,
    chat: b.chat ?? [],
    actionItems: b.actionItems ?? [],
    templates: b.templates ?? [],
    segments: b.segments ?? {},
  } as FolderBundle;
}

// ---------- Import ----------

export interface PreparedFolder {
  bundle: FolderBundle;
  folderId: number;
  // The local folder's updated_at before any meeting import touched it.
  previousUpdatedAt: string;
}

// Creates missing folders (by uid). `dirNames` maps a folder uid to the
// directory it was found in (rescan), which then becomes its dirName.
export async function prepareFolderBundles(
  bundles: FolderBundle[],
  dirNames: Map<string, string> = new Map(),
): Promise<PreparedFolder[]> {
  const out: PreparedFolder[] = [];
  for (const bundle of bundles) {
    const known = await db.getFolderByUid(bundle.folder.uid);
    if (known) {
      out.push({ bundle, folderId: known.id, previousUpdatedAt: await db.getFolderUpdatedAt(known.id) });
      continue;
    }
    const taken = new Set((await db.listFolders()).map((f) => f.dirName.toLowerCase()));
    const wanted = dirNames.get(bundle.folder.uid) ?? (bundle.folder.dirName || bundle.folder.name);
    let dirName = wanted;
    for (let n = 2; taken.has(dirName.toLowerCase()); n++) dirName = `${wanted} (${n})`;
    const created: Folder = await db.insertFolder({
      uid: bundle.folder.uid,
      name: bundle.folder.name,
      dirName,
      createdAt: bundle.folder.createdAt,
      briefing: bundle.folder.briefing,
      terms: bundle.folder.terms ?? [],
    });
    out.push({ bundle, folderId: created.id, previousUpdatedAt: '' });
  }
  return out;
}

// Replaces each folder's content with its bundle's when the bundle is newer.
// Returns how many folders were updated.
export async function finishFolderBundles(prepared: PreparedFolder[]): Promise<number> {
  let updated = 0;
  for (const { bundle: b, folderId, previousUpdatedAt } of prepared) {
    if (previousUpdatedAt && previousUpdatedAt >= b.folder.updatedAt) continue;
    const localId = async (uid: string | null) => (uid ? ((await db.getMeetingByUid(uid))?.id ?? null) : null);
    const segIds = new Map<number, number>();
    for (const [oldId, ref] of Object.entries(b.segments)) {
      const id = await db.findSegmentId(ref.meeting, ref.startMs, ref.text);
      if (id != null) segIds.set(Number(oldId), id);
    }

    await db.deleteFolderContent(folderId);
    await db.setFolderBriefing(folderId, b.folder.briefing);
    await db.setFolderTerms(folderId, b.folder.terms ?? []);
    for (const d of b.aiDocs) {
      await db.insertImportedAiDoc({ scope: 'folder', ownerId: folderId, ...d, content: remapCitations(d.content, segIds) });
    }
    if (b.state) {
      const toIds = async (uids: string[]) => (await Promise.all(uids.map(localId))).filter((n): n is number => n != null);
      const content = JSON.stringify({
        summaryMeetings: await toIds(b.state.summaryMeetings),
        progressMeetings: await toIds(b.state.progressMeetings),
      });
      await db.insertImportedAiDoc({ scope: 'folder', ownerId: folderId, kind: 'folder_state', content, model: null, createdAt: b.exportedAt, costUsd: null });
    }
    for (const m of b.chat) {
      await db.insertImportedChatMessage({ scope: 'folder', ownerId: folderId, ...m, content: remapCitations(m.content, segIds) });
    }
    for (const a of b.actionItems) {
      await db.addActionItem({
        folderId,
        meetingId: null,
        text: a.text,
        owner: a.owner,
        status: a.status,
        firstSeenMeeting: await localId(a.firstSeenMeeting),
        lastUpdateMeeting: await localId(a.lastUpdateMeeting),
        sourceMs: a.sourceMs,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      });
    }
    await db.upsertFolderTemplates(folderId, b.templates);
    // Last: the writes above bumped updated_at to "now".
    await db.setFolderUpdatedAt(folderId, b.folder.updatedAt);
    updated++;
  }
  return updated;
}

// ---------- Sidecar ----------

// Writes Base/<dirName>/folder.json. No-op without a base folder.
export async function writeFolderSidecar(folderId: number): Promise<void> {
  const root = getSettings().baseFolder.trim();
  const folder = await db.getFolder(folderId);
  if (!root || !folder) return;
  const dir = await join(root, folder.dirName);
  await mkdir(dir, { recursive: true });
  await writeTextFile(await join(dir, FOLDER_BUNDLE_FILE), JSON.stringify(await buildFolderBundle(folderId), null, 1));
}

export async function writeAllFolderSidecars(): Promise<void> {
  for (const f of await db.listFolders()) {
    await writeFolderSidecar(f.id).catch((err) => console.warn(`Couldn't write folder.json for ${f.name}`, err));
  }
}

const POLL_MS = 5000;
let watermark = '';
let started = false;

// Polls folders.updated_at and rewrites changed folder.json files. The first
// poll writes every folder once, so folders from before this existed get one.
export function initFolderSidecars(): void {
  if (started) return;
  started = true;
  const poll = async () => {
    const changed = await db.listFoldersChangedSince(watermark);
    for (const f of changed) {
      if (f.updatedAt > watermark) watermark = f.updatedAt;
      await writeFolderSidecar(f.id).catch((err) => console.warn(`Couldn't write folder.json for ${f.id}`, err));
    }
  };
  setInterval(() => void poll().catch(() => {}), POLL_MS);
}
