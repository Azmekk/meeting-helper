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
