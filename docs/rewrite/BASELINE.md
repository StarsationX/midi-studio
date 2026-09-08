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

## Re-running the Player timing harness

Player dispatch timing lives in Python, so it is measured in Python, at the
keypress rather than in the UI. Each script's docstring explains what it
isolates and why.

```
python benchmarks/make_player_fixture.py            # fixtures/player-dense.mid
python benchmarks/player_timing.py --all --seconds 20 --json benchmarks/player-baseline.json
python benchmarks/player_timing.py --no-play --sleep-probe --microbench --ipc-volume
python benchmarks/player_chord_batch.py  --json benchmarks/player-chord-batch.json
python benchmarks/player_inject_cost.py  --json benchmarks/player-inject-cost.json
python benchmarks/player_sleep_ab.py     --json benchmarks/player-sleep-ab.json
npx electron tools/player-render-bench.js --json benchmarks/player-render.json
```

`player_timing.py` defaults to `--kb nullkey`: a real pynput Controller driving
`KeyCode.from_vk(0xFF)`, an undefined virtual key. Same SendInput path, same
per-press cost, but no application receives a character, so a run is safe with
any window in the foreground. `--kb real` types for real and is gated behind
`--allow-real-keys`.

Two traps worth keeping written down:

* A hand-rolled `INPUT` struct must be **40 bytes** on x64. At 32 bytes
  SendInput rejects the call and returns without injecting, which looks like a
  180x speed-up and is simply a failed call.
* Electron on Windows is a GUI-subsystem binary, so `console.log` never reaches
  the launching terminal. `tools/player-render-bench.js` mirrors its output to
  `benchmarks/player-render.log`, and a hidden window fires no
  `requestAnimationFrame`, so the render loop is driven by `setTimeout`.

## Re-running the main-process harnesses

The main process is the thread that has to stay responsive while keystrokes are
being dispatched, so its costs are measured as *blocking* time, not just wall
time, and the fan-out is measured against the real renderer.

```
node benchmarks/main-perf.js --reps 8 --json benchmarks/main-perf.json
node benchmarks/gamewatch-ab.js --reps 8 --cpu-polls 30 --json benchmarks/gamewatch-ab.json
node_modules/electron/dist/electron.exe benchmarks/fanout-bench.js --json benchmarks/fanout.json
node benchmarks/startup.js --runs 6 --json benchmarks/startup.json
```

* `main-perf.js` -- reapOrphanJobs (thread blocked vs wall clock, seeded with a
  fixed number of dead pids so the number does not depend on what the last
  session left behind), one GameWatch poll, the boot-path registry read
  (spawnSync vs execFile), the provisioner's stdout pump against a
  carriage-return-only stream, and the boot log's append cost and size.
* `gamewatch-ab.js` -- seven ways of asking "is a game running?", interleaved,
  all required to return the same answer. It reports wall clock AND
  machine-wide CPU per poll, because a variant that merely runs its spawns in
  parallel finishes sooner while burning exactly as much of the machine.
  On a loaded machine the CPU column is dominated by background noise and only
  large differences can be read from it; the wall column is reproducible.
* `fanout-bench.js` -- opens the real shell with the real preload, opens all six
  tabs, and reports how many of `broadcast()`'s seven sends each channel
  actually needs, plus the cost of 2000 broadcasts with and without the
  subscription filter. The two are the same code path with one predicate
  changed.
* `subscribe-cost.js` -- the other half of the fan-out change: what the extra
  `ipcRenderer.send` per subscribed channel costs the RENDERER at boot, measured
  through the same primitive in the same preload. 15 messages x 0.004ms =
  0.06ms, which is why the fan-out saving is not paid for on the way in.
* `startup.js` -- unchanged in what it launches, but `adoptInstallerForgePath`,
  `recoverForgeEnv` and `reapOrphanJobs` moved out of the ordered milestone
  chain into an OFF THE BOOT PATH section, reported relative to `painted`. A
  negative number there means the work still finished before the window was on
  screen; it just no longer gates it.

One trap worth keeping written down: `startup.js` refuses to run while any
`electron.exe` exists, because another harness's window makes every boot number
meaningless. On a machine where several perf harnesses are running at once, that
guard will stop the run rather than produce a bad number -- which is the correct
behaviour, not a bug to work around.

### One result worth keeping written down

Taking the synchronous registry read and the synchronous orphan reap out of
`createServices()` moved `boot:window` from 335ms to 199ms and moved `painted`
by 11ms. The work had been *relocated*, not removed: the reap's three
`tasklist.exe` spawns now overlapped `loadFile`, and `loadFile -> painted` went
from 197-214ms to 320-325ms on runs where both sides had the machine to
themselves. A process spawn costs the same wherever it is issued from, so the
question is never "is this off the boot path" but "what is it in front of now".
The reap therefore waits for `ready-to-show`, where there is nothing left to be
in front of.

---

## Looping CSS animations, and what "idle" really costs (shared)

`benchmarks/anim-cost.js` (new, Electron) answers one question the per-tab idle
sweep could not: **what does a single looping CSS animation cost, and what does
it cost when nobody can see it?**

    node_modules/electron/dist/electron.exe benchmarks/anim-cost.js --seconds 20 --json benchmarks/anim-cost-after.json

`benchmarks/idle.js` measures a tab at idle, but whether the shell's transport
pill happens to be BLOCKED depends on session state, so `dot-pulse` is present
in some runs and absent in others and the two runs are not comparable. This
harness forces the state instead of hoping for it, re-forcing it before every
variant (the shell re-renders the pill on its own schedule and drops the class),
and it forces only dots with an `offsetParent`: the shell markup carries several
`.dot` elements inside `display:none` branches, Chromium creates **no animation
object at all** for those, and an earlier version of the harness forced one of
them and then reported confident numbers for five variants while measuring
nothing.

Measured, two pulsing 8px status dots, 20s samples, same window, same DOM:

| variant | renderer CPU | p95 | GPU CPU | p95 | task ms/s | anims |
|---|---|---|---|---|---|---|
| floor-nopulse (control) | 0.021% | 0.202 | 0.009% | 0.012 | 0.53 | 0 |
| visible-pulse | 1.060% | 1.135 | 2.902% | 3.007 | 2.59 | 2 |
| visible-willchange | 1.040% | 1.093 | 2.866% | 3.039 | 2.58 | 2 |
| parked (`Draw.setOnscreen(false)`) | 0.000% | 0.002 | 0.008% | 0.011 | 0.02 | 0 |
| parked, pause defeated | 1.084% | 1.117 | 2.990% | 3.118 | 2.75 | 2 |
| really minimised, loops parked | 0.000% | 0.001 | 0.009% | 0.011 | 0.02 | 0 |
| really minimised, pause defeated | 0.005% | 0.006 | 0.248% | 0.293 | 0.08 | 2 |

Four things worth keeping written down:

* **A visible pulse costs ~1.06% renderer + ~2.90% GPU and that is the floor.**
  It is one full composite per vsync; the only way down is fewer frames, which
  is a visual-quality trade and is not on the table. `will-change: transform,
  opacity` was tested twice: 1.040%/2.866% here and 1.156%/3.198% on an earlier
  sweep against a 1.110%/3.109% baseline. It is inside the run-to-run noise in
  both directions. It was **not** adopted -- a change that cannot be told apart
  from its control is added risk, not an optimisation.

* **`document.hidden` is inert in this app and cannot be used for any of this.**
  Measured with a direct Electron probe: `win.hide()` AND `win.minimize()` both
  leave `document.visibilityState === 'visible'`, because
  `webPreferences.backgroundThrottling` is false by design (invariant) and
  Electron then never marks the page hidden. `draw.js`'s `env.hidden`, which has
  always been documented as "window minimised", was dead code.

* **A minimised window is detectable from the renderer, event-driven, with no
  polling.** Windows parks it at `screenX/screenY === -32000` (outer box
  160x28), and fires `blur` on minimise / `focus` on restore with the position
  already updated. `draw.js` reads the position on those two events, which it
  already listened for. It does this in the **top frame only**: a panel iframe
  reads the same -32000, but receives no blur, focus, resize or
  visibilitychange at all when the window is minimised, so a panel that parked
  on it would have nothing left to un-park it.

* **Minimising already recovers most of the cost on its own** -- 2.902% GPU
  visible vs 0.248% GPU minimised -- so the saving from parking the loops is the
  remaining 0.248% -> 0.009% GPU and 0.005% -> 0.000% renderer, held for as long
  as the window stays minimised. That is a real number but a small one, and it
  is very different from the 3.438% that `win.hide()` reports; `hide()` keeps
  the compositor fully alive and is **not** a stand-in for minimise.

`renderer/shared/draw.js` publishes its own park condition as
`<html data-parked>`, and `ui.css` / `tokens.css` pause the five endless
decorative loops off it (`dot-pulse`, `dot-blink`, `ui-spin`, `skel-sweep`,
`indet`). Paused, never `animation: none` -- play-state resumes mid-cycle, so
nothing about how any of them looks on screen changes. Only endless decorative
loops are listed: a finite animation may have an `animationend` listener behind
it, and pausing one of those would stall real logic.

Still on the table, and NOT done because it is outside `renderer/shared`: the
shell does not stamp `data-onscreen="0"` on its panels when the window is
minimised, so a panel's own loops (a Forge job's busy spinner and indeterminate
bar) keep running there. `Draw.setOnscreen(false)` is the call, the receiving
half is in place, and the parked column above is what it is worth.

## The Editor's open path, and how to re-check it

The Editor no longer asks `python-engine/midi_document.py` to read a MIDI file.
`renderer/shared/midi-parse.js` reads it in the frame that is going to hold the
document, and the python loader stays as the writer and as the automatic
fallback for anything the JS reader will not swear to.

**End to end, `openReviewProject()` to the first pixel the piano roll puts down,
in a real window with the real preload and the real main-process loader** (four
alternating repetitions per arm, `benchmarks/editor-open-e2e.json`):

| notes | python round trip | renderer reader | speedup |
|------:|------------------:|----------------:|--------:|
| 2,000   |  224.8 ms (max 236.7) |  6.1 ms (max 8.6)  | 37x |
| 10,000  |  459.3 ms (max 464.1) | 10.1 ms (max 12.3) | 46x |
| 50,000  | 1733.8 ms (max 1775) | 33.2 ms (max 35.3) | 52x |
| 120,000 | 4317.5 ms (max 4516) | 85.3 ms (max 86.9) | 51x |

The python column already includes the `mido.MidiFile.length` fix below; before
that it was 2055 ms mean / 2419 max at 50k and 5458 / 6562 at 120k.

```
npx electron benchmarks/editor-open-e2e.js --reps 4 --json benchmarks/editor-open-e2e.json
```

It measures BOTH arms in one run on the same window and the same fixture
(`window.__review.forcePython` selects the arm) and asserts that the document the
panel ends up holding is identical either way, so a faster number can never be
bought with a different document.

### Parity is the whole contract

```
node benchmarks/editor-parse-parity.js                       # the shipped fixtures
node benchmarks/editor-parse-parity.js --dir "<a real library>" --reps 1
```

Field for field over every note -- id, pitch, start, end, velocity, channel, the
`unterminated` flag -- plus `name`, `path`, `bpm`, `bpmEstimated`, `duration` and
`programs`. Last run over 92 real files / 236,659 notes: **92 identical, 0
different, 0 refused**, 233 ms of JS against 20.6 s of python. `node
tools/run-tests.js` runs the same comparison over `benchmarks/fixtures` plus five
synthetic files aimed at the rules that are easy to get subtly wrong (trailing
silence past the last note, an unterminated note, running status interrupted by a
meta event, two interleaved tracks with a mid-file tempo change, and a file with
no tempo track at all).

Two things the corpus caught that a fixture set never would have, both now fixed
and both asserted:

* **mido converts every message's delta to seconds separately**, so *which*
  messages a reader keeps changes the last bit of the running total:
  `tick2second(10) + tick2second(10)` is not `tick2second(20)`. The reader
  therefore records EVERY message, not just the note/tempo/program ones. The
  single exception is `end_of_track`, because `merge_tracks` deletes those and
  folds their delta into the next message.
* **python's `round()` is half-to-EVEN and JS's `toFixed`/`Math.round` are
  half-up**, and exact ties are common rather than exotic: note ends land on
  dyadic values like `76.1015625` all the time. `MidiParse.pyRound` reproduces
  python's rule and was fuzzed against the real interpreter over 400,000 values
  x 4 precisions (1.6M roundings, deliberately over-sampling exact midpoints and
  the doubles either side of them) with zero mismatches.

### midi_document.py: the third pass is gone

`load_midi` built `mido.MidiFile` (pass 1), iterated it (pass 2), and then asked
for `float(midi.length)`, which re-iterates the merged track to re-sum the very
deltas the loop had just accumulated (pass 3). Measured on the bundled
interpreter: **50k 1727 ms -> 1455 ms, 120k 4176 ms -> 3575 ms.** The
50,000-element list comprehension beside it went too. Note that `.length` uses
python's `sum()`, which is compensated, so it is not bit-identical to a plain
left-to-right total -- dropping it is also what makes the two loaders agree
exactly.

## The Editor's gestures

`benchmarks/editor-interact.js` now **focuses its window** and prints
`[focus=… budget=…ms]` beside every repaint-rate row. This is not cosmetic:
draw.js clamps an unfocused window to 250 ms per frame, so a run that lost focus
to another app reports 4.0 fps for every gesture no matter what the code under
test does. Two runs of an identical build differed 4.0 fps vs 29.3 fps on
nothing but focus. **Ignore any gesture row whose `focus` is false.**

`review.js` now raises the draw rate for the duration of a gesture, the way
Player, Forge and Audition already did, through a REFCOUNT so that a gesture and
playback cannot cancel each other. At 120k notes, focused, budget 33 ms:

| gesture | before | after |
|---|---:|---:|
| scroll | 4.0 fps | 27.9 fps |
| wheel zoom | 4.0 fps | 26.5 fps |
| marquee | 4.0 fps | 28.0 fps |
| note drag | 4.0 fps | 23.2 fps |

```
npx electron benchmarks/editor-idle-after-gesture.js
```

is the guard on the one thing that change could cost: it opens a document,
performs a scroll, a wheel zoom, a marquee, a CANCELLED marquee and a note drag,
and counts roll repaints over two seconds of stillness after each. All six read
zero.

Three adjacent before/after pairs at 120,000 notes (adjacent, because a sweep
that runs 120k last measures ten minutes of accumulated machine load rather than
the code):

| | before | after |
|---|---:|---:|
| open -> first roll paint | 187 / 183 / 170 ms | 122 / 106 / 110 ms |
| one velocity commit, sync | 70.8 / 58.3 / 54.5 ms mean | 45.5 / 38.6 / 39.5 ms |
| ...its worst | 96.9 / 80.7 / 78.1 ms | 74.5 / 58.9 / 68.2 ms |
| undo | 40.8 / 41.7 / 36.4 ms mean, 83.2 max | 26.5 / 21.2 / 19.3 ms, 30.2 max |
| redo | 36.6 / 35.1 / 39.2 ms mean, 73.2 max | 22.7 / 19.9 / 19.2 ms, 25.8 max |

### Tried and reverted: skipping the re-sort during a drag

A drag calls `noteMoved()` per note, which sets `sortDirty`, so `drawRoll` used
to re-sort the whole array on every repaint -- and at 30 fps instead of 4 that
looked like it would be 30 full sorts a second. It is not. A drag displaces every
selected note by the same delta, which leaves the array NEARLY sorted, and
TimSort walks a nearly-sorted array in close to linear time. Replacing the sort
with a linear window scan measured, over three paired 120k runs, a drag repaint
frame of 11.7 / 10.1 / 6.85 ms against 7.63 / 11.8 / 6.00 ms for the sort: no
improvement, inside a spread bigger than the effect. Reverted. What DID measure
is checking whether the order actually broke before paying for a sort
(`sortedAlready()` in `ensureSorted`): 0.57 ms against 3.19 ms over an
already-sorted 120k array, which is the state after the loader, after a velocity
edit, and after the undo of one.

## Player aim compensation (A/B harnesses)

`benchmarks/player_ab.py` loads two or more copies of `midi_player.py` into one
process and runs them ALTERNATELY, round by round, order swapped on odd rounds,
then pools the raw per-note errors. That is what makes a 2 ms change readable
on a machine whose idle noise floor is +/-1.5 ms at p99. It reports absolute
error as well as signed, because a change that trades a late note for an early
one has to be judged on |err|, and a median-of-per-round-max alongside the
pooled max, because one environmental stall owns the pooled max.

```
# baseline vs what ships (measured aim + chord centring)
python benchmarks/player_ab.py --rounds 10 --seconds 20     --variant base=<a copy of the pre-change midi_player.py>     --variant ship=python-engine/midi_player.py:centre:cal     --json benchmarks/player-ab-final.json
python benchmarks/player_ab.py --rounds 6 --seconds 20 --sustain ...
python benchmarks/player_ab.py --rounds 5 --load forge-below --load-procs 24 ...

# the approach-sleep strategy on its own, tens of thousands of samples
python benchmarks/player_nap_ab.py --samples 4000 --gaps 22,25     --json benchmarks/player-nap-ab.json

# the original single-engine harness, now able to aim the way the app ships
python benchmarks/player_timing.py --seconds 20 --calibrate     --json benchmarks/player-after.json
```

`--calibrate` is OFF by default in player_timing.py so its numbers stay
comparable with `benchmarks/player-baseline.json`; without it the harness
measures the loop with the old fixed 1.5 ms aim and no chord centring, which
is no longer what the app does.

---

## Adversarial verification of the performance pass

Every claim in the pass was re-measured independently on a quiet machine
(0 foreign electron.exe, 0 stray python.exe). What follows is what reproduced,
what did not, and the two changes the audit itself made.

### The noise floor, first

`benchmarks/bench.js` is UNCHANGED by this pass, so its deltas are pure
run-to-run variance and calibrate everything else: JS MIDI parse moves 10-25%
between two consecutive runs of identical code (50k parse 10.26ms then 11.3ms;
120k 29.6 then 26.9), while the python path is stable to ~1.3% (midi_document
50k 1474.0 then 1455.2). So a sub-30% change in a JS micro-benchmark here is
not a result, and the python numbers are.

### Reproduced

| claim | before | verified after |
|---|---:|---:|
| Editor open -> first roll paint, 50k | 1716.8 ms | **32.1 ms** (53.5x) |
| Editor open -> first roll paint, 120k | 4094.0 ms | **82.8 ms** (49.5x) |
| `midi_document.py` load, 50k (bench.js) | 1944 ms | **1465 ms** (-25%) |
| Player \|land err\| pooled, 6 rounds, 3534 notes | mean 1.611 / p95 5.817 / p99 8.207 | **0.962 / 4.261 / 6.129** |
| Player median-of-round max | 12.273 ms | **8.361 ms** |
| Player notes landing >10 ms late | 9 | **1** |
| `boot:window` | 335 ms | **199 ms** (5 runs: 209/198/201/200/199) |
| GameWatch poll | 291 ms wall, 3 spawns | **144 ms, 2 spawns** |
| reap, calling thread blocked | 320 ms (sync) | **14.9 mean / 26.9 max** |
| registry read, thread blocked | 23.2 ms | **4.2 ms** |
| broadcast fan-out, `engine-event` | 7 sends, p99 0.155 ms | **2 sends, p99 0.064 ms** |
| provisioner pump, 20k CR chunks | 2199 ms, **0 lines shown** | **8.6 ms, 19,999 lines** |
| Editor gestures at 120k, focused | 4 fps (250 ms idle clamp) | **23-28.5 fps** |
| decorative loops while minimised | 0.213% GPU | **0.005% GPU** |

Parity, which is the claim that actually protects note accuracy, was re-run
against a corpus the parser had never seen (39 files from Downloads/Desktop/
claude, including a unicode filename and a 120k-note file): **39/39 identical,
0 refused**. The refusal paths behave: a type-2 file and a missing file both
fall back to the python loader and the user sees mido's own error.

### Two things the audit changed

1. **The injection calibration was on the Play path.** `_injection_cost()` ran
   inside `_run_session`, so the first Play of every sidecar process paid
   208 ms for it (measured 205-213 ms over 5 runs; 150 ms of that is the
   deliberate 15 ms spacing between isolated-press samples) between the click
   and the count-in. The accuracy it buys is real and is kept; only its
   position moved. It is now prewarmed on a background thread straight after
   `{"event":"ready"}`, on an idle sidecar: **first Play 221-240 ms -> 0.008 ms**.
   A Play arriving mid-prewarm WAITS for that result (`_inject_lock`) instead of
   starting a second calibration -- two SendInput bursts at once measure each
   other (tap 3.45 ms observed under concurrency against 1.41 ms idle), and
   that inflated number would be cached for the life of the process and aim
   every chord far too early. CPU load alone does NOT distort it: 8 busy
   processes moved the tap median 1.41 -> 1.32 ms, i.e. not at all.

2. **The Editor's selection memo had no test.** It is keyed on the `selected`
   Set's identity, `selVersion` and `notesEpoch`. Every path that replaces the
   selection builds a new Set, and the two that mutate one in place both bump
   `selVersion` -- so it is correct today. Nothing stopped a third in-place
   `selected.add/delete` being added without the bump, which would serve a
   stale list and silently apply the next edit to the WRONG NOTES. Now
   asserted in `tools/run-tests.js`, and the assertion was verified to fail on
   an injected violation.

### Disclosed, immaterial: `duration` moved by 1 microsecond

Replacing `float(midi.length)` with the `time_sec` the parse loop already
accumulated changes `duration` on **3 of 45 real files, by exactly 1e-6 s**.
All 515,955 notes across those files are bit-identical. The change is
deliberate: `.length` re-iterates the merged track with compensated summation
and lands up to 1e-12 from a plain left-to-right total, which is what made the
python and JS loaders disagree in the 6th decimal. Taking `time_sec` is what
makes the two loaders bit-identical, which is what makes the 53x Editor open
safe. 1 microsecond is far below both display precision and one audio sample.

### Claims that did not survive as stated

* **`bench.js` JS-parse "improvements" are noise.** The parse code it exercises
  is untouched; -18% to -34% is the same variance that produces -10% between
  two runs of the identical build. No JS parse regression either.
* **GameWatch's wildcard is not the fastest variant in wall clock.** Variant B
  (three exact filters, parallel) measured 109 ms against the shipped F's
  144 ms. F is still the right choice -- 2 spawns instead of 3 and ~28% less
  machine-wide CPU per poll (356-378 vs 524 ms/poll), which is what matters for
  a probe that runs every 20 s forever -- but the wall-clock win over A is
  parallelism, not the wildcard.
* **`painted` and `handover` remain unattributable**, exactly as the main-process
  agent said. Verified `boot:window` (335 -> 199) is real and tight; `painted`
  (530-578) sits inside the spread of the before set.

### Gates

`node tools/run-tests.js` -> **502 passed, 0 failed**. Layout audit clean on all
7 pages at 1920x1080 and 1040x700. No orphaned electron or python processes.
