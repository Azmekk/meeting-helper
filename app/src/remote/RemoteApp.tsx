// The phone page: live transcript, notes, the answer sheet and "help me
// answer", mirroring the overlay. The pairing key comes from the URL fragment
// (#k=...), which browsers never send to the server.
//
// Layout: the text scrolls under a slim blurred top bar and above a blurred
// dock; the answer is a draggable bottom sheet (AnswerSheet) between them.
import { ArrowDown, Lightbulb, Monitor, MonitorOff, Send } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { TASK_LABEL, costLabel } from '../components/live/shared';
import { Spinner, clsx } from '../components/ui';
import type { LiveAiTask, LiveSnapshot } from '../lib/live';
import AnswerSheet, { PEEK_PX, type Detent } from './AnswerSheet';
import { useRemoteConnection, type ConnState } from './connection';
import { parseKey } from './crypto';
import { Line, Notes, PartialLine } from './text';

const CONN_LABEL: Record<ConnState, string> = {
  connecting: 'Connecting…',
  open: 'Connected',
  reconnecting: 'Reconnecting…',
  badKey: 'Not paired',
  repaired: 'Re-paired',
};

type Tab = 'transcript' | 'notes';

function keyFromHash(): Uint8Array | null {
  const k = new URLSearchParams(location.hash.slice(1)).get('k');
  return k ? parseKey(k) : null;
}

// Height of an element, kept current.
function useHeight<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [h, setH] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setH(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, h] as const;
}

// iOS doesn't shrink the layout viewport for the keyboard; follow the visual
// viewport so the dock stays above it.
function useVisualViewport() {
  const [box, setBox] = useState<{ top: number; height: number } | null>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      setBox({ top: vv.offsetTop, height: vv.height });
      if (window.scrollY) window.scrollTo(0, 0);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);
  return box;
}

export default function RemoteApp() {
  const key = useMemo(keyFromHash, []);
  const { state, phone, send } = useRemoteConnection(key);

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
  return <Live state={state} snap={phone?.snap ?? null} hidden={!!phone?.hidden} canHide={!!phone?.canHide} send={send} />;
}

interface LiveProps {
  state: ConnState;
  snap: LiveSnapshot | null;
  hidden: boolean;
  canHide: boolean;
  send: ReturnType<typeof useRemoteConnection>['send'];
}

function Live({ state, snap, hidden, canHide, send }: LiveProps) {
  const [tab, setTab] = useState<Tab>('transcript');
  const [question, setQuestion] = useState('');
  const [detent, setDetent] = useState<Detent>('peek');
  const [headerRef, headerH] = useHeight<HTMLElement>();
  const [dockRef, dockH] = useHeight<HTMLDivElement>();
  const viewport = useVisualViewport();
  const box = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showLatest, setShowLatest] = useState(false);

  const connected = state === 'open';
  const answer = snap?.answer ?? null;
  const showSheet = !!answer && !!(answer.text || answer.error || answer.busy);

  // A new answer opens to Half; otherwise the chosen detent sticks.
  // An answer that was already there when the page opened stays in Peek.
  const answerId = answer?.id;
  const answerBusy = !!answer?.busy;
  const seenAnswer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (answerId == null || answerId === seenAnswer.current) return;
    const first = seenAnswer.current === undefined;
    seenAnswer.current = answerId;
    if (!first || answerBusy) setDetent('half');
  }, [answerId, answerBusy]);

  const contentBottom = dockH + (showSheet ? PEEK_PX + 8 : 0);

  // Follow new text only while the user is at the bottom.
  const lastLine = snap?.lines[snap.lines.length - 1];
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || tab !== 'transcript') return;
    if (atBottom.current) el.scrollTop = el.scrollHeight;
    else setShowLatest(true);
  }, [lastLine, snap?.partials, tab, contentBottom, headerH]);

  // Switching tabs: transcript starts at the newest line, notes at the top.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.scrollTop = tab === 'transcript' ? el.scrollHeight : 0;
    atBottom.current = tab === 'transcript';
    setShowLatest(false);
  }, [tab]);

  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (atBottom.current) setShowLatest(false);
  };

  const toLatest = () => {
    const el = box.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    atBottom.current = true;
    setShowLatest(false);
  };

  const ask = () => {
    const q = question.trim();
    if (!q) send({ type: 'help' });
    else if (send({ type: 'ask', question: q })) setQuestion('');
  };
  const setModel = (task: LiveAiTask, model: string) => send({ type: 'set-model', task, model });


  return (
    <div
      className="fixed inset-x-0 overflow-hidden bg-bg text-text"
      style={viewport ? { top: viewport.top, height: viewport.height } : { top: 0, height: '100dvh' }}
    >
      {/* Scrolling text, under the bars. */}
      <div
        ref={box}
        onScroll={onScroll}
        className="rm-scroll absolute inset-0 pr-[max(env(safe-area-inset-right),20px)] pl-[max(env(safe-area-inset-left),20px)]"
        style={{ paddingTop: headerH + 16, paddingBottom: contentBottom + 20 }}
      >
        {!snap ? (
          <div className="flex justify-center py-10">
            <Spinner size={22} />
          </div>
        ) : tab === 'transcript' ? (
          <div className="space-y-2.5">
            {!snap.lines.length && !snap.partials.length && (
              <p className="py-6 text-center text-[15px] text-faint">
                {snap.active ? 'Waiting for speech…' : 'Live transcription isn’t running.'}
              </p>
            )}
            {snap.lines.map((l) => (
              <Line key={l.id} line={l} />
            ))}
            {snap.partials.map((p) => (
              <PartialLine key={p.track} partial={p} />
            ))}
          </div>
        ) : (
          <div>
            {snap.notesError && <p className="mb-3 text-[15px] text-danger">{snap.notesError}</p>}
            {snap.notes ? <Notes text={snap.notes} /> : <p className="py-6 text-center text-[15px] text-faint">No notes yet.</p>}
            <Models snap={snap} onChange={setModel} />
          </div>
        )}
      </div>

      {/* Top bar */}
      <header
        ref={headerRef}
        className="rm-bar absolute inset-x-0 top-0 z-30 flex flex-col gap-3 border-b border-line pt-[max(env(safe-area-inset-top),12px)] pr-[max(env(safe-area-inset-right),16px)] pb-3 pl-[max(env(safe-area-inset-left),16px)]"
      >
        <div className="flex min-h-11 items-center gap-2">
          <span className={clsx('h-[9px] w-[9px] shrink-0 rounded-full', snap?.active ? 'rm-pulse bg-rec' : 'bg-faint')} />
          <span className="text-base font-semibold">{snap?.active ? 'Live' : 'Not live'}</span>
          {snap?.aiCostUsd ? <span className="truncate text-[13px] text-muted">· AI {costLabel(snap.aiCostUsd)}</span> : null}
          <span className="flex-1" />
          {!connected && <span className="shrink-0 text-xs text-warn">{CONN_LABEL[state]}</span>}
          {canHide && (
            <button
              type="button"
              aria-pressed={hidden}
              aria-label={hidden ? 'PC window hidden. Show it' : 'PC window visible. Hide it'}
              disabled={!connected}
              onClick={() => send({ type: 'set-hidden', hidden: !hidden })}
              className="-my-1.5 flex h-11 shrink-0 items-center disabled:opacity-50"
            >
              <span
                className={clsx(
                  'flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold transition-colors',
                  hidden ? 'bg-warn-soft text-warn' : 'bg-fill text-text',
                )}
              >
                {hidden ? <MonitorOff size={15} /> : <Monitor size={15} />}
                {hidden ? 'PC: Hidden' : 'PC: Visible'}
              </span>
            </button>
          )}
        </div>

        <div role="tablist" aria-label="View" className="flex rounded-full bg-segment-track p-[3px]">
          {(['transcript', 'notes'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={clsx(
                'flex h-[38px] flex-1 items-center justify-center gap-1.5 rounded-full text-sm font-semibold transition-colors',
                tab === t ? 'bg-segment-thumb text-text shadow-sm' : 'text-muted',
              )}
            >
              {t === 'transcript' ? 'Transcript' : 'Notes'}
              {t === 'notes' && snap?.notesBusy && <Spinner size={12} />}
            </button>
          ))}
        </div>

        {snap?.error && <p className="m-0 rounded-xl bg-danger-soft px-3 py-2 text-sm text-danger">{snap.error}</p>}
      </header>

      {showLatest && tab === 'transcript' && (
        <button
          type="button"
          onClick={toLatest}
          className="absolute left-1/2 z-10 flex h-11 -translate-x-1/2 items-center"
          style={{ bottom: contentBottom + 8 }}
        >
          <span className="flex h-9 items-center gap-1.5 rounded-full border border-line bg-raised px-4 text-sm font-medium shadow-md">
            <ArrowDown size={15} /> Latest
          </span>
        </button>
      )}

      {showSheet && answer && <AnswerSheet answer={answer} detent={detent} onDetent={setDetent} top={headerH} bottom={dockH} />}

      {/* Dock */}
      <div
        ref={dockRef}
        className="rm-bar absolute inset-x-0 bottom-0 z-30 flex items-center gap-2 border-t border-line pt-2.5 pr-[max(env(safe-area-inset-right),12px)] pb-[max(env(safe-area-inset-bottom),10px)] pl-[max(env(safe-area-inset-left),12px)]"
      >
        <label htmlFor="rm-ask" className="sr-only">
          Ask a question
        </label>
        <input
          id="rm-ask"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && ask()}
          enterKeyHint="send"
          autoComplete="off"
          placeholder="Ask a question…"
          className="h-[46px] min-w-0 flex-1 rounded-full border-0 bg-fill px-[18px] text-[17px] text-text placeholder:text-faint focus:outline-2 focus:outline-accent"
        />
        <button
          type="button"
          disabled={!connected}
          onClick={ask}
          className="flex h-[46px] shrink-0 items-center gap-1.5 rounded-full bg-accent px-[18px] text-base font-semibold text-on-accent active:bg-accent-hover disabled:opacity-50"
        >
          {answer?.busy ? (
            <Spinner size={17} className="text-on-accent" />
          ) : question.trim() ? (
            <Send size={17} />
          ) : (
            <Lightbulb size={17} strokeWidth={2.2} />
          )}
          {question.trim() ? 'Ask' : 'Help'}
        </button>
      </div>
    </div>
  );
}

function Models({ snap, onChange }: { snap: LiveSnapshot; onChange: (task: LiveAiTask, model: string) => void }) {
  return (
    <div className="mt-8 space-y-2 border-t border-line pt-4">
      <h2 className="m-0 text-[13px] font-semibold tracking-[0.04em] text-muted uppercase">AI models</h2>
      {(['answer', 'live'] as const).map((task) => (
        <label key={task} className="flex items-center gap-2 text-sm text-muted">
          <span className="w-28 shrink-0">{TASK_LABEL[task]}</span>
          <select
            value={snap.models[task]}
            onChange={(e) => onChange(task, e.target.value)}
            className="h-11 min-w-0 flex-1 rounded-xl border border-line bg-panel px-2 font-mono text-[13px] text-text"
          >
            {[...new Set([snap.models[task], ...snap.modelOptions])].map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <span className="w-16 shrink-0 text-right text-xs">
            {costLabel(task === 'answer' ? snap.answerCostEstimate : snap.notesCostEstimate)}
          </span>
        </label>
      ))}
    </div>
  );
}

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex h-dvh items-center justify-center bg-bg px-5 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-text">
      <div className="w-full max-w-sm rounded-[28px] border border-line bg-panel p-6 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-accent-soft text-accent-ink">
          <Monitor size={22} />
        </div>
        <h1 className="m-0 mb-2 text-xl font-semibold">{title}</h1>
        <p className="m-0 text-[15px] leading-normal text-muted">{children}</p>
      </div>
    </div>
  );
}
