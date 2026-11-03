// Shared building blocks. Screens should compose these rather than restyle
// raw elements, so the app looks like one thing.
import clsx from 'clsx';
import { AlertTriangle, Check, CheckCircle2, ChevronDown, Info, Loader2, X, XCircle, type LucideIcon } from 'lucide-react';
import {
  Children,
  forwardRef,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { useToasts } from '../lib/toast';

export { clsx };
export { toast } from '../lib/toast';
export { errorMessage } from '../lib/errors';

// ---------- Motion ----------
// Elements animate in with data-motion="fade|pop|drop|rise|up|down" (keyframes
// in index.css) and out with data-state="closed". These hooks keep a closing
// element mounted long enough to play its exit.

// Slightly longer than --dur-out so the exit finishes before unmounting.
export const EXIT_MS = 170;

// Like `open`, but stays mounted for `exitMs` after it turns false.
export function usePresence(open: boolean, exitMs = EXIT_MS): { mounted: boolean; closing: boolean } {
  const [lingering, setLingering] = useState(open);
  if (open && !lingering) setLingering(true);
  useEffect(() => {
    if (open) return;
    const t = setTimeout(() => setLingering(false), exitMs);
    return () => clearTimeout(t);
  }, [open, exitMs]);
  return { mounted: open || lingering, closing: !open && lingering };
}

// For a slot that switches between values (or empties): the old value plays
// its exit first, then the new one mounts. Returns what to render now.
export function usePresentValue<T>(value: T | null, exitMs = EXIT_MS): { value: T | null; closing: boolean } {
  const [shown, setShown] = useState<T | null>(value);
  const changing = shown !== value;
  useEffect(() => {
    if (!changing) return;
    if (shown === null) {
      setShown(value);
      return;
    }
    const t = setTimeout(() => setShown(value), exitMs);
    return () => clearTimeout(t);
  }, [changing, shown, value, exitMs]);
  return { value: shown, closing: changing && shown !== null };
}

// Mounts children with an enter animation and fades them out before
// unmounting. While closing it keeps rendering the last children it was given,
// so data that vanished with `show` doesn't blank the exit.
export function Presence({
  show,
  motion = 'fade',
  exitMs,
  className,
  children,
}: {
  show: boolean;
  motion?: 'fade' | 'pop' | 'drop' | 'rise' | 'up' | 'down';
  exitMs?: number;
  className?: string;
  children: ReactNode;
}) {
  const last = useRef(children);
  if (show) last.current = children;
  const { mounted, closing } = usePresence(show, exitMs);
  if (!mounted) return null;
  return (
    <div data-motion={motion} data-state={closing ? 'closed' : 'open'} className={className}>
      {show ? children : last.current}
    </div>
  );
}

// Show/hide a block by animating its height (grid rows 0fr → 1fr) and opacity.
// Closed content is unmounted once the animation ends (unless `keepMounted`)
// and is inert while hidden.
export function Collapse({
  open,
  children,
  className,
  keepMounted,
}: {
  open: boolean;
  children: ReactNode;
  className?: string;
  keepMounted?: boolean;
}) {
  const { mounted } = usePresence(open, 300);
  // Mount closed, then open on the next frame so the height transition runs.
  const [expanded, setExpanded] = useState(open);
  useEffect(() => {
    if (!open) {
      setExpanded(false);
      return;
    }
    const raf = requestAnimationFrame(() => setExpanded(true));
    return () => cancelAnimationFrame(raf);
  }, [open]);
  if (!mounted && !keepMounted) return null;
  return (
    <div className="mh-collapse" data-open={expanded && open} aria-hidden={!open || undefined} inert={!open}>
      {/* The clipping wrapper carries no padding, so 0fr really is 0px tall. */}
      <div>
        <div className={className}>{children}</div>
      </div>
    </div>
  );
}

// ---------- Buttons ----------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  icon?: LucideIcon;
  loading?: boolean;
}

// Pills: filled accent primary, grey-fill secondary, no heavy borders.
const variantClass: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-on-accent hover:bg-accent-hover',
  secondary: 'bg-fill text-text hover:bg-fill-strong',
  ghost: 'text-muted hover:text-text hover:bg-hover',
  danger: 'bg-fill text-danger hover:bg-danger-soft',
};

const sizeClass = {
  sm: 'h-[30px] px-3 text-[13px] gap-1.5',
  md: 'h-9 px-4 text-sm gap-2',
  lg: 'h-11 px-6 text-[15px] gap-2 font-semibold',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon: Icon, loading, disabled, className, children, ...rest },
  ref,
) {
  const iconSize = size === 'sm' ? 14 : 16;
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center rounded-full font-medium whitespace-nowrap transition-[color,background-color,border-color,opacity,box-shadow] active:opacity-80 active:duration-75',
        'disabled:pointer-events-none disabled:opacity-50',
        variantClass[variant],
        sizeClass[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 size={iconSize} className="animate-spin" /> : Icon ? <Icon size={iconSize} /> : null}
      {children}
    </button>
  );
});

export function IconButton({
  icon: Icon,
  label,
  className,
  size = 'md',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string; size?: 'sm' | 'md' }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-hover hover:text-text active:bg-fill-strong',
        'disabled:pointer-events-none disabled:opacity-50',
        size === 'sm' ? 'h-6 w-6' : 'h-8 w-8',
        className,
      )}
      {...rest}
    >
      <Icon size={size === 'sm' ? 14 : 16} />
    </button>
  );
}

// ---------- Form controls ----------

// Grey fill instead of borders; pill for single-line, rounded for textareas.
const controlClass =
  'w-full border border-transparent bg-fill px-3.5 text-sm text-text placeholder:text-faint ' +
  'transition-[background-color,border-color,box-shadow,color] hover:bg-fill-strong focus:border-accent focus:bg-panel ' +
  'focus:outline-none focus:ring-[3px] focus:ring-accent/20 disabled:opacity-60';

// controlClass makes fields full width. A width passed by the caller (w-auto,
// w-48…) replaces that default; with both, CSS order decides and the caller's
// width could silently lose.
function controlFor(className?: string): string {
  return /(^|\s)!?w-/.test(className ?? '') ? controlClass.replace('w-full ', '') : controlClass;
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={clsx(controlFor(className), 'h-9 rounded-full', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={clsx(controlFor(className), 'rounded-field py-2.5 leading-relaxed', className)} {...rest} />;
  },
);

// A styled replacement for <select>: same props and <option>/<optgroup>
// children, so call sites didn't change. The list opens in a portal (never
// clipped by a scrolling card) and works with the keyboard. onChange gets an
// event-like object whose target.value is the picked option's value.
type SelectItem = { value: string; label: ReactNode; disabled: boolean; group?: string };

function collectOptions(children: ReactNode, group?: string): SelectItem[] {
  const out: SelectItem[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement<{ value?: unknown; children?: ReactNode; disabled?: boolean; label?: string }>(child)) return;
    if (child.type === 'option') {
      const value = String(child.props.value ?? child.props.children ?? '');
      out.push({ value, label: child.props.children, disabled: !!child.props.disabled, group });
    } else if (child.type === 'optgroup') {
      out.push(...collectOptions(child.props.children, child.props.label));
    } else if (child.props.children) {
      out.push(...collectOptions(child.props.children, group));
    }
  });
  return out;
}

// Plain text of an option label, for the search filter.
function nodeText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return '';
}

// Long lists get a search field at the top.
const SEARCH_THRESHOLD = 8;

export function Select({
  className,
  children,
  value,
  onChange,
  disabled,
  id,
  title,
  'aria-label': ariaLabel,
  plain,
}: SelectHTMLAttributes<HTMLSelectElement> & {
  // Only `className` styles the button (for compact pickers in a sentence or toolbar).
  plain?: boolean;
}) {
  const items = collectOptions(children);
  const current = String(value ?? '');
  const selected = items.find((i) => i.value === current) ?? items[0];
  const searchable = items.length > SEARCH_THRESHOLD;
  const [open, setOpen] = useState(false);
  const { mounted, closing } = usePresence(open);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; up: boolean } | null>(null);
  // Searchable lists keep the width they opened with, so filtering doesn't jiggle them.
  const [lockedWidth, setLockedWidth] = useState<number | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  const q = query.trim().toLowerCase();
  const shown = q ? items.filter((i) => nodeText(i.label).toLowerCase().includes(q)) : items;
  const firstEnabled = (list: SelectItem[]) => Math.max(0, list.findIndex((i) => !i.disabled));

  const place = () => {
    const r = button.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom;
    const up = below < 280 && r.top > below;
    setPos({ left: r.left, top: up ? r.top : r.bottom, width: r.width, up });
  };
  const show = () => {
    if (disabled) return;
    place();
    setQuery('');
    setLockedWidth(null);
    setActive(Math.max(0, items.findIndex((i) => i.value === current)));
    setOpen(true);
  };
  const hide = (refocus = true) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  const pick = (item: SelectItem) => {
    if (item.disabled) return;
    hide();
    if (item.value !== current) {
      onChange?.({ target: { value: item.value }, currentTarget: { value: item.value } } as unknown as ChangeEvent<HTMLSelectElement>);
    }
  };

  useLayoutEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, active, query]);

  useLayoutEffect(() => {
    if (open && searchable && lockedWidth == null && pop.current) setLockedWidth(pop.current.offsetWidth);
  }, [open, searchable, lockedWidth]);

  // Opened left-aligned to the button; near the right edge of the window,
  // shift left so the whole list stays visible.
  const [fitLeft, setFitLeft] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!mounted || !pos || !pop.current) return;
    const maxLeft = window.innerWidth - 8 - pop.current.offsetWidth;
    setFitLeft(pos.left > maxLeft ? Math.max(8, maxLeft) : null);
  }, [mounted, pos, lockedWidth]);

  useEffect(() => {
    if (open && searchable) search.current?.focus({ preventScroll: true });
  }, [open, searchable]);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (pop.current?.contains(e.target as Node) || button.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const reposition = () => place();
    window.addEventListener('mousedown', close);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    // In the search field, Space, Home and End edit the text.
    const typing = e.target === search.current;
    const step = (dir: number) => {
      if (!shown.length) return;
      let n = active;
      for (let k = 0; k < shown.length; k++) {
        n = (n + dir + shown.length) % shown.length;
        if (!shown[n].disabled) break;
      }
      setActive(n);
    };
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        show();
      }
      return;
    }
    if (e.key === 'ArrowDown') step(1);
    else if (e.key === 'ArrowUp') step(-1);
    else if (e.key === 'Home' && !typing) setActive(firstEnabled(shown));
    else if (e.key === 'End' && !typing) setActive(shown.length - 1);
    else if (e.key === 'Enter' || (e.key === ' ' && !typing)) {
      if (shown[active]) pick(shown[active]);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      if (typing && query) {
        setQuery('');
        setActive(Math.max(0, items.findIndex((i) => i.value === current)));
      } else hide();
    } else if (e.key === 'Tab') {
      hide(false);
      return;
    } else return;
    e.preventDefault();
  };

  return (
    <>
      <button
        ref={button}
        id={id}
        type="button"
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? hide() : show())}
        onKeyDown={onKeyDown}
        className={clsx(
          !plain && controlFor(className),
          !plain && 'h-9 rounded-full',
          'flex cursor-pointer items-center gap-2 text-left disabled:cursor-default',
          className,
        )}
      >
        <span className="min-w-0 flex-1 truncate">{selected?.label}</span>
        <ChevronDown size={14} className={clsx('shrink-0 text-muted transition-transform duration-300', open && 'rotate-180')} />
      </button>
      {mounted &&
        pos &&
        createPortal(
          <div
            ref={pop}
            data-motion={pos.up ? 'rise' : 'drop'}
            data-state={closing ? 'closed' : 'open'}
            onKeyDown={onKeyDown}
            style={{
              left: fitLeft ?? pos.left,
              minWidth: Math.max(pos.width, searchable ? 220 : 160),
              width: lockedWidth ?? undefined,
              transformOrigin: `${pos.up ? 'bottom' : 'top'} ${fitLeft != null ? 'right' : 'left'}`,
              ...(pos.up ? { bottom: window.innerHeight - pos.top + 6 } : { top: pos.top + 6 }),
            }}
            className="surface-pop fixed z-[60] flex max-h-80 max-w-[min(28rem,calc(100vw-16px))] flex-col overflow-hidden rounded-2xl border border-line text-text"
          >
            {searchable && (
              <div className="shrink-0 p-1.5 pb-1">
                <input
                  ref={search}
                  type="text"
                  value={query}
                  aria-label="Search options"
                  placeholder="Search…"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => {
                    const text = e.target.value;
                    setQuery(text);
                    const t = text.trim().toLowerCase();
                    setActive(firstEnabled(t ? items.filter((i) => nodeText(i.label).toLowerCase().includes(t)) : items));
                  }}
                  className="h-8 w-full rounded-xl border border-transparent bg-fill px-3 text-[13px] text-text transition-[background-color,border-color] placeholder:text-faint focus:border-accent/60 focus:bg-panel focus:outline-none"
                />
              </div>
            )}
            <div
              ref={list}
              role="listbox"
              aria-label={ariaLabel}
              className={clsx('min-h-0 flex-1 overflow-y-auto p-1.5', searchable && 'pt-0.5')}
            >
              {shown.map((item, n) => (
                <div key={`${item.group ?? ''}:${item.value}`}>
                  {item.group && item.group !== shown[n - 1]?.group && (
                    <div className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-faint uppercase">{item.group}</div>
                  )}
                  <button
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={item.value === current}
                    data-active={n === active}
                    disabled={item.disabled}
                    onMouseEnter={() => setActive(n)}
                    onClick={() => pick(item)}
                    className={clsx(
                      'flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition-colors duration-150 disabled:opacity-50',
                      n === active && 'bg-fill-strong',
                      item.value === current && 'font-semibold',
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.value === current && <Check size={14} className="shrink-0 text-accent" />}
                  </button>
                </div>
              ))}
              {!shown.length && <div className="px-3 py-2 text-sm text-muted">No matches</div>}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative inline-flex h-[31px] w-[51px] shrink-0 items-center rounded-full transition-colors duration-200 disabled:opacity-50',
        checked ? 'bg-switch-on' : 'bg-fill-strong',
      )}
    >
      <span
        className={clsx(
          'inline-block h-[27px] w-[27px] rounded-full bg-white shadow-[0_2px_4px_rgba(0,0,0,0.2),0_0_1px_rgba(0,0,0,0.1)] transition-transform duration-200',
          checked ? 'translate-x-[22px]' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

// iOS segmented control: a pill track with a raised selected segment. Use
// role="tablist" when it switches views (tabs), the default radiogroup when it
// picks a value.
export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: LucideIcon;
  // Extra content after the label (a count, a dot).
  extra?: ReactNode;
  disabled?: boolean;
  title?: string;
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  role = 'radiogroup',
  size = 'md',
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SegmentedOption<T>[];
  label: string;
  role?: 'radiogroup' | 'tablist';
  size?: 'sm' | 'md';
  className?: string;
}) {
  // The raised thumb is one element that slides to the selected button.
  const track = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);
  const [animate, setAnimate] = useState(false); // not on the first placement
  const selectedIndex = options.findIndex((o) => o.value === value);

  useLayoutEffect(() => {
    const el = track.current;
    if (!el) return;
    const measure = () => {
      const btn = el.querySelectorAll<HTMLElement>(':scope > button')[selectedIndex];
      setThumb(btn ? { left: btn.offsetLeft, width: btn.offsetWidth } : null);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    el.querySelectorAll(':scope > button').forEach((b) => ro.observe(b));
    return () => ro.disconnect();
  }, [selectedIndex, options.length]);

  useEffect(() => {
    if (!thumb || animate) return;
    const raf = requestAnimationFrame(() => setAnimate(true));
    return () => cancelAnimationFrame(raf);
  }, [thumb, animate]);

  return (
    <div
      ref={track}
      role={role}
      aria-label={label}
      // Scrolls sideways rather than overflowing when there isn't room.
      className={clsx(
        'relative inline-flex max-w-full shrink-0 items-center gap-0.5 overflow-x-auto rounded-full bg-segment-track p-[3px] [scrollbar-width:none]',
        className,
      )}
    >
      {thumb && (
        <span
          aria-hidden
          className={clsx(
            'motion-slide pointer-events-none absolute top-[3px] bottom-[3px] left-0 rounded-full bg-segment-thumb shadow-[0_1px_3px_rgba(0,0,0,0.12),0_1px_1px_rgba(0,0,0,0.04)]',
            animate && 'transition-[transform,width] duration-[280ms] ease-[cubic-bezier(0.22,1,0.36,1)]',
          )}
          style={{ width: thumb.width, transform: `translateX(${thumb.left}px)` }}
        />
      )}
      {options.map((o) => {
        const selected = o.value === value;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            type="button"
            role={role === 'tablist' ? 'tab' : 'radio'}
            aria-selected={role === 'tablist' ? selected : undefined}
            aria-checked={role === 'radiogroup' ? selected : undefined}
            disabled={o.disabled}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={clsx(
              'relative inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full whitespace-nowrap transition-colors disabled:opacity-50',
              size === 'sm' ? 'h-[26px] px-3 text-[12.5px]' : 'h-[30px] px-4 text-[13px]',
              selected
                ? clsx('font-semibold text-text', !thumb && 'bg-segment-thumb')
                : 'text-text/75 hover:text-text',
            )}
          >
            {Icon && <Icon size={size === 'sm' ? 13 : 14} className="shrink-0" />}
            {o.label}
            {o.extra}
          </button>
        );
      })}
    </div>
  );
}

// Label + control + optional hint, stacked.
export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={clsx('flex flex-col gap-1.5', className)}>
      <span className="text-[13px] font-medium text-text">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  );
}

// A row with text on the left and a control (switch, select) on the right.
export function SettingRow({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 py-3">
      <div className="min-w-0">
        <div className="text-[14px] font-medium">{title}</div>
        {description && <div className="mt-0.5 text-[12.5px] text-muted">{description}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

// ---------- Layout ----------

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 pb-6">
      <div className="min-w-0">
        <h1 className="font-display text-[28px] leading-tight font-bold tracking-[-0.02em]">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Card({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
  padded = true,
  open,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
  padded?: boolean;
  // Makes the body collapsible: false folds it away (animated), leaving the header.
  open?: boolean;
}) {
  const collapsible = open !== undefined;
  const bodyClass = clsx(padded && (title || actions ? 'px-5 pt-3 pb-5' : 'p-5'), bodyClassName);
  return (
    <section className={clsx('surface rounded-card', className)}>
      {(title || actions) && (
        <div
          className={clsx(
            'flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-5 pt-[18px]',
            collapsible && 'transition-[padding] duration-[280ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
            collapsible && !open ? 'pb-[18px]' : padded ? 'pb-1' : 'border-b border-line pb-3.5',
          )}
        >
          {/* Actions wrap below the title instead of squeezing it. The title sets the
              width that decides this; the description (w-0 min-w-full) just fills it. */}
          <div className="min-w-[min(100%,14rem)] flex-auto">
            {title && <h2 className="text-[15px] font-semibold">{title}</h2>}
            {description && <p className="mt-0.5 w-0 min-w-full text-[13px] text-muted">{description}</p>}
          </div>
          {actions && <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {collapsible ? (
        <Collapse open={open} className={bodyClass}>
          {children}
        </Collapse>
      ) : (
        <div className={bodyClass}>{children}</div>
      )}
    </section>
  );
}

// ---------- Feedback ----------

type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'rec';

const badgeTone: Record<Tone, string> = {
  neutral: 'bg-fill text-muted',
  accent: 'bg-accent-soft text-accent',
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  danger: 'bg-danger-soft text-danger',
  rec: 'bg-danger-soft text-rec',
};

export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap',
        badgeTone[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

const calloutStyle = {
  info: { icon: Info, cls: 'bg-accent-soft', iconCls: 'text-accent' },
  warn: { icon: AlertTriangle, cls: 'bg-warn-soft', iconCls: 'text-warn' },
  error: { icon: XCircle, cls: 'bg-danger-soft', iconCls: 'text-danger' },
  success: { icon: CheckCircle2, cls: 'bg-ok-soft', iconCls: 'text-ok' },
};

export function Callout({
  tone = 'info',
  title,
  children,
  className,
}: {
  tone?: keyof typeof calloutStyle;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const { icon: Icon, cls, iconCls } = calloutStyle[tone];
  return (
    <div className={clsx('flex gap-3 rounded-2xl px-4 py-3 text-[13px]', cls, className)}>
      <Icon size={16} className={clsx('mt-0.5 shrink-0', iconCls)} />
      <div className="min-w-0 space-y-1">
        {title && <div className="font-medium text-text">{title}</div>}
        {children && <div className="text-text/75 [&_a]:text-accent-ink [&_a]:underline">{children}</div>}
      </div>
    </div>
  );
}

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return <Loader2 size={size} className={clsx('animate-spin text-muted', className)} />;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-fill text-muted">
        <Icon size={22} />
      </div>
      <div className="text-[15px] font-semibold">{title}</div>
      {description && <p className="mt-1 max-w-sm text-sm text-muted">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

// Numbered how-to steps (used for API key and OBS setup guides).
export function Steps({ steps }: { steps: ReactNode[] }) {
  return (
    <ol className="space-y-3">
      {steps.map((step, i) => (
        <li key={i} className="flex gap-3 text-[13px] leading-relaxed">
          <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent">
            {i + 1}
          </span>
          <div className="min-w-0 text-muted [&_a]:text-accent [&_a]:underline [&_b]:font-medium [&_b]:text-text [&_code]:rounded-md [&_code]:bg-fill [&_code]:px-1 [&_code]:font-mono [&_code]:text-[12px] [&_code]:text-text">
            {step}
          </div>
        </li>
      ))}
    </ol>
  );
}

// ---------- Modal ----------

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 'max-w-lg',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Stays mounted briefly after `open` turns false so it can fade out; the
  // last content is kept for that exit (callers often clear their state too).
  const { mounted, closing } = usePresence(open, 200);
  const last = useRef({ title, children, footer });
  if (open) last.current = { title, children, footer };
  if (!mounted) return null;
  const view = open ? { title, children, footer } : last.current;
  const state = closing ? 'closed' : 'open';
  // In a portal: a glass card (backdrop-filter) would otherwise become the
  // containing block of this fixed overlay and trap it inside the card.
  return createPortal(
    <div
      className={clsx('fixed inset-0 z-50 flex items-center justify-center p-6', closing && 'pointer-events-none')}
      onMouseDown={closing ? undefined : onClose}
    >
      <div aria-hidden data-motion="fade" data-state={state} className="absolute inset-0 bg-black/50" />
      <div
        role="dialog"
        aria-modal="true"
        data-motion="pop"
        data-state={state}
        className={clsx('surface-pop relative w-full rounded-3xl border border-line', width)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 pt-5 pb-2">
          <h2 className="text-[17px] font-semibold">{view.title}</h2>
          <IconButton icon={X} label="Close" onClick={onClose} className="bg-fill" />
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-6 py-3">{view.children}</div>
        {view.footer && <div className="flex justify-end gap-2 px-6 pt-2 pb-5">{view.footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ---------- Toasts ----------

// Raised with toast() from lib/toast.ts (re-exported here for components).
export function Toaster() {
  const items = useToasts((s) => s.items);
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-80 flex-col gap-2">
      {items.map((t) => {
        const Icon = t.tone === 'success' ? CheckCircle2 : t.tone === 'error' ? XCircle : Info;
        return (
          <div
            key={t.id}
            data-motion="rise"
            data-state={t.leaving ? 'closed' : 'open'}
            className="surface-pop pointer-events-auto flex gap-2.5 rounded-2xl border border-line px-4 py-3 text-[13px]"
          >
            <Icon
              size={16}
              className={clsx(
                'mt-0.5 shrink-0',
                t.tone === 'success' ? 'text-ok' : t.tone === 'error' ? 'text-danger' : 'text-accent',
              )}
            />
            <span className="min-w-0 break-words">{t.message}</span>
          </div>
        );
      })}
    </div>
  );
}
