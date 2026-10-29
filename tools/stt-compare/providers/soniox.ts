import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Provider } from '../types.ts';

// Docs: https://soniox.com/docs/stt/async/async-transcription
const API = 'https://api.soniox.com/v1';
const POLL_MS = 2000;
const TIMEOUT_MS = 60 * 60 * 1000;

async function call(path: string, apiKey: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(API + path, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, ...init.headers },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Soniox ${init.method ?? 'GET'} ${path} failed: ${res.status} ${body}`);
  return body ? JSON.parse(body) : null;
}

export const soniox: Provider = {
  name: 'soniox',
  model: 'stt-async-v5',
  envKey: 'SONIOX_API_KEY',
  usdPerHour: 0.1,

  async transcribe(file, opts, apiKey) {
    const form = new FormData();
    form.append('file', await openAsBlob(file), basename(file));
    const uploaded = await call('/files', apiKey, { method: 'POST', body: form });

    try {
      const job = await call('/transcriptions', apiKey, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          file_id: uploaded.id,
          language_hints: opts.languages.length ? opts.languages : undefined,
          enable_language_identification: true,
          enable_speaker_diarization: true,
          context: opts.terms.length ? { terms: opts.terms } : undefined,
        }),
      });

      try {
        const deadline = Date.now() + TIMEOUT_MS;
        let status: any;
        while (true) {
          status = await call(`/transcriptions/${job.id}`, apiKey);
          if (status.status === 'completed') break;
          if (status.status === 'error' || status.status === 'failed') {
            throw new Error(`Soniox transcription failed: ${status.error_message ?? 'unknown error'}`);
          }
          if (Date.now() > deadline) throw new Error('Soniox transcription timed out');
          await sleep(POLL_MS);
        }
        const transcript = await call(`/transcriptions/${job.id}/transcript`, apiKey);
        return { transcription: status, transcript };
      } finally {
        // Don't leave meeting audio or text sitting on their servers.
        await call(`/transcriptions/${job.id}`, apiKey, { method: 'DELETE' }).catch(() => {});
      }
    } finally {
      await call(`/files/${uploaded.id}`, apiKey, { method: 'DELETE' }).catch(() => {});
    }
  },

  parse(raw) {
    const tokens = raw.transcript.tokens.map((t: any) => ({
      text: t.text,
      startMs: t.start_ms,
      endMs: t.end_ms,
      speaker: t.speaker != null ? String(t.speaker) : undefined,
      language: t.language,
    }));
    const ms = raw.transcription.audio_duration_ms;
    return { tokens, durationSec: ms != null ? ms / 1000 : undefined };
  },
};
