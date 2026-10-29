# Meeting Helper

Record online meetings, get an editable Bulgarian/English transcript with speakers, and search
every meeting by word to jump to the moment it was said.

- **Recording**: OBS Studio, controlled from the app (codec, quality, format, output folder).
  Your mic and the other people go on separate audio tracks.
- **Transcription**: Soniox (`stt-async-v5`) or ElevenLabs (`scribe_v2`), your choice per meeting,
  with speaker detection. You can run both on the same meeting and switch between them.
- **Editing**: fix text, rename speakers ("Speaker 2" → "Ivan"), reassign or merge lines.
- **Search**: SQLite full-text search that copes with Bulgarian word endings
  (`среща` finds `срещата`, `срещи`).

| Folder | What |
|---|---|
| [app/](app/) | The desktop app (Tauri v2 + React + TypeScript, SQLite) |
| [tools/stt-compare/](tools/stt-compare/) | Command-line script that compares both providers on one file, with WER scoring |

## Requirements (Windows)

- [Bun](https://bun.sh) 1.3+ and Rust (stable, MSVC) with Visual Studio Build Tools: only for building
- [OBS Studio 30+](https://obsproject.com): only for recording; importing existing files works without it
- ffmpeg + ffprobe on `PATH` (`winget install Gyan.FFmpeg`), or set the path in Settings
- An API key for Soniox and/or ElevenLabs: the Settings screen explains how to get each

## Run it

```bash
cd app
bun install
bun run tauri dev
```

To build an installer: `bun run tauri build` (output in `app/src-tauri/target/release/bundle/`).

## Testing both providers

1. **Settings → Transcription providers**: paste each key, press **Test key**. The guide on each
   card shows where to get the key.
2. **Meetings → Import recording**: pick your existing audio/video file. It is transcribed with the
   default provider.
3. On the meeting page, **Transcribe with… → the other provider**. Both transcripts are kept: switch
   between them with the transcript picker at the top and compare text and speakers while the
   audio plays.
4. For a number instead of an impression, use the [comparison script](tools/stt-compare/README.md),
   which computes word error rate against a transcript you've checked by ear.

## Recording a meeting

1. In OBS: **Tools → WebSocket Server Settings → Enable WebSocket server**, then
   **Show Connect Info** and copy the password.
2. In the app: **Record**, paste the password, **Connect**. The app sets up OBS's audio tracks
   (track 2 = your mic, track 3 = desktop audio) and recording output for you.
3. Wear headphones (otherwise your mic also picks up the other people), press record, then stop.
   The recording is converted to MP4 and transcribed automatically.

## Where data lives

Meetings database, settings and temporary audio are in `%APPDATA%\com.meetinghelper.app\`.
API keys and the OBS password are in Windows Credential Manager, not in files. Recordings stay in
the folder you chose in OBS.
