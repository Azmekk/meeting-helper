// A one-term-per-line vocabulary box that saves when it loses focus. Used for
// folder, meeting and Record-screen vocabulary (see lib/terms.ts).
import { useEffect, useState } from 'react';
import { parseTerms } from '../lib/terms';
import { Textarea } from './ui';

export function TermsField({
  terms,
  onSave,
  rows = 3,
  id,
  placeholder = 'Names, product names, jargon…\nOne term per line',
}: {
  terms: string[];
  onSave: (terms: string[]) => void | Promise<void>;
  rows?: number;
  id?: string;
  placeholder?: string;
}) {
  const saved = terms.join('\n');
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);

  const commit = () => {
    const next = parseTerms(draft);
    if (next.join('\n') !== saved) void onSave(next);
    else setDraft(saved);
  };

  return (
    <Textarea
      id={id}
      rows={rows}
      spellCheck={false}
      placeholder={placeholder}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      className="resize-y text-[13px]"
    />
  );
}
