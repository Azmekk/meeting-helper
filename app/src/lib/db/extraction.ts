// Extraction templates and the rows they produce.
import type { ExtractionField, ExtractionRow, ExtractionTemplate } from '../types';
import { conn, touch, touchFolder, touchTemplateFolder } from './connection';
import { now, parseJson } from './helpers';

interface TemplateRow {
  id: number;
  folder_id: number;
  name: string;
  fields_json: string;
  created_at: string;
}

interface ExtractionRowRow {
  id: number;
  template_id: number;
  meeting_id: number;
  values_json: string;
  created_at: string;
}

const toTemplate = (r: TemplateRow): ExtractionTemplate => ({
  id: r.id,
  folderId: r.folder_id,
  name: r.name,
  fields: parseJson<ExtractionField[]>(r.fields_json, []),
  createdAt: r.created_at,
});

const toExtractionRow = (r: ExtractionRowRow): ExtractionRow => ({
  id: r.id,
  templateId: r.template_id,
  meetingId: r.meeting_id,
  values: parseJson<Record<string, string | null>>(r.values_json, {}),
  createdAt: r.created_at,
});

export async function listExtractionTemplates(folderId: number): Promise<ExtractionTemplate[]> {
  const rows = await conn().select<TemplateRow[]>('SELECT * FROM extraction_templates WHERE folder_id = $1 ORDER BY id', [
    folderId,
  ]);
  return rows.map(toTemplate);
}

export async function getExtractionTemplate(id: number): Promise<ExtractionTemplate | null> {
  const rows = await conn().select<TemplateRow[]>('SELECT * FROM extraction_templates WHERE id = $1', [id]);
  return rows[0] ? toTemplate(rows[0]) : null;
}

export async function createExtractionTemplate(
  folderId: number,
  name: string,
  fields: ExtractionField[],
): Promise<ExtractionTemplate> {
  const createdAt = now();
  const res = await conn().execute(
    'INSERT INTO extraction_templates (folder_id, name, fields_json, created_at) VALUES ($1, $2, $3, $4)',
    [folderId, name, JSON.stringify(fields), createdAt],
  );
  if (res.lastInsertId == null) throw new Error('createExtractionTemplate: no id returned');
  await touchFolder(folderId);
  return { id: Number(res.lastInsertId), folderId, name, fields, createdAt };
}

export async function updateExtractionTemplate(id: number, name: string, fields: ExtractionField[]): Promise<void> {
  await conn().execute('UPDATE extraction_templates SET name = $1, fields_json = $2 WHERE id = $3', [
    name,
    JSON.stringify(fields),
    id,
  ]);
  await touchTemplateFolder(id);
}

export async function deleteExtractionTemplate(id: number): Promise<void> {
  await touchTemplateFolder(id);
  await conn().execute('DELETE FROM extraction_rows WHERE template_id = $1', [id]);
  await conn().execute('DELETE FROM extraction_templates WHERE id = $1', [id]);
}

export async function listExtractionRows(templateId: number): Promise<ExtractionRow[]> {
  const rows = await conn().select<ExtractionRowRow[]>('SELECT * FROM extraction_rows WHERE template_id = $1 ORDER BY id', [
    templateId,
  ]);
  return rows.map(toExtractionRow);
}

// With the template, so a bundle can recreate it elsewhere.
export async function listMeetingExtractionRows(
  meetingId: number,
): Promise<(ExtractionRow & { template: ExtractionTemplate | null })[]> {
  const rows = await conn().select<ExtractionRowRow[]>('SELECT * FROM extraction_rows WHERE meeting_id = $1 ORDER BY id', [
    meetingId,
  ]);
  const out = [];
  for (const r of rows) out.push({ ...toExtractionRow(r), template: await getExtractionTemplate(r.template_id) });
  return out;
}

// One row per (template, meeting): a re-run replaces the old values.
export async function saveExtractionRow(
  templateId: number,
  meetingId: number,
  values: Record<string, string | null>,
  createdAt: string = now(),
): Promise<void> {
  await conn().execute('DELETE FROM extraction_rows WHERE template_id = $1 AND meeting_id = $2', [templateId, meetingId]);
  await conn().execute(
    'INSERT INTO extraction_rows (template_id, meeting_id, values_json, created_at) VALUES ($1, $2, $3, $4)',
    [templateId, meetingId, JSON.stringify(values), createdAt],
  );
  await touch('meeting', meetingId);
}

// Templates matched by name: existing ones get the bundle's fields, missing
// ones are created, and ones not in the bundle are dropped when no meeting has
// rows for them.
export async function upsertFolderTemplates(
  folderId: number,
  templates: { name: string; fields: ExtractionField[]; createdAt: string }[],
): Promise<void> {
  const d = conn();
  const existing = await listExtractionTemplates(folderId);
  for (const t of templates) {
    const match = existing.find((e) => e.name === t.name);
    if (match) {
      await d.execute('UPDATE extraction_templates SET fields_json = $1 WHERE id = $2', [JSON.stringify(t.fields), match.id]);
    } else {
      await d.execute('INSERT INTO extraction_templates (folder_id, name, fields_json, created_at) VALUES ($1, $2, $3, $4)', [
        folderId,
        t.name,
        JSON.stringify(t.fields),
        t.createdAt,
      ]);
    }
  }
  const names = new Set(templates.map((t) => t.name));
  for (const e of existing) {
    if (names.has(e.name)) continue;
    const rows = await d.select<{ n: number }[]>('SELECT COUNT(*) AS n FROM extraction_rows WHERE template_id = $1', [e.id]);
    if (!Number(rows[0]?.n)) await d.execute('DELETE FROM extraction_templates WHERE id = $1', [e.id]);
  }
}
