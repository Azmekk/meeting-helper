// Shown on a meeting whose recording isn't on this computer but is in the
// cloud backup (e.g. after a restore): downloads it on request.
import { CloudDownload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { downloadMedia, formatBytes, remoteMediaFor, useBackup } from '../../lib/backup';
import type { Meeting } from '../../lib/types';
import { Button, Callout, errorMessage, toast } from '../ui';

export function CloudMediaBanner({ meeting }: { meeting: Meeting }) {
  const [size, setSize] = useState<number | null>(null);
  const progress = useBackup((s) => s.downloads[meeting.id]);

  useEffect(() => {
    let alive = true;
    remoteMediaFor(meeting)
      .then((r) => alive && setSize(r ? r.size : null))
      .catch(() => alive && setSize(null));
    return () => {
      alive = false;
    };
  }, [meeting]);

  if (size == null && !progress) return null;

  const download = async () => {
    try {
      await downloadMedia(meeting.id);
    } catch (err) {
      toast(`Download failed: ${errorMessage(err)}`, 'error');
    }
  };

  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : null;
  return (
    <Callout tone="info" title="The recording is in your cloud backup">
      {progress ? (
        <div className="space-y-1.5">
          <p>
            Downloading… {formatBytes(progress.done)} of {formatBytes(progress.total)}
          </p>
          <div className="h-1.5 overflow-hidden rounded-full bg-sunken">
            <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${pct ?? 0}%` }} />
          </div>
        </div>
      ) : (
        <Button size="sm" className="mt-1" icon={CloudDownload} onClick={download}>
          Download recording ({formatBytes(size ?? 0)})
        </Button>
      )}
    </Callout>
  );
}
