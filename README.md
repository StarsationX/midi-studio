# MIDI Studio

One Windows app combining two tools:

Four tabs:

- **Midi Forge**, turn a song (file or YouTube/URL) into a MIDI, using AI source separation
  (BS-Rofo-SW-Fixed) + transcription (Transkun for piano, basic-pitch for general).
- **Midi Player**, play a MIDI into any Windows app (Roblox piano games, [virtualpiano.net](https://virtualpiano.net),
  …) by simulating keypresses, with a real-time piano-roll, global hotkeys, and focus-aware pause.
- **Midi Editor**, piano-roll editing of a Forge result against the original waveform: drag, box-select,
  quantize, transpose, undo/redo, and export.
- **Self Midi**, listen to a MIDI inside the app with bundled General MIDI instruments, no game needed.

Built as one Electron app with a bundled Python engine, an **in-app dependency downloader**, and a
**built-in auto-updater**.

## Download & run

Grab **`MIDI-Studio-<version>-Setup.exe`** from the [Releases](https://github.com/StarsationX/midi-studio/releases)
page and run the installer. **No separate Python install is required**, the Midi Player tab works immediately.

Setup asks where to keep the **Midi Forge** engine and models, then remembers that location for
upgrades. The first time you use Forge, click **"Set up Midi Forge"** to download PyTorch and the
models there (~4 GB downloaded, ~15 GB free space required on that drive; NVIDIA GPU recommended).
This is a one-time download, and the folder can be changed later in Settings.

> Windows SmartScreen may warn "unknown publisher" because the build isn't code-signed yet.
> choose **More info → Run anyway**.

## Updates

The app checks [Releases](https://github.com/StarsationX/midi-studio/releases) a few seconds after
launch (toggleable in **⚙ Settings**), verifies the download's **SHA-256** against the **digest GitHub
publishes for each release asset** (`asset.digest` in the API, no sidecar checksum file needed), and
applies it through the full installer. You can also check manually from
the version badge or **⚙ Settings**.

## Build from source

```powershell
git clone https://github.com/StarsationX/midi-studio.git
cd midi-studio
npm install
npm start                  # run in dev (needs Python 3.10+ with the player deps on PATH)

npm run build:nsis         # -> NSIS installer
npm test                   # unit tests
```

`build:nsis` first builds a small bundled Python (`python-engine/python/`) with the player dependencies.

## Architecture

```
electron/        main process, Python sidecar manager, forge runner/provisioner, updater
renderer/        shell + Forge, Player, Editor, and Self Midi tab renderers
python-engine/   ipc_main.py + midi_player.py (player engine, verbatim);
                 song_to_midi/transcribe/stem_to_midi/yt_download/... (forge pipeline);
                 provision_forge.py (the dependency downloader)
.github/         CI release workflow (build on Windows, publish + checksums on a v* tag)
```

## License

MIT, see [LICENSE](./LICENSE).
