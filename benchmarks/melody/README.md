# Main Melody benchmark

Create a manually corrected reference MIDI for each test excerpt. Copy
`manifest.example.json` to `manifest.json`, point each entry at a generated and
reference MIDI, then run:

```powershell
python ../../python-engine/benchmark_melody.py manifest.json
```

The report measures pitch-matched note onsets within 80 ms. Keep the same short,
representative excerpts between releases so precision, recall, and F1 are comparable.

For a two-hand Medley before/after comparison against an aligned performance, run:

```powershell
python compare_performance.py reference.mid before.mid after.mid --start 0.25 --end 31.75
```

This uses `mido`. It pools non-drum tracks, counts exact MIDI keys one-to-one
within 50 ms, and reports matched, extra and missed attacks, precision, recall
and F1. The window excludes its end. For a clip starting 64 s into the source,
use `--clip-offset 64` and set the window on the source clock. Set
`--reference-offset` only from a separate score-to-audio alignment, never by
fitting the output MIDI. Synchronized player-piano key presses can serve as
performance truth. An independently arranged cover measures agreement with
that guide, not song-wide transcription accuracy. Keep private recordings,
references and generated MIDIs outside the repository.
