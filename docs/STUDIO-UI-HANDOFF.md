# MIDI Studio — approved UI handoff

## Start here

The user reviewed the redesign and explicitly approved it: “oh yeah i love this.”
**The redesign is already implemented in the working tree.** This is a handoff for continuing work, not a request to rebuild the app or generate another mockup.

Project: `C:\Users\stars\claude\midi-studio`

Read the current source and inspect `git diff` before changing anything. The UI changes are uncommitted. `renderer/shared/studio.css` is a new, untracked source file and must be included if committing the redesign. There is also a pre-existing untracked `.claude/` directory; leave it alone.

These notes describe the accepted baseline. Later user requests take precedence.

## Design direction

A calm, focused desktop music studio. Dark green-gray surfaces, restrained mint accents, readable titles, and room for the waveform and piano roll.

- Keep navigation in the left sidebar. The order is **Forge, Player, Editor, Listen, Library, Logs**. Settings and the version badge sit at the bottom.
- Use a small breadcrumb in the titlebar and a clear title with one short explanatory sentence inside each workspace.
- Reserve the mint accent for the active workspace, selected options, primary actions, and meaningful state.
- Keep secondary controls quiet. Use spacing and type hierarchy to separate sections instead of adding more borders, badges, or decorative effects.
- Show optional settings through disclosures. Avoid presenting the same choice or playback controls twice.
- Give the musical content priority. Smaller windows should preserve usable editing space and scroll secondary panels as needed.

The existing colorful app logo is intentionally retained.

## Shared visual system

Source of truth: `renderer/shared/tokens.css`.

| Token | Default |
| --- | --- |
| Page background | `#111516` |
| Recessed background | `#0d1112` |
| Panel surface | `#191e20` |
| Control surface | `#22282b` |
| Hover surface | `#2b3336` |
| Border | `#2a3235` |
| Stronger border | `#3d494d` |
| Primary text | `#edf2ef` |
| Secondary text | `#a6b2b3` |
| Muted text | `#8e9d9f` |
| Mint accent | `#9cdbbb` |
| Accent hover | `#b6ebcf` |
| Text on accent | `#10271c` |
| Accent surface | `#1c3028` |
| Accent border | `#3d6352` |

Use the bundled **Archivo** font for interface text. Use **JetBrains Mono** for timecodes, numbers, shortcuts, and other machine values. Corner-radius tokens are 7px, 9px, and 12px.

Preserve the alternate accent presets and custom color support. The default preset is now labeled **Mint**.

## Architecture and stylesheet order

This is an existing Electron app with plain HTML/CSS/JavaScript and six iframe workspaces. Keep the current architecture and IPC contracts unless the user requests a change.

Load CSS in this order:

1. `shared/tokens.css`: shared tokens and base styles.
2. `shared/ui.css`: reusable UI primitives.
3. The shell or workspace's existing structural stylesheet.
4. **`shared/studio.css` last**: the redesign's shared finishing layer and responsive adjustments.

Do not omit `studio.css`, move it ahead of workspace styles, or replace it with a disconnected prototype. Earlier design files under `_design/` are not the accepted implementation.

New workspace introductions use `.studio-workspace`, `.studio-page-head`, `.studio-eyebrow`, `.studio-page-title`, and `.studio-page-description`.

## Behavior to preserve

- **Shell:** the sidebar is 208px wide and becomes a 72px icon rail at narrower window widths. Tabs keep explicit accessible names. Up/Down, Home/End, existing Left/Right navigation, and Ctrl+1–6 continue to work. The selection indicator moves vertically.
- **Status:** engine, game, and log-error indicators live in the titlebar. The activity strip hides when idle, while active tasks and update notices remain visible. An empty Player must not produce a persistent global “Blocked untitled” notice.
- **Playback:** the bottom transport persists across workspaces. Embedded Player hides its duplicate timeline and transport; standalone Player keeps them. The shell stamps `data-embedded="1"` on iframe roots for this distinction.
- **Forge:** import audio, choose what to extract, adjust quality/stems/range, then convert. Save location and filename are collapsed by default and follow the model picker. Advanced settings remain available.
- **Forge model selection:** tiles are the single visible model picker. The existing hidden `#c-model` control remains in the DOM because the application synchronizes it with the tiles. Do not remove it without updating those bindings.
- **Forge progress:** hide the seven pending stage rows before a job starts. Show actual stages when a job runs or a relevant error needs attention. The progress panel must not collapse to zero height in a short window.
- **Player:** preferences start collapsed on a fresh profile. Saved disclosure choices take precedence. Queue actions appear on hover/focus without consuming the song title's normal width.
- **Editor:** toolbar groups wrap instead of clipping. Its grid allocates automatic toolbar height. Short windows reduce waveform and automation heights to preserve piano-roll space.
- **Listen:** related toolbar labels and controls stay grouped when wrapping. Library section tabs fit the smaller navigation pane.
- **All workspaces:** preserve drag and drop, menus, settings, themes, keyboard shortcuts, resize behavior, playback ownership, and lazy iframe loading.

Keep virtualized list row heights consistent with `VList` and the shared `--h-row` / `--h-row-lg` tokens. Keep canvas geometry and pointer mapping aligned. Do not change audio, transcription, or keystroke behavior as part of routine styling work.

## Files changed for this redesign

- `renderer/shared/studio.css` — new shared redesign styles, shell grid/sidebar, workspace introductions, responsive refinements.
- `renderer/shared/tokens.css` — palette, radii, base appearance.
- `renderer/index.html` — sidebar, titlebar status indicators, Mint preset label, shared stylesheet.
- `renderer/shell/shell.js` — vertical indicator/navigation, workspace breadcrumb, embedded-frame marker, empty-playback activity filtering.
- `renderer/shell/shell.css` — Mint preset swatch.
- `renderer/forge/index.html` and `renderer/forge/forge.js` — import flow, model picker, output disclosure, settings/progress presentation, empty-state wording.
- `renderer/player/index.html` and `renderer/player/app.js` — shared layout, narrower default panes, initial preferences disclosure, theme-aware color input.
- `renderer/review/index.html`, `renderer/audition/index.html`, `renderer/library/index.html`, `renderer/logs/index.html` — workspace introductions and shared redesign stylesheet; Listen also groups toolbar controls.

No dependencies or backend processing files were changed.

## Verification already completed

- `npm test`: **502 passed, 0 failed**.
- Integrated Electron UI smoke checks: **46 passed**, with **0 renderer errors**.
- Tested normal **1440×940** and compact **1040×700** windows.
- Checks covered all six workspaces, frame fit, unique IDs, audio import, conversion enablement, model synchronization, disclosures, results collapse, MIDI document loading, shared playback presentation, vertical keyboard navigation, command search/Escape, theme propagation, and density propagation.
- Layout audits were used to resolve toolbar and panel clipping, including loaded-document states.

The UI checks used fixtures and a generated local WAV. They do not establish real transcription quality or live keyboard-injection correctness.

On this machine, the integrated smoke harness is at:

`C:\Users\stars\Documents\Codex\2026-10-21\d\work\verify-studio.cjs`

It is a local verification artifact, not part of the repository's committed test suite.

Run the app with `npm start`. Restart an already-running instance to load the redesign. If packaging or committing later, include the new shared stylesheet.

## Visual references

Screenshots of the implemented UI are saved under:

`C:\Users\stars\Documents\Codex\2026-10-21\d\outputs\midi-studio-ui`

Normal views: `forge.png`, `player.png`, `editor.png`, `listen.png`, `library.png`, `logs.png`.

Compact views: `forge-compact.png`, `player-compact.png`, `review-compact.png`.

Use these as references for the accepted direction. Continue from the actual application source and the user's next request.
