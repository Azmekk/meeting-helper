// The connection, and the change tracking every write goes through.
//
// plugin-sql caveats the database modules are written around:
// - It uses a connection pool, so BEGIN/COMMIT can't span several execute()
//   calls; multi-step writes clean up after themselves on failure instead.
// - PRAGMA foreign_keys is per connection, so child rows are deleted
//   explicitly rather than through ON DELETE CASCADE.
import Database from '@tauri-apps/plugin-sql';
import type { AiScope } from '../types';
import { now } from './helpers';
import { MIGRATIONS } from './migrations';

let db: Database | null = null;

export function conn(): Database {
  if (!db) throw new Error('Database not initialised (initDb was not called)');
  return db;
}

// Opens the database and applies migrations. Called once at startup.
export async function initDb(): Promise<void> {
  if (db) return;
  const d = await Database.load('sqlite:meeting-helper.db');
  try {
    await d.execute('PRAGMA journal_mode = WAL');
  } catch {
    /* not essential */
  }
  const rows = await d.select<{ user_version: number }[]>('PRAGMA user_version');
  const current = Number(rows[0]?.user_version ?? 0);
  for (let v = current; v < MIGRATIONS.length; v++) {
    for (const step of MIGRATIONS[v]) {
      if (typeof step === 'string') await d.execute(step);
      else await step(d);
    }
    await d.execute(`PRAGMA user_version = ${v + 1}`);
  }
  db = d;
}

// Every write that changes a meeting's content bumps meetings.updated_at so
// backup can tell what changed. Each entry resolves the meeting from a child id.
const TOUCH_SQL = {
  meeting: 'UPDATE meetings SET updated_at = $1 WHERE id = $2',
  transcript: 'UPDATE meetings SET updated_at = $1 WHERE id = (SELECT meeting_id FROM transcripts WHERE id = $2)',
  segment: `UPDATE meetings SET updated_at = $1 WHERE id = (
    SELECT t.meeting_id FROM segments s JOIN transcripts t ON t.id = s.transcript_id WHERE s.id = $2)`,
  speaker: `UPDATE meetings SET updated_at = $1 WHERE id = (
    SELECT t.meeting_id FROM speakers sp JOIN transcripts t ON t.id = sp.transcript_id WHERE sp.id = $2)`,
} as const;

export async function touch(kind: keyof typeof TOUCH_SQL, id: number): Promise<void> {
  await conn().execute(TOUCH_SQL[kind], [now(), id]);
}

// Only meeting-scoped data counts as meeting content for backup.
export async function touchOwner(scope: AiScope, ownerId: number): Promise<void> {
  if (scope === 'meeting') await touch('meeting', ownerId);
  else await touchFolder(ownerId);
}

// Items are part of their meeting's bundle, so changes count as meeting content.
export async function touchItemMeeting(meetingId: number | null): Promise<void> {
  if (meetingId != null) await touch('meeting', meetingId);
}

// Folder-level data (folder summary, chat, templates, unattached action items)
// lives in folder.json; folders.updated_at tells backup and the sidecar writer
// that it changed.
export async function touchFolder(folderId: number | null): Promise<void> {
  if (folderId != null) await conn().execute('UPDATE folders SET updated_at = $1 WHERE id = $2', [now(), folderId]);
}

export async function touchTemplateFolder(templateId: number): Promise<void> {
  await conn().execute(
    'UPDATE folders SET updated_at = $1 WHERE id = (SELECT folder_id FROM extraction_templates WHERE id = $2)',
    [now(), templateId],
  );
}
