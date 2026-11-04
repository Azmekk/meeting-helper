// One line per OpenAI-compatible request in <app data>/ai-cache.log, to tell why
// an answer missed the cache: token counts and a fingerprint of the context, never
// any text. A changed fingerprint means the context changed, so the miss was
// expected; the same one means the provider missed; reported=false means it sent
// no cache numbers, so the 0 isn't a real measurement.
import { appDataDir, join } from '@tauri-apps/api/path';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import type { AiUsage } from './types';

// FNV-1a. Only compared between requests, so it needn't be cryptographic.
export function fingerprint(blocks: string[]): string {
  let hash = 0x811c9dc5;
  for (const block of blocks) {
    for (let i = 0; i < block.length; i++) {
      hash ^= block.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function cacheLogLine(
  at: Date,
  entry: { model: string; cacheKey?: string; usage: AiUsage; reported: boolean; context: string[] },
): string {
  const { usage } = entry;
  return [
    at.toISOString(),
    entry.model,
    `for=${entry.cacheKey ?? '-'}`,
    `cached=${usage.cachedInputTokens}`,
    `written=${usage.cacheWriteTokens}`,
    `input=${usage.inputTokens}`,
    `reported=${entry.reported}`,
    `context=${entry.context.length ? fingerprint(entry.context) : '-'}`,
  ].join(' ');
}

// Never gets in the way of the answer.
export async function logCacheUse(entry: Parameters<typeof cacheLogLine>[1]): Promise<void> {
  try {
    const path = await join(await appDataDir(), 'ai-cache.log');
    await writeTextFile(path, `${cacheLogLine(new Date(), entry)}\n`, { append: true });
  } catch (err) {
    console.warn('Could not write the AI cache log', err);
  }
}
