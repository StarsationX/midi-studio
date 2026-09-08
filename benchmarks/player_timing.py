#!/usr/bin/env python3
"""player_timing.py -- measures the ACTUAL dispatch timing error of the player.

Why this exists
---------------
Player timing is the highest-priority behaviour in the app and had never been
measured. `midi_player.playback_loop` already records `actual - target` when
collect_stats is on, but nothing ever ran it under load, nothing measured the
keypress cost sitting between "we woke up" and "the key is down", and nothing
checked whether Forge backgrounding does anything.

What it measures
----------------
For every note, three instants on one perf_counter timeline:

    ideal   = base + t_sec                (where the note belongs, musically)
    entry   = perf() just before the press call
    exit    = perf() just after the press call returns

  wake_err  = entry - ideal    scheduler accuracy: how late the loop woke up
  land_err  = exit  - ideal    what the target window actually sees
  press_ms  = exit  - entry    cost of the keypress itself

`playback_loop` deliberately aims `latency_offset` (1.5 ms) EARLY so the key
LANDS on the beat, so a healthy run has wake_err ~= -1.5 ms and land_err ~= 0.
land_err is the number a user hears. Both are reported.

Keyboard modes (--kb)
---------------------
  nullkey  (default) REAL pynput Controller driving KeyCode.from_vk(0xFF), an
           undefined virtual key. Identical SendInput injection path and
           identical per-press pynput dispatch, but no application anywhere
           receives a character, so this is safe to run against whatever window
           happens to be in the foreground. This is the honest default.
  stub     no keypress at all. Isolates the pure scheduler floor.
  real     real pynput with the real mapped characters. TYPES INTO THE
           FOREGROUND WINDOW. Requires --allow-real-keys.

Because nullkey mode skips pynput's per-press char->KeyCode resolution and
midi_player's _parse_mapping_value, --microbench measures those two costs
separately so the real total can be reconstructed without typing anything.

Load conditions (--load)
------------------------
  none          idle machine
  cpu           N spinner processes at NORMAL priority (N = --load-procs,
                default = cpu_count) -- "user is doing something else"
  forge-below   same spinners at BELOW_NORMAL, i.e. a Forge job with playback
                NOT counted (what forge.setBackground(false) leaves behind)
  forge-low     same spinners at IDLE/LOW, i.e. what forge.setBackground(true)
                actually does while playback is live
Comparing forge-below against forge-low IS the measurement of whether the Forge
backgrounding in invariant 5 helps. The spinners imitate the OpenMP spin-wait
profile that invariant 5 names as the culprit; they are CPU-only and never
touch the GPU or a real model.

Usage
-----
  python benchmarks/player_timing.py --load none
  python benchmarks/player_timing.py --all --seconds 20 --json player.json
  python benchmarks/player_timing.py --microbench --sleep-probe --ipc-volume
"""

import argparse
import json
import os
import statistics
import subprocess
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
ENGINE = ROOT / "python-engine"
sys.path.insert(0, str(ENGINE))

import midi_player as engine  # noqa: E402
from pynput.keyboard import Controller, KeyCode  # noqa: E402

PLATFORM = sys.platform
NULL_VK = 0xFF  # undefined virtual key: full injection path, zero side effect


# ---------------------------------------------------------------------------
# stats
# ---------------------------------------------------------------------------

def stats(samples, scale=1000.0):
    """mean/p50/p95/p99/max in ms. A tail stall is what a user notices."""
    if not samples:
        return None
    s = sorted(x * scale for x in samples)
    n = len(s)

    def at(p):
        return s[min(n - 1, int(p * n))]

    return {
        "n": n,
        "mean": round(statistics.mean(s), 4),
        "p50": round(at(0.50), 4),
        "p95": round(at(0.95), 4),
        "p99": round(at(0.99), 4),
        "max": round(s[-1], 4),
        "min": round(s[0], 4),
        "stdev": round(statistics.stdev(s), 4) if n > 1 else 0.0,
        "abs_mean": round(statistics.mean(abs(x) for x in s), 4),
        "over_5ms": sum(1 for x in s if abs(x) > 5.0),
        "over_10ms": sum(1 for x in s if abs(x) > 10.0),
        "over_20ms": sum(1 for x in s if abs(x) > 20.0),
    }


# ---------------------------------------------------------------------------
# recording keyboards
# ---------------------------------------------------------------------------

class RecordingKB:
    """Wraps a keyboard and timestamps every press/release.

    press() and release() are what playback_loop and play_keys call. The
    timestamps bracket the ACTUAL injection, so press cost is measured where it
    is paid rather than inferred.

    Only presses of a BASE key are recorded as notes. play_keys() also presses
    Shift/Ctrl around a note whose mapping needs a modifier, and those arrive
    here as pynput Key enum members rather than strings; counting them as notes
    put the whole press-to-event pairing out of step by however many uppercase
    keys the mapping happened to use.
    """

    __slots__ = ("presses", "releases", "mod_presses", "mod_releases",
                 "_press", "_release", "_mode")

    def __init__(self, mode):
        self._mode = mode
        self.presses = []    # (entry_perf, exit_perf) for base keys only
        self.releases = []
        self.mod_presses = 0
        self.mod_releases = 0
        if mode == "stub":
            self._press = self._noop
            self._release = self._noop
        elif mode == "nullkey":
            kb = Controller()
            nk = KeyCode.from_vk(NULL_VK)
            self._press = lambda _v, _kb=kb, _nk=nk: _kb.press(_nk)
            self._release = lambda _v, _kb=kb, _nk=nk: _kb.release(_nk)
        elif mode == "real":
            kb = Controller()
            self._press = kb.press
            self._release = kb.release
        else:
            raise SystemExit("unknown --kb " + str(mode))

    @staticmethod
    def _noop(_v):
        pass

    def press(self, v):
        t0 = time.perf_counter()
        self._press(v)
        t1 = time.perf_counter()
        if isinstance(v, str):
            self.presses.append((t0, t1))
        else:
            self.mod_presses += 1

    def release(self, v):
        t0 = time.perf_counter()
        self._release(v)
        t1 = time.perf_counter()
        if isinstance(v, str):
            self.releases.append((t0, t1))
        else:
            self.mod_releases += 1


# ---------------------------------------------------------------------------
# load generators
# ---------------------------------------------------------------------------

SPINNER = "\n".join([
    "import time,math",
    "t=time.time()+%f",
    "x=0.0",
    "while time.time()<t:",
    "    for i in range(20000): x=math.sqrt(x*1.000001+i)",
])


def _set_priority(pid, klass):
    """klass: normal | below | idle. Windows only; best effort."""
    if PLATFORM != "win32":
        return False
    try:
        import win32api
        import win32con
        import win32process
        table = {
            "normal": win32process.NORMAL_PRIORITY_CLASS,
            "below": win32process.BELOW_NORMAL_PRIORITY_CLASS,
            "idle": win32process.IDLE_PRIORITY_CLASS,
        }
        h = win32api.OpenProcess(win32con.PROCESS_SET_INFORMATION, False, pid)
        win32process.SetPriorityClass(h, table[klass])
        win32api.CloseHandle(h)
        return True
    except Exception as e:  # pragma: no cover
        print("  [warn] could not set priority on %s: %s" % (pid, e),
              file=sys.stderr)
        return False


class LoadGen:
    """N spinner subprocesses at a chosen priority class."""

    def __init__(self, kind, procs, seconds):
        self.kind = kind
        self.procs = procs
        self.seconds = seconds
        self.children = []
        self.applied = 0

    def start(self):
        if self.kind == "none":
            return
        klass = {"cpu": "normal", "forge-below": "below",
                 "forge-low": "idle"}[self.kind]
        code = SPINNER % (self.seconds + 10.0)
        for _ in range(self.procs):
            kw = {}
            if PLATFORM == "win32":
                kw["creationflags"] = 0x08000000  # CREATE_NO_WINDOW
            p = subprocess.Popen([sys.executable, "-c", code],
                                 stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, **kw)
            self.children.append(p)
        for p in self.children:
            if _set_priority(p.pid, klass):
                self.applied += 1
        # let the spinners reach steady state before anything is timed
        time.sleep(1.5)

    def stop(self):
        for p in self.children:
            try:
                p.kill()
            except Exception:
                pass
        for p in self.children:
            try:
                p.wait(timeout=5)
            except Exception:
                pass
        self.children = []


# ---------------------------------------------------------------------------
# the run
# ---------------------------------------------------------------------------

def run_once(midi, mapping, seconds, kb_mode, load, load_procs, sustain,
             progress_loop, focus_monitor_cost, tempo=1.0, verbose=True,
             calibrate=False):
    mapping_data, note_to_key = engine.load_mapping(mapping, ENGINE)
    events, unmapped, total_dur, bpm, _g = engine.parse_midi(
        str(midi), note_to_key, tempo)
    if not events:
        raise SystemExit("fixture produced no events")
    end_at = float(seconds) if seconds and seconds < total_dur else None
    n_expect = sum(1 for e in events if end_at is None or e[0] < end_at)

    kb = RecordingKB(kb_mode)
    state = engine.State(len(events), total_dur, bpm)

    # ipc_main.py runs the loop on a worker thread with a 20 Hz progress
    # emitter and a focus monitor alongside it. Reproduce that exactly, or the
    # measurement is of a program nobody ships.
    emitted = {"n": 0, "bytes": 0}
    stop_prog = threading.Event()

    def prog():
        while not state.stop_event.is_set() and not stop_prog.is_set():
            elapsed = (state.frozen_elapsed
                       if state.frozen_elapsed is not None
                       else (time.perf_counter() - state.base_time
                             if state.base_time > 0 else 0.0))
            line = json.dumps({
                "event": "progress",
                "elapsed": round(elapsed, 4),
                "played": state.played_count,
                "focus_lost": bool(state.focus_lost),
                "user_paused": bool(state.user_paused),
                "frozen_elapsed": None,
                "base_time_perf": round(state.base_time, 6),
            }, separators=(",", ":"))
            emitted["n"] += 1
            emitted["bytes"] += len(line) + 1
            time.sleep(0.05)

    fm_polls = {"n": 0}

    def fake_focus_monitor():
        """Same shape and cadence as engine.focus_monitor: a Win32 foreground
        lookup every 25 ms. Uses the real call so its true cost is included,
        but never compares against a target (a real focus loss would pause
        playback and make the timing numbers meaningless)."""
        while not state.stop_event.is_set():
            engine.focused_id()
            fm_polls["n"] += 1
            time.sleep(0.025)

    if progress_loop:
        threading.Thread(target=prog, daemon=True, name="progress").start()
    if focus_monitor_cost:
        threading.Thread(target=fake_focus_monitor, daemon=True,
                         name="focus-monitor").start()

    gen = LoadGen(load, load_procs, (seconds or total_dur))
    gen.start()

    wall0 = time.perf_counter()
    result_holder = {}

    # Default OFF so these numbers stay comparable with the pre-optimisation
    # benchmarks/player-baseline.json. Pass --calibrate to measure what the
    # app actually ships: ipc_main.py calibrates the aim and hands
    # playback_loop the back-to-back cost so chords straddle the beat.
    latency = 0.0015
    inject_cost = None
    if calibrate:
        aim, chord_press, chord_tap = engine.calibrate_injection(Controller())
        if aim is not None:
            latency = aim
            inject_cost = chord_press if sustain else chord_tap

    def session():
        try:
            engine.playback_loop(events, state, kb, latency, None, True,
                                 sustain, end_at, inject_cost=inject_cost)
        except BaseException as e:  # noqa: BLE001
            result_holder["error"] = repr(e)

    th = threading.Thread(target=session, daemon=True, name="session")
    th.start()
    th.join(timeout=(seconds or total_dur) + 30)
    wall = time.perf_counter() - wall0
    state.stop_event.set()
    state.pause_event.set()
    stop_prog.set()
    gen.stop()

    base = state.base_time
    presses = kb.presses
    # events[k] is the k-th note the loop fires (dedup + stagger already
    # applied inside parse_midi), so press k pairs with events[k].
    wake, land, cost = [], [], []
    for k, (entry, exit_) in enumerate(presses):
        if k >= len(events):
            break
        ideal = base + events[k][0]
        wake.append(entry - ideal)
        land.append(exit_ - ideal)
        cost.append(exit_ - entry)

    # Inter-note gap distribution, so the numbers can be read against how hard
    # the fixture actually is.
    upto = min(len(events), n_expect)
    gaps = [events[i + 1][0] - events[i][0] for i in range(upto - 1)]

    # Every note of a chord shares one target time, so notes 2..k of a chord
    # can only be dispatched after the ones before them have finished
    # injecting. Bucketing land_err by position-within-chord shows whether the
    # tail of the distribution is chords rather than the scheduler.
    by_pos = {}
    pos = 0
    for k in range(len(land)):
        if k > 0 and (events[k][0] - events[k - 1][0]) < 0.003:
            pos += 1
        else:
            pos = 0
        by_pos.setdefault(min(pos, 7), []).append(land[k])
    chord_pos = {("pos_%d" % k): stats(v) for k, v in sorted(by_pos.items())}

    out = {
        "condition": {
            "load": load, "load_procs": (load_procs if load != "none" else 0),
            "load_priority_applied": gen.applied,
            "kb": kb_mode, "sustain": bool(sustain),
            "calibrated_aim": bool(calibrate),
            "latency_offset_ms": round(latency * 1000.0, 4),
            "inject_cost_ms": (round(inject_cost * 1000.0, 4)
                               if inject_cost else None),
            "progress_loop": bool(progress_loop),
            "focus_monitor": bool(focus_monitor_cost),
        },
        "fixture": {
            "path": str(midi), "mapping": mapping,
            "events_total": len(events), "events_in_window": n_expect,
            "notes_dispatched": len(presses),
            "seconds": round(seconds or total_dur, 2),
            "wall_seconds": round(wall, 3),
            "bpm": round(bpm, 2),
            "unmapped": len(unmapped),
            "gap_ms": stats(gaps) if gaps else None,
            "gaps_under_3ms": sum(1 for g in gaps if g < 0.003),
            "gaps_3_to_30ms": sum(1 for g in gaps if 0.003 <= g < 0.030),
        },
        "land_err_by_chord_position_ms": chord_pos,
        "wake_err_ms": stats(wake),
        "land_err_ms": stats(land),
        "press_cost_ms": stats(cost),
        "engine_timing_errors_ms": stats(state.timing_errors),
        "releases": len(kb.releases),
        "modifier_presses": kb.mod_presses,
        "modifier_releases": kb.mod_releases,
        "ipc": {
            "progress_packets": emitted["n"],
            "progress_bytes": emitted["bytes"],
            "packets_per_sec": round(emitted["n"] / wall, 2) if wall else 0,
            "bytes_per_sec": round(emitted["bytes"] / wall, 1) if wall else 0,
            "per_note_packets": 0,
        },
        "focus_monitor_polls": fm_polls["n"],
        "error": result_holder.get("error"),
    }
    if verbose:
        print_run(out)
    return out


def print_run(r):
    c = r["condition"]
    f = r["fixture"]
    print("\n--- load=%s(%dp,prio_ok=%d) kb=%s sustain=%s ---"
          % (c["load"], c["load_procs"], c["load_priority_applied"],
             c["kb"], c["sustain"]))
    print("  %d/%d notes over %ss wall  gaps<3ms=%d 3-30ms=%d"
          % (f["notes_dispatched"], f["events_in_window"], f["wall_seconds"],
             f["gaps_under_3ms"], f["gaps_3_to_30ms"]))
    for key in ("wake_err_ms", "land_err_ms", "press_cost_ms"):
        s = r[key]
        if not s:
            continue
        print("  %-15s mean %+8.3f p95 %+8.3f p99 %+8.3f max %+9.3f "
              ">5ms %-4d >20ms %d"
              % (key, s["mean"], s["p95"], s["p99"], s["max"],
                 s["over_5ms"], s["over_20ms"]))
    cp = r.get("land_err_by_chord_position_ms") or {}
    if cp:
        parts = []
        for k in sorted(cp, key=lambda x: int(x.split("_")[1])):
            v = cp[k]
            if v:
                parts.append("%s n=%d mean%+.2f p99%+.2f max%+.2f"
                             % (k, v["n"], v["mean"], v["p99"], v["max"]))
        print("  land_err by position within chord:")
        for x in parts:
            print("      " + x)
    i = r["ipc"]
    print("  ipc: %s/s progress, %s B/s, %d per note; focus polls %d"
          % (i["packets_per_sec"], i["bytes_per_sec"], i["per_note_packets"],
             r["focus_monitor_polls"]))


# ---------------------------------------------------------------------------
# microbenchmarks: the per-press CPU that nullkey mode does not include
# ---------------------------------------------------------------------------

def microbench(iters=200000):
    """Cost of the per-note Python work in play_keys, apart from injection.

    play_keys() re-parses the mapping string and pynput re-resolves the char to
    a KeyCode on EVERY note. Neither depends on anything that changes during
    playback, so both are measurable here without injecting a keystroke.
    """
    out = {}
    vals = ["a", "q", "Z", "!", "ctrl+1", "shift+3"]

    def bench(label, fn, n):
        for _ in range(1000):      # warm up: time steady state, not first call
            fn()
        t0 = time.perf_counter()
        for _ in range(n):
            fn()
        dt = time.perf_counter() - t0
        out[label] = {"iters": n, "total_s": round(dt, 4),
                      "per_call_us": round(dt / n * 1e6, 4)}
        print("  %-40s %8.3f us/call" % (label, out[label]["per_call_us"]))

    pmv = engine._parse_mapping_value
    i = [0]

    def parse_mixed():
        i[0] += 1
        pmv(vals[i[0] % len(vals)])

    bench("_parse_mapping_value (mixed values)", parse_mixed, iters)
    bench("_parse_mapping_value ('a')", lambda: pmv("a"), iters)

    kb = Controller()
    resolve = getattr(kb, "_resolve", None)
    if resolve is not None:
        bench("pynput Controller._resolve('a')", lambda: resolve("a"), iters)
    bench("KeyCode.from_char('a')", lambda: KeyCode.from_char("a"), iters)
    nk = KeyCode.from_vk(NULL_VK)
    if resolve is not None:
        bench("pynput Controller._resolve(KeyCode)", lambda: resolve(nk), iters)

    mod_keys = engine._MOD_KEYS

    def prologue():
        mods, base = pmv("a")
        [mod_keys[m] for m in mods if m in mod_keys]

    bench("play_keys prologue ('a', no injection)", prologue, iters)

    # Real injection cost through the real pynput path, undefined VK.
    n = 4000
    t0 = time.perf_counter()
    for _ in range(n):
        kb.press(nk)
        kb.release(nk)
    dt = time.perf_counter() - t0
    out["pynput_press_release_nullkey"] = {
        "iters": n, "total_s": round(dt, 4),
        "per_call_us": round(dt / n * 1e6, 4)}
    print("  %-40s %8.3f us/call"
          % ("pynput press+release (null VK, injects)",
             out["pynput_press_release_nullkey"]["per_call_us"]))
    return out


# ---------------------------------------------------------------------------
# sleep-resolution probe: the floor the scheduler cannot beat
# ---------------------------------------------------------------------------

def sleep_probe(n=400):
    """How accurately can this machine wake up at all?

    Three regimes, each one playback_loop actually uses:
      raw sleep(x)                 -- timer resolution not raised
      hi-res sleep(x)              -- inside engine.hi_res_timer()
      hybrid (sleep + 3 ms spin)   -- engine._hybrid_sleep, what ships
    """
    out = {}

    def measure(label, fn, target):
        errs = []
        for _ in range(n):
            t = time.perf_counter() + target
            fn(t, target)
            errs.append(time.perf_counter() - t)
        out[label] = stats(errs)
        s = out[label]
        print("  %-34s mean %+7.3f p95 %+7.3f p99 %+7.3f max %+8.3f"
              % (label, s["mean"], s["p95"], s["p99"], s["max"]))

    for target in (0.002, 0.010, 0.050):
        tag = "%dms" % int(target * 1000)
        measure("raw sleep " + tag, lambda _t, d: time.sleep(d), target)
        with engine.hi_res_timer():
            measure("hi-res sleep " + tag, lambda _t, d: time.sleep(d), target)
            measure("hi-res hybrid " + tag,
                    lambda t, _d: engine._hybrid_sleep(t), target)
    return out


# ---------------------------------------------------------------------------
# IPC volume: what actually crosses the pipe, per second and per note
# ---------------------------------------------------------------------------

def ipc_volume(seconds=5.0):
    """Counts every byte ipc_main would write during steady playback.

    playback_loop is called from ipc_main with q=None, so the display queue is
    dead in-app and NOTHING is emitted per note. The only steady traffic is the
    20 Hz progress packet. This measures its true size and rate, and the cost
    of the json.dumps that produces it.
    """
    state = engine.State(1000, 300.0, 120.0)
    state.base_time = time.perf_counter()
    n = 0
    total = 0
    t_end = time.perf_counter() + seconds
    build = []
    while time.perf_counter() < t_end:
        t0 = time.perf_counter()
        elapsed = time.perf_counter() - state.base_time
        line = json.dumps({
            "event": "progress", "elapsed": round(elapsed, 4),
            "played": state.played_count, "focus_lost": False,
            "user_paused": False, "frozen_elapsed": None,
            "base_time_perf": round(state.base_time, 6),
        }, separators=(",", ":"))
        build.append(time.perf_counter() - t0)
        n += 1
        total += len(line) + 1
        time.sleep(0.05)
    out = {
        "packets": n, "bytes": total,
        "packets_per_sec": round(n / seconds, 2),
        "bytes_per_sec": round(total / seconds, 1),
        "bytes_per_packet": round(total / max(n, 1), 1),
        "build_cost_ms": stats(build),
        "per_note_packets": 0,
        "note": ("ipc_main.py passes q=None to playback_loop, so the per-note "
                 "queue.put_nowait is dead in-app; 0 packets per note."),
    }
    print("  progress: %s/s, %s B each, %s B/s; build %.4f ms mean, p99 %.4f ms"
          % (out["packets_per_sec"], out["bytes_per_packet"],
             out["bytes_per_sec"], out["build_cost_ms"]["mean"],
             out["build_cost_ms"]["p99"]))
    print("  per note: %d packets (%s)" % (out["per_note_packets"], out["note"]))
    return out


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

ALL_LOADS = ("none", "cpu", "forge-below", "forge-low")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--midi", default=str(HERE / "fixtures" / "player-dense.mid"))
    p.add_argument("--mapping", default="virtualpiano")
    p.add_argument("--seconds", type=float, default=20.0,
                   help="play only the first N seconds (0 = whole file)")
    p.add_argument("--kb", default="nullkey",
                   choices=("nullkey", "stub", "real"))
    p.add_argument("--allow-real-keys", action="store_true")
    p.add_argument("--load", default="none", choices=ALL_LOADS)
    p.add_argument("--load-procs", type=int, default=os.cpu_count() or 4)
    p.add_argument("--sustain", action="store_true")
    p.add_argument("--tempo", type=float, default=1.0)
    p.add_argument("--no-progress", action="store_true",
                   help="omit the 20 Hz progress thread")
    p.add_argument("--no-focus-monitor", action="store_true")
    p.add_argument("--all", action="store_true",
                   help="run every load condition in sequence")
    p.add_argument("--repeat", type=int, default=1)
    p.add_argument("--microbench", action="store_true")
    p.add_argument("--sleep-probe", action="store_true")
    p.add_argument("--ipc-volume", action="store_true")
    p.add_argument("--calibrate", action="store_true",
                   help="aim as the shipped app does: measured latency offset "
                        "plus chord centring (default off, so runs stay "
                        "comparable with player-baseline.json)")
    p.add_argument("--no-play", action="store_true",
                   help="skip the playback runs (probes only)")
    p.add_argument("--json", default="")
    args = p.parse_args()

    if args.kb == "real" and not args.allow_real_keys:
        raise SystemExit("--kb real types into the foreground window. "
                         "Pass --allow-real-keys if that is genuinely what "
                         "you want.")

    report = {
        "meta": {
            "when": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "platform": PLATFORM,
            "python": sys.version.split()[0],
            "cpu_count": os.cpu_count(),
            "args": vars(args),
        },
        "runs": [],
    }

    if args.sleep_probe:
        print("\n=== sleep / wake resolution (ms error) ===")
        report["sleep_probe"] = sleep_probe()
    if args.microbench:
        print("\n=== per-note CPU, apart from injection ===")
        report["microbench"] = microbench()
    if args.ipc_volume:
        print("\n=== IPC volume during playback ===")
        report["ipc_volume"] = ipc_volume()

    if not args.no_play:
        loads = ALL_LOADS if args.all else (args.load,)
        for load in loads:
            for _ in range(args.repeat):
                report["runs"].append(run_once(
                    Path(args.midi), args.mapping, args.seconds, args.kb,
                    load, args.load_procs, args.sustain,
                    not args.no_progress, not args.no_focus_monitor,
                    args.tempo, calibrate=args.calibrate))

    if args.json:
        Path(args.json).write_text(json.dumps(report, indent=2), encoding="utf-8")
        print("\nwrote " + args.json)
    return 0


if __name__ == "__main__":
    sys.exit(main())
