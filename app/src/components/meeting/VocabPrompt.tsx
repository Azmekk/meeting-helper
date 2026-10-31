// After a transcript correction: offer to add the newly typed words to the
// custom vocabulary, so the next transcription gets them right.
import { Folder as FolderIcon, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as db from '../../lib/db';
import { refreshFolders } from '../../lib/folders';
import { emitMeetingChanged } from '../../lib/pipeline';
import { getSettings } from '../../lib/settings';
import { mergeTerms } from '../../lib/terms';
import type { Folder, Meeting } from '../../lib/types';
import { saveSettings } from '../settings/common';
import { Button, IconButton, clsx, errorMessage, toast, usePresence } from '../ui';

const WORD_RE = /[\p{L}\p{M}\p{N}]+(?:['’-][\p{L}\p{M}\p{N}]+)*/gu;

export function wordTokens(text: string): string[] {
  return text.match(WORD_RE) ?? [];
}

// Words in `after` that weren't in `before`, skipping short words, numbers and
// anything the vocabulary already has. Keeps the casing as typed.
export function newVocabWords(before: string, after: string, vocab: string[]): string[] {
  const known = new Set(wordTokens(before).map((w) => w.toLowerCase()));
  for (const term of vocab) {
    known.add(term.toLowerCase());
    for (const w of wordTokens(term)) known.add(w.toLowerCase());
  }
  return mergeTerms(wordTokens(after).filter((w) => w.length >= 3 && /\p{L}/u.test(w) && !known.has(w.toLowerCase())));
}

const AUTO_DISMISS_MS = 15000;

export function VocabPrompt({
  words,
  meeting,
  folder,
  onClose,
}: {
  // null hides the prompt.
  words: string[] | null;
  meeting: Meeting | null;
  folder: Folder | null;
  onClose: () => void;
}) {
  const open = words != null && words.length > 0;
  const { mounted, closing } = usePresence(open);
  const last = useRef<string[]>([]);
  if (open) last.current = words;
  const shown = open ? words : last.current;

  // Words switched off; new ones arrive switched on.
  const [off, setOff] = useState<Set<string>>(() => new Set());
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    if (!open) {
      setOff(new Set());
      setHovered(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open || hovered) return;
    const t = setTimeout(onClose, AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [open, hovered, words, onClose]);

  if (!mounted) return null;

  const picked = shown.filter((w) => !off.has(w));

  const add = async (layer: 'meeting' | 'folder' | 'all') => {
    if (!picked.length) return;
    onClose();
    const what = picked.length === 1 ? `“${picked[0]}”` : `${picked.length} words`;
    try {
      if (layer === 'meeting' && meeting) {
        const current = (await db.getMeeting(meeting.id))?.terms ?? meeting.terms;
        await db.updateMeeting(meeting.id, { terms: mergeTerms(current, picked) });
        emitMeetingChanged(meeting.id);
        toast(`Added ${what} to this meeting's vocabulary`, 'success');
      } else if (layer === 'folder' && folder) {
        const current = (await db.getFolder(folder.id))?.terms ?? folder.terms;
        await db.setFolderTerms(folder.id, mergeTerms(current, picked));
        await refreshFolders();
        toast(`Added ${what} to ${folder.name}'s vocabulary`, 'success');
      } else if (layer === 'all') {
        await saveSettings({ terms: mergeTerms(getSettings().terms, picked) });
        toast(`Added ${what} to the default vocabulary`, 'success');
      }
    } catch (err) {
      toast(`Couldn't save the vocabulary: ${errorMessage(err)}`, 'error');
    }
  };

  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
      <div
        data-motion="rise"
        data-state={closing ? 'closed' : 'open'}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className="surface-pop pointer-events-auto w-full max-w-md rounded-2xl border border-line px-4 py-3"
      >
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 text-[13px] font-semibold text-text">Add to vocabulary?</p>
          <IconButton size="sm" icon={X} label="Dismiss" onClick={onClose} />
        </div>
        <p className="mt-0.5 text-xs text-muted">So future transcriptions spell these right.</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {shown.map((w) => {
            const on = !off.has(w);
            return (
              <button
                key={w}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  setOff((s) => {
                    const next = new Set(s);
                    if (on) next.add(w);
                    else next.delete(w);
                    return next;
                  })
                }
                className={clsx(
                  'h-7 rounded-full px-3 text-[13px] font-medium transition-colors',
                  on ? 'bg-accent-soft text-accent-ink' : 'bg-fill text-faint line-through',
                )}
              >
                {w}
              </button>
            );
          })}
        </div>
        <div className="mt-3 flex flex-wrap justify-end gap-1.5">
          {meeting && (
            <Button size="sm" variant="secondary" disabled={!picked.length} onClick={() => add('meeting')}>
              This meeting
            </Button>
          )}
          {folder && (
            <Button
              size="sm"
              variant="secondary"
              icon={FolderIcon}
              disabled={!picked.length}
              onClick={() => add('folder')}
              title={`Every meeting in ${folder.name}`}
              className="max-w-48"
            >
              <span className="truncate">{folder.name}</span>
            </Button>
          )}
          <Button size="sm" disabled={!picked.length} onClick={() => add('all')} title="The default list, used for every meeting">
            Everywhere
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
