// Sharing one meeting with someone who has the app: export it as a
// .meeting.zip, and import such a file with the speakers named on this side
// (the sender's own mic speaker is not "you" here).
import { open, save } from '@tauri-apps/plugin-dialog';
import { stat } from '@tauri-apps/plugin-fs';
import { FileArchive, FolderUp } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  SHARE_EXT,
  exportZip,
  formatBytes,
  importZip,
  inspectZip,
  useBackup,
  type SingleMeetingZip,
  type ZipImportResult,
} from '../../lib/backup';
import { bundleSpeakers } from '../../lib/bundle';
import * as db from '../../lib/db';
import { refreshFolders, useFolders } from '../../lib/folders';
import type { Meeting } from '../../lib/types';
import { Button, Callout, Field, Input, Modal, Select, SettingRow, Switch, errorMessage, toast } from '../ui';

function Progress() {
  const progress = useBackup((s) => s.progress);
  if (!progress) return null;
  const pct = progress.fraction != null ? ` ${Math.round(progress.fraction * 100)}%` : '';
  return (
    <p className="mt-3 truncate rounded-full bg-accent-soft px-3 py-1 text-[13px] text-accent-ink" title={progress.message}>
      {progress.message}
      {pct}
    </p>
  );
}

// "Q3 planning: notes?" → "Q3 planning notes"
const fileSafe = (s: string) => s.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'meeting';

// ---------- Export ----------

export function ExportMeetingModal({ meeting, open: isOpen, onClose }: { meeting: Meeting; open: boolean; onClose: () => void }) {
  const [recording, setRecording] = useState(true);
  const [aiDocs, setAiDocs] = useState(true);
  const [chat, setChat] = useState(false);
  const [size, setSize] = useState<number | null>(null);
  const [counts, setCounts] = useState<{ docs: number; chat: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useBackup((s) => s.running);
  const mediaPath = meeting.mediaPath ?? meeting.sourcePath;

  useEffect(() => {
    if (!isOpen) return;
    setSize(null);
    if (mediaPath) {
      stat(mediaPath)
        .then((s) => setSize(s.size))
        .catch(() => setSize(null));
    }
    void Promise.all([db.listMeetingAiDocs(meeting.id), db.listChatMessages('meeting', meeting.id)])
      .then(([d, c]) => setCounts({ docs: d.length, chat: c.length }))
      .catch(() => setCounts(null));
  }, [isOpen, meeting.id, mediaPath]);

  const hasMedia = !!mediaPath && size != null;

  const run = async () => {
    const out = await save({
      title: 'Export meeting',
      defaultPath: `${fileSafe(meeting.title)}${SHARE_EXT}`,
      filters: [{ name: 'Meeting file', extensions: ['zip'] }],
    });
    if (!out) return;
    setBusy(true);
    try {
      await exportZip({ meetingIds: [meeting.id], folderIds: [], share: { recording: recording && hasMedia, aiDocs, chat } }, out);
      toast(`Meeting saved to ${out}`, 'success');
      onClose();
    } catch (err) {
      toast(`Export failed: ${errorMessage(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={isOpen}
      onClose={busy ? () => {} : onClose}
      title="Export meeting for someone"
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon={FileArchive} loading={busy} disabled={!!running && !busy} onClick={run}>
            Export…
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted">
        Saves one file they can open with <b className="font-medium text-text">Import meeting file</b> in their copy of Meeting Helper.
        Transcripts are always included.
      </p>
      <div className="mt-4 divide-y divide-line rounded-2xl bg-fill px-4">
        <SettingRow
          title="Recording"
          description={!mediaPath ? 'This meeting has no recording.' : size != null ? formatBytes(size) : 'The recording file is missing.'}
        >
          <Switch checked={recording && hasMedia} disabled={!hasMedia} onChange={setRecording} label="Include the recording" />
        </SettingRow>
        <SettingRow
          title="Summary and AI notes"
          description={counts && !counts.docs ? 'Nothing generated yet.' : 'Summary, AI documents, action items and extracted fields.'}
        >
          <Switch checked={aiDocs} onChange={setAiDocs} label="Include the summary and AI notes" />
        </SettingRow>
        <SettingRow title="Chat history" description={counts && !counts.chat ? 'No chat yet.' : 'Your questions to the AI about this meeting. Private by default.'}>
          <Switch checked={chat} onChange={setChat} label="Include the chat history" />
        </SettingRow>
      </div>
      {busy && <Progress />}
    </Modal>
  );
}

// ---------- Import ----------

export async function pickMeetingZip(title = 'Import meeting file'): Promise<string | null> {
  const picked = await open({ multiple: false, title, filters: [{ name: 'Meeting file', extensions: ['zip'] }] });
  return typeof picked === 'string' ? picked : null;
}

const resultLine = (r: ZipImportResult) =>
  `${r.imported} added, ${r.updated} updated, ${r.skipped} already up to date${r.folders ? `, ${r.folders} folder(s) restored` : ''}.`;

// A zip with a single meeting opens the import dialog (setPending); anything
// else is imported right away like a backup. Resolves with the result of that
// direct import, or null when the dialog took over.
export async function startMeetingZipImport(
  zipPath: string,
  setPending: (z: SingleMeetingZip) => void,
): Promise<{ meetingId: number | null } | null> {
  const single = await inspectZip(zipPath);
  if (single) {
    setPending(single);
    return null;
  }
  const res = await importZip(zipPath);
  toast(`Zip imported: ${resultLine(res)}${res.failed.length ? ` ${res.failed.length} failed.` : ''}`, res.failed.length ? 'error' : 'success');
  return { meetingId: res.meetingId ?? null };
}

export function ImportMeetingModal({
  pending,
  onClose,
  onImported,
}: {
  pending: SingleMeetingZip | null;
  onClose: () => void;
  onImported: (meetingId: number | null, result: ZipImportResult) => void;
}) {
  const folders = useFolders((s) => s.folders);
  const [names, setNames] = useState<Record<string, string>>({});
  const [folderId, setFolderId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const speakers = pending ? bundleSpeakers(pending.bundle) : [];

  useEffect(() => {
    if (!pending) return;
    refreshFolders().catch(() => {});
    const next: Record<string, string> = {};
    for (const s of bundleSpeakers(pending.bundle)) {
      // The sender's mic is labelled with their own setting ("Me" by default).
      next[s.key] = s.isSelf ? (pending.exportedBy ?? s.name ?? (s.label !== 'Me' ? s.label : '')) : (s.name ?? s.label);
    }
    setNames(next);
    // Re-imports stay where they are unless moved here.
    setFolderId(pending.existing?.folderId ?? null);
  }, [pending]);

  const run = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const res = await importZip(pending.zipPath, undefined, { folderId, speakerNames: names });
      if (res.failed.length) throw new Error(res.failed.map((f) => f.error).join('; '));
      toast(res.updated ? 'Meeting updated' : 'Meeting imported', 'success');
      onImported(res.meetingId ?? null, res);
    } catch (err) {
      toast(`Import failed: ${errorMessage(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const b = pending?.bundle;
  return (
    <Modal
      open={!!pending}
      onClose={busy ? () => {} : onClose}
      title="Import meeting"
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon={FolderUp} loading={busy} onClick={run}>
            {pending?.existing ? 'Update meeting' : 'Import'}
          </Button>
        </>
      }
    >
      {b && pending && (
        <div className="space-y-4">
          <div className="rounded-2xl bg-fill px-4 py-3">
            <div className="text-[15px] font-semibold">{b.meeting.title || 'Untitled meeting'}</div>
            <div className="text-[13px] text-muted">
              {new Date(b.meeting.createdAt).toLocaleString()}
              {pending.exportedBy && ` · from ${pending.exportedBy}`}
              {pending.recordingSize != null ? ` · recording ${formatBytes(pending.recordingSize)}` : ' · no recording'}
            </div>
          </div>
          {pending.existing && (
            <Callout tone="info">You imported this meeting before. Importing again replaces that copy, including its speaker names.</Callout>
          )}

          <div>
            <div className="mb-1.5 px-1 text-[12px] font-semibold tracking-[0.04em] text-muted uppercase">Speakers</div>
            {speakers.length === 0 && <p className="text-[13px] text-muted">This meeting has no transcript.</p>}
            <div className={speakers.length ? 'divide-y divide-line rounded-2xl bg-fill px-4' : undefined}>
              {speakers.map((s) => (
                <div key={s.key} className="grid grid-cols-[minmax(0,10rem)_1fr] items-center gap-3 py-2">
                  <span className="truncate text-[13px] text-muted" title={s.label}>
                    {s.isSelf ? 'Recorded by (the sender)' : s.label}
                  </span>
                  <Input
                    value={names[s.key] ?? ''}
                    placeholder={s.isSelf ? "The sender's name" : s.label}
                    onChange={(e) => setNames((cur) => ({ ...cur, [s.key]: e.target.value }))}
                    className="bg-panel hover:bg-panel"
                  />
                </div>
              ))}
            </div>
          </div>

          <Field label="Folder">
            <Select value={folderId ?? ''} onChange={(e) => setFolderId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">Unsorted</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </Select>
          </Field>
          {busy && <Progress />}
        </div>
      )}
    </Modal>
  );
}
