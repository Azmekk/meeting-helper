// Meeting-level actions shared by the list and the editor.
import { open } from '@tauri-apps/plugin-dialog';
import { remove } from '@tauri-apps/plugin-fs';
import { Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import * as db from '../../lib/db';
import { deleteMeetingFiles, emitMeetingChanged, ingestMedia } from '../../lib/pipeline';
import { baseFolder, importRecordingIntoFolder, removeMeetingSidecars } from '../../lib/folders';
import { useRecorder } from '../../lib/obs';
import type { CopyProgress } from '../../lib/native';
import type { Meeting } from '../../lib/types';
import { Button, Modal, errorMessage, toast } from '../ui';
import { MEDIA_EXTENSIONS, fileBaseName } from './shared';

// Opens the file picker and imports the chosen recording into `folderId`
// (null = Unsorted). With a base folder set the file is copied into the new
// meeting's directory first; without one it's used where it is. Resolves with
// the new meeting id, or null if the user cancelled.
export async function pickAndImportRecording(
  folderId: number | null = null,
  onProgress?: (p: CopyProgress) => void,
): Promise<number | null> {
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
  const title = fileBaseName(picked);
  if (baseFolder()) return importRecordingIntoFolder(picked, title, folderId, onProgress);
  const id = await ingestMedia(picked, title);
  if (folderId != null) {
    await db.setMeetingFolder(id, folderId);
    emitMeetingChanged(id);
  }
  return id;
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

  // OBS is still writing the file of a meeting that's recording; leave it alone.
  const files =
    meeting && meeting.status !== 'recording'
      ? [...new Set([meeting.mediaPath, meeting.sourcePath].filter((p): p is string => !!p))]
      : [];

  const confirm = async () => {
    if (!meeting) return;
    // The recording would come back as a new meeting and live lines would be
    // saved under the deleted id.
    if (useRecorder.getState().recordingMeetingId === meeting.id) {
      toast('Stop the recording before deleting this meeting.', 'error');
      return;
    }
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
      // The app's own copies (imported media, work files) always go, and so do
      // the sidecar files, or a rescan would bring the meeting back.
      await deleteMeetingFiles(meeting.id).catch((err) => console.warn('Could not remove meeting files', err));
      await removeMeetingSidecars(meeting).catch((err) => console.warn('Could not remove meeting.json', err));
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
