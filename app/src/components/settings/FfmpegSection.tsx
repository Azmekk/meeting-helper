import { open } from '@tauri-apps/plugin-dialog';
import { FolderOpen, Stethoscope } from 'lucide-react';
import { useState } from 'react';
import { ffmpegVersion } from '../../lib/native';
import { useSettings } from '../../lib/settings';
import { Button, Callout, Card, errorMessage, toast } from '../ui';
import { CommitInput, saveSettings } from './common';

type Check = { kind: 'idle' } | { kind: 'running' } | { kind: 'ok'; version: string } | { kind: 'error'; message: string };

export function FfmpegSection() {
  const ffmpegPath = useSettings((s) => s.settings.ffmpegPath);
  const [check, setCheck] = useState<Check>({ kind: 'idle' });

  async function runCheck(path = ffmpegPath) {
    setCheck({ kind: 'running' });
    try {
      setCheck({ kind: 'ok', version: await ffmpegVersion(path) });
    } catch (err) {
      setCheck({ kind: 'error', message: errorMessage(err) });
    }
  }

  async function setPath(path: string) {
    await saveSettings({ ffmpegPath: path });
    setCheck({ kind: 'idle' });
  }

  async function browse() {
    try {
      const picked = await open({
        title: 'Select ffmpeg.exe',
        multiple: false,
        directory: false,
        filters: [{ name: 'ffmpeg', extensions: ['exe'] }],
      });
      if (typeof picked === 'string') {
        await setPath(picked);
        runCheck(picked);
      }
    } catch (err) {
      toast(`Couldn't open the file picker: ${errorMessage(err)}`, 'error');
    }
  }

  return (
    <Card
      title="ffmpeg"
      description="Needed to convert recordings to MP4 and to pull out the audio for transcription."
    >
      <div className="space-y-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="ffmpeg-path" className="text-[13px] font-medium">
            Path to ffmpeg.exe
          </label>
          <div className="flex gap-2">
            <CommitInput
              id="ffmpeg-path"
              spellCheck={false}
              className="flex-1 font-mono text-[13px]"
              placeholder="Use ffmpeg from PATH"
              value={ffmpegPath}
              onCommit={(v) => setPath(v.trim())}
            />
            <Button icon={FolderOpen} onClick={browse}>
              Browse
            </Button>
            <Button icon={Stethoscope} onClick={() => runCheck()} loading={check.kind === 'running'}>
              Check
            </Button>
          </div>
          <span className="text-xs text-muted">
            Leave empty to use ffmpeg from PATH. ffprobe.exe must be in the same folder.
          </span>
        </div>

        {check.kind === 'ok' && (
          <Callout tone="success" title="ffmpeg works">
            <span className="font-mono text-[12px] break-all">{check.version}</span>
          </Callout>
        )}
        {check.kind === 'error' && (
          <Callout tone="error" title="ffmpeg couldn't run">
            <p className="break-words">{check.message}</p>
            <p className="pt-1">
              Install it from a terminal with{' '}
              <code className="rounded bg-sunken px-1 font-mono text-[12px] text-text">winget install Gyan.FFmpeg</code>{' '}
              (or <code className="rounded bg-sunken px-1 font-mono text-[12px] text-text">scoop install ffmpeg</code> /{' '}
              <code className="rounded bg-sunken px-1 font-mono text-[12px] text-text">choco install ffmpeg</code>),
              then restart Meeting Helper so it sees the new PATH. Or click <b className="text-text">Browse</b> and
              select ffmpeg.exe.
            </p>
          </Callout>
        )}
      </div>
    </Card>
  );
}
