// Folders, and their change tracking for folder.json.
import type { Folder } from '../types';
import { conn, touchFolder } from './connection';
import { joinTerms, now } from './helpers';
import { updateMeeting } from './meetings';
import { toFolder, type FolderRow } from './rows';

// Folder names become directory names, so drop characters Windows forbids.
function safeDirName(name: string): string {
  const clean = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return clean || 'Folder';
}

export async function createFolder(name: string, dirName?: string): Promise<Folder> {
  const clean = name.trim() || 'Untitled folder';
  const folder = { uid: crypto.randomUUID(), name: clean, dirName: dirName ?? safeDirName(clean), createdAt: now() };
  const res = await conn().execute('INSERT INTO folders (uid, name, dir_name, created_at) VALUES ($1, $2, $3, $4)', [
    folder.uid,
    folder.name,
    folder.dirName,
    folder.createdAt,
  ]);
  if (res.lastInsertId == null) throw new Error('createFolder: no id returned');
  return { id: Number(res.lastInsertId), ...folder, briefing: null, terms: [] };
}

// Alphabetical.
export async function listFolders(): Promise<Folder[]> {
  const rows = await conn().select<FolderRow[]>('SELECT * FROM folders ORDER BY name COLLATE NOCASE, id');
  return rows.map(toFolder);
}

export async function getFolder(id: number): Promise<Folder | null> {
  const rows = await conn().select<FolderRow[]>('SELECT * FROM folders WHERE id = $1', [id]);
  return rows[0] ? toFolder(rows[0]) : null;
}

// Renames the folder in the app only; moving the directory is the caller's job
// (pass the new `dirName` once it has been moved).
export async function renameFolder(id: number, name: string, dirName?: string): Promise<void> {
  const clean = name.trim();
  if (!clean) return;
  if (dirName !== undefined) {
    await conn().execute('UPDATE folders SET name = $1, dir_name = $2 WHERE id = $3', [clean, dirName, id]);
  } else {
    await conn().execute('UPDATE folders SET name = $1 WHERE id = $2', [clean, id]);
  }
  await touchFolder(id);
}

// Deletes the folder and its folder-level AI data. Its meetings are kept and
// become unassigned. Does not touch files on disk.
export async function deleteFolder(id: number): Promise<void> {
  const d = conn();
  await d.execute('UPDATE meetings SET folder_id = NULL, updated_at = $1 WHERE folder_id = $2', [now(), id]);
  await d.execute("DELETE FROM ai_docs WHERE scope = 'folder' AND owner_id = $1", [id]);
  await d.execute("DELETE FROM chat_messages WHERE scope = 'folder' AND owner_id = $1", [id]);
  await d.execute("DELETE FROM chat_conversations WHERE scope = 'folder' AND owner_id = $1", [id]);
  await d.execute('DELETE FROM action_items WHERE folder_id = $1', [id]);
  await d.execute(
    'DELETE FROM extraction_rows WHERE template_id IN (SELECT id FROM extraction_templates WHERE folder_id = $1)',
    [id],
  );
  await d.execute('DELETE FROM extraction_templates WHERE folder_id = $1', [id]);
  await d.execute('DELETE FROM folders WHERE id = $1', [id]);
}

// `folderId` null = unassigned ("Unsorted").
export async function setMeetingFolder(meetingId: number, folderId: number | null): Promise<void> {
  await updateMeeting(meetingId, { folderId });
}

export async function getFolderByUid(uid: string): Promise<Folder | null> {
  const rows = await conn().select<FolderRow[]>('SELECT * FROM folders WHERE uid = $1', [uid]);
  return rows[0] ? toFolder(rows[0]) : null;
}

// A folder with a known uid (bundle import), unlike createFolder.
export async function insertFolder(f: Omit<Folder, 'id'>): Promise<Folder> {
  const res = await conn().execute(
    'INSERT INTO folders (uid, name, dir_name, created_at, briefing, terms) VALUES ($1, $2, $3, $4, $5, $6)',
    [f.uid, f.name, f.dirName, f.createdAt, f.briefing, joinTerms(f.terms)],
  );
  if (res.lastInsertId == null) throw new Error('insertFolder: no id returned');
  return { id: Number(res.lastInsertId), ...f };
}

export async function setFolderBriefing(id: number, briefing: string | null): Promise<void> {
  await conn().execute('UPDATE folders SET briefing = $1 WHERE id = $2', [briefing, id]);
  await touchFolder(id);
}

export async function setFolderTerms(id: number, terms: string[]): Promise<void> {
  await conn().execute('UPDATE folders SET terms = $1 WHERE id = $2', [joinTerms(terms), id]);
  await touchFolder(id);
}

// '' for folders created by an import that hasn't brought their folder.json yet.
export async function getFolderUpdatedAt(id: number): Promise<string> {
  const rows = await conn().select<{ updated_at: string | null }[]>('SELECT updated_at FROM folders WHERE id = $1', [id]);
  return rows[0]?.updated_at ?? '';
}

export async function setFolderUpdatedAt(id: number, updatedAt: string): Promise<void> {
  await conn().execute('UPDATE folders SET updated_at = $1 WHERE id = $2', [updatedAt, id]);
}

export async function listFoldersChangedSince(since: string): Promise<{ id: number; updatedAt: string }[]> {
  const rows = await conn().select<{ id: number; updated_at: string }[]>(
    'SELECT id, COALESCE(updated_at, created_at) AS updated_at FROM folders WHERE COALESCE(updated_at, created_at) > $1',
    [since],
  );
  return rows.map((r) => ({ id: r.id, updatedAt: r.updated_at }));
}

// Clears what folder.json describes before an import writes it again.
// Templates are kept (their rows belong to meetings); see upsertFolderTemplates.
export async function deleteFolderContent(folderId: number): Promise<void> {
  const d = conn();
  await d.execute("DELETE FROM ai_docs WHERE scope = 'folder' AND owner_id = $1", [folderId]);
  await d.execute("DELETE FROM chat_messages WHERE scope = 'folder' AND owner_id = $1", [folderId]);
  await d.execute("DELETE FROM chat_conversations WHERE scope = 'folder' AND owner_id = $1", [folderId]);
  await d.execute('DELETE FROM action_items WHERE folder_id = $1 AND meeting_id IS NULL', [folderId]);
}
