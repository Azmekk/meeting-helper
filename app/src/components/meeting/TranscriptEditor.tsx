import { Check, Merge, Plus, Trash2, UserRound } from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { formatTimestamp } from '../../lib/format';
import { splitHighlights } from '../../lib/search';
import { speakerName, type Segment, type Speaker } from '../../lib/types';
import { IconButton, Input, Textarea, clsx } from '../ui';
import { MenuItem, MenuLabel, MenuSeparator, Popover, SpeakerDot, speakerChipStyle } from './shared';

export interface SegmentActions {
  seek: (ms: number, play: boolean) => void;
  editText: (segmentId: number, text: string) => void;
  reassign: (segmentId: number, speakerId: number | null) => void;
  createSpeakerAndAssign: (segmentId: number, name: string) => Promise<void>;
  merge: (segmentId: number) => void;
  remove: (segmentId: number) => void;
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
}) {
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

  if (filtering && visible.length === 0) {
    return <p className="px-3 py-10 text-center text-sm text-muted">No lines match your search.</p>;
  }

  return (
    <div onWheel={onUserScroll} onTouchMove={onUserScroll} className="pb-[30vh]">
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
        />
      ))}
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
}) {
  const [editing, setEditing] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!confirmDelete) return;
    const t = setTimeout(() => setConfirmDelete(false), 3000);
    return () => clearTimeout(t);
  }, [confirmDelete]);

  const name = speaker ? speakerName(speaker) : 'Unknown speaker';

  return (
    <div
      data-seg={seg.id}
      className={clsx(
        'group relative grid grid-cols-[4.25rem_minmax(0,1fr)] gap-x-3 rounded-xl px-3 py-2 transition-colors duration-300',
        showSpeaker && 'mt-4',
        active ? 'bg-highlight/70' : 'hover:bg-panel',
        flash && 'ring-2 ring-accent',
      )}
    >
      <div className={clsx(showSpeaker && 'pt-[30px]')}>
        <button
          type="button"
          onClick={() => actions.seek(seg.startMs, true)}
          title="Play from here"
          className={clsx(
            'rounded px-1 py-0.5 font-mono text-xs tabular-nums transition-colors hover:bg-accent-soft hover:text-accent',
            active ? 'text-accent' : 'text-faint',
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
              className="mb-1 inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[13px] font-semibold transition-opacity hover:opacity-80"
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
              if (text !== seg.text) actions.editText(seg.id, text);
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <p
            onClick={() => setEditing(true)}
            title="Click to edit"
            className="-mx-1.5 cursor-text rounded-md px-1.5 py-0.5 text-[15px] leading-7 whitespace-pre-wrap text-text"
          >
            {seg.text ? highlight(seg.text, terms, current) : <span className="text-faint italic">(empty)</span>}
            {seg.edited && (
              <span className="ml-2 align-middle text-[11px] font-medium text-faint select-none" title="Edited by you">
                edited
              </span>
            )}
          </p>
        )}
      </div>

      {!editing && (
        <div
          className={clsx(
            'absolute -top-3 right-3 z-10 flex items-center gap-0.5 rounded-lg border border-line bg-panel p-0.5 shadow-sm transition-opacity',
            confirmDelete || pickerOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100',
          )}
        >
          <IconButton size="sm" icon={UserRound} label="Change speaker" onClick={() => setPickerOpen(true)} />
          {!isLast && <IconButton size="sm" icon={Merge} label="Merge with next" onClick={() => actions.merge(seg.id)} />}
          {confirmDelete ? (
            <button
              type="button"
              onClick={() => actions.remove(seg.id)}
              className="h-6 rounded-md bg-danger-soft px-2 text-xs font-medium text-danger"
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

function highlight(text: string, terms: string[], current: boolean): ReactNode {
  if (!terms.length) return text;
  return splitHighlights(text, terms).map((p, i) =>
    p.match ? (
      <mark
        key={i}
        className={clsx('rounded-sm px-0.5 text-text', current ? 'bg-accent-soft ring-2 ring-accent' : 'bg-highlight')}
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
      className="-mx-1.5 block resize-none overflow-hidden px-1.5! py-0.5! text-[15px]! leading-7!"
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
              <SpeakerDot color={colorOf(sp.id)} />
              <span className="truncate">{speakerName(sp)}</span>
            </span>
          </MenuItem>
        ))}
      </div>
      <MenuSeparator />
      <div className="flex items-center gap-1 p-1">
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
