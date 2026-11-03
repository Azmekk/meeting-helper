// Folder AI tabs: rolling summary and tool-using chat, plus the folder
// briefing. Citations can point at any meeting in the folder; clicking one
// opens that meeting at the cited line.
import { TermsField } from '../TermsField';
import { AiLanguageSelect } from '../ai/AiLanguageSelect';
import { AiModelSelect, rememberAiModel, useAiModel } from '../ai/AiModelSelect';
import { ConversationBar, ProposalCard, useConversations } from '../ai/ChatParts';
import { SummaryHistoryControls, useSummaryHistory } from '../ai/SummaryHistory';
import { ArrowUp, MessageSquare, RefreshCw, Search, Square } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Callout, Card, Modal, Spinner, Textarea, clsx, errorMessage, toast } from '../ui';
import { ChatBubble, NoKeyNotice, useAbortable, useAiKey } from '../meeting/AiPanels';
import { AiMarkdown, type CiteProps } from '../meeting/AiMarkdown';
import * as db from '../../lib/db';
import { citedIds } from '../../lib/ai/prompts';
import { askFolder, rebuildFolderSummary, useFolderAi } from '../../lib/ai/folder';
import { isAbortError } from '../../lib/ai/meeting';
import { formatDate, formatUsd } from '../../lib/format';
import { refreshFolders } from '../../lib/folders';
import type { Folder } from '../../lib/types';

// Loads the segments cited anywhere in `texts` (any meeting) for CiteChip.
export function useFolderCites(texts: string[]): CiteProps {
  const navigate = useNavigate();
  const [refs, setRefs] = useState<Map<number, db.SegmentRef>>(new Map());
  const key = useMemo(() => [...new Set(texts.flatMap(citedIds))].sort((a, b) => a - b).join(','), [texts]);

  useEffect(() => {
    if (!key) return;
    let alive = true;
    db.getSegmentRefs(key.split(',').map(Number))
      .then((list) => alive && setRefs((cur) => new Map([...cur, ...list.map((r) => [r.segmentId, r] as const)])))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [key]);

  return useMemo(
    () => ({
      resolve: (segId: number) => {
        const r = refs.get(segId);
        return r ? { startMs: r.startMs, speaker: `${r.speaker} · ${r.meetingTitle}`, text: r.text } : null;
      },
      onCite: (segId: number) => {
        const r = refs.get(segId);
        if (r) navigate(`/meetings/${r.meetingId}?t=${r.startMs}&seg=${segId}`);
      },
    }),
    [refs, navigate],
  );
}

// ---------- Summary ----------

export function FolderSummaryPanel({ folder }: { folder: Folder }) {
  const hasKey = useAiKey();
  const [model, setModel] = useAiModel('background', 'folder-summary');
  const autoBusy = useFolderAi((s) => s.busy[folder.id]);
  const { docs, doc, select, showNewest, reload, loadError } = useSummaryHistory('folder', folder.id, 'folder_summary');
  const [streaming, setStreaming] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const error = runError ?? loadError;
  const { start, stop } = useAbortable();

  // Background updates finish while the tab is open.
  const wasBusy = useRef(autoBusy);
  useEffect(() => {
    if (wasBusy.current && !autoBusy) void reload();
    wasBusy.current = autoBusy;
  }, [autoBusy, reload]);

  const cite = useFolderCites(doc ? [doc.content] : []);
  const streamCite = useFolderCites(streaming ? [streaming] : []);

  const rebuild = async () => {
    const signal = start();
    setRunError(null);
    setStreaming('');
    try {
      await rebuildFolderSummary(folder.id, { signal, onText: setStreaming, model });
      showNewest();
      await reload();
      toast('Folder summary ready', 'success');
    } catch (err) {
      if (!isAbortError(err)) setRunError(errorMessage(err));
    } finally {
      setStreaming(null);
    }
  };

  if (!docs || hasKey === undefined) {
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    );
  }
  const busy = streaming !== null;
  if (!doc && !busy && !hasKey) return <NoKeyNotice />;

  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          Folder summary
          {doc && !busy && <SummaryHistoryControls docs={docs} doc={doc} onSelect={select} onDeleted={() => void reload()} />}
        </span>
      }
      description={
        busy
          ? `Writing with ${model}…`
          : autoBusy
            ? autoBusy
            : doc
              ? `${doc.model ?? 'Unknown model'} · ${formatUsd(doc.costUsd)} · ${formatDate(doc.createdAt)}`
              : 'Where things stand across all meetings. Updated after each meeting gets its summary.'
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
            <Button size="sm" icon={RefreshCw} onClick={rebuild} disabled={!hasKey || !!autoBusy} title="Rebuild from every meeting summary in the folder. This one stays in the history.">
              Rebuild from all meetings
            </Button>
          </>
        )
      }
    >
      {error && (
        <Callout tone="error" title="Couldn't write the folder summary" className="mb-4">
          <p className="break-words">{error}</p>
        </Callout>
      )}
      {busy ? (
        streaming ? (
          <AiMarkdown text={streaming} {...streamCite} />
        ) : (
          <div className="flex items-center gap-2 py-6 text-sm text-muted">
            <Spinner /> Reading the meeting summaries…
          </div>
        )
      ) : doc ? (
        <AiMarkdown text={doc.content} {...cite} />
      ) : (
        <p className="py-4 text-center text-[13px] text-muted">
          No folder summary yet. Summarise meetings in this folder, or rebuild from the ones that already have a summary.
        </p>
      )}
    </Card>
  );
}

// ---------- Chat ----------

const SUGGESTIONS = ['What changed since the last meeting?', 'What is still open and who owns it?', 'Summarise the decisions so far.'];

const TOOL_LABEL: Record<string, string> = {
  list_meetings: 'Listing meetings',
  search_meetings: 'Searching transcripts',
  get_meeting_summary: 'Reading a summary',
  get_transcript_excerpt: 'Reading a transcript',
};

export function FolderChatPanel({ folder }: { folder: Folder }) {
  const hasKey = useAiKey();
  const chat = useConversations('folder', folder.id);
  const { messages } = chat;
  const [model, setModel] = useAiModel('summary', `chat:folder:${chat.activeId ?? folder.id}`);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<{ question: string; text: string; tool: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [costs, setCosts] = useState<Record<number, string>>({});
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const { start, stop } = useAbortable();

  const texts = useMemo(() => [...(messages ?? []).map((m) => m.content), pending?.text ?? ''], [messages, pending?.text]);
  const cite = useFolderCites(texts);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  const send = async (text = input) => {
    const question = text.trim();
    if (!question || pending) return;
    const signal = start();
    setError(null);
    setInput('');
    stick.current = true;
    setPending({ question, text: '', tool: null });
    try {
      const ex = await askFolder(folder.id, question, {
        signal,
        model,
        conversationId: chat.activeId,
        onText: (t) => setPending((p) => (p ? { ...p, text: t, tool: null } : p)),
        onTool: (call) => {
          const q = typeof call.input.query === 'string' ? `: ${call.input.query}` : '';
          setPending((p) => (p ? { ...p, tool: `${TOOL_LABEL[call.name] ?? call.name}${q}` } : p));
        },
      });
      rememberAiModel(`chat:folder:${ex.conversationId}`, model);
      await chat.add(ex);
      setCosts((c) => ({ ...c, [ex.answer.id]: [ex.model, formatUsd(ex.costUsd), ex.note].filter(Boolean).join(' · ') }));
    } catch (err) {
      setInput((cur) => cur || question);
      if (!isAbortError(err)) setError(errorMessage(err));
    } finally {
      setPending(null);
    }
  };

  if (messages === undefined || hasKey === undefined) {
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    );
  }
  if (!hasKey && !messages.length) return <NoKeyNotice />;
  const canSend = hasKey && !pending;
  const shownError = error ?? chat.loadError;

  return (
    <Card
      title="Chat"
      description="Ask across every meeting in this folder. The AI searches the transcripts and links to the lines it uses."
      padded={false}
      actions={
        <>
          <AiLanguageSelect />
          <AiModelSelect value={model} onChange={setModel} disabled={!!pending} />
        </>
      }
    >
      <ConversationBar conversations={chat.conversations} activeId={chat.activeId} disabled={!!pending} onOpen={(id) => void chat.open(id)} onDelete={chat.remove} />
      <div
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="max-h-[calc(100vh-20rem)] min-h-40 space-y-4 overflow-y-auto px-5 py-4"
      >
        {!messages.length && !pending && (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <MessageSquare size={22} className="text-faint" />
            <div className="flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <Button key={s} size="sm" variant="secondary" disabled={!canSend} onClick={() => send(s)}>
                  {s}
                </Button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id}>
            <ChatBubble role={m.role} text={m.content} meta={costs[m.id]} cite={cite} />
            {m.proposal && <ProposalCard message={m} folderId={folder.id} meetingId={null} onChange={chat.setProposal} />}
          </div>
        ))}
        {pending && (
          <>
            <ChatBubble role="user" text={pending.question} cite={cite} />
            {pending.text ? (
              <ChatBubble role="assistant" text={pending.text} cite={cite} />
            ) : (
              <div className="flex items-center gap-2 text-[13px] text-muted">
                {pending.tool ? <Search size={14} className="text-accent" /> : <Spinner />}
                <span className="truncate">{pending.tool ? `${pending.tool}…` : 'Thinking…'}</span>
              </div>
            )}
          </>
        )}
      </div>

      <div className="border-t border-line px-5 py-3">
        {shownError && (
          <Callout tone="error" className="mb-3">
            <p className="break-words">{shownError}</p>
          </Callout>
        )}
        {!hasKey && (
          <p className="mb-2 text-[13px] text-muted">
            Add an AI key in{' '}
            <Link to="/settings?tab=ai" className="text-accent underline">
              Settings
            </Link>{' '}
            to keep chatting.
          </p>
        )}
        <div className="flex items-end gap-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (canSend) send();
              }
            }}
            rows={2}
            disabled={!hasKey}
            placeholder="Ask about these meetings (Enter to send, Shift+Enter for a new line)"
            className="max-h-40 min-h-[2.5rem] resize-y text-[13px]"
          />
          {pending ? (
            <Button icon={Square} onClick={stop}>
              Stop
            </Button>
          ) : (
            <Button variant="primary" icon={ArrowUp} disabled={!canSend || !input.trim()} onClick={() => send()}>
              Send
            </Button>
          )}
        </div>
      </div>

    </Card>
  );
}

// ---------- Briefing ----------

// Briefing and vocabulary as two compact rows; each opens a dialog to edit.
export function FolderContextCard({ folder }: { folder: Folder }) {
  const [editing, setEditing] = useState<null | 'briefing' | 'terms'>(null);
  const terms = folder.terms;
  return (
    <Card title="Folder context" padded={false}>
      <div className="divide-y divide-line">
        <ContextRow
          title="Briefing"
          hint="Added to every AI request for meetings in this folder."
          preview={folder.briefing ?? 'Not set'}
          empty={!folder.briefing}
          onEdit={() => setEditing('briefing')}
        />
        <ContextRow
          title="Vocabulary"
          hint="Names and terms the transcriber should know."
          preview={terms.length ? terms.join(', ') : 'No terms'}
          empty={!terms.length}
          onEdit={() => setEditing('terms')}
        />
      </div>
      <BriefingDialog folder={folder} open={editing === 'briefing'} onClose={() => setEditing(null)} />
      <TermsDialog folder={folder} open={editing === 'terms'} onClose={() => setEditing(null)} />
    </Card>
  );
}

function ContextRow({
  title,
  hint,
  preview,
  empty,
  onEdit,
}: {
  title: string;
  hint: string;
  preview: string;
  empty: boolean;
  onEdit: () => void;
}) {
  return (
    <div className="flex items-center gap-3 px-5 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium" title={hint}>
          {title}
        </div>
        <p className={clsx('truncate text-[13px]', empty ? 'text-faint' : 'text-muted')}>{preview}</p>
      </div>
      <Button size="sm" variant="secondary" onClick={onEdit}>
        {empty ? 'Add' : 'Edit'}
      </Button>
    </div>
  );
}

function BriefingDialog({ folder, open, onClose }: { folder: Folder; open: boolean; onClose: () => void }) {
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setValue(folder.briefing ?? '');
  }, [open, folder.briefing]);

  const save = async () => {
    setSaving(true);
    try {
      await db.setFolderBriefing(folder.id, value.trim() || null);
      await refreshFolders();
      onClose();
    } catch (err) {
      toast(`Couldn't save the briefing: ${errorMessage(err)}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Folder briefing"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <p className="mb-3 text-[13px] text-muted">
        Who you are and what this series of meetings is about. The AI reads it with every summary, answer and extraction
        for meetings in this folder.
      </p>
      <Textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={6}
        autoFocus
        placeholder="e.g. Weekly syncs with Acme about the website relaunch. I'm the agency's project lead; Иван is their CFO."
        className="resize-y text-[13px]"
      />
    </Modal>
  );
}

function TermsDialog({ folder, open, onClose }: { folder: Folder; open: boolean; onClose: () => void }) {
  const save = async (terms: string[]) => {
    try {
      await db.setFolderTerms(folder.id, terms);
      await refreshFolders();
    } catch (err) {
      toast(`Couldn't save the vocabulary: ${errorMessage(err)}`, 'error');
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Folder vocabulary"
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <p className="mb-3 text-[13px] text-muted">
        One term per line: just the name or word, no explanation. Used for every meeting in this folder, on top of your
        default list in Settings → Language. Saved when you click outside the box.
      </p>
      <TermsField terms={folder.terms} onSave={save} rows={8} placeholder={'Client and colleague names, product names…\nOne term per line'} />
    </Modal>
  );
}
