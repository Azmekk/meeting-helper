// ElevenLabs Scribe. The endpoint answers synchronously, so one long upload
// request returns the whole transcript.
// Docs: https://elevenlabs.io/docs/api-reference/speech-to-text/convert
import { appCacheDir, join } from '@tauri-apps/api/path';
import { mkdir, remove, writeFile } from '@tauri-apps/plugin-fs';
import { uploadMultipart } from '../native';
import type { ProviderToken, SttProvider } from './types';

const URL = 'https://api.elevenlabs.io/v1/speech-to-text';
// Synchronous: the request stays open while the whole file is transcribed.
const TIMEOUT_SECS = 3600;

// Scribe reports ISO-639-3; the rest of the app (and Soniox) uses ISO-639-1.
const ISO3_TO_1: Record<string, string> = {
  bul: 'bg', eng: 'en', rus: 'ru', deu: 'de', ger: 'de', fra: 'fr', fre: 'fr', spa: 'es',
  ita: 'it', tur: 'tr', ell: 'el', gre: 'el', ron: 'ro', rum: 'ro', srp: 'sr', mkd: 'mk', ukr: 'uk',
};

// Error bodies are either { detail: { status, message } } or, for 422,
// { detail: [{ loc, msg, type }] }.
function describeError(status: number, body: string): string {
  let code = '';
  let message = '';
  try {
    const detail = JSON.parse(body).detail;
    if (Array.isArray(detail)) {
      message = detail
        .map((d: any) => `${Array.isArray(d.loc) ? d.loc.filter((l: unknown) => l !== 'body').join('.') + ': ' : ''}${d.msg}`)
        .join('; ');
    } else if (detail && typeof detail === 'object') {
      code = String(detail.status ?? '');
      message = String(detail.message ?? '');
    } else if (typeof detail === 'string') {
      message = detail;
    }
  } catch {
    message = body.slice(0, 300);
  }
  const lower = `${code} ${message}`.toLowerCase();

  // Permission-scoped keys come back as 401 or 403 with "missing_permissions".
  if (lower.includes('permission') || status === 403) {
    return 'This ElevenLabs API key lacks the "Speech to Text" permission. Enable it for the key at elevenlabs.io (Developers → API Keys).';
  }
  if (status === 401) return 'ElevenLabs rejected the API key. Check it in Settings.';
  if (status === 402 || /quota|credit|insufficient|payment|subscription/.test(lower)) {
    return `Your ElevenLabs account is out of credits or over its quota${message ? ` (${message})` : ''}.`;
  }
  if (status === 429) return 'ElevenLabs rate limit reached. Wait a minute and try again.';
  if (status === 400 || status === 422) return `ElevenLabs rejected the request: ${message || `HTTP ${status}`}`;
  if (status >= 500) return `ElevenLabs is having problems (HTTP ${status}). Try again later.`;
  return `ElevenLabs error (HTTP ${status})${message ? `: ${message}` : ''}`;
}

// Keyterms that break ElevenLabs' rules get the whole request rejected (422),
// so drop them: < 50 chars, at most 5 words, none of <>{}[]\.
function validKeyterms(terms: string[]): string[] {
  return terms
    .map((t) => t.trim())
    .filter((t) => t && t.length < 50 && t.split(/\s+/).length <= 5 && !/[<>{}[\]\\]/.test(t))
    .slice(0, 1000);
}

async function post(apiKey: string, filePath: string, fields: [string, string][]): Promise<any> {
  let res;
  try {
    res = await uploadMultipart({
      url: URL,
      headers: { 'xi-api-key': apiKey },
      fields,
      fileField: 'file',
      filePath,
      timeoutSecs: TIMEOUT_SECS,
    });
  } catch (err) {
    throw new Error(`ElevenLabs request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status < 200 || res.status >= 300) throw new Error(describeError(res.status, res.body));
  return JSON.parse(res.body);
}

// 0.5 s of silence as a 16 kHz mono 16-bit PCM WAV.
function silentWav(seconds = 0.5, sampleRate = 16000): Uint8Array {
  const dataBytes = Math.round(seconds * sampleRate) * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const ascii = (offset: number, s: string) => [...s].forEach((c, i) => v.setUint8(offset + i, c.charCodeAt(0)));
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  v.setUint32(40, dataBytes, true);
  return new Uint8Array(buf); // samples are already zero
}

export const elevenlabs: SttProvider = {
  id: 'elevenlabs',
  name: 'ElevenLabs',
  model: 'scribe_v2',
  secret: 'elevenlabs_api_key',
  usdPerHour: 0.22,

  async transcribe(audioPath, apiKey, opts) {
    opts.onProgress?.('Uploading and transcribing with ElevenLabs…');
    const fields: [string, string][] = [
      ['model_id', this.model],
      ['diarize', String(opts.diarize)],
      ['timestamps_granularity', 'word'],
      ['tag_audio_events', 'false'],
    ];
    // Scribe takes a single language; the first hint is the main one.
    if (opts.languages.length) fields.push(['language_code', opts.languages[0]]);
    // Keyterms are billed extra (+20%) by ElevenLabs.
    for (const term of validKeyterms(opts.terms)) fields.push(['keyterms', term]);

    const raw = await post(apiKey, audioPath, fields);
    // One language per request; tag every token with it for the language mix.
    const lang = typeof raw.language_code === 'string' ? (ISO3_TO_1[raw.language_code] ?? raw.language_code) : undefined;

    const tokens: ProviderToken[] = [];
    let lastMs = 0;
    for (const w of raw.words ?? []) {
      // start/end are nullable; reuse the previous time so ordering holds.
      const startMs = w.start != null ? Math.round(w.start * 1000) : lastMs;
      const endMs = w.end != null ? Math.round(w.end * 1000) : startMs;
      lastMs = endMs;
      tokens.push({
        // Audio events are off, but keep a gap if one slips through so words don't merge.
        text: w.type === 'audio_event' ? ' ' : w.text,
        startMs,
        endMs,
        speaker: w.speaker_id ?? undefined,
        language: w.type === 'word' ? lang : undefined,
      });
    }
    const secs = raw.audio_duration_secs;
    return { tokens, durationMs: typeof secs === 'number' ? Math.round(secs * 1000) : undefined };
  },

  async testKey(apiKey) {
    // Keys can be permission-scoped, so prove the Speech to Text permission
    // itself by transcribing half a second of silence.
    const dir = await appCacheDir();
    await mkdir(dir, { recursive: true });
    const path = await join(dir, `elevenlabs-keytest-${Date.now()}.wav`);
    await writeFile(path, silentWav());
    try {
      await post(apiKey, path, [
        ['model_id', this.model],
        ['tag_audio_events', 'false'],
      ]);
    } finally {
      await remove(path).catch(() => {});
    }
  },
};
