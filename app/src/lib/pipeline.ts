// Media ingest and transcription jobs: everything between "a file exists" and
// "the meeting has a transcript".
import { appDataDir, join } from '@tauri-apps/api/path';
import { exists, mkdir, remove } from '@tauri-apps/plugin-fs';
import { create } from 'zustand';
import { errorMessage, toast } from '../components/ui';
import * as db from './db';
import * as native from './native';
import { getProvider } from './providers';
import type { ProviderResult } from './providers/types';
import { getSecret } from './secrets';
import { buildSegments, labelSpeakers, languageMix } from './segments';
import { getSettings } from './settings';
import type { ProviderId } from './types';

export type JobStage = 'preparing' | 'extracting' | 'uploading' | 'transcribing' | 'saving' | 'done' | 'error';

export interface Job {
  meetingId: number;
  stage: JobStage;
  message: string; // human-readable, e.g. "Transcribing desktop audio with Soniox…"
  error?: string;
}

interface JobsState {
  jobs: Record<number, Job>;
}

// Live progress for meetings being processed. UI reads it with
// `useJobs((s) => s.jobs[meetingId])`.
export const useJobs = create<JobsState>(() => ({ jobs: {} }));

function setJob(job: Job): void {
  useJobs.setState((s) => ({ jobs: { ...s.jobs, [job.meetingId]: job } }));
}

// Drops a finished job after a delay, unless a newer run replaced it.
function clearJobLater(meetingId: number, job: Job, delayMs: number): void {
  setTimeout(() => {
    useJobs.setState((s) => {
      if (s.jobs[meetingId] !== job) return s;
      const { [meetingId]: _, ...rest } = s.jobs;
      return { jobs: rest };
    });
  }, delayMs);
}

// ---------------------------------------------------------------------------
// Paths

// Extensions WebView2 can play directly. Everything else (mkv, flv, ts, avi,
// wmv, …) is remuxed to MP4 first.
const PLAYABLE = new Set(['mp4', 'm4v', 'mov', 'm4a', 'mp3', 'wav', 'ogg', 'oga', 'opus', 'webm', 'flac', 'aac']);

function extension(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function withoutExtension(path: string): string {
  const ext = extension(path);
  return ext ? path.slice(0, -(ext.length + 1)) : path;
}

// "C:\rec\call.mkv" → "C:\rec\call.mp4", or "call (2).mp4" if that's taken.
async function freeMp4PathNextTo(source: string): Promise<string> {
  const base = withoutExtension(source);
  let candidate = `${base}.mp4`;
  for (let n = 2; await exists(candidate); n++) candidate = `${base} (${n}).mp4`;
  return candidate;
}

async function meetingDir(meetingId: number, ...parts: string[]): Promise<string> {
  const dir = await join(await appDataDir(), 'meetings', String(meetingId), ...parts);
  await mkdir(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Ingest

// Takes a finished OBS recording or a user-picked file: creates the meeting,
// remuxes .mkv to .mp4 if needed, probes duration, then starts transcription
// in the background if `autoTranscribe` is on. Resolves with the meeting id as
// soon as the meeting row exists (before transcription finishes).
// `fromRecording`: the file is our own OBS output, so the .mkv may be deleted
// after remuxing (per the keepOriginalMkv setting). Never delete imported files.
export async function ingestMedia(
  path: string,
  title: string,
  opts: { fromRecording?: boolean } = {},
): Promise<number> {
  const settings = getSettings();
  const info = await native.probeMedia(path, settings.ffmpegPath);

  const id = await db.createMeeting({
    title,
    sourcePath: path,
    mediaPath: null,
    status: 'queued',
    durationMs: info.durationMs,
  });

  let mediaPath = path;
  let sourcePath: string | null = path;
  if (!PLAYABLE.has(extension(path))) {
    try {
      // Recordings live in the user's recordings folder already; imported
      // files are someone else's, so we keep our copy in app data instead.
      const output = opts.fromRecording
        ? await freeMp4PathNextTo(path)
        : await join(await meetingDir(id), 'media.mp4');
      await native.remuxToMp4({ input: path, output, ffmpegPath: settings.ffmpegPath });
      mediaPath = output;

      if (opts.fromRecording && !settings.keepOriginalMkv) {
        try {
          await remove(path);
          sourcePath = output;
        } catch (err) {
          // Not fatal: the recording stays on disk and sourcePath keeps pointing at it.
          console.warn('Could not delete the original recording', err);
        }
      }
    } catch (err) {
      const message = `Couldn't convert the recording for playback: ${errorMessage(err)}`;
      await db.updateMeeting(id, { status: 'error', error: message });
      emitMeetingChanged(id);
      toast(message, 'error');
      return id;
    }
  }

  await db.updateMeeting(id, { mediaPath, sourcePath, durationMs: info.durationMs });
  emitMeetingChanged(id);

  if (settings.autoTranscribe) void transcribeMeeting(id);
  return id;
}

// ---------------------------------------------------------------------------
// Transcription

// Meetings with a transcription in flight (one job per meeting at a time).
const running = new Set<number>();

// Audio track convention set up in OBS by the recorder:
// track 1 (audioIndex 0) = mic + desktop mix, 2 (1) = mic only, 3 (2) = desktop only.
const MIC_TRACK = 1;
const DESKTOP_TRACK = 2;

// Transcribes a meeting's media with the given provider (default from
// settings) and saves it as a new active transcript. Updates meeting status and
// useJobs while it runs. Never throws: failures end in status 'error'.
export async function transcribeMeeting(meetingId: number, providerId?: ProviderId): Promise<void> {
  if (running.has(meetingId)) return;
  running.add(meetingId);

  const settings = getSettings();
  const provider = getProvider(providerId ?? settings.defaultProvider);
  const workFiles: string[] = [];
  const update = (stage: JobStage, message: string) => setJob({ meetingId, stage, message });

  try {
    update('preparing', 'Preparing…');
    const meeting = await db.getMeeting(meetingId);
    if (!meeting) throw new Error('This meeting no longer exists.');
    const input = meeting.mediaPath ?? meeting.sourcePath;
    if (!input) throw new Error('This meeting has no media file.');

    const apiKey = await getSecret(provider.secret);
    if (!apiKey) throw new Error(`Add your ${provider.name} API key in Settings`);

    await db.updateMeeting(meetingId, { status: 'processing', error: null });
    emitMeetingChanged(meetingId);

    const info = await native.probeMedia(input, settings.ffmpegPath);
    if (info.audioStreams.length === 0) throw new Error('This file has no audio track.');
    const split = settings.splitTracks && info.audioStreams.length >= 3;

    // 1. Extract 16 kHz mono FLAC(s) into the meeting's work folder.
    update('extracting', 'Extracting audio…');
    const workDir = await meetingDir(meetingId, 'work');
    const extract = async (name: string, audioIndex: number | null) => {
      const output = await join(workDir, `${name}.flac`);
      workFiles.push(output);
      await native.extractAudio({ input, output, audioIndex, ffmpegPath: settings.ffmpegPath });
      return output;
    };
    const desktopFile = await extract(split ? 'desktop' : 'mix', split ? DESKTOP_TRACK : null);
    const micFile = split ? await extract('mic', MIC_TRACK) : null;

    // 2. Send to the provider (both tracks in parallel when split).
    const progress = new Map<string, string>();
    const track = (label: string) => (message: string) => {
      progress.set(label, message);
      const stage: JobStage = [...progress.values()].some((m) => /upload/i.test(m)) ? 'uploading' : 'transcribing';
      const text = split ? [...progress].map(([l, m]) => `${l}: ${m}`).join(' · ') : message;
      update(stage, text);
    };
    update('transcribing', `Transcribing with ${provider.name}…`);
    const options = { languages: settings.languages, terms: settings.terms };
    const [desktop, mic] = await Promise.all([
      provider.transcribe(desktopFile, apiKey, { ...options, diarize: true, onProgress: track('Desktop') }),
      micFile
        ? provider.transcribe(micFile, apiKey, { ...options, diarize: false, onProgress: track('Mic') })
        : Promise.resolve<ProviderResult | null>(null),
    ]);

    // 3. Group into segments and save.
    update('saving', 'Saving transcript…');
    const saved = buildTranscript(desktop, mic, settings.selfName);
    const tracks = micFile ? 2 : 1;
    const durationSec = (info.durationMs || desktop.durationMs || 0) / 1000;
    const costUsd = durationSec ? (durationSec / 3600) * provider.usdPerHour * tracks : null;

    await db.createTranscript(
      meetingId,
      { provider: provider.id, model: provider.model, costUsd, languages: saved.languages },
      saved.speakers,
      saved.segments,
    );
    await db.updateMeeting(meetingId, { status: 'ready', error: null });

    const done: Job = { meetingId, stage: 'done', message: 'Transcript ready' };
    setJob(done);
    clearJobLater(meetingId, done, 4000);
    toast(`Transcript ready: ${meeting.title}`, 'success');
  } catch (err) {
    const message = errorMessage(err);
    await db.updateMeeting(meetingId, { status: 'error', error: message }).catch(() => {});
    const failed: Job = { meetingId, stage: 'error', message: 'Transcription failed', error: message };
    setJob(failed);
    clearJobLater(meetingId, failed, 10_000);
    toast(`Transcription failed: ${message}`, 'error');
  } finally {
    for (const file of workFiles) await remove(file).catch(() => {});
    running.delete(meetingId);
    emitMeetingChanged(meetingId);
  }
}

// Turns provider results into the speakers/segments db.createTranscript wants.
// Desktop (or mixed) audio is diarized into "Speaker 1..N"; the mic track, if
// any, is one speaker named after the user.
function buildTranscript(desktop: ProviderResult, mic: ProviderResult | null, selfName: string) {
  const desktopSegments = labelSpeakers(buildSegments(desktop.tokens));

  const speakers: { label: string; name: string | null; isSelf: boolean }[] = [];
  const seen = new Set<string>();
  for (const s of desktopSegments) {
    if (seen.has(s.speaker)) continue;
    seen.add(s.speaker);
    speakers.push({ label: s.speaker, name: null, isSelf: false });
  }

  let micSegments: { speaker: string; startMs: number; endMs: number; text: string }[] = [];
  if (mic && mic.tokens.some((t) => t.text.trim())) {
    // Labels must be unique within the transcript.
    let selfLabel = selfName.trim() || 'Me';
    if (seen.has(selfLabel)) selfLabel = `${selfLabel} (mic)`;
    // Ignore any speaker ids: the mic track is one known person.
    micSegments = buildSegments(mic.tokens.map((t) => ({ ...t, speaker: undefined }))).map((s) => ({
      ...s,
      speaker: selfLabel,
    }));
    if (micSegments.length) speakers.push({ label: selfLabel, name: null, isSelf: true });
  }

  const segments = [...desktopSegments, ...micSegments]
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
    .map((s) => ({ speakerLabel: s.speaker, startMs: s.startMs, endMs: s.endMs, text: s.text }));

  const languages = languageMix([...desktop.tokens, ...(mic?.tokens ?? [])]) ?? null;
  return { speakers, segments, languages };
}

// ---------------------------------------------------------------------------
// Change notifications

// Events other screens can subscribe to so lists refresh when processing ends.
type Listener = (meetingId: number) => void;
const listeners = new Set<Listener>();
export function onMeetingChanged(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function emitMeetingChanged(meetingId: number): void {
  for (const fn of listeners) fn(meetingId);
}
