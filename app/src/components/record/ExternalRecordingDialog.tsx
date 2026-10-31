// OBS started recording on its own (its UI, a hotkey, or before the app was
// open): only recordings started from the app become meetings without asking.
import { useState } from 'react';
import {
  discardExternalRecording,
  ignoreExternalRecording,
  importExternalRecording,
  trackExternalRecording,
  useRecorder,
  type ExternalRecording,
} from '../../lib/obs';
import { fileBaseName } from '../meeting/shared';
import { Button, Modal } from '../ui';

export function ExternalRecordingDialog() {
  const ext = useRecorder((s) => s.externalRecording);
  const open = !!ext && !ext.ignored;
  // Kept while the modal fades out.
  const [shown, setShown] = useState<ExternalRecording | null>(null);
  if (open && ext !== shown) setShown(ext);
  const view = open ? ext : shown;
  if (!view) return null;

  // Closing without answering: while recording that's "Ignore" (it can still be
  // tracked from the Record screen); once stopped the file is left alone.
  const close = view.stopped ? discardExternalRecording : ignoreExternalRecording;
  const file = view.path ? fileBaseName(view.path) : null;

  return (
    <Modal
      open={open}
      onClose={close}
      title={
        view.stopped ? (
          <>OBS recorded {file ? <span className="break-all">“{file}”</span> : 'a file'}</>
        ) : (
          'OBS started recording'
        )
      }
      footer={
        view.stopped ? (
          <>
            <Button variant="ghost" onClick={discardExternalRecording}>
              Discard
            </Button>
            <Button variant="primary" onClick={() => void importExternalRecording()} disabled={!view.path}>
              Import
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={ignoreExternalRecording}>
              Ignore
            </Button>
            <Button variant="primary" onClick={trackExternalRecording}>
              Track as meeting
            </Button>
          </>
        )
      }
    >
      <p className="text-[13px] text-muted">
        {view.stopped ? (
          <>
            The recording was started and stopped in OBS. Import it as a meeting? Discard leaves the file untouched in
            OBS’s recording folder.
            {view.path && (
              <span className="mt-2 block truncate font-mono text-xs" title={view.path}>
                {view.path}
              </span>
            )}
          </>
        ) : (
          <>
            This recording was started in OBS, not from Meeting Helper. Track it as a meeting? It then gets a title,
            folder and live transcription like any other recording. If you ignore it, OBS keeps recording and the file
            stays in OBS’s folder.
          </>
        )}
      </p>
    </Modal>
  );
}
