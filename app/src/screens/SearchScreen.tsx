import { CalendarDays, ChevronRight, Search as SearchIcon, SearchX, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Badge, Callout, EmptyState, IconButton, PageHeader, Spinner, clsx, errorMessage } from '../components/ui';
import { search } from '../lib/db';
import { formatDate, formatTimestamp } from '../lib/format';
import { highlightTerms, splitHighlights } from '../lib/search';
import type { SearchHit } from '../lib/types';

const DEBOUNCE_MS = 250;
const LIMIT = 200;

interface MeetingGroup {
  meetingId: number;
  title: string;
  createdAt: string;
  hits: SearchHit[];
}

function groupByMeeting(hits: SearchHit[]): MeetingGroup[] {
  const groups: MeetingGroup[] = [];
  const byId = new Map<number, MeetingGroup>();
  for (const h of hits) {
    let g = byId.get(h.meetingId);
    if (!g) {
      g = { meetingId: h.meetingId, title: h.meetingTitle, createdAt: h.meetingCreatedAt, hits: [] };
      byId.set(h.meetingId, g);
      groups.push(g);
    }
    g.hits.push(h);
  }
  return groups;
}

export default function SearchScreen() {
  const [params, setParams] = useSearchParams();
  const urlQuery = params.get('q') ?? '';
  const [input, setInput] = useState(urlQuery);
  const [results, setResults] = useState<{ query: string; hits: SearchHit[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);

  // Back/forward navigation changes the URL: reflect it in the box.
  useEffect(() => {
    setInput((cur) => (cur.trim() === urlQuery.trim() ? cur : urlQuery));
  }, [urlQuery]);

  // Debounce typing into the URL (replace, so history isn't flooded).
  useEffect(() => {
    if (input.trim() === urlQuery.trim()) return;
    const t = setTimeout(() => {
      const q = input.trim();
      setParams(q ? { q } : {}, { replace: true });
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [input, urlQuery, setParams]);

  // Run the search whenever the URL query changes.
  useEffect(() => {
    const q = urlQuery.trim();
    const id = ++requestId.current;
    if (!q) {
      setResults(null);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    search(q, LIMIT)
      .then((hits) => {
        if (id !== requestId.current) return;
        setResults({ query: q, hits });
        setError(null);
      })
      .catch((err) => {
        if (id !== requestId.current) return;
        setError(errorMessage(err));
        setResults(null);
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false);
      });
  }, [urlQuery]);

  const groups = useMemo(() => (results ? groupByMeeting(results.hits) : []), [results]);
  const terms = useMemo(() => (results ? highlightTerms(results.query) : []), [results]);

  const runExample = (q: string) => {
    setInput(q);
    setParams({ q }, { replace: true });
    inputRef.current?.focus();
  };

  const clear = () => {
    setInput('');
    setParams({}, { replace: true });
    inputRef.current?.focus();
  };

  const hasQuery = urlQuery.trim().length > 0;
  const total = results?.hits.length ?? 0;

  return (
    <div className="mx-auto max-w-4xl px-8 py-8">
      <PageHeader title="Search" description="Find anything that was said, in every meeting." />

      <div className="relative">
        <SearchIcon size={18} className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-faint" />
        <input
          ref={inputRef}
          autoFocus
          type="search"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && input) {
              e.preventDefault();
              clear();
            }
          }}
          placeholder="Search transcripts…"
          spellCheck={false}
          className={clsx(
            'h-12 w-full rounded-xl border border-line bg-panel pr-12 pl-11 text-[15px] text-text shadow-sm',
            'placeholder:text-faint transition-colors hover:border-faint',
            'focus:border-accent focus:ring-2 focus:ring-accent-soft focus:outline-none',
            '[&::-webkit-search-cancel-button]:hidden',
          )}
        />
        <div className="absolute top-1/2 right-3 flex -translate-y-1/2 items-center">
          {loading ? (
            <Spinner size={16} className="mr-1.5" />
          ) : input ? (
            <IconButton icon={X} label="Clear search" size="sm" onClick={clear} />
          ) : null}
        </div>
      </div>

      <div className="mt-6">
        {error ? (
          <Callout tone="error" title="Search failed">
            {error}
          </Callout>
        ) : !hasQuery ? (
          <SearchTips onExample={runExample} />
        ) : !results ? (
          <div className="flex justify-center py-16">
            <Spinner size={20} />
          </div>
        ) : total === 0 ? (
          <EmptyState
            icon={SearchX}
            title="No matches"
            description={
              <>
                Nothing in your transcripts matches <span className="font-medium text-text">“{results.query}”</span>.
                Try fewer words or a shorter form of the word.
              </>
            }
          />
        ) : (
          <div className={clsx('space-y-5 transition-opacity', loading && 'opacity-60')}>
            <div className="text-[13px] text-muted">
              {total >= LIMIT ? `First ${LIMIT} matches` : `${total} ${total === 1 ? 'match' : 'matches'}`} in{' '}
              {groups.length} {groups.length === 1 ? 'meeting' : 'meetings'}
            </div>
            {groups.map((g) => (
              <MeetingResults key={g.meetingId} group={g} terms={terms} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MeetingResults({ group, terms }: { group: MeetingGroup; terms: string[] }) {
  const navigate = useNavigate();
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-panel shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <button
        type="button"
        onClick={() => navigate(`/meetings/${group.meetingId}`)}
        className="group flex w-full items-center gap-3 border-b border-line px-5 py-3.5 text-left transition-colors hover:bg-hover/50"
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold">{group.title || 'Untitled meeting'}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
            <CalendarDays size={12} />
            {formatDate(group.createdAt)}
          </div>
        </div>
        <Badge tone="accent">
          {group.hits.length} {group.hits.length === 1 ? 'hit' : 'hits'}
        </Badge>
        <ChevronRight size={16} className="text-faint transition-colors group-hover:text-muted" />
      </button>
      <ul className="divide-y divide-line">
        {group.hits.map((h) => (
          <li key={h.segmentId}>
            <button
              type="button"
              onClick={() => navigate(`/meetings/${h.meetingId}?t=${h.startMs}&seg=${h.segmentId}`)}
              className="flex w-full gap-4 px-5 py-3 text-left transition-colors hover:bg-hover/50 focus-visible:bg-hover/50"
            >
              <span className="mt-0.5 h-fit shrink-0 rounded-md bg-sunken px-1.5 py-0.5 font-mono text-[12px] text-muted tabular-nums">
                {formatTimestamp(h.startMs)}
              </span>
              <div className="min-w-0 flex-1">
                {h.speakerName && <div className="mb-0.5 text-xs font-medium text-muted">{h.speakerName}</div>}
                <p className="text-sm leading-relaxed break-words text-text">
                  <Highlighted text={h.text} terms={terms} />
                </p>
              </div>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Highlighted({ text, terms }: { text: string; terms: string[] }) {
  const parts = useMemo(() => splitHighlights(text, terms), [text, terms]);
  return (
    <>
      {parts.map((p, i) =>
        p.match ? (
          <mark key={i} className="rounded-[3px] bg-highlight px-0.5 text-text">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

const EXAMPLES = ['среща', 'проект', 'deploy', '"next sprint"'];

function SearchTips({ onExample }: { onExample: (q: string) => void }) {
  return (
    <div className="rounded-xl border border-line bg-panel px-6 py-5">
      <div className="text-sm font-medium">Search tips</div>
      <ul className="mt-3 space-y-2 text-[13px] leading-relaxed text-muted">
        <li>
          <span className="font-medium text-text">Word endings are matched.</span> Searching{' '}
          <span className="text-text">среща</span> also finds <span className="text-text">срещата</span> and{' '}
          <span className="text-text">срещи</span>; parts of words match too, so <span className="text-text">deploy</span>{' '}
          finds <span className="text-text">deployment</span>.
        </li>
        <li>
          <span className="font-medium text-text">All words must appear</span> in the same segment, in any order. Case
          doesn't matter.
        </li>
        <li>
          <span className="font-medium text-text">Use quotes for an exact phrase</span>, e.g.{' '}
          <span className="text-text">"next sprint"</span>.
        </li>
      </ul>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="text-xs text-faint">Try</span>
        {EXAMPLES.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => onExample(q)}
            className="rounded-full border border-line bg-sunken px-2.5 py-0.5 text-xs text-muted transition-colors hover:border-faint hover:text-text"
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}
