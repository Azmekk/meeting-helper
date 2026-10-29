// Meeting-level actions shared by the list and the editor.
import { open } from '@tauri-apps/plugin-dialog';
import { remove } from '@tauri-apps/plugin-fs';
import { Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import * as db from '../../lib/db';
import { ingestMedia } from '../../lib/pipeline';
import type { Meeting } from '../../lib/types';
import { Button, Modal, errorMessage, toast } from '../ui';
import { MEDIA_EXTENSIONS, fileBaseName } from './shared';

// Opens the file picker and imports the chosen recording. Resolves with the
// new meeting id, or null if the user cancelled.
export async function pickAndImportRecording(): Promise<number | null> {
  const picked = await open({
    multiple: false,
    directory: false,
    title: 'Import a recording',
    filters: [
      { name: 'Audio & video', extensions: MEDIA_EXTENSIONS },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (!picked || typeof picked !== 'string') return null;
  return ingestMedia(picked, fileBaseName(picked));
}

export function DeleteMeetingModal({
  meeting,
  onClose,
  onDeleted,
}: {
  meeting: Meeting | null;
  onClose: () => void;
  onDeleted: (id: number) => void;
}) {
  const [alsoFiles, setAlsoFiles] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (meeting) setAlsoFiles(false);
  }, [meeting]);

  const files = meeting ? [...new Set([meeting.mediaPath, meeting.sourcePath].filter((p): p is string => !!p))] : [];

  const confirm = async () => {
    if (!meeting) return;
    setBusy(true);
    try {
      await db.deleteMeeting(meeting.id);
      if (alsoFiles) {
        for (const f of files) {
          try {
            await remove(f);
          } catch (err) {
            toast(`Couldn't delete ${fileBaseName(f)}: ${errorMessage(err)}`, 'error');
          }
        }
      }
      toast('Meeting deleted', 'success');
      onDeleted(meeting.id);
    } catch (err) {
      toast(`Couldn't delete meeting: ${errorMessage(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={!!meeting}
      onClose={onClose}
      title="Delete meeting?"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" icon={Trash2} loading={busy} onClick={confirm}>
            Delete
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted">
        <span className="font-medium text-text">{meeting?.title}</span> and all of its transcripts will be removed. This
        can't be undone.
      </p>
      {files.length > 0 && (
        <label className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-lg border border-line bg-sunken/50 px-3 py-2.5">
          <input
            type="checkbox"
            checked={alsoFiles}
            onChange={(e) => setAlsoFiles(e.target.checked)}
            className="mt-0.5 accent-[var(--c-accent)]"
          />
          <span className="min-w-0 text-[13px]">
            <span className="font-medium">Also delete the media file{files.length > 1 ? 's' : ''}</span>
            {files.map((f) => (
              <span key={f} className="block truncate font-mono text-xs text-muted" title={f}>
                {f}
              </span>
            ))}
          </span>
        </label>
      )}
    </Modal>
  );
}
