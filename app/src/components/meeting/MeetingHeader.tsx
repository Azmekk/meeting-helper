import {
  ArrowLeft,
  ChevronDown,
  Download,
  Ellipsis,
  FileText,
  Folder as FolderIcon,
  FolderOpen,
  Languages,
  Pencil,
  Share2,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { EXPORT_FORMATS, type ExportFormat } from '../../lib/export';
import { formatDate, formatDuration } from '../../lib/format';
import type { Job } from '../../lib/pipeline';
import type { Folder, Meeting, ProviderId, Transcript } from '../../lib/types';
import { Button, IconButton, Input, Select } from '../ui';
import {
  MenuItem,
  MenuLabel,
  MenuSeparator,
  PROVIDER_IDS,
  PROVIDER_LABEL,
  Popover,
  StatusBadge,
  isJobActive,
  transcriptLabel,
} from './shared';

export function MeetingHeader({
  meeting,
  job,
  transcripts,
  activeTranscript,
  defaultProvider,
  onRename,
  onSelectTranscript,
  onTranscribe,
  onExport,
  onShowInFolder,
  onShare,
  onDeleteTranscript,
  onDeleteMeeting,
  folders,
  onMoveToFolder,
}: {
  meeting: Meeting;
  job: Job | undefined;
  transcripts: Transcript[];
  activeTranscript: Transcript | null;
  defaultProvider: ProviderId;
  onRename: (title: string) => void;
  onSelectTranscript: (id: number) => void;
  onTranscribe: (provider: ProviderId) => void;
  onExport: (format: ExportFormat) => void;
  onShowInFolder: () => void;
  onShare: () => void;
  onDeleteTranscript: () => void;
  onDeleteMeeting: () => void;
  folders: Folder[];
  onMoveToFolder: (folderId: number | null) => void;
}) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [menu, setMenu] = useState<null | 'transcribe' | 'export' | 'more'>(null);
  const busy = isJobActive(job) || meeting.status === 'processing';
  const hasMedia = !!(meeting.mediaPath || meeting.sourcePath);
  const toggle = (m: NonNullable<typeof menu>) => setMenu((cur) => (cur === m ? null : m));
  const close = () => setMenu(null);

  const saveTitle = (value: string) => {
    setEditingTitle(false);
    const t = value.trim();
    if (t && t !== meeting.title) onRename(t);
  };

  return (
    <header className="pb-5">
      <Link
        to="/meetings"
        className="-ml-2 mb-2 inline-flex h-7 items-center gap-1 rounded-full px-2 text-[13px] font-medium text-accent-ink transition-colors hover:bg-accent-soft"
      >
        <ArrowLeft size={14} />
        Meetings
      </Link>

      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted">
            {(folders.length > 0 || meeting.folderId != null) && (
              <label className="-ml-1 inline-flex items-center gap-1" title="Folder">
                <FolderIcon size={13} className="text-faint" />
                <Select
                  plain
                  aria-label="Folder"
                  value={meeting.folderId ?? ''}
                  disabled={meeting.status === 'recording'}
                  onChange={(e) => onMoveToFolder(e.target.value ? Number(e.target.value) : null)}
                  className="max-w-48 rounded-full px-1.5 py-0.5 text-[13px] text-muted hover:bg-hover hover:text-text focus:outline-none"
                >
                  <option value="">Unsorted</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </Select>
              </label>
            )}
            {(folders.length > 0 || meeting.folderId != null) && <span className="text-faint">·</span>}
            <span>{formatDate(meeting.createdAt)}</span>
            <span className="text-faint">·</span>
            <span>{formatDuration(meeting.durationMs)}</span>
            <StatusBadge status={meeting.status} job={job} />
            {activeTranscript?.languages && (
              <span className="inline-flex items-center gap-1 text-muted" title="Detected languages">
                <Languages size={13} />
                {activeTranscript.languages}
              </span>
            )}
          </div>
          {editingTitle ? (
            <Input
              autoFocus
              defaultValue={meeting.title}
              onFocus={(e) => e.currentTarget.select()}
              onBlur={(e) => saveTitle(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveTitle(e.currentTarget.value);
                if (e.key === 'Escape') setEditingTitle(false);
              }}
              className="mt-1 h-11 max-w-2xl rounded-field! font-display text-[26px]! font-bold tracking-[-0.02em]"
            />
          ) : (
            <h1
              onClick={() => setEditingTitle(true)}
              title="Click to rename"
              className="group -mx-2 mt-1 inline-flex max-w-full cursor-text items-center gap-2 rounded-xl px-2 font-display text-[28px] leading-[44px] font-bold tracking-[-0.02em] hover:bg-hover"
            >
              <span className="truncate">{meeting.title || 'Untitled meeting'}</span>
              <Pencil size={15} className="shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
            </h1>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {transcripts.length > 0 && (
            <Select
              aria-label="Transcript"
              title="Which transcript to show"
              value={activeTranscript?.id ?? ''}
              onChange={(e) => onSelectTranscript(Number(e.target.value))}
              className="w-auto max-w-md"
            >
              {transcripts.map((t) => (
                <option key={t.id} value={t.id}>
                  {transcriptLabel(t)}
                </option>
              ))}
            </Select>
          )}

          <div className="relative">
            <Button
              variant={transcripts.length ? 'secondary' : 'primary'}
              icon={Sparkles}
              disabled={busy || !hasMedia || meeting.status === 'recording'}
              onClick={() => toggle('transcribe')}
            >
              Transcribe with…
              <ChevronDown size={14} className="-mr-1 opacity-70" />
            </Button>
            <Popover open={menu === 'transcribe'} onClose={close} className="top-full right-0 mt-1.5 w-64">
              <MenuLabel>Adds a new transcript</MenuLabel>
              {PROVIDER_IDS.map((p) => (
                <MenuItem
                  key={p}
                  onClick={() => {
                    close();
                    onTranscribe(p);
                  }}
                  hint={p === defaultProvider ? 'default' : undefined}
                >
                  {PROVIDER_LABEL[p]}
                </MenuItem>
              ))}
            </Popover>
          </div>

          <div className="relative">
            <Button icon={Download} disabled={!activeTranscript} onClick={() => toggle('export')}>
              Export
              <ChevronDown size={14} className="-mr-1 opacity-70" />
            </Button>
            <Popover open={menu === 'export'} onClose={close} className="top-full right-0 mt-1.5 w-60">
              {EXPORT_FORMATS.map((f) => (
                <MenuItem
                  key={f.id}
                  icon={FileText}
                  hint={`.${f.ext}`}
                  onClick={() => {
                    close();
                    onExport(f.id);
                  }}
                >
                  {f.label}
                </MenuItem>
              ))}
            </Popover>
          </div>

          <div className="relative">
            <IconButton icon={Ellipsis} label="More" onClick={() => toggle('more')} className="h-9 w-9 bg-fill text-text hover:bg-fill-strong" />
            <Popover open={menu === 'more'} onClose={close} className="top-full right-0 mt-1.5 w-56">
              <MenuItem
                icon={FolderOpen}
                disabled={!hasMedia}
                onClick={() => {
                  close();
                  onShowInFolder();
                }}
              >
                Show in folder
              </MenuItem>
              <MenuItem
                icon={Share2}
                disabled={meeting.status === 'recording'}
                onClick={() => {
                  close();
                  onShare();
                }}
              >
                Export meeting for someone…
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                icon={Trash2}
                danger
                disabled={!activeTranscript}
                onClick={() => {
                  close();
                  onDeleteTranscript();
                }}
              >
                Delete this transcript
              </MenuItem>
              <MenuItem
                icon={Trash2}
                danger
                onClick={() => {
                  close();
                  onDeleteMeeting();
                }}
              >
                Delete meeting
              </MenuItem>
            </Popover>
          </div>
        </div>
      </div>
    </header>
  );
}
