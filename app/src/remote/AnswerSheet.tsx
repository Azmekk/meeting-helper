// The AI answer as a bottom sheet above the dock, with three detents: Peek (a
// one-line preview that leaves the transcript readable), Half and Full.
// Dragging moves it with a transform straight on the element (no React
// renders per frame); on release it snaps to the nearest detent, or the next
// one in the direction of a flick.
import { ChevronDown } from 'lucide-react';
import { memo, useCallback, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Spinner, clsx } from '../components/ui';
import type { LiveAnswer } from '../lib/live';
import { InlineBold } from './text';

export type Detent = 'peek' | 'half' | 'full';
const DETENTS: Detent[] = ['peek', 'half', 'full'];
const DETENT_LABEL: Record<Detent, string> = { peek: 'Peek', half: 'Half', full: 'Full' };

export const PEEK_PX = 72; // visible height in Peek
const TOP_GAP_PX = 8; // space left above the sheet at Full
const FOOTER_PX = 52; // the detent buttons row
const SNAP = 'transform 280ms cubic-bezier(0.2, 0.8, 0.2, 1)';
const FLICK_PX_PER_MS = 0.45;

interface Props {
  answer: LiveAnswer;
  detent: Detent;
  onDetent: (d: Detent) => void;
  top: number; // header height
  bottom: number; // dock height
}

export default function AnswerSheet({ answer, detent, onDetent, top, bottom }: Props) {
  const clip = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLElement>(null);
  const [avail, setAvail] = useState(0);
  const offsetNow = useRef(0); // current translateY
  const drag = useRef<{ id: number; startY: number; start: number; moved: boolean; samples: { y: number; t: number }[] } | null>(null);

  useLayoutEffect(() => {
    const el = clip.current;
    if (!el) return;
    const measure = () => setAvail(Math.max(0, el.clientHeight - TOP_GAP_PX));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const visible = useCallback(
    (d: Detent) => {
      if (d === 'peek') return Math.min(PEEK_PX, avail);
      if (d === 'half') return Math.min(avail, Math.max(PEEK_PX + 160, Math.round(avail * 0.52)));
      return avail;
    },
    [avail],
  );
  const offsetOf = useCallback((d: Detent) => avail - visible(d), [avail, visible]);

  const apply = useCallback((offset: number, animate: boolean) => {
    const el = sheet.current;
    if (!el) return;
    offsetNow.current = offset;
    el.style.transition = animate ? SNAP : 'none';
    el.style.transform = `translate3d(0, ${offset}px, 0)`;
    // Keeps the footer at the bottom of the visible part.
    el.style.setProperty('--hidden', `${Math.max(0, offset)}px`);
  }, []);

  // Detent or size changed: settle there (animated, unless it's the first layout).
  const placed = useRef(false);
  useLayoutEffect(() => {
    if (!avail || drag.current) return;
    apply(offsetOf(detent), placed.current);
    placed.current = true;
  }, [avail, detent, offsetOf, apply]);

  const snapTo = (d: Detent) => {
    apply(offsetOf(d), true);
    onDetent(d);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as Element).closest('button')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, startY: e.clientY, start: offsetNow.current, moved: false, samples: [{ y: e.clientY, t: e.timeStamp }] };
    if (sheet.current) sheet.current.style.transition = 'none';
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dy = e.clientY - d.startY;
    if (Math.abs(dy) > 5) d.moved = true;
    if (!d.moved) return;
    const max = offsetOf('peek');
    let next = d.start + dy;
    // Rubber band past the ends.
    if (next < 0) next = next / 3;
    else if (next > max) next = max + (next - max) / 3;
    apply(next, false);
    d.samples.push({ y: e.clientY, t: e.timeStamp });
    while (d.samples.length > 2 && e.timeStamp - d.samples[0].t > 100) d.samples.shift();
  };

  const onPointerEnd = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (!d.moved) {
      if (e.type === 'pointerup' && detent === 'peek') snapTo('half');
      else apply(offsetOf(detent), true);
      return;
    }
    const first = d.samples[0];
    const last = d.samples[d.samples.length - 1];
    const dt = last.t - first.t;
    const v = dt > 0 && e.timeStamp - last.t < 80 ? (last.y - first.y) / dt : 0; // px/ms, + is down
    const now = offsetNow.current;
    const byOffset = DETENTS.map((x) => ({ x, o: offsetOf(x) }));
    let target: Detent;
    if (Math.abs(v) > FLICK_PX_PER_MS) {
      // Next detent in the flick's direction (down = larger offset).
      const ahead = byOffset.filter(({ o }) => (v > 0 ? o > now + 1 : o < now - 1));
      ahead.sort((a, b) => Math.abs(a.o - now) - Math.abs(b.o - now));
      target = ahead[0]?.x ?? (v > 0 ? 'peek' : 'full');
    } else {
      const projected = now + v * 120;
      byOffset.sort((a, b) => Math.abs(a.o - projected) - Math.abs(b.o - projected));
      target = byOffset[0].x;
    }
    snapTo(target);
  };

  const lower = () => snapTo(detent === 'full' ? 'half' : 'peek');
  const handlers = { onPointerDown, onPointerMove, onPointerUp: onPointerEnd, onPointerCancel: onPointerEnd };
  const peek = detent === 'peek';

  return (
    <div ref={clip} className="pointer-events-none absolute inset-x-0 z-20 overflow-hidden" style={{ top, bottom }}>
      <section
        ref={sheet}
        aria-label="Suggested answer"
        className="rm-sheet pointer-events-auto absolute inset-x-2 bottom-0 flex flex-col rounded-[28px] border border-line bg-panel"
        style={{ height: avail, transform: `translate3d(0, ${avail}px, 0)` }}
      >
        {/* Drag handle: the grabber and title row (the whole sheet in Peek). */}
        <div
          {...handlers}
          className={clsx('shrink-0 cursor-grab touch-none px-4 pt-2 select-none', peek ? 'pb-3' : 'pb-1')}
          style={peek ? { height: PEEK_PX } : undefined}
        >
          <div aria-hidden="true" className="mx-auto mb-2 h-[5px] w-[38px] rounded-full bg-fill-strong" />
          {peek ? (
            // Not a <button>, so a drag can start on it; a tap opens it (pointerup).
            <div
              role="button"
              tabIndex={0}
              aria-label="Open the answer"
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && snapTo('half')}
              className="flex h-11 w-full min-w-0 items-center gap-2 text-left"
            >
              {answer.busy && !answer.text ? (
                <Spinner size={14} />
              ) : (
                <span className={clsx('h-2 w-2 shrink-0 rounded-full', answer.error ? 'bg-danger' : 'bg-accent')} />
              )}
              <span className={clsx('min-w-0 flex-1 truncate text-[15px]', answer.error ? 'text-danger' : 'text-text')}>
                {answer.error || previewOf(answer.text) || 'Thinking…'}
              </span>
              <span className="shrink-0 text-xs text-muted">Swipe up</span>
            </div>
          ) : (
            <div className="flex h-11 items-center gap-2">
              <span className="text-[13px] font-semibold text-accent">Suggested answer</span>
              <span className="min-w-0 truncate text-xs text-muted">{answer.model}</span>
              {answer.busy && <Spinner size={13} />}
              <span className="flex-1" />
              <button
                type="button"
                aria-label="Lower the answer"
                onClick={lower}
                className="-mr-2 flex h-11 w-11 items-center justify-center rounded-full"
              >
                <span className="flex h-[30px] w-[30px] items-center justify-center rounded-full bg-fill text-muted">
                  <ChevronDown size={15} strokeWidth={2.6} />
                </span>
              </button>
            </div>
          )}
        </div>

        {!peek && (
          <>
            <div
              className={clsx('min-h-0 flex-1 px-[18px]', detent === 'full' ? 'rm-scroll' : 'overflow-hidden')}
              style={{ marginBottom: `calc(var(--hidden, 0px) + ${FOOTER_PX}px)`, paddingBottom: 8 }}
            >
              {answer.question && <p className="mb-2 text-[13px] text-muted">Q: {answer.question}</p>}
              {answer.error ? (
                <p className="text-[17px] leading-normal text-danger">{answer.error}</p>
              ) : answer.text ? (
                <AnswerText text={answer.text} />
              ) : (
                <div className="flex items-center gap-2 py-2 text-[15px] text-muted">
                  <Spinner size={16} /> Thinking…
                </div>
              )}
            </div>
            <div
              className="absolute inset-x-0 flex items-center gap-1 rounded-b-[28px] bg-panel px-3"
              style={{ bottom: 'var(--hidden, 0px)', height: FOOTER_PX }}
            >
              {DETENTS.map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={detent === d}
                  onClick={() => snapTo(d)}
                  className="flex h-11 items-center px-0.5"
                >
                  <span
                    className={clsx(
                      'flex h-8 items-center rounded-full px-3.5 text-[13px]',
                      detent === d ? 'bg-accent font-semibold text-on-accent' : 'bg-fill text-muted',
                    )}
                  >
                    {DETENT_LABEL[d]}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function previewOf(text: string): string {
  return text.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
}

const AnswerText = memo(function AnswerText({ text }: { text: string }) {
  return (
    <div className="text-[17px] leading-normal whitespace-pre-wrap text-text">
      <InlineBold text={text} />
    </div>
  );
});
