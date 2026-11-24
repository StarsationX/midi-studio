# Changelog

The app reads this file to build its What's New screen, so the shape matters:
a `## <version> "<name>" — <date>` heading per release, then `### New`,
`### Changed`, `### Fixed` and `### Known issues` sections holding plain
bullets. Anything outside that shape is ignored by the parser and shown only
in the full changelog view.

## 3.1.16 "Medley" — 2026-11-24

### Changed

- Medley uses the backing audio to choose the octave and relative loudness of left-hand chord notes. It no longer assumes a lower copy of a melody note was played just because it fits the chord.
- A strummed chord can repeat one note without restarting the other fingers. When a recorded key drops out of the backing, the left hand can release it before the chord changes.
- A plucked right-hand note can ring past a short backing transcription when the recording still carries its fundamental and an overtone. It stops at the instrumental detector’s release or sooner if the hand needs to move.

## 3.1.15 "Medley" — 2026-11-24

### Changed

- When the bass steps forward or the upper line takes over, Medley changes their relative touch instead of turning the whole piano up or down. Drum hits do not drive this change.
- The piano follows short loud and quiet phrases more closely. A high key that has mostly faded no longer counts as much as a ringing bass key when Medley chooses the next accent. Exposed piano passages keep their recorded touch.
- A brief detector fragment just before a sustained instrumental strike no longer takes its place when both detectors agree on the later note. Genuine short lead-ins and rolled chords are preserved.
- Medley checks the spacing of the bass waveform across a held note before choosing between adjacent semitones. At an exposed piano entrance, a rolled chord can now begin just before the separator’s half-second boundary without losing its first key.

## 3.1.14 "Medley" — 2026-11-24

### Changed

- A strummed chord can keep three right-hand keys when the recording supports all three. The left hand leaves room rather than adding an unrecorded octave underneath.
- Backing chords favor the octave struck in the recording. When one key arrives slightly later than the others, it can keep that timing instead of landing on the first strike.
- In exposed piano passages, a held pedal can carry through a quiet gap. With the pedal up, either hand can take an isolated note so the other hand need not release a held key early.

## 3.1.13 "Medley" — 2026-11-24

### Changed

- A strummed note can now ring over the next attack when two detectors still hear it and both hands have room. This restores the ending without adding another strike.
- Medley uses higher harmonics to distinguish a low bass note from its louder octave. This helps keep the left hand in the recorded register.
- On sung lines, the piano can lift at the end of the vowel rather than holding through the hiss or breath that follows. A quieter vowel that still repeats at the same pitch is protected.

## 3.1.12 "Medley" — 2026-11-24

### Changed

- The right hand can now play a previously missed middle note in a strummed chord when both pitch detectors hear its attack and the left hand leaves room. An upper melody note is not traded away for the extra key.
- The left hand follows differences in the strength of nearby bass plucks instead of playing a quiet pickup and an accent with nearly the same touch. This changes velocity, not the selected bass pitches or rhythm.
- A sustained vocal pickup can be recovered before a repeated syllable when both the vocal model and the isolated voice support that key. An unpitched breath alone does not add a note.

## 3.1.11 "Medley" — 2026-11-24

### Changed

- Repeated instrumental notes now follow the recorded accents. Medley compares clear plucks of the same pitch within a phrase and adjusts how hard the right hand plays them, without changing their timing. It leaves sung notes, chords and exposed piano keystrokes alone.
- The left hand can lift a bass key when the recording has a sharp mute. The arranger chooses the chord first, so that shorter release does not replace a chord tone or invent a new bass attack.
- In an unpedaled piano roll with a free finger, the hand can hold a previous key until the first conflicting note of the roll, rather than lifting it at the start of the whole chord.

## 3.1.10 "Medley" — 2026-11-24

### Changed

- When an instrumental melody key is written just before a clear pluck in the recording, Medley can delay its attack by less than 17 ms, leaving time for the piano sample to sound. It leaves block chords, vocal attacks and exposed piano alone.
- The vocal melody releases a held key when the pitched vowel has faded into a sustained, quiet, unvoiced tail. A brief dip in volume is not enough to cut a syllable short.
- A stronger stretch of the recording can refine the tempo estimate. A fading outro needs a distinct new pulse before it can change the MIDI tempo; the notes are not snapped to the grid.

## 3.1.9 "Medley" — 2026-11-24

### Changed

- The two-hand arrangement follows swells and quiet passages in the recording. Medley compares the pitched instruments with the notes already assigned to the piano, so neither a drum hit nor a fuller chord gets mistaken for a crescendo. Exposed piano passages keep their detected key velocities.
- In exposed piano passages, Medley looks ahead for large leaps. When either hand can take the next chord, it favors the assignment that lets a held key finish ringing without dropping a new attack.
- When two accompaniment chords share a held key, the left hand can keep it down across the chord change. A fresh attack around the change still gets its own keystroke.

## 3.1.8 "Medley" — 2026-11-24

### Changed

- The right hand can play a distinct upper instrumental attack without cutting off the lower key already ringing beneath it. It leaves the vocal melody alone.
- When two chords fit the backing, Medley also checks the sustained bass. The left hand favors chord tones the recording actually emphasizes.
- Medley writes detected sustain-pedal presses and releases on both hands during exposed piano passages. The pedal lifts when the arrangement returns to the band.
- Listen and Editor now play written sustain timing. In Listen, turn Sustain off to hear just the key presses. Files without a pedal lane keep their previous playback behavior.

## 3.1.7 "Medley" — 2026-11-24

### Changed

- Medley keeps quiet piano notes through brief rests and favors the melody and bass when a wide chord won't fit under two hands.
- The right hand can keep two instrumental notes struck together when the recording supports both. It no longer has to discard one just because they share an onset.
- Bass tracking checks the spacing of overtones before moving the left hand up a register and listens for a fresh pluck before repeating a held note.

## 3.1.6 "Medley" — 2026-11-24

### Changed

- Windows Setup offers optional Forge setup. Install just MIDI Studio to listen, edit, or play without downloading transcription models.
- Forge shows the missing download size for the chosen transcription profile. NVIDIA acceleration is optional; compatible existing components are reused. Medley still uses your original, locally supplied separator.
- Medley keeps independently detected piano notes in exposed piano passages instead of forcing them into a single melody. In dense instrumental passages it can keep a lead attack when the piano and instrumental detectors agree.

## 3.1.4 "Medley" — 2026-11-24

### New

- Paste a Virtual Piano sheet into Player. Set the BPM, steps per beat and note length, then load it or play it into your selected game window.

### Fixed

- Windows Setup can upgrade an inspected, model-free Rust installation even when the desktop-user check is unavailable. If it cannot rule out model loss, it still stops before removing the old app and now explains the reason.

## 3.1.3 "Medley" — 2026-11-22

### Fixed

- Change playback speed in Player, Listen, or Editor without restarting the
  song or replaying held notes. Changing speed while paused keeps your place.

## 3.1.2 "Medley" — 2026-11-22

### New

- Medley uses the original separation model, not a replacement. Import your
  existing model on a new PC; the public installer does not include or download it.
- Getting started offers three first-launch paths: turn a recording into MIDI, listen
  to a MIDI file, or edit notes. Reopen it from the sidebar. Forge’s main button now
  offers the next step, and Listen can open and play a local MIDI without installing Forge.
- Editor controller editing for modulation, volume, pan, expression, and sustain,
  with channel selection, numeric input, drawing, deletion, and undo/redo.
- Persistent named MIDI markers with add, rename, move, delete, and undo/redo.
- Direct MuseScore MIDI imports: save the unchanged MIDI delivered by the public player
  and open it in Editor, without audio transcription or Forge model setup.

### Changed

- Expressive Piano is now **Medley** in Midi Forge. Existing projects and settings
  keep working. Medley builds a two-hand piano arrangement with the Rust engine.
- Medley follows short instrumental runs and checks repeated notes against pitch
  and onset evidence. A sustained note or octave echo is less likely to become a
  second keystroke, while a clearly articulated repeat stays in the right hand.
- Refined the mint/graphite UI with readable labels, sentence-case headings,
  consistent spacing, quieter option groups, and clearer workspace descriptions.
- Replaced the sidebar slogan with useful keyboard shortcuts.
- MuseScore links use Get MIDI and Enter to start a direct MIDI download.

### Fixed

- MIDI document import and export preserve controller events and named markers
  across JavaScript, Python, and Rust, including events in files with tempo changes.
- Forge displays downloader errors and recovery hints instead of only an exit code.
- YouTube client retries apply only to YouTube, and failed downloads cannot select
  an unrelated MP3 from the output folder. Downloads that produce no file finish with an error.

### Known issues

- The Editor's local audition previews notes. Controller edits are saved to MIDI
  but are not interpreted by the preview synthesizer.
- MuseScore imports require the public player to deliver a MIDI response. Site verification
  or unavailable playback can prevent a download.

## 3.0.1 "Graphite" — 2026-09-08

A full rewrite of the interface. Every workflow now lives in one application
instead of four separate mini-apps that happened to share a window.

### New

- **Library.** A dedicated tab for finding and managing MIDI files, with
  search, Type/Source/Tag filters, sortable columns, list and grid views,
  multi-select, tags and favourites. It is backed by an index that records
  each file's note count and length, so those columns hold real data.
- **Logs.** The log is its own section now rather than a drawer squeezed into
  the strip. Full scrollback with source and level filters, live search,
  follow-the-tail, copy and clear.
- **Command palette.** Ctrl+K reaches every action in the app: open a tab,
  open a recent MIDI, play, stop, focus the target window, panic, transpose,
  change mapping, open settings.
- **Persistent activity strip.** A Forge job, live playback or an unsaved
  edit stays visible from every tab, with its progress and its actions.
  Clicking a running job returns you to it.
- **Persistent transport.** One playback bar along the bottom, owned by
  whichever of Player, Self MIDI or Editor is actually sounding.
- **Cross-tab hand-off.** A Forge result goes straight to the Editor, the
  Player or Self MIDI. So does a Library row, an Editor save, a Self MIDI
  track. You no longer memorise an output path and go looking for the file
  you just made.
- **What's New.** This screen, shown after an update installs.
- **Custom titlebar** with the MIDI Studio mark, and a boot splash driven by
  real initialisation milestones rather than a fixed delay.
- **Compact density** in Settings, for fitting more on screen.

### Changed

- One design system across the whole app. Every button, row, panel, menu,
  modal and list is the same component everywhere instead of each tab having
  invented its own.
- **Forge** is one three-column workspace: input and pipeline on the left,
  the waveform, settings and a seven-stage progress checklist in the middle,
  results and their hand-off actions on the right. The four competing layouts
  (Classic, Cards, Bench, Console) are gone in favour of one good one.
- **Editor** now reads as a real piano-roll editor, with a track list, a
  proper toolbar, an automation lane and a Properties/Selection/History
  inspector. The canvas is no longer buried under its own configuration.
- **Player** makes its job obvious: MIDI in, keystrokes out to another
  application. The visualizer is the centre of the tab, and the mapping
  warnings that used to appear after a run now appear before it, while they
  can still change your mind.
- **Self MIDI** is a music player rather than a second Player: playlists,
  favourites, a queue, recently played, bookmarks, A/B loop.
- **Settings** is reorganised into Appearance, Playback, Performance, Forge
  Engine, Storage, Updates, Overlay and About.
- Playback timing and drawing are now separate concerns. The visualizer
  interpolates from authoritative playback state and can never hold it up.
- Long lists are virtualised, so a library of thousands of files scrolls at
  the same speed as one of ten.
- The MIDI library scan no longer blocks the app while it runs.

### Fixed

- The window could barely be moved: the titlebar's drag region had been
  reduced to the few pixels of gap between its controls.
- The layout was 128px wider than the window, because the bottom transport
  refused to compress. Content was cut off at every size.
- Several controls clipped their own labels.
- Self MIDI stole the transport from a playing Player merely by loading a
  file, including on session restore at startup.
- Changing tempo while paused was read as the track ending, which advanced
  the queue.
- The Editor's volume control did nothing: its sampled preview bypassed the
  master gain entirely.
- A debounced settings write was cancelled rather than flushed on quit, so
  the last change before closing could be lost.
- Holding an arrow key in the Editor pushed one full-document snapshot per
  key repeat and discarded real undo history within seconds.
- Very large transcriptions failed on their first redraw.
- Installer-chosen Forge storage was never adopted, because the registry key
  being read was written with collapsed backslashes and could not exist.
- Favourites, tags and the library index survive being written while a scan
  is in progress.

### Known issues

- The Editor's Modulation, Expression, Sustain and Pan automation lanes are
  visible but inactive: transcription does not capture those controllers yet.
  Velocity works.
- Markers in the Editor have no file format behind them yet.
