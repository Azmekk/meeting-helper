// Model picker shown next to AI actions. Unlike AiLanguageSelect it applies to
// that panel only: the summary model in Settings → AI stays the default.
import { Bot } from 'lucide-react';
import { useState } from 'react';
import { effectiveModel } from '../../lib/ai';
import { useLive } from '../../lib/live';
import { useSettings } from '../../lib/settings';
import { Select, clsx } from '../ui';

// Model ids differ per provider, so a choice only holds for the provider it was made under.
export function useAiModel(): [string, (model: string) => void] {
  const provider = useSettings((s) => s.settings.aiProvider);
  const fallback = useSettings((s) => effectiveModel('summary', s.settings));
  const [chosen, setChosen] = useState<{ provider: string; model: string } | null>(null);
  return [chosen?.provider === provider ? chosen.model : fallback, (model) => setChosen({ provider, model })];
}

export function AiModelSelect({
  value,
  onChange,
  disabled,
  className,
}: {
  value: string;
  onChange: (model: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const options = useLive((s) => s.modelOptions);
  return (
    <span className={clsx('inline-flex h-[30px] max-w-full min-w-0 items-center rounded-full bg-fill pl-3 text-[12.5px] text-text/80', className)}>
      <Bot size={13} className="shrink-0" aria-hidden="true" />
      <Select
        plain
        aria-label="AI model"
        title="Model for this panel. The default is set in Settings → AI."
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="h-full max-w-56 min-w-0 gap-1.5 rounded-full pr-3 pl-1.5 text-text focus:outline-none"
      >
        {[...new Set([value, ...options])].filter(Boolean).map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </Select>
    </span>
  );
}
