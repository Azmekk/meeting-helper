// Cloud backup state.
import { conn } from './connection';
import { parseJson } from './helpers';

export interface BackupFile {
  name: string; // file name inside the meeting's remote directory
  role: 'media' | 'source';
  size: number;
  mtime: string | null;
  etag: string | null;
  // An unfinished multipart upload of this file (resumed on the next run).
  uploadId?: string | null;
}

export interface BackupState {
  uid: string;
  kind: 'meeting' | 'folder';
  uploadedAt: string | null;
  updatedAt: string | null; // the meeting/folder updated_at that was uploaded
  files: BackupFile[];
}

interface BackupStateRow {
  uid: string;
  kind: 'meeting' | 'folder';
  uploaded_at: string | null;
  updated_at: string | null;
  files_json: string;
}

const toBackupState = (r: BackupStateRow): BackupState => ({
  uid: r.uid,
  kind: r.kind,
  uploadedAt: r.uploaded_at,
  updatedAt: r.updated_at,
  files: parseJson<BackupFile[]>(r.files_json, []),
});

export async function listBackupState(): Promise<BackupState[]> {
  const rows = await conn().select<BackupStateRow[]>('SELECT * FROM backup_state');
  return rows.map(toBackupState);
}

export async function getBackupState(uid: string): Promise<BackupState | null> {
  const rows = await conn().select<BackupStateRow[]>('SELECT * FROM backup_state WHERE uid = $1', [uid]);
  return rows[0] ? toBackupState(rows[0]) : null;
}

export async function saveBackupState(s: BackupState): Promise<void> {
  await conn().execute(
    `INSERT INTO backup_state (uid, kind, uploaded_at, updated_at, files_json) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT(uid) DO UPDATE SET kind = $2, uploaded_at = $3, updated_at = $4, files_json = $5`,
    [s.uid, s.kind, s.uploadedAt, s.updatedAt, JSON.stringify(s.files)],
  );
}

// Forgets everything uploaded (e.g. after switching to another bucket).
export async function clearBackupState(): Promise<void> {
  await conn().execute('DELETE FROM backup_state');
}
