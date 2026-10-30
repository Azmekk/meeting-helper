import { openUrl } from '@tauri-apps/plugin-opener';
import { Copy, RefreshCw, Settings as SettingsIcon } from 'lucide-react';
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { FFMPEG_INSTALL, IS_WINDOWS } from '../lib/platform';
import { checkFfmpeg, ffmpegDialogOpen, useFfmpeg } from '../lib/requirements';
import { Button, IconButton, Modal, errorMessage, toast } from './ui';

function copy(text: string) {
  navigator.clipboard
    .writeText(text)
    .then(() => toast('Copied', 'success'))
    .catch((err) => toast(`Couldn't copy: ${errorMessage(err)}`, 'error'));
}

// Shown at start-up when ffmpeg can't be run. Nothing works without it
// (playback conversion and transcription both use it), so ask straight away.
export function FfmpegDialog() {
  const status = useFfmpeg((s) => s.status);
  const open = useFfmpeg(ffmpegDialogOpen);
  const navigate = useNavigate();

  useEffect(() => {
    void checkFfmpeg();
  }, []);

  const later = () => useFfmpeg.setState({ dismissed: true });

  async function checkAgain() {
    if (await checkFfmpeg()) toast('ffmpeg found. You are all set.', 'success');
    else toast("Still can't find ffmpeg", 'error');
  }

  return (
    <Modal
      open={open}
      onClose={later}
      title="Install ffmpeg to get started"
      footer={
        <>
          <Button variant="ghost" onClick={later}>
            Later
          </Button>
          <Button
            icon={SettingsIcon}
            onClick={() => {
              later();
              navigate('/settings?tab=system');
            }}
          >
            Set the path
          </Button>
          <Button variant="primary" icon={RefreshCw} loading={status === 'checking'} onClick={checkAgain}>
            Check again
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <p>
          Meeting Helper uses the free tool <b>ffmpeg</b> to convert recordings for playback and to pull out the audio
          for transcription. It isn't installed, or the app can't find it.
        </p>
        <div className="space-y-2">
          <div className="text-[13px] font-medium">Install it from a terminal{IS_WINDOWS && ' (PowerShell)'}:</div>
          {FFMPEG_INSTALL.map((cmd) => (
            <div key={cmd} className="flex items-center gap-2">
              <code className="flex-1 rounded-lg bg-sunken px-3 py-2 font-mono text-[12.5px]">{cmd}</code>
              <IconButton icon={Copy} label="Copy command" onClick={() => copy(cmd)} />
            </div>
          ))}
          {FFMPEG_INSTALL.length > 1 && <p className="text-xs text-muted">Any one of these works.</p>}
        </div>
        <p className="text-muted">
          Or download it from{' '}
          <a
            href="https://ffmpeg.org/download.html"
            className="text-accent underline"
            onClick={(e) => {
              e.preventDefault();
              void openUrl('https://ffmpeg.org/download.html');
            }}
          >
            ffmpeg.org
          </a>{' '}
          and use <b>Set the path</b> to point Meeting Helper at it. Then click <b>Check again</b>.
        </p>
      </div>
    </Modal>
  );
}
