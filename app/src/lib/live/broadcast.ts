// The LiveSnapshot other windows (overlay, phone remote) get as `live://state`.
import { emit } from '@tauri-apps/api/event';
import { useRecorder } from '../obs';
import { getSettings } from '../settings';
import { answerCostEstimate, liveModel, notesCostEstimate } from './ai';
import { useLive, type LivePartial, type LiveSnapshot } from './store';

const get = useLive.getState;

const SNAPSHOT_LINES = 60;

export function getLiveSnapshot(): LiveSnapshot {
  const s = get();
  const models = { live: liveModel('live'), answer: liveModel('answer') };
  return {
    active: s.active,
    meetingId: s.meetingId,
    error: s.error,
    tracks: s.tracks,
    lines: s.lines.slice(-SNAPSHOT_LINES),
    lineCount: s.lines.length,
    partials: Object.values(s.partials).filter((p): p is LivePartial => !!p),
    notes: s.notes,
    notesBusy: s.notesBusy,
    notesError: s.notesError,
    answer: s.answer,
    models,
    modelOptions: s.modelOptions,
    outputLanguage: getSettings().aiOutputLanguage || 'meeting',
    micMuted: useRecorder.getState().setup?.micMuted ?? null,
    overlaySolid: getSettings().overlaySolid,
    answerCostEstimate: answerCostEstimate(models.answer),
    notesContext: getSettings().liveNotesContext,
    notesCostEstimate: notesCostEstimate(models.live),
    aiCostUsd: s.aiCostUsd,
    aiCachedPercent: s.aiPromptTokens ? Math.round((100 * s.aiCachedTokens) / s.aiPromptTokens) : null,
    notesIntervalMin: getSettings().liveNotesIntervalMin,
    hotkey: getSettings().liveHotkey,
  };
}

let broadcastTimer: ReturnType<typeof setTimeout> | null = null;

export function broadcastNow() {
  if (broadcastTimer) clearTimeout(broadcastTimer);
  broadcastTimer = null;
  void emit('live://state', getLiveSnapshot()).catch(() => {});
}

// Provisional text changes several times a second; 5 updates/s is plenty.
export function scheduleBroadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(broadcastNow, 200);
}
