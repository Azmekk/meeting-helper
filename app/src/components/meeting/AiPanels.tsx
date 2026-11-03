// AI tabs on the meeting screen (Summary, Chat) plus the per-meeting briefing.
// Requests stay alive while switching tabs (panels stay mounted) and are
// aborted when the meeting screen unmounts.
import { AiLanguageSelect } from '../ai/AiLanguageSelect';
import { AiModelSelect, rememberAiModel, useAiModel } from '../ai/AiModelSelect';
import { ChatCacheLine, ConversationBar, ProposalCard, answerMeta, useCacheStatus, useConversations } from '../ai/ChatParts';
import { SummaryHistoryControls, useSummaryHistory } from '../ai/SummaryHistory';
import { ArrowUp, KeyRound, MessageSquare, Play, RefreshCw, Sparkles, Square, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Callout, Card, EmptyState, IconButton, Spinner, Textarea, errorMessage, toast } from '../ui';
import * as db from '../../lib/db';
import { formatDate, formatTimestamp, formatUsd } from '../../lib/format';
import { askMeeting, hasAiKey, isAbortError, meetingCacheStatus, onMeetingSummarized, startSummary, stopSummary, useSummaryJobs } from '../../lib/ai/meeting';
import { useSettings } from '../../lib/settings';
import type { ChatMessage, Meeting } from '../../lib/types';
import { AiMarkdown, type CiteProps, type CiteTarget } from './AiMarkdown';

// undefined while checking. Re-checked when the AI provider setting changes.
export function useAiKey(): boolean | undefined {
  const provider = useSettings((s) => s.settings.aiProvider);
  const [has, setHas] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    hasAiKey()
      .then((v) => alive && setHas(v))
      .catch(() => alive && setHas(false));
    return () => {
      alive = false;
    };
  }, [provider]);
  return has;
}

// Aborts the in-flight request on unmount.
export function useAbortable() {
  const ref = useRef<AbortController | null>(null);
  useEffect(() => () => ref.current?.abort(), []);
  const start = useCallback(() => {
    ref.current?.abort();
    ref.current = new AbortController();
    return ref.current.signal;
  }, []);
  const stop = useCallback(() => ref.current?.abort(), []);
  return { start, stop };
}

export function NoKeyNotice() {
  const navigate = useNavigate();
  return (
    <Card>
      <EmptyState
        icon={KeyRound}
        title="Add an AI key to use this"
        description="Summaries and chat use your own key from Anthropic, OpenAI, DeepSeek or an OpenAI-compatible service."
        action={
          <Button variant="primary" onClick={() => navigate('/settings?tab=ai')}>
            Open AI settings
          </Button>
        }
      />
    </Card>
  );
}

function NoTranscriptNotice() {
  return (
    <Card>
      <EmptyState icon={Sparkles} title="Nothing to work with yet" description="This transcript has no text, so there's nothing for the AI to read." />
    </Card>
  );
}

// ---------- Summary ----------

export function SummaryPanel({ meetingId, hasText, cite }: { meetingId: number; hasText: boolean; cite: CiteProps }) {
  const hasKey = useAiKey();
  const [model, setModel] = useAiModel();
  const { docs, doc, select, showNewest, reload, loadError } = useSummaryHistory('meeting', meetingId, 'summary');
  // The run itself lives in lib/ai/meeting.ts, so leaving this tab doesn't stop it.
  const job = useSummaryJobs((s) => s[meetingId]);
  const streaming = job?.running ? job.text : null;
  const error = job?.error ?? loadError;

  // A run started here, in the "Recording saved" dialog or before leaving the tab.
  useEffect(
    () =>
      onMeetingSummarized((id) => {
        if (id !== meetingId) return;
        showNewest();
        void reload();
      }),
    [meetingId, reload, showNewest],
  );

  const generate = async () => {
    if (await startSummary(meetingId, { model })) toast('Summary ready', 'success');
  };
  const stop = () => stopSummary(meetingId);

  if (!docs || hasKey === undefined) {
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    );
  }
  const busy = streaming !== null;
  if (!doc && !busy && !hasKey) return <NoKeyNotice />;
  if (!doc && !busy && !hasText) return <NoTranscriptNotice />;

  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          Summary
          {doc && !busy && <SummaryHistoryControls docs={docs} doc={doc} onSelect={select} onDeleted={() => void reload()} />}
        </span>
      }
      description={
        busy
          ? `Writing with ${job?.model || model}… You can leave this page; it keeps going.`
          : doc
            ? `${doc.model ?? 'Unknown model'} · ${formatUsd(doc.costUsd)} · ${formatDate(doc.createdAt)}`
            : 'Overview, decisions, action items and open questions, each linked to the transcript.'
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
            {doc && (
              <Button size="sm" icon={RefreshCw} onClick={generate} disabled={!hasKey || !hasText} title={!hasKey ? 'Add an AI key in Settings' : 'Writes a new summary. This one stays in the history.'}>
                Regenerate
              </Button>
            )}
          </>
        )
      }
    >
      {error && (
        <Callout tone="error" title="Couldn't generate the summary" className="mb-4">
          <p className="break-words">{error}</p>
        </Callout>
      )}
      {busy ? (
        streaming ? (
          <AiMarkdown text={streaming} {...cite} />
        ) : (
          <div className="flex items-center gap-2 py-6 text-sm text-muted">
            <Spinner /> Reading the transcript…
          </div>
        )
      ) : doc ? (
        <AiMarkdown text={doc.content} {...cite} />
      ) : (
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <p className="max-w-sm text-[13px] text-muted">
            Uses <span className="font-medium text-text">{model || 'the summary model'}</span>. Add a briefing on the left to tell the AI who you are and what matters.
          </p>
          <Button variant="primary" icon={Sparkles} onClick={generate}>
            Generate summary
          </Button>
        </div>
      )}
    </Card>
  );
}

// ---------- Chat ----------

const SUGGESTIONS = ['What did I commit to?', 'What were the main disagreements?', 'Write a short follow-up email.'];

export function ChatPanel({
  meetingId,
  folderId,
  hasText,
  cite,
  draft,
}: {
  meetingId: number;
  folderId: number | null;
  hasText: boolean;
  cite: CiteProps;
  draft?: { text: string; nonce: number } | null; // "Ask about this" on a task
}) {
  const hasKey = useAiKey();
  const chat = useConversations('meeting', meetingId);
  const { messages } = chat;
  const memory = `chat:meeting:${chat.activeId ?? meetingId}`;
  const [model, setModel] = useAiModel('summary', memory);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<{ question: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const { start, stop } = useAbortable();

  useEffect(() => {
    if (!draft) return;
    setInput(draft.text);
    inputRef.current?.focus();
  }, [draft]);

  // Keep the newest text in view unless the user scrolled up to read.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  const loadCache = useCallback(() => meetingCacheStatus(meetingId, chat.activeId, model), [meetingId, chat.activeId, model]);
  const cache = useCacheStatus(loadCache, !!hasText && !!hasKey, pending);

  const send = async (text = input) => {
    const question = text.trim();
    if (!question || pending) return;
    const signal = start();
    setError(null);
    setInput('');
    stick.current = true;
    setPending({ question, text: '' });
    try {
      const ex = await askMeeting(meetingId, question, {
        signal,
        model,
        conversationId: chat.activeId,
        onText: (t) => setPending((p) => (p ? { ...p, text: t } : p)),
      });
      rememberAiModel(`chat:meeting:${ex.conversationId}`, model);
      await chat.add(ex);
    } catch (err) {
      // Nothing was saved; give the question back so it can be retried.
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
  if (!hasText && !messages.length) return <NoTranscriptNotice />;

  const canSend = hasKey && hasText && !pending;
  const shownError = error ?? chat.loadError;

  return (
    <Card
      title="Chat"
      description="Ask anything about this meeting."
      padded={false}
      className="flex min-h-0 flex-1 flex-col"
      bodyClassName="flex min-h-0 flex-1 flex-col"
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
        className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5"
      >
        {!messages.length && !pending && (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-fill text-muted"><MessageSquare size={20} /></span>
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
            <ChatBubble role={m.role} text={m.content} meta={answerMeta(m)} cite={cite} />
            {m.proposal && folderId != null && <ProposalCard message={m} folderId={folderId} meetingId={meetingId} onChange={chat.setProposal} />}
          </div>
        ))}
        {pending && (
          <>
            <ChatBubble role="user" text={pending.question} cite={cite} />
            {pending.text ? (
              <ChatBubble role="assistant" text={pending.text} cite={cite} />
            ) : (
              <div className="flex items-center gap-2 text-[13px] text-muted">
                <Spinner /> Thinking…
              </div>
            )}
          </>
        )}
      </div>

      <div className="border-t border-line px-5 py-3.5">
        {shownError && (
          <Callout tone="error" className="mb-3">
            <p className="break-words">{shownError}</p>
          </Callout>
        )}
        <ChatCacheLine status={cache} conversation={chat.conversations.find((c) => c.id === chat.activeId)} />
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
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (canSend) send();
              }
            }}
            rows={2}
            disabled={!hasKey || !hasText}
            placeholder="Ask about this meeting (Enter to send, Shift+Enter for a new line)"
            className="max-h-40 min-h-[2.5rem] resize-y rounded-[20px] text-[14px]"
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

export function ChatBubble({ role, text, meta, cite }: { role: ChatMessage['role']; text: string; meta?: string; cite: CiteProps }) {
  if (role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-[20px] rounded-br-md bg-accent px-4 py-2 text-[15px] leading-snug whitespace-pre-wrap text-on-accent">{text}</div>
      </div>
    );
  }
  return (
    <div className="max-w-[95%]">
      <AiMarkdown text={text} {...cite} />
      {meta && <div className="mt-1.5 text-[11.5px] text-muted">{meta}</div>}
    </div>
  );
}

// ---------- Cited line preview ----------

// Shown above the AI tabs after clicking a citation: what was said, with a way
// to jump to it in the transcript.
export function CitedLine({
  target,
  onShow,
  onClose,
}: {
  target: CiteTarget;
  onShow: () => void;
  onClose: () => void;
}) {
  return (
    <div className="surface mb-3 flex shrink-0 items-center gap-3 rounded-2xl py-2 pr-2 pl-3 text-[13px]">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-ink"><Play size={13} className="translate-x-px" /></span>
      <div className="line-clamp-2 min-w-0 flex-1" title={target.text}>
        <span className="mr-2 rounded-full bg-accent-soft px-[7px] py-px text-[12px] font-semibold text-accent-ink tabular-nums">{formatTimestamp(target.startMs)}</span>
        <span className="mr-1.5 font-medium">{target.speaker}:</span>
        <span className="text-muted">{target.text}</span>
      </div>
      <Button size="sm" variant="secondary" onClick={onShow}>
        Show in transcript
      </Button>
      <IconButton size="sm" icon={X} label="Close" onClick={onClose} />
    </div>
  );
}

// ---------- Briefing ----------

// Free-text context for every AI prompt about this meeting; saved on blur.
export function BriefingCard({ meeting, onSaved }: { meeting: Meeting; onSaved: (briefing: string | null) => void }) {
  const saved = meeting.briefing ?? '';
  const [value, setValue] = useState(saved);
  const [saving, setSaving] = useState(false);

  useEffect(() => setValue(meeting.briefing ?? ''), [meeting.id, meeting.briefing]);

  const save = async () => {
    const next = value.trim() ? value.trim() : null;
    if ((next ?? '') === saved.trim()) return;
    setSaving(true);
    try {
      await db.updateMeeting(meeting.id, { briefing: next });
      onSaved(next);
    } catch (err) {
      toast(`Couldn't save the briefing: ${errorMessage(err)}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title="Briefing"
      description="Who you are, the context and your goals. Added to every AI request for this meeting."
      actions={saving ? <Spinner size={14} /> : null}
    >
      <Textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        rows={3}
        placeholder="e.g. I'm the product manager. This is the weekly sync with the agency; I care about deadlines and budget."
        className="resize-y text-[13px]"
      />
    </Card>
  );
}
