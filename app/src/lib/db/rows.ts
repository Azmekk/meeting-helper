// Database rows, and how they map to the app's types.
import type { ActionItem, ActionItemStatus, AiDoc, AiDocKind, AiScope, ChatMessage, Folder, Meeting, MeetingStatus, ProviderId, Segment, Speaker, TaskProposal, Transcript, TranscriptSource } from '../types';
import { splitTerms } from './helpers';

export interface MeetingRow {
  id: number;
  uid: string;
  title: string;
  created_at: string;
  duration_ms: number | null;
  source_path: string | null;
  media_path: string | null;
  status: MeetingStatus;
  error: string | null;
  active_transcript_id: number | null;
  folder_id: number | null;
  dir_path: string | null;
  updated_at: string | null;
  briefing: string | null;
  split_tracks: number | null;
  terms: string | null;
}

export interface FolderRow {
  id: number;
  uid: string;
  name: string;
  dir_name: string;
  created_at: string;
  briefing: string | null;
  terms: string | null;
}

export interface TranscriptRow {
  id: number;
  meeting_id: number;
  provider: ProviderId;
  model: string;
  source: TranscriptSource | null;
  created_at: string;
  cost_usd: number | null;
  languages: string | null;
}

export interface SpeakerRow {
  id: number;
  transcript_id: number;
  label: string;
  name: string | null;
  is_self: number;
}

export interface SegmentRow {
  id: number;
  transcript_id: number;
  speaker_id: number | null;
  start_ms: number;
  end_ms: number;
  text: string;
  edited: number;
}

export const toMeeting = (r: MeetingRow): Meeting => ({
  id: r.id,
  uid: r.uid,
  title: r.title,
  createdAt: r.created_at,
  durationMs: r.duration_ms,
  sourcePath: r.source_path,
  mediaPath: r.media_path,
  status: r.status,
  error: r.error,
  activeTranscriptId: r.active_transcript_id,
  folderId: r.folder_id,
  dirPath: r.dir_path,
  updatedAt: r.updated_at ?? r.created_at,
  briefing: r.briefing,
  splitTracks: r.split_tracks == null ? null : !!r.split_tracks,
  terms: splitTerms(r.terms),
});

export const toFolder = (r: FolderRow): Folder => ({
  id: r.id,
  uid: r.uid,
  name: r.name,
  dirName: r.dir_name,
  createdAt: r.created_at,
  briefing: r.briefing,
  terms: splitTerms(r.terms),
});

export const toTranscript = (r: TranscriptRow): Transcript => ({
  id: r.id,
  meetingId: r.meeting_id,
  provider: r.provider,
  model: r.model,
  source: r.source ?? 'async',
  createdAt: r.created_at,
  costUsd: r.cost_usd,
  languages: r.languages,
});

export const toSpeaker = (r: SpeakerRow): Speaker => ({
  id: r.id,
  transcriptId: r.transcript_id,
  label: r.label,
  name: r.name,
  isSelf: !!r.is_self,
});

export const toSegment = (r: SegmentRow): Segment => ({
  id: r.id,
  transcriptId: r.transcript_id,
  speakerId: r.speaker_id,
  startMs: r.start_ms,
  endMs: r.end_ms,
  text: r.text,
  edited: !!r.edited,
});

export interface AiDocRow {
  id: number;
  scope: AiScope;
  owner_id: number;
  kind: AiDocKind;
  content: string;
  model: string | null;
  created_at: string;
  cost_usd: number | null;
}

export interface ChatMessageRow {
  id: number;
  scope: AiScope;
  owner_id: number;
  role: 'user' | 'assistant';
  content: string;
  conversation_id: number | null;
  proposal: string | null;
  created_at: string;
  model: string | null;
  cost_usd: number | null;
  cached_percent: number | null;
}

export const toAiDoc = (r: AiDocRow): AiDoc => ({
  id: r.id,
  scope: r.scope,
  ownerId: r.owner_id,
  kind: r.kind,
  content: r.content,
  model: r.model,
  createdAt: r.created_at,
  costUsd: r.cost_usd,
});

export const toChatMessage = (r: ChatMessageRow): ChatMessage => ({
  id: r.id,
  scope: r.scope,
  ownerId: r.owner_id,
  role: r.role,
  content: r.content,
  createdAt: r.created_at,
  conversationId: r.conversation_id,
  proposal: parseProposal(r.proposal),
  model: r.model,
  costUsd: r.cost_usd,
  cachedPercent: r.cached_percent,
});

function parseProposal(raw: string | null): TaskProposal | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TaskProposal;
  } catch {
    return null;
  }
}

export interface ActionItemRow {
  id: number;
  folder_id: number | null;
  meeting_id: number | null;
  text: string;
  owner: string | null;
  status: ActionItemStatus;
  first_seen_meeting: number | null;
  last_update_meeting: number | null;
  source_ms: number | null;
  parent_id: number | null;
  created_at: string;
  updated_at: string;
}

export const toActionItem = (r: ActionItemRow): ActionItem => ({
  id: r.id,
  folderId: r.folder_id,
  meetingId: r.meeting_id,
  text: r.text,
  owner: r.owner,
  status: r.status,
  firstSeenMeeting: r.first_seen_meeting,
  lastUpdateMeeting: r.last_update_meeting,
  sourceMs: r.source_ms,
  parentId: r.parent_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
