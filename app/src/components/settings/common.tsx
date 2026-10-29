// Small helpers shared by the settings sections.
import { openUrl } from '@tauri-apps/plugin-opener';
import { Check, ExternalLink as ExternalLinkIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { Input, clsx, errorMessage, toast } from '../ui';
import { useSettings, type Settings } from '../../lib/settings';

// Plain hrefs don't open the system browser inside Tauri, so route clicks
// through the opener plugin.
export function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        openUrl(href).catch((err) => toast(`Couldn't open the link: ${errorMessage(err)}`, 'error'));
      }}
      className="inline-flex items-center gap-0.5"
    >
      {children}
      <ExternalLinkIcon size={11} className="shrink-0 opacity-70" />
    </a>
  );
}

// ---------- "Saved" indicator ----------

const useSavedFlash = create<{ at: number }>(() => ({ at: 0 }));

function flashSaved() {
  useSavedFlash.setState({ at: Date.now() });
}

// Persists a settings patch and flashes the "Saved" tick in the page header.
export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  try {
    await useSettings.getState().update(patch);
    flashSaved();
  } catch (err) {
    toast(`Couldn't save settings: ${errorMessage(err)}`, 'error');
  }
}

export function SavedIndicator() {
  const at = useSavedFlash((s) => s.at);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!at) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 1600);
    return () => clearTimeout(t);
  }, [at]);
  return (
    <span
      aria-live="polite"
      className={clsx(
        'inline-flex items-center gap-1 text-[13px] text-ok transition-opacity duration-300',
        visible ? 'opacity-100' : 'opacity-0',
      )}
    >
      <Check size={14} /> Saved
    </span>
  );
}

// ---------- Text input that commits on blur / Enter ----------

export function CommitInput({
  value,
  onCommit,
  className,
  ...rest
}: {
  value: string;
  onCommit: (v: string) => void;
  className?: string;
  placeholder?: string;
  spellCheck?: boolean;
  id?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <Input
      {...rest}
      className={className}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setDraft(value);
      }}
    />
  );
}
