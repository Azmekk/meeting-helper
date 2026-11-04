import { openUrl } from '@tauri-apps/plugin-opener';
import { ArrowUpCircle, Download, RefreshCw } from 'lucide-react';
import { formatDate } from '../lib/format';
import { ffmpegDialogOpen, useFfmpeg } from '../lib/requirements';
import { dismissUpdate, installUpdate, skipUpdate, useInstallBlocker, useUpdate } from '../lib/updates';
import { Button, Modal, errorMessage, toast } from './ui';

function openRelease(url: string) {
  openUrl(url).catch((err) => toast(`Couldn't open the download page: ${errorMessage(err)}`, 'error'));
}

// Shown once the update has downloaded in the background, or straight away with a
// link to the website when this copy can't install it itself.
export function UpdateDialog() {
  const available = useUpdate((s) => s.available);
  const phase = useUpdate((s) => s.phase);
  const dismissed = useUpdate((s) => s.dismissed);
  const current = useUpdate((s) => s.current);
  // Wait until the "install ffmpeg" dialog is out of the way.
  const blocked = useFfmpeg(ffmpegDialogOpen);
  const busy = useInstallBlocker();
  if (!available) return null;
  const inApp = phase === 'ready' || phase === 'installing';

  return (
    <Modal
      open={!dismissed && !blocked && phase !== 'downloading'}
      onClose={dismissUpdate}
      title={inApp ? 'A new version is ready' : 'A new version is out'}
      width="max-w-md"
      footer={
        <>
          <Button variant="ghost" disabled={phase === 'installing'} onClick={() => void skipUpdate(available.version)}>
            Skip this version
          </Button>
          <Button disabled={phase === 'installing'} onClick={dismissUpdate}>
            Later
          </Button>
          {inApp ? (
            <Button
              variant="primary"
              icon={RefreshCw}
              disabled={!!busy}
              loading={phase === 'installing'}
              onClick={() => installUpdate().catch((err) => toast(`Couldn't install the update: ${errorMessage(err)}`, 'error'))}
            >
              Restart to update
            </Button>
          ) : (
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
          )}
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
          {inApp ? (
            <p className="text-muted">
              {busy ? `You can restart once ${busy} has finished. ` : 'Meeting Helper will close, install it and open again. '}
              Your meetings, settings and API keys are kept.
            </p>
          ) : (
            <p className="text-muted">
              Download opens the Meeting Helper website in your browser. Install the new version over this one; your meetings,
              settings and API keys are kept.
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}

// Stays in the sidebar after the popup is closed with "Later".
export function SidebarUpdateNotice() {
  const available = useUpdate((s) => s.available);
  const phase = useUpdate((s) => s.phase);
  const dismissed = useUpdate((s) => s.dismissed);
  if (!available || !dismissed || phase === 'downloading') return null;

  return (
    <button
      type="button"
      onClick={() => useUpdate.setState({ dismissed: false })}
      className="mb-2 flex w-full items-center gap-2 rounded-xl bg-accent-soft px-3 py-2 text-left text-[13px] font-semibold text-accent-ink transition-colors hover:bg-accent-soft/70"
    >
      <ArrowUpCircle size={15} className="shrink-0" />
      <span className="flex-1">
        Version {available.version} is {phase === 'idle' ? 'out' : 'ready'}
      </span>
    </button>
  );
}
