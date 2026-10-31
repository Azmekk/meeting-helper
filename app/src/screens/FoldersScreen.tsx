// Folders: a list on the left, the selected folder on the right with its
// meetings, briefing and the folder AI tabs (summary, progress, chat, extract).
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import {
  AudioLines,
  CheckSquare,
  Folder as FolderIcon,
  FolderOpen,
  FolderPlus,
  MessageSquare,
  Pencil,
  Sparkles,
  Table2,
  Trash2,
  Upload,
  Video,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ExtractPanel } from '../components/folders/ExtractPanel';
import { FolderBriefingCard, FolderChatPanel, FolderSummaryPanel, FolderTermsCard } from '../components/folders/FolderAiPanels';
import { ProgressPanel } from '../components/folders/ProgressPanel';
import { pickAndImportRecording } from '../components/meeting/actions';
import { StatusBadge, isAudioPath } from '../components/meeting/shared';
import {
  Button,
  Callout,
  Card,
  EmptyState,
  IconButton,
  Input,
  Modal,
  PageHeader,
  Spinner,
  clsx,
  errorMessage,
  toast,
} from '../components/ui';
import * as db from '../lib/db';
import { useFolderAi } from '../lib/ai/folder';
import { createFolderWithDir, deleteFolderKeepMeetings, folderDirPath, refreshFolders, renameFolderWithDir, useFolders } from '../lib/folders';
import { formatDate, formatDuration } from '../lib/format';
import { onMeetingChanged, useJobs } from '../lib/pipeline';
import { useSettings } from '../lib/settings';
import type { Folder, Meeting } from '../lib/types';

type Tab = 'summary' | 'progress' | 'chat' | 'extract';

const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: 'summary', label: 'Summary', icon: Sparkles },
  { id: 'progress', label: 'Progress', icon: CheckSquare },
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'extract', label: 'Extract', icon: Table2 },
];

export default function FoldersScreen() {
  const { id: idParam } = useParams();
  const folderId = idParam ? Number(idParam) : null;
  const navigate = useNavigate();
  const folders = useFolders((s) => s.folders);
  const busy = useFolderAi((s) => s.busy);
  const [loaded, setLoaded] = useState(false);
  const [counts, setCounts] = useState<Record<number, number>>({});
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      await refreshFolders();
      const all = await db.listMeetings();
      const c: Record<number, number> = {};
      for (const m of all) if (m.folderId != null) c[m.folderId] = (c[m.folderId] ?? 0) + 1;
      setCounts(c);
    } catch (err) {
      toast(`Couldn't load folders: ${errorMessage(err)}`, 'error');
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    refresh();
    return onMeetingChanged(() => refresh());
  }, [refresh]);

  const create = async (name: string) => {
    setCreating(false);
    if (!name.trim()) return;
    try {
      const f = await createFolderWithDir(name);
      navigate(`/folders/${f.id}`);
    } catch (err) {
      toast(`Couldn't create the folder: ${errorMessage(err)}`, 'error');
    }
  };

  const folder = folderId != null ? (folders.find((f) => f.id === folderId) ?? null) : null;

  return (
    <div className="mx-auto max-w-7xl px-8 py-8">
      <PageHeader
        title="Folders"
        description="Group meetings by project, client or team. The AI can work across all meetings in a folder."
        actions={
          <Button variant="primary" icon={FolderPlus} onClick={() => setCreating(true)}>
            New folder
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="space-y-1 lg:sticky lg:top-6 lg:self-start">
          {creating && <NameInput initial="" placeholder="Folder name" onDone={create} />}
          {!loaded ? (
            <div className="flex justify-center py-6">
              <Spinner />
            </div>
          ) : (
            folders.map((f) => (
              <Link
                key={f.id}
                to={`/folders/${f.id}`}
                className={clsx(
                  'flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors',
                  f.id === folderId ? 'bg-panel font-medium text-text shadow-sm' : 'text-muted hover:bg-hover hover:text-text',
                )}
              >
                <FolderIcon size={15} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                {busy[f.id] ? <Spinner size={12} /> : <span className="text-xs text-faint tabular-nums">{counts[f.id] ?? 0}</span>}
              </Link>
            ))
          )}
          {loaded && !folders.length && !creating && <p className="px-2.5 py-2 text-[13px] text-muted">No folders yet.</p>}
        </aside>

        <section className="min-w-0">
          {folder ? (
            <FolderDetail key={folder.id} folder={folder} onDeleted={() => navigate('/folders')} />
          ) : (
            <Card>
              <EmptyState
                icon={FolderIcon}
                title={folders.length ? 'Pick a folder' : 'Create your first folder'}
                description="Each folder is also a real directory under your base folder, with one sub-folder per meeting."
                action={
                  !folders.length && (
                    <Button variant="primary" icon={FolderPlus} onClick={() => setCreating(true)}>
                      New folder
                    </Button>
                  )
                }
              />
            </Card>
          )}
        </section>
      </div>
    </div>
  );
}

function NameInput({ initial, placeholder, onDone }: { initial: string; placeholder: string; onDone: (name: string) => void }) {
  return (
    <Input
      autoFocus
      defaultValue={initial}
      placeholder={placeholder}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => onDone(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onDone(e.currentTarget.value);
        if (e.key === 'Escape') onDone('');
      }}
      className="h-9"
    />
  );
}

function FolderDetail({ folder, onDeleted }: { folder: Folder; onDeleted: () => void }) {
  const navigate = useNavigate();
  const hasBase = useSettings((s) => !!s.settings.baseFolder);
  const [meetings, setMeetings] = useState<Meeting[] | null>(null);
  const [tab, setTab] = useState<Tab>('summary');
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);

  const load = useCallback(() => {
    db.listFolderMeetings(folder.id)
      .then(setMeetings)
      .catch((err) => {
        setMeetings([]);
        toast(errorMessage(err), 'error');
      });
  }, [folder.id]);

  useEffect(() => {
    load();
    return onMeetingChanged(() => load());
  }, [load]);

  const rename = async (name: string) => {
    setRenaming(false);
    if (!name.trim() || name.trim() === folder.name) return;
    try {
      await renameFolderWithDir(folder.id, name);
    } catch (err) {
      toast(`Couldn't rename the folder: ${errorMessage(err)}`, 'error');
    }
  };

  const remove = async () => {
    setDeleting(true);
    try {
      await deleteFolderKeepMeetings(folder.id);
      setConfirmDelete(false);
      toast('Folder deleted; its meetings are now unsorted', 'success');
      onDeleted();
    } catch (err) {
      toast(`Couldn't delete the folder: ${errorMessage(err)}`, 'error');
    } finally {
      setDeleting(false);
    }
  };

  const importRecording = async () => {
    setImporting('Importing…');
    try {
      const id = await pickAndImportRecording(folder.id, (p) =>
        setImporting(p.total > 1 ? `Copying… ${Math.round((p.done / p.total) * 100)}%` : 'Importing…'),
      );
      if (id != null) navigate(`/meetings/${id}`);
    } catch (err) {
      toast(`Import failed: ${errorMessage(err)}`, 'error');
    } finally {
      setImporting(null);
    }
  };

  const showDir = async () => {
    try {
      await revealItemInDir(await folderDirPath(folder));
    } catch (err) {
      toast(`Couldn't open the folder: ${errorMessage(err)}`, 'error');
    }
  };

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        {renaming ? (
          <div className="max-w-md flex-1">
            <NameInput initial={folder.name} placeholder="Folder name" onDone={rename} />
          </div>
        ) : (
          <h2
            onClick={() => setRenaming(true)}
            title="Click to rename"
            className="group -mx-1.5 inline-flex min-w-0 cursor-text items-center gap-2 rounded-lg px-1.5 font-display text-xl leading-9 font-semibold tracking-tight hover:bg-hover/60"
          >
            <span className="truncate">{folder.name}</span>
            <Pencil size={14} className="shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
          </h2>
        )}
        <div className="flex items-center gap-2">
          {hasBase && <IconButton icon={FolderOpen} label="Show in Explorer" onClick={showDir} className="h-9 w-9" />}
          <IconButton icon={Trash2} label="Delete folder" onClick={() => setConfirmDelete(true)} className="h-9 w-9 hover:text-danger" />
          <Button variant="primary" icon={Upload} loading={!!importing} onClick={importRecording}>
            {importing ?? 'Import recording'}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-8 xl:grid-cols-[minmax(260px,340px)_minmax(0,1fr)]">
        <aside className="space-y-5">
          <Card title="Meetings" description={meetings ? `${meetings.length} in this folder` : undefined} padded={false}>
            {meetings === null ? (
              <div className="flex justify-center py-6">
                <Spinner />
              </div>
            ) : meetings.length ? (
              <ul className="divide-y divide-line">
                {[...meetings].reverse().map((m) => (
                  <FolderMeetingRow key={m.id} meeting={m} />
                ))}
              </ul>
            ) : (
              <p className="px-5 py-6 text-center text-[13px] text-muted">
                No meetings yet. Import a recording here, record into this folder, or move meetings in from the Meetings list.
              </p>
            )}
          </Card>
          <FolderBriefingCard folder={folder} />
          <FolderTermsCard folder={folder} />
          {!hasBase && (
            <Callout tone="info" title="Folders exist only in the app for now">
              Choose a base folder in{' '}
              <Link to="/settings?tab=folders">Settings → Folders</Link> to keep each folder's meetings and recordings together on disk.
            </Callout>
          )}
        </aside>

        <section className="min-w-0">
          <div role="tablist" className="mb-4 flex items-end gap-1 border-b border-line">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={clsx(
                  '-mb-px inline-flex h-10 items-center gap-2 border-b-2 px-3 text-sm transition-colors',
                  tab === t.id ? 'border-accent font-medium text-text' : 'border-transparent text-muted hover:text-text',
                )}
              >
                <t.icon size={14} />
                {t.label}
              </button>
            ))}
          </div>
          {/* Panels stay mounted so requests survive tab switches. */}
          <div className={clsx(tab !== 'summary' && 'hidden')}>
            <FolderSummaryPanel folder={folder} />
          </div>
          <div className={clsx(tab !== 'progress' && 'hidden')}>
            <ProgressPanel folder={folder} meetings={meetings ?? []} />
          </div>
          <div className={clsx(tab !== 'chat' && 'hidden')}>
            <FolderChatPanel folder={folder} />
          </div>
          <div className={clsx(tab !== 'extract' && 'hidden')}>
            <ExtractPanel folder={folder} meetings={meetings ?? []} />
          </div>
        </section>
      </div>

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete folder?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="danger" icon={Trash2} loading={deleting} onClick={remove}>
              Delete folder
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">
          <span className="font-medium text-text">{folder.name}</span> and its summary, chat, action items and extraction
          tables will be deleted. Its {meetings?.length ?? 0} meeting(s) are kept and become unsorted
          {hasBase ? '; their directories move to Unsorted' : ''}.
        </p>
      </Modal>
    </div>
  );
}

function FolderMeetingRow({ meeting: m }: { meeting: Meeting }) {
  const job = useJobs((s) => s.jobs[m.id]);
  const audio = isAudioPath(m.mediaPath ?? m.sourcePath);
  return (
    <li>
      <Link to={`/meetings/${m.id}`} className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-hover/50">
        <span className="text-muted">{audio ? <AudioLines size={15} /> : <Video size={15} />}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium">{m.title || 'Untitled meeting'}</span>
          <span className="block text-xs text-faint">
            {formatDate(m.createdAt)} · {formatDuration(m.durationMs)}
          </span>
        </span>
        {m.status !== 'ready' && <StatusBadge status={m.status} job={job} />}
      </Link>
    </li>
  );
}
