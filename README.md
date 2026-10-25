# video2mp4

Interactive command-line tool that converts **YouTube** and **TikTok** videos into edit-ready **MP4 (H.264 + AAC)** files, named after the video title and saved to the folder you run it from.

Everything it needs - the [yt-dlp](https://github.com/yt-dlp/yt-dlp) download engine and [FFmpeg](https://ffmpeg.org) with the H.264/AAC codecs - is installed automatically by the setup script. No Python, no manual FFmpeg install, no PATH editing.

## Install

### Windows

```cmd
git clone https://github.com/fullstackjefsong/video2mp4.git
cd video2mp4
setup.cmd
```

(Or just double-click `setup.cmd` in Explorer.)

**Downloaded the ZIP instead?** Extract it first (right-click, *Extract All*), then double-click `setup.cmd` in the extracted folder. Only approve Windows security prompts if you trust the downloaded source.

On Windows, setup installs a private Node.js runtime and command launchers under `%LOCALAPPDATA%\video2mp4`. It does not need administrator rights, winget, npm's global prefix, or permission to run npm PowerShell scripts.

If you run setup from **Command Prompt**, `video2mp4` is available in that same prompt immediately. For PowerShell, Windows Terminal, VS Code or Git Bash that were already open, **fully close and reopen the host application**, not just its terminal tab. Windows cannot change the environment of an already-running parent process.

To activate without restarting an existing PowerShell session:

```powershell
$env:Path = "$env:LOCALAPPDATA\video2mp4\command;$env:Path"
video2mp4 --version
```

In an existing Git Bash session:

```bash
export PATH="$(cygpath -u "$LOCALAPPDATA")/video2mp4/command:$PATH"
hash -r
video2mp4 --version
```

### macOS / Linux

```bash
git clone https://github.com/fullstackjefsong/video2mp4.git
cd video2mp4
./setup.sh
```

### Alternative: one-liner without cloning (Node.js 20+ already installed)

```bash
npm install -g github:fullstackjefsong/video2mp4 --allow-scripts=video2mp4
```

If your npm version skips install scripts, yt-dlp and FFmpeg are downloaded automatically the first time you run `video2mp4`.

The setup script:

1. On Windows, copies an available Node.js 20+ executable into the private runtime, or downloads Node.js LTS from nodejs.org and verifies its SHA-256 checksum. On macOS/Linux, uses Homebrew or nvm if Node.js 20+ is missing.
2. Downloads the standalone yt-dlp binary (SHA-256 verified) and a static FFmpeg + FFprobe build for your OS/CPU (Windows x64/ARM64/x86, macOS Intel/Apple Silicon, Linux x64/ARM64) into `vendor/`.
3. Copies the app to a permanent per-user location: `%LOCALAPPDATA%\video2mp4` on Windows, `${XDG_DATA_HOME:-~/.local/share}/video2mp4` on macOS/Linux.
4. On Windows, persists `%LOCALAPPDATA%\video2mp4\command` on the user PATH, notifies Windows of the environment change, and verifies command discovery in fresh cmd and PowerShell child processes. On macOS/Linux, persists Node and npm's global bin folder in bash/zsh startup files.

An internet connection is needed during setup (Node.js, yt-dlp and FFmpeg are downloaded for your exact OS/CPU). Setup fails if required dependencies cannot be downloaded or executed; it does not report a successful installation with missing tools. After successful setup, **the cloned or extracted folder can be deleted**.

Launch a fresh terminal application afterwards and `video2mp4` is available for the Windows user who ran setup. Other Windows accounts must run setup separately.

> Git cannot run scripts automatically on `git clone` (a security restriction), so running the setup script once after cloning or extracting is the only manual step.

## Usage

```text
> video2mp4

 _______________________________________________________________________
|  ___________________________________________________________________  |
| | VHS | T-120 | SP =========================== HI-FI STEREO  v1.0.0 | |
| |          _     _           ____                  _  _             | |
| |   __   _(_) __| | ___  ___|___ \ _ __ ___  _ __ | || |            | |
| |   \ \ / / |/ _` |/ _ \/ _ \ __) | '_ ` _ \| '_ \| || |_           | |
| |    \ V /| | (_| |  __/ (_) / __/| | | | | | |_) |__   _|          | |
| |     \_/ |_|\__,_|\___|\___/_____|_| |_| |_| .__/   |_|            | |
| |                                           |_|                     | |
| |                                                                   | |
| |                             -- by --                              | |
| |     __      _ _    _           _    _      __                     | |
| |    / _|_  _| | |__| |_ __ _ __| |__(_)___ / _|___ ___ _ _  __ _   | |
| |   |  _| || | | (_-<  _/ _` / _| / /| / -_)  _(_-</ _ \ ' \/ _` |  | |
| |   |_|  \_,_|_|_/__/\__\__,_\__|_\_\/ \___|_| /__/\___/_||_\__, |  | |
| |                                  |__/                     |___/   | |
| |___________________________________________________________________| |
|                                                                       |
|         ____________________________________________________          |
|        |     .-''''''''-.                                   |         |
|        |   .'   .----.   '.                     .-''''-.    |         |
|        |  |    |  ()  |    |=====================|  ()  |   |         |
|        |   '.   '----'   .'                     '-....-'    |         |
|        |     '-........-'                                   |         |
|        |____________________________________________________|         |
|                                                                       |
|            << REW    [] STOP    > PLAY    >> FF    (o) REC            |
|          YouTube / TikTok  ->  MP4  *  H.264 + AAC  *  1080p          |
|_______________________________________________________________________|

? YouTube or TikTok URL: https://www.tiktok.com/@funnyanimals576/video/7689026282587278622?is_from_webapp=1
  Checking TikTok video... OK
  Title:    The most Epic LEGO fail #Foryou #fyp #usa #tiktok #funny
  Channel:  funnyanimals576
  Duration: 1:46
  Source:   1080x1920 (1080p, vertical)

? Press Enter to convert [MP4 up to 1080p - H.264 + AAC 192k], or type lofi / insane (n to cancel):

  Converting to MP4 up to 1080p - H.264 + AAC 192k ...
  Video: H.264 1080x1920 @ 30 fps (CRF 18, medium, max 3.0 Mbps)
  Audio: AAC 192k 48 kHz stereo
  Done! Saved: C:\Videos\The most Epic LEGO fail #Foryou #fyp #usa #tiktok #funny.mp4
```

1. Enter a YouTube URL (`youtu.be/...`, `youtube.com/watch?v=...`, Shorts, live, embed) or a TikTok URL (`tiktok.com/@user/video/...`, `vm.tiktok.com/...` / `vt.tiktok.com/...` share links). Tracking parameters like `?si=` or `?is_from_webapp=` are stripped.
2. The URL is validated and the video is checked for accessibility (private, removed, age-restricted, region-locked, photo slideshows and still-live streams are reported and you are asked for another URL).
3. The source resolution is shown, then choose the output profile:

| Input    | Video                                                         | Audio          | Best for |
|----------|---------------------------------------------------------------|----------------|----------|
| *Enter*  | H.264 High, source resolution capped at **1080p**, up to 60 fps | AAC-LC 192k   | Default - archiving and remixing; native upload format for YouTube & TikTok |
| `lofi`   | H.264 Main, **480p**, up to 30 fps                             | AAC-LC 96k    | Previews, chat apps, small files |
| `insane` | H.264 High, **full source resolution** (4K / 8K), source fps, CRF 15 | AAC-LC 320k | Maximum quality from high-definition sources |
| `n`      | Cancel                                                        |                |          |

The file is written to the current directory and named after the video title (an existing file is never overwritten - ` (2)`, ` (3)`... is appended). Characters that are not allowed in file names (such as `/`, `:` or `?`) are replaced with look-alike Unicode characters.

### Why MP4 + H.264 + AAC for every profile?

It is the only combination that works **everywhere without conversion**: Premiere Pro, DaVinci Resolve, Final Cut, CapCut, iMovie, phones, browsers, and the upload pipelines of YouTube, TikTok and Instagram. MKV/WebM (VP9, AV1, Opus) are not accepted by many editors, ProRes/MOV is ~10x larger, and HEVC still has gaps in older editors and on Windows.

Every output is also prepared specifically for editing:

- **Constant frame rate** - variable frame rate (common on TikTok and phone footage) causes audio drift in editors, so it is always converted to the nearest standard rate (23.976 / 24 / 25 / 29.97 / 30 / 50 / 59.94 / 60).
- **2-second keyframe interval** - smooth scrubbing and frame-accurate cuts on the timeline.
- **yuv420p 8-bit, square pixels, even dimensions** - the universally decodable pixel format.
- **AAC-LC 48 kHz stereo** - the editing/video standard (HE-AAC from TikTok is converted to LC).
- **+faststart** - plays instantly in browsers and previews.
- **Vertical stays vertical** - the 1080p / 480p caps apply to the shorter side, so a TikTok stays 1080x1920.
- **SDR source preferred** - HDR streams are skipped in favour of the SDR version, so colours are not washed out.

### Smart copy (no quality loss)

If the downloaded stream already matches the profile (H.264, yuv420p, constant frame rate, within the resolution/fps cap; AAC-LC audio), it is copied into the MP4 **without re-encoding** - instant and bit-identical to the source. YouTube videos up to 1080p usually convert this way. Otherwise the stream is re-encoded with libx264; the bitrate is capped relative to the source (2.5x for HEVC/VP9/AV1, 1.5x for others) because re-encoding cannot add detail, so files do not balloon.

### Notes on `insane`

- Use it for 1440p / 4K / 8K sources. For sources of 1080p or lower it keeps the full source quality and raises audio to 320k.
- 4K+ in H.264 is encoded in software and is CPU-heavy - expect several times the video length (e.g. ~5x on a laptop for 4K60). H.264 at 4K/8K plays in all modern editors but 8K H.264 may not decode on older hardware.

### Other commands

```text
video2mp4 <url>        Skip the URL prompt
video2mp4 --update     Update the bundled yt-dlp engine (run this if downloads start failing)
video2mp4 --version    Show version
video2mp4 --help       Show help
```

## Updating / uninstalling

Update the yt-dlp engine only (fixes most "site changed" errors):

```bash
video2mp4 --update
```

Update the tool itself: `git pull` (or download a fresh ZIP and extract it), then run `setup.cmd` / `./setup.sh` again. Setup overwrites the installed copy and keeps already downloaded binaries.

Uninstall on Windows after using `setup.cmd`: remove `%LOCALAPPDATA%\video2mp4\command` from your **user** Path in Windows Environment Variables, then delete `%LOCALAPPDATA%\video2mp4`. Restart terminal applications afterwards. If you previously installed through npm, also run `npm.cmd uninstall -g video2mp4` to remove its old shims.

Uninstall on macOS/Linux (or for an npm-only install):

```bash
npm uninstall -g video2mp4
```

Then delete the install folder (`${XDG_DATA_HOME:-~/.local/share}/video2mp4` on macOS/Linux).

## Notes

- YouTube and TikTok change their sites frequently; if downloads fail, run `video2mp4 --update`.
- Only download content you have the right to download and remix, in accordance with the platforms' Terms of Service and your local copyright law.

## License

MIT
