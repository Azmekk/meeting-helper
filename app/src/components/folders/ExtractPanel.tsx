// Custom extraction: the user defines fields, the AI fills them per meeting
// (structured output), results show as a table with CSV export.
import { AiLanguageSelect } from '../ai/AiLanguageSelect';
import { AiModelSelect, useAiModel } from '../ai/AiModelSelect';
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { Download, Pencil, Play, Plus, Square, Table2, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Callout, Card, EmptyState, IconButton, Input, Modal, Select, Spinner, clsx, errorMessage, toast } from '../ui';
import { useAbortable, useAiKey } from '../meeting/AiPanels';
import * as db from '../../lib/db';
import { runExtraction, runInFolderQueue, useFolderAi } from '../../lib/ai/folder';
import { safeFileName } from '../../lib/export';
import { formatDate, formatUsd } from '../../lib/format';
import type { ExtractionField, ExtractionRow, ExtractionTemplate, Folder, Meeting } from '../../lib/types';

function csvCell(v: string): string {
  return /[",\n\r;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function toCsv(template: ExtractionTemplate, meetings: Meeting[], rows: Map<number, ExtractionRow>): string {
  const header = ['Meeting', 'Date', ...template.fields.map((f) => f.name)];
  const lines = [header.map(csvCell).join(',')];
  for (const m of meetings) {
    const row = rows.get(m.id);
    if (!row) continue;
    lines.push([m.title, m.createdAt.slice(0, 10), ...template.fields.map((f) => row.values[f.name] ?? '')].map(csvCell).join(','));
  }
  // BOM so Excel opens UTF-8 (Cyrillic) correctly.
  return '﻿' + lines.join('\r\n') + '\r\n';
}

export function ExtractPanel({ folder, meetings }: { folder: Folder; meetings: Meeting[] }) {
  const hasKey = useAiKey();
  const [model, setModel] = useAiModel();
  const autoBusy = useFolderAi((s) => s.busy[folder.id]);
  const [templates, setTemplates] = useState<ExtractionTemplate[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [rows, setRows] = useState<ExtractionRow[]>([]);
  const [editing, setEditing] = useState<ExtractionTemplate | 'new' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { start, stop } = useAbortable();

  const loadTemplates = useCallback(async () => {
    try {
      const list = await db.listExtractionTemplates(folder.id);
      setTemplates(list);
      setSelected((cur) => (cur != null && list.some((t) => t.id === cur) ? cur : (list[0]?.id ?? null)));
    } catch (err) {
      setTemplates([]);
      setError(errorMessage(err));
    }
  }, [folder.id]);

  useEffect(() => {
    setTemplates(null);
    setSelected(null);
    loadTemplates();
  }, [loadTemplates]);

  const loadRows = useCallback(() => {
    if (selected == null) return setRows([]);
    db.listExtractionRows(selected)
      .then(setRows)
      .catch((err) => setError(errorMessage(err)));
  }, [selected]);

  useEffect(loadRows, [loadRows]);
  useEffect(() => {
    if (!autoBusy) loadRows();
  }, [autoBusy, loadRows]);

  const template = templates?.find((t) => t.id === selected) ?? null;
  const rowByMeeting = useMemo(() => new Map(rows.map((r) => [r.meetingId, r])), [rows]);
  const withTranscript = meetings.filter((m) => m.activeTranscriptId != null);
  const missing = withTranscript.filter((m) => !rowByMeeting.has(m.id));

  const run = async (targets: Meeting[]) => {
    if (!template || !targets.length) return;
    const signal = start();
    setError(null);
    setProgress({ done: 0, total: targets.length });
    try {
      const res = await runInFolderQueue(folder.id, () =>
        runExtraction(
          template.id,
          targets.map((m) => m.id),
          { signal, model, onStep: (done, total) => setProgress({ done, total }) },
        ),
      );
      loadRows();
      if (res.failed.length) setError(`${res.failed.length} meeting(s) failed: ${res.failed.map((f) => f.error).join(' · ')}`);
      else toast(`Extracted ${res.done} meeting(s) (${formatUsd(res.costUsd)})`, 'success');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setProgress(null);
    }
  };

  const exportCsv = async () => {
    if (!template) return;
    try {
      const path = await save({
        title: 'Export as CSV',
        defaultPath: `${safeFileName(`${folder.name} - ${template.name}`)}.csv`,
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      });
      if (!path) return;
      await writeTextFile(path, toCsv(template, meetings, rowByMeeting));
      toast('CSV saved', 'success');
    } catch (err) {
      toast(`Couldn't save the CSV: ${errorMessage(err)}`, 'error');
    }
  };

  const saveTemplate = async (name: string, fields: ExtractionField[]) => {
    try {
      if (editing && editing !== 'new') await db.updateExtractionTemplate(editing.id, name, fields);
      else setSelected((await db.createExtractionTemplate(folder.id, name, fields)).id);
      setEditing(null);
      await loadTemplates();
    } catch (err) {
      toast(`Couldn't save the template: ${errorMessage(err)}`, 'error');
    }
  };

  const deleteTemplate = async () => {
    if (!template) return;
    try {
      await db.deleteExtractionTemplate(template.id);
      setConfirmDelete(false);
      setSelected(null);
      await loadTemplates();
    } catch (err) {
      toast(`Couldn't delete: ${errorMessage(err)}`, 'error');
    }
  };

  if (templates === null) {
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    );
  }

  const editor = (
    <TemplateEditor
      open={editing !== null}
      template={editing && editing !== 'new' ? editing : null}
      onClose={() => setEditing(null)}
      onSave={saveTemplate}
    />
  );

  if (!templates.length) {
    return (
      <Card>
        <EmptyState
          icon={Table2}
          title="Pull the same facts out of every meeting"
          description="Define fields (e.g. budget, next deadline, client mood) and the AI fills them in for each meeting. New meetings in this folder are filled in automatically."
          action={
            <Button variant="primary" icon={Plus} onClick={() => setEditing('new')}>
              New template
            </Button>
          }
        />
        {editor}
      </Card>
    );
  }

  const busy = progress !== null;

  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          <Select value={selected ?? ''} onChange={(e) => setSelected(Number(e.target.value))} className="h-8 w-auto max-w-xs text-sm font-semibold">
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
          <IconButton icon={Pencil} label="Edit template" onClick={() => template && setEditing(template)} />
          <IconButton icon={Trash2} label="Delete template" onClick={() => setConfirmDelete(true)} className="hover:text-danger" />
          <IconButton icon={Plus} label="New template" onClick={() => setEditing('new')} />
        </span>
      }
      description={
        busy
          ? `Extracting ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`
          : (autoBusy ?? `${rows.length} of ${withTranscript.length} meetings filled in. New meetings are filled in after their summary.`)
      }
      actions={
        busy ? (
          <Button size="sm" icon={Square} onClick={stop}>
            Stop
          </Button>
        ) : (
          <>
            <AiLanguageSelect />
            <AiModelSelect value={model} onChange={setModel} />
            <Button size="sm" icon={Play} disabled={!hasKey || !missing.length || !!autoBusy} onClick={() => run(missing)}>
              Run on new ({missing.length})
            </Button>
            <Button size="sm" variant="ghost" disabled={!hasKey || !withTranscript.length || !!autoBusy} onClick={() => run(withTranscript)}>
              Run on all
            </Button>
            <IconButton icon={Download} label="Export CSV" disabled={!rows.length} onClick={exportCsv} />
          </>
        )
      }
      padded={false}
    >
      {error && (
        <Callout tone="error" className="mx-5 mt-4">
          <p className="break-words">{error}</p>
        </Callout>
      )}
      {template && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead className="border-b border-line bg-sunken/50 text-xs text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Meeting</th>
                {template.fields.map((f) => (
                  <th key={f.name} className="px-4 py-2 font-medium" title={f.description}>
                    {f.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {withTranscript.map((m) => {
                const row = rowByMeeting.get(m.id);
                return (
                  <tr key={m.id} className="align-top">
                    <td className="px-4 py-2 whitespace-nowrap">
                      <Link to={`/meetings/${m.id}`} className="font-medium hover:text-accent hover:underline">
                        {m.title}
                      </Link>
                      <div className="text-xs text-faint">{formatDate(m.createdAt)}</div>
                    </td>
                    {template.fields.map((f) => {
                      const value = row?.values[f.name];
                      return (
                        <td key={f.name} className="max-w-xs px-4 py-2">
                          {row ? value ? <ClampedText text={value} /> : <span className="text-faint">—</span> : <span className="text-faint italic">not run</span>}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!withTranscript.length && <p className="px-5 py-6 text-center text-[13px] text-muted">No meeting in this folder has a transcript yet.</p>}
        </div>
      )}
      {editor}
      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete template?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="danger" icon={Trash2} onClick={deleteTemplate}>
              Delete
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">
          <span className="font-medium text-text">{template?.name}</span> and all values extracted with it will be removed.
        </p>
      </Modal>
    </Card>
  );
}

// A table cell's value: long ones show a few lines with a toggle for the rest.
function ClampedText({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const check = () => setClipped(el.scrollHeight > el.clientHeight + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, open]);

  return (
    <>
      <div ref={ref} className={clsx(!open && 'line-clamp-4')}>
        {text}
      </div>
      {(clipped || open) && (
        <button type="button" onClick={() => setOpen((v) => !v)} className="mt-1 text-xs font-medium text-accent-ink hover:underline">
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </>
  );
}

// Ready-made templates for the "Start from an example" buttons.
const EXAMPLES: { name: string; fields: ExtractionField[] }[] = [
  {
    name: 'Client status',
    fields: [
      { name: 'Status', description: 'one line: where the project stands after this meeting' },
      { name: 'Next deadline', description: 'the next agreed date and what is due' },
      { name: 'Blockers', description: 'anything holding things up, or "none"' },
      { name: 'Client mood', description: 'happy / neutral / concerned, with a short reason' },
    ],
  },
  {
    name: 'Sales call',
    fields: [
      { name: 'Budget', description: 'budget mentioned, with currency and conditions' },
      { name: 'Decision maker', description: 'who decides and who else is involved' },
      { name: 'Objections', description: 'concerns the prospect raised' },
      { name: 'Next step', description: 'the agreed next step and its date' },
    ],
  },
];

function TemplateEditor({
  open,
  template,
  onClose,
  onSave,
}: {
  open: boolean;
  template: ExtractionTemplate | null;
  onClose: () => void;
  onSave: (name: string, fields: ExtractionField[]) => void;
}) {
  const [name, setName] = useState('');
  const [fields, setFields] = useState<ExtractionField[]>([]);

  useEffect(() => {
    if (!open) return;
    setName(template?.name ?? '');
    setFields(template?.fields.length ? template.fields : [{ name: '', description: '' }]);
  }, [open, template]);

  const clean = fields.map((f) => ({ name: f.name.trim(), description: f.description.trim() })).filter((f) => f.name);
  const names = clean.map((f) => f.name.toLowerCase());
  const duplicate = names.some((n, i) => names.indexOf(n) !== i);
  const setField = (i: number, patch: Partial<ExtractionField>) => setFields((list) => list.map((f, j) => (j === i ? { ...f, ...patch } : f)));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={template ? 'Edit template' : 'New extraction template'}
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name.trim() || !clean.length || duplicate} onClick={() => onSave(name.trim(), clean)}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <p className="text-[13px] text-muted">
          A template is a table the AI fills in for every meeting in this folder: one row per meeting, one column per
          field. Give each field a name and tell the AI what to write in it.
        </p>
        {!template && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted">Start from an example:</span>
            {EXAMPLES.map((ex) => (
              <Button
                key={ex.name}
                size="sm"
                variant="secondary"
                onClick={() => {
                  setName(ex.name);
                  setFields(ex.fields);
                }}
              >
                {ex.name}
              </Button>
            ))}
          </div>
        )}
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">Template name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Client status" autoFocus />
        </label>
        <div className="space-y-2.5">
          <div className="text-[13px] font-medium">Fields (columns)</div>
          {fields.map((f, i) => (
            <div key={i} className="flex items-start gap-2 rounded-field border border-line p-3">
              <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-[11rem_minmax(0,1fr)]">
                <label className="flex min-w-0 flex-col gap-1">
                  <span className="text-xs text-muted">Field name</span>
                  <Input value={f.name} onChange={(e) => setField(i, { name: e.target.value })} placeholder="e.g. Budget" />
                </label>
                <label className="flex min-w-0 flex-col gap-1">
                  <span className="text-xs text-muted">What the AI should write</span>
                  <Input
                    value={f.description}
                    onChange={(e) => setField(i, { description: e.target.value })}
                    placeholder="e.g. the agreed budget in EUR, with any conditions"
                   
                  />
                </label>
              </div>
              <IconButton
                icon={X}
                label="Remove field"
                disabled={fields.length === 1}
                onClick={() => setFields((list) => list.filter((_, j) => j !== i))}
                className="mt-6"
              />
            </div>
          ))}
          <Button size="sm" variant="ghost" icon={Plus} onClick={() => setFields((list) => [...list, { name: '', description: '' }])}>
            Add field
          </Button>
          {duplicate && <p className="text-xs text-danger">Field names must be unique.</p>}
          {template && <p className="text-xs text-muted">Changing fields doesn't update values already extracted; run the template again for that.</p>}
        </div>
      </div>
    </Modal>
  );
}
