// Chat conversations and their messages.
import type { AiScope, ChatConversation, ChatMessage, TaskProposal } from '../types';
import { conn, touchOwner } from './connection';
import { conversationTitle, now } from './helpers';
import { toChatMessage, type ChatMessageRow } from './rows';

export interface AnswerUsage {
  model: string;
  costUsd: number | null;
  cachedPercent: number | null;
}

// Newest activity first.
export async function listConversations(scope: AiScope, ownerId: number): Promise<ChatConversation[]> {
  const rows = await conn().select<
    { id: number; scope: AiScope; owner_id: number; title: string; created_at: string; updated_at: string; cost_usd: number | null; unpriced: number }[]
  >(
    `SELECT c.*,
       (SELECT SUM(m.cost_usd) FROM chat_messages m WHERE m.conversation_id = c.id) AS cost_usd,
       (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id = c.id AND m.role = 'assistant' AND m.cost_usd IS NULL) AS unpriced
     FROM chat_conversations c
     WHERE c.scope = $1 AND c.owner_id = $2
     ORDER BY c.updated_at DESC, c.id DESC`,
    [scope, ownerId],
  );
  return rows.map((r) => ({
    id: r.id,
    scope: r.scope,
    ownerId: r.owner_id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    costUsd: r.cost_usd,
    unpricedAnswers: r.unpriced,
  }));
}

// Titled from the first question, so naming a chat costs nothing.
export async function createConversation(scope: AiScope, ownerId: number, question: string, createdAt = now()): Promise<number> {
  const res = await conn().execute(
    'INSERT INTO chat_conversations (scope, owner_id, title, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)',
    [scope, ownerId, conversationTitle(question), createdAt],
  );
  if (res.lastInsertId == null) throw new Error('createConversation: no id returned');
  return Number(res.lastInsertId);
}

export async function deleteConversation(conversation: Pick<ChatConversation, 'id' | 'scope' | 'ownerId'>): Promise<void> {
  const d = conn();
  await d.execute('DELETE FROM chat_messages WHERE conversation_id = $1', [conversation.id]);
  await d.execute('DELETE FROM chat_conversations WHERE id = $1', [conversation.id]);
  await touchOwner(conversation.scope, conversation.ownerId);
}

// Oldest first. Without a conversation: every chat of this meeting or folder.
export async function listChatMessages(scope: AiScope, ownerId: number, conversationId?: number): Promise<ChatMessage[]> {
  const rows = await conn().select<ChatMessageRow[]>(
    conversationId == null
      ? 'SELECT * FROM chat_messages WHERE scope = $1 AND owner_id = $2 ORDER BY id'
      : 'SELECT * FROM chat_messages WHERE scope = $1 AND owner_id = $2 AND conversation_id = $3 ORDER BY id',
    conversationId == null ? [scope, ownerId] : [scope, ownerId, conversationId],
  );
  return rows.map(toChatMessage);
}

export async function addChatMessage(
  scope: AiScope,
  ownerId: number,
  conversationId: number,
  role: ChatMessage['role'],
  content: string,
  proposal: TaskProposal | null = null,
  usage: AnswerUsage | null = null,
): Promise<ChatMessage> {
  const createdAt = now();
  const res = await conn().execute(
    'INSERT INTO chat_messages (scope, owner_id, conversation_id, role, content, proposal, created_at, model, cost_usd, cached_percent) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
    [scope, ownerId, conversationId, role, content, proposal ? JSON.stringify(proposal) : null, createdAt, usage?.model ?? null, usage?.costUsd ?? null, usage?.cachedPercent ?? null],
  );
  if (res.lastInsertId == null) throw new Error('addChatMessage: no id returned');
  await conn().execute('UPDATE chat_conversations SET updated_at = $1 WHERE id = $2', [createdAt, conversationId]);
  await touchOwner(scope, ownerId);
  return { id: Number(res.lastInsertId), scope, ownerId, conversationId, role, content, proposal, createdAt, ...usage };
}

// When this model last read the transcript or folder context, so the prompt cache
// can be judged after a restart. A meeting's summary shares that prefix with its chats.
export async function lastCacheUse(scope: AiScope, ownerId: number, model: string): Promise<string | null> {
  const rows = await conn().select<{ at: string | null }[]>(
    `SELECT MAX(at) AS at FROM (
       SELECT created_at AS at FROM chat_messages WHERE scope = $1 AND owner_id = $2 AND model = $3
       UNION ALL
       SELECT created_at FROM ai_docs WHERE scope = $1 AND owner_id = $2 AND model = $3 AND kind = 'summary' AND scope = 'meeting'
     )`,
    [scope, ownerId, model],
  );
  return rows[0]?.at ?? null;
}

export async function setMessageProposal(id: number, proposal: TaskProposal): Promise<void> {
  await conn().execute('UPDATE chat_messages SET proposal = $1 WHERE id = $2', [JSON.stringify(proposal), id]);
}

// Chats for a bundle. Proposals stay out: they point at this database's task
// ids, and applied ones are already in the tasks.
export async function exportChat(scope: AiScope, ownerId: number) {
  const titles = new Map((await listConversations(scope, ownerId)).map((c) => [c.id, c.title]));
  return (await listChatMessages(scope, ownerId)).map((m) => ({
    role: m.role,
    content: m.content,
    createdAt: m.createdAt,
    conversation: (m.conversationId != null && titles.get(m.conversationId)) || undefined,
  }));
}

export async function importChat(
  scope: AiScope,
  ownerId: number,
  messages: { role: ChatMessage['role']; content: string; createdAt: string; conversation?: string }[],
): Promise<void> {
  const ids = new Map<string, number>();
  for (const m of messages) {
    const key = m.conversation ?? '';
    let conversationId = ids.get(key);
    if (conversationId == null) {
      conversationId = await createConversation(scope, ownerId, m.conversation ?? m.content, m.createdAt);
      ids.set(key, conversationId);
    }
    await insertImportedChatMessage({ scope, ownerId, ...m, conversationId });
  }
}

export async function insertImportedChatMessage(m: Omit<ChatMessage, 'id'>): Promise<void> {
  await conn().execute(
    'INSERT INTO chat_messages (scope, owner_id, conversation_id, role, content, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [m.scope, m.ownerId, m.conversationId ?? null, m.role, m.content, m.createdAt],
  );
}
