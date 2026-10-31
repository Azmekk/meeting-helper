// Typed wrappers around the Rust commands in src-tauri/src. The command names
// and argument shapes here are the contract with the Rust side.
import { Channel, invoke } from '@tauri-apps/api/core';

export interface AudioStream {
  // Position among the file's audio streams (0 = first audio track), as used
  // by ffmpeg's `-map 0:a:N`.
  audioIndex: number;
  codec: string;
  channels: number;
  title: string | null;
}

export interface MediaInfo {
  durationMs: number;
  hasVideo: boolean;
  videoCodec: string | null;
  audioStreams: AudioStream[];
}

export interface HttpResponse {
  status: number;
  body: string;
}

// Returns the `ffmpeg -version` first line. Throws if ffmpeg/ffprobe can't run.
// `ffmpegPath` is the user setting: '' means "find ffmpeg and ffprobe on PATH",
// otherwise the full path to ffmpeg.exe (ffprobe.exe is expected next to it).
export function ffmpegVersion(ffmpegPath: string): Promise<string> {
  return invoke('ffmpeg_version', { ffmpegPath });
}

export function probeMedia(path: string, ffmpegPath: string): Promise<MediaInfo> {
  return invoke('probe_media', { path, ffmpegPath });
}

// Writes 16 kHz mono FLAC. `audioIndex` null = mix all audio streams together.
export function extractAudio(args: {
  input: string;
  output: string;
  audioIndex: number | null;
  ffmpegPath: string;
}): Promise<void> {
  return invoke('extract_audio', args);
}

// Copies every stream into an MP4 container without re-encoding (fast). Used
// to turn OBS .mkv recordings into something the player can open.
export function remuxToMp4(args: { input: string; output: string; ffmpegPath: string }): Promise<void> {
  return invoke('remux_to_mp4', args);
}

// Streams a local file to a multipart/form-data endpoint. Used for audio
// uploads, which are too large and too slow for the webview fetch.
export function uploadMultipart(args: {
  url: string;
  headers: Record<string, string>;
  fields: [string, string][]; // repeated names allowed
  fileField: string;
  filePath: string;
  timeoutSecs: number;
}): Promise<HttpResponse> {
  return invoke('upload_multipart', args);
}

export interface CopyProgress {
  done: number; // bytes (a same-drive rename reports 1 of 1)
  total: number;
}

function progressChannel(onProgress?: (p: CopyProgress) => void): Channel<CopyProgress> {
  const ch = new Channel<CopyProgress>();
  if (onProgress) ch.onmessage = onProgress;
  return ch;
}

// Moves a file or directory to `dst` (which must not exist, parents are
// created): a rename on the same drive, copy-then-delete across drives.
export function movePath(src: string, dst: string, onProgress?: (p: CopyProgress) => void): Promise<void> {
  return invoke('move_path', { src, dst, onProgress: progressChannel(onProgress) });
}

// Copies a file or directory to `dst` (which must not exist), with progress.
export function copyFileProgress(src: string, dst: string, onProgress?: (p: CopyProgress) => void): Promise<void> {
  return invoke('copy_file_progress', { src, dst, onProgress: progressChannel(onProgress) });
}

// ---------- Phase 6: backup (bundle.rs, s3.rs) ----------

// Writes a zip: whole directories under a prefix (minus `skip` top-level
// names) plus single files. Resolves with the number of files written.
export function exportZip(
  args: {
    entries: { srcDir: string; zipPrefix: string; skip?: string[] }[];
    extraFiles: { src: string; zipPath: string }[];
    outPath: string;
  },
  onProgress?: (p: CopyProgress) => void,
): Promise<number> {
  return invoke('export_zip', { args, onProgress: progressChannel(onProgress) });
}

// Unpacks a zip into `destDir`; resolves with the '/'-separated relative paths
// written. Rejects zips with unsafe paths (`..`, absolute) before writing.
export function importZip(args: { zipPath: string; destDir: string }, onProgress?: (p: CopyProgress) => void): Promise<string[]> {
  return invoke('import_zip', { args, onProgress: progressChannel(onProgress) });
}

// One text entry of a zip (e.g. manifest.json) without unpacking it; null when
// it isn't there.
export function readZipText(zipPath: string, name: string): Promise<string | null> {
  return invoke('read_zip_text', { zipPath, name });
}

export interface S3Config {
  endpoint: string;
  region: string; // 'auto' for R2
  bucket: string;
  pathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface S3Object {
  key: string;
  size: number;
  etag: string | null;
  lastModified: string | null;
}

export interface TransferProgress {
  done: number;
  total: number;
  // Set once a multipart upload started; pass it back to resume.
  uploadId: string | null;
}

function transferChannel(onProgress?: (p: TransferProgress) => void): Channel<TransferProgress> {
  const ch = new Channel<TransferProgress>();
  if (onProgress) ch.onmessage = onProgress;
  return ch;
}

// Lists, then writes and deletes a small test object under `prefix`.
export function s3Test(config: S3Config, prefix: string): Promise<void> {
  return invoke('s3_test', { config, prefix });
}

export function s3List(config: S3Config, prefix: string): Promise<S3Object[]> {
  return invoke('s3_list', { config, prefix });
}

// Files over 100 MB go up in parts; resumeUploadId continues such an upload.
export function s3PutFile(
  config: S3Config,
  key: string,
  path: string,
  resumeUploadId: string | null,
  onProgress?: (p: TransferProgress) => void,
): Promise<{ etag: string | null; size: number }> {
  return invoke('s3_put_file', { config, key, path, resumeUploadId, onProgress: transferChannel(onProgress) });
}

export function s3GetFile(config: S3Config, key: string, path: string, onProgress?: (p: TransferProgress) => void): Promise<number> {
  return invoke('s3_get_file', { config, key, path, onProgress: transferChannel(onProgress) });
}

export function s3PutText(config: S3Config, key: string, text: string, contentType = 'application/json'): Promise<{ etag: string | null; size: number }> {
  return invoke('s3_put_bytes', { config, key, body: Array.from(new TextEncoder().encode(text)), contentType });
}

// Null when the object doesn't exist.
export async function s3GetText(config: S3Config, key: string): Promise<string | null> {
  const bytes = await invoke<number[] | null>('s3_get_bytes', { config, key });
  return bytes ? new TextDecoder().decode(new Uint8Array(bytes)) : null;
}

export function s3Delete(config: S3Config, key: string): Promise<void> {
  return invoke('s3_delete', { config, key });
}
