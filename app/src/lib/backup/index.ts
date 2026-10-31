// Backup and restore: cloud backup to S3-compatible storage (AWS S3, R2, MinIO,
// …) and zip export/import. Both use the bundle format (bundle.ts,
// folderBundle.ts) and go through the common importers, which match meetings
// and folders by uid. It's backup for one computer at a time, not two-way
// sync: meetings deleted here stay in the bucket, and a restore never deletes
// anything locally.
//
//   shared.ts   manifest, progress store, local media files
//   cloud.ts    bucket settings and layout
//   backup.ts   uploading, automatic backup
//   restore.ts  restoring from the bucket, media downloads
//   zip.ts      zip export/import and sharing one meeting
export {
  MANIFEST_FILE,
  formatBytes,
  useBackup,
  type BackupManifest,
  type BackupProgress,
  type ManifestFile,
  type ManifestFolder,
  type ManifestMeeting,
} from './shared';
export { isBackupConfigured, loadS3Config, remotePrefix } from './cloud';
export { backupNow, initBackup, type BackupResult } from './backup';
export {
  downloadAllMedia,
  downloadMedia,
  listRemote,
  remoteMediaFor,
  restoreFromCloud,
  type RemoteListing,
  type RemoteMeeting,
  type RestoreResult,
} from './restore';
export {
  SHARE_EXT,
  exportZip,
  importZip,
  inspectZip,
  type ShareOptions,
  type SharedImportOptions,
  type SingleMeetingZip,
  type ZipImportResult,
  type ZipSelection,
} from './zip';
