// Text pieces of the phone page: transcript lines and the notes, memoized so a
// delta only re-renders what changed.
import { memo, useMemo } from 'react';
import { clsx } from '../components/ui';
import type { LiveLine, LivePartial } from '../lib/live';

// **bold** inside model output.
export function InlineBold({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
        /^\*\*[^*]+\*\*$/.test(part) ? (
          <b key={i} className="font-semibold">
            {part.slice(2, -2)}
          </b>
        ) : (
          part
        ),
      )}
    </>
  );
}

function speakerColor(speaker: string, isSelf: boolean): string | undefined {
  if (isSelf) return undefined; // accent via class
  let h = 0;
  for (let i = 0; i < speaker.length; i++) h = (h * 31 + speaker.charCodeAt(i)) | 0;
  return `var(--spk-${Math.abs(h) % 4})`;
}

// Finished lines never change, and the phone keeps their objects across deltas.
export const Line = memo(function Line({ line }: { line: LiveLine }) {
  return (
    <p className="m-0 text-[17px] leading-[1.45] text-text">
      <span className={clsx('mr-1.5 font-semibold', line.isSelf && 'text-accent')} style={{ color: speakerColor(line.speaker, line.isSelf) }}>
        {line.speaker}
      </span>
      {line.text}
    </p>
  );
});

export function PartialLine({ partial }: { partial: LivePartial }) {
  return (
    <p className="m-0 text-[17px] leading-[1.45] text-text">
      <span className="mr-1.5 font-semibold text-muted">{partial.speaker}</span>
      {partial.final}
      <span className="text-faint">{partial.provisional}</span>
    </p>
  );
}

type Block = { kind: 'h'; text: string } | { kind: 'p'; text: string } | { kind: 'ul'; items: string[] };

function parseNotes(text: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const bullet = /^(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    const heading = /^#{1,6}\s+(.*)$/.exec(line) ?? /^\*\*([^*]+)\*\*:?$/.exec(line);
    if (bullet) {
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'ul') last.items.push(bullet[1]);
      else blocks.push({ kind: 'ul', items: [bullet[1]] });
    } else if (heading) {
      blocks.push({ kind: 'h', text: heading[1].replace(/:$/, '') });
    } else {
      blocks.push({ kind: 'p', text: line });
    }
  }
  return blocks;
}

// Re-parsed only when the notes text changes.
export const Notes = memo(function Notes({ text }: { text: string }) {
  const blocks = useMemo(() => parseNotes(text), [text]);
  return (
    <div className="space-y-4 text-[17px] leading-normal text-text">
      {blocks.map((b, i) =>
        b.kind === 'h' ? (
          <h2 key={i} className="m-0 -mb-2 pt-1 text-[13px] font-semibold tracking-[0.04em] text-muted uppercase">
            {b.text}
          </h2>
        ) : b.kind === 'ul' ? (
          <ul key={i} className="m-0 list-disc space-y-1 pl-5 marker:text-faint">
            {b.items.map((it, j) => (
              <li key={j}>
                <InlineBold text={it} />
              </li>
            ))}
          </ul>
        ) : (
          <p key={i} className="m-0">
            <InlineBold text={b.text} />
          </p>
        ),
      )}
    </div>
  );
});
