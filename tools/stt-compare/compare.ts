// Send the same audio to several speech-to-text providers and compare them.
// Run `bun compare.ts --help` for usage.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { elevenlabs } from './providers/elevenlabs.ts';
import { soniox } from './providers/soniox.ts';
import { buildSegments, formatTime, labelSpeakers, languageMix, talkTime } from './segments.ts';
import { renderReport, type ReportColumn, type ReportRow } from './report.ts';
import { score } from './wer.ts';
import type { Options, Provider } from './types.ts';

const PROVIDERS: Provider[] = [soniox, elevenlabs];

const HELP = `Usage: bun compare.ts <audio-or-video-file> [options]

Options:
  --from <time>        Only use audio from this point (e.g. 10:00 or 00:10:00)
  --to <time>          Only use audio up to this point
  --ref <file>         Hand-checked transcript of the same audio, to compute WER/CER
  --lang <codes>       Language hints, most likely first (default: bg,en; "auto" to detect)
  --speakers <n>       Maximum number of speakers (ElevenLabs only)
  --terms <file>       Names/jargon to bias towards, one per line
  --providers <list>   Comma-separated subset of: ${PROVIDERS.map((p) => p.name).join(', ')}
  --force              Call the APIs again instead of reusing saved responses
  --out <dir>          Results directory (default: results)

API keys are read from .env next to this script (see .env.example).`;

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    from: { type: 'string' },
    to: { type: 'string' },
    ref: { type: 'string' },
    lang: { type: 'string', default: 'bg,en' },
    speakers: { type: 'string' },
    terms: { type: 'string' },
    providers: { type: 'string' },
    force: { type: 'boolean', default: false },
    out: { type: 'string', default: join(import.meta.dirname, 'results') },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (args.help || positionals.length !== 1) {
  console.log(HELP);
  process.exit(args.help ? 0 : 1);
}

const envFile = join(import.meta.dirname, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const input = resolve(positionals[0]);
if (!existsSync(input)) fail(`File not found: ${input}`);

const providers = args.providers
  ? args.providers.split(',').map((name) => PROVIDERS.find((p) => p.name === name.trim()) ?? fail(`Unknown provider: ${name}`))
  : PROVIDERS;

const opts: Options = {
  languages: args.lang === 'auto' ? [] : args.lang.split(',').map((l) => l.trim()).filter(Boolean),
  maxSpeakers: args.speakers ? Number(args.speakers) : undefined,
  terms: args.terms ? readFileSync(args.terms, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [],
};

const clipSuffix = args.from || args.to ? `_${args.from ?? 'start'}-${args.to ?? 'end'}`.replace(/[^\w-]/g, '') : '';
const runName = basename(input, extname(input)) + clipSuffix;
const outDir = join(args.out, runName);
mkdirSync(outDir, { recursive: true });

const audio = prepareAudio(input, outDir, args.from, args.to);
const reference = args.ref ? readFileSync(args.ref, 'utf8') : undefined;

console.log(`Audio:   ${audio}`);
console.log(`Results: ${outDir}\n`);

const results = await Promise.all(providers.map((p) => run(p)));

const rows: ReportRow[] = [];
const columns: ReportColumn[] = [];
for (const r of results) {
  if ('error' in r) {
    rows.push({ provider: r.provider.name, model: r.provider.model, error: r.error });
    continue;
  }
  const row: ReportRow = {
    provider: r.provider.name,
    model: r.provider.model,
    audio: formatTime(r.durationSec * 1000),
    'est. cost': `$${((r.durationSec / 3600) * r.provider.usdPerHour).toFixed(3)}`,
    'took (s)': r.cached ? `${r.elapsedSec.toFixed(0)} (saved)` : r.elapsedSec.toFixed(0),
    speakers: r.speakers.size,
    'talk time': [...r.speakers].map(([s, sec]) => `${s.replace('Speaker ', 'S')} ${formatTime(sec * 1000)}`).join(', '),
    languages: r.languages ?? '',
  };
  if (reference) {
    const { wer, cer } = score(reference, r.text);
    row.WER = pct(wer.rate);
    row['sub/del/ins'] = `${wer.sub}/${wer.del}/${wer.ins}`;
    row.CER = cer ? pct(cer.rate) : 'skipped';
    row['ref words'] = wer.refLength;
  }
  rows.push(row);
  columns.push({ name: r.provider.name, model: r.provider.model, segments: r.segments });
}

console.table(rows);

const reportPath = join(outDir, 'report.html');
writeFileSync(reportPath, renderReport(runName, basename(audio), rows, columns));
console.log(`\nSide-by-side report: ${reportPath}`);
if (!reference) console.log('Add --ref <file> with a hand-checked transcript to get WER/CER.');
if (results.some((r) => 'error' in r)) process.exitCode = 1;

// ---

async function run(provider: Provider) {
  const rawPath = join(outDir, `${provider.name}.raw.json`);
  try {
    let saved: { elapsedSec: number; raw: unknown };
    let cached = false;
    if (existsSync(rawPath) && !args.force) {
      saved = JSON.parse(readFileSync(rawPath, 'utf8'));
      cached = true;
      console.log(`[${provider.name}] using saved response (--force to re-run)`);
    } else {
      const apiKey = process.env[provider.envKey];
      if (!apiKey) throw new Error(`${provider.envKey} is not set`);
      console.log(`[${provider.name}] transcribing...`);
      const started = Date.now();
      const raw = await provider.transcribe(audio, opts, apiKey);
      saved = { elapsedSec: (Date.now() - started) / 1000, raw };
      writeFileSync(
        rawPath,
        JSON.stringify({ ...saved, model: provider.model, options: opts, createdAt: new Date().toISOString() }, null, 2),
      );
      console.log(`[${provider.name}] done in ${saved.elapsedSec.toFixed(0)}s`);
    }

    const parsed = provider.parse(saved.raw);
    const segments = labelSpeakers(buildSegments(parsed.tokens));
    const text = segments.map((s) => s.text).join('\n');
    const durationSec = parsed.durationSec ?? (parsed.tokens.at(-1)?.endMs ?? 0) / 1000;

    writeFileSync(
      join(outDir, `${provider.name}.txt`),
      segments.map((s) => `[${formatTime(s.startMs)}] ${s.speaker}: ${s.text}`).join('\n') + '\n',
    );

    return {
      provider,
      cached,
      elapsedSec: saved.elapsedSec,
      durationSec,
      segments,
      text,
      speakers: talkTime(segments),
      languages: languageMix(parsed.tokens) ?? parsed.detectedLanguage,
    };
  } catch (err: any) {
    console.error(`[${provider.name}] ${err.message}`);
    return { provider, error: String(err.message) };
  }
}

// Convert to 16 kHz mono FLAC: lossless for speech, small to upload, works for
// video input, and lets --from/--to cut a clip. Falls back to the original
// file if ffmpeg isn't installed.
function prepareAudio(file: string, dir: string, from?: string, to?: string): string {
  const target = join(dir, 'audio.flac');
  if (existsSync(target)) return target;

  const ffmpegArgs = ['-hide_banner', '-loglevel', 'error', '-y'];
  if (from) ffmpegArgs.push('-ss', from);
  if (to) ffmpegArgs.push('-to', to);
  ffmpegArgs.push('-i', file, '-vn', '-ac', '1', '-ar', '16000', target);

  const res = spawnSync('ffmpeg', ffmpegArgs, { stdio: 'inherit' });
  if (res.error || res.status !== 0) {
    if (from || to) fail('ffmpeg is needed for --from/--to but failed or is not installed');
    console.warn('ffmpeg not available; sending the original file as-is');
    return file;
  }
  return target;
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
