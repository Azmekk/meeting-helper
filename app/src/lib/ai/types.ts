// Provider-neutral shapes for the AI assistant. Each provider module
// (anthropic.ts, openai.ts) maps these to its own SDK.
import type { SecretName } from '../secrets';

export type AiProviderId = 'anthropic' | 'openai' | 'deepseek' | 'custom';

// Which setting picks the model: live notes, "help me answer", summaries/chat,
// and background folder work (action items, folder summary, extraction).
export type AiTask = 'live' | 'answer' | 'summary' | 'background';

// 'fast' = live notes (lowest reasoning effort), 'normal' = everything that
// reads a saved meeting, so those calls can share one transcript cache.
export type AiEffort = 'fast' | 'normal' | 'deep';

export interface AiAuth {
  apiKey: string; // may be '' for a keyless custom endpoint (Ollama)
  baseUrl?: string; // only used by the 'custom' provider
}

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
}

// A read-only tool the caller implements (search_meetings etc.).
export interface AiTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON schema of an object
}

export interface AiToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AiRequest {
  model: string;
  system: string;
  // Large, stable blocks (transcript, folder material), sent before the system
  // prompt so different tasks over the same material share one cache. Each block
  // must stay byte-identical between calls; a growing transcript adds new blocks
  // rather than extending the last one, because providers only reuse a prefix up
  // to a block boundary.
  context?: string[];
  // Comes after `context` and isn't cached: the part of a transcript still growing.
  contextTail?: string;
  messages: AiMessage[]; // must start with a user message
  // True for chat: the history is also cached so the next question can reuse it.
  conversation?: boolean;
  // Current state for this turn only (the open task list). Goes after the newest
  // question and isn't saved in the history, so it can change without breaking
  // the cached history.
  turnContext?: string;
  // What the request reads ("meeting:12"), so requests over the same material
  // stay grouped. OpenAI routes by it before GPT-5.6; the cache log records it.
  cacheKey?: string;
  maxTokens?: number;
  effort?: AiEffort;
  tools?: AiTool[];
  // Runs a tool call and returns its result text. With it, stream() loops until
  // the model stops calling tools. Without it, stream() stops at the first round
  // of calls and returns them in AiResult.toolCalls. Throwing marks the result
  // as an error for the model rather than aborting the loop.
  runTool?: (call: AiToolCall) => Promise<string>;
  maxToolRounds?: number; // default 8
  // Ask for a JSON object matching this schema; the parsed value lands in
  // AiResult.json. The schema should have additionalProperties: false. It goes
  // in the prompt after the context: a schema parameter would change the cached
  // prefix, so these calls couldn't read the transcript a summary just cached.
  json?: { name: string; schema: Record<string, unknown> };
  signal?: AbortSignal;
}

// Normalised token counts. inputTokens excludes cached and cache-write tokens.
export interface AiUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number; // Anthropic only; others cache for free
  outputTokens: number;
}

export type AiStopReason = 'end' | 'max_tokens' | 'tool_calls' | 'refusal' | 'other';

export interface AiResult {
  text: string; // text of the final round
  json?: unknown; // set when req.json was given and the text parsed
  toolCalls: AiToolCall[]; // pending calls; only non-empty without runTool
  usage: AiUsage; // summed over all tool rounds
  stopReason: AiStopReason;
  model: string; // the model that answered (may differ after a fallback)
}

export interface AiStreamHandlers {
  // delta = new text, text = everything so far in this round.
  onText?: (delta: string, text: string) => void;
  onToolCall?: (call: AiToolCall) => void;
  // Fired after each round so the UI can show running cost.
  onUsage?: (total: AiUsage) => void;
}

export interface AiProvider {
  id: AiProviderId;
  name: string;
  secret: SecretName;
  recommendedModels: { default: string; budget: string; others: string[] };
  keyOptional?: boolean; // custom endpoints may need no key
  listModels(auth: AiAuth): Promise<string[]>;
  // Cheap authenticated call; throws an Error with a readable message.
  testKey(auth: AiAuth): Promise<void>;
  stream(auth: AiAuth, req: AiRequest, handlers?: AiStreamHandlers): Promise<AiResult>;
}

export const EMPTY_USAGE: AiUsage = { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };

export function addUsage(a: AiUsage, b: AiUsage): AiUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

export function jsonInstruction(schema: Record<string, unknown>): string {
  return `Reply with a single JSON object matching this JSON schema, and nothing else:\n${JSON.stringify(schema)}`;
}

// The object in a JSON reply, which sometimes comes in a ```json fence or with a
// sentence around it.
export function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch {
    return undefined;
  }
}

// Minimal check of a tool input against its schema's required keys; inputs can
// arrive truncated when streamed, and the model should get a clear error back.
export function missingRequired(tool: AiTool | undefined, input: unknown): string[] {
  if (!input || typeof input !== 'object') return ['(input is not an object)'];
  const required = (tool?.parameters.required as string[] | undefined) ?? [];
  return required.filter((k) => !(k in (input as Record<string, unknown>)));
}
