// The phone page: live transcript, notes, the answer box and "help me answer",
// mirroring the overlay. The pairing key comes from the URL fragment (#k=...),
// which browsers never send to the server.
import { ChevronDown, Eye, EyeOff, Lightbulb, Send } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { LineView, PartialView, PlainMarkdown, TASK_LABEL, costLabel } from '../components/live/shared';
import { Spinner, clsx } from '../components/ui';
import type { LiveAiTask } from '../lib/live';
import { useRemoteConnection, type ConnState } from './connection';
import { parseKey } from './crypto';

const CONN_LABEL: Record<ConnState, string> = {
  connecting: 'Connecting…',
  open: 'Connected',
  reconnecting: 'Reconnecting…',
  badKey: 'Not paired',
  repaired: 'Re-paired',
};

function keyFromHash(): Uint8Array | null {
  const k = new URLSearchParams(location.hash.slice(1)).get('k');
  return k ? parseKey(k) : null;
}

export default function RemoteApp() {
  const key = useMemo(keyFromHash, []);
  const { state, message, send } = useRemoteConnection(key);
  const snap = message?.snap ?? null;
  const [tab, setTab] = useState<'transcript' | 'notes'>('transcript');
  const [question, setQuestion] = useState('');
  const [showModels, setShowModels] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    const el = box.current;
    if (el && tab === 'transcript' && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [snap?.lineCount, snap?.partials, tab]);

  if (!key) {
    return (
      <Notice title="Scan the QR code">
        Open this page by scanning the QR code in Meeting Helper → Settings → Secret mode. The link carries the pairing key.
      </Notice>
    );
  }
  if (state === 'badKey' || state === 'repaired') {
    return (
      <Notice title={state === 'repaired' ? 'This phone was unpaired' : 'Pairing key doesn’t match'}>
        Scan the current QR code in Meeting Helper → Settings → Secret mode again.
      </Notice>
    );
  }

  const ask = () => {
    const q = question.trim();
    if (!q) return;
    if (send({ type: 'ask', question: q })) setQuestion('');
  };
  const setModel = (task: LiveAiTask, model: string) => send({ type: 'set-model', task, model });
  const connected = state === 'open';
  const answer = snap?.answer;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg text-text">
      <header className="flex shrink-0 items-center gap-2 border-b border-line bg-panel px-4 pt-[max(env(safe-area-inset-top),0.75rem)] pb-3">
        <span className={clsx('h-2.5 w-2.5 rounded-full', snap?.active ? 'animate-pulse bg-rec' : 'bg-faint')} />
        <span className="flex-1 text-sm font-medium">
          {snap?.active ? 'Live' : 'Not live'}
          {snap?.aiCostUsd ? <span className="text-muted"> · AI {costLabel(snap.aiCostUsd)}</span> : null}
        </span>
        <span className={clsx('text-xs', connected ? 'text-ok' : 'text-warn')}>{CONN_LABEL[state]}</span>
        {message?.canHide && (
          <button
            type="button"
            aria-label={message.hidden ? 'Show the PC window' : 'Hide the PC window'}
            onClick={() => send({ type: 'set-hidden', hidden: !message.hidden })}
            className="rounded-md p-1.5 text-muted active:bg-hover"
          >
            {message.hidden ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>
        )}
      </header>

      {snap?.error && <div className="shrink-0 border-b border-line bg-danger-soft px-4 py-2 text-sm text-danger">{snap.error}</div>}

      <div role="tablist" className="flex shrink-0 border-b border-line bg-panel">
        {(['transcript', 'notes'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={clsx(
              '-mb-px flex-1 border-b-2 py-2.5 text-sm',
              tab === t ? 'border-accent font-medium text-text' : 'border-transparent text-muted',
            )}
          >
            {t === 'transcript' ? 'Transcript' : 'Notes'}
            {t === 'notes' && snap?.notesBusy && <Spinner size={12} className="ml-1.5 inline" />}
          </button>
        ))}
      </div>

      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
      >
        {!snap ? (
          <div className="flex justify-center py-8">
            <Spinner size={20} />
          </div>
        ) : tab === 'transcript' ? (
          <div className="space-y-1.5 [&_div]:text-[15px]">
            {!snap.lines.length && !snap.partials.length && (
              <p className="text-sm text-faint">{snap.active ? 'Waiting for speech…' : 'Live transcription isn’t running.'}</p>
            )}
            {snap.lines.map((l) => (
              <LineView key={l.id} line={l} compact />
            ))}
            {snap.partials.map((p) => (
              <PartialView key={p.track} partial={p} compact />
            ))}
          </div>
        ) : (
          <div>
            {snap.notesError && <p className="mb-2 text-sm text-danger">{snap.notesError}</p>}
            {snap.notes ? <PlainMarkdown text={snap.notes} className="text-[15px]" /> : <p className="text-sm text-faint">No notes yet.</p>}
          </div>
        )}
      </div>

      <div className="shrink-0 space-y-3 border-t border-line bg-panel px-4 pt-3 pb-[max(env(safe-area-inset-bottom),0.75rem)]">
        {answer && (answer.text || answer.error || answer.busy) && (
          <div className="max-h-[38dvh] overflow-y-auto rounded-lg bg-sunken px-3 py-2.5">
            {answer.question && <p className="mb-1 text-xs text-muted">Q: {answer.question}</p>}
            {answer.error ? (
              <p className="text-sm text-danger">{answer.error}</p>
            ) : answer.text ? (
              <PlainMarkdown text={answer.text} className="text-[15px]" />
            ) : (
              <Spinner size={16} />
            )}
          </div>
        )}

        <button
          type="button"
          disabled={!connected}
          onClick={() => send({ type: 'help' })}
          className="flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-accent text-base font-semibold text-on-accent active:bg-accent-hover disabled:opacity-50"
        >
          {answer?.busy ? <Spinner size={18} className="text-on-accent" /> : <Lightbulb size={20} />}
          Help me answer
        </button>

        <div className="flex gap-2">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && ask()}
            enterKeyHint="send"
            placeholder="Ask a question…"
            className="h-11 min-w-0 flex-1 rounded-lg border border-line bg-panel px-3 text-base focus:border-accent focus:outline-none"
          />
          <button
            type="button"
            aria-label="Ask"
            disabled={!connected || !question.trim()}
            onClick={ask}
            className="flex h-11 w-11 items-center justify-center rounded-lg border border-line text-muted active:bg-hover disabled:opacity-50"
          >
            <Send size={18} />
          </button>
        </div>

        {snap && (
          <>
            <button
              type="button"
              onClick={() => setShowModels((v) => !v)}
              className="flex w-full items-center gap-1 text-xs text-muted"
            >
              <ChevronDown size={14} className={clsx('transition-transform', showModels && 'rotate-180')} />
              Models
            </button>
            {showModels &&
              (['answer', 'live'] as const).map((task) => (
                <label key={task} className="flex items-center gap-2 text-xs text-muted">
                  <span className="w-24 shrink-0">{TASK_LABEL[task]}</span>
                  <select
                    value={snap.models[task]}
                    onChange={(e) => setModel(task, e.target.value)}
                    className="h-9 min-w-0 flex-1 rounded-md border border-line bg-panel px-1 font-mono text-xs"
                  >
                    {[...new Set([snap.models[task], ...snap.modelOptions])].map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                  <span className="w-16 shrink-0 text-right">
                    {costLabel(task === 'answer' ? snap.answerCostEstimate : snap.notesCostEstimate)}
                  </span>
                </label>
              ))}
          </>
        )}
      </div>
    </div>
  );
}

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex h-dvh items-center justify-center bg-bg p-6 text-text">
      <div className="max-w-sm rounded-xl border border-line bg-panel p-5">
        <h1 className="mb-2 text-lg font-semibold">{title}</h1>
        <p className="text-sm text-muted">{children}</p>
      </div>
    </div>
  );
}
