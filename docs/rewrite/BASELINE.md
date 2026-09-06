# Baseline (before the rewrite)

Machine: this dev box. `node benchmarks/bench.js --json benchmarks/baseline.json`.
Reported as mean / p95 / p99 / max because a tail stall is what a user notices.

## Headline findings

| path | measured | note |
|---|---|---|
| `midi_document.py load` 50k notes | **1690 ms**, 5.0 MB JSON | what the Editor pays to open a large transcription |
| `midi_document.py load` 2k notes | 320 ms, 0.2 MB JSON | ordinary song |
| python bare startup | 32 ms | so ~1.65 s of the above is mido + JSON, NOT process spawn |
| equivalent parse in JS | 11 ms (50k), 30 ms (120k) | ~150x faster than the round trip |
| visible-note scan, linear | 0.308 ms/frame @120k notes | what the roll and visualiser do today |
| visible-note scan, binary | 0.003 ms/frame @120k notes | **100x**; p99 4.4 ms -> 0.006 ms |
| library scan, sync | 54 ms mean, 84 ms p95 | runs INSIDE the IPC handler, so the whole app freezes |
| library scan, async batched | 31 ms | and does not block |

## Reading

1. The Editor's open path is the single worst latency in the app, and almost
   none of it is Python startup. Parsing in the renderer would cut it ~150x,
   but the loader's contract must be reproduced exactly: stable note ids
   (`n1..nN`), the `unterminated` flag, `bpm` + `bpmEstimated` onset estimation,
   and `programs`. Any replacement needs a parity test against the Python
   output before it can be trusted.
2. Linear visible-range scans are cheap on average and expensive at the tail.
   The p99 is 1000x the mean because it lands on a GC or a cache miss. This is
   exactly the kind of thing an average hides.
3. The synchronous library walk is not slow in isolation, it is slow in the
   wrong place: on the main thread inside an IPC handler, so every input event
   waits behind it.
