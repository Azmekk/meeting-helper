// Word and character error rate against a hand-checked reference transcript.

export type ErrorRate = { rate: number; sub: number; del: number; ins: number; refLength: number };

export type Score = { wer: ErrorRate; cer?: ErrorRate };

// Character-level edit distance is O(n*m); skip it for very long texts.
const MAX_CER_CELLS = 4e8;

// Lines copied from a generated .txt start with "[00:12] Speaker 1: ". Strip
// that so a reference can be made by correcting one of the outputs.
const LINE_PREFIX = /^\s*\[\d+(?::\d+){1,2}\]\s*[^:\n]{1,40}:\s*/gm;

export function normalize(text: string): string {
  return text
    .replace(LINE_PREFIX, '')
    .normalize('NFC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Levenshtein distance with a substitution/deletion/insertion breakdown,
// keeping only two rows in memory.
function editCounts(ref: string[], hyp: string[]): ErrorRate {
  const m = hyp.length;
  let prev = { cost: new Uint32Array(m + 1), sub: new Uint32Array(m + 1), del: new Uint32Array(m + 1), ins: new Uint32Array(m + 1) };
  let cur = { cost: new Uint32Array(m + 1), sub: new Uint32Array(m + 1), del: new Uint32Array(m + 1), ins: new Uint32Array(m + 1) };
  for (let j = 0; j <= m; j++) prev.cost[j] = prev.ins[j] = j;

  for (let i = 1; i <= ref.length; i++) {
    cur.cost[0] = cur.del[0] = i;
    cur.sub[0] = cur.ins[0] = 0;
    for (let j = 1; j <= m; j++) {
      let from: typeof prev, k: number, op: 'sub' | 'del' | 'ins' | null;
      if (ref[i - 1] === hyp[j - 1]) {
        from = prev; k = j - 1; op = null;
      } else {
        const s = prev.cost[j - 1], d = prev.cost[j], n = cur.cost[j - 1];
        if (s <= d && s <= n) { from = prev; k = j - 1; op = 'sub'; }
        else if (d <= n) { from = prev; k = j; op = 'del'; }
        else { from = cur; k = j - 1; op = 'ins'; }
      }
      cur.cost[j] = from.cost[k] + (op ? 1 : 0);
      cur.sub[j] = from.sub[k] + (op === 'sub' ? 1 : 0);
      cur.del[j] = from.del[k] + (op === 'del' ? 1 : 0);
      cur.ins[j] = from.ins[k] + (op === 'ins' ? 1 : 0);
    }
    [prev, cur] = [cur, prev];
  }
  return {
    rate: ref.length ? prev.cost[m] / ref.length : 0,
    sub: prev.sub[m],
    del: prev.del[m],
    ins: prev.ins[m],
    refLength: ref.length,
  };
}

export function score(reference: string, hypothesis: string): Score {
  const ref = normalize(reference);
  const hyp = normalize(hypothesis);
  const wer = editCounts(ref.split(' ').filter(Boolean), hyp.split(' ').filter(Boolean));
  const refChars = Array.from(ref);
  const hypChars = Array.from(hyp);
  const cer = refChars.length * hypChars.length <= MAX_CER_CELLS ? editCounts(refChars, hypChars) : undefined;
  return { wer, cer };
}
