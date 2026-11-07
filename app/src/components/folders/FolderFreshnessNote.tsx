// Shown above a folder's tabs when its summary, tasks or extraction tables don't
// include its newest meetings. Folder AI only runs when asked, so this is how
// the user sees what's behind and brings it up to date.
import { RefreshCw } from 'lucide-react';
import { Fragment, useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AiModelSelect, useAiModel } from '../ai/AiModelSelect';
import { costLabel } from '../live/shared';
import { useAiKey } from '../meeting/AiPanels';
import { Button, Card } from '../ui';
import {
  STEP_OUTPUT_TOKENS,
  catchUpExtraction,
  catchUpFolder,
  catchUpFolderSummary,
  catchUpTasks,
  folderSummaryCost,
  getFolderFreshness,
  transcriptStepCost,
  useFolderAi,
  type FolderFreshness,
} from '../../lib/ai/folder';
import { onMeetingSummarized } from '../../lib/ai/meeting';
import { formatDate } from '../../lib/format';
import type { Folder, Meeting } from '../../lib/types';

const SHOWN_NAMES = 3;

function MeetingName({ meeting }: { meeting: Meeting }) {
  return (
    <Link to={`/meetings/${meeting.id}`} className="font-medium text-text hover:text-accent hover:underline">
      {meeting.title || 'Untitled meeting'}
    </Link>
  );
}

function MeetingNames({ meetings }: { meetings: Meeting[] }) {
  const more = meetings.length - SHOWN_NAMES;
  return (
    <>
      {meetings.slice(0, SHOWN_NAMES).map((m, i) => (
        <Fragment key={m.id}>
          {i > 0 && ', '}
          <MeetingName meeting={m} />
        </Fragment>
      ))}
      {more > 0 && ` and ${more} more`}
    </>
  );
}

function lastIncluded(last: Meeting | null): ReactNode {
  return last ? (
    <>
      Last updated from <MeetingName meeting={last} /> ({formatDate(last.createdAt)}).{' '}
    </>
  ) : (
    'Not updated from any meeting yet. '
  );
}

// Every meeting pays for its own transcript; a later step on the same meeting may
// read it cached, so this is the most it should cost.
function transcriptCost(model: string, meetings: Meeting[], output: number): number | null {
  let total = 0;
  for (const m of meetings) {
    const cost = transcriptStepCost(model, m.durationMs, output, false);
    if (cost == null) return null;
    total += cost;
  }
  return total;
}

function updateLabel(meetings: Meeting[]): string {
  return meetings.length === 1 ? 'Update' : `Update from ${meetings.length} meetings`;
}

export function FolderFreshnessNote({ folder, meetings }: { folder: Folder; meetings: Meeting[] | null }) {
  const hasKey = useAiKey();
  const [model, setModel] = useAiModel('background', 'folder-catch-up');
  const busy = useFolderAi((s) => s.busy[folder.id]);
  const updates = useFolderAi((s) => s.updates[folder.id] ?? 0);
  const taskChanges = useFolderAi((s) => s.tasks[folder.id] ?? 0);
  const [fresh, setFresh] = useState<FolderFreshness | null>(null);

  const load = useCallback(() => {
    void getFolderFreshness(folder.id)
      .then(setFresh)
      .catch((err) => console.warn('Could not check the folder', err));
  }, [folder.id]);

  useEffect(load, [load, meetings, busy, updates, taskChanges]);
  useEffect(() => onMeetingSummarized(load), [load]);
  useEffect(() => {
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, [load]);

  if (!fresh || !meetings?.length) return null;
  const { summary, tasks, extraction } = fresh;
  const behindTables = extraction.filter((e) => e.pending.length);
  const summaryRuns = summary.pending.length > 0 || summary.changed.length > 0;
  const showSummary = summaryRuns || summary.unsummarized.length > 0;
  const actions = (summaryRuns ? 1 : 0) + (tasks.pending.length ? 1 : 0) + behindTables.length;
  if (!showSummary && !tasks.pending.length && !behindTables.length) return null;
  const disabled = !hasKey || !!busy;

  return (
    <Card
      className="mb-5"
      padded={false}
      title="Not up to date with the latest meeting"
      description={busy ?? 'These only update when you ask, so nothing here has been spent yet.'}
      actions={
        <>
          <AiModelSelect value={model} onChange={setModel} disabled={!!busy} className="h-7" />
          {actions > 1 && (
            <Button size="sm" icon={RefreshCw} disabled={disabled} onClick={() => void catchUpFolder(folder.id, fresh, model)}>
              Update all
            </Button>
          )}
        </>
      }
    >
      <ul className="divide-y divide-line">
        {showSummary && (
          <Row
            title="Folder summary"
            action={summaryRuns ? 'Update' : undefined}
            cost={folderSummaryCost()}
            disabled={disabled}
            onRun={() => void catchUpFolderSummary(folder.id)}
          >
            {lastIncluded(summary.last)}
            {summary.pending.length > 0 && (
              <>
                Not included: <MeetingNames meetings={summary.pending} />.{' '}
              </>
            )}
            {summary.changed.length > 0 && (
              <>
                Summary redone since: <MeetingNames meetings={summary.changed} />.{' '}
              </>
            )}
            {summary.unsummarized.length > 0 && (
              <>
                Needs a meeting summary first: <MeetingNames meetings={summary.unsummarized} />.
              </>
            )}
          </Row>
        )}
        {tasks.pending.length > 0 && (
          <Row
            title="Tasks"
            action={updateLabel(tasks.pending)}
            cost={transcriptCost(model, tasks.pending, STEP_OUTPUT_TOKENS.tasks)}
            disabled={disabled}
            onRun={() => void catchUpTasks(folder.id, tasks.pending, model)}
          >
            {lastIncluded(tasks.last)}
            Not included: <MeetingNames meetings={tasks.pending} />.
          </Row>
        )}
        {behindTables.map((e) => (
          <Row
            key={e.template.id}
            title={`Extract: ${e.template.name}`}
            action={updateLabel(e.pending)}
            cost={transcriptCost(model, e.pending, STEP_OUTPUT_TOKENS.extraction)}
            disabled={disabled}
            onRun={() => void catchUpExtraction(folder.id, e.template, e.pending, model)}
          >
            {lastIncluded(e.last)}
            Not filled in: <MeetingNames meetings={e.pending} />.
          </Row>
        ))}
      </ul>
    </Card>
  );
}

function Row({
  title,
  action,
  cost,
  disabled,
  onRun,
  children,
}: {
  title: string;
  action?: string;
  cost: number | null;
  disabled: boolean;
  onRun: () => void;
  children: ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
      <div className="min-w-0 flex-1 basis-64 text-[13px]">
        <div className="font-medium">{title}</div>
        <p className="text-muted">{children}</p>
      </div>
      {action && (
        <Button size="sm" variant="secondary" disabled={disabled} onClick={onRun} title="Estimate. It's less when a transcript is already cached.">
          {action} ({costLabel(cost)})
        </Button>
      )}
    </li>
  );
}
