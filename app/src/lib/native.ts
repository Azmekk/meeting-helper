// Typed wrappers around the Rust commands in src-tauri/src. The command names
// and argument shapes here are the contract with the Rust side.
import { invoke } from '@tauri-apps/api/core';

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
