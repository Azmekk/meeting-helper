import { openUrl } from '@tauri-apps/plugin-opener';
import { ArrowUpCircle, Download } from 'lucide-react';
import { formatDate } from '../lib/format';
import { ffmpegDialogOpen, useFfmpeg } from '../lib/requirements';
import { dismissUpdate, skipUpdate, useUpdate } from '../lib/updates';
import { Button, Modal, errorMessage, toast } from './ui';

function openRelease(url: string) {
  openUrl(url).catch((err) => toast(`Couldn't open the download page: ${errorMessage(err)}`, 'error'));
}

// "A new version is out" popup. It only links to the release; the user installs it.
export function UpdateDialog() {
  const available = useUpdate((s) => s.available);
  const dismissed = useUpdate((s) => s.dismissed);
  const current = useUpdate((s) => s.current);
  // Wait until the "install ffmpeg" dialog is out of the way.
  const blocked = useFfmpeg(ffmpegDialogOpen);
  if (!available) return null;

  return (
    <Modal
      open={!dismissed && !blocked}
      onClose={dismissUpdate}
      title="A new version is out"
      width="max-w-md"
      footer={
        <>
          <Button variant="ghost" onClick={() => void skipUpdate(available.version)}>
            Skip this version
          </Button>
          <Button onClick={dismissUpdate}>Later</Button>
          <Button
            variant="primary"
            icon={Download}
            onClick={() => {
              openRelease(available.url);
              dismissUpdate();
            }}
          >
            Download
          </Button>
        </>
      }
    >
      <div className="flex gap-4">
        <ArrowUpCircle size={28} className="mt-0.5 shrink-0 text-accent" />
        <div className="space-y-1.5 text-sm">
          <p>
            <b>Meeting Helper {available.version}</b> is available
            {available.publishedAt && <span className="text-muted"> (released {formatDate(available.publishedAt)})</span>}.
            You have {current ?? 'an older version'}.
          </p>
          <p className="text-muted">
            Download opens the release page in your browser. Install the new version over this one; your meetings,
            settings and API keys are kept.
          </p>
        </div>
      </div>
    </Modal>
  );
}

// Stays in the sidebar after the popup is closed with "Later".
export function SidebarUpdateNotice() {
  const available = useUpdate((s) => s.available);
  const dismissed = useUpdate((s) => s.dismissed);
  if (!available || !dismissed) return null;

  return (
    <button
      type="button"
      onClick={() => useUpdate.setState({ dismissed: false })}
      className="mb-2 flex w-full items-center gap-2 rounded-lg bg-accent-soft px-2.5 py-2 text-left text-[13px] font-medium text-accent transition-colors hover:bg-accent-soft/70"
    >
      <ArrowUpCircle size={15} className="shrink-0" />
      <span className="flex-1">Version {available.version} is out</span>
    </button>
  );
}
