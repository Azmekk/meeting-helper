// AI tabs on the meeting screen (Summary, Chat) plus the per-meeting briefing.
// Requests stay alive while switching tabs (panels stay mounted) and are
// aborted when the meeting screen unmounts.
import { AiLanguageSelect } from '../ai/AiLanguageSelect';
import { ArrowUp, KeyRound, MessageSquare, Play, RefreshCw, Sparkles, Square, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Callout, Card, EmptyState, IconButton, Modal, Spinner, Textarea, errorMessage, toast } from '../ui';
import * as db from '../../lib/db';
import { formatDate, formatTimestamp, formatUsd } from '../../lib/format';
import { askMeeting, hasAiKey, isAbortError, summarizeMeeting } from '../../lib/ai/meeting';
import { effectiveModel } from '../../lib/ai';
import { useSettings } from '../../lib/settings';
import type { AiDoc, ChatMessage, Meeting } from '../../lib/types';
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
  const summaryModel = useSettings((s) => effectiveModel('summary', s.settings));
  const [doc, setDoc] = useState<AiDoc | null | undefined>(undefined);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { start, stop } = useAbortable();

  useEffect(() => {
    setDoc(undefined);
    db.getAiDoc('meeting', meetingId, 'summary')
      .then(setDoc)
      .catch((err) => {
        setDoc(null);
        setError(errorMessage(err));
      });
  }, [meetingId]);

  const generate = async () => {
    const signal = start();
    setError(null);
    setStreaming('');
    try {
      const saved = await summarizeMeeting(meetingId, { signal, onText: setStreaming });
      setDoc(saved);
      toast('Summary ready', 'success');
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
  if (!doc && !busy && !hasText) return <NoTranscriptNotice />;

  return (
    <Card
      title="Summary"
      description={
        busy
          ? `Writing with ${summaryModel}…`
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
          <div className="flex items-center gap-2">
            <AiLanguageSelect />
            {doc && (
              <Button size="sm" icon={RefreshCw} onClick={generate} disabled={!hasKey || !hasText} title={!hasKey ? 'Add an AI key in Settings' : undefined}>
                Regenerate
              </Button>
            )}
          </div>
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
            Uses <span className="font-medium text-text">{summaryModel || 'the summary model'}</span>. Add a briefing on the left to tell the AI who you are and what matters.
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

export function ChatPanel({ meetingId, hasText, cite }: { meetingId: number; hasText: boolean; cite: CiteProps }) {
  const hasKey = useAiKey();
  const [messages, setMessages] = useState<ChatMessage[] | undefined>(undefined);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<{ question: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [costs, setCosts] = useState<Record<number, string>>({});
  const [confirmClear, setConfirmClear] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const { start, stop } = useAbortable();

  useEffect(() => {
    setMessages(undefined);
    db.listChatMessages('meeting', meetingId)
      .then(setMessages)
      .catch((err) => {
        setMessages([]);
        setError(errorMessage(err));
      });
  }, [meetingId]);

  // Keep the newest text in view unless the user scrolled up to read.
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
    setPending({ question, text: '' });
    try {
      const ex = await askMeeting(meetingId, question, {
        signal,
        onText: (t) => setPending((p) => (p ? { ...p, text: t } : p)),
      });
      setMessages((m) => [...(m ?? []), ex.question, ex.answer]);
      setCosts((c) => ({ ...c, [ex.answer.id]: `${ex.model} · ${formatUsd(ex.costUsd)}` }));
    } catch (err) {
      // Nothing was saved; give the question back so it can be retried.
      setInput((cur) => cur || question);
      if (!isAbortError(err)) setError(errorMessage(err));
    } finally {
      setPending(null);
    }
  };

  const clear = async () => {
    try {
      await db.clearChat('meeting', meetingId);
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
  if (!hasText && !messages.length) return <NoTranscriptNotice />;

  const canSend = hasKey && hasText && !pending;

  return (
    <Card
      title="Chat"
      description="Ask anything about this meeting. Answers link to the lines they come from."
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
                <Spinner /> Thinking…
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
            disabled={!hasKey || !hasText}
            placeholder="Ask about this meeting (Enter to send, Shift+Enter for a new line)"
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
        <p className="text-sm text-muted">This deletes all questions and answers for this meeting.</p>
      </Modal>
    </Card>
  );
}

export function ChatBubble({ role, text, meta, cite }: { role: ChatMessage['role']; text: string; meta?: string; cite: CiteProps }) {
  if (role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent-soft px-3.5 py-2 text-sm whitespace-pre-wrap text-text">{text}</div>
      </div>
    );
  }
  return (
    <div className="max-w-[95%]">
      <AiMarkdown text={text} {...cite} />
      {meta && <div className="mt-1 text-[11px] text-faint">{meta}</div>}
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
    <div className="mb-4 flex items-start gap-3 rounded-lg border border-line bg-panel px-3.5 py-2.5 text-[13px] shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <Play size={14} className="mt-0.5 shrink-0 text-accent" />
      <div className="min-w-0 flex-1">
        <span className="mr-2 text-faint tabular-nums">{formatTimestamp(target.startMs)}</span>
        <span className="mr-1.5 font-medium">{target.speaker}:</span>
        <span className="text-muted">{target.text}</span>
      </div>
      <Button size="sm" variant="ghost" onClick={onShow}>
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
