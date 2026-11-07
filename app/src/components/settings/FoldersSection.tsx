// Settings → Folders: the base folder, moving older meetings into it, rescan,
// and whether folder AI updates start switched on after a recording.
import { open } from '@tauri-apps/plugin-dialog';
import { mkdir } from '@tauri-apps/plugin-fs';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { FolderInput, FolderOpen, FolderSearch, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button, Callout, Card, Modal, SettingRow, Spinner, Switch, errorMessage, toast } from '../ui';
import { saveSettings } from './common';
import { adoptMeeting, folderDirPath, listMeetingsWithoutDir, refreshFolders, rescanBaseFolder, type RescanResult } from '../../lib/folders';
import { useSettings } from '../../lib/settings';
import type { Meeting } from '../../lib/types';

export function FoldersSection() {
  const baseFolder = useSettings((s) => s.settings.baseFolder);
  const folderAiPreselect = useSettings((s) => s.settings.folderAiPreselect);
  const [loose, setLoose] = useState<Meeting[] | null>(null);
  const [migrateOpen, setMigrateOpen] = useState(false);
  const [scanning, setScanning] = useState<string | null>(null);
  const [scan, setScan] = useState<RescanResult | null>(null);

  const loadLoose = useCallback(async () => {
    try {
      setLoose(await listMeetingsWithoutDir());
    } catch {
      setLoose([]);
    }
  }, []);

  useEffect(() => {
    loadLoose();
  }, [loadLoose]);

  const choose = async () => {
    const picked = await open({ directory: true, multiple: false, title: 'Choose the base folder for meetings' });
    if (!picked || typeof picked !== 'string') return;
    const first = !baseFolder;
    await saveSettings({ baseFolder: picked });
    try {
      // Create the folder directories so the structure is visible right away.
      for (const f of [null, ...(await refreshFolders())]) await mkdir(await folderDirPath(f), { recursive: true });
    } catch (err) {
      toast(`Couldn't create folders in ${picked}: ${errorMessage(err)}`, 'error');
    }
    const without = await listMeetingsWithoutDir();
    setLoose(without);
    if (first && without.length) setMigrateOpen(true);
  };

  const reveal = async () => {
    try {
      await revealItemInDir(baseFolder);
    } catch (err) {
      toast(`Couldn't open the folder: ${errorMessage(err)}`, 'error');
    }
  };

  const rescan = async () => {
    setScanning('Looking for meetings…');
    setScan(null);
    try {
      const res = await rescanBaseFolder((done, total) => setScanning(total ? `Reading ${Math.min(done + 1, total)} of ${total}…` : 'Looking for meetings…'));
      setScan(res);
      loadLoose();
    } catch (err) {
      toast(`Rescan failed: ${errorMessage(err)}`, 'error');
    } finally {
      setScanning(null);
    }
  };

  return (
    <>
      <Card
        title="Base folder"
        description="Each folder becomes a directory here, with one sub-folder per meeting holding its recording, meeting.json, transcript.md and summary.md."
      >
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate rounded-full bg-fill px-3.5 py-2 font-mono text-[12.5px]" title={baseFolder}>
            {baseFolder || <span className="font-sans text-muted">Not set: meetings stay where they were recorded or imported from.</span>}
          </div>
          {baseFolder && <Button icon={FolderOpen} onClick={reveal}>Show</Button>}
          <Button variant={baseFolder ? 'secondary' : 'primary'} icon={FolderInput} onClick={choose}>
            {baseFolder ? 'Change…' : 'Choose…'}
          </Button>
          {baseFolder && (
            <Button variant="ghost" icon={X} onClick={() => saveSettings({ baseFolder: '' })} title="Stop using a base folder. Files stay where they are.">
              Clear
            </Button>
          )}
        </div>
        {baseFolder && (
          <p className="mt-2 text-xs text-muted">
            Changing it later doesn't move meetings that are already in the old location. Move their directories over yourself, then run Rescan to
            update the paths.
          </p>
        )}

        {baseFolder && loose && loose.length > 0 && (
          <Callout tone="info" className="mt-4" title={`${loose.length} meeting(s) aren't in the base folder yet`}>
            <p>They can be moved into Unsorted (or their folder) together with their recordings.</p>
            <Button size="sm" className="mt-2" icon={FolderInput} onClick={() => setMigrateOpen(true)}>
              Move them…
            </Button>
          </Callout>
        )}
      </Card>

      {baseFolder && (
        <Card title="Rescan" description="Reads every meeting.json under the base folder and adds meetings the app doesn't know yet (e.g. after reinstalling or copying folders from another computer).">
          <div className="flex items-center gap-3">
            <Button icon={FolderSearch} loading={!!scanning} onClick={rescan}>
              Rescan base folder
            </Button>
            {scanning && <span className="text-[13px] text-muted">{scanning}</span>}
          </div>
          {scan && (
            <Callout tone={scan.failed.length ? 'warn' : 'success'} className="mt-4" title="Rescan finished">
              <p>
                {scan.imported} added, {scan.updated} updated from newer files, {scan.relocated} with new locations, {scan.skipped} already up to date.
              </p>
              {scan.failed.map((f) => (
                <p key={f.path} className="break-words">
                  <span className="font-mono text-xs">{f.path}</span>: {f.error}
                </p>
              ))}
            </Callout>
          )}
        </Card>
      )}

      <Card title="Folder AI">
        <SettingRow
          title="Preselect folder updates after a recording"
          description="Start with the folder summary, action items and extraction tables switched on in the Recording saved dialog. They never run unless you press Start there or update them from the folder."
        >
          <Switch checked={folderAiPreselect} onChange={(v) => saveSettings({ folderAiPreselect: v })} label="Preselect folder updates after a recording" />
        </SettingRow>
      </Card>

      <MigrateModal
        open={migrateOpen}
        meetings={loose ?? []}
        onClose={() => {
          setMigrateOpen(false);
          loadLoose();
        }}
      />
    </>
  );
}

// Moves meetings without a directory into the base folder, one at a time.
function MigrateModal({ open, meetings, onClose }: { open: boolean; meetings: Meeting[]; onClose: () => void }) {
  const [state, setState] = useState<'idle' | 'running' | 'done'>('idle');
  const [current, setCurrent] = useState<{ index: number; title: string; pct: number | null } | null>(null);
  const [failed, setFailed] = useState<{ title: string; error: string }[]>([]);
  const [moved, setMoved] = useState(0);

  useEffect(() => {
    if (open) {
      setState('idle');
      setFailed([]);
      setMoved(0);
      setCurrent(null);
    }
  }, [open]);

  const run = async () => {
    setState('running');
    const list = [...meetings];
    for (const [index, m] of list.entries()) {
      setCurrent({ index, title: m.title, pct: null });
      try {
        await adoptMeeting(m.id, (p) => p.total > 1 && setCurrent({ index, title: m.title, pct: Math.round((p.done / p.total) * 100) }));
        setMoved((n) => n + 1);
      } catch (err) {
        setFailed((f) => [...f, { title: m.title, error: errorMessage(err) }]);
      }
    }
    setState('done');
  };

  return (
    <Modal
      open={open}
      onClose={state === 'running' ? () => {} : onClose}
      title="Move existing meetings"
      footer={
        state === 'idle' ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Not now
            </Button>
            <Button variant="primary" icon={FolderInput} onClick={run} disabled={!meetings.length}>
              Move {meetings.length} meeting(s)
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={onClose} disabled={state === 'running'}>
            Close
          </Button>
        )
      }
    >
      {state === 'idle' && (
        <p className="text-sm text-muted">
          Each meeting gets a directory under <span className="font-medium text-text">Unsorted</span> (or its folder), named by date and title,
          and its recording is moved there. Recordings on another drive are copied and then deleted, which can take a while.
        </p>
      )}
      {state !== 'idle' && (
        <div className="space-y-3 text-sm">
          {state === 'running' && current && (
            <div className="flex items-center gap-2">
              <Spinner />
              <span className="min-w-0 truncate">
                {current.index + 1} of {meetings.length}: {current.title}
                {current.pct != null && ` (${current.pct}%)`}
              </span>
            </div>
          )}
          {state === 'done' && (
            <Callout tone={failed.length ? 'warn' : 'success'} title={`${moved} meeting(s) moved`}>
              {failed.length > 0 && <p>{failed.length} couldn't be moved and stay where they are.</p>}
            </Callout>
          )}
          {failed.map((f, i) => (
            <p key={i} className="break-words text-[13px] text-danger">
              {f.title}: {f.error}
            </p>
          ))}
        </div>
      )}
    </Modal>
  );
}
