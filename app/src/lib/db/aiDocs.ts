// AI documents: summaries, notes and bookkeeping for meetings and folders.
import type { AiDoc, AiDocKind, AiScope } from '../types';
import { conn, touchOwner } from './connection';
import { now } from './helpers';
import { toAiDoc, type AiDocRow } from './rows';

// Summaries keep their history until the user deletes them; other kinds hold
// one doc per (scope, owner, kind), so a new one replaces the old.
const KEEPS_HISTORY: AiDocKind[] = ['summary', 'folder_summary'];

export async function saveAiDoc(doc: {
  scope: AiScope;
  ownerId: number;
  kind: AiDocKind;
  content: string;
  model: string | null;
  costUsd: number | null;
}): Promise<AiDoc> {
  const d = conn();
  const createdAt = now();
  const res = await d.execute(
    `INSERT INTO ai_docs (scope, owner_id, kind, content, model, created_at, cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [doc.scope, doc.ownerId, doc.kind, doc.content, doc.model, createdAt, doc.costUsd],
  );
  if (res.lastInsertId == null) throw new Error('saveAiDoc: no id returned');
  const id = Number(res.lastInsertId);
  if (!KEEPS_HISTORY.includes(doc.kind)) {
    await d.execute('DELETE FROM ai_docs WHERE scope = $1 AND owner_id = $2 AND kind = $3 AND id <> $4', [
      doc.scope,
      doc.ownerId,
      doc.kind,
      id,
    ]);
  }
  await touchOwner(doc.scope, doc.ownerId);
  return { id, ...doc, createdAt };
}

// Newest first.
export async function listAiDocs(scope: AiScope, ownerId: number, kind: AiDocKind): Promise<AiDoc[]> {
  const rows = await conn().select<AiDocRow[]>(
    'SELECT * FROM ai_docs WHERE scope = $1 AND owner_id = $2 AND kind = $3 ORDER BY id DESC',
    [scope, ownerId, kind],
  );
  return rows.map(toAiDoc);
}

export async function deleteAiDocVersion(doc: Pick<AiDoc, 'id' | 'scope' | 'ownerId'>): Promise<void> {
  await conn().execute('DELETE FROM ai_docs WHERE id = $1', [doc.id]);
  await touchOwner(doc.scope, doc.ownerId);
}

// The newest one, for kinds with a history.
export async function getAiDoc(scope: AiScope, ownerId: number, kind: AiDocKind): Promise<AiDoc | null> {
  const rows = await conn().select<AiDocRow[]>(
    'SELECT * FROM ai_docs WHERE scope = $1 AND owner_id = $2 AND kind = $3 ORDER BY id DESC LIMIT 1',
    [scope, ownerId, kind],
  );
  return rows[0] ? toAiDoc(rows[0]) : null;
}

export async function deleteAiDoc(scope: AiScope, ownerId: number, kind: AiDocKind): Promise<void> {
  await conn().execute('DELETE FROM ai_docs WHERE scope = $1 AND owner_id = $2 AND kind = $3', [scope, ownerId, kind]);
  await touchOwner(scope, ownerId);
}

export async function insertImportedAiDoc(doc: Omit<AiDoc, 'id'>): Promise<void> {
  await conn().execute(
    `INSERT INTO ai_docs (scope, owner_id, kind, content, model, created_at, cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [doc.scope, doc.ownerId, doc.kind, doc.content, doc.model, doc.createdAt, doc.costUsd],
  );
}

// All meeting-scoped AI docs (summary, notes, …) for the bundle.
export async function listMeetingAiDocs(meetingId: number): Promise<AiDoc[]> {
  const rows = await conn().select<AiDocRow[]>("SELECT * FROM ai_docs WHERE scope = 'meeting' AND owner_id = $1 ORDER BY id", [
    meetingId,
  ]);
  return rows.map(toAiDoc);
}

export async function listFolderAiDocs(folderId: number): Promise<AiDoc[]> {
  const rows = await conn().select<AiDocRow[]>("SELECT * FROM ai_docs WHERE scope = 'folder' AND owner_id = $1 ORDER BY id", [
    folderId,
  ]);
  return rows.map(toAiDoc);
}
