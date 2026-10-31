import { AudioLines, CircleDot, FileArchive, Folder as FolderIcon, FolderInput, Inbox, Library, Pencil, RotateCcw, Sparkles, Trash2, Upload, Video } from 'lucide-react';
import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { DeleteMeetingModal, pickAndImportRecording } from '../components/meeting/actions';
import { ImportMeetingModal, pickMeetingZip, startMeetingZipImport } from '../components/meeting/ShareMeeting';
import { MenuItem, MenuLabel, MenuSeparator, Popover, StatusBadge, isAudioPath, isJobActive } from '../components/meeting/shared';
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
import type { SingleMeetingZip } from '../lib/backup';
import { moveMeetingToFolder, refreshFolders, useFolders } from '../lib/folders';
import { onMeetingChanged, transcribeMeeting, useJobs } from '../lib/pipeline';
import type { Folder, Meeting } from '../lib/types';

// 'all', 'unsorted' (no folder) or a folder id.
type FolderFilter = 'all' | 'unsorted' | number;

export default function MeetingsScreen() {
  const navigate = useNavigate();
  const [meetings, setMeetings] = useState<Meeting[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<Meeting | null>(null);
  const folders = useFolders((s) => s.folders);
  const [filter, setFilter] = useState<FolderFilter>('all');
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [zipImporting, setZipImporting] = useState(false);
  const [pendingZip, setPendingZip] = useState<SingleMeetingZip | null>(null);

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
    refreshFolders().catch(() => {});
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
      const id = await pickAndImportRecording(typeof filter === 'number' ? filter : null, (p) =>
        setImportStatus(p.total > 1 ? `Copying… ${Math.round((p.done / p.total) * 100)}%` : null),
      );
      if (id != null) navigate(`/meetings/${id}`);
    } catch (err) {
      toast(`Import failed: ${errorMessage(err)}`, 'error');
    } finally {
      setImporting(false);
      setImportStatus(null);
    }
  };

  // A meeting file from someone (or any Meeting Helper zip).
  const importMeetingFile = async () => {
    const path = await pickMeetingZip();
    if (!path) return;
    setZipImporting(true);
    try {
      const res = await startMeetingZipImport(path, setPendingZip);
      if (res) refresh();
    } catch (err) {
      toast(`Import failed: ${errorMessage(err)}`, 'error');
    } finally {
      setZipImporting(false);
    }
  };

  const moveTo = async (m: Meeting, folderId: number | null) => {
    try {
      await moveMeetingToFolder(m.id, folderId);
      refresh();
    } catch (err) {
      toast(`Couldn't move the meeting: ${errorMessage(err)}`, 'error');
      refresh();
    }
  };

  const folderById = new Map(folders.map((f) => [f.id, f]));
  const shown =
    meetings?.filter((m) => (filter === 'all' ? true : filter === 'unsorted' ? m.folderId == null : m.folderId === filter)) ?? null;

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
      {importStatus ?? 'Import recording'}
    </Button>
  );
  const importFileButton = (
    <Button variant="secondary" size="lg" icon={FileArchive} loading={zipImporting} onClick={importMeetingFile}>
      Import meeting file…
    </Button>
  );

  return (
    <div className="mx-auto max-w-7xl px-8 py-8">
      <PageHeader
        title="Meetings"
        description="Your recordings and their transcripts."
        actions={
          meetings && meetings.length > 0 ? (
            <>
              <Button variant="secondary" size="lg" icon={CircleDot} onClick={() => navigate('/record')}>
                Record
              </Button>
              {importFileButton}
              {importButton}
            </>
          ) : undefined
        }
      />

      {meetings && meetings.length > 0 && folders.length > 0 && (
        <div role="group" aria-label="Folder" className="-mx-1 mb-4 flex gap-2 overflow-x-auto px-1 pb-1">
          {([
            { value: 'all', label: 'All', icon: undefined },
            { value: 'unsorted', label: 'Unsorted', icon: Inbox },
            ...folders.map((f) => ({ value: f.id, label: f.name, icon: FolderIcon })),
          ] as { value: FolderFilter; label: string; icon?: typeof Inbox }[]).map((o) => {
            const selected = filter === o.value;
            const Icon = o.icon;
            return (
              <button
                key={String(o.value)}
                type="button"
                aria-pressed={selected}
                onClick={() => setFilter(o.value)}
                className={clsx(
                  'inline-flex h-8 max-w-56 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium whitespace-nowrap transition-colors',
                  selected ? 'bg-accent text-on-accent' : 'bg-fill text-text hover:bg-fill-strong',
                )}
              >
                {Icon && <Icon size={13} className={clsx('shrink-0', !selected && 'text-muted')} />}
                <span className="truncate">{o.label}</span>
              </button>
            );
          })}
        </div>
      )}

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
                {importFileButton}
              </div>
            }
          />
        </Card>
      ) : (
        <Card padded={false}>
          {shown && !shown.length && <p className="px-5 py-8 text-center text-sm text-muted">No meetings in this folder.</p>}
          <ul className="space-y-0.5 p-2">
            {(shown ?? []).map((m) => (
              <MeetingRow
                key={m.id}
                meeting={m}
                folder={m.folderId != null ? (folderById.get(m.folderId) ?? null) : null}
                folders={folders}
                onMove={(folderId) => moveTo(m, folderId)}
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

      <ImportMeetingModal
        pending={pendingZip}
        onClose={() => setPendingZip(null)}
        onImported={(id) => {
          setPendingZip(null);
          if (id != null) navigate(`/meetings/${id}`);
          else refresh();
        }}
      />

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
  folder,
  folders,
  onMove,
  renaming,
  onOpen,
  onStartRename,
  onRename,
  onCancelRename,
  onDelete,
}: {
  meeting: Meeting;
  folder: Folder | null;
  folders: Folder[];
  onMove: (folderId: number | null) => void;
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
  const [moveOpen, setMoveOpen] = useState(false);

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
      className={clsx('group flex items-center gap-3.5 rounded-2xl px-3 py-3 transition-colors', !renaming && 'cursor-pointer hover:bg-hover')}
      onClick={renaming ? undefined : onOpen}
    >
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px] bg-accent-soft text-accent-ink">
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
            className="h-8 max-w-md text-[15px]"
          />
        ) : (
          <div className="truncate text-[15px] font-semibold">{m.title || 'Untitled meeting'}</div>
        )}
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[13px] text-muted">
          <span>{formatDate(m.createdAt)}</span>
          <span aria-hidden>·</span>
          <span>{formatDuration(m.durationMs)}</span>
          {folder && (
            <>
              <span aria-hidden>·</span>
              <span className="inline-flex min-w-0 items-center gap-1">
                <FolderIcon size={12} className="shrink-0" />
                <span className="truncate">{folder.name}</span>
              </span>
            </>
          )}
          {active && (
            <>
              <span aria-hidden>·</span>
              <span className="truncate text-accent-ink">{job.message}</span>
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
        {/* Left untranscribed ("Not now" after recording, or autoTranscribe off). */}
        {m.status === 'queued' && !active && !!m.mediaPath && (
          <Button size="sm" variant="secondary" icon={Sparkles} loading={retrying} onClick={retry}>
            Transcribe
          </Button>
        )}
        <StatusBadge status={m.status} job={job} />
        <div className="flex items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <IconButton icon={Pencil} label="Rename" onClick={onStartRename} />
          {(folders.length > 0 || folder) && (
            <div className="relative">
              <IconButton icon={FolderInput} label="Move to folder" onClick={() => setMoveOpen((v) => !v)} disabled={m.status === 'recording'} />
              <Popover open={moveOpen} onClose={() => setMoveOpen(false)} className="top-full right-0 mt-1.5 w-56">
                <MenuLabel>Move to</MenuLabel>
                <MenuItem
                  icon={Inbox}
                  active={!folder}
                  onClick={() => {
                    setMoveOpen(false);
                    if (folder) onMove(null);
                  }}
                >
                  Unsorted
                </MenuItem>
                {folders.length > 0 && <MenuSeparator />}
                {folders.map((f) => (
                  <MenuItem
                    key={f.id}
                    icon={FolderIcon}
                    active={folder?.id === f.id}
                    onClick={() => {
                      setMoveOpen(false);
                      if (folder?.id !== f.id) onMove(f.id);
                    }}
                  >
                    {f.name}
                  </MenuItem>
                ))}
              </Popover>
            </div>
          )}
          <IconButton icon={Trash2} label="Delete" onClick={onDelete} className="hover:text-danger" />
        </div>
      </div>
    </li>
  );
}
