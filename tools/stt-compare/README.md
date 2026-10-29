# stt-compare

Sends the same audio to **Soniox** (`stt-async-v5`) and **ElevenLabs** (`scribe_v2`), both with
speaker diarization, and compares the results:

- a summary table (cost, speed, speakers found, talk time per speaker, language mix)
- **WER/CER** against your own hand-checked transcript, if you give one
- `report.html`: both transcripts side by side with the audio; click a line to jump there

No dependencies: needs [Bun](https://bun.sh) (runs the `.ts` files directly) and ffmpeg on `PATH`.

## Setup (once)

1. Create API keys:
   - Soniox: https://console.soniox.com
   - ElevenLabs: https://elevenlabs.io/app/settings/api-keys (enable the Speech to Text permission)
2. `cp .env.example .env` and paste both keys in.

## Run

From this folder:

```bash
bun compare.ts "C:/path/to/meeting.mkv"
```

Any audio or video file works. It's converted to 16 kHz mono FLAC first (small upload, no quality
loss for speech). Results go to `results/<file-name>/`:

| File | What |
|---|---|
| `report.html` | Side-by-side view with an audio player. Open it in a browser. |
| `soniox.txt`, `elevenlabs.txt` | `[mm:ss] Speaker N: text`, one segment per line |
| `*.raw.json` | The untouched API responses |

Responses are saved, so re-running (for example to add `--ref`) **costs nothing**. Use `--force`
to call the APIs again (e.g. after changing `--lang` or `--terms`).

Privacy: the script deletes the uploaded file and transcript from Soniox once it has the result.
ElevenLabs keeps request logs by default (zero retention needs an enterprise plan), so mind what
you upload.

## Getting a fair WER number

WER only means something on a transcript you've checked by ear. Doing a full meeting is too much,
so use a clip:

1. Pick 5–10 minutes that is typical, ideally with crosstalk and some English mixed in:
   ```bash
   bun compare.ts meeting.mkv --from 12:00 --to 20:00
   ```
2. Open `results/meeting_1200-2000/report.html`, play it, and write `ref.txt`: what was **actually
   said**, word for word. The quickest way is to copy one provider's `.txt` and fix it while
   listening. The `[mm:ss] Speaker N:` prefixes are ignored, so you can leave them in. Fix it
   against the audio, not the other provider's text, or you'll favour the one you started from.
3. Score both (uses the saved responses, so it's free):
   ```bash
   bun compare.ts meeting.mkv --from 12:00 --to 20:00 --ref ref.txt
   ```

Reading the numbers:
- **WER** is the share of words wrong (substituted + deleted + inserted ÷ words in the reference). Lower is better.
- **CER** is the same per character. In Bulgarian a wrong ending (`срещата` vs `срещи`) counts as a
  whole word wrong in WER but only a letter or two in CER, so CER shows how close the "wrong" words were.
- Case and punctuation are ignored. Numbers aren't normalised: "3" vs "три" counts as an error,
  so write numbers the way the providers do, or fix them by hand when comparing.

Speaker detection has no automatic score. Check it in `report.html`: did each provider find the
right number of people, and how often does a line go to the wrong person? Count those mistakes in
the same clip.

The number that matters most in the end: **how many minutes it took you to fix each transcript.**

## Options

```
--from / --to <time>   Use only part of the file (10:00 or 00:10:00)
--ref <file>           Hand-checked transcript for WER/CER
--lang <codes>         Language hints, main one first (default bg,en; "auto" to detect).
                       Soniox gets all of them; ElevenLabs only takes the first.
--speakers <n>         Maximum speakers (ElevenLabs only)
--terms <file>         Names and jargon, one per line (ElevenLabs bills extra for these)
--providers <list>     e.g. --providers soniox
--force                Ignore saved responses and call the APIs again
```

Worth trying on the same clip: `--lang auto` versus the default, and `--terms` with your
teammates' names and product words. Both can change the results a lot on mixed Bulgarian/English.

## Cost

Estimated in the table from list prices (Oct 2026): Soniox about $0.10/h, ElevenLabs Scribe v2
batch $0.22/h (keyterms +$0.05/h). Testing a few meetings costs well under $1.

## Limits

- ElevenLabs answers in one long request, which can time out on very long files. If that
  happens on a long meeting, use `--from/--to` to split it.
- The report's highlighting follows each provider's segment times, so timing drift between the
  two is visible there too.
