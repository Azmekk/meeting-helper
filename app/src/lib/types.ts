// Shared domain types. Every module codes against these; change them only
// together with all their users.

export type ProviderId = 'soniox' | 'elevenlabs';

export type MeetingStatus =
  | 'recording' // OBS is still recording into sourcePath
  | 'queued' // media ready, waiting for transcription
  | 'processing' // extracting audio / transcribing / saving
  | 'ready' // has a transcript
  | 'error'; // last processing attempt failed; see `error`

export interface Meeting {
  id: number;
  title: string;
  createdAt: string; // ISO 8601
  durationMs: number | null;
  // The file as recorded/imported (e.g. OBS .mkv). May be deleted after remux.
  sourcePath: string | null;
  // The file the player uses (MP4 or a browser-playable audio file).
  mediaPath: string | null;
  status: MeetingStatus;
  error: string | null;
  activeTranscriptId: number | null;
}

// One run of a provider over a meeting. A meeting can have several (e.g. one
// per provider) and the user picks which one is active.
export interface Transcript {
  id: number;
  meetingId: number;
  provider: ProviderId;
  model: string;
  createdAt: string; // ISO 8601
  costUsd: number | null;
  languages: string | null; // e.g. "bg 91%, en 9%"
}

// Speakers belong to a transcript because provider labels differ per run.
export interface Speaker {
  id: number;
  transcriptId: number;
  label: string; // provider label, e.g. "Speaker 2"
  name: string | null; // user-given name; display name is `name ?? label`
  isSelf: boolean; // came from the microphone track
}

export interface Segment {
  id: number;
  transcriptId: number;
  speakerId: number | null;
  startMs: number;
  endMs: number;
  text: string;
  edited: boolean;
}

export interface TranscriptDetail {
  transcript: Transcript;
  speakers: Speaker[];
  segments: Segment[]; // ordered by startMs
}

export interface SearchHit {
  meetingId: number;
  meetingTitle: string;
  meetingCreatedAt: string;
  transcriptId: number;
  segmentId: number;
  startMs: number;
  endMs: number;
  speakerName: string | null;
  text: string;
}

export function speakerName(s: Pick<Speaker, 'name' | 'label'>): string {
  return s.name?.trim() || s.label;
}
