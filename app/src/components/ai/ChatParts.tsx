// What meeting chat and folder chat share: the conversation picker and the card
// for task changes the AI proposes.
import { Check, ListChecks, Plus, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import * as db from '../../lib/db';
import { formatUsd } from '../../lib/format';
import type { CacheStatus } from '../../lib/ai/meeting';
import { tasksChanged } from '../../lib/ai/folder';
import { applyProposal, describeChange } from '../../lib/ai/tasks';
import type { ActionItem, AiScope, ChatConversation, ChatMessage, TaskChange, TaskProposal } from '../../lib/types';
import { Badge, Button, IconButton, Input, Modal, Select, clsx, errorMessage, toast } from '../ui';

export function useConversations(scope: AiScope, ownerId: number) {
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null); // null = a new chat
  const [messages, setMessages] = useState<ChatMessage[] | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);

  const open = useCallback(
    async (id: number | null) => {
      setActiveId(id);
      setMessages(id == null ? [] : await db.listChatMessages(scope, ownerId, id));
    },
    [scope, ownerId],
  );

  // Opens the most recent chat.
  useEffect(() => {
    let alive = true;
    setMessages(undefined);
    setLoadError(null);
    db.listConversations(scope, ownerId)
      .then(async (list) => {
        if (!alive) return;
        setConversations(list);
        await open(list[0]?.id ?? null);
      })
      .catch((err) => {
        if (!alive) return;
        setMessages([]);
        setLoadError(errorMessage(err));
      });
    return () => {
      alive = false;
    };
  }, [scope, ownerId, open]);

  const add = useCallback(
    async (exchange: { conversationId: number; question: ChatMessage; answer: ChatMessage }) => {
      setActiveId(exchange.conversationId);
      setMessages((m) => [...(m ?? []), exchange.question, exchange.answer]);
      setConversations(await db.listConversations(scope, ownerId));
    },
    [scope, ownerId],
  );

  const remove = useCallback(async () => {
    const current = conversations.find((c) => c.id === activeId);
    if (!current) return;
    await db.deleteConversation(current);
    const rest = conversations.filter((c) => c.id !== current.id);
    setConversations(rest);
    await open(rest[0]?.id ?? null);
  }, [conversations, activeId, open]);

  const setProposal = useCallback((messageId: number, proposal: TaskProposal) => {
    setMessages((m) => m?.map((x) => (x.id === messageId ? { ...x, proposal } : x)));
  }, []);

  return { conversations, activeId, messages, loadError, open, add, remove, setProposal };
}

// "gpt-6.1-terra · $0.01 · 94% cached", the line under an answer. Answers saved
// before these were recorded have none.
export function answerMeta(m: ChatMessage): string | undefined {
  if (!m.model) return undefined;
  return [m.model, m.costUsd != null && formatUsd(m.costUsd), m.cachedPercent != null && `${m.cachedPercent}% cached`].filter(Boolean).join(' · ');
}

// What a conversation has cost so far. The + says some answers have no known cost.
function conversationCost(c: ChatConversation | undefined): string | null {
  if (c?.costUsd == null) return null;
  return `${formatUsd(c.costUsd)}${c.unpricedAnswers ? '+' : ''}`;
}

// Rechecked regularly: the cache expires while the chat sits idle. Pass a stable
// `load` (useCallback) and a `refresh` that changes around each answer.
export function useCacheStatus(load: () => Promise<CacheStatus>, enabled: boolean, refresh: unknown): CacheStatus | null {
  const [status, setStatus] = useState<CacheStatus | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const check = () =>
      load()
        .then((s) => alive && setStatus(s))
        .catch(() => alive && setStatus(null));
    void check();
    const timer = setInterval(() => void check(), 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [load, enabled, refresh]);
  return status;
}

// Above the message box: is the context still cached, and what this chat has cost.
export function ChatCacheLine({ status, conversation }: { status: CacheStatus | null; conversation: ChatConversation | undefined }) {
  const cost = conversationCost(conversation);
  if (!status && !cost) return null;
  const minutes = status?.expiresAt != null ? Math.max(1, Math.round((status.expiresAt - Date.now()) / 60_000)) : null;
  const next = status?.coldCost != null && status.coldCost >= 0.01 ? `, next question about ${formatUsd(status.coldCost)}` : '';
  return (
    <div className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-0.5 text-xs text-muted">
      {status && (
        <span className="flex min-w-0 items-center gap-1.5" title="An estimate from when this model last read it. Providers don't report when a cache really expires.">
          <span aria-hidden className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', minutes != null ? 'bg-ok' : 'bg-warn')} />
          {minutes != null ? `Cache active, about ${minutes} min left` : status.everUsed ? `Cache expired${next}` : `Not cached for this model yet${next}`}
        </span>
      )}
      {cost && (
        <span className="ml-auto shrink-0" title={conversation?.unpricedAnswers ? 'Earlier answers have no recorded cost, so the total is higher than this.' : undefined}>
          This chat: {cost}
        </span>
      )}
    </div>
  );
}

// The dropdown, "New chat" and "Delete" row at the top of a chat.
export function ConversationBar({
  conversations,
  activeId,
  disabled,
  onOpen,
  onDelete,
}: {
  conversations: ChatConversation[];
  activeId: number | null;
  disabled: boolean;
  onOpen: (id: number | null) => void;
  onDelete: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const del = async () => {
    try {
      await onDelete();
      setConfirming(false);
    } catch (err) {
      toast(`Couldn't delete the conversation: ${errorMessage(err)}`, 'error');
    }
  };
  return (
    <div className="flex items-center gap-2 border-b border-line px-5 py-2">
      <Select
        aria-label="Conversation"
        value={activeId ?? ''}
        disabled={disabled}
        search
        onChange={(e) => onOpen(e.target.value ? Number(e.target.value) : null)}
        className="h-8 min-w-0 flex-1 text-[13px]"
      >
        <option value="">New chat</option>
        {conversations.map((c) => (
          <option key={c.id} value={c.id}>
            <span className="flex items-baseline gap-3">
              <span className="min-w-0 flex-1 truncate">{c.title}</span>
              {conversationCost(c) && <span className="shrink-0 text-xs font-normal text-muted tabular-nums">{conversationCost(c)}</span>}
            </span>
          </option>
        ))}
      </Select>
      <Button size="sm" variant="secondary" icon={Plus} disabled={disabled || activeId == null} onClick={() => onOpen(null)} title="Start a new chat. Earlier ones stay in the list.">
        New chat
      </Button>
      {activeId != null && <IconButton size="sm" icon={Trash2} label="Delete conversation" disabled={disabled} onClick={() => setConfirming(true)} className="hover:text-danger" />}
      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Delete conversation?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="danger" icon={Trash2} onClick={() => void del()}>
              Delete
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">This deletes the questions and answers in this conversation. Other conversations and your tasks stay.</p>
      </Modal>
    </div>
  );
}

// Task changes suggested in an answer. Nothing happens until Apply; each change
// can be reworded or taken out first.
export function ProposalCard({
  message,
  folderId,
  meetingId,
  onChange,
}: {
  message: ChatMessage;
  folderId: number;
  meetingId: number | null;
  onChange: (messageId: number, proposal: TaskProposal) => void;
}) {
  const proposal = message.proposal!;
  const [changes, setChanges] = useState<TaskChange[]>(proposal.changes);
  const [items, setItems] = useState<ActionItem[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    db.listActionItems(folderId)
      .then(setItems)
      .catch(() => {});
  }, [folderId]);

  const finish = async (next: TaskProposal) => {
    await db.setMessageProposal(message.id, next);
    onChange(message.id, next);
  };

  const apply = async () => {
    setBusy(true);
    try {
      await applyProposal(folderId, meetingId, changes);
      await finish({ changes, state: 'applied' });
      tasksChanged(folderId);
      toast('Tasks updated', 'success');
    } catch (err) {
      toast(`Couldn't update the tasks: ${errorMessage(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const dismiss = () => finish({ changes, state: 'dismissed' }).catch((err) => toast(errorMessage(err), 'error'));
  const update = (i: number, change: TaskChange) => setChanges((c) => c.map((x, j) => (j === i ? change : x)));
  const pending = proposal.state === 'pending';

  return (
    <div className="mt-2 rounded-2xl border border-line p-3">
      <div className="mb-2 flex items-center gap-2 text-[13px] font-medium">
        <ListChecks size={14} className="text-accent" />
        Proposed task changes
        {!pending && <Badge tone={proposal.state === 'applied' ? 'ok' : 'neutral'}>{proposal.state === 'applied' ? 'Applied' : 'Dismissed'}</Badge>}
      </div>
      <ul className="space-y-2">
        {changes.map((change, i) => {
          const { title, lines } = describeChange(change, items);
          return (
            <li key={i} className="flex items-start gap-2 text-[13px]">
              <div className="min-w-0 flex-1 space-y-1">
                {pending && change.action === 'add' ? (
                  <Input aria-label="Task text" value={change.text} onChange={(e) => update(i, { ...change, text: e.target.value })} className="h-8 text-[13px]" />
                ) : (
                  <div>{title}</div>
                )}
                {pending && change.action === 'split'
                  ? change.subtasks.map((s, k) => (
                      <Input
                        key={k}
                        aria-label="Subtask text"
                        value={s.text}
                        onChange={(e) => update(i, { ...change, subtasks: change.subtasks.map((x, n) => (n === k ? { ...x, text: e.target.value } : x)) })}
                        className="h-8 text-[13px]"
                      />
                    ))
                  : lines.filter(Boolean).map((line) => (
                      <div key={line} className="text-muted">
                        {line}
                      </div>
                    ))}
              </div>
              {pending && <IconButton size="sm" icon={X} label="Leave this change out" onClick={() => setChanges((c) => c.filter((_, j) => j !== i))} />}
            </li>
          );
        })}
      </ul>
      {pending && (
        <div className="mt-3 flex gap-2">
          <Button size="sm" variant="primary" icon={Check} loading={busy} disabled={!changes.length} onClick={() => void apply()}>
            Apply
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void dismiss()}>
            Dismiss
          </Button>
        </div>
      )}
    </div>
  );
}
