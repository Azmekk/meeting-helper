<p align="center">
  <img src="app/src-tauri/app-icon.svg" width="96" alt="">
</p>

<h1 align="center">Meeting Helper</h1>

<p align="center">
  Record online meetings, get an editable Bulgarian/English transcript with speakers,<br>
  and search every meeting by word to jump to the moment it was said.
</p>

<p align="center">
  <a href="https://meetinghelper.vexbyte.com/"><b>Website</b></a> · <a href="../../releases/latest"><b>Download</b></a>
</p>

---

- **Record** through OBS Studio, controlled from the app: codec, quality, format and output folder.
  Your mic and the other people go on separate audio tracks, so your lines are always labelled as you.
- **Transcribe** with Soniox or ElevenLabs, your choice per meeting, with speaker detection. Run both
  on the same meeting and switch between the transcripts to see which did better.
- **Edit** text, rename speakers ("Speaker 2" → "Ivan"), reassign or merge lines. Click a line's
  timestamp to play the recording from there.
- **Search** across all meetings, or within one. Copes with Bulgarian word endings: `среща` finds
  `срещата` and `срещи`. Each hit links to the exact timestamp.

Everything stays on your computer except the audio sent to the transcription provider you pick.

## Install

Download the latest build from the [website](https://meetinghelper.vexbyte.com/) or the [Releases](../../releases) page:

| System | File |
|---|---|
| Windows | `…_x64-setup.exe` (`…_arm64-setup.exe` on ARM PCs) |
| macOS | `…_aarch64.dmg` for Apple Silicon (M1 and later), `…_x64.dmg` for Intel |
| Linux | `.AppImage` (any distro), `.deb` (Debian/Ubuntu) or `.rpm` (Fedora) |

The builds aren't code-signed, so the first launch needs one extra step:

- **Windows**: SmartScreen says "Windows protected your PC" → **More info → Run anyway**.
- **macOS**: if it says the app is damaged or can't be opened, run this once in Terminal:
  `xattr -cr "/Applications/Meeting Helper.app"`

You also need:

- **ffmpeg** (converts recordings and pulls out the audio):
  - Windows: `winget install Gyan.FFmpeg`
  - macOS: `brew install ffmpeg`
  - Linux: `sudo apt install ffmpeg` or `sudo dnf install ffmpeg`
- **[OBS Studio](https://obsproject.com) 30+**, only for recording. Importing existing files works
  without it.
- **An API key** for Soniox and/or ElevenLabs. Settings walks you through getting one.

## First run

1. **Settings → Soniox / ElevenLabs**: paste a key and press **Test key**. Each tab has a step-by-step
   guide for getting the key. The starred provider is the default for new transcriptions.
2. **Settings → Language**: Bulgarian and English are preselected. Add names and jargon under
   *Custom vocabulary* so they're spelled right.
3. **Settings → Recording**: set your name; it's used for the lines from your microphone.

### Recording a meeting

1. In OBS: **Tools → WebSocket Server Settings → Enable WebSocket server**, then **Show Connect
   Info** and copy the password.
2. In the app: **Record**, paste the password, **Connect**. The app sets up OBS's audio tracks and
   recording output for you.
3. Wear headphones (otherwise your mic also picks up the other people), press record, then stop.
   The recording is converted to MP4 and transcribed automatically.

### Importing a recording

**Meetings → Import recording** and pick any audio or video file. To compare providers, open the
meeting and use **Transcribe with… → the other provider**; both transcripts are kept.

## Cost

You pay the provider directly, per hour of audio:

| Provider | Per hour | Notes |
|---|---|---|
| Soniox (`stt-async-v5`) | about $0.10 | Uses all language hints; good with Bulgarian/English switching |
| ElevenLabs (`scribe_v2`) | about $0.22 | Custom vocabulary adds about $0.05 |

With **Transcribe my microphone separately** on (the default), your mic and the desktop audio are
sent as two tracks, which doubles the cost. Turn it off in **Settings → Recording** to send one
mixed track.

## Where data lives

| | Windows | macOS | Linux |
|---|---|---|---|
| Meetings database and settings | `%APPDATA%\com.meetinghelper.app` | `~/Library/Application Support/com.meetinghelper.app` | `~/.local/share/com.meetinghelper.app` |
| API keys and OBS password | Credential Manager | Keychain | Secret Service (GNOME Keyring / KWallet) |

Recordings stay in the folder you chose. **Settings → System → Open folder** opens the data folder.

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
