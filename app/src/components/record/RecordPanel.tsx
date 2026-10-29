import { ArrowRight, Pause, Play, Square } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  defaultMeetingTitle,
  pauseRecording,
  resumeRecording,
  setRecordingTitle,
  startRecording,
  stopRecording,
  useRecorder,
} from '../../lib/obs';
import { Button, Callout, Card, Input, Spinner, clsx, errorMessage, toast } from '../ui';

function pad(n: number) {
  return String(n).padStart(2, '0');
}

function formatElapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function useElapsed(startedAt: number | null, pausedAt: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt == null || pausedAt != null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [startedAt, pausedAt]);
  if (startedAt == null) return 0;
  return (pausedAt ?? now) - startedAt;
}

export default function RecordPanel() {
  const navigate = useNavigate();
  const connected = useRecorder((s) => s.connected);
  const recording = useRecorder((s) => s.recording);
  const startedAt = useRecorder((s) => s.startedAt);
  const paused = useRecorder((s) => s.paused);
  const pausedAt = useRecorder((s) => s.pausedAt);
  const busy = useRecorder((s) => s.busy);
  const title = useRecorder((s) => s.title);
  const lastIngest = useRecorder((s) => s.lastIngest);
  const restartNeeded = useRecorder((s) => s.restartNeeded);
  const elapsed = useElapsed(startedAt, paused ? pausedAt : null);

  const [placeholder] = useState(() => defaultMeetingTitle());

  async function act(fn: () => Promise<void>) {
    try {
      await fn();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  const onBigButton = () => void act(recording ? stopRecording : startRecording);

  return (
    <Card padded={false}>
      <div className="flex flex-col items-center gap-6 px-6 py-10 sm:flex-row sm:items-center sm:gap-10 sm:px-10">
        <button
          type="button"
          onClick={onBigButton}
          disabled={!connected || busy !== null}
          aria-label={recording ? 'Stop recording' : 'Start recording'}
          title={recording ? 'Stop recording' : connected ? 'Start recording' : 'Connect to OBS first'}
          className={clsx(
            'group relative flex h-28 w-28 shrink-0 items-center justify-center rounded-full transition-all',
            'focus-visible:outline-offset-4 disabled:cursor-not-allowed',
            recording
              ? 'bg-rec shadow-[0_0_0_8px_var(--c-danger-soft)] hover:brightness-110'
              : 'border border-line bg-panel shadow-md hover:shadow-lg disabled:opacity-50 disabled:shadow-none',
          )}
        >
          {busy ? (
            <Spinner size={28} className={recording ? 'text-white' : undefined} />
          ) : recording ? (
            <Square size={30} className="fill-white text-white" />
          ) : (
            <span className="h-12 w-12 rounded-full bg-rec transition-transform group-hover:scale-105 group-disabled:scale-100" />
          )}
        </button>

        <div className="w-full min-w-0 flex-1 space-y-4">
          <div className="flex items-center gap-3">
            {recording && (
              <span className="relative flex h-2.5 w-2.5">
                {!paused && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rec opacity-60" />}
                <span className={clsx('relative inline-flex h-2.5 w-2.5 rounded-full', paused ? 'bg-faint' : 'bg-rec')} />
              </span>
            )}
            <span
              className={clsx(
                'font-mono text-4xl font-semibold tracking-tight tabular-nums',
                recording ? 'text-text' : 'text-faint',
              )}
            >
              {formatElapsed(elapsed)}
            </span>
            {recording && (
              <span className={clsx('text-xs font-medium tracking-wide uppercase', paused ? 'text-muted' : 'text-rec')}>
                {paused ? 'Paused' : 'Recording'}
              </span>
            )}
          </div>

          <Input
            value={title}
            onChange={(e) => setRecordingTitle(e.target.value)}
            placeholder={placeholder}
            aria-label="Meeting title"
            className="h-11 text-[15px]"
          />

          <div className="flex flex-wrap items-center gap-2">
            {recording ? (
              <>
                <Button
                  icon={paused ? Play : Pause}
                  onClick={() => void act(paused ? resumeRecording : pauseRecording)}
                  disabled={busy !== null}
                >
                  {paused ? 'Resume' : 'Pause'}
                </Button>
                <Button
                  variant="danger"
                  icon={Square}
                  onClick={() => void act(stopRecording)}
                  loading={busy === 'stopping'}
                >
                  Stop
                </Button>
              </>
            ) : null}
            <span className="text-xs text-muted">
              {!connected
                ? 'Connect to OBS below to record.'
                : recording
                  ? 'You can rename the meeting until you stop.'
                  : busy === 'starting'
                    ? 'Starting…'
                    : 'Press the red button to start. Leave the title empty to name it by date and time.'}
            </span>
          </div>
        </div>
      </div>

      {(restartNeeded || lastIngest) && (
        <div className="space-y-3 border-t border-line px-6 py-4 sm:px-10">
          {restartNeeded && !recording && (
            <Callout tone="warn" title="Restart OBS before recording">
              You changed the encoder or quality. OBS applies that only after a restart.
            </Callout>
          )}
          {lastIngest && (
            <div className="flex items-center justify-between gap-4 text-[13px]">
              <div className="flex min-w-0 items-center gap-2.5">
                {lastIngest.status === 'processing' && <Spinner size={15} />}
                <span className="min-w-0 truncate">
                  {lastIngest.status === 'processing' && <>Processing “{lastIngest.title}”…</>}
                  {lastIngest.status === 'done' && <>“{lastIngest.title}” is saved.</>}
                  {lastIngest.status === 'error' && (
                    <span className="text-danger">
                      Couldn't import “{lastIngest.title}”: {lastIngest.error}
                    </span>
                  )}
                </span>
              </div>
              {lastIngest.meetingId != null && (
                <Button size="sm" variant="ghost" onClick={() => navigate(`/meetings/${lastIngest.meetingId}`)}>
                  Open meeting <ArrowRight size={14} />
                </Button>
              )}
            </div>
          )}
          {lastIngest?.status === 'error' && (
            <div className="truncate font-mono text-xs text-muted" title={lastIngest.path}>
              {lastIngest.path}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
