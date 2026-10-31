// Minimal Markdown renderer for AI output: headings, lists, quotes, bold,
// italic, code and [#segId] citation chips. React escapes all text, so model
// output can't inject HTML.
import type { ReactNode } from 'react';
import { clsx } from '../ui';
import { formatTimestamp } from '../../lib/format';
import { parseCitations } from '../../lib/ai/prompts';

export interface CiteTarget {
  startMs: number;
  speaker: string;
  text: string;
}

export interface CiteProps {
  resolve: (segId: number) => CiteTarget | null;
  onCite: (segId: number) => void;
}

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'list'; ordered: boolean; items: { text: string; indent: number }[] }
  | { type: 'quote'; text: string }
  | { type: 'hr' }
  | { type: 'p'; text: string };

function parseBlocks(src: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ type: 'p', text: para.join(' ') });
    para = [];
  };
  for (const raw of src.replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^(\s*)[-*+•]\s+(.*)$/.exec(line);
    const numbered = /^(\s*)\d+[.)]\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].replace(/\s*#+$/, '') });
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push({ type: 'hr' });
    } else if (bullet || numbered) {
      flush();
      const m = (bullet ?? numbered)!;
      const ordered = !bullet;
      const item = { text: m[2], indent: Math.min(3, Math.floor(m[1].replace(/\t/g, '  ').length / 2)) };
      const last = blocks[blocks.length - 1];
      if (last?.type === 'list' && (last.ordered === ordered || item.indent > 0)) last.items.push(item);
      else blocks.push({ type: 'list', ordered, items: [item] });
    } else if (/^\s*>/.test(line)) {
      flush();
      const text = line.replace(/^\s*>\s?/, '');
      const last = blocks[blocks.length - 1];
      if (last?.type === 'quote') last.text += ` ${text}`;
      else blocks.push({ type: 'quote', text });
    } else {
      // A wrapped line continues the previous list item.
      const last = blocks[blocks.length - 1];
      if (!para.length && last?.type === 'list' && /^\s+/.test(raw)) last.items[last.items.length - 1].text += ` ${line.trim()}`;
      else para.push(line.trim());
    }
  }
  flush();
  return blocks;
}

const INLINE_RE = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;

function renderEmphasis(text: string, key: string): ReactNode[] {
  return text.split(INLINE_RE).map((part, i) => {
    const k = `${key}-${i}`;
    if (!part) return null;
    if ((part.startsWith('**') && part.endsWith('**')) || (part.startsWith('__') && part.endsWith('__')))
      return (
        <strong key={k} className="font-semibold text-text">
          {part.slice(2, -2)}
        </strong>
      );
    if (part.startsWith('`') && part.endsWith('`'))
      return (
        <code key={k} className="rounded-md bg-fill px-1.5 py-0.5 font-mono text-[0.88em]">
          {part.slice(1, -1)}
        </code>
      );
    if (part.length > 2 && ((part.startsWith('*') && part.endsWith('*')) || (part.startsWith('_') && part.endsWith('_'))))
      return <em key={k}>{part.slice(1, -1)}</em>;
    return part;
  });
}

export function CiteChip({ segId, resolve, onCite }: { segId: number } & CiteProps) {
  const target = resolve(segId);
  if (!target) {
    return (
      <span
        title="This line isn't in the current transcript"
        className="ml-1 inline-block rounded-full bg-fill px-[7px] align-baseline text-[12px] leading-5 font-semibold text-muted tabular-nums line-through"
      >
        #{segId}
      </span>
    );
  }
  const preview = target.text.length > 160 ? `${target.text.slice(0, 160)}…` : target.text;
  return (
    <button
      type="button"
      onClick={() => onCite(segId)}
      title={`${target.speaker}: ${preview}`}
      className="ml-1 inline-block rounded-full bg-accent-soft px-[7px] align-baseline text-[12px] leading-5 font-semibold text-accent-ink tabular-nums transition-colors hover:bg-accent hover:text-on-accent"
    >
      {formatTimestamp(target.startMs)}
    </button>
  );
}

function renderInline(text: string, cite: CiteProps, key: string): ReactNode[] {
  return parseCitations(text).map((part, i) =>
    part.type === 'cite' ? (
      <CiteChip key={`${key}-c${i}`} segId={part.segId} {...cite} />
    ) : (
      <span key={`${key}-t${i}`}>{renderEmphasis(part.text, `${key}-t${i}`)}</span>
    ),
  );
}

export function AiMarkdown({ text, className, ...cite }: { text: string; className?: string } & CiteProps) {
  const blocks = parseBlocks(text);
  return (
    <div className={clsx('space-y-3 text-[15px] leading-[1.6] text-text', className)}>
      {blocks.map((b, i) => {
        const key = String(i);
        switch (b.type) {
          case 'heading':
            return b.level <= 2 ? (
              <h3 key={key} className="pt-3 text-[13px] font-semibold tracking-[0.04em] text-muted uppercase first:pt-0">
                {renderInline(b.text, cite, key)}
              </h3>
            ) : (
              <h4 key={key} className="pt-1 text-[15px] font-semibold first:pt-0">
                {renderInline(b.text, cite, key)}
              </h4>
            );
          case 'list': {
            const Tag = b.ordered ? 'ol' : 'ul';
            return (
              <Tag key={key} className={clsx('space-y-1.5 pl-5', b.ordered ? 'list-decimal' : 'list-disc', 'marker:text-faint')}>
                {b.items.map((it, j) => (
                  <li key={j} style={it.indent ? { marginLeft: `${it.indent * 1.25}rem` } : undefined}>
                    {renderInline(it.text, cite, `${key}-${j}`)}
                  </li>
                ))}
              </Tag>
            );
          }
          case 'quote':
            return (
              <blockquote key={key} className="rounded-r-xl border-l-[3px] border-accent/40 bg-fill py-1.5 pr-3 pl-3 text-muted">
                {renderInline(b.text, cite, key)}
              </blockquote>
            );
          case 'hr':
            return <hr key={key} className="border-line" />;
          default:
            return <p key={key}>{renderInline(b.text, cite, key)}</p>;
        }
      })}
    </div>
  );
}
