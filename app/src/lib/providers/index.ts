// Registry of speech-to-text providers.
import type { ProviderId } from '../types';
import { elevenlabs } from './elevenlabs';
import { soniox } from './soniox';
import type { SttProvider } from './types';

export const PROVIDERS: Record<ProviderId, SttProvider> = {
  soniox,
  elevenlabs,
};

export function getProvider(id: ProviderId): SttProvider {
  return PROVIDERS[id];
}
