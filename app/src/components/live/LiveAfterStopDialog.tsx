// Shown after a recording that was transcribed live: offers the full (batch)
// transcription and a summary instead of starting them automatically.
import { useEffect, useState } from 'react';
import { summarizeMeeting } from '../../lib/ai/meeting';
import * as db from '../../lib/db';
import { dismissAfterStop, useLive } from '../../lib/live';
import { onMeetingChanged, transcribeMeeting } from '../../lib/pipeline';
import { getProvider } from '../../lib/providers';
import { useSettings } from '../../lib/settings';
import type { Meeting } from '../../lib/types';
import { Button, Modal, Spinner, Switch, errorMessage, toast } from '../ui';
import { costLabel } from './shared';

export function LiveAfterStopDialog() {
  const afterStop = useLive((s) => s.afterStop);
  const settings = useSettings((s) => s.settings);
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [transcribe, setTranscribe] = useState(true);
  const [summarize, setSummarize] = useState(true);

  // The recording is still being imported (remuxed) when this opens; batch
  // transcription needs the final media file.
  useEffect(() => {
    if (!afterStop) return;
    let alive = true;
    const load = () =>
      void db.getMeeting(afterStop.meetingId).then((m) => {
        if (alive) setMeeting(m);
      });
    load();
    const off = onMeetingChanged((id) => id === afterStop.meetingId && load());
    return () => {
      alive = false;
      off();
    };
  }, [afterStop]);

  if (!afterStop) return null;
  const provider = getProvider(settings.defaultProvider);
  const durationMs = meeting?.durationMs || afterStop.durationMs;
  const tracks = (meeting?.splitTracks ?? settings.splitTracks) ? 2 : 1;
  const cost = durationMs ? (durationMs / 3_600_000) * provider.usdPerHour * tracks : null;
  const ready = !!meeting && meeting.status !== 'recording' && !!meeting.mediaPath;

  async function go() {
    const id = afterStop!.meetingId;
    dismissAfterStop();
    if (transcribe) {
      // Summarise after the full transcript replaces the live one.
      void transcribeMeeting(id).then(() => (summarize ? runSummary(id) : undefined));
    } else if (summarize) {
      void runSummary(id);
    }
  }

  return (
    <Modal
      open
      onClose={dismissAfterStop}
      title="Live transcript saved"
      footer={
        <>
          <Button variant="ghost" onClick={dismissAfterStop}>
            Not now
          </Button>
          <Button variant="primary" onClick={() => void go()} disabled={!ready || (!transcribe && !summarize)}>
            {!ready ? 'Preparing the recording…' : 'Start'}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-[13px]">
        <p className="text-muted">
          “{meeting?.title ?? 'The meeting'}” has its live transcript. The full transcription is usually more accurate
          (better speaker separation, no missed words while reconnecting).
        </p>
        <label className="flex items-center justify-between gap-4">
          <span>
            Run full transcription with {provider.name} <span className="text-muted">({costLabel(cost)})</span>
          </span>
          <Switch checked={transcribe} onChange={setTranscribe} label="Run full transcription" />
        </label>
        <label className="flex items-center justify-between gap-4">
          <span>
            Generate summary{' '}
            <span className="text-muted">{transcribe ? '(after the full transcription)' : '(from the live transcript)'}</span>
          </span>
          <Switch checked={summarize} onChange={setSummarize} label="Generate summary" />
        </label>
        {!ready && (
          <div className="flex items-center gap-2 text-muted">
            <Spinner size={13} /> Converting the recording…
          </div>
        )}
      </div>
    </Modal>
  );
}

async function runSummary(meetingId: number) {
  try {
    await summarizeMeeting(meetingId);
    toast('Summary ready.', 'success');
  } catch (err) {
    toast(`Couldn't summarise: ${errorMessage(err)}`, 'error');
  }
}
