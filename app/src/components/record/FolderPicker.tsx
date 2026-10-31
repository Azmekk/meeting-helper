import { Folder } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { createFolderWithDir, refreshFolders, useFolders } from '../../lib/folders';
import { setRecordingFolder, useRecorder } from '../../lib/obs';
import { useSettings } from '../../lib/settings';
import { Button, Input, Select, errorMessage, toast } from '../ui';

const NEW = '__new';

// Which folder the recording goes into. Editable until the recording stops;
// a change during recording moves the files once it stops.
export default function FolderPicker() {
  const base = useSettings((s) => s.settings.baseFolder.trim());
  const folders = useFolders((s) => s.folders);
  const folderId = useRecorder((s) => s.folderId);
  const busy = useRecorder((s) => s.busy);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void refreshFolders().catch(() => {});
  }, []);

  if (!base) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted">
        <Folder size={13} className="shrink-0" />
        <span>
          To file recordings into folders, choose a base folder in{' '}
          <Link to="/settings?tab=folders" className="text-accent hover:underline">
            Settings → Folders
          </Link>
          .
        </span>
      </p>
    );
  }

  async function choose(id: number | null) {
    try {
      await setRecordingFolder(id);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  async function create() {
    const clean = name.trim();
    if (!clean) return;
    setSaving(true);
    try {
      const folder = await createFolderWithDir(clean);
      setCreating(false);
      setName('');
      await choose(folder.id);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setSaving(false);
    }
  }

  if (creating) {
    return (
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setCreating(false)}
          placeholder="Folder name"
          aria-label="New folder name"
          className="min-w-0 flex-1"
        />
        <Button type="submit" size="sm" variant="primary" loading={saving} disabled={!name.trim()}>
          Create
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setCreating(false)}>
          Cancel
        </Button>
      </form>
    );
  }

  // A folder deleted elsewhere counts as Unsorted.
  const value = folderId != null && folders.some((f) => f.id === folderId) ? String(folderId) : '';

  return (
    <label className="flex items-center gap-2">
      <Folder size={15} className="shrink-0 text-muted" />
      <span className="sr-only">Folder</span>
      <Select
        value={value}
        disabled={busy !== null}
        onChange={(e) => {
          const v = e.target.value;
          if (v === NEW) setCreating(true);
          else void choose(v ? Number(v) : null);
        }}
        className="min-w-0 flex-1"
      >
        <option value="">Unsorted</option>
        {folders.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
        <option value={NEW}>New folder…</option>
      </Select>
    </label>
  );
}
