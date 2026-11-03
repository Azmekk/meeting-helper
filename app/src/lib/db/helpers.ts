// Small helpers the database modules share.

export function conversationTitle(question: string): string {
  const text = question.replace(/\s+/g, ' ').trim();
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

export const splitTerms = (text: string | null): string[] => (text ? text.split('\n').filter(Boolean) : []);

export const joinTerms = (terms: string[]): string | null => (terms.length ? terms.join('\n') : null);

export const now = () => new Date().toISOString();

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export const SEGMENT_CHUNK = 200;

export function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
