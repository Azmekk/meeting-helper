// Anthropic (Claude) provider via the official SDK, routed through the Tauri
// HTTP plugin so requests leave from Rust and aren't subject to CORS.
import Anthropic from '@anthropic-ai/sdk';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import {
  EMPTY_USAGE,
  addUsage,
  jsonInstruction,
  missingRequired,
  parseJsonText,
  type AiAuth,
  type AiEffort,
  type AiProvider,
  type AiStopReason,
  type AiToolCall,
  type AiUsage,
} from './types';

// Beta namespace: needed for server-side refusal fallbacks.
import type * as B from '@anthropic-ai/sdk/resources/beta/messages/messages';

function client(auth: AiAuth): Anthropic {
  return new Anthropic({
    apiKey: auth.apiKey,
    fetch: tauriFetch as unknown as typeof globalThis.fetch,
    // Safe here: the key comes from the OS keyring and never leaves this machine
    // except to api.anthropic.com.
    dangerouslyAllowBrowser: true,
  });
}

// Models before the 4.6 generation don't take adaptive thinking or effort.
function isLegacy(model: string): boolean {
  return /^claude-(3|instant|2)|^claude-\w+-4(-[0-5])?(-\d{8})?$/.test(model);
}

// Models that accept server-side refusal fallbacks ("default" lets the API pick
// the fallback model per refusal category).
function supportsFallbacks(model: string): boolean {
  return /^claude-(opus-5|opus-5-5|sonnet-5-5|fable-5-1)$/.test(model);
}

const EFFORT: Record<AiEffort, 'low' | 'medium' | 'high'> = { fast: 'low', normal: 'medium', deep: 'high' };

const CACHE = { type: 'ephemeral', ttl: '1h' } as const;

function toUsage(u: B.BetaUsage): AiUsage {
  return {
    inputTokens: u.input_tokens ?? 0,
    cachedInputTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
  };
}

function toStop(reason: string | null): AiStopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end';
    case 'max_tokens':
      return 'max_tokens';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}

function describeError(err: unknown): Error {
  if (err instanceof Anthropic.APIUserAbortError) return err;
  if (err instanceof Anthropic.AuthenticationError) return new Error('Anthropic rejected the API key. Check it in Settings → AI.');
  if (err instanceof Anthropic.PermissionDeniedError) return new Error(`Anthropic refused the request: ${err.message}`);
  if (err instanceof Anthropic.NotFoundError) return new Error(`Anthropic doesn't know this model: ${err.message}`);
  if (err instanceof Anthropic.RateLimitError) return new Error('Anthropic rate limit reached. Wait a moment and try again.');
  if (err instanceof Anthropic.BadRequestError) {
    if (/credit balance/i.test(err.message)) return new Error('Your Anthropic account is out of credit. Top up at console.anthropic.com.');
    return new Error(`Anthropic rejected the request: ${err.message}`);
  }
  if (err instanceof Anthropic.APIConnectionError) return new Error(`Couldn't reach Anthropic: ${err.message}`);
  if (err instanceof Anthropic.APIError) return new Error(`Anthropic error (HTTP ${err.status ?? '?'}): ${err.message}`);
  return err instanceof Error ? err : new Error(String(err));
}

export const anthropic: AiProvider = {
  id: 'anthropic',
  name: 'Anthropic',
  secret: 'anthropic_api_key',
  recommendedModels: {
    default: 'claude-sonnet-5-5',
    budget: 'claude-haiku-5-5',
    others: ['claude-opus-5-5', 'claude-fable-5-1'],
  },

  async listModels(auth) {
    try {
      const ids: string[] = [];
      for await (const m of client(auth).models.list()) ids.push(m.id);
      return ids;
    } catch (err) {
      throw describeError(err);
    }
  },

  async testKey(auth) {
    try {
      await client(auth).models.list({ limit: 1 });
    } catch (err) {
      throw describeError(err);
    }
  },

  async stream(auth, req, handlers = {}) {
    const api = client(auth);
    const legacy = isLegacy(req.model);
    const fallbacks = supportsFallbacks(req.model);

    // Prefix order is tools → system → messages. Context blocks come first so
    // tasks with different instructions share them. The hour-long cache outlives
    // pauses in a chat and notes on a long interval. A request has 4 breakpoints:
    // up to 2 or 3 on the newest context blocks, the rest on the conversation.
    const contextBlocks = req.context ?? [];
    const contextMarks = req.conversation ? 2 : 3;
    const system: B.BetaTextBlockParam[] = contextBlocks.map((text, i) => ({
      type: 'text',
      text,
      ...(i >= contextBlocks.length - contextMarks ? { cache_control: CACHE } : {}),
    }));
    if (req.contextTail) system.push({ type: 'text', text: req.contextTail });
    system.push({ type: 'text', text: req.json ? `${req.system}\n\n${jsonInstruction(req.json.schema)}` : req.system });

    const tools: B.BetaTool[] | undefined = req.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: { type: 'object', ...t.parameters },
      eager_input_streaming: true,
    }));

    const messages: B.BetaMessageParam[] = req.messages.map((m, i) => {
      if (i < req.messages.length - 1 || (!req.conversation && !req.turnContext)) return { role: m.role, content: m.content };
      // The breakpoint sits on the question, before anything that changes per turn.
      const content: B.BetaTextBlockParam[] = [
        { type: 'text', text: m.content, ...(req.conversation ? { cache_control: CACHE } : {}) },
      ];
      if (req.turnContext) content.push({ type: 'text', text: req.turnContext });
      return { role: m.role, content };
    });
    let usage = EMPTY_USAGE;
    const maxRounds = req.maxToolRounds ?? 8;

    try {
      for (let round = 0; ; round++) {
        const params: B.MessageCreateParamsStreaming = {
          model: req.model,
          max_tokens: req.maxTokens ?? 16000,
          system,
          messages,
          stream: true,
        };
        // Follows the tool rounds as they grow. One-off calls and plain chat leave
        // it out: it would pay to store text nothing reads back.
        if (req.conversation && tools?.length) params.cache_control = CACHE;
        if (!legacy) {
          params.thinking = { type: 'adaptive' };
          params.output_config = { effort: EFFORT[req.effort ?? 'normal'] };
        }
        if (tools?.length) params.tools = tools;
        if (fallbacks) {
          params.betas = ['server-side-fallback-2026-07-01'];
          params.fallbacks = 'default';
        }

        const stream = api.beta.messages.stream(params, { signal: req.signal });
        if (handlers.onText) stream.on('text', handlers.onText);
        const msg = await stream.finalMessage();

        usage = addUsage(usage, toUsage(msg.usage));
        handlers.onUsage?.(usage);

        const text = msg.content
          .filter((b): b is B.BetaTextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('');
        const calls: AiToolCall[] = msg.content
          .filter((b): b is B.BetaToolUseBlock => b.type === 'tool_use')
          .map((b) => ({ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }));
        const stopReason = toStop(msg.stop_reason);

        const done = (toolCalls: AiToolCall[] = []) => ({
          text,
          json: req.json ? parseJsonText(text) : undefined,
          toolCalls,
          usage,
          stopReason,
          model: msg.model,
        });

        // A refusal or max_tokens can cut a tool call off mid-input; never run those.
        if (stopReason !== 'tool_calls' || !calls.length) return done();
        calls.forEach((c) => handlers.onToolCall?.(c));
        if (!req.runTool || round >= maxRounds) return done(calls);

        messages.push({ role: 'assistant', content: msg.content as B.BetaContentBlockParam[] });
        const results: B.BetaToolResultBlockParam[] = [];
        for (const call of calls) {
          const missing = missingRequired(
            req.tools?.find((t) => t.name === call.name),
            call.input,
          );
          if (missing.length) {
            results.push({
              type: 'tool_result',
              tool_use_id: call.id,
              is_error: true,
              content: `Invalid input, missing: ${missing.join(', ')}`,
            });
            continue;
          }
          try {
            results.push({ type: 'tool_result', tool_use_id: call.id, content: await req.runTool(call) });
          } catch (err) {
            results.push({
              type: 'tool_result',
              tool_use_id: call.id,
              is_error: true,
              content: err instanceof Error ? err.message : String(err),
            });
          }
        }
        // All results of a round go back in one user message.
        messages.push({ role: 'user', content: results });
      }
    } catch (err) {
      throw describeError(err);
    }
  },
};
