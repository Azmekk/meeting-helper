// OWNER: data agent. Query parsing for full-text search over transcripts.
//
// The index is an FTS5 table with the `trigram` tokenizer, so every query
// string of 3+ characters matches as a case-insensitive substring (Cyrillic
// included: the trigram tokenizer folds Unicode case). On top of that,
// Bulgarian words change their endings (среща / срещата / срещи), so for every
// bare term of 5+ characters we also search a stem with the common ending
// stripped. Terms shorter than 3 characters can't use trigrams; they are
// matched with instr() over every upper/lower-case variant instead (SQLite's
// LIKE and lower() only fold ASCII).
//
// Pure module (no Tauri imports) so it can be tested outside the app.

// Longest first: we strip the first one that leaves a long enough stem.
const BG_ENDINGS = [
  'ите', 'ата', 'ото', 'ете', 'ове', 'ища', 'ият',
  'ът', 'ят', 'та', 'то', 'те', 'ия',
  'и', 'а', 'я', 'о', 'е',
];
const STEM_MIN_TERM = 5;
const STEM_MIN_LEN = 4;
const TRIGRAM_MIN = 3;

export interface QueryClause {
  // Lowercased strings; a segment matches the clause if it contains any.
  alternatives: string[];
  // The original wording (for display/debugging).
  source: string;
  phrase: boolean;
}

export interface ParsedQuery {
  clauses: QueryClause[]; // AND over clauses
}

const EDGE_PUNCT = /^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu;

// Strips one common Bulgarian ending (longest first) if the stem stays >= 4
// chars. Returns null when nothing applies. Input must be lowercase.
export function bulgarianStem(term: string): string | null {
  if ([...term].length < STEM_MIN_TERM) return null;
  for (const ending of BG_ENDINGS) {
    if (term.endsWith(ending)) {
      const stem = term.slice(0, -ending.length);
      if ([...stem].length >= STEM_MIN_LEN) return stem;
    }
  }
  return null;
}

export function parseQuery(query: string): ParsedQuery {
  const clauses: QueryClause[] = [];
  const seen = new Set<string>();
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query))) {
    if (m[1] !== undefined) {
      const phrase = m[1].replace(/\s+/g, ' ').trim().toLowerCase();
      if (!phrase || seen.has('"' + phrase)) continue;
      seen.add('"' + phrase);
      clauses.push({ alternatives: [phrase], source: m[1].trim(), phrase: true });
    } else {
      const raw = m[2].replace(/"/g, '').replace(EDGE_PUNCT, '');
      const term = raw.toLowerCase();
      if (!term || seen.has(term)) continue;
      seen.add(term);
      const stem = bulgarianStem(term);
      clauses.push({ alternatives: stem ? [term, stem] : [term], source: raw, phrase: false });
    }
  }
  return { clauses };
}

// Same matching rules as the database search, for text already in memory:
// every clause must appear (any of its alternatives), case-insensitively.
export function matchesQuery(text: string, parsed: ParsedQuery): boolean {
  if (!parsed.clauses.length) return false;
  const lower = text.toLowerCase();
  return parsed.clauses.every((c) => c.alternatives.some((a) => lower.includes(a)));
}

// Every string the UI should highlight, longest first.
export function highlightTerms(query: string): string[] {
  const all = new Set<string>();
  for (const c of parseQuery(query).clauses) for (const a of c.alternatives) all.add(a);
  return [...all].sort((a, b) => b.length - a.length);
}

export interface TextPart {
  text: string;
  match: boolean;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Splits `text` into matched / unmatched parts (case-insensitive, Unicode).
export function splitHighlights(text: string, terms: string[]): TextPart[] {
  const usable = terms.filter(Boolean);
  if (!usable.length || !text) return [{ text, match: false }];
  const re = new RegExp(usable.map(escapeRegExp).join('|'), 'giu');
  const parts: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (!m[0]) continue;
    if (i > last) parts.push({ text: text.slice(last, i), match: false });
    parts.push({ text: m[0], match: true });
    last = i + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), match: false });
  return parts;
}

// FTS5 string literal: wrap in double quotes, double any inner quote.
export function ftsQuote(s: string): string {
  return '"' + s.replace(/"/g, '""') + '"';
}

// All upper/lower-case spellings of a short string (max 2^3 variants).
function caseVariants(s: string): string[] {
  let out = [''];
  for (const ch of s) {
    const lo = ch.toLowerCase();
    const up = ch.toUpperCase();
    const opts = lo === up ? [ch] : [lo, up];
    out = out.flatMap((p) => opts.map((o) => p + o));
  }
  return [...new Set(out)];
}

export interface SearchSql {
  sql: string;
  params: unknown[];
}

// Builds the search statement ($1, $2 … placeholders, as plugin-sql expects for
// SQLite). Returns null for an empty query.
export function buildSearchSql(query: string, limit: number): SearchSql | null {
  const { clauses } = parseQuery(query);
  if (!clauses.length) return null;

  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };

  // Placeholders are numbered in order of appearance (SQLite assigns
  // parameter indexes by first appearance), so the MATCH goes first.
  const ftsParts: string[] = [];
  const shortClauses: QueryClause[] = [];
  for (const c of clauses) {
    if (c.alternatives.every((a) => [...a].length >= TRIGRAM_MIN)) {
      ftsParts.push('(' + c.alternatives.map(ftsQuote).join(' OR ') + ')');
    } else {
      shortClauses.push(c);
    }
  }
  const where: string[] = [];
  if (ftsParts.length) {
    where.push(`s.id IN (SELECT rowid FROM segments_fts WHERE segments_fts MATCH ${p(ftsParts.join(' AND '))})`);
  }
  for (const c of shortClauses) {
    // Too short for trigrams: instr() over every case variant.
    const ors = c.alternatives.flatMap((a) => caseVariants(a).map((v) => `instr(s.text, ${p(v)}) > 0`));
    where.push('(' + ors.join(' OR ') + ')');
  }

  const sql = `
    SELECT m.id AS meeting_id, m.title AS meeting_title, m.created_at AS meeting_created_at,
           s.transcript_id, s.id AS segment_id, s.start_ms, s.end_ms, s.text,
           COALESCE(NULLIF(TRIM(sp.name), ''), sp.label) AS speaker_name
    FROM segments s
    JOIN meetings m ON m.active_transcript_id = s.transcript_id
    LEFT JOIN speakers sp ON sp.id = s.speaker_id
    WHERE ${where.join(' AND ')}
    ORDER BY m.created_at DESC, m.id DESC, s.start_ms, s.id
    LIMIT ${p(limit)}`;
  return { sql, params };
}
