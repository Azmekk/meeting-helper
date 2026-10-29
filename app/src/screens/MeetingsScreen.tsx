import { AudioLines, CircleDot, Library, Pencil, RotateCcw, Trash2, Upload, Video } from 'lucide-react';
import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { DeleteMeetingModal, pickAndImportRecording } from '../components/meeting/actions';
import { StatusBadge, isAudioPath, isJobActive } from '../components/meeting/shared';
import {
  Button,
  Callout,
  Card,
  EmptyState,
  IconButton,
  Input,
  PageHeader,
  Spinner,
  clsx,
  errorMessage,
  toast,
} from '../components/ui';
import * as db from '../lib/db';
import { formatDate, formatDuration } from '../lib/format';
import { onMeetingChanged, transcribeMeeting, useJobs } from '../lib/pipeline';
import type { Meeting } from '../lib/types';

export default function MeetingsScreen() {
  const navigate = useNavigate();
  const [meetings, setMeetings] = useState<Meeting[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<Meeting | null>(null);

  const refresh = useCallback(async () => {
    try {
      setMeetings(await db.listMeetings());
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err));
      setMeetings((m) => m ?? []);
    }
  }, []);

  useEffect(() => {
    refresh();
    return onMeetingChanged(() => refresh());
  }, [refresh]);

  // Job stage changes (e.g. processing → done) should refresh the status too.
  const jobStages = useJobs((s) =>
    Object.values(s.jobs)
      .map((j) => `${j.meetingId}:${j.stage}`)
      .join(','),
  );
  useEffect(() => {
    if (jobStages) refresh();
  }, [jobStages, refresh]);

  const importRecording = async () => {
    setImporting(true);
    try {
      const id = await pickAndImportRecording();
      if (id != null) navigate(`/meetings/${id}`);
    } catch (err) {
      toast(`Import failed: ${errorMessage(err)}`, 'error');
    } finally {
      setImporting(false);
    }
  };

  const rename = async (m: Meeting, title: string) => {
    setRenamingId(null);
    const next = title.trim();
    if (!next || next === m.title) return;
    setMeetings((list) => list?.map((x) => (x.id === m.id ? { ...x, title: next } : x)) ?? null);
    try {
      await db.updateMeeting(m.id, { title: next });
    } catch (err) {
      toast(`Couldn't rename: ${errorMessage(err)}`, 'error');
      refresh();
    }
  };

  const importButton = (
    <Button variant="primary" size="lg" icon={Upload} loading={importing} onClick={importRecording}>
      Import recording
    </Button>
  );

  return (
    <div className="mx-auto max-w-5xl px-8 py-8">
      <PageHeader
        title="Meetings"
        description="Your recordings and their transcripts."
        actions={
          meetings && meetings.length > 0 ? (
            <>
              <Button variant="secondary" size="lg" icon={CircleDot} onClick={() => navigate('/record')}>
                Record
              </Button>
              {importButton}
            </>
          ) : undefined
        }
      />

      {loadError && (
        <Callout tone="error" title="Couldn't load meetings" className="mb-4">
          {loadError}
        </Callout>
      )}

      {meetings === null ? (
        <div className="flex justify-center py-20">
          <Spinner size={20} />
        </div>
      ) : meetings.length === 0 ? (
        <Card>
          <EmptyState
            icon={Library}
            title="No meetings yet"
            description="Import an existing audio or video recording to transcribe it, or record a new meeting with OBS."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                {importButton}
                <Button variant="secondary" size="lg" icon={CircleDot} onClick={() => navigate('/record')}>
                  Start recording
                </Button>
              </div>
            }
          />
        </Card>
      ) : (
        <Card padded={false}>
          <ul className="divide-y divide-line">
            {meetings.map((m) => (
              <MeetingRow
                key={m.id}
                meeting={m}
                renaming={renamingId === m.id}
                onOpen={() => navigate(`/meetings/${m.id}`)}
                onStartRename={() => setRenamingId(m.id)}
                onRename={(t) => rename(m, t)}
                onCancelRename={() => setRenamingId(null)}
                onDelete={() => setDeleting(m)}
              />
            ))}
          </ul>
        </Card>
      )}

      <DeleteMeetingModal
        meeting={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={(id) => {
          setDeleting(null);
          setMeetings((list) => list?.filter((x) => x.id !== id) ?? null);
        }}
      />
    </div>
  );
}

function MeetingRow({
  meeting: m,
  renaming,
  onOpen,
  onStartRename,
  onRename,
  onCancelRename,
  onDelete,
}: {
  meeting: Meeting;
  renaming: boolean;
  onOpen: () => void;
  onStartRename: () => void;
  onRename: (title: string) => void;
  onCancelRename: () => void;
  onDelete: () => void;
}) {
  const job = useJobs((s) => s.jobs[m.id]);
  const active = isJobActive(job);
  const audio = isAudioPath(m.mediaPath ?? m.sourcePath);
  const [retrying, setRetrying] = useState(false);

  const retry = async () => {
    setRetrying(true);
    try {
      await transcribeMeeting(m.id);
    } finally {
      setRetrying(false);
    }
  };

  const onTitleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') onRename(e.currentTarget.value);
    if (e.key === 'Escape') {
      e.stopPropagation();
      onCancelRename();
    }
  };

  return (
    <li
      className={clsx('group flex items-center gap-4 px-5 py-4 transition-colors', !renaming && 'cursor-pointer hover:bg-hover/50')}
      onClick={renaming ? undefined : onOpen}
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-sunken text-muted">
        {audio ? <AudioLines size={18} /> : <Video size={18} />}
      </div>

      <div className="min-w-0 flex-1">
        {renaming ? (
          <Input
            autoFocus
            defaultValue={m.title}
            onClick={(e) => e.stopPropagation()}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={onTitleKey}
            onBlur={(e) => onRename(e.currentTarget.value)}
            className="h-8 max-w-md"
          />
        ) : (
          <div className="truncate text-[15px] font-medium">{m.title || 'Untitled meeting'}</div>
        )}
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[13px] text-muted">
          <span>{formatDate(m.createdAt)}</span>
          <span className="text-faint">·</span>
          <span>{formatDuration(m.durationMs)}</span>
          {active && (
            <>
              <span className="text-faint">·</span>
              <span className="truncate text-accent">{job.message}</span>
            </>
          )}
        </div>
        {m.status === 'error' && !active && m.error && (
          <div className="mt-1 line-clamp-2 text-[13px] text-danger">{m.error}</div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2" onClick={(e) => e.stopPropagation()}>
        {m.status === 'error' && !active && (
          <Button size="sm" variant="secondary" icon={RotateCcw} loading={retrying} onClick={retry}>
            Retry
          </Button>
        )}
        <StatusBadge status={m.status} job={job} />
        <div className="flex items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <IconButton icon={Pencil} label="Rename" onClick={onStartRename} />
          <IconButton icon={Trash2} label="Delete" onClick={onDelete} className="hover:text-danger" />
        </div>
      </div>
    </li>
  );
}
