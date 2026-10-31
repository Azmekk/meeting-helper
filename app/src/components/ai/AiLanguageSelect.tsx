// "Respond in…" picker shown next to AI actions. It edits the same setting as
// Settings → AI → Output language, so the last choice sticks as the default.
import { Languages } from 'lucide-react';
import { languageName } from '../../lib/ai/prompts';
import { useSettings } from '../../lib/settings';
import { saveSettings } from '../settings/common';
import { clsx } from '../ui';

export const OUTPUT_LANGUAGES = ['en', 'bg', 'de', 'ru', 'uk', 'fr', 'es', 'it', 'pt', 'nl', 'pl', 'ro', 'el', 'tr', 'sr', 'mk', 'cs'];

export function AiLanguageSelect({ className }: { className?: string }) {
  const value = useSettings((s) => s.settings.aiOutputLanguage) || 'meeting';
  return (
    <label
      className={clsx('inline-flex h-8 items-center gap-1.5 rounded-md border border-line px-2 text-[12.5px] text-muted', className)}
      title="Language the AI writes in"
    >
      <Languages size={13} className="shrink-0" />
      <select
        aria-label="AI response language"
        value={value}
        onChange={(e) => void saveSettings({ aiOutputLanguage: e.target.value })}
        className="min-w-0 cursor-pointer bg-transparent text-text focus:outline-none"
      >
        <option value="meeting">Meeting’s language</option>
        {OUTPUT_LANGUAGES.map((code) => (
          <option key={code} value={code}>
            {languageName(code)}
          </option>
        ))}
      </select>
    </label>
  );
}
