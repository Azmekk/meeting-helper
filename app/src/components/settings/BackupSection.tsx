// Settings → Backup: S3/R2 bucket settings and keys, back up now / auto backup,
// restore from the bucket, and zip export/import.
import { open, save } from '@tauri-apps/plugin-dialog';
import { CloudDownload, CloudUpload, Download, FileArchive, FlaskConical, FolderUp, RefreshCw, Save } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Badge, Button, Callout, Card, Field, Input, Modal, SettingRow, Spinner, Switch, clsx, errorMessage, toast } from '../ui';
import { CommitInput, saveSettings } from './common';
import {
  backupNow,
  downloadAllMedia,
  exportZip,
  formatBytes,
  importZip,
  listRemote,
  loadS3Config,
  remotePrefix,
  restoreFromCloud,
  useBackup,
  type BackupResult,
  type RemoteListing,
  type ZipSelection,
} from '../../lib/backup';
import * as db from '../../lib/db';
import * as native from '../../lib/native';
import { KEY_STORE } from '../../lib/platform';
import { deleteSecret, getSecret, setSecret, type SecretName } from '../../lib/secrets';
import { useSettings, type Settings } from '../../lib/settings';
import type { Folder, Meeting } from '../../lib/types';

type Failure = { title: string; error: string };

function Failures({ items }: { items: Failure[] }) {
  if (!items.length) return null;
  return (
    <>
      {items.map((f, i) => (
        <p key={i} className="break-words">
          <span className="font-medium text-text">{f.title}</span>: {f.error}
        </p>
      ))}
    </>
  );
}

function ProgressBar({ message, fraction }: { message: string; fraction: number | null }) {
  return (
    <div className="mt-3 space-y-1.5">
      <div className="truncate text-[13px] text-muted" title={message}>
        {message}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-sunken">
        <div
          className={clsx('h-full rounded-full bg-accent transition-[width]', fraction == null && 'w-1/3 animate-pulse')}
          style={fraction != null ? { width: `${Math.round(fraction * 100)}%` } : undefined}
        />
      </div>
    </div>
  );
}

// Access key fields: stored in the OS keyring, never in settings.json.
function SecretInput({ name, label, onChange }: { name: SecretName; label: string; onChange: () => void }) {
  const [saved, setSaved] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  useEffect(() => {
    getSecret(name)
      .then((v) => {
        setSaved(v);
        setDraft(v ?? '');
      })
      .catch(() => {});
  }, [name]);
  const dirty = draft.trim() !== (saved ?? '');
  const store = async () => {
    try {
      if (draft.trim()) await setSecret(name, draft.trim());
      else await deleteSecret(name);
      setSaved(draft.trim() || null);
      onChange();
      toast(`${label} saved`, 'success');
    } catch (err) {
      toast(`Couldn't save: ${errorMessage(err)}`, 'error');
    }
  };
  return (
    <Field label={label} hint={saved ? `Saved in ${KEY_STORE}.` : undefined}>
      <div className="flex gap-2">
        <Input type="password" value={draft} onChange={(e) => setDraft(e.target.value)} autoComplete="off" spellCheck={false} />
        {dirty && (
          <Button icon={Save} onClick={store}>
            Save
          </Button>
        )}
      </div>
    </Field>
  );
}

export function BackupSection() {
  const s = useSettings((st) => st.settings);
  const running = useBackup((st) => st.running);
  const progress = useBackup((st) => st.progress);
  const [testing, setTesting] = useState(false);
  const [testOk, setTestOk] = useState<boolean | null>(null);
  const [lastResult, setLastResult] = useState<BackupResult | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'warn' | 'error'; title: string; body?: ReactNode } | null>(null);

  // Another bucket or prefix means nothing there is backed up yet.
  const saveTarget = async (patch: Partial<Settings>) => {
    const key = Object.keys(patch)[0] as keyof Settings;
    if (patch[key] === s[key]) return;
    await saveSettings(patch);
    setTestOk(null);
    if (key !== 'backupRegion' && key !== 'backupPathStyle') await db.clearBackupState().catch(() => {});
  };

  const test = async () => {
    setTesting(true);
    setTestOk(null);
    try {
      await native.s3Test(await loadS3Config(), remotePrefix());
      setTestOk(true);
      toast('Connected: the bucket can be read and written.', 'success');
    } catch (err) {
      setTestOk(false);
      setMessage({ tone: 'error', title: 'Connection failed', body: errorMessage(err) });
    } finally {
      setTesting(false);
    }
  };

  const runBackup = async () => {
    setMessage(null);
    try {
      const res = await backupNow();
      setLastResult(res);
      setMessage(
        res.failed.length
          ? { tone: 'warn', title: 'Backup finished with problems', body: <Failures items={res.failed} /> }
          : { tone: 'success', title: 'Backup finished', body: `${res.meetings} meeting(s), ${res.folders} folder(s), ${formatBytes(res.bytes)} of media uploaded.` },
      );
    } catch (err) {
      setMessage({ tone: 'error', title: 'Backup failed', body: errorMessage(err) });
    }
  };

  const downloadAll = async () => {
    setMessage(null);
    try {
      const res = await downloadAllMedia();
      setMessage({
        tone: res.failed.length ? 'warn' : 'success',
        title: `${res.downloaded} recording(s) downloaded`,
        body: <Failures items={res.failed} />,
      });
    } catch (err) {
      setMessage({ tone: 'error', title: 'Download failed', body: errorMessage(err) });
    }
  };

  const runImportZip = async () => {
    const picked = await open({ multiple: false, title: 'Import meetings from a zip', filters: [{ name: 'Zip', extensions: ['zip'] }] });
    if (!picked || typeof picked !== 'string') return;
    setMessage(null);
    try {
      const res = await importZip(picked);
      setMessage({
        tone: res.failed.length ? 'warn' : 'success',
        title: 'Zip imported',
        body: (
          <>
            <p>
              {res.imported} added, {res.updated} updated, {res.skipped} already up to date, {res.folders} folder(s) restored.
            </p>
            <Failures items={res.failed} />
          </>
        ),
      });
    } catch (err) {
      setMessage({ tone: 'error', title: 'Import failed', body: errorMessage(err) });
    }
  };

  const configured = !!(s.backupEndpoint.trim() && s.backupBucket.trim());

  return (
    <>
      <Card title="Cloud backup" description="Any S3-compatible storage: Cloudflare R2, AWS S3, Backblaze B2, MinIO…">
        <div className="space-y-3">
          <Callout tone="warn" title="The bucket holds your recordings and transcripts">
            Keep it private (no public access, no public URL) and use a key that can only reach this bucket.
          </Callout>
          <Callout tone="info">
            This is a backup for one computer at a time, not two-way sync. Meetings deleted here stay in the bucket; a restore adds and updates
            meetings but never deletes any.
          </Callout>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Endpoint" hint="R2: https://<account id>.r2.cloudflarestorage.com" className="sm:col-span-2">
            <CommitInput value={s.backupEndpoint} onCommit={(v) => saveTarget({ backupEndpoint: v.trim() })} placeholder="https://…" spellCheck={false} />
          </Field>
          <Field label="Bucket">
            <CommitInput value={s.backupBucket} onCommit={(v) => saveTarget({ backupBucket: v.trim() })} spellCheck={false} />
          </Field>
          <Field label="Region" hint="'auto' for R2, e.g. eu-central-1 for AWS.">
            <CommitInput value={s.backupRegion} onCommit={(v) => saveTarget({ backupRegion: v.trim() || 'auto' })} spellCheck={false} />
          </Field>
          <Field label="Folder in the bucket" hint="Lets several apps or computers share one bucket." className="sm:col-span-2">
            <CommitInput value={s.backupPrefix} onCommit={(v) => saveTarget({ backupPrefix: v.trim() })} placeholder="meeting-helper" spellCheck={false} />
          </Field>
          <SecretInput name="s3_access_key_id" label="Access key ID" onChange={() => setTestOk(null)} />
          <SecretInput name="s3_secret_access_key" label="Secret access key" onChange={() => setTestOk(null)} />
        </div>
        <SettingRow title="Path-style URLs" description="Needed by MinIO and most self-hosted servers (endpoint/bucket/key instead of bucket.endpoint/key).">
          <Switch checked={s.backupPathStyle} onChange={(v) => saveTarget({ backupPathStyle: v })} label="Path-style URLs" />
        </SettingRow>
        <div className="flex items-center gap-3">
          <Button icon={FlaskConical} loading={testing} disabled={!configured} onClick={test}>
            Test connection
          </Button>
          {testOk === true && <Badge tone="ok">Connected</Badge>}
          {testOk === false && <Badge tone="danger">Failed</Badge>}
        </div>
      </Card>

      <Card title="Back up">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" icon={CloudUpload} loading={running === 'backup'} disabled={!configured || (!!running && running !== 'backup')} onClick={runBackup}>
            Back up now
          </Button>
          <span className="text-[13px] text-muted">
            {s.backupLastAt ? `Last backup ${new Date(s.backupLastAt).toLocaleString()}: ${s.backupLastSummary}.` : 'Not backed up yet.'}
          </span>
        </div>
        {running === 'backup' && progress && <ProgressBar {...progress} />}
        {lastResult && running !== 'backup' && lastResult.bytes > 0 && (
          <p className="mt-2 text-xs text-muted">{lastResult.files} media file(s) uploaded in the last run.</p>
        )}
        <div className="mt-3 border-t border-line">
          <SettingRow
            title="Back up automatically"
            description="About a minute after a meeting is ready or edited. Never while recording or transcribing. Only changed meetings and recordings are uploaded."
          >
            <Switch checked={s.backupAuto} onChange={(v) => saveSettings({ backupAuto: v })} label="Back up automatically" />
          </SettingRow>
        </div>
      </Card>

      <Card title="Restore" description="Meetings and folders come back right away; recordings download when you open a meeting, or all at once.">
        <div className="flex flex-wrap gap-2">
          <Button icon={CloudDownload} disabled={!configured || !!running} onClick={() => setRestoreOpen(true)}>
            Restore from cloud…
          </Button>
          <Button icon={Download} disabled={!configured || !!running} onClick={downloadAll}>
            Download all recordings
          </Button>
        </div>
        {(running === 'restore' || (!running && progress)) && progress && <ProgressBar {...progress} />}
      </Card>

      <Card title="Zip" description="A single file with meetings, folders and recordings, e.g. to move to another computer without a bucket.">
        <div className="flex flex-wrap gap-2">
          <Button icon={FileArchive} disabled={!!running} onClick={() => setExportOpen(true)}>
            Export zip…
          </Button>
          <Button icon={FolderUp} disabled={!!running} loading={running === 'zip' && !exportOpen} onClick={runImportZip}>
            Import zip…
          </Button>
        </div>
        {running === 'zip' && !exportOpen && progress && <ProgressBar {...progress} />}
      </Card>

      {message && (
        <Callout tone={message.tone} title={message.title}>
          {message.body}
        </Callout>
      )}

      <RestoreModal open={restoreOpen} onClose={() => setRestoreOpen(false)} onDone={setMessage} />
      <ExportModal open={exportOpen} onClose={() => setExportOpen(false)} onDone={setMessage} />
    </>
  );
}

type Done = (m: { tone: 'success' | 'warn' | 'error'; title: string; body?: ReactNode }) => void;

function RestoreModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: Done }) {
  const [listing, setListing] = useState<RemoteListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const progress = useBackup((st) => st.progress);

  const load = async () => {
    setListing(null);
    setError(null);
    try {
      const l = await listRemote();
      setListing(l);
      // Preselect what's missing or newer in the bucket.
      setSelected(new Set(l.meetings.filter((m) => m.local === 'missing' || m.local === 'older').map((m) => m.uid)));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  useEffect(() => {
    if (open) void load();
  }, [open]);

  const restore = async () => {
    if (!listing) return;
    setBusy(true);
    try {
      const all = selected.size === listing.meetings.length;
      const res = await restoreFromCloud(listing, all ? 'all' : [...selected]);
      onDone({
        tone: res.failed.length ? 'warn' : 'success',
        title: 'Restore finished',
        body: (
          <>
            <p>
              {res.imported} added, {res.updated} updated, {res.skipped} already up to date, {res.folders} folder(s) restored. Recordings
              download when you open a meeting.
            </p>
            <Failures items={res.failed} />
          </>
        ),
      });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (uid: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      next.has(uid) ? next.delete(uid) : next.add(uid);
      return next;
    });
  const LOCAL_LABEL = { missing: 'Not here', older: 'Older here', same: 'Up to date', newer: 'Newer here' } as const;
  const size = listing?.meetings.filter((m) => selected.has(m.uid)).reduce((n, m) => n + m.mediaSize, 0) ?? 0;

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title="Restore from cloud"
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" icon={RefreshCw} onClick={load} disabled={busy}>
            Reload
          </Button>
          <Button variant="primary" icon={CloudDownload} loading={busy} disabled={!selected.size} onClick={restore}>
            Restore {selected.size} meeting(s)
          </Button>
        </>
      }
    >
      {error && (
        <Callout tone="error" title="Couldn't read the bucket">
          {error}
        </Callout>
      )}
      {!listing && !error && (
        <div className="flex justify-center py-8">
          <Spinner size={20} />
        </div>
      )}
      {listing && !listing.meetings.length && <p className="text-sm text-muted">The bucket has no meetings under this folder yet.</p>}
      {listing && listing.meetings.length > 0 && (
        <>
          <div className="mb-2 flex items-center justify-between text-[13px] text-muted">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                className="accent-[var(--c-accent)]"
                checked={selected.size === listing.meetings.length}
                onChange={(e) => setSelected(new Set(e.target.checked ? listing.meetings.map((m) => m.uid) : []))}
              />
              Select all ({listing.meetings.length})
            </label>
            <span>Recordings to download later: {formatBytes(size)}</span>
          </div>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {listing.meetings.map((m) => (
              <li key={m.uid}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-hover">
                  <input type="checkbox" className="accent-[var(--c-accent)]" checked={selected.has(m.uid)} onChange={() => toggle(m.uid)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{m.title}</span>
                    <span className="block truncate text-xs text-muted">
                      {new Date(m.createdAt).toLocaleString()}
                      {m.folderName ? ` · ${m.folderName}` : ''}
                      {m.mediaSize ? ` · ${formatBytes(m.mediaSize)}` : ' · no recording'}
                    </span>
                  </span>
                  <Badge tone={m.local === 'missing' ? 'accent' : m.local === 'older' ? 'warn' : 'neutral'}>{LOCAL_LABEL[m.local]}</Badge>
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
      {busy && progress && <ProgressBar {...progress} />}
    </Modal>
  );
}

function ExportModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: Done }) {
  const [mode, setMode] = useState<'all' | 'folders' | 'meetings'>('all');
  const [folders, setFolders] = useState<Folder[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const progress = useBackup((st) => st.progress);

  useEffect(() => {
    if (!open) return;
    setPicked(new Set());
    void Promise.all([db.listFolders(), db.listMeetings()]).then(([f, m]) => {
      setFolders(f);
      setMeetings(m.filter((x) => x.status !== 'recording'));
    });
  }, [open]);

  useEffect(() => setPicked(new Set()), [mode]);

  const run = async () => {
    const stamp = new Date().toISOString().slice(0, 10);
    const out = await save({ title: 'Export meetings', defaultPath: `meeting-helper-${stamp}.zip`, filters: [{ name: 'Zip', extensions: ['zip'] }] });
    if (!out) return;
    const sel: ZipSelection =
      mode === 'all'
        ? { meetingIds: 'all', folderIds: 'all' }
        : mode === 'folders'
          ? { meetingIds: [], folderIds: [...picked] }
          : { meetingIds: [...picked], folderIds: [] };
    setBusy(true);
    try {
      const res = await exportZip(sel, out);
      onDone({ tone: 'success', title: 'Zip exported', body: `${res.meetings} meeting(s) and ${res.folders} folder(s) saved to ${out}.` });
      onClose();
    } catch (err) {
      onDone({ tone: 'error', title: 'Export failed', body: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const items = mode === 'folders' ? folders.map((f) => ({ id: f.id, label: f.name })) : meetings.map((m) => ({ id: m.id, label: m.title }));
  const toggle = (id: number) =>
    setPicked((cur) => {
      const next = new Set(cur);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title="Export zip"
      footer={
        <Button variant="primary" icon={FileArchive} loading={busy} disabled={mode !== 'all' && !picked.size} onClick={run}>
          Export…
        </Button>
      }
    >
      <div className="space-y-2 text-sm">
        {(
          [
            ['all', `Everything (${meetings.length} meetings, ${folders.length} folders)`],
            ['folders', 'Chosen folders, with all their meetings'],
            ['meetings', 'Chosen meetings (and their folders)'],
          ] as const
        ).map(([id, label]) => (
          <label key={id} className="flex cursor-pointer items-center gap-2">
            <input type="radio" name="zip-mode" className="accent-[var(--c-accent)]" checked={mode === id} onChange={() => setMode(id)} />
            {label}
          </label>
        ))}
      </div>
      {mode !== 'all' && (
        <ul className="mt-3 max-h-72 divide-y divide-line overflow-y-auto rounded-lg border border-line">
          {items.length === 0 && <li className="px-3 py-2 text-[13px] text-muted">Nothing to choose from.</li>}
          {items.map((it) => (
            <li key={it.id}>
              <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-hover">
                <input type="checkbox" className="accent-[var(--c-accent)]" checked={picked.has(it.id)} onChange={() => toggle(it.id)} />
                <span className="truncate">{it.label}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-muted">Recordings are included, so the zip can be large.</p>
      {busy && progress && <ProgressBar {...progress} />}
    </Modal>
  );
}
