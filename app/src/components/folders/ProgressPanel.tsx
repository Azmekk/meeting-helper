// Folder action items: tracked across meetings, updated by the reconcile step
// after each meeting, editable by hand. Shown on the folder screen and, with
// `meetingId`, on the meeting screen, where it can follow just that meeting.
// Completed items stay in the list until deleted by hand.
import { AiLanguageSelect } from '../ai/AiLanguageSelect';
import { AiModelSelect, useAiModel } from '../ai/AiModelSelect';
import { Check, ChevronDown, Circle, MessageSquare, Pencil, Plus, RefreshCw, Trash2, Undo2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Callout, Card, Collapse, IconButton, Input, Segmented, Select, Spinner, clsx, errorMessage, toast } from '../ui';
import { useAiKey } from '../meeting/AiPanels';
import * as db from '../../lib/db';
import { reconcileActionItems, runInFolderQueue, useFolderAi } from '../../lib/ai/folder';
import { formatDate, formatTimestamp, formatUsd } from '../../lib/format';
import type { ActionItem, ActionItemStatus, Folder, Meeting } from '../../lib/types';

const STATUS_LABEL: Record<ActionItemStatus, string> = { suggested: 'Suggested', open: 'Open', done: 'Completed', dropped: 'Dropped' };

// Parents with their subtasks right below them. A subtask whose parent isn't
// shown stays in the list as a top-level row.
function inTreeOrder(items: ActionItem[]): { item: ActionItem; depth: number }[] {
  const ids = new Set(items.map((i) => i.id));
  const children = new Map<number, ActionItem[]>();
  for (const i of items) {
    if (i.parentId != null && ids.has(i.parentId)) children.set(i.parentId, [...(children.get(i.parentId) ?? []), i]);
  }
  const out: { item: ActionItem; depth: number }[] = [];
  const walk = (item: ActionItem, depth: number) => {
    out.push({ item, depth });
    for (const c of children.get(item.id) ?? []) walk(c, depth + 1);
  };
  for (const i of items) if (i.parentId == null || !ids.has(i.parentId)) walk(i, 0);
  return out;
}

export function ProgressPanel({
  folder,
  meetings,
  meetingId,
  onSeek,
  onAsk,
}: {
  folder: Folder;
  meetings: Meeting[];
  meetingId?: number;
  onSeek?: (ms: number) => void; // moves the player when an item's source is this meeting
  onAsk?: (item: ActionItem) => void;
}) {
  const compact = meetingId != null;
  const hasKey = useAiKey();
  const [model, setModel] = useAiModel('background', 'progress');
  const autoBusy = useFolderAi((s) => s.busy[folder.id]);
  const changes = useFolderAi((s) => s.tasks[folder.id] ?? 0);
  const [items, setItems] = useState<ActionItem[] | null>(null);
  const [filter, setFilter] = useState<'open' | 'all'>('all');
  const [scope, setScope] = useState<'meeting' | 'folder'>('meeting');
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [running, setRunning] = useState(false);
  const [showSuggested, setShowSuggested] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    db.listActionItems(folder.id)
      .then(setItems)
      .catch((err) => {
        setItems([]);
        setError(errorMessage(err));
      });
  }, [folder.id]);

  useEffect(() => {
    setItems(null);
    load();
  }, [load]);

  // Tasks can also change from chat, or from outside the app through MCP.
  useEffect(() => {
    if (changes) load();
  }, [changes, load]);
  useEffect(() => {
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, [load]);

  const wasBusy = useRef(autoBusy);
  useEffect(() => {
    if (wasBusy.current && !autoBusy) load();
    wasBusy.current = autoBusy;
  }, [autoBusy, load]);

  const byId = useMemo(() => new Map(meetings.map((m) => [m.id, m])), [meetings]);
  // This meeting on its screen, otherwise the newest meeting with a transcript.
  const target = useMemo(
    () => (compact ? (byId.get(meetingId) ?? null) : ([...meetings].reverse().find((m) => m.activeTranscriptId != null) ?? null)),
    [compact, byId, meetingId, meetings],
  );

  const update = async () => {
    if (!target) return;
    setRunning(true);
    setError(null);
    try {
      const r = await runInFolderQueue(folder.id, () => reconcileActionItems(folder.id, target.id, { model }));
      toast(`Action items updated: ${r.updated} changed, ${r.added} new, ${r.suggested} suggested (${formatUsd(r.costUsd)})`, 'success');
      load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRunning(false);
    }
  };

  const save = async (item: ActionItem | null, patch: { text: string; owner: string | null; meetingId: number | null }) => {
    try {
      if (item) await db.updateActionItem(item.id, patch);
      else
        await db.addActionItem({
          folderId: folder.id,
          meetingId: patch.meetingId,
          text: patch.text,
          owner: patch.owner,
          status: 'open',
          firstSeenMeeting: null, // manual: not replaced when the AI re-runs a meeting
          lastUpdateMeeting: null,
          sourceMs: null,
        });
      setEditing(null);
      load();
    } catch (err) {
      toast(`Couldn't save: ${errorMessage(err)}`, 'error');
    }
  };

  const setStatus = async (item: ActionItem, status: ActionItemStatus) => {
    setItems((list) => list?.map((x) => (x.id === item.id ? { ...x, status } : x)) ?? null);
    try {
      await db.updateActionItem(item.id, { status });
    } catch (err) {
      toast(`Couldn't update: ${errorMessage(err)}`, 'error');
      load();
    }
  };

  // Accepted items are the user's now: not replaced when the AI re-runs a meeting.
  const accept = async (item: ActionItem) => {
    try {
      await db.updateActionItem(item.id, { status: 'open', firstSeenMeeting: null });
      load();
    } catch (err) {
      toast(`Couldn't update: ${errorMessage(err)}`, 'error');
    }
  };

  const remove = async (item: ActionItem) => {
    try {
      await db.deleteActionItem(item.id);
      load();
    } catch (err) {
      toast(`Couldn't delete: ${errorMessage(err)}`, 'error');
    }
  };

  if (items === null) {
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    );
  }
  const fromHere = (i: ActionItem) => !compact || scope === 'folder' || i.meetingId === meetingId || i.firstSeenMeeting === meetingId || i.lastUpdateMeeting === meetingId;
  const inScope = items.filter(fromHere);
  // A subtask from this meeting brings its parent along, and the other way round.
  const shownIds = new Set(inScope.map((i) => i.id));
  const related = items.filter((i) => shownIds.has(i.id) || (i.parentId != null && shownIds.has(i.parentId)) || inScope.some((c) => c.parentId === i.id));
  const tracked = related.filter((i) => i.status !== 'suggested');
  const suggested = related.filter((i) => i.status === 'suggested');
  const shown = inTreeOrder(filter === 'open' ? tracked.filter((i) => i.status === 'open') : tracked);
  const openCount = tracked.filter((i) => i.status === 'open').length;

  return (
    <Card
      title="Progress"
      description={
        autoBusy ?? (compact ? undefined : 'Action items across the folder. Each new meeting marks items done or dropped and adds clear commitments; anything less certain waits under Suggested.')
      }
      actions={
        <>
          {!compact && <AiLanguageSelect className="h-7" />}
          <AiModelSelect value={model} onChange={setModel} disabled={running} className="h-7" />
          <Select value={filter} onChange={(e) => setFilter(e.target.value as 'open' | 'all')} aria-label="Which tasks to show" className="h-7 w-auto text-[13px]">
            <option value="all">All ({tracked.length})</option>
            <option value="open">Open ({openCount})</option>
          </Select>
          <Button
            size="sm"
            icon={RefreshCw}
            loading={running}
            disabled={!hasKey || !target || !!autoBusy}
            title={target ? `Reconcile with "${target.title}"` : 'No meeting with a transcript yet'}
            onClick={update}
          >
            {compact ? 'Update from this meeting' : 'Update from latest meeting'}
          </Button>
        </>
      }
      padded={false}
    >
      {compact && (
        <div className="border-b border-line px-5 py-2">
          <Segmented
            size="sm"
            label="Which meetings"
            value={scope}
            onChange={setScope}
            options={[
              { value: 'meeting', label: 'This meeting' },
              { value: 'folder', label: 'Whole folder' },
            ]}
          />
        </div>
      )}
      {error && (
        <Callout tone="error" className="mx-5 mt-4">
          <p className="break-words">{error}</p>
        </Callout>
      )}
      <ul className="divide-y divide-line">
        {shown.map(({ item, depth }) =>
          editing === item.id ? (
            <ItemEditor key={item.id} item={item} meetings={meetings} onSave={(p) => save(item, p)} onCancel={() => setEditing(null)} />
          ) : (
            <li key={item.id} className="group flex items-start gap-3 py-3 pr-5" style={{ paddingLeft: `${20 + depth * 24}px` }}>
              <button
                type="button"
                onClick={() => setStatus(item, item.status === 'open' ? 'done' : 'open')}
                title={item.status === 'open' ? 'Mark completed' : 'Reopen'}
                className={clsx(
                  'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors',
                  item.status === 'done' ? 'border-ok bg-ok text-white' : 'border-line text-transparent hover:border-ok hover:text-ok',
                )}
              >
                {item.status === 'dropped' ? <X size={12} className="text-faint" /> : <Check size={12} />}
              </button>
              <div className="min-w-0 flex-1">
                <div className={clsx('text-sm', item.status !== 'open' && 'text-muted line-through')}>
                  {item.owner && <span className="mr-1.5 font-semibold text-text">{item.owner}:</span>}
                  {item.text}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-faint">
                  <TaskId id={item.id} />
                  {item.status !== 'open' && <Badge tone={item.status === 'done' ? 'ok' : 'neutral'}>{STATUS_LABEL[item.status]}</Badge>}
                  <MeetingLink meeting={item.meetingId != null ? byId.get(item.meetingId) : undefined} ms={item.sourceMs} prefix="From" here={meetingId} onSeek={onSeek} />
                  {item.lastUpdateMeeting != null && item.lastUpdateMeeting !== item.meetingId && (
                    <MeetingLink meeting={byId.get(item.lastUpdateMeeting)} ms={null} prefix="Updated in" here={meetingId} onSeek={onSeek} />
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                {onAsk && <IconButton size="sm" icon={MessageSquare} label="Ask about this" onClick={() => onAsk(item)} />}
                {item.status === 'open' ? (
                  <IconButton size="sm" icon={Circle} label="Mark dropped" onClick={() => setStatus(item, 'dropped')} />
                ) : (
                  <IconButton size="sm" icon={Undo2} label="Reopen" onClick={() => setStatus(item, 'open')} />
                )}
                <IconButton size="sm" icon={Pencil} label="Edit" onClick={() => setEditing(item.id)} />
                <IconButton size="sm" icon={Trash2} label="Delete" onClick={() => remove(item)} className="hover:text-danger" />
              </div>
            </li>
          ),
        )}
        {editing === 'new' && <ItemEditor item={null} meetings={meetings} defaultMeeting={meetingId} onSave={(p) => save(null, p)} onCancel={() => setEditing(null)} />}
      </ul>
      {!shown.length && editing !== 'new' && (
        <p className="px-5 py-6 text-center text-[13px] text-muted">
          {related.length ? 'Nothing open. Nice.' : compact && scope === 'meeting' ? 'No tasks from this meeting yet.' : 'No action items yet. They appear after a meeting in this folder gets its summary, or add one by hand.'}
        </p>
      )}
      {suggested.length > 0 && (
        <div className="border-t border-line">
          <button
            type="button"
            aria-expanded={showSuggested}
            onClick={() => setShowSuggested((v) => !v)}
            className="flex w-full items-center gap-2 px-5 py-2.5 text-left text-[13px] font-medium text-muted transition-colors hover:text-text"
          >
            <ChevronDown size={14} className={clsx('shrink-0 transition-transform', !showSuggested && '-rotate-90')} />
            Suggested ({suggested.length})
            <span className="min-w-0 truncate font-normal text-faint">Not firm commitments. Accept the ones you want to track.</span>
          </button>
          <Collapse open={showSuggested}>
            <ul className="divide-y divide-line border-t border-line">
              {suggested.map((item) => (
                <li key={item.id} className="flex items-start gap-3 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm">
                      {item.owner && <span className="mr-1.5 font-semibold">{item.owner}:</span>}
                      {item.text}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-faint">
                      <TaskId id={item.id} />
                      <MeetingLink meeting={item.meetingId != null ? byId.get(item.meetingId) : undefined} ms={item.sourceMs} prefix="From" here={meetingId} onSeek={onSeek} />
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center">
                    <IconButton size="sm" icon={Check} label="Accept" onClick={() => accept(item)} className="hover:text-ok" />
                    <IconButton size="sm" icon={X} label="Dismiss" onClick={() => remove(item)} />
                  </div>
                </li>
              ))}
            </ul>
          </Collapse>
        </div>
      )}
      <div className="border-t border-line px-5 py-2.5">
        <Button size="sm" variant="ghost" icon={Plus} onClick={() => setEditing('new')} disabled={editing === 'new'}>
          Add item
        </Button>
      </div>
    </Card>
  );
}

// The number AI agents use when they mention a task.
function TaskId({ id }: { id: number }) {
  return <span className="shrink-0 tabular-nums">#{id}</span>;
}

function MeetingLink({
  meeting,
  ms,
  prefix,
  here,
  onSeek,
}: {
  meeting: Meeting | undefined;
  ms: number | null;
  prefix: string;
  here?: number;
  onSeek?: (ms: number) => void;
}) {
  if (!meeting) return null;
  // Already on this meeting: move the player instead of opening the page again.
  if (meeting.id === here) {
    const label = `${prefix} this meeting${ms != null ? ` · ${formatTimestamp(ms)}` : ''}`;
    if (ms == null || !onSeek) return <span className="truncate">{label}</span>;
    return (
      <button type="button" onClick={() => onSeek(ms)} className="truncate hover:text-accent hover:underline">
        {label}
      </button>
    );
  }
  const to = ms != null ? `/meetings/${meeting.id}?t=${ms}` : `/meetings/${meeting.id}`;
  return (
    <Link to={to} className="truncate hover:text-accent hover:underline">
      {prefix} {meeting.title} · {formatDate(meeting.createdAt)}
      {ms != null && ` · ${formatTimestamp(ms)}`}
    </Link>
  );
}

function ItemEditor({
  item,
  meetings,
  defaultMeeting,
  onSave,
  onCancel,
}: {
  item: ActionItem | null;
  meetings: Meeting[];
  defaultMeeting?: number;
  onSave: (p: { text: string; owner: string | null; meetingId: number | null }) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(item?.text ?? '');
  const [owner, setOwner] = useState(item?.owner ?? '');
  const [meetingId, setMeetingId] = useState<number | null>(item ? item.meetingId : (defaultMeeting ?? null));
  const submit = () => text.trim() && onSave({ text: text.trim(), owner: owner.trim() || null, meetingId });
  return (
    <li className="flex flex-wrap items-center gap-2 bg-sunken/40 px-5 py-3">
      <Input
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') onCancel();
        }}
        placeholder="What needs doing"
        className="h-8 min-w-48 flex-1"
      />
      <Input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Owner" className="h-8 w-32" />
      <Select value={meetingId ?? ''} onChange={(e) => setMeetingId(e.target.value ? Number(e.target.value) : null)} className="h-8 w-48 text-[13px]">
        <option value="">No meeting</option>
        {meetings.map((m) => (
          <option key={m.id} value={m.id}>
            {m.title}
          </option>
        ))}
      </Select>
      <Button size="sm" variant="primary" onClick={submit} disabled={!text.trim()}>
        Save
      </Button>
      <Button size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </li>
  );
}
