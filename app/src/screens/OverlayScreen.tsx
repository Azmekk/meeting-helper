// The small always-on-top overlay window (#/overlay). Display-only: the main
// window does all the work and sends `live://state`; buttons send commands
// back as events (see lib/live.ts for the contract).
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ChevronDown, Lightbulb, QrCode as QrIcon, Send, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { LineView, PartialView, PlainMarkdown, TASK_LABEL, costLabel, hotkeyLabel } from '../components/live/shared';
import { QrCode } from '../components/remote/PhoneLink';
import { Spinner, clsx } from '../components/ui';
import type { LiveAiTask, LiveSnapshot } from '../lib/live';
import type { PhoneLinkInfo } from '../lib/remote';

export default function OverlayScreen() {
  const [snap, setSnap] = useState<LiveSnapshot | null>(null);
  const [showNotes, setShowNotes] = useState(false);
  const [question, setQuestion] = useState('');
  // Phone QR view: the main window owns the key and sends the link on request.
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [phone, setPhone] = useState<PhoneLinkInfo | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const off = listen<LiveSnapshot>('live://state', (e) => setSnap(e.payload));
    void emit('live://hello', {});
    return () => void off.then((f) => f());
  }, []);

  useEffect(() => {
    const off = listen<PhoneLinkInfo>('remote://phone-link', (e) => setPhone(e.payload));
    return () => void off.then((f) => f());
  }, []);

  const togglePhone = () => {
    if (!phoneOpen) void emit('remote://phone-link-request', {});
    setPhoneOpen((v) => !v);
  };

  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [snap?.lineCount, snap?.partials]);

  const ask = () => {
    const q = question.trim();
    if (!q) return;
    setQuestion('');
    void emit('live://ask', { question: q });
  };
  const setModel = (task: LiveAiTask, model: string) => void emit('live://set-model', { task, model });

  return (
    <div className="flex h-screen flex-col overflow-hidden border border-line bg-panel text-text">
      <div data-tauri-drag-region className="flex h-8 shrink-0 cursor-move items-center gap-2 border-b border-line px-2.5">
        <span
          data-tauri-drag-region
          className={clsx('h-2 w-2 rounded-full', snap?.active ? 'animate-pulse bg-rec' : 'bg-faint')}
        />
        <span data-tauri-drag-region className="flex-1 text-xs font-medium text-muted">
          {snap?.active ? 'Live' : 'Not live'}
          {snap?.aiCostUsd ? ` · AI ${costLabel(snap.aiCostUsd)}` : ''}
        </span>
        <button
          type="button"
          aria-label="Show phone QR code"
          title="Use on your phone"
          onClick={togglePhone}
          className={clsx('rounded p-0.5 hover:bg-hover hover:text-text', phoneOpen ? 'text-accent' : 'text-muted')}
        >
          <QrIcon size={14} />
        </button>
        <button
          type="button"
          aria-label="Close overlay"
          onClick={() => void getCurrentWindow().close()}
          className="rounded p-0.5 text-muted hover:bg-hover hover:text-text"
        >
          <X size={14} />
        </button>
      </div>

      {snap?.error && <div className="border-b border-line px-2.5 py-1.5 text-xs text-danger">{snap.error}</div>}

      {phoneOpen && <PhonePanel info={phone} />}

      <div ref={box} className={clsx('min-h-0 flex-1 space-y-1 overflow-y-auto px-2.5 py-2', phoneOpen && 'hidden')}>
        {!snap && <Spinner size={14} />}
        {snap?.lines.slice(-12).map((l) => <LineView key={l.id} line={l} compact />)}
        {snap?.partials.map((p) => <PartialView key={p.track} partial={p} compact />)}
      </div>

      <div className="shrink-0 space-y-2 border-t border-line px-2.5 py-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void emit('live://help', {})}
            className="inline-flex h-7 items-center gap-1.5 rounded-md bg-accent px-2.5 text-[12.5px] font-medium text-on-accent hover:bg-accent-hover"
          >
            {snap?.answer?.busy ? <Spinner size={12} className="text-on-accent" /> : <Lightbulb size={13} />}
            Help me answer
          </button>
          {snap?.hotkey && <span className="text-[11px] text-faint">{hotkeyLabel(snap.hotkey)}</span>}
        </div>
        <div className="flex gap-1.5">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && ask()}
            placeholder="Ask…"
            className="h-7 min-w-0 flex-1 rounded-md border border-line bg-panel px-2 text-[12.5px] focus:border-accent focus:outline-none"
          />
          <button type="button" aria-label="Ask" onClick={ask} className="rounded-md px-1.5 text-muted hover:bg-hover hover:text-text">
            <Send size={13} />
          </button>
        </div>
        {snap?.answer && (snap.answer.text || snap.answer.error) && (
          <div className="max-h-48 overflow-y-auto rounded-md bg-sunken/60 px-2 py-1.5">
            {snap.answer.error ? (
              <p className="text-xs text-danger">{snap.answer.error}</p>
            ) : (
              <PlainMarkdown text={snap.answer.text} className="text-[12.5px]" />
            )}
          </div>
        )}

        <button
          type="button"
          onClick={() => setShowNotes((v) => !v)}
          className="flex w-full items-center gap-1 text-xs text-muted hover:text-text"
        >
          <ChevronDown size={12} className={clsx('transition-transform', showNotes && 'rotate-180')} />
          Notes & models
        </button>
        {showNotes && snap && (
          <div className="space-y-2">
            {snap.notes ? (
              <PlainMarkdown text={snap.notes} className="max-h-40 overflow-y-auto text-[12px]" />
            ) : (
              <p className="text-xs text-faint">No notes yet.</p>
            )}
            {(['answer', 'live'] as const).map((task) => (
              <label key={task} className="flex items-center gap-1.5 text-[11px] text-muted">
                <span className="w-20 shrink-0">{TASK_LABEL[task]}</span>
                <select
                  value={snap.models[task]}
                  onChange={(e) => setModel(task, e.target.value)}
                  className="h-6 min-w-0 flex-1 rounded border border-line bg-panel font-mono text-[11px]"
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
          </div>
        )}
      </div>
    </div>
  );
}

function PhonePanel({ info }: { info: PhoneLinkInfo | null }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 overflow-y-auto px-2.5 py-2 text-center">
      {!info ? (
        <Spinner size={14} />
      ) : info.url ? (
        <>
          <QrCode text={info.url} className="h-36 w-36" />
          <p className="text-[11px] text-muted">
            {info.clients
              ? `${info.clients} phone${info.clients === 1 ? '' : 's'} connected`
              : 'Scan with your phone on the same Wi-Fi'}
          </p>
        </>
      ) : (
        <p className="text-xs text-danger">{info.error ?? 'The phone server isn’t running.'}</p>
      )}
    </div>
  );
}
