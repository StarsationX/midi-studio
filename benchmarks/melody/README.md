# Main Melody benchmark

Create a manually corrected reference MIDI for each test excerpt. Copy
`manifest.example.json` to `manifest.json`, point each entry at a generated and
reference MIDI, then run:

```powershell
python ../../python-engine/benchmark_melody.py manifest.json
```

The report measures pitch-matched note onsets within 80 ms. Keep the same short,
representative excerpts between releases so precision, recall, and F1 are comparable.
