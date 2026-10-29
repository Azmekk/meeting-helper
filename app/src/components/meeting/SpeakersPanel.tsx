import { Plus, UserPlus, Users } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { formatDuration } from '../../lib/format';
import type { Segment, Speaker } from '../../lib/types';
import { Badge, Button, Card, Input } from '../ui';
import { SpeakerDot } from './shared';

export function SpeakersPanel({
  speakers,
  segments,
  colorOf,
  knownNames,
  onRename,
  onAdd,
}: {
  speakers: Speaker[];
  segments: Segment[];
  colorOf: (speakerId: number | null) => string;
  knownNames: string[];
  onRename: (speakerId: number, name: string | null) => void;
  onAdd: (name: string) => Promise<void>;
}) {
  const listId = useId();
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

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

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Users size={15} className="text-muted" />
          Speakers
        </span>
      }
      actions={
        !adding && (
          <Button size="sm" variant="ghost" icon={UserPlus} onClick={() => setAdding(true)}>
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

      <ul className="divide-y divide-line">
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
}: {
  speaker: Speaker;
  color: string;
  talkMs: number;
  share: number;
  count: number;
  listId: string;
  onRename: (name: string | null) => void;
}) {
  const [value, setValue] = useState(speaker.name ?? '');
  useEffect(() => setValue(speaker.name ?? ''), [speaker.name]);

  const commit = () => {
    const next = value.trim() || null;
    if (next !== (speaker.name?.trim() || null)) onRename(next);
  };

  return (
    <li className="px-4 py-3">
      <div className="flex items-center gap-2.5">
        <SpeakerDot color={color} />
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
          className="h-8 border-transparent bg-transparent px-2 font-medium shadow-none hover:border-line"
        />
        {speaker.isSelf && <Badge tone="accent">You</Badge>}
      </div>
      <div className="mt-1.5 flex items-center gap-3 pl-5 text-xs text-muted">
        <span>{formatDuration(talkMs)}</span>
        <span className="text-faint">·</span>
        <span>
          {count} segment{count === 1 ? '' : 's'}
        </span>
        {speaker.name && <span className="truncate text-faint">({speaker.label})</span>}
        <div className="ml-auto h-1 w-16 overflow-hidden rounded-full bg-sunken">
          <div className="h-full rounded-full" style={{ width: `${Math.round(share * 100)}%`, backgroundColor: color }} />
        </div>
      </div>
    </li>
  );
}
