// Development only: fills a folder's Progress and Extract tabs with made-up
// data so their full states can be looked at without spending AI tokens.
import * as db from './db';
import type { Meeting } from './types';

const ITEMS: { text: string; owner: string | null; status: 'open' | 'done' | 'dropped' }[] = [
  { text: 'Send Q3 bank statements to Иван', owner: 'Martin Yordanov', status: 'open' },
  { text: 'File the Q3 VAT return', owner: 'Иван Петров', status: 'open' },
  { text: 'Book onboarding calls with both new clients', owner: 'Martin Yordanov', status: 'done' },
  { text: 'Share the onboarding checklist template', owner: 'Мария Георгиева', status: 'done' },
  { text: 'Decide whether to switch payroll provider', owner: null, status: 'open' },
  { text: 'Prepare a quote for the bookkeeping add-on', owner: 'Martin Yordanov', status: 'dropped' },
  { text: 'Check the invoice numbering gap from August', owner: 'Иван Петров', status: 'open' },
];

const FIELDS = [
  { name: 'Status', description: 'one line: where the project stands after this meeting' },
  { name: 'Next deadline', description: 'the next agreed date and what is due' },
  { name: 'Blockers', description: 'anything holding things up, or "none"' },
  { name: 'Client mood', description: 'happy / neutral / concerned, with a short reason' },
];

const ROWS: Record<string, string | null>[] = [
  { Status: 'VAT return on track; statements still missing', 'Next deadline': '14 Nov: VAT return', Blockers: 'Bank statements for August', 'Client mood': 'Neutral: worried about the deadline' },
  { Status: 'Onboarding checklist agreed', 'Next deadline': '7 Nov: first onboarding call', Blockers: 'none', 'Client mood': 'Happy: liked the checklist' },
  { Status: 'Payroll provider comparison started', 'Next deadline': null, Blockers: 'Waiting for two quotes', 'Client mood': 'Neutral' },
  { Status: 'Invoice numbering gap found', 'Next deadline': '5 Nov: explain the gap', Blockers: 'Missing August export', 'Client mood': 'Concerned: auditor asked about it' },
  { Status: 'Kick-off: scope and contacts agreed', 'Next deadline': '1 Nov: send engagement letter', Blockers: 'none', 'Client mood': 'Happy' },
];

export async function fillSampleFolderData(folderId: number, meetings: Meeting[]): Promise<void> {
  const ordered = [...meetings].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const at = (n: number) => ordered[Math.min(n, ordered.length - 1)]?.id ?? null;

  for (const [n, item] of ITEMS.entries()) {
    const first = at(n % Math.max(1, ordered.length));
    await db.addActionItem({
      folderId,
      meetingId: first,
      text: item.text,
      owner: item.owner,
      status: item.status,
      firstSeenMeeting: first,
      lastUpdateMeeting: item.status === 'open' ? first : at(ordered.length - 1),
      sourceMs: 30_000 + n * 47_000,
    });
  }

  if (!ordered.length) return;
  const template = await db.createExtractionTemplate(folderId, 'Client status (sample)', FIELDS);
  for (const [n, m] of ordered.entries()) {
    await db.saveExtractionRow(template.id, m.id, ROWS[n % ROWS.length]);
  }
}
