# MIDI Studio

One Windows app combining two tools:

- **Midi-Forge** — turn a song (file or YouTube/URL) into a MIDI, using AI source separation
  (BS-Rofo-SW-Fixed) + transcription (Transkun for piano, basic-pitch for general).
- **Midi-Player** — play a MIDI into any Windows app (Roblox piano games, [virtualpiano.net](https://virtualpiano.net),
  …) by simulating keypresses, with a real-time piano-roll, global hotkeys, and focus-aware pause.

Built as one Electron app with a bundled Python engine, an **in-app dependency downloader**, and a
**built-in auto-updater**.

## Download & run

Grab **`MIDI-Studio-<version>-portable.exe`** from the [Releases](https://github.com/StarsationX/midi-studio/releases)
page and double-click it. No install, no admin, **no Python required** — the Midi-Player tab works
immediately.

The first time you use **Midi-Forge**, click **"Set up Midi-Forge"** — it downloads PyTorch + the
model into `%LOCALAPPDATA%\midi-studio\forge-env` (~3 GB, NVIDIA GPU recommended). A one-time step.

> Windows SmartScreen may warn "unknown publisher" because the build isn't code-signed yet —
> choose **More info → Run anyway**.

## Updates

The app checks [Releases](https://github.com/StarsationX/midi-studio/releases) a few seconds after
launch (toggleable in **⚙ Settings**), verifies the download's **SHA-256** against the **digest GitHub
publishes for each release asset** (`asset.digest` in the API — no sidecar checksum file needed), and
applies it with a safe swap (keeps a backup, restores on failure). You can also check manually from
the version badge or **⚙ Settings**.

## Build from source

```powershell
git clone https://github.com/StarsationX/midi-studio.git
cd midi-studio
npm install
npm start                  # run in dev (needs Python 3.10+ with the player deps on PATH)

npm run build:portable     # -> dist/MIDI-Studio-<ver>-portable.exe + dist/SHA256SUMS.txt
npm run build:nsis         # -> NSIS installer
npm test                   # unit tests
```

`build:portable` first runs `build-portable.bat`, which builds a small bundled Python
(`python-engine/python/`) with the player deps so the portable exe is zero-install.

## Architecture

```
electron/        main process, Python sidecar manager, forge runner/provisioner, updater
renderer/        shell (two tab iframes) + forge tab + the original player renderer
python-engine/   ipc_main.py + midi_player.py (player engine, verbatim);
                 song_to_midi/transcribe/stem_to_midi/yt_download/... (forge pipeline);
                 provision_forge.py (the dependency downloader)
.github/         CI release workflow (build on Windows, publish + checksums on a v* tag)
```

## License

MIT — see [LICENSE](./LICENSE).
