// Action items.
import type { ActionItem } from '../types';
import { conn, touchFolder, touchItemMeeting } from './connection';
import { now } from './helpers';
import { toActionItem, type ActionItemRow } from './rows';

// Open first, then by when they came up.
export async function listActionItems(folderId: number): Promise<ActionItem[]> {
  const rows = await conn().select<ActionItemRow[]>(
    `SELECT * FROM action_items WHERE folder_id = $1
     ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'done' THEN 1 ELSE 2 END, created_at, id`,
    [folderId],
  );
  return rows.map(toActionItem);
}

export async function listMeetingActionItems(meetingId: number): Promise<ActionItem[]> {
  const rows = await conn().select<ActionItemRow[]>('SELECT * FROM action_items WHERE meeting_id = $1 ORDER BY id', [
    meetingId,
  ]);
  return rows.map(toActionItem);
}

export async function addActionItem(item: Omit<ActionItem, 'id' | 'createdAt' | 'updatedAt'> & Partial<Pick<ActionItem, 'createdAt' | 'updatedAt'>>): Promise<ActionItem> {
  const createdAt = item.createdAt ?? now();
  const updatedAt = item.updatedAt ?? createdAt;
  const res = await conn().execute(
    `INSERT INTO action_items (folder_id, meeting_id, text, description, owner, status, first_seen_meeting, last_update_meeting,
       source_ms, parent_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      item.folderId,
      item.meetingId,
      item.text,
      item.description ?? null,
      item.owner,
      item.status,
      item.firstSeenMeeting,
      item.lastUpdateMeeting,
      item.sourceMs,
      item.parentId ?? null,
      createdAt,
      updatedAt,
    ],
  );
  if (res.lastInsertId == null) throw new Error('addActionItem: no id returned');
  await touchItemMeeting(item.meetingId);
  if (item.meetingId == null) await touchFolder(item.folderId);
  return { ...item, id: Number(res.lastInsertId), createdAt, updatedAt };
}

const ACTION_ITEM_COLUMNS: Record<string, string> = {
  text: 'text',
  description: 'description',
  owner: 'owner',
  status: 'status',
  firstSeenMeeting: 'first_seen_meeting',
  lastUpdateMeeting: 'last_update_meeting',
  sourceMs: 'source_ms',
  meetingId: 'meeting_id',
  parentId: 'parent_id',
};

export async function updateActionItem(
  id: number,
  patch: Partial<Pick<ActionItem, 'text' | 'description' | 'owner' | 'status' | 'firstSeenMeeting' | 'lastUpdateMeeting' | 'sourceMs' | 'meetingId' | 'parentId'>>,
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const col = ACTION_ITEM_COLUMNS[key];
    if (!col || value === undefined) continue;
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  }
  if (!sets.length) return;
  params.push(now());
  sets.push(`updated_at = $${params.length}`);
  params.push(id);
  await conn().execute(`UPDATE action_items SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
  const rows = await conn().select<{ meeting_id: number | null; folder_id: number | null }[]>(
    'SELECT meeting_id, folder_id FROM action_items WHERE id = $1',
    [id],
  );
  await touchItemMeeting(rows[0]?.meeting_id ?? null);
  await touchFolder(rows[0]?.folder_id ?? null);
}

export async function deleteActionItem(id: number): Promise<void> {
  const rows = await conn().select<{ meeting_id: number | null; folder_id: number | null }[]>(
    'SELECT meeting_id, folder_id FROM action_items WHERE id = $1',
    [id],
  );
  // Its subtasks stay, as ordinary tasks.
  await conn().execute('UPDATE action_items SET parent_id = NULL WHERE parent_id = $1', [id]);
  await conn().execute('DELETE FROM action_items WHERE id = $1', [id]);
  await touchItemMeeting(rows[0]?.meeting_id ?? null);
  await touchFolder(rows[0]?.folder_id ?? null);
}

// Moving a meeting to another folder takes the items it started along.
export async function moveMeetingActionItems(meetingId: number, folderId: number | null): Promise<void> {
  await conn().execute('UPDATE action_items SET folder_id = $1 WHERE meeting_id = $2', [folderId, meetingId]);
}

// Action items that no meeting bundle carries.
export async function listUnattachedActionItems(folderId: number): Promise<ActionItem[]> {
  const rows = await conn().select<ActionItemRow[]>(
    'SELECT * FROM action_items WHERE folder_id = $1 AND meeting_id IS NULL ORDER BY id',
    [folderId],
  );
  return rows.map(toActionItem);
}
