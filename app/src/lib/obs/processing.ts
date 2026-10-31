// After a recording: transcribe / summarise?
//
// Recordings are never processed automatically; ProcessingDialog asks. live.ts
// offers it as soon as a live meeting stops (while the import still runs); each
// meeting is offered once, so the import doesn't open a second dialog.
import * as db from '../db';
import { useRecorder, type ProcessingOffer } from './store';

const set = useRecorder.setState;

const offeredIds = new Set<number>();

export function offerProcessing(offer: ProcessingOffer): void {
  if (offeredIds.has(offer.meetingId)) return;
  offeredIds.add(offer.meetingId);
  set((s) => ({ processing: [...s.processing, offer] }));
}

export function dismissProcessing(meetingId: number): void {
  set((s) => ({ processing: s.processing.filter((p) => p.meetingId !== meetingId) }));
}

export async function offerFinished(meetingId: number) {
  const m = await db.getMeeting(meetingId).catch(() => null);
  // Conversion failed: the meeting page shows the error instead.
  if (!m || m.status === 'error' || !m.mediaPath) return;
  const live = await db.hasLiveTranscript(meetingId).catch(() => false);
  offerProcessing({ meetingId, durationMs: m.durationMs ?? 0, live });
}
