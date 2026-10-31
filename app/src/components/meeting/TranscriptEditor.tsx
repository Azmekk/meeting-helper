import { Check, Copy, Merge, Pencil, Plus, Trash2, UserRound } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { formatTimestamp } from '../../lib/format';
import { splitHighlights } from '../../lib/search';
import { useSettings } from '../../lib/settings';
import { mergeTerms } from '../../lib/terms';
import { speakerName, type Folder, type Meeting, type Segment, type Speaker } from '../../lib/types';
import { Button, IconButton, Input, Textarea, clsx, errorMessage, toast } from '../ui';
import { MenuItem, MenuLabel, MenuSeparator, Popover, SpeakerAvatar, speakerChipStyle } from './shared';
import { VocabPrompt, newVocabWords } from './VocabPrompt';

export interface SegmentActions {
  seek: (ms: number, play: boolean) => void;
  editText: (segmentId: number, text: string) => void;
  reassign: (segmentId: number, speakerId: number | null) => void;
  createSpeakerAndAssign: (segmentId: number, name: string) => Promise<void>;
  merge: (segmentId: number) => void;
  remove: (segmentId: number) => void;
}

// What a row needs from the whole transcript. Stable, so rows stay memoized.
interface RowTools {
  allSegments: () => Segment[];
  // A text edit happened; may offer the new words for the vocabulary.
  corrected: (before: string, after: string) => void;
}

export function TranscriptEditor({
  segments,
  speakers,
  colorOf,
  activeId,
  flashId,
  terms,
  matchIds,
  currentMatchId,
  onlyMatches,
  actions,
  onUserScroll,
  meeting = null,
  folder = null,
}: {
  segments: Segment[];
  speakers: Speaker[];
  colorOf: (speakerId: number | null) => string;
  activeId: number | null;
  flashId: number | null;
  // Highlighted strings from the find bar, longest first.
  terms: string[];
  // Segments that match the find bar, or null when it's empty.
  matchIds: Set<number> | null;
  currentMatchId: number | null;
  // Hide segments that don't match.
  onlyMatches: boolean;
  actions: SegmentActions;
  onUserScroll: () => void;
  // For the "add to vocabulary" prompt after a correction.
  meeting?: Meeting | null;
  folder?: Folder | null;
}) {
  const defaultTerms = useSettings((s) => s.settings.terms);
  const vocab = useMemo(
    () => mergeTerms(defaultTerms, folder?.terms ?? [], meeting?.terms ?? []),
    [defaultTerms, folder?.terms, meeting?.terms],
  );
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;
  const vocabRef = useRef(vocab);
  vocabRef.current = vocab;

  // One prompt at a time; corrections made while it's up add to it.
  const [suggested, setSuggested] = useState<string[] | null>(null);
  const closeSuggested = useCallback(() => setSuggested(null), []);
  const tools = useMemo<RowTools>(
    () => ({
      allSegments: () => segmentsRef.current,
      corrected: (before, after) => {
        const words = newVocabWords(before, after, vocabRef.current);
        if (words.length) setSuggested((cur) => mergeTerms(cur ?? [], words));
      },
    }),
    [],
  );

  const speakerById = useMemo(() => new Map(speakers.map((s) => [s.id, s])), [speakers]);
  const filtering = onlyMatches && matchIds != null;

  const visible = useMemo(() => {
    const lastId = segments.length ? segments[segments.length - 1].id : null;
    const list = filtering ? segments.filter((s) => matchIds.has(s.id)) : segments;
    return list.map((s, i) => ({
      seg: s,
      showSpeaker: filtering || i === 0 || list[i - 1].speakerId !== s.speakerId,
      isLast: s.id === lastId,
    }));
  }, [segments, filtering, matchIds]);

  const prompt = <VocabPrompt words={suggested} meeting={meeting} folder={folder} onClose={closeSuggested} />;

  if (filtering && visible.length === 0) {
    return (
      <>
        <p className="surface rounded-card px-3 py-10 text-center text-sm text-muted">No lines match your search.</p>
        {prompt}
      </>
    );
  }

  return (
    <div onWheel={onUserScroll} onTouchMove={onUserScroll} className="pb-[30vh]">
      <div className="surface rounded-card px-3 pt-1 pb-3">
      {visible.map(({ seg, showSpeaker, isLast }) => (
        <SegmentRow
          key={seg.id}
          segment={seg}
          speaker={seg.speakerId != null ? speakerById.get(seg.speakerId) ?? null : null}
          speakers={speakers}
          color={colorOf(seg.speakerId)}
          colorOf={colorOf}
          showSpeaker={showSpeaker}
          isLast={isLast}
          active={seg.id === activeId}
          flash={seg.id === flashId}
          current={seg.id === currentMatchId}
          terms={matchIds?.has(seg.id) ? terms : NO_TERMS}
          actions={actions}
          tools={tools}
        />
      ))}
      </div>
      {prompt}
    </div>
  );
}

const SegmentRow = memo(function SegmentRow({
  segment: seg,
  speaker,
  speakers,
  color,
  colorOf,
  showSpeaker,
  isLast,
  active,
  flash,
  current,
  terms,
  actions,
  tools,
}: {
  segment: Segment;
  speaker: Speaker | null;
  speakers: Speaker[];
  color: string;
  colorOf: (speakerId: number | null) => string;
  showSpeaker: boolean;
  isLast: boolean;
  active: boolean;
  flash: boolean;
  current: boolean;
  terms: string[];
  actions: SegmentActions;
  tools: RowTools;
}) {
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!confirmDelete) return;
    const t = setTimeout(() => setConfirmDelete(false), 3000);
    return () => clearTimeout(t);
  }, [confirmDelete]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(seg.text);
      setCopied(true);
    } catch (err) {
      toast(`Couldn't copy: ${errorMessage(err)}`, 'error');
    }
  };

  const name = speaker ? speakerName(speaker) : 'Unknown speaker';

  return (
    <div
      data-seg={seg.id}
      className={clsx(
        'group relative grid grid-cols-[4.25rem_minmax(0,1fr)] gap-x-3 rounded-2xl px-3 py-2 transition-colors duration-300',
        showSpeaker && 'mt-3',
        active ? 'bg-highlight/70' : 'hover:bg-hover/60',
        flash && 'ring-2 ring-accent',
      )}
    >
      <div className={clsx(showSpeaker && 'pt-[30px]')}>
        <button
          type="button"
          onClick={() => actions.seek(seg.startMs, true)}
          title="Play from here"
          className={clsx(
            'rounded-full px-2 py-0.5 text-xs font-medium tabular-nums transition-colors hover:bg-accent-soft hover:text-accent-ink',
            active ? 'bg-accent-soft text-accent-ink' : 'text-muted',
          )}
        >
          {formatTimestamp(seg.startMs)}
        </button>
      </div>

      <div className="min-w-0">
        <div className="relative">
          {showSpeaker && (
            <button
              type="button"
              onClick={() => setPickerOpen((o) => !o)}
              title="Change speaker"
              className="mb-1 inline-flex h-[26px] max-w-full items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold transition-opacity hover:opacity-80"
              style={speakerChipStyle(color)}
            >
              <span className="truncate">{name}</span>
              {speaker?.isSelf && <span className="text-[11px] font-medium opacity-70">· you</span>}
            </button>
          )}
          <SpeakerPicker
            open={pickerOpen}
            onClose={() => setPickerOpen(false)}
            currentId={seg.speakerId}
            speakers={speakers}
            colorOf={colorOf}
            onPick={(id) => {
              setPickerOpen(false);
              if (id !== seg.speakerId) actions.reassign(seg.id, id);
            }}
            onCreate={async (n) => {
              setPickerOpen(false);
              await actions.createSpeakerAndAssign(seg.id, n);
            }}
          />
        </div>

        {editing ? (
          <SegmentTextEditor
            initial={seg.text}
            onSave={(text) => {
              setEditing(false);
              if (text !== seg.text) {
                actions.editText(seg.id, text);
                tools.corrected(seg.text, text);
              }
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <SegmentText segment={seg} terms={terms} current={current} actions={actions} tools={tools} />
        )}
      </div>

      {!editing && (
        <div
          className={clsx(
            'surface-pop absolute -top-3 right-3 z-10 flex items-center gap-0.5 rounded-full border border-line p-[3px] transition-opacity',
            confirmDelete || pickerOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100',
          )}
        >
          <IconButton size="sm" icon={Pencil} label="Edit text" onClick={() => setEditing(true)} />
          <IconButton
            size="sm"
            icon={copied ? Check : Copy}
            label={copied ? 'Copied' : 'Copy text'}
            onClick={copy}
            className={clsx(copied && 'text-ok hover:text-ok')}
          />
          <IconButton size="sm" icon={UserRound} label="Change speaker" onClick={() => setPickerOpen(true)} />
          {!isLast && <IconButton size="sm" icon={Merge} label="Merge with next" onClick={() => actions.merge(seg.id)} />}
          {confirmDelete ? (
            <button
              type="button"
              onClick={() => actions.remove(seg.id)}
              className="h-6 rounded-full bg-danger-soft px-2.5 text-xs font-medium text-danger"
            >
              Delete?
            </button>
          ) : (
            <IconButton
              size="sm"
              icon={Trash2}
              label="Delete segment"
              onClick={() => setConfirmDelete(true)}
              className="hover:text-danger"
            />
          )}
        </div>
      )}
    </div>
  );
});

const NO_TERMS: string[] = [];

// ---------- Fix a word in place ----------
// The text stays one plain run (plus find-bar marks), so selecting and copying
// behave as usual. A single handler on the text finds the word under the
// pointer from the caret position; the hover look is a CSS Custom Highlight.

const isWordChar = (ch: string | undefined) => !!ch && /[\p{L}\p{M}\p{N}]/u.test(ch);
const isJoiner = (ch: string | undefined) => ch === "'" || ch === '’' || ch === '-';

// The word around index `i` (apostrophes/hyphens inside a word count), or null.
function wordAt(text: string, i: number): { start: number; end: number } | null {
  if (!isWordChar(text[i])) {
    if (!isWordChar(text[i - 1])) return null;
    i -= 1;
  }
  let start = i;
  while (start > 0 && (isWordChar(text[start - 1]) || (isJoiner(text[start - 1]) && isWordChar(text[start - 2])))) start--;
  let end = i + 1;
  while (end < text.length && (isWordChar(text[end]) || (isJoiner(text[end]) && isWordChar(text[end + 1])))) end++;
  return { start, end };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Case-insensitive whole-word matcher.
function wholeWord(word: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${escapeRegExp(word)}(?![\\p{L}\\p{M}\\p{N}])`, 'giu');
}

function textNodes(root: Node): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  if (typeof document.caretPositionFromPoint === 'function') {
    const p = document.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  const r = document.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, offset: r.startOffset } : null;
}

interface WordHit {
  start: number;
  end: number;
  range: Range;
}

// The word of `root`'s text under a viewport point, if the point is on it.
function hitWord(root: HTMLElement, x: number, y: number): WordHit | null {
  const caret = caretAt(x, y);
  if (!caret || caret.node.nodeType !== Node.TEXT_NODE || !root.contains(caret.node)) return null;
  const nodes = textNodes(root);
  let abs = 0;
  for (const n of nodes) {
    if (n === caret.node) break;
    abs += n.data.length;
  }
  abs += caret.offset;
  const w = wordAt(nodes.map((n) => n.data).join(''), abs);
  if (!w) return null;

  const point = (offset: number): [Text, number] => {
    let rest = offset;
    for (const n of nodes) {
      if (rest <= n.data.length) return [n, rest];
      rest -= n.data.length;
    }
    const lastNode = nodes[nodes.length - 1];
    return [lastNode, lastNode.data.length];
  };
  const range = document.createRange();
  range.setStart(...point(w.start));
  range.setEnd(...point(w.end));
  // caret*FromPoint snaps to the nearest position, even from blank space.
  const on = Array.from(range.getClientRects()).some(
    (r) => x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1,
  );
  return on ? { ...w, range } : null;
}

// One shared highlight: only one word is ever under the pointer. While a fix
// popover is open its word stays lit and hovering elsewhere doesn't move it.
let litRange: Range | null = null;
let fixing = false;
function lightWord(range: Range | null) {
  if (range === litRange) return;
  litRange = range;
  if (typeof Highlight === 'undefined' || !CSS.highlights) return;
  if (range) CSS.highlights.set('mh-word', new Highlight(range));
  else CSS.highlights.delete('mh-word');
}

// Longer than a double-click gap, so double/triple-click selection wins.
const CLICK_DELAY_MS = 250;

function hasSelection(): boolean {
  const sel = window.getSelection();
  return !!sel && !sel.isCollapsed && sel.toString().length > 0;
}

interface WordFix {
  start: number;
  end: number;
  word: string;
  // Where to anchor the popover, relative to the text block.
  left: number;
  top: number;
  // Whole-word matches in the transcript, this one included.
  count: number;
}

function SegmentText({
  segment: seg,
  terms,
  current,
  actions,
  tools,
}: {
  segment: Segment;
  terms: string[];
  current: boolean;
  actions: SegmentActions;
  tools: RowTools;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const hovered = useRef<WordHit | null>(null);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [fix, setFix] = useState<WordFix | null>(null);
  const [fixOpen, setFixOpen] = useState(false);

  useEffect(
    () => () => {
      clearTimeout(clickTimer.current);
      if (hovered.current) {
        fixing = false;
        lightWord(null);
      }
    },
    [],
  );

  const setHover = (hit: WordHit | null) => {
    const prev = hovered.current;
    if (prev && hit && prev.start === hit.start && prev.end === hit.end) return;
    if (!prev && !hit) return;
    hovered.current = hit;
    lightWord(hit?.range ?? null);
  };

  const openFix = (hit: WordHit) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const box = wrap.getBoundingClientRect();
    const rect = hit.range.getClientRects()[0] ?? hit.range.getBoundingClientRect();
    const word = seg.text.slice(hit.start, hit.end);
    const re = wholeWord(word);
    const count = tools.allSegments().reduce((n, s) => n + (s.text.match(re)?.length ?? 0), 0);
    setFix({ start: hit.start, end: hit.end, word, left: rect.left - box.left, top: rect.bottom - box.top, count });
    setFixOpen(true);
    fixing = true;
    hovered.current = hit;
    lightWord(hit.range);
  };

  const closeFix = useCallback(() => {
    setFixOpen(false);
    fixing = false;
    hovered.current = null;
    lightWord(null);
  }, []);

  const apply = (replacement: string, everywhere: boolean) => {
    closeFix();
    const r = replacement.trim();
    if (!fix || !r || r === fix.word || seg.text.slice(fix.start, fix.end) !== fix.word) return;
    let next = seg.text.slice(0, fix.start) + r + seg.text.slice(fix.end);
    if (everywhere) {
      const re = wholeWord(fix.word);
      next = seg.text.replace(re, () => r);
      for (const s of tools.allSegments()) {
        const t = s.id === seg.id ? next : s.text.replace(re, () => r);
        if (t !== s.text) actions.editText(s.id, t);
      }
    } else {
      actions.editText(seg.id, next);
    }
    tools.corrected(seg.text, next);
  };

  return (
    <div ref={wrapRef} className="relative">
      <p className="-mx-1.5 rounded-md px-1.5 py-0.5 text-[15px] leading-7 whitespace-pre-wrap text-text">
        <span
          ref={textRef}
          onMouseMove={(e) => {
            const el = textRef.current;
            if (fixing || !el) return;
            // Leave drag-selecting alone.
            setHover(e.buttons === 0 ? hitWord(el, e.clientX, e.clientY) : null);
          }}
          onMouseLeave={() => {
            if (!fixing) setHover(null);
          }}
          onClick={(e) => {
            clearTimeout(clickTimer.current);
            const el = textRef.current;
            if (!el || e.detail > 1 || hasSelection()) return;
            const hit = hitWord(el, e.clientX, e.clientY);
            if (!hit) return;
            clickTimer.current = setTimeout(() => {
              if (!hasSelection()) openFix(hit);
            }, CLICK_DELAY_MS);
          }}
          onDoubleClick={() => clearTimeout(clickTimer.current)}
        >
          {seg.text ? highlight(seg.text, terms, current) : <span className="text-faint italic select-none">(empty)</span>}
        </span>
        {seg.edited && (
          <span className="ml-2 rounded-full bg-fill px-1.5 py-px align-middle text-[11px] font-medium text-muted select-none" title="Edited by you">
            edited
          </span>
        )}
      </p>
      {fix && (
        <div className="absolute h-0 w-0" style={{ left: fix.left, top: fix.top }}>
          <WordFixPopover open={fixOpen} onClose={closeFix} word={fix.word} count={fix.count} onApply={apply} />
        </div>
      )}
    </div>
  );
}

function WordFixPopover({
  open,
  onClose,
  word,
  count,
  onApply,
}: {
  open: boolean;
  onClose: () => void;
  word: string;
  count: number;
  onApply: (replacement: string, everywhere: boolean) => void;
}) {
  const [value, setValue] = useState(word);
  const [everywhere, setEverywhere] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    setValue(word);
    setEverywhere(false);
    const el = inputRef.current;
    el?.focus();
    el?.select();
  }, [open, word]);

  const submit = () => onApply(value, everywhere && count > 1);

  return (
    <Popover open={open} onClose={onClose} className="top-1 left-0 w-72">
      <div className="flex items-center gap-1 px-1 pt-1 pb-0.5">
        <Input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          aria-label="Replace with"
          className="h-8 text-[13px]"
        />
        <Button size="sm" variant="primary" onClick={submit} disabled={!value.trim()}>
          Fix
        </Button>
      </div>
      {count > 1 && (
        <label className="flex cursor-pointer items-center gap-2 px-2 pt-1.5 pb-1 text-[13px] text-muted select-none">
          <input
            type="checkbox"
            checked={everywhere}
            onChange={(e) => setEverywhere(e.target.checked)}
            className="h-3.5 w-3.5 accent-accent"
          />
          Replace everywhere in this transcript ({count})
        </label>
      )}
    </Popover>
  );
}

function highlight(text: string, terms: string[], current: boolean): ReactNode {
  if (!terms.length) return text;
  return splitHighlights(text, terms).map((p, i) =>
    p.match ? (
      <mark
        key={i}
        className={clsx('rounded-[4px] px-0.5 text-text', current ? 'bg-accent-soft ring-2 ring-accent' : 'bg-highlight')}
      >
        {p.text}
      </mark>
    ) : (
      p.text
    ),
  );
}

function SegmentTextEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);

  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    fit();
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const text = ref.current?.value.trim() ?? initial;
    if (save && text) onSave(text);
    else onCancel();
  };

  return (
    <Textarea
      ref={ref}
      defaultValue={initial}
      rows={1}
      onInput={fit}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          finish(false);
        }
      }}
      className="-mx-1.5 block resize-none overflow-hidden rounded-xl! px-1.5! py-0.5! text-[15px]! leading-7!"
    />
  );
}

function SpeakerPicker({
  open,
  onClose,
  currentId,
  speakers,
  colorOf,
  onPick,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  currentId: number | null;
  speakers: Speaker[];
  colorOf: (speakerId: number | null) => string;
  onPick: (speakerId: number) => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  useEffect(() => {
    if (open) setName('');
  }, [open]);

  const create = () => {
    const n = name.trim();
    if (n) onCreate(n);
  };

  return (
    <Popover open={open} onClose={onClose} className="top-full left-0 mt-1 w-64">
      <MenuLabel>Assign to</MenuLabel>
      <div className="max-h-64 overflow-y-auto">
        {speakers.map((sp) => (
          <MenuItem
            key={sp.id}
            active={sp.id === currentId}
            onClick={() => onPick(sp.id)}
            hint={sp.id === currentId ? <Check size={14} className="text-accent" /> : undefined}
          >
            <span className="flex items-center gap-2">
              <SpeakerAvatar name={speakerName(sp)} color={colorOf(sp.id)} className="h-6! w-6! text-[10px]!" />
              <span className="truncate">{speakerName(sp)}</span>
            </span>
          </MenuItem>
        ))}
      </div>
      <MenuSeparator />
      <div className="flex items-center gap-1 px-1 pt-1 pb-0.5">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') create();
          }}
          placeholder="New speaker…"
          className="h-8 text-[13px]"
        />
        <IconButton icon={Plus} label="Create speaker" onClick={create} disabled={!name.trim()} />
      </div>
    </Popover>
  );
}
