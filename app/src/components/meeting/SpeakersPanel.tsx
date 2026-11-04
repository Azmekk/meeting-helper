import { Plus, Trash2, UserPlus } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { formatDuration } from '../../lib/format';
import { speakerName, type Segment, type Speaker } from '../../lib/types';
import { Badge, Button, Card, IconButton, Input, Modal, Select } from '../ui';
import { SpeakerAvatar } from './shared';

// The Select's value for leaving the lines with no speaker.
const NO_SPEAKER = '';

export function SpeakersPanel({
  speakers,
  segments,
  colorOf,
  knownNames,
  onRename,
  onAdd,
  onDelete,
}: {
  speakers: Speaker[];
  segments: Segment[];
  colorOf: (speakerId: number | null) => string;
  knownNames: string[];
  onRename: (speakerId: number, name: string | null) => void;
  onAdd: (name: string) => Promise<void>;
  onDelete: (speakerId: number, reassignTo: number | null) => void;
}) {
  const listId = useId();
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<Speaker | null>(null);
  const [assignTo, setAssignTo] = useState(NO_SPEAKER);

  const stats = useMemo(() => {
    const m = new Map<number, { ms: number; count: number }>();
    for (const s of segments) {
      if (s.speakerId == null) continue;
      const st = m.get(s.speakerId) ?? { ms: 0, count: 0 };
      st.ms += Math.max(0, s.endMs - s.startMs);
      st.count += 1;
      m.set(s.speakerId, st);
    }
    return m;
  }, [segments]);

  const totalMs = useMemo(() => [...stats.values()].reduce((a, b) => a + b.ms, 0), [stats]);

  const submitNew = async () => {
    const name = newName.trim();
    if (!name) {
      setAdding(false);
      return;
    }
    setBusy(true);
    try {
      await onAdd(name);
      setNewName('');
      setAdding(false);
    } finally {
      setBusy(false);
    }
  };

  // Nothing to lose without lines, so only a speaker who has some asks first.
  const startDelete = (sp: Speaker) => {
    if (!stats.get(sp.id)?.count) {
      onDelete(sp.id, null);
      return;
    }
    const next = speakers.find((o) => o.id !== sp.id);
    setAssignTo(next ? String(next.id) : NO_SPEAKER);
    setDeleting(sp);
  };

  const confirmDelete = () => {
    if (!deleting) return;
    onDelete(deleting.id, assignTo === NO_SPEAKER ? null : Number(assignTo));
    setDeleting(null);
  };

  const deletingCount = deleting ? (stats.get(deleting.id)?.count ?? 0) : 0;

  return (
    <Card
      title="Speakers"
      actions={
        !adding && (
          <Button size="sm" variant="secondary" icon={UserPlus} onClick={() => setAdding(true)}>
            Add
          </Button>
        )
      }
      padded={false}
    >
      <datalist id={listId}>
        {knownNames.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>

      {speakers.length === 0 && !adding && (
        <p className="px-5 py-4 text-[13px] text-muted">No speakers in this transcript.</p>
      )}

      <ul className="space-y-0.5 px-2 pt-1 pb-2">
        {speakers.map((sp) => {
          const st = stats.get(sp.id);
          return (
            <SpeakerRow
              key={sp.id}
              speaker={sp}
              color={colorOf(sp.id)}
              talkMs={st?.ms ?? 0}
              share={totalMs ? (st?.ms ?? 0) / totalMs : 0}
              count={st?.count ?? 0}
              listId={listId}
              onRename={(name) => onRename(sp.id, name)}
              onDelete={() => startDelete(sp)}
            />
          );
        })}
      </ul>

      {adding && (
        <div className="flex gap-2 border-t border-line px-4 py-3">
          <Input
            autoFocus
            list={listId}
            placeholder="Name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitNew();
              if (e.key === 'Escape') {
                setNewName('');
                setAdding(false);
              }
            }}
            className="h-8"
          />
          <Button size="sm" variant="primary" icon={Plus} loading={busy} onClick={submitNew} className="h-8">
            Add
          </Button>
        </div>
      )}

      <Modal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={`Delete ${deleting ? speakerName(deleting) : 'speaker'}?`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="danger" icon={Trash2} onClick={confirmDelete}>
              Delete
            </Button>
          </>
        }
      >
        <div className="text-sm text-muted">
          <p className="mb-2">
            They have {deletingCount} segment{deletingCount === 1 ? '' : 's'} in this transcript. Who should {deletingCount === 1 ? 'it' : 'they'} be assigned to?
          </p>
          <Select value={assignTo} onChange={(e) => setAssignTo(e.target.value)} aria-label="Assign the segments to">
            {speakers
              .filter((o) => o.id !== deleting?.id)
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {speakerName(o)}
                </option>
              ))}
            <option value={NO_SPEAKER}>Unknown speaker</option>
          </Select>
        </div>
      </Modal>
    </Card>
  );
}

function SpeakerRow({
  speaker,
  color,
  talkMs,
  share,
  count,
  listId,
  onRename,
  onDelete,
}: {
  speaker: Speaker;
  color: string;
  talkMs: number;
  share: number;
  count: number;
  listId: string;
  onRename: (name: string | null) => void;
  onDelete: () => void;
}) {
  const [value, setValue] = useState(speaker.name ?? '');
  useEffect(() => setValue(speaker.name ?? ''), [speaker.name]);

  const commit = () => {
    const next = value.trim() || null;
    if (next !== (speaker.name?.trim() || null)) onRename(next);
  };

  return (
    <li className="group rounded-2xl px-3 py-2 transition-colors hover:bg-hover/50">
      <div className="flex items-center gap-2.5">
        <SpeakerAvatar name={speaker.name || speaker.label} color={color} />
        <Input
          list={listId}
          value={value}
          placeholder={speaker.label}
          aria-label={`Name for ${speaker.label}`}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              setValue(speaker.name ?? '');
              e.currentTarget.blur();
            }
          }}
          className="h-8 bg-transparent px-2.5 text-[14px] font-medium shadow-none"
        />
        {speaker.isSelf && <Badge tone="accent">You</Badge>}
        <IconButton
          size="sm"
          icon={Trash2}
          label={`Delete ${speakerName(speaker)}`}
          onClick={onDelete}
          className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        />
      </div>
      <div className="mt-0.5 flex items-center gap-2 pl-[38px] text-xs text-muted">
        <span>{formatDuration(talkMs)}</span>
        <span aria-hidden>·</span>
        <span>
          {count} segment{count === 1 ? '' : 's'}
        </span>
        {speaker.name && <span className="truncate">({speaker.label})</span>}
        <div className="ml-auto h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-fill">
          <div className="h-full rounded-full" style={{ width: `${Math.round(share * 100)}%`, backgroundColor: color }} />
        </div>
      </div>
    </li>
  );
}
