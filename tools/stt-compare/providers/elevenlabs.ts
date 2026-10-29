import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import type { Provider } from '../types.ts';

// Docs: https://elevenlabs.io/docs/api-reference/speech-to-text/convert
const URL = 'https://api.elevenlabs.io/v1/speech-to-text';

export const elevenlabs: Provider = {
  name: 'elevenlabs',
  model: 'scribe_v2',
  envKey: 'ELEVENLABS_API_KEY',
  usdPerHour: 0.22,

  async transcribe(file, opts, apiKey) {
    const form = new FormData();
    form.append('model_id', this.model);
    form.append('file', await openAsBlob(file), basename(file));
    form.append('diarize', 'true');
    form.append('timestamps_granularity', 'word');
    form.append('tag_audio_events', 'false');
    // Scribe takes a single language; the first hint is the main one.
    if (opts.languages.length) form.append('language_code', opts.languages[0]);
    if (opts.maxSpeakers) form.append('num_speakers', String(opts.maxSpeakers));
    // Keyterms are billed extra by ElevenLabs.
    for (const term of opts.terms) form.append('keyterms', term);

    let res: Response;
    try {
      res = await fetch(URL, { method: 'POST', headers: { 'xi-api-key': apiKey }, body: form });
    } catch (err: any) {
      if (err?.cause?.code === 'UND_ERR_HEADERS_TIMEOUT') {
        throw new Error('ElevenLabs took over 5 minutes to respond; try a shorter clip with --from/--to');
      }
      throw err;
    }
    const body = await res.text();
    if (!res.ok) throw new Error(`ElevenLabs request failed: ${res.status} ${body}`);
    return JSON.parse(body);
  },

  parse(raw) {
    const tokens = raw.words.map((w: any) => ({
      // Audio events are off, but keep a gap if one slips through so words don't merge.
      text: w.type === 'audio_event' ? ' ' : w.text,
      startMs: Math.round(w.start * 1000),
      endMs: Math.round(w.end * 1000),
      speaker: w.speaker_id ?? undefined,
    }));
    return { tokens, durationSec: raw.audio_duration_secs, detectedLanguage: raw.language_code };
  },
};
