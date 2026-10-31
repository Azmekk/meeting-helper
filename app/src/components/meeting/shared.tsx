// Small pieces shared by the meetings list and the meeting editor.
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { formatUsd } from '../../lib/format';
import type { Job } from '../../lib/pipeline';
import type { MeetingStatus, ProviderId, Transcript } from '../../lib/types';
import { Badge, Spinner, clsx, usePresence } from '../ui';

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  soniox: 'Soniox',
  elevenlabs: 'ElevenLabs',
};

export const PROVIDER_IDS: ProviderId[] = ['soniox', 'elevenlabs'];

export const MEDIA_EXTENSIONS = ['mp4', 'mkv', 'mov', 'webm', 'm4a', 'mp3', 'wav', 'flac', 'ogg', 'opus', 'aac'];
const AUDIO_EXTENSIONS = new Set(['m4a', 'mp3', 'wav', 'flac', 'ogg', 'opus', 'aac', 'oga', 'weba']);

export function isAudioPath(path: string | null | undefined): boolean {
  const ext = path?.split('.').pop()?.toLowerCase() ?? '';
  return AUDIO_EXTENSIONS.has(ext);
}

export function fileBaseName(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  return name.replace(/\.[^.]+$/, '') || name;
}

export function isJobActive(job: Job | undefined): job is Job {
  return !!job && job.stage !== 'done' && job.stage !== 'error';
}

// "Soniox · stt-async-v5 · 30 Oct 14:02 · $0.04"
export function transcriptLabel(t: Transcript): string {
  const when = new Date(t.createdAt).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = [PROVIDER_LABEL[t.provider] ?? t.provider, t.model, when];
  if (t.costUsd != null) parts.push(formatUsd(t.costUsd));
  return parts.join(' · ');
}

// ---------- Speaker colors ----------

// Distinct hues; lightness flips between themes via light-dark() so the text
// stays readable on both the light and the dark panel.
const HUES = [205, 22, 150, 275, 45, 335, 180, 240];

export function speakerColor(index: number): string {
  if (index < 0) return 'var(--c-faint)';
  const h = HUES[index % HUES.length];
  // Past the first round, shift the hue a bit so repeats are still distinguishable.
  const shift = Math.floor(index / HUES.length) * 17;
  const hue = (h + shift) % 360;
  return `light-dark(hsl(${hue} 58% 36%), hsl(${hue} 62% 72%))`;
}

// Text is pulled toward the theme's text color so even the lighter hues
// (yellow, cyan) clear 4.5:1 on their own tint.
export function speakerChipStyle(color: string): CSSProperties {
  return {
    color: `color-mix(in srgb, ${color} 72%, var(--c-text))`,
    backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)`,
  };
}

// "Иван Петров" -> "ИП", "Speaker 2" -> "S2".
export function speakerInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const first = [...words[0]][0] ?? '?';
  const second = words.length > 1 ? (/^\d+$/.test(words[1]) ? words[1] : [...words[1]][0]) : '';
  return (first + second).toUpperCase();
}

// Round initials avatar in the speaker's color.
export function SpeakerAvatar({ name, color, className }: { name: string; color: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={clsx(
        'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11.5px] font-bold tracking-tight',
        className,
      )}
      style={speakerChipStyle(color)}
    >
      {speakerInitials(name)}
    </span>
  );
}

export function SpeakerDot({ color, className }: { color: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={clsx('inline-block h-2.5 w-2.5 shrink-0 rounded-full', className)}
      style={{ backgroundColor: color }}
    />
  );
}

// ---------- Status ----------

export function StatusBadge({ status, job }: { status: MeetingStatus; job?: Job }) {
  if (isJobActive(job) || status === 'processing') {
    return (
      <Badge tone="accent">
        <Spinner size={11} className="text-accent" />
        Processing
      </Badge>
    );
  }
  switch (status) {
    case 'recording':
      return (
        <Badge tone="rec">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-rec" />
          Recording
        </Badge>
      );
    case 'queued':
      return <Badge>Not transcribed</Badge>;
    case 'ready':
      return <Badge tone="ok">Ready</Badge>;
    case 'error':
      return <Badge tone="danger">Failed</Badge>;
    default:
      return <Badge>{status}</Badge>;
  }
}

// ---------- Popover ----------

// Closes on outside mousedown and Escape. Position it with `className`
// relative to a `relative` parent.
export function Popover({
  open,
  onClose,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Fades out before unmounting, still showing what it showed while open.
  const { mounted, closing } = usePresence(open);
  const last = useRef(children);
  if (open) last.current = children;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const el = ref.current;
      // The trigger is the popover's previous sibling inside the same wrapper;
      // treat clicks inside the wrapper as "inside" so the trigger can toggle.
      const wrapper = el?.parentElement;
      if (wrapper && !wrapper.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!mounted) return null;
  // Grow from the corner nearest the trigger.
  const up = /\bbottom-full\b/.test(className ?? '');
  const side = /(^|\s)left-/.test(className ?? '') ? 'left' : 'right';
  return (
    <div
      ref={ref}
      data-motion={up ? 'rise' : 'drop'}
      data-state={closing ? 'closed' : 'open'}
      style={{ transformOrigin: `${up ? 'bottom' : 'top'} ${side}` }}
      className={clsx(
        'surface-pop absolute z-40 min-w-48 rounded-2xl border border-line p-1.5',
        className,
      )}
    >
      {open ? children : last.current}
    </div>
  );
}

export function MenuItem({
  icon: Icon,
  children,
  onClick,
  hint,
  danger,
  disabled,
  active,
}: {
  icon?: React.ComponentType<{ size?: number; className?: string }>;
  children: ReactNode;
  onClick: () => void;
  hint?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        'flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-[7px] text-left text-[13.5px] transition-colors',
        'disabled:pointer-events-none disabled:opacity-50',
        danger ? 'text-danger hover:bg-danger-soft' : 'text-text hover:bg-hover',
        active && 'bg-hover',
      )}
    >
      {Icon && <Icon size={15} className={danger ? 'text-danger' : 'text-muted'} />}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="shrink-0 text-xs text-faint">{hint}</span>}
    </button>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-semibold tracking-[0.04em] text-muted uppercase">{children}</div>;
}

export function MenuSeparator() {
  return <div className="mx-2.5 my-1 h-px bg-line" />;
}
