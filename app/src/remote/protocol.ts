// JSON messages between the main window and the phone page (inside the
// encrypted frames, see crypto.ts). Type-only imports, so no Tauri code ends
// up in the phone bundle.
//
// The PC sends a full `state` when a phone says hello (and whenever the meeting
// changes), then only `delta`s: lines from `fromLine` on (an index into the
// meeting's whole transcript) plus the snapshot fields that changed. Every
// message carries `seq`; a delta is `seq + 1` of the last message, so a phone
// that sees a gap (a frame was dropped, it slept…) asks for a full state again.
import type { LiveAiTask, LiveLine, LiveSnapshot } from '../lib/live';

// Snapshot fields other than the transcript lines.
export type SnapshotPatch = Partial<Omit<LiveSnapshot, 'lines' | 'lineCount'>>;

export type ToPhone =
  | { type: 'state'; seq: number; snap: LiveSnapshot; hidden: boolean; canHide: boolean }
  | {
      type: 'delta';
      seq: number;
      fromLine: number; // lines from this index on are replaced by `lines`
      lines: LiveLine[];
      lineCount: number;
      patch: SnapshotPatch;
      hidden: boolean;
      canHide: boolean;
    };

export type SnapshotDelta = Pick<Extract<ToPhone, { type: 'delta' }>, 'fromLine' | 'lines' | 'lineCount' | 'patch'>;

export type FromPhone =
  | { type: 'hello' }
  | { type: 'help' }
  | { type: 'ask'; question: string }
  | { type: 'set-model'; task: LiveAiTask; model: string }
  | { type: 'set-hidden'; hidden: boolean };

// WebSocket close codes sent by remote.rs.
export const CLOSE_REPAIRED = 4001;
export const CLOSE_BAD_KEY = 4002;

// What the phone keeps. `lines` can hold more than one snapshot's worth: deltas
// keep appending (up to PHONE_MAX_LINES); `lineOffset` is the meeting index of
// lines[0].
export interface PhoneState {
  seq: number;
  snap: LiveSnapshot;
  lineOffset: number;
  hidden: boolean;
  canHide: boolean;
}

export const PHONE_MAX_LINES = 400;

// Applies a message; returns null when the phone has to resync (gap, or a
// delta before any state).
export function applyToPhone(prev: PhoneState | null, msg: ToPhone): PhoneState | null {
  if (msg.type === 'state') {
    const { snap } = msg;
    return { seq: msg.seq, snap, lineOffset: snap.lineCount - snap.lines.length, hidden: msg.hidden, canHide: msg.canHide };
  }
  if (!prev || msg.seq !== prev.seq + 1) return null;
  let lines = prev.snap.lines;
  let lineOffset = prev.lineOffset;
  const keep = msg.fromLine - lineOffset;
  if (keep < 0) return null; // the change starts before what we have
  if (msg.lines.length || keep < lines.length) {
    lines = lines.slice(0, keep).concat(msg.lines);
    if (lines.length > PHONE_MAX_LINES) {
      lineOffset += lines.length - PHONE_MAX_LINES;
      lines = lines.slice(-PHONE_MAX_LINES);
    }
  }
  if (lineOffset + lines.length !== msg.lineCount) return null;
  return {
    seq: msg.seq,
    snap: { ...prev.snap, ...msg.patch, lines, lineCount: msg.lineCount },
    lineOffset,
    hidden: msg.hidden,
    canHide: msg.canHide,
  };
}

function sameLine(a: LiveLine | undefined, b: LiveLine | undefined): boolean {
  return !!a && !!b && a.id === b.id && a.text === b.text && a.speaker === b.speaker && a.endMs === b.endMs;
}

// PC side: builds the delta from `prev` to `snap`, or null when a full state is needed.
export function diffSnapshot(prev: LiveSnapshot, snap: LiveSnapshot): SnapshotDelta | null {
  if (prev.meetingId !== snap.meetingId || snap.lineCount < prev.lineCount) return null;
  const prevOffset = prev.lineCount - prev.lines.length;
  const offset = snap.lineCount - snap.lines.length;
  // First meeting index where the lines differ (only the overlap can be compared).
  let fromLine = Math.max(prevOffset, offset);
  while (fromLine < prev.lineCount && sameLine(prev.lines[fromLine - prevOffset], snap.lines[fromLine - offset])) fromLine++;
  // Changed before what the snapshot holds, or more new lines than it holds.
  if (fromLine < offset || fromLine > prev.lineCount) return null;
  const patch: SnapshotPatch = {};
  for (const k of Object.keys(snap) as (keyof LiveSnapshot)[]) {
    if (k === 'lines' || k === 'lineCount') continue;
    const a = prev[k];
    const b = snap[k];
    if (a === b) continue;
    if (typeof b === 'object' && b !== null && JSON.stringify(a) === JSON.stringify(b)) continue;
    (patch as Record<string, unknown>)[k] = b;
  }
  return { fromLine, lines: snap.lines.slice(fromLine - offset), lineCount: snap.lineCount, patch };
}
