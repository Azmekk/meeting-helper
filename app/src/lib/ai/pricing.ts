// Built-in list prices for cost estimates. Providers' model lists don't carry
// prices, so unknown models show "unknown" rather than a guess.
import type { AiUsage } from './types';

// USD per 1M tokens.
interface Price {
  input: number;
  cachedInput: number;
  output: number;
  cacheWrite?: number;
}

// Anthropic charges 2x input to write the one-hour cache this app uses.
const anthropic = (input: number, cachedInput: number, output: number): Price => ({
  input,
  cachedInput,
  output,
  cacheWrite: input * 2,
});

// OpenAI charges 1.25x input to write the 30-minute cache on current models.
const openai = (input: number, cachedInput: number, output: number): Price => ({
  input,
  cachedInput,
  output,
  cacheWrite: input * 1.25,
});

export const PRICES: Record<string, Price> = {
  'claude-sonnet-5-5': anthropic(2, 0.2, 10),
  'claude-haiku-5-5': anthropic(0.1, 0.01, 0.5),
  'claude-opus-5-5': anthropic(4, 0.2, 20),
  'claude-fable-5-1': anthropic(10, 0.25, 50),
  'gpt-6.1-sol': openai(2, 0.1, 10),
  'gpt-6.1-terra': openai(1, 0.05, 5),
  'gpt-6-luna': openai(0.1, 0.01, 0.5),
  'gpt-6-astra': openai(10, 1, 50),
  // DeepSeek peak-hour prices (off-peak is cheaper), so estimates err high.
  'deepseek-v4-pro': { input: 1.32, cachedInput: 0.044, output: 3.96 },
  'deepseek-flash': { input: 0.3, cachedInput: 0.006, output: 1.2 },
};

// Accepts OpenRouter-style ids ("anthropic/claude-sonnet-5-5") too.
export function priceFor(model: string): Price | null {
  const id = model.trim().toLowerCase();
  return PRICES[id] ?? PRICES[id.slice(id.lastIndexOf('/') + 1)] ?? null;
}

export function estimateCost(model: string, usage: AiUsage): number | null {
  const p = priceFor(model);
  if (!p) return null;
  return (
    (usage.inputTokens * p.input +
      usage.cachedInputTokens * p.cachedInput +
      usage.cacheWriteTokens * (p.cacheWrite ?? p.input) +
      usage.outputTokens * p.output) /
    1_000_000
  );
}

// Rough token count for estimates before a call (~3.5 chars per token across
// English and Cyrillic text); use real usage numbers whenever available.
export function roughTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

// Expected cost of one call that resends `contextTokens` of prompt. `cached`
// says whether that prefix is already in this model's cache (false right after
// a model switch, when the whole transcript is paid at full price).
export function estimateCallCost(
  model: string,
  contextTokens: number,
  outputTokens: number,
  cached: boolean,
): number | null {
  const p = priceFor(model);
  if (!p) return null;
  const usage: AiUsage = cached
    ? { inputTokens: 0, cachedInputTokens: contextTokens, cacheWriteTokens: 0, outputTokens }
    : p.cacheWrite
      ? { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: contextTokens, outputTokens }
      : { inputTokens: contextTokens, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens };
  return estimateCost(model, usage);
}

// How long a prefix can be expected to stay cached since it was last used. OpenAI
// guarantees 30 minutes, Anthropic an hour here; DeepSeek's lasts hours but is
// best-effort, so an hour is a cautious guess for it and other providers.
export function cacheWindowMs(model: string): number {
  return /(^|\/)gpt-/i.test(model) ? 30 * 60_000 : 60 * 60_000;
}

// Share of the prompt read from cache, or null with no prompt to measure.
export function cachedPercent(usage: AiUsage): number | null {
  const total = usage.inputTokens + usage.cachedInputTokens + usage.cacheWriteTokens;
  return total ? Math.round((100 * usage.cachedInputTokens) / total) : null;
}

// "94% cached", for the line under an answer.
export function usageNote(usage: AiUsage): string {
  const pct = cachedPercent(usage);
  return pct == null ? '' : `${pct}% cached`;
}
