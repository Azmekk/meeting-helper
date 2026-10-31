// "Respond in…" picker shown next to AI actions. It edits the same setting as
// Settings → AI → Output language, so the last choice sticks as the default.
import { Languages } from 'lucide-react';
import { languageName } from '../../lib/ai/prompts';
import { useSettings } from '../../lib/settings';
import { saveSettings } from '../settings/common';
import { Select, clsx } from '../ui';

export const OUTPUT_LANGUAGES = ['en', 'bg', 'de', 'ru', 'uk', 'fr', 'es', 'it', 'pt', 'nl', 'pl', 'ro', 'el', 'tr', 'sr', 'mk', 'cs'];

export function AiLanguageSelect({ className }: { className?: string }) {
  const value = useSettings((s) => s.settings.aiOutputLanguage) || 'meeting';
  return (
    <span className={clsx('inline-flex h-[30px] max-w-full min-w-0 items-center rounded-full bg-fill pl-3 text-[12.5px] text-text/80', className)}>
      <Languages size={13} className="shrink-0" aria-hidden="true" />
      <Select
        plain
        aria-label="AI response language"
        title="Language the AI writes in"
        value={value}
        onChange={(e) => void saveSettings({ aiOutputLanguage: e.target.value })}
        className="h-full min-w-0 gap-1.5 rounded-full pr-3 pl-1.5 text-text focus:outline-none"
      >
        <option value="meeting">Meeting’s language</option>
        {OUTPUT_LANGUAGES.map((code) => (
          <option key={code} value={code}>
            {languageName(code)}
          </option>
        ))}
      </Select>
    </span>
  );
}
