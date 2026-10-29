import { ArrowUpToLine, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useSettings } from '../../lib/settings';
import { Card, IconButton, Select, Switch, Textarea, clsx } from '../ui';
import { saveSettings } from './common';

const LANGUAGES: [string, string][] = [
  ['bg', 'Bulgarian'],
  ['en', 'English'],
  ['de', 'German'],
  ['ru', 'Russian'],
  ['uk', 'Ukrainian'],
  ['fr', 'French'],
  ['es', 'Spanish'],
  ['it', 'Italian'],
  ['pt', 'Portuguese'],
  ['nl', 'Dutch'],
  ['pl', 'Polish'],
  ['ro', 'Romanian'],
  ['el', 'Greek'],
  ['tr', 'Turkish'],
  ['sr', 'Serbian'],
  ['mk', 'Macedonian'],
  ['cs', 'Czech'],
];

const NAMES = Object.fromEntries(LANGUAGES);
const langName = (code: string) => NAMES[code] ?? code;

function parseTerms(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push(t);
    }
  }
  return out;
}

export function LanguageSection() {
  const languages = useSettings((s) => s.settings.languages);
  const terms = useSettings((s) => s.settings.terms);
  const autoDetect = languages.length === 0;
  const lastList = useRef<string[]>(languages.length ? languages : ['bg', 'en']);
  useEffect(() => {
    if (languages.length) lastList.current = languages;
  }, [languages]);

  const setLanguages = (next: string[]) => saveSettings({ languages: next });
  const available = LANGUAGES.filter(([code]) => !languages.includes(code));

  const [termsDraft, setTermsDraft] = useState(terms.join('\n'));
  useEffect(() => setTermsDraft(terms.join('\n')), [terms]);
  const commitTerms = () => {
    const next = parseTerms(termsDraft);
    if (next.join('\n') !== terms.join('\n')) saveSettings({ terms: next });
    else setTermsDraft(terms.join('\n'));
  };

  return (
    <Card title="Language" description="Tell the transcriber what to expect. Better hints mean fewer mistakes.">
      <div className="space-y-6">
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-6">
            <div>
              <div className="text-sm font-medium">Auto-detect language</div>
              <div className="text-xs text-muted">Let the provider work out the language by itself.</div>
            </div>
            <Switch
              label="Auto-detect language"
              checked={autoDetect}
              onChange={(on) => setLanguages(on ? [] : lastList.current)}
            />
          </div>

          {!autoDetect && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                {languages.map((code, i) => (
                  <span
                    key={code}
                    className={clsx(
                      'inline-flex h-8 items-center gap-1.5 rounded-full border pr-1 pl-3 text-[13px]',
                      i === 0 ? 'border-accent/30 bg-accent-soft text-text' : 'border-line bg-panel',
                    )}
                  >
                    <span className="font-medium">{langName(code)}</span>
                    <span className="font-mono text-[11px] text-faint">{code}</span>
                    {i === 0 ? (
                      <span className="ml-0.5 rounded-full bg-accent px-1.5 text-[10.5px] font-semibold text-on-accent">
                        MAIN
                      </span>
                    ) : (
                      <IconButton
                        icon={ArrowUpToLine}
                        size="sm"
                        label={`Make ${langName(code)} the main language`}
                        onClick={() => setLanguages([code, ...languages.filter((c) => c !== code)])}
                      />
                    )}
                    <IconButton
                      icon={X}
                      size="sm"
                      label={`Remove ${langName(code)}`}
                      onClick={() => setLanguages(languages.filter((c) => c !== code))}
                    />
                  </span>
                ))}

                {available.length > 0 && (
                  <div className="relative">
                    <Plus
                      size={14}
                      className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted"
                    />
                    <Select
                      aria-label="Add a language"
                      value=""
                      onChange={(e) => e.target.value && setLanguages([...languages, e.target.value])}
                      className="h-8 w-auto rounded-full pl-7 text-[13px]"
                    >
                      <option value="">Add language</option>
                      {available.map(([code, label]) => (
                        <option key={code} value={code}>
                          {label} ({code})
                        </option>
                      ))}
                    </Select>
                  </div>
                )}
              </div>
              <p className="text-xs leading-relaxed text-muted">
                The first language is the main one. <b className="font-medium text-text">Soniox</b> uses all of them and
                copes well with meetings that switch between Bulgarian and English.{' '}
                <b className="font-medium text-text">ElevenLabs</b> only uses the main language.
              </p>
            </>
          )}
        </div>

        <div className="flex flex-col gap-1.5 border-t border-line pt-5">
          <label htmlFor="terms" className="text-[13px] font-medium">
            Custom vocabulary
          </label>
          <Textarea
            id="terms"
            rows={5}
            spellCheck={false}
            placeholder={'Teammates’ names, product names, jargon…\nOne term per line'}
            value={termsDraft}
            onChange={(e) => setTermsDraft(e.target.value)}
            onBlur={commitTerms}
          />
          <span className="text-xs text-muted">
            One term per line. Helps with names and words a transcriber wouldn't know.
            {terms.length > 0 && ` ${terms.length} term${terms.length === 1 ? '' : 's'} saved.`} ElevenLabs charges
            extra for key terms (about $0.05 per hour).
          </span>
        </div>
      </div>
    </Card>
  );
}
