import { ArrowRight, Hourglass, Mic, MicOff, Pause, Play, Square } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  defaultMeetingTitle,
  pauseRecording,
  resumeRecording,
  setMicMuted,
  setOthersInRoom,
  setRecordingTerms,
  setRecordingTitle,
  startRecording,
  stopRecording,
  trackExternalRecording,
  useRecorder,
} from '../../lib/obs';
import { useSettings } from '../../lib/settings';
import { Button, Callout, Card, Input, Spinner, Switch, clsx, errorMessage, toast } from '../ui';
import FolderPicker from './FolderPicker';
import { TermsField } from '../TermsField';

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
  // Started in OBS itself and ignored in ExternalRecordingDialog.
  const untracked = useRecorder((s) => s.recording && !!s.externalRecording?.ignored);
  const splitTracks = useSettings((s) => s.settings.splitTracks);
  const micMuted = useRecorder((s) => s.setup?.micMuted ?? false);
  const hasMic = useRecorder((s) => !!s.setup?.micInput);
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

  // OBS is busy with a recording the user chose not to track: no meeting
  // controls until it ends, just a way to change their mind or end it.
  if (untracked) {
    return (
      <Card>
        <div className="flex flex-col items-center gap-4 py-6 text-center sm:flex-row sm:gap-6 sm:text-left">
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-fill text-muted">
            <Hourglass size={24} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[17px] font-semibold">Waiting for the OBS recording to end</h2>
            <p className="mt-1 text-[13px] text-muted">
              OBS started recording on its own and you chose not to track it, so it won’t become a meeting. You can
              record a meeting once it ends. Running for{' '}
              <span className="font-mono tabular-nums">{formatElapsed(elapsed)}</span>.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap justify-center gap-2">
            <Button variant="secondary" onClick={() => void act(stopRecording)} loading={busy === 'stopping'}>
              Stop it in OBS
            </Button>
            <Button variant="primary" onClick={trackExternalRecording}>
              Track as meeting
            </Button>
          </div>
        </div>
      </Card>
    );
  }

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

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              value={title}
              onChange={(e) => setRecordingTitle(e.target.value)}
              placeholder={placeholder}
              aria-label="Meeting title"
              className="h-11 min-w-0 flex-1 text-[15px]"
            />
            <div className="sm:w-60">
              <FolderPicker />
            </div>
          </div>

          <AudioOnly recording={recording} />
          {splitTracks && <OthersInRoom recording={recording} />}
          <RecordingTerms recording={recording} />

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
                {hasMic && (
                  <Button
                    icon={micMuted ? MicOff : Mic}
                    onClick={() => void act(() => setMicMuted(!micMuted))}
                    title={micMuted ? 'Your mic is muted in the recording' : 'Mute your mic in the recording and transcript'}
                    className={clsx(micMuted && 'bg-warn-soft! text-warn!')}
                  >
                    {micMuted ? 'Unmute mic' : 'Mute mic'}
                  </Button>
                )}
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
            {untracked && (
              <Button size="sm" variant="ghost" onClick={trackExternalRecording}>
                Track it
              </Button>
            )}
            <span className="text-xs text-muted">
              {!connected
                ? 'Connect to OBS below to record.'
                : untracked
                  ? 'Started in OBS and not tracked: it won’t be saved as a meeting.'
                  : recording
                    ? 'You can rename the meeting or change its folder until you stop.'
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

function AudioOnly({ recording }: { recording: boolean }) {
  const on = useSettings((s) => s.settings.recordAudioOnly);
  return (
    <div className="flex items-start gap-3">
      <Switch
        label="Audio only"
        checked={on}
        disabled={recording}
        onChange={(v) => void useSettings.getState().update({ recordAudioOnly: v })}
      />
      <div className="text-[13px]">
        <div className="font-medium">Audio only</div>
        <div className="text-muted">
          Records your mic and computer sound without your screen, and keeps a small audio file. OBS goes back to its
          scene when you stop.
        </div>
      </div>
    </div>
  );
}

// Only shown while the mic is transcribed on its own (Settings → Recording).
function OthersInRoom({ recording }: { recording: boolean }) {
  const othersInRoom = useRecorder((s) => s.othersInRoom);
  return (
    <div className="flex items-start gap-3">
      <Switch
        label="Someone is here with me"
        checked={othersInRoom}
        onChange={(v) => void setOthersInRoom(v).catch((err) => toast(errorMessage(err), 'error'))}
      />
      <div className="text-[13px]">
        <div className="font-medium">Someone is here with me</div>
        <div className="text-muted">
          Transcribes everyone together instead of labelling your mic as you, so a person next to you isn’t
          mistaken for you.{recording && ' Live transcription keeps the setting it started with.'}
        </div>
      </div>
    </div>
  );
}

// Collapsed unless used: most meetings get by on the default and folder lists.
function RecordingTerms({ recording }: { recording: boolean }) {
  const terms = useRecorder((s) => s.terms);
  const [open, setOpen] = useState(terms.length > 0);
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="self-start text-[13px] text-accent hover:underline">
        Add vocabulary for this meeting
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="recording-terms" className="text-[13px] font-medium">
        Vocabulary for this meeting
      </label>
      <TermsField
        id="recording-terms"
        rows={2}
        terms={terms}
        onSave={(next) => setRecordingTerms(next).catch((err) => toast(errorMessage(err), 'error'))}
      />
      <span className="text-xs text-muted">
        Added to your default list and the folder’s.
        {recording && ' Live transcription keeps the words it started with; the full transcription uses these.'}
      </span>
    </div>
  );
}
