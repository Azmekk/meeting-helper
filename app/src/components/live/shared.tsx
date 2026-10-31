// Bits shared by the live panel (main window) and the overlay window.
import { IS_MAC } from '../../lib/platform';
import type { LiveAiTask, LiveLine, LivePartial, TrackState } from '../../lib/live';
import { formatTimestamp } from '../../lib/format';
import { clsx } from '../ui';

export function costLabel(usd: number | null): string {
  if (usd == null) return 'cost unknown';
  if (usd < 0.001) return '< $0.001';
  return `~$${usd < 0.1 ? usd.toFixed(3) : usd.toFixed(2)}`;
}

// "CommandOrControl+Alt+H" → "Ctrl+Alt+H" (or "Cmd+Alt+H" on macOS).
export function hotkeyLabel(accelerator: string): string {
  return accelerator.replace(/CommandOrControl|CmdOrCtrl/gi, IS_MAC ? 'Cmd' : 'Ctrl');
}

export const TRACK_LABEL: Record<string, string> = { mic: 'Your mic', desktop: 'Others', mix: 'Audio' };

export const STATE_LABEL: Record<TrackState, { text: string; tone: 'neutral' | 'ok' | 'warn' | 'danger' }> = {
  catchingUp: { text: 'starting', tone: 'neutral' },
  live: { text: 'live', tone: 'ok' },
  reconnecting: { text: 'reconnecting', tone: 'warn' },
  stopped: { text: 'stopped', tone: 'neutral' },
  error: { text: 'error', tone: 'danger' },
};

export const TASK_LABEL: Record<LiveAiTask, string> = { live: 'Notes model', answer: 'Answer model' };

export function LineView({ line, compact }: { line: LiveLine; compact?: boolean }) {
  return (
    <div className={clsx('leading-relaxed', compact ? 'text-[12.5px]' : 'text-[13px]')}>
      {!compact && <span className="mr-2 font-mono text-[11px] text-faint">{formatTimestamp(line.startMs)}</span>}
      <span className={clsx('mr-1.5 font-medium', line.isSelf ? 'text-accent' : 'text-text')}>{line.speaker}:</span>
      <span className="text-text">{line.text}</span>
    </div>
  );
}

// Provisional text is dimmed: Soniox may still change it.
export function PartialView({ partial, compact }: { partial: LivePartial; compact?: boolean }) {
  return (
    <div className={clsx('leading-relaxed', compact ? 'text-[12.5px]' : 'text-[13px]')}>
      <span className="mr-1.5 font-medium text-muted">{partial.speaker}:</span>
      <span className="text-text">{partial.final}</span>
      <span className="text-faint">{partial.provisional}</span>
    </div>
  );
}

// Model output is Markdown-ish plain text; keep line breaks and bold headings readable.
export function PlainMarkdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={clsx('text-[13px] leading-relaxed whitespace-pre-wrap', className)}>
      {text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
        /^\*\*[^*]+\*\*$/.test(part) ? (
          <b key={i} className="font-semibold">
            {part.slice(2, -2)}
          </b>
        ) : (
          part
        ),
      )}
    </div>
  );
}
