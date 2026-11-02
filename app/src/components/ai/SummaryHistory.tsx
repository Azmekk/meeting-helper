// History of a meeting's or folder's summaries: pick which one to read, delete
// the ones you don't want. The newest is what the rest of the AI features use.
import { Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as db from '../../lib/db';
import { formatDate } from '../../lib/format';
import type { AiDoc, AiDocKind, AiScope } from '../../lib/types';
import { Button, IconButton, Modal, Select, errorMessage, toast } from '../ui';

export function useSummaryHistory(scope: AiScope, ownerId: number, kind: AiDocKind) {
  const [docs, setDocs] = useState<AiDoc[] | undefined>(undefined);
  const [selected, setSelected] = useState<number | null>(null); // null = the newest
  const [loadError, setLoadError] = useState<string | null>(null);
  const request = useRef(0);

  const reload = useCallback(async () => {
    const id = ++request.current;
    try {
      const list = await db.listAiDocs(scope, ownerId, kind);
      if (id === request.current) setDocs(list);
    } catch (err) {
      if (id !== request.current) return;
      setDocs([]);
      setLoadError(errorMessage(err));
    }
  }, [scope, ownerId, kind]);

  useEffect(() => {
    setDocs(undefined);
    setSelected(null);
    void reload();
  }, [reload]);

  const showNewest = useCallback(() => setSelected(null), []);
  const doc = docs && (docs.find((d) => d.id === selected) ?? docs[0] ?? null);
  return { docs, doc, select: setSelected, showNewest, reload, loadError };
}

// The picker (once there's more than one) and the delete button, for a card's title.
export function SummaryHistoryControls({
  docs,
  doc,
  onSelect,
  onDeleted,
}: {
  docs: AiDoc[];
  doc: AiDoc;
  onSelect: (id: number) => void;
  onDeleted: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  const remove = async () => {
    try {
      await db.deleteAiDocVersion(doc);
      setConfirming(false);
      onDeleted();
    } catch (err) {
      toast(`Couldn't delete the summary: ${errorMessage(err)}`, 'error');
    }
  };

  return (
    <>
      {docs.length > 1 && (
        <Select aria-label="Summary version" value={doc.id} onChange={(e) => onSelect(Number(e.target.value))} className="h-8 w-auto max-w-full min-w-0 text-[13px] font-normal">
          {docs.map((d, i) => (
            <option key={d.id} value={d.id}>
              {i === 0 ? 'Latest · ' : ''}
              {formatDate(d.createdAt)} · {d.model ?? 'Unknown model'}
            </option>
          ))}
        </Select>
      )}
      <IconButton icon={Trash2} label="Delete this summary" onClick={() => setConfirming(true)} className="hover:text-danger" />
      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Delete this summary?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="danger" icon={Trash2} onClick={() => void remove()}>
              Delete
            </Button>
          </>
        }
      >
        <p className="text-sm font-normal text-muted">
          The summary from {formatDate(doc.createdAt)} by {doc.model ?? 'an unknown model'} will be deleted.
          {docs.length > 1 ? ' Your other summaries stay.' : ''}
        </p>
      </Modal>
    </>
  );
}
