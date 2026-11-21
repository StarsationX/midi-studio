# MIDI Studio design

Reading this as a desktop music workstation for people transcribing, editing,
and playing MIDI, with graphite equipment surfaces and mint selection cues.
Energy 1 / Rhythm 2 / Motion 1.

## Direction

- Product: turn recordings into editable MIDI and play them locally or into a keyboard app.
- Character: focused, precise, calm.
- World: studio equipment, musical timelines, and physical keyboard controls.
- Moments: the source waveform and the piano roll carry the visual detail and meaningful color.
- Signature: aligned timecodes, note names, and keyboard shortcuts in the bundled mono font.

## Decisions

- Keep the existing logo and mint accent because they are the accepted product identity.
- Keep graphite surfaces because long editing sessions need a quiet surround for notes and waveforms.
- Use mint for selection and the primary action; secondary icons and labels remain neutral.
- Keep Archivo for readable controls and JetBrains Mono for quantities that must line up.
- Use a 12px minimum for interface copy, with 13px body text and 28px workspace titles.
- Use 4px spacing steps, 8px control corners, and 12px workspace corners to distinguish nesting.
- Keep navigation on the left and the shared transport below every workspace, preserving playback context.
- Give source, timeline, and inspector different widths because musical content needs most of the space.
- Use disclosure controls for advanced choices so frequently used controls stay visible.
- Keep the existing music-specific icons; they identify operations rather than decorate headings.
- Use grids only inside musical timelines, where they represent pitch and time.
- Keep transitions brief and honor reduced motion; no animation runs merely to decorate an idle screen.

## Implementation boundaries

The supported desktop window starts at 1040 × 700. Compact widths use the icon
rail, wrapped toolbars, and scrollable secondary panes. The six workspace order,
resizable panels, alternate accent presets, custom accents, canvas geometry,
virtualized row sizes, and Electron/Tauri bridges remain intact.

Controller and marker editing use the same document, undo, save, and export paths
as notes. Empty lanes and marker lists explain how to add real data.

## References

Design review uses [Anti Slop](https://github.com/miqdadbadjuber/anti-slop),
by Miqdad Badjuber (MIT), and
[Unslop](https://github.com/heydamir/unslop), by Damir Sokolovsky
([@heydamir](https://x.com/heydamir), CC BY 4.0).
This is a refinement of MIDI Studio's existing design, not a copied template.
