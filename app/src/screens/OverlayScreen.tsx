// The always-on-top overlay window (#/overlay): a floating glass pill in a
// transparent, frameless window. The suggested answer floats above the pill,
// notes (and model pickers) sit below it. Display-only: the main window does
// all the work and sends `live://state`; buttons send commands back as events
// (see lib/live.ts for the contract). The window is resized to fit the content
// and moved so the pill stays put when the answer bubble appears or goes.
//
// Motion: sections fade and slide a few px in (opacity + transform only, so
// the window resizes once, not every frame). On hide they fade out first and
// unmount after, so the window shrinks once. The whole overlay fades in when
// it opens and out before it closes (also when the main window asks, via
// overlay://close).
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { LogicalSize, PhysicalPosition, getCurrentWindow } from '@tauri-apps/api/window';
import { Check, ChevronDown, ChevronUp, Ellipsis, Lightbulb, MessageSquareText, Mic, MicOff, QrCode as QrIcon, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { LineView, PartialView, PlainMarkdown, TASK_LABEL, costLabel, hotkeyLabel } from '../components/live/shared';
import { OUTPUT_LANGUAGES } from '../components/ai/AiLanguageSelect';
import { QrCode } from '../components/remote/PhoneLink';
import { languageName } from '../lib/ai/prompts';
import { Presence, Spinner, clsx, usePresentValue } from '../components/ui';
import { OVERLAY_CLOSE_EVENT, type LiveAiTask, type LiveSnapshot } from '../lib/live';
import type { PhoneLinkInfo } from '../lib/remote';

// Matches --dur-out for html.overlay (index.css), plus a frame.
const OV_EXIT_MS = 190;

export default function OverlayScreen() {
  const [snap, setSnap] = useState<LiveSnapshot | null>(null);
  // Settings → Appearance → Overlay background (index.css: html.ov-solid).
  useEffect(() => {
    document.documentElement.classList.toggle('ov-solid', !!snap?.overlaySolid);
  }, [snap?.overlaySolid]);
  const [question, setQuestion] = useState('');
  const [collapsed, setCollapsed] = useState(false); // just the pill
  const [moreOpen, setMoreOpen] = useState(false);
  const [openPicker, setOpenPicker] = useState<string | null>(null); // one list at a time
  const menu = useRef<HTMLDivElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  // The settings menu closes on a click elsewhere or Esc, like any menu.
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !moreButton.current?.contains(t)) setMoreOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setMoreOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [moreOpen]);
  const [notesTab, setNotesTab] = useState<'notes' | 'transcript'>('notes');
  const [hiddenAnswer, setHiddenAnswer] = useState<number | null>(null); // answer id the user hid
  // Phone QR view: the main window owns the key and sends the link on request.
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [phone, setPhone] = useState<PhoneLinkInfo | null>(null);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    const off = listen<LiveSnapshot>('live://state', (e) => setSnap(e.payload));
    void emit('live://hello', {});
    return () => void off.then((f) => f());
  }, []);

  useEffect(() => {
    const off = listen<PhoneLinkInfo>('remote://phone-link', (e) => setPhone(e.payload));
    return () => void off.then((f) => f());
  }, []);

  // Fade out, then close the window. The main window falls back to a hard
  // close if this never happens.
  const closingRef = useRef(false);
  const closeOverlay = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    setTimeout(() => void getCurrentWindow().close(), OV_EXIT_MS);
  };
  const closeRef = useRef(closeOverlay);
  closeRef.current = closeOverlay;
  useEffect(() => {
    const off = listen(OVERLAY_CLOSE_EVENT, () => closeRef.current());
    return () => void off.then((f) => f());
  }, []);

  const root = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLDivElement>(null);
  useFitWindow(root, pill);

  const togglePhone = () => {
    if (!phoneOpen) void emit('remote://phone-link-request', {});
    setPhoneOpen((v) => !v);
    setCollapsed(false);
    setMoreOpen(false);
  };

  const ask = () => {
    const q = question.trim();
    if (!q) return;
    setQuestion('');
    setHiddenAnswer(null);
    void emit('live://ask', { question: q });
  };
  const help = () => {
    setHiddenAnswer(null);
    void emit('live://help', {});
  };
  const setModel = (task: LiveAiTask, model: string) => void emit('live://set-model', { task, model });

  const answer = snap?.answer;
  const hasAnswer = !!answer && (answer.busy || !!answer.text || !!answer.error);
  const showAnswer = !collapsed && hasAnswer && hiddenAnswer !== answer?.id;
  // A hidden (or collapsed-away) answer gets a button on the pill to bring it back.
  const canReopen = hasAnswer && !showAnswer;

  // The card below the pill: phone QR or notes. Switching plays the old one's
  // exit before the new one mounts, so the window resizes once per step.
  const lower = collapsed ? null : phoneOpen ? 'phone' : 'notes';
  const { value: lowerShown, closing: lowerClosing } = usePresentValue(lower, OV_EXIT_MS);

  return (
    <div ref={root} data-closing={closing} className="ov-root relative flex flex-col gap-2 p-3 text-[#f2f2f7]">
      <Presence show={showAnswer} motion="up" exitMs={OV_EXIT_MS}>
        {answer && snap && (
          <section className="ov-glass rounded-[22px] px-4 py-3">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-xs font-semibold text-accent">Suggested answer</span>
              <span className="min-w-0 truncate text-[11px] text-[#aeaeb2]">
                {[answer.model, costLabel(snap.answerCostEstimate)].filter(Boolean).join(' · ')}
              </span>
              <span className="flex-1" />
              <button
                type="button"
                aria-label="Hide answer"
                title="Hide answer"
                onClick={() => setHiddenAnswer(answer.id)}
                className="ov-icon h-[26px] w-[26px] transition-colors"
              >
                <ChevronDown size={14} />
              </button>
            </div>
            {answer.question && <p className="mb-1 truncate text-[11.5px] text-[#8e8e93]">“{answer.question}”</p>}
            <div className="max-h-56 overflow-y-auto">
              {answer.error ? (
                <p className="text-[13px] text-danger">{answer.error}</p>
              ) : answer.text ? (
                <PlainMarkdown text={answer.text} className="text-[14px] leading-normal" />
              ) : (
                <p className="flex items-center gap-2 text-[13px] text-[#aeaeb2]">
                  <Spinner size={12} /> Thinking…
                </p>
              )}
            </div>
          </section>
        )}
      </Presence>

      {/* Control island: asking on the left, controls in their own capsule. */}
      <div ref={pill} className="flex shrink-0 items-center gap-2">
      <div
        data-tauri-drag-region
        className="ov-glass flex h-14 min-w-0 flex-1 items-center gap-1.5 rounded-full pr-2 pl-2.5 transition-shadow has-[input:focus]:ring-2 has-[input:focus]:ring-accent/40"
      >
        <span
          data-tauri-drag-region
          role="img"
          aria-label="Drag to move"
          title="Drag to move"
          className="h-[22px] w-1.5 shrink-0 cursor-grab rounded-[3px] bg-white/25"
        />
        <span
          data-tauri-drag-region
          title={snap?.active ? 'Live' : 'Not live'}
          className={clsx(
            'mx-1.5 h-2 w-2 shrink-0 rounded-full transition-colors duration-300',
            snap?.active ? 'animate-pulse bg-[#ff453a]' : 'bg-[#636366]',
          )}
        />
        <label htmlFor="ov-ask" className="sr-only">
          Ask
        </label>
        <input
          id="ov-ask"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && ask()}
          placeholder="Ask or press Help…"
          className="h-10 min-w-0 flex-1 border-0 bg-transparent text-[15px] text-white outline-none placeholder:text-[#8e8e93] focus:outline-none focus-visible:outline-none"
        />
        {canReopen && (
          <button
            type="button"
            aria-label="Show suggested answer"
            title="Show suggested answer"
            onClick={() => {
              setHiddenAnswer(null);
              setCollapsed(false);
            }}
            data-motion="fade"
            className="ov-icon h-9 w-9 text-accent! transition-colors"
          >
            <MessageSquareText size={16} />
          </button>
        )}
        <button
          type="button"
          onClick={help}
          title={snap?.hotkey ? `Help me answer (${hotkeyLabel(snap.hotkey)})` : 'Help me answer'}
          className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full bg-accent px-4 text-[14px] font-semibold text-on-accent transition-[background-color,opacity] hover:bg-accent-hover active:opacity-85"
        >
          {answer?.busy ? <Spinner size={14} className="text-on-accent" /> : <Lightbulb size={15} />}
          Help
        </button>
      </div>
      <div data-tauri-drag-region className="ov-glass flex h-14 shrink-0 items-center gap-1 rounded-full px-2">
        {snap && snap.micMuted != null && (
          <button
            type="button"
            aria-label={snap.micMuted ? 'Unmute mic' : 'Mute mic'}
            aria-pressed={snap.micMuted}
            title={snap.micMuted ? 'Mic muted in the recording: click to unmute' : 'Mute your mic in the recording and transcript'}
            onClick={() => void emit('live://set-mute', { muted: !snap.micMuted })}
            className={clsx('ov-icon h-8 w-8', snap.micMuted && 'bg-[#ff453a]/20! text-[#ff6961]!')}
          >
            {snap.micMuted ? <MicOff size={16} /> : <Mic size={16} />}
          </button>
        )}
        <button
          type="button"
          aria-label="Show phone QR code"
          aria-pressed={phoneOpen}
          title="Use on your phone"
          onClick={togglePhone}
          className={clsx('ov-icon h-8 w-8 transition-colors', phoneOpen && 'text-accent!')}
        >
          <QrIcon size={15} />
        </button>
        {collapsed && (
          <button
            type="button"
            aria-label="Show notes"
            title="Show notes"
            onClick={() => setCollapsed(false)}
            className="ov-icon h-8 w-8 transition-colors"
          >
            <ChevronDown size={16} />
          </button>
        )}
        <button
          ref={moreButton}
          type="button"
          aria-label="Settings"
          aria-expanded={moreOpen}
          title="Language, models, close"
          onClick={() => {
            if (!moreOpen && phoneOpen) setPhoneOpen(false);
            setOpenPicker(null);
            setMoreOpen((v) => !v);
          }}
          className={clsx('ov-icon h-8 w-8 transition-colors', moreOpen && 'bg-white/15! text-white!')}
        >
          <Ellipsis size={16} />
        </button>
      </div>
      </div>

      {/* Settings: language and models, plus close. Picking anything closes it. */}
      <Presence show={moreOpen && !!snap} motion="down" exitMs={OV_EXIT_MS}>
        {snap && (
          <div ref={menu} className="ov-glass space-y-1.5 rounded-[20px] px-3 py-2.5">
            <ModelPicker
              label="Respond in"
              // Older main windows don't send outputLanguage.
              value={snap.outputLanguage || 'meeting'}
              options={['meeting', ...OUTPUT_LANGUAGES]}
              labelOf={(v) => (v === 'meeting' ? 'Meeting’s language' : languageName(v))}
              open={openPicker === 'language'}
              onOpenChange={(o) => setOpenPicker(o ? 'language' : null)}
              onPick={(language) => {
                void emit('live://set-language', { language });
                setMoreOpen(false);
              }}
            />
            {(['answer', 'live'] as const).map((task) => (
              <ModelPicker
                key={task}
                label={TASK_LABEL[task]}
                value={snap.models[task]}
                options={[...new Set([snap.models[task], ...snap.modelOptions])]}
                cost={costLabel(task === 'answer' ? snap.answerCostEstimate : snap.notesCostEstimate)}
                open={openPicker === task}
                onOpenChange={(o) => setOpenPicker(o ? task : null)}
                onPick={(m) => {
                  setModel(task, m);
                  setMoreOpen(false);
                }}
              />
            ))}
            <div className="flex items-center gap-2 border-t border-white/10 pt-2 text-[12px]">
              <span className="flex-1 text-[#8e8e93]">
                {snap.aiCostUsd > 0 ? `AI this meeting ${costLabel(snap.aiCostUsd)}` : ''}
              </span>
              <button type="button" onClick={closeOverlay} className="ov-action h-7! hover:text-[#ff6961]!">
                <X size={13} /> Close overlay
              </button>
            </div>
          </div>
        )}
      </Presence>

      <Presence show={!!snap?.error} motion="down" exitMs={OV_EXIT_MS}>
        <div className="ov-glass rounded-2xl px-4 py-2 text-[12.5px] text-danger">{snap?.error}</div>
      </Presence>

      {lowerShown && (
        <div key={lowerShown} data-motion="down" data-state={lowerClosing ? 'closed' : 'open'}>
          {lowerShown === 'phone' ? (
            <PhonePanel info={phone} />
          ) : (
            <section className="ov-glass rounded-[22px] px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-[#d1d1d6]">{notesTab === 'notes' ? 'Notes' : 'Transcript'}</span>
                {snap?.notesBusy && <Spinner size={11} className="text-[#8e8e93]" />}
                {snap?.notesError && (
                  <span className="min-w-0 truncate text-[11px] text-danger" title={snap.notesError}>
                    {snap.notesError}
                  </span>
                )}
                <span className="flex-1" />
                <Presence show motion="fade" exitMs={OV_EXIT_MS}>
                  <div className="flex rounded-full bg-white/8 p-0.5 text-[11px]">
                    {(['notes', 'transcript'] as const).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setNotesTab(t)}
                        className={clsx(
                          'rounded-full px-2 py-0.5 capitalize transition-colors',
                          notesTab === t ? 'bg-white/16 text-white' : 'text-[#aeaeb2] hover:text-white',
                        )}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </Presence>
                <button
                  type="button"
                  aria-label="Just the pill"
                  title="Just the pill"
                  onClick={() => setCollapsed(true)}
                  className="ov-icon h-6 w-6 transition-colors"
                >
                  <ChevronUp size={13} />
                </button>
              </div>

              <Presence show motion="down" exitMs={OV_EXIT_MS}>
                <div key={notesTab} data-motion="fade" className="mt-1.5 max-h-48 overflow-y-auto">
                  {!snap ? (
                    <Spinner size={14} />
                  ) : notesTab === 'notes' ? (
                    snap.notes ? (
                      <PlainMarkdown text={snap.notes} className="text-[13px] text-[#e5e5ea]" />
                    ) : (
                      <p className="text-xs text-[#8e8e93]">No notes yet.</p>
                    )
                  ) : (
                    <Transcript snap={snap} />
                  )}
                </div>
              </Presence>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function Transcript({ snap }: { snap: LiveSnapshot }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current?.parentElement;
    if (el) el.scrollTop = el.scrollHeight;
  }, [snap.lineCount, snap.partials]);
  if (!snap.lines.length && !snap.partials.length) return <p className="text-xs text-[#8e8e93]">Nothing yet.</p>;
  return (
    <div ref={box} className="space-y-1">
      {snap.lines.slice(-12).map((l) => (
        <LineView key={l.id} line={l} compact />
      ))}
      {snap.partials.map((p) => (
        <PartialView key={p.track} partial={p} compact />
      ))}
    </div>
  );
}

function PhonePanel({ info }: { info: PhoneLinkInfo | null }) {
  return (
    <section className="ov-glass flex flex-col items-center gap-2 rounded-[22px] px-4 py-3 text-center">
      {!info ? (
        <Spinner size={14} />
      ) : info.url ? (
        <>
          <div data-motion="fade" className="rounded-xl bg-white p-2">
            <QrCode text={info.url} className="h-36 w-36" />
          </div>
          <p className="text-[11.5px] text-[#aeaeb2]">
            {info.clients
              ? `${info.clients} phone${info.clients === 1 ? '' : 's'} connected`
              : 'Scan with your phone on the same Wi-Fi'}
          </p>
        </>
      ) : (
        <p className="text-xs text-danger">{info.error ?? 'The phone server isn’t running.'}</p>
      )}
    </section>
  );
}

// Keep the window exactly as tall as the content. When the part above the
// pill (the answer bubble) grows or shrinks, move the window by the same amount
// so the pill stays where the user put it. Sizes come from layout (the
// ResizeObserver's border box, offsetTop within the positioned root), never
// from getBoundingClientRect, so transforms used for animation don't count.
function useFitWindow(root: RefObject<HTMLDivElement | null>, pill: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const win = getCurrentWindow();
    let lastTop: number | null = null;
    let lastHeight = 0;
    let queue = Promise.resolve();
    const fit = (entry?: ResizeObserverEntry) => {
      const box = entry?.borderBoxSize?.[0]?.blockSize;
      const height = Math.ceil(box ?? el.offsetHeight);
      const top = pill.current?.offsetTop ?? 0;
      const dy = lastTop == null ? 0 : top - lastTop;
      lastTop = top;
      if (height === lastHeight && !dy) return;
      lastHeight = height;
      queue = queue
        .then(async () => {
          // Move and resize in one native call (window_bounds.rs); two calls
          // flickered when the answer bubble grew the window upward.
          const pos = await win.outerPosition();
          const dpr = window.devicePixelRatio;
          await invoke('set_window_bounds', {
            x: pos.x,
            y: pos.y - Math.round(dy * dpr),
            width: Math.round(window.innerWidth * dpr),
            height: Math.round(height * dpr),
          }).catch(async () => {
            if (dy) await win.setPosition(new PhysicalPosition(pos.x, pos.y - Math.round(dy * dpr)));
            await win.setSize(new LogicalSize(window.innerWidth, height));
          });
        })
        .catch(() => {});
    };
    // Fires once right away on observe, then on every layout size change.
    const ro = new ResizeObserver((entries) => fit(entries[entries.length - 1]));
    ro.observe(el);
    return () => ro.disconnect();
  }, [root, pill]);
}

// Lists longer than this get a search field.
const PICKER_SEARCH_THRESHOLD = 8;

// The overlay window is only as tall as its content, so a floating menu would
// be cut off. The list opens inline instead and the window grows to fit.
function ModelPicker({
  label,
  value,
  options,
  cost = '',
  labelOf = (v) => v,
  onPick,
  open: openProp,
  onOpenChange,
}: {
  label: string;
  value: string;
  options: string[];
  cost?: string;
  labelOf?: (value: string) => string;
  onPick: (model: string) => void;
  open?: boolean; // controlled by the parent so only one list is open
  onOpenChange?: (open: boolean) => void;
}) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (v: boolean | ((cur: boolean) => boolean)) => {
    const next = typeof v === 'function' ? v(open) : v;
    if (onOpenChange) onOpenChange(next);
    else setOpenState(next);
  };
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  // Fall back to the raw value when there's no friendly name for it.
  const nameOf = (v: string) => labelOf(v) || v;
  const searchable = options.length > PICKER_SEARCH_THRESHOLD;
  const q = query.trim().toLowerCase();
  const shown = q ? options.filter((m) => nameOf(m).toLowerCase().includes(q) || m.toLowerCase().includes(q)) : options;

  useEffect(() => {
    if (open && searchable) search.current?.focus({ preventScroll: true });
  }, [open, searchable]);

  const toggle = () => {
    if (!open) {
      setQuery('');
      setActive(Math.max(0, options.indexOf(value)));
    }
    setOpen((v) => !v);
  };
  const pick = (m: string) => {
    setOpen(false);
    button.current?.focus({ preventScroll: true });
    if (m !== value) onPick(m);
  };
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!shown.length) return;
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      setActive((n) => (n + dir + shown.length) % shown.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (shown[active]) pick(shown[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (query) {
        setQuery('');
        setActive(Math.max(0, options.indexOf(value)));
      } else {
        setOpen(false);
        button.current?.focus({ preventScroll: true });
      }
    }
  };

  return (
    <div className="text-[11px] text-[#aeaeb2]">
      <div className="flex items-center gap-2">
        <span className="w-[5.5rem] shrink-0">{label}</span>
        <button
          ref={button}
          type="button"
          aria-expanded={open}
          onClick={toggle}
          className="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-white/12 bg-white/6 px-2 text-left text-[#e5e5ea] transition-colors hover:bg-white/10"
        >
          <span className="min-w-0 flex-1 truncate">{nameOf(value)}</span>
          <ChevronDown size={12} className={clsx('shrink-0 transition-transform duration-300', open && 'rotate-180')} />
        </button>
        <span className="w-16 shrink-0 text-right">{cost}</span>
      </div>
      <Presence show={open} motion="down" exitMs={OV_EXIT_MS} className="mt-1 ml-[6rem]">
        <div className="rounded-lg border border-white/10 bg-black/25 p-1">
          {searchable && (
            <input
              ref={search}
              type="text"
              value={query}
              aria-label={`Search ${label.toLowerCase()}`}
              placeholder="Search…"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onSearchKey}
              className="mb-1 h-6 w-full rounded-md border border-white/10 bg-white/6 px-2 text-[11px] text-white transition-colors placeholder:text-[#8e8e93] focus:border-white/25 focus:outline-none"
            />
          )}
          <div role="listbox" aria-label={label} className="max-h-36 overflow-y-auto">
            {shown.map((m, n) => (
              <button
                key={m}
                type="button"
                role="option"
                aria-selected={m === value}
                onMouseEnter={() => setActive(n)}
                onClick={() => pick(m)}
                className={clsx(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-white/10',
                  searchable && n === active && 'bg-white/10',
                  m === value ? 'font-semibold text-white' : 'text-[#d1d1d6]',
                )}
              >
                <span className="min-w-0 flex-1 truncate">{nameOf(m)}</span>
                {m === value && <Check size={12} className="shrink-0" />}
              </button>
            ))}
            {!shown.length && <p className="px-2 py-1 text-[#8e8e93]">No matches</p>}
          </div>
        </div>
      </Presence>
    </div>
  );
}
