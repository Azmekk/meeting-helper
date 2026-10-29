import type { ProviderId } from '../types';
import type { SecretName } from '../secrets';

export interface TranscribeOptions {
  languages: string[]; // main first; empty = auto-detect
  terms: string[];
  diarize: boolean; // false for the mic track (it's one known person)
  onProgress?: (message: string) => void;
}

// A timed piece of text as returned by a provider (word, sub-word or spacing).
export interface ProviderToken {
  text: string;
  startMs: number;
  endMs: number;
  speaker?: string; // provider's raw speaker id
  language?: string;
}

export interface ProviderResult {
  tokens: ProviderToken[];
  durationMs?: number;
}

export interface SttProvider {
  id: ProviderId;
  name: string; // "Soniox"
  model: string; // "stt-async-v5"
  secret: SecretName;
  usdPerHour: number; // list price, for cost estimates only
  transcribe(audioPath: string, apiKey: string, opts: TranscribeOptions): Promise<ProviderResult>;
  // Cheap call that proves the key works for transcription. Throws an Error
  // with a human-readable message if not.
  testKey(apiKey: string): Promise<void>;
}
