// Live transcription panel on the Record screen: transcript stream, rolling
// notes, "help me answer", per-meeting model pickers and the overlay toggle.
import { AiLanguageSelect } from '../ai/AiLanguageSelect';
import { Lightbulb, MessageSquareText, PanelTopOpen, RefreshCw, Send, Smartphone, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  answerCostEstimate,
  helpMeAnswer,
  notesCostEstimate,
  refreshNotes,
  retryLive,
  setLiveEnabled,
  setOverlayProtected,
  toggleOverlay,
  useLive,
  type LiveTrack,
} from '../../lib/live';
import { useRecorder } from '../../lib/obs';
import { useRemote } from '../../lib/remote';
import { useSettings } from '../../lib/settings';
import { saveSettings } from '../settings/common';
import { LiveModelPicker } from '../live/LiveModelPicker';
import { LineView, PartialView, PlainMarkdown, STATE_LABEL, TRACK_LABEL, hotkeyLabel } from '../live/shared';
import { PhoneLink } from '../remote/PhoneLink';
import { Badge, Button, Callout, Card, Input, Modal, Spinner, Switch, clsx } from '../ui';

export default function LivePanel() {
  const enabled = useSettings((s) => s.settings.liveEnabled);
  const recording = useRecorder((s) => s.recording);
  const active = useLive((s) => s.active);
  const starting = useLive((s) => s.starting);
  const error = useLive((s) => s.error);
  const tracks = useLive((s) => s.tracks);
  const hasData = useLive((s) => s.lines.length > 0 || s.notes !== '' || s.answer != null);

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          Live transcription
          {Object.entries(tracks).map(([t, st]) =>
            st ? (
              <Badge key={t} tone={STATE_LABEL[st.state].tone}>
                {TRACK_LABEL[t as LiveTrack]}: {STATE_LABEL[st.state].text}
              </Badge>
            ) : null,
          )}
          {starting && <Spinner size={13} />}
        </span>
      }
      description="Transcribes while you record (Soniox real-time), keeps notes and helps you answer."
      actions={<Switch label="Live transcription" checked={enabled} onChange={(v) => void setLiveEnabled(v)} />}
    >
      {!enabled && !hasData ? (
        <p className="text-[13px] text-muted">
          Turn on to see the transcript, AI notes and answer suggestions during the meeting. The live transcript is saved
          with the meeting; afterwards you can still run the full transcription.
        </p>
      ) : (
        <div className="space-y-4">
          {error && (
            <Callout tone="error" title="Live transcription stopped">
              {error}
              {recording && enabled && !active && (
                <div className="mt-2">
                  <Button size="sm" icon={RefreshCw} onClick={retryLive}>
                    Try again
                  </Button>
                </div>
              )}
            </Callout>
          )}
          {!recording && !hasData && !error && (
            <p className="text-[13px] text-muted">Starts automatically when you start recording.</p>
          )}
          <OverlayControls />
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
            <TranscriptStream />
            <div className="space-y-4">
              <AnswerBox />
              <NotesBox />
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

function OverlayControls() {
  const open = useLive((s) => s.overlayOpen);
  const protectedOn = useSettings((s) => s.settings.overlayContentProtected);
  const phones = useRemote((s) => (s.status.running ? s.status.clients : 0));
  const [phoneOpen, setPhoneOpen] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
      <div className="flex gap-2">
        <Button size="sm" icon={PanelTopOpen} onClick={() => void toggleOverlay()}>
          {open ? 'Close overlay' : 'Open overlay'}
        </Button>
        <Button size="sm" icon={Smartphone} onClick={() => setPhoneOpen(true)}>
          {phones ? `On phone (${phones})` : 'Use on phone'}
        </Button>
      </div>
      <Modal open={phoneOpen} onClose={() => setPhoneOpen(false)} title="Use on your phone">
        <PhoneLink />
      </Modal>
      <label className="flex items-center gap-2 text-[13px] text-muted">
        <Switch
          checked={protectedOn}
          onChange={(v) => void setOverlayProtected(v)}
          label="Hidden from screen share (Windows)"
        />
        Hidden from screen share (Windows)
      </label>
    </div>
  );
}

function TranscriptStream() {
  const lines = useLive((s) => s.lines);
  const partials = useLive((s) => s.partials);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Follow new text unless the user scrolled up to read.
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines, partials]);

  const open = Object.values(partials).filter((p) => p && (p.final || p.provisional.trim()));
  return (
    <div
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      className="h-[26rem] space-y-1.5 overflow-y-auto rounded-lg border border-line bg-sunken/40 px-3 py-2.5"
    >
      {lines.length === 0 && open.length === 0 && (
        <div className="flex h-full items-center justify-center text-[13px] text-faint">
          <MessageSquareText size={16} className="mr-2" /> The transcript appears here.
        </div>
      )}
      {lines.map((l) => (
        <LineView key={l.id} line={l} />
      ))}
      {open.map((p) => p && <PartialView key={p.track} partial={p} />)}
    </div>
  );
}

function AnswerBox() {
  const answer = useLive((s) => s.answer);
  const active = useLive((s) => s.active);
  // The cost estimate depends on the transcript length and the chosen model.
  useLive((s) => s.lines.length);
  useLive((s) => s.overrides.answer);
  const hotkey = useSettings((s) => s.settings.liveHotkey);
  const hotkeyError = useLive((s) => s.hotkeyError);
  const [question, setQuestion] = useState('');

  const ask = () => {
    const q = question.trim();
    if (!q) return;
    setQuestion('');
    void helpMeAnswer(q);
  };

  return (
    <div className="space-y-2.5 rounded-lg border border-line p-3">
      <div className="flex items-center gap-2">
        <Button variant="primary" size="sm" icon={Lightbulb} onClick={() => void helpMeAnswer()} loading={answer?.busy}>
          Help me answer
        </Button>
        {hotkey && <span className="text-xs text-faint">{hotkeyLabel(hotkey)}</span>}
        <AiLanguageSelect className="ml-auto" />
      </div>
      {hotkeyError && active && <p className="text-xs text-warn">{hotkeyError}</p>}
      <div className="flex gap-2">
        <Input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && ask()}
          placeholder="Ask about the meeting…"
          className="h-8 text-[13px]"
        />
        <Button size="sm" icon={Send} onClick={ask} disabled={!question.trim()} aria-label="Ask" />
      </div>
      {answer && (
        <div className="rounded-md bg-sunken/50 px-3 py-2">
          {answer.question && <div className="mb-1 text-xs text-muted">“{answer.question}”</div>}
          {answer.error ? (
            <p className="text-[13px] text-danger">{answer.error}</p>
          ) : answer.text ? (
            <PlainMarkdown text={answer.text} />
          ) : (
            <Spinner size={14} />
          )}
        </div>
      )}
      <LiveModelPicker task="answer" cost={answerCostEstimate()} costUnit="per answer" />
    </div>
  );
}

function NotesBox() {
  const notes = useLive((s) => s.notes);
  const busy = useLive((s) => s.notesBusy);
  const error = useLive((s) => s.notesError);
  const lineCount = useLive((s) => s.lines.length);
  useLive((s) => s.overrides.live); // re-render the cost estimate on a model switch
  const mode = useSettings((s) => s.settings.liveNotesContext);

  return (
    <div className="space-y-2.5 rounded-lg border border-line p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[13px] font-medium">
          <Sparkles size={14} className="text-accent" /> Notes
          {busy && <Spinner size={12} />}
        </span>
        <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => void refreshNotes()} disabled={busy || !lineCount}>
          Update now
        </Button>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      {notes ? (
        <PlainMarkdown text={notes} className="max-h-72 overflow-y-auto" />
      ) : (
        <p className="text-[13px] text-faint">Updated about once a minute while people talk.</p>
      )}
      <LiveModelPicker task="live" cost={notesCostEstimate()} costUnit="per update" />
      <NotesContextToggle mode={mode} />
    </div>
  );
}

export function NotesContextToggle({ mode }: { mode: 'notes' | 'full' }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-xs text-muted">Notes read</span>
        <div className="flex rounded-md border border-line p-0.5 text-[12px]">
          {(['notes', 'full'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => void saveSettings({ liveNotesContext: m })}
              className={clsx(
                'rounded px-2 py-0.5 transition-colors',
                mode === m ? 'bg-accent-soft font-medium text-accent' : 'text-muted hover:text-text',
              )}
            >
              {m === 'notes' ? 'Last 90 s' : 'Whole meeting'}
            </button>
          ))}
        </div>
      </div>
      <p className="text-[11px] leading-snug text-faint">
        {mode === 'notes'
          ? 'Cheapest: each update sees the notes plus the last ~90 s. Earlier details live only in the notes.'
          : 'Better recall of earlier parts; cost grows with meeting length (with caching on Sonnet 5.5 about $0.60 for 1 h vs $0.45, $1.50 for 2 h vs $0.90; much more without caching).'}{' '}
        Applies from the next update.
      </p>
    </div>
  );
}
