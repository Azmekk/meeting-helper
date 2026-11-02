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
  uid: string; // stable across machines; matches meeting bundles on import
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
  folderId: number | null;
  // The meeting's own directory under the base folder, once it has one.
  dirPath: string | null;
  updatedAt: string; // ISO 8601; bumped on every content change (backup uses it)
  briefing: string | null; // user context added to AI prompts
  // Transcribe the mic on its own; null = follow the setting. Off when someone
  // else was in the room, so their voice isn't labelled as the user.
  splitTracks: boolean | null;
  // Extra vocabulary for this meeting, on top of the folder's and the default.
  terms: string[];
}

// One level of grouping; each folder is also a real directory (`dirName`)
// under the user's base folder.
export interface Folder {
  id: number;
  uid: string;
  name: string;
  dirName: string;
  createdAt: string; // ISO 8601
  briefing: string | null;
  terms: string[]; // vocabulary for every meeting in the folder
}

// 'async': batch transcription after recording; 'live': streamed while recording.
export type TranscriptSource = 'async' | 'live';

// One run of a provider over a meeting. A meeting can have several (e.g. one
// per provider) and the user picks which one is active.
export interface Transcript {
  id: number;
  meetingId: number;
  provider: ProviderId;
  model: string;
  source: TranscriptSource;
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

// AI output attached to a meeting or folder (summaries, live notes).
export type AiScope = 'meeting' | 'folder';
// 'folder_state': JSON bookkeeping for folder AI (which meetings were folded in).
export type AiDocKind = 'summary' | 'notes' | 'folder_summary' | 'folder_state';

export interface AiDoc {
  id: number;
  scope: AiScope;
  ownerId: number;
  kind: AiDocKind;
  content: string; // Markdown with [#segId] citations
  model: string | null;
  createdAt: string; // ISO 8601
  costUsd: number | null;
}

export interface ChatMessage {
  id: number;
  scope: AiScope;
  ownerId: number;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string; // ISO 8601
}

// ---------- Folder AI (progress tracking, extraction) ----------

// 'suggested': the AI found it but it isn't a firm commitment; waits for the user to accept.
export type ActionItemStatus = 'suggested' | 'open' | 'done' | 'dropped';

// A task tracked across a folder's meetings. `meetingId`/`sourceMs` point at
// where it first came up; `lastUpdateMeeting` at the meeting that last changed it.
export interface ActionItem {
  id: number;
  folderId: number | null;
  meetingId: number | null;
  text: string;
  owner: string | null;
  status: ActionItemStatus;
  firstSeenMeeting: number | null;
  lastUpdateMeeting: number | null;
  sourceMs: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExtractionField {
  name: string;
  description: string;
}

export interface ExtractionTemplate {
  id: number;
  folderId: number;
  name: string;
  fields: ExtractionField[];
  createdAt: string;
}

export interface ExtractionRow {
  id: number;
  templateId: number;
  meetingId: number;
  values: Record<string, string | null>;
  createdAt: string;
}
