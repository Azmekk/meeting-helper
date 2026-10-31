// S3-compatible storage (AWS S3, R2, MinIO, …): the bucket settings and where
// things live in it, under the configured prefix:
//   <prefix>/manifest.json                    titles, sizes, versions (BackupManifest)
//   <prefix>/meetings/<uid>/meeting.json      the meeting bundle
//   <prefix>/meetings/<uid>/<media files>     recording (and original, if kept)
//   <prefix>/folders/<uid>/folder.json        the folder bundle
import { FOLDER_BUNDLE_FILE } from '../folderBundle';
import type * as native from '../native';
import { getSecret } from '../secrets';
import { getSettings } from '../settings';
import { MANIFEST_FILE } from './shared';

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

export const meetingKey = (uid: string, name: string) => `${remotePrefix()}meetings/${uid}/${name}`;
export const folderKey = (uid: string) => `${remotePrefix()}folders/${uid}/${FOLDER_BUNDLE_FILE}`;
export const manifestKey = () => `${remotePrefix()}${MANIFEST_FILE}`;
