// OpenAI-compatible providers via the official `openai` SDK (Chat Completions):
// OpenAI itself, DeepSeek, and any custom base URL (OpenRouter, Ollama, ...).
// Context goes first so tasks with different instructions share it. Current
// OpenAI models get explicit cache breakpoints at stable boundaries; DeepSeek
// and older models cache repeated prefixes automatically.
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import OpenAI from 'openai';
import type { SecretName } from '../secrets';
import {
  EMPTY_USAGE,
  addUsage,
  missingRequired,
  parseJsonText,
  type AiAuth,
  type AiEffort,
  type AiProvider,
  type AiProviderId,
  type AiStopReason,
  type AiToolCall,
  type AiUsage,
} from './types';

type Chat = OpenAI.Chat.Completions.ChatCompletionMessageParam;

interface Flavor {
  id: Extract<AiProviderId, 'openai' | 'deepseek' | 'custom'>;
  name: string;
  secret: SecretName;
  baseUrl?: string; // fixed base URL; custom takes it from AiAuth
  recommendedModels: AiProvider['recommendedModels'];
}

function client(flavor: Flavor, auth: AiAuth): OpenAI {
  const baseURL = flavor.baseUrl ?? auth.baseUrl?.trim().replace(/\/+$/, '');
  if (flavor.id === 'custom' && !baseURL) throw new Error('Enter the base URL of your OpenAI-compatible endpoint first.');
  return new OpenAI({
    // The SDK refuses an empty key; keyless local servers ignore it.
    apiKey: auth.apiKey || 'none',
    baseURL,
    fetch: tauriFetch as unknown as typeof globalThis.fetch,
    // The key comes from the OS keyring and is only sent to the chosen endpoint.
    dangerouslyAllowBrowser: true,
  });
}

const EFFORT: Record<AiEffort, 'low' | 'medium' | 'high'> = { fast: 'low', normal: 'medium', deep: 'high' };

// /models on OpenAI also lists embedding, audio and image models.
const NOT_CHAT = /embed|tts|whisper|dall-e|image|audio|realtime|moderation|transcribe|search|davinci|babbage|sora/i;

function toUsage(u: OpenAI.CompletionUsage | undefined | null): AiUsage {
  if (!u) return EMPTY_USAGE;
  // OpenAI: prompt_tokens_details.cached_tokens; DeepSeek: prompt_cache_hit_tokens.
  const raw = u as OpenAI.CompletionUsage & { prompt_cache_hit_tokens?: number };
  const cached = u.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens ?? 0;
  const written = u.prompt_tokens_details?.cache_write_tokens ?? 0;
  return {
    inputTokens: Math.max(0, (u.prompt_tokens ?? 0) - cached - written),
    cachedInputTokens: cached,
    cacheWriteTokens: written,
    outputTokens: u.completion_tokens ?? 0,
  };
}

// GPT-5.6 and later take explicit breakpoints; without one, a prefix is only
// saved at the end of the newest message, so a later call that differs there
// (another question, a grown transcript) starts cold.
function takesBreakpoints(flavor: Flavor, model: string): boolean {
  return flavor.id === 'openai' && /^gpt-(5\.([6-9]|\d{2})|[6-9]|\d{2})/.test(model);
}

const BREAKPOINT = { prompt_cache_breakpoint: { mode: 'explicit' } } as const;

function toStop(reason: string | null | undefined): AiStopReason {
  switch (reason) {
    case 'stop':
      return 'end';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'content_filter':
      return 'refusal';
    default:
      return 'other';
  }
}

function describeError(name: string, err: unknown): Error {
  if (err instanceof OpenAI.APIUserAbortError) return err;
  if (err instanceof OpenAI.AuthenticationError) return new Error(`${name} rejected the API key. Check it in Settings → AI.`);
  if (err instanceof OpenAI.PermissionDeniedError) return new Error(`${name} refused the request: ${err.message}`);
  if (err instanceof OpenAI.NotFoundError) return new Error(`${name} doesn't know this model or URL: ${err.message}`);
  if (err instanceof OpenAI.RateLimitError) {
    if (/quota|billing|balance/i.test(err.message)) return new Error(`Your ${name} account is out of credit or over its quota.`);
    return new Error(`${name} rate limit reached. Wait a moment and try again.`);
  }
  if (err instanceof OpenAI.BadRequestError) return new Error(`${name} rejected the request: ${err.message}`);
  if (err instanceof OpenAI.APIConnectionError) return new Error(`Couldn't reach ${name}: ${err.message}`);
  if (err instanceof OpenAI.APIError) {
    if (err.status === 402) return new Error(`Your ${name} account is out of credit.`);
    return new Error(`${name} error (HTTP ${err.status ?? '?'}): ${err.message}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

function makeProvider(flavor: Flavor): AiProvider {
  return {
    id: flavor.id,
    name: flavor.name,
    secret: flavor.secret,
    recommendedModels: flavor.recommendedModels,
    keyOptional: flavor.id === 'custom',

    async listModels(auth) {
      try {
        const ids: string[] = [];
        for await (const m of client(flavor, auth).models.list()) ids.push(m.id);
        return flavor.id === 'openai' ? ids.filter((id) => !NOT_CHAT.test(id)) : ids;
      } catch (err) {
        throw describeError(flavor.name, err);
      }
    },

    async testKey(auth) {
      try {
        await client(flavor, auth).models.list();
      } catch (err) {
        throw describeError(flavor.name, err);
      }
    },

    async stream(auth, req, handlers = {}) {
      const api = client(flavor, auth);

      let system = req.system;
      // DeepSeek and most custom servers only do json_object; the schema then
      // goes into the prompt (json_object also requires the word "JSON" in it).
      const schemaMode = flavor.id === 'openai';
      if (req.json && !schemaMode) {
        system += `\n\nReply with a single JSON object matching this JSON schema, and nothing else:\n${JSON.stringify(req.json.schema)}`;
      }
      const breakpoints = takesBreakpoints(flavor, req.model);
      const messages: Chat[] = [];
      if (breakpoints && req.context?.length) {
        const parts: OpenAI.Chat.Completions.ChatCompletionContentPartText[] = req.context.map((text) => ({ type: 'text', text, ...BREAKPOINT }));
        if (req.contextTail) parts.push({ type: 'text', text: req.contextTail });
        messages.push({ role: 'system', content: parts });
      } else if (req.context?.length || req.contextTail) {
        messages.push({ role: 'system', content: [...(req.context ?? []), req.contextTail ?? ''].filter(Boolean).join('\n') });
      }
      messages.push({ role: 'system', content: system });
      // A request writes at most four breakpoints, the latest ones, so marking every
      // question drops the context's and other chats can't reuse it. The second-last
      // question is where the previous turn's prefix ends.
      const markedQuestions = new Set(req.messages.flatMap((m, i) => (m.role === 'user' ? [i] : [])).slice(-2));
      req.messages.forEach((m, i) => {
        const last = i === req.messages.length - 1;
        if (breakpoints && req.conversation && markedQuestions.has(i)) {
          const parts: OpenAI.Chat.Completions.ChatCompletionContentPartText[] = [{ type: 'text', text: m.content, ...BREAKPOINT }];
          if (last && req.turnContext) parts.push({ type: 'text', text: req.turnContext });
          messages.push({ role: 'user', content: parts });
        } else if (m.role === 'user') {
          messages.push({ role: 'user', content: last && req.turnContext ? `${m.content}\n\n${req.turnContext}` : m.content });
        } else {
          messages.push({ role: 'assistant', content: m.content });
        }
      });

      const tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined = req.tools?.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));

      let usage = EMPTY_USAGE;
      const maxRounds = req.maxToolRounds ?? 8;
      const maxTokens = req.maxTokens ?? 16000;

      try {
        for (let round = 0; ; round++) {
          const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
            model: req.model,
            messages,
            stream: true,
            stream_options: { include_usage: true },
          };
          // Explicit-only, so the changing end of a prompt isn't paid for as a write.
          if (breakpoints) params.prompt_cache_options = { mode: 'explicit' };
          // OpenAI's reasoning models only take max_completion_tokens; others
          // still expect max_tokens.
          if (flavor.id === 'openai') {
            params.max_completion_tokens = maxTokens;
            params.reasoning_effort = EFFORT[req.effort ?? 'normal'];
          } else {
            params.max_tokens = maxTokens;
          }
          if (tools?.length) params.tools = tools;
          if (req.json) {
            params.response_format = schemaMode
              ? { type: 'json_schema', json_schema: { name: req.json.name, schema: req.json.schema, strict: true } }
              : { type: 'json_object' };
          }

          const stream = api.chat.completions.stream(params, { signal: req.signal });
          if (handlers.onText) stream.on('content', handlers.onText);
          const completion = await stream.finalChatCompletion();

          usage = addUsage(usage, toUsage(completion.usage));
          handlers.onUsage?.(usage);

          const choice = completion.choices[0];
          const text = choice?.message.content ?? '';
          const calls: AiToolCall[] = [];
          const rawArgs = new Map<string, string>();
          for (const c of choice?.message.tool_calls ?? []) {
            if (c.type !== 'function') continue;
            rawArgs.set(c.id, c.function.arguments);
            let input: Record<string, unknown> = {};
            try {
              input = c.function.arguments ? JSON.parse(c.function.arguments) : {};
            } catch {
              input = { __invalid_json: c.function.arguments };
            }
            calls.push({ id: c.id, name: c.function.name, input });
          }
          let stopReason = toStop(choice?.finish_reason);
          // Some compatible servers report "stop" even when they called tools.
          if (calls.length && stopReason === 'end') stopReason = 'tool_calls';

          const done = (toolCalls: AiToolCall[] = []) => ({
            text,
            json: req.json ? parseJsonText(text) : undefined,
            toolCalls,
            usage,
            stopReason,
            model: completion.model || req.model,
          });

          if (stopReason !== 'tool_calls' || !calls.length) return done();
          calls.forEach((c) => handlers.onToolCall?.(c));
          if (!req.runTool || round >= maxRounds) return done(calls);

          messages.push({
            role: 'assistant',
            content: text || null,
            // Echo the raw arguments back unchanged.
            tool_calls: calls.map((c) => ({
              id: c.id,
              type: 'function',
              function: { name: c.name, arguments: rawArgs.get(c.id) ?? JSON.stringify(c.input) },
            })),
          });
          for (const call of calls) {
            const missing =
              '__invalid_json' in call.input
                ? ['(arguments were not valid JSON)']
                : missingRequired(
                    req.tools?.find((t) => t.name === call.name),
                    call.input,
                  );
            let content: string;
            if (missing.length) {
              content = `Error: invalid input, missing: ${missing.join(', ')}`;
            } else {
              try {
                content = await req.runTool(call);
              } catch (err) {
                content = `Error: ${err instanceof Error ? err.message : String(err)}`;
              }
            }
            messages.push({ role: 'tool', tool_call_id: call.id, content: breakpoints ? [{ type: 'text', text: content, ...BREAKPOINT }] : content });
          }
        }
      } catch (err) {
        throw describeError(flavor.name, err);
      }
    },
  };
}

export const openai = makeProvider({
  id: 'openai',
  name: 'OpenAI',
  secret: 'openai_api_key',
  baseUrl: 'https://api.openai.com/v1',
  recommendedModels: { default: 'gpt-6.1-terra', budget: 'gpt-6-luna', others: ['gpt-6.1-sol', 'gpt-6-astra'] },
});

export const deepseek = makeProvider({
  id: 'deepseek',
  name: 'DeepSeek',
  secret: 'deepseek_api_key',
  baseUrl: 'https://api.deepseek.com',
  recommendedModels: { default: 'deepseek-v4-pro', budget: 'deepseek-flash', others: [] },
});

export const custom = makeProvider({
  id: 'custom',
  name: 'Custom endpoint',
  secret: 'custom_ai_api_key',
  recommendedModels: { default: '', budget: '', others: [] },
});
