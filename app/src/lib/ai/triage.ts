// Decides where a new action item goes. The AI reports what was said; this rule,
// not the AI's sense of importance, decides what counts as a task.

export interface ItemEvidence {
  kind: 'commitment' | 'request' | 'suggestion';
  accepted: boolean;
  quote: string;
}

// Shorter "quotes" (e.g. "ok") match almost any transcript.
const MIN_QUOTE_CHARS = 5;

// Letters and digits only, so punctuation and spacing differences don't matter.
export function normalizeForQuote(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

// `transcript` is already normalized. Anything unproven stays a suggestion, so
// the user can still accept it.
export function triageItem(item: ItemEvidence, transcript: string): 'open' | 'suggested' {
  const firm = item.kind === 'commitment' || (item.kind === 'request' && item.accepted);
  const quote = normalizeForQuote(item.quote ?? '');
  return firm && quote.length >= MIN_QUOTE_CHARS && transcript.includes(quote) ? 'open' : 'suggested';
}
