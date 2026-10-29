// Soniox async transcription.
// Docs: https://soniox.com/docs/stt/async/async-transcription
// Flow: upload file → create transcription → poll → fetch tokens → delete
// both the transcription and the file so no meeting data stays on their side.
import { fetch } from '@tauri-apps/plugin-http';
import { uploadMultipart } from '../native';
import type { ProviderToken, SttProvider } from './types';

const API = 'https://api.soniox.com/v1';
const POLL_MS = 2000;
// Async jobs usually finish in a fraction of real time; this is a safety net.
const TIMEOUT_MS = 3 * 60 * 60 * 1000;
const UPLOAD_TIMEOUT_SECS = 3600;

// Soniox error bodies look like
// { status_code, error_type, message, validation_errors: [{ location?, message }] }.
function describeError(status: number, body: string): string {
  let message = '';
  let type = '';
  let details = '';
  try {
    const json = JSON.parse(body);
    message = typeof json.message === 'string' ? json.message : '';
    type = typeof json.error_type === 'string' ? json.error_type : '';
    if (Array.isArray(json.validation_errors) && json.validation_errors.length) {
      details = json.validation_errors
        .map((v: any) => [v.location, v.message].filter(Boolean).join(': '))
        .join('; ');
    }
  } catch {
    message = body.slice(0, 300);
  }
  const lower = `${type} ${message}`.toLowerCase();

  if (status === 401) return 'Soniox rejected the API key. Check it in Settings.';
  if (status === 402 || /balance|credit|quota|payment|billing/.test(lower)) {
    return 'Your Soniox account is out of credit or over its quota. Top up at console.soniox.com.';
  }
  if (status === 403) return `Soniox refused the request (403)${message ? `: ${message}` : ''}.`;
  if (status === 429) return 'Soniox rate limit reached. Wait a minute and try again.';
  if (status === 400 || status === 422) {
    return `Soniox rejected the request: ${[message, details].filter(Boolean).join(' – ') || `HTTP ${status}`}`;
  }
  if (status >= 500) return `Soniox is having problems (HTTP ${status}). Try again later.`;
  return `Soniox error (HTTP ${status})${message ? `: ${message}` : ''}`;
}

// JSON call to the Soniox REST API.
async function call(path: string, apiKey: string, init: { method?: string; json?: unknown } = {}): Promise<any> {
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  if (init.json !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(API + path, {
      method: init.method ?? 'GET',
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    });
  } catch (err) {
    throw new Error(`Couldn't reach Soniox: ${err instanceof Error ? err.message : String(err)}`);
  }
  const body = await res.text();
  if (!res.ok) throw new Error(describeError(res.status, body));
  return body ? JSON.parse(body) : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const soniox: SttProvider = {
  id: 'soniox',
  name: 'Soniox',
  model: 'stt-async-v5',
  secret: 'soniox_api_key',
  usdPerHour: 0.1,

  async transcribe(audioPath, apiKey, opts) {
    const progress = opts.onProgress ?? (() => {});

    progress('Uploading audio to Soniox…');
    let upload;
    try {
      upload = await uploadMultipart({
        url: `${API}/files`,
        headers: { Authorization: `Bearer ${apiKey}` },
        fields: [],
        fileField: 'file',
        filePath: audioPath,
        timeoutSecs: UPLOAD_TIMEOUT_SECS,
      });
    } catch (err) {
      throw new Error(`Uploading to Soniox failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (upload.status < 200 || upload.status >= 300) throw new Error(describeError(upload.status, upload.body));
    const fileId: string = JSON.parse(upload.body).id;

    try {
      const job = await call('/transcriptions', apiKey, {
        method: 'POST',
        json: {
          model: this.model,
          file_id: fileId,
          language_hints: opts.languages.length ? opts.languages : undefined,
          enable_language_identification: true,
          enable_speaker_diarization: opts.diarize,
          context: opts.terms.length ? { terms: opts.terms } : undefined,
        },
      });

      try {
        const deadline = Date.now() + TIMEOUT_MS;
        let status: any;
        while (true) {
          status = await call(`/transcriptions/${job.id}`, apiKey);
          if (status.status === 'completed') break;
          if (status.status === 'error' || status.status === 'failed') {
            throw new Error(`Soniox couldn't transcribe the audio: ${status.error_message ?? 'unknown error'}`);
          }
          progress(status.status === 'queued' ? 'Queued at Soniox…' : 'Transcribing with Soniox…');
          if (Date.now() > deadline) throw new Error('Soniox transcription timed out');
          await sleep(POLL_MS);
        }

        progress('Downloading transcript from Soniox…');
        const transcript = await call(`/transcriptions/${job.id}/transcript`, apiKey);
        const tokens: ProviderToken[] = (transcript.tokens ?? []).map((t: any) => ({
          text: t.text,
          startMs: t.start_ms,
          endMs: t.end_ms,
          speaker: t.speaker != null ? String(t.speaker) : undefined,
          language: t.language ?? undefined,
        }));
        const ms = status.audio_duration_ms;
        return { tokens, durationMs: typeof ms === 'number' ? ms : undefined };
      } finally {
        // Don't leave meeting text sitting on their servers.
        await call(`/transcriptions/${job.id}`, apiKey, { method: 'DELETE' }).catch(() => {});
      }
    } finally {
      await call(`/files/${fileId}`, apiKey, { method: 'DELETE' }).catch(() => {});
    }
  },

  async testKey(apiKey) {
    // Cheap authenticated call: list at most one uploaded file.
    await call('/files?limit=1', apiKey);
  },
};
