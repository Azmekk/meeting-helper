// Tasks in chat: telling the AI about the current tasks, reading the changes it
// proposes from its answer, and applying them once the user agrees.
//
// Proposals are a fenced block in the answer rather than a tool call. Tools sit
// at the very start of a prompt, so adding one to chat would stop chat sharing
// the cached transcript with summaries; a block also works on endpoints without
// tool support.
import * as db from '../db';
import type { ActionItem, TaskChange, TaskProposal } from '../types';

export const TASK_RULES = `The user tracks tasks for this series of meetings. The current tasks come after their question.
Use them when asked about a task. When the user asks you to create, split, reword or complete tasks, describe the change in a sentence, then end your answer with one block like this, and use it only then:
\`\`\`tasks
{"changes":[{"action":"add","text":"Short task","owner":null,"parent_id":null},{"action":"split","id":12,"subtasks":[{"text":"First step","owner":"Maria"}]},{"action":"update","id":12,"text":"New wording","owner":null},{"action":"complete","id":12}]}
\`\`\`
Include only the changes asked for. Use ids from the task list, and null for anything unknown or unchanged. These are only suggestions: the user reviews them before anything changes, so never say a change has been made.`;

// Sent per turn, after the question, so ticking a box doesn't break the cache.
export function taskListText(items: ActionItem[]): string {
  const tracked = items.filter((i) => i.status === 'open' || i.status === 'done');
  if (!tracked.length) return 'Current tasks: none.';
  const lines = tracked.map(
    (i) =>
      `- id ${i.id}${i.parentId != null ? ` (subtask of ${i.parentId})` : ''} [${i.status === 'done' ? 'completed' : 'open'}]: ${i.text}${i.owner ? ` (owner: ${i.owner})` : ''}`,
  );
  return `Current tasks:\n${lines.join('\n')}`;
}

const BLOCK = /```tasks\s*([\s\S]*?)(?:```|$)/;

// The answer without its block; hides the block while it's still streaming too.
export function visibleAnswer(text: string): string {
  const at = text.indexOf('```tasks');
  return at < 0 ? text : text.slice(0, at).trimEnd();
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

// Keeps only well-formed changes that point at tasks that exist.
function toChange(raw: Record<string, unknown>, known: Set<number>): TaskChange | null {
  const id = Number(raw.id);
  switch (raw.action) {
    case 'add': {
      const t = text(raw.text);
      const parent = Number(raw.parent_id);
      return t ? { action: 'add', text: t, owner: text(raw.owner), parentId: known.has(parent) ? parent : null } : null;
    }
    case 'split': {
      if (!known.has(id) || !Array.isArray(raw.subtasks)) return null;
      const subtasks = (raw.subtasks as Record<string, unknown>[]).flatMap((s) => {
        const t = text(s?.text);
        return t ? [{ text: t, owner: text(s.owner) }] : [];
      });
      return subtasks.length ? { action: 'split', id, subtasks } : null;
    }
    case 'update': {
      const t = text(raw.text);
      const owner = text(raw.owner);
      return known.has(id) && (t || owner) ? { action: 'update', id, text: t, owner } : null;
    }
    case 'complete':
      return known.has(id) ? { action: 'complete', id } : null;
    default:
      return null;
  }
}

export function parseProposal(answer: string, items: ActionItem[]): TaskProposal | null {
  const m = BLOCK.exec(answer);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1].trim()) as { changes?: Record<string, unknown>[] };
    const known = new Set(items.map((i) => i.id));
    const changes = (parsed.changes ?? []).flatMap((c) => toChange(c, known) ?? []);
    return changes.length ? { changes, state: 'pending' } : null;
  } catch {
    return null;
  }
}

// One line per change, for the card in chat.
export function describeChange(change: TaskChange, items: ActionItem[]): { title: string; lines: string[] } {
  const name = (id: number) => {
    const item = items.find((i) => i.id === id);
    return item ? `#${id} ${item.text}` : `Task ${id}`;
  };
  const who = (owner: string | null) => (owner ? `${owner}: ` : '');
  switch (change.action) {
    case 'add':
      return { title: `Add: ${who(change.owner)}${change.text}`, lines: change.parentId != null ? [`Under: ${name(change.parentId)}`] : [] };
    case 'split':
      return { title: `Split: ${name(change.id)}`, lines: change.subtasks.map((s) => `${who(s.owner)}${s.text}`) };
    case 'update':
      return { title: `Change: ${name(change.id)}`, lines: [[change.owner && `Owner: ${change.owner}`, change.text && `Text: ${change.text}`].filter(Boolean).join(' · ')] };
    case 'complete':
      return { title: `Complete: ${name(change.id)}`, lines: [] };
  }
}

// Applied tasks count as added by hand: re-running action items leaves them alone.
export async function applyProposal(folderId: number, meetingId: number | null, changes: TaskChange[]): Promise<void> {
  const add = (text: string, owner: string | null, parentId: number | null) =>
    db.addActionItem({ folderId, meetingId, text, owner, status: 'open', firstSeenMeeting: null, lastUpdateMeeting: null, sourceMs: null, parentId });
  for (const c of changes) {
    if (c.action === 'add') await add(c.text, c.owner, c.parentId);
    else if (c.action === 'split') for (const s of c.subtasks) await add(s.text, s.owner, c.id);
    else if (c.action === 'update') await db.updateActionItem(c.id, { ...(c.text ? { text: c.text } : {}), ...(c.owner ? { owner: c.owner } : {}) });
    else await db.updateActionItem(c.id, { status: 'done' });
  }
}
