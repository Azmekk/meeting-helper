<div align="center">

<img src="app/src-tauri/app-icon.svg" width="96" height="96" alt="Meeting Helper icon">

# Meeting Helper

**Record online meetings, get an editable Bulgarian/English transcript with speakers, and find anything that was said.**

[![Latest release](https://img.shields.io/github/v/release/Azmekk/meeting-helper?label=download&color=1f8a7a&cacheSeconds=3600)](https://github.com/Azmekk/meeting-helper/releases/latest)
![Windows · macOS · Linux](https://img.shields.io/badge/Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-x64%20%7C%20ARM64-555)
[![Downloads](https://img.shields.io/github/downloads/Azmekk/meeting-helper/total?color=555)](https://github.com/Azmekk/meeting-helper/releases)

[**Website**](https://meetinghelper.vexbyte.com/) · [**Download**](https://github.com/Azmekk/meeting-helper/releases/latest) · [Features](#features) · [First run](#first-run) · [Cost](#cost) · [FAQ](#faq) · [Development](#development)

<img src="docs/screenshots/meeting-dark.webp" alt="A meeting open in Meeting Helper: the audio player and speaker list on the left, the Bulgarian/English transcript with named speakers and timestamps on the right" width="900">

</div>

Record a call through OBS (or import any recording), pick Soniox or ElevenLabs, and a few minutes later you have a transcript with speakers that you can edit, export and search. Click any line to hear the moment it was said.

## Features

<table>
<tr>
<td width="50%" valign="top">

### 🎙️ Record
Through OBS Studio, controlled from the app: codec, quality, format and output folder. Your mic and the other people go on separate audio tracks, so your lines are always labelled as you.

### 📝 Transcribe
With Soniox or ElevenLabs, your choice per meeting, with speaker detection. Run both on the same meeting and switch between the transcripts to see which did better.

</td>
<td width="50%" valign="top">

### ✏️ Edit
Fix text, rename speakers ("Speaker 2" → "Ivan"), reassign or merge lines. Click a line's timestamp to play the recording from there. Export to text, Markdown or subtitles.

### 🔍 Search
Across all meetings, or within one. Copes with Bulgarian word endings: `среща` finds `срещата` and `срещи`. Each hit links to the exact timestamp.

</td>
</tr>
</table>

<div align="center">
<img src="docs/screenshots/search-light.webp" alt="Search across meetings in the light theme: the word среща also matches срещата, and each hit shows the speaker and timestamp" width="900">
<br><sub>Searching every meeting at once, in the light theme</sub>
</div>

Everything stays on your computer except the audio sent to the transcription provider you pick.

## Download

Get the latest build from the [**website**](https://meetinghelper.vexbyte.com/) or the [**Releases page**](https://github.com/Azmekk/meeting-helper/releases/latest):

| System | File |
|---|---|
| Windows | `…_x64-setup.exe` (`…_arm64-setup.exe` on ARM PCs) |
| macOS | `…_aarch64.dmg` for Apple Silicon (M1 and later), `…_x64.dmg` for Intel |
| Linux | `.AppImage` (any distro), `.deb` (Debian/Ubuntu) or `.rpm` (Fedora) |

**You also need:**

- **ffmpeg** (converts recordings and pulls out the audio):
  - Windows: `winget install Gyan.FFmpeg`
  - macOS: `brew install ffmpeg`
  - Linux: `sudo apt install ffmpeg` or `sudo dnf install ffmpeg`
- **[OBS Studio](https://obsproject.com) 30+**, only for recording. Importing existing files works without it.
- **An API key** for Soniox and/or ElevenLabs. Settings walks you through getting one.

The app tells you if ffmpeg or OBS is missing, and when a new version is out.

## First run

1. **Settings → Soniox / ElevenLabs**: paste a key and press **Test key**. Each tab has a step-by-step guide for getting the key. The starred provider is the default for new transcriptions.
2. **Settings → Language**: Bulgarian and English are preselected. Add names and jargon under *Custom vocabulary* so they're spelled right.
3. **Settings → Recording**: set your name; it's used for the lines from your microphone.

### Recording a meeting

1. In OBS: **Tools → WebSocket Server Settings → Enable WebSocket server**, then **Show Connect Info** and copy the password.
2. In the app: **Record**, paste the password, **Connect**. The app sets up OBS's audio tracks and recording output for you.
3. Wear headphones (otherwise your mic also picks up the other people), press record, then stop. The recording is converted to MP4 and transcribed automatically.

### Importing a recording

**Meetings → Import recording** and pick any audio or video file. To compare providers, open the meeting and use **Transcribe with… → the other provider**; both transcripts are kept.

## Cost

You pay the provider directly, per hour of audio:

| Provider | Per hour | Notes |
|---|---|---|
| Soniox (`stt-async-v5`) | about $0.10 | Uses all language hints; good with Bulgarian/English switching |
| ElevenLabs (`scribe_v2`) | about $0.22 | Custom vocabulary adds about $0.05 |

With **Transcribe my microphone separately** on (the default), your mic and the desktop audio are sent as two tracks, which doubles the cost. Turn it off in **Settings → Recording** to send one mixed track.

## FAQ

<details>
<summary><b>Windows says "Windows protected your PC", or macOS says the app is damaged</b></summary>

The builds aren't code-signed yet. On Windows, click **More info → Run anyway**. On macOS, run this once in Terminal:

```bash
xattr -cr "/Applications/Meeting Helper.app"
```

Every release is built from this repository by [GitHub Actions](https://github.com/Azmekk/meeting-helper/actions/workflows/release.yml), so you can check exactly what went into it.
</details>

<details>
<summary><b>Where do my recordings and transcripts go?</b></summary>

Recordings stay in the folder you chose. Transcripts live in a local database, and the only thing that leaves your computer is the audio sent to the provider you pick for that meeting. There's no account and no telemetry; the app otherwise only goes online to check GitHub for a new release.

| | Windows | macOS | Linux |
|---|---|---|---|
| Meetings database and settings | `%APPDATA%\com.meetinghelper.app` | `~/Library/Application Support/com.meetinghelper.app` | `~/.local/share/com.meetinghelper.app` |
| API keys and OBS password | Credential Manager | Keychain | Secret Service (GNOME Keyring / KWallet) |

**Settings → System → Open folder** opens the data folder.
</details>

<details>
<summary><b>Why are my lines labelled as someone else?</b></summary>

Your mic is only kept apart when the recording has separate tracks and you wear headphones. Without headphones the desktop track hears you too. You can fix lines afterwards: reassign them to the right speaker, or merge them with the next line.
</details>

<details>
<summary><b>Which provider should I use?</b></summary>

Soniox is cheaper and handles switching between Bulgarian and English well, so it's the default. If a transcript comes out poorly, run ElevenLabs on the same meeting and compare; both transcripts are kept and you can switch between them.
</details>

## Development

The app is in [app/](app/): Tauri v2 (Rust) with React, TypeScript, Tailwind CSS and SQLite.

Requirements: [Bun](https://bun.sh) 1.3+ and [Rust](https://rustup.rs) (stable), plus the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS (Visual Studio Build
Tools on Windows, Xcode Command Line Tools on macOS; on Linux also `libdbus-1-dev`).

```bash
cd app
bun install
bun run tauri dev
```

`bun run tauri build` makes an installer for your own OS in `app/src-tauri/target/release/bundle/`.

### Download page

[`site/`](site/) is the download page: plain HTML with no build step. It's served by Cloudflare
Workers using [`wrangler.jsonc`](wrangler.jsonc); run `npx wrangler deploy` to publish it, or connect
the repo in Cloudflare so every push to `main` deploys it. Its download buttons read the latest
published release from the GitHub API.

### Releasing

[`.github/workflows/release.yml`](.github/workflows/release.yml) builds all six targets (Windows,
macOS and Linux, each on x64 and ARM64) and publishes them as a GitHub release once every build has
succeeded. Until then the release stays a draft, so nobody sees it with installers missing.

1. Bump `version` in [`app/src-tauri/tauri.conf.json`](app/src-tauri/tauri.conf.json) and commit.
2. Push a matching tag, or run the **Release** workflow from the Actions tab:
   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```
3. That's it. In about 10 minutes the release is live, the download page links to the new
   installers, and the app tells existing users a new version is out. If a build fails, the draft
   stays on the Releases page: fix the problem and run the workflow again (it reuses the draft).

## License

Free for personal use, including at work: install it, use it, build it from source and modify it
for yourself. Selling it, offering it as a service, redistributing it or reusing its code in other
projects is not allowed without written permission. The source is public so you can see how it
works and send improvements. It isn't open source. See [LICENSE](LICENSE) for the full terms.
