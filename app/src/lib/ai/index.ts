// AI provider registry plus helpers that resolve the current provider, key and
// per-task model from settings.
import { getSecret } from '../secrets';
import { getSettings, type Settings } from '../settings';
import { anthropic } from './anthropic';
import { custom, deepseek, openai } from './openai';
import type { AiAuth, AiEffort, AiProvider, AiProviderId, AiRequest, AiResult, AiStreamHandlers, AiTask } from './types';

export * from './types';
export { estimateCallCost, estimateCost, priceFor, roughTokens } from './pricing';

export const AI_PROVIDERS: Record<AiProviderId, AiProvider> = { anthropic, openai, deepseek, custom };

export const AI_PROVIDER_IDS = Object.keys(AI_PROVIDERS) as AiProviderId[];

export function getAiProvider(id: AiProviderId): AiProvider {
  return AI_PROVIDERS[id] ?? AI_PROVIDERS.anthropic;
}

// Recommended models first (default, budget, others), then the rest sorted.
export function sortModels(provider: AiProvider, ids: string[]): { recommended: string[]; rest: string[] } {
  const { default: d, budget, others } = provider.recommendedModels;
  const recommended = [d, budget, ...others].filter((m) => m && ids.includes(m));
  const rest = ids.filter((m) => !recommended.includes(m)).sort();
  return { recommended, rest };
}

// The newest model of each family: claude-opus-5-5 hides claude-opus-4-8, and
// an alias hides its dated snapshots (claude-haiku-4-5-20251001). A family is
// the id without its version numbers (claude-opus, gpt-sol, deepseek-pro).
const DATE_SUFFIX = /-(\d{8}|\d{4}-\d{2}-\d{2})$/;

function parseModelId(id: string): { family: string; version: number[]; date: string } {
  const date = DATE_SUFFIX.exec(id)?.[1] ?? '';
  const family: string[] = [];
  const version: number[] = [];
  for (const part of id.replace(DATE_SUFFIX, '').split(/[-_]/)) {
    const m = /^v?(\d+(?:\.\d+)*)$/i.exec(part);
    if (m) version.push(...m[1].split('.').map(Number));
    else family.push(part.toLowerCase());
  }
  return { family: family.join('-'), version, date };
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export function latestModels(ids: string[]): string[] {
  const best = new Map<string, { id: string; version: number[]; date: string }>();
  for (const id of ids) {
    const p = parseModelId(id);
    const cur = best.get(p.family);
    const newer =
      !cur ||
      compareVersions(p.version, cur.version) > 0 ||
      (compareVersions(p.version, cur.version) === 0 && (!p.date ? !!cur.date : !!cur.date && p.date > cur.date));
    if (newer) best.set(p.family, { id, ...p });
  }
  const keep = new Set([...best.values()].map((b) => b.id));
  return ids.filter((id) => keep.has(id));
}

// The models the pickers offer, per Settings → AI → "Models in lists", in
// sortModels order. The recommended models are always offered.
export function pickerModels(provider: AiProvider, ids: string[], settings: Settings = getSettings()) {
  const { default: d, budget, others } = provider.recommendedModels;
  const pinned = new Set([d, budget, ...others].filter(Boolean));
  const shown =
    settings.aiModelList === 'all'
      ? ids
      : settings.aiModelList === 'custom'
        ? ids.filter((id) => pinned.has(id) || settings.aiCustomModels.includes(id))
        : ids.filter((id) => pinned.has(id) || latestModels(ids).includes(id));
  return sortModels(provider, shown);
}

// Live calls must be quick; summaries can think longer.
const TASK_EFFORT: Record<AiTask, AiEffort> = { live: 'fast', answer: 'normal', summary: 'deep' };

const TASK_SETTING: Record<AiTask, 'aiLiveModel' | 'aiAnswerModel' | 'aiSummaryModel'> = {
  live: 'aiLiveModel',
  answer: 'aiAnswerModel',
  summary: 'aiSummaryModel',
};

// The model to use for a task: the setting, or the provider's recommended
// model when it's blank. '' for a custom endpoint with nothing chosen.
export function effectiveModel(task: AiTask, settings: Settings = getSettings()): string {
  return settings[TASK_SETTING[task]] || getAiProvider(settings.aiProvider).recommendedModels.default;
}

export async function getAiAuth(id: AiProviderId, settings: Settings = getSettings()): Promise<AiAuth> {
  const provider = getAiProvider(id);
  const apiKey = (await getSecret(provider.secret)) ?? '';
  if (!apiKey && !provider.keyOptional) throw new Error(`Add your ${provider.name} API key in Settings → AI first.`);
  return { apiKey, baseUrl: id === 'custom' ? settings.aiCustomBaseUrl : undefined };
}

// Main entry for features: uses the configured provider and the task's model
// unless the request names one (e.g. a mid-meeting model switch).
export async function runAi(
  task: AiTask,
  req: Omit<AiRequest, 'model'> & { model?: string },
  handlers?: AiStreamHandlers,
): Promise<AiResult> {
  const settings = getSettings();
  const provider = getAiProvider(settings.aiProvider);
  const model = req.model || effectiveModel(task, settings);
  if (!model) throw new Error('Choose a model in Settings → AI first.');
  const auth = await getAiAuth(provider.id, settings);
  return provider.stream(auth, { ...req, model, effort: req.effort ?? TASK_EFFORT[task] }, handlers);
}
