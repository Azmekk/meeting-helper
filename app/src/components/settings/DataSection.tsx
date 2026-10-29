import { appDataDir } from '@tauri-apps/api/path';
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import { FolderOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, Card, Spinner, errorMessage, toast } from '../ui';

export function DataSection() {
  const [dir, setDir] = useState<string | null>(null);

  useEffect(() => {
    appDataDir()
      .then(setDir)
      .catch((err) => toast(`Couldn't find the data folder: ${errorMessage(err)}`, 'error'));
  }, []);

  async function openFolder() {
    if (!dir) return;
    try {
      await openPath(dir);
    } catch {
      // openPath may be outside the opener scope; revealing in Explorer is the fallback.
      try {
        await revealItemInDir(dir);
      } catch (err) {
        toast(`Couldn't open the folder: ${errorMessage(err)}`, 'error');
      }
    }
  }

  return (
    <Card
      title="Data"
      description="Your meetings database and settings live here. Recordings stay where OBS saved them or where you imported them from."
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1 truncate rounded-lg bg-sunken px-3 py-2 font-mono text-[12.5px]" title={dir ?? ''}>
          {dir ?? <Spinner size={13} />}
        </div>
        <Button icon={FolderOpen} onClick={openFolder} disabled={!dir}>
          Open folder
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted">API keys aren't stored here. They're in Windows Credential Manager.</p>
    </Card>
  );
}
