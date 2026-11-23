# MIDI Studio

Turn a recording into MIDI, fix the notes in a piano roll, and hear the result. You can also play a MIDI into a game or virtual piano that accepts keyboard input.

**[Download MIDI Studio for Windows x64](https://github.com/StarsationX/midi-studio/releases/latest)** · [What’s new](CHANGELOG.md)

Under **Assets**, download `MIDI-Studio-<version>-Setup.exe` and run it. This is the **Rust/Tauri** edition. You don’t need to install Python to listen, edit MIDI, or use the keyboard player. The installer is not code-signed, so Windows SmartScreen may show an unknown-publisher warning.

**Already using MIDI Studio?** Install over your existing copy; don’t uninstall it first. Keep your Forge storage folder so setup can preserve your Medley model. The app checks GitHub for updates and verifies the installer’s SHA-256 before launching it. Click the version badge to check manually.

![Player showing a falling-note piano roll above the keyboard](docs/img/player.png)

## Start with the file you have

| I have… | What to do first |
|---|---|
| **A MIDI file I want to hear** | Open **Listen → Open MIDI and play**, then choose your `.mid` file. The built-in instruments play it directly; no game, target window, or model needed. |
| **An MP3 or WAV I want to turn into notes** | In **Forge**, select **Choose audio…**, pick your recording, choose **Fast**, then **Create MIDI**. Open the finished file from **Results**. Fast works without the Medley model. |
| **A MIDI file with notes I want to fix** | Open it in **Editor**. Move, add, or delete notes in the piano roll, listen back, then save. When you have the original recording, use its waveform to check the timing. |
| **A MIDI file I want to play in a game** | Open the game first. In **Player**, open the MIDI, select the game window under **Target**, and choose a keyboard mapping that matches the game. Press **Play**. Playback pauses if the target loses focus. |

If Forge shows **Set up audio conversion** instead of **Create MIDI**, check the free space shown, choose a storage folder, and select **Install**. Some engines download several GB. Your recording stays selected. Skip this step if you only want to listen to or edit MIDI.

You can reopen **Getting started** from the sidebar. In **Player**, **Listen**, and **Editor**, you can slow down a tricky passage without restarting the song. Changing speed while paused keeps your place.

## Make a two-hand piano arrangement

**Medley** (formerly **Expressive Piano**) arranges a recording for two hands: the right hand follows vocal and instrumental melodies, while the left plays bass and chords. Choose **Melody** instead if you want only the lead line.

Medley uses the original six-stem separator. The public installer **does not bundle, download, or substitute** that model.
The [model source and license information](https://huggingface.co/FractalSurfer/BS-RoFormer-SW-6stem#license) is provided for reference; the mirror grants no additional rights. Only import a copy you’re authorized to use. Otherwise choose **Fast** in Forge to convert audio without it.

- **On an existing installation:** Setup checks for the original model before replacing the app. If it can’t safely preserve it, setup stops. If you used a portable copy, keep it until the new app shows Medley is ready.
- **On a new PC with your own model:** Open **Forge → Medley → Import existing Medley model → Choose local model…** and select `bsrofo_sw_body.onnx`. Studio verifies the file before using it.
- **If you only have `BS-Rofo-SW-Fixed.ckpt`:** Keep its matching YAML file. Offline conversion also needs your original local Forge Python and MSST installation. The checkpoint alone isn’t enough.

Once Medley is ready, choose a recording and select **Create MIDI**. From **Results**, open the arrangement in **Editor** to adjust it or **Listen** to hear it.

## Other things you can do

- **Import a MuseScore score without transcribing audio.** Paste the score link into Forge and choose **Get MIDI**. If the public player delivers a MIDI, Studio opens that file unchanged in Editor. Other supported links, such as YouTube and SoundCloud, import **audio** for transcription instead.
- **If a YouTube audio download stalls:** Forge automatically tries an alternate media server when YouTube lists one and the first one times out. If the download still fails, retry later or on another network.
- **Edit expression as well as pitch.** Editor supports modulation, volume, pan, expression, sustain, and named MIDI markers. Controller edits are saved to the MIDI file; the in-app note preview doesn’t perform them.
- **Find a song or diagnose a job.** Use **Library** to search, tag, or favorite a file. If a conversion fails, open **Logs** to copy its diagnostics.

## Build the Rust edition

The shipped Windows app uses [Tauri](src-tauri/) with a WebView2 interface, an [in-process Rust keyboard player](player-rs/), and the [Rust Forge engine](forge-rs/). Some optional conversion tools still use [Python](python-engine/). The [Electron host](electron/) is legacy: `npm start` and `npm run build:nsis` are **not** the Rust build.

For Windows development, install Git, Node.js with npm, Rust stable (MSVC), the Visual Studio C++ Build Tools with a Windows SDK, and WebView2. To work on the desktop and player without packaging Forge models:

```powershell
git clone https://github.com/StarsationX/midi-studio.git
cd midi-studio
npm ci
cargo run --locked --manifest-path src-tauri/Cargo.toml --bin midi-studio
```

For a **full installer**, staging also needs Python 3.11+ and the verified Transkun 2.0.1 exports. Point `MIDI_STUDIO_MODELS_DIR` at a directory containing those exports under `onnx/`. The [staging script](tools/stage_native_assets.py) lists the exact filenames and hashes. The private Medley separator is **not** a build input.

```powershell
npm run build:tauri
```

The application is `src-tauri\target\release\MIDI Studio.exe`. The Windows installer is under `src-tauri\target\release\bundle\nsis\`.

## License and credits

MIDI Studio’s code is [MIT-licensed](LICENSE). Bundled models, instruments, fonts, and runtimes have [separate licenses and credits](third-party/THIRD-PARTY.txt); in particular, the GAME model weights are licensed for noncommercial use under CC BY-NC-SA 4.0.

The MuseScore public-player import was informed by [ingui-n/musescore-downloader](https://github.com/ingui-n/musescore-downloader); its extension is not bundled. See [DESIGN.md](DESIGN.md) for interface credits.
