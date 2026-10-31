// Folder AI tabs: rolling summary and tool-using chat, plus the folder
// briefing. Citations can point at any meeting in the folder; clicking one
// opens that meeting at the cited line.
import { TermsField } from '../TermsField';
import { AiLanguageSelect } from '../ai/AiLanguageSelect';
import { ArrowUp, MessageSquare, RefreshCw, Search, Sparkles, Square, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Callout, Card, Modal, Spinner, Textarea, errorMessage, toast } from '../ui';
import { ChatBubble, NoKeyNotice, useAbortable, useAiKey } from '../meeting/AiPanels';
import { AiMarkdown, type CiteProps } from '../meeting/AiMarkdown';
import * as db from '../../lib/db';
import { citedIds } from '../../lib/ai/prompts';
import { askFolder, rebuildFolderSummary, useFolderAi } from '../../lib/ai/folder';
import { isAbortError } from '../../lib/ai/meeting';
import { effectiveModel } from '../../lib/ai';
import { formatDate, formatUsd } from '../../lib/format';
import { refreshFolders } from '../../lib/folders';
import { useSettings } from '../../lib/settings';
import type { AiDoc, ChatMessage, Folder } from '../../lib/types';

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
  const model = useSettings((s) => effectiveModel('summary', s.settings));
  const autoBusy = useFolderAi((s) => s.busy[folder.id]);
  const [doc, setDoc] = useState<AiDoc | null | undefined>(undefined);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { start, stop } = useAbortable();

  const load = useCallback(() => {
    db.getAiDoc('folder', folder.id, 'folder_summary')
      .then(setDoc)
      .catch((err) => {
        setDoc(null);
        setError(errorMessage(err));
      });
  }, [folder.id]);

  useEffect(() => {
    setDoc(undefined);
    load();
  }, [load]);

  // Background updates finish while the tab is open.
  const wasBusy = useRef(autoBusy);
  useEffect(() => {
    if (wasBusy.current && !autoBusy) load();
    wasBusy.current = autoBusy;
  }, [autoBusy, load]);

  const cite = useFolderCites(doc ? [doc.content] : []);
  const streamCite = useFolderCites(streaming ? [streaming] : []);

  const rebuild = async () => {
    const signal = start();
    setError(null);
    setStreaming('');
    try {
      setDoc(await rebuildFolderSummary(folder.id, { signal, onText: setStreaming }));
      toast('Folder summary ready', 'success');
    } catch (err) {
      if (!isAbortError(err)) setError(errorMessage(err));
    } finally {
      setStreaming(null);
    }
  };

  if (doc === undefined || hasKey === undefined) {
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
      title="Folder summary"
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
          <div className="flex items-center gap-2">
            <AiLanguageSelect />
            <Button size="sm" icon={RefreshCw} onClick={rebuild} disabled={!hasKey || !!autoBusy} title="Rebuild from every meeting summary in the folder">
              Rebuild from all meetings
            </Button>
          </div>
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
  const [messages, setMessages] = useState<ChatMessage[] | undefined>(undefined);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<{ question: string; text: string; tool: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [costs, setCosts] = useState<Record<number, string>>({});
  const [confirmClear, setConfirmClear] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const { start, stop } = useAbortable();

  useEffect(() => {
    setMessages(undefined);
    db.listChatMessages('folder', folder.id)
      .then(setMessages)
      .catch((err) => {
        setMessages([]);
        setError(errorMessage(err));
      });
  }, [folder.id]);

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
        onText: (t) => setPending((p) => (p ? { ...p, text: t, tool: null } : p)),
        onTool: (call) => {
          const q = typeof call.input.query === 'string' ? `: ${call.input.query}` : '';
          setPending((p) => (p ? { ...p, tool: `${TOOL_LABEL[call.name] ?? call.name}${q}` } : p));
        },
      });
      setMessages((m) => [...(m ?? []), ex.question, ex.answer]);
      setCosts((c) => ({ ...c, [ex.answer.id]: `${ex.model} · ${formatUsd(ex.costUsd)}` }));
    } catch (err) {
      setInput((cur) => cur || question);
      if (!isAbortError(err)) setError(errorMessage(err));
    } finally {
      setPending(null);
    }
  };

  const clear = async () => {
    try {
      await db.clearChat('folder', folder.id);
      setMessages([]);
      setCosts({});
      setConfirmClear(false);
    } catch (err) {
      toast(`Couldn't clear the chat: ${errorMessage(err)}`, 'error');
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

  return (
    <Card
      title="Chat"
      description="Ask across every meeting in this folder. The AI searches the transcripts and links to the lines it uses."
      padded={false}
      actions={
        <div className="flex items-center gap-2">
          <AiLanguageSelect />
          {messages.length > 0 && (
            <Button size="sm" variant="ghost" icon={Trash2} disabled={!!pending} onClick={() => setConfirmClear(true)}>
              Clear chat
            </Button>
          )}
        </div>
      }
    >
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
          <ChatBubble key={m.id} role={m.role} text={m.content} meta={costs[m.id]} cite={cite} />
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
        {error && (
          <Callout tone="error" className="mb-3">
            <p className="break-words">{error}</p>
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

      <Modal
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        title="Clear chat?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmClear(false)}>
              Cancel
            </Button>
            <Button variant="danger" icon={Trash2} onClick={clear}>
              Clear
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">This deletes all questions and answers for this folder.</p>
      </Modal>
    </Card>
  );
}

// ---------- Briefing ----------

// Folder-wide context for every AI request about its meetings; saved on blur.
export function FolderBriefingCard({ folder }: { folder: Folder }) {
  const saved = folder.briefing ?? '';
  const [value, setValue] = useState(saved);
  const [saving, setSaving] = useState(false);

  useEffect(() => setValue(folder.briefing ?? ''), [folder.id, folder.briefing]);

  const save = async () => {
    const next = value.trim() ? value.trim() : null;
    if ((next ?? '') === saved.trim()) return;
    setSaving(true);
    try {
      await db.setFolderBriefing(folder.id, next);
      await refreshFolders();
    } catch (err) {
      toast(`Couldn't save the briefing: ${errorMessage(err)}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title="Folder briefing"
      description="Who you are and what this series of meetings is about. Added to every AI request for meetings in this folder."
      actions={saving ? <Spinner size={14} /> : <Sparkles size={14} className="text-faint" />}
    >
      <Textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        rows={3}
        placeholder="e.g. Weekly syncs with Acme about the website relaunch. I'm the agency's project lead."
        className="resize-y text-[13px]"
      />
    </Card>
  );
}

export function FolderTermsCard({ folder }: { folder: Folder }) {
  const save = async (terms: string[]) => {
    try {
      await db.setFolderTerms(folder.id, terms);
      await refreshFolders();
    } catch (err) {
      toast(`Couldn't save the vocabulary: ${errorMessage(err)}`, 'error');
    }
  };
  return (
    <Card
      title="Folder vocabulary"
      description="Names and terms the transcriber should know for every meeting in this folder, added to your default list (Settings → Language)."
    >
      <TermsField terms={folder.terms} onSave={save} placeholder={'Client and colleague names, product names…\nOne term per line'} />
    </Card>
  );
}
