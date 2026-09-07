#!/usr/bin/env python3
"""player_ab.py -- A/B/C dispatch-timing comparison of midi_player variants.

Why a second harness
--------------------
benchmarks/player_timing.py measures ONE engine and prints per-run stats. The
measurement noise floor on this machine is large (p99 varied 10.1-13.8 ms
across identical idle runs), so a single before/after pair cannot tell a real
2 ms improvement from machine drift.

This driver removes both problems:

  * it loads TWO OR MORE copies of midi_player.py (any file path) into one
    process and runs them ALTERNATELY, round by round, order swapped on odd
    rounds, so slow drift in the machine is shared by every variant instead of
    being attributed to whichever ran last;
  * it pools the RAW per-note errors across rounds and reports absolute-error
    percentiles as well as signed ones. Signed p99 alone is misleading for a
    change that trades a late note for an early one: |err| is what a listener
    hears.

Everything else reproduces ipc_main.py exactly: the loop runs on a worker
thread with the real 20 Hz progress emitter and a real-cost focus monitor
alongside it, and --kb nullkey drives a real pynput Controller against
KeyCode.from_vk(0xFF), an undefined virtual key -- the identical SendInput
path with no application anywhere receiving a character.

Usage
-----
  python benchmarks/player_ab.py --rounds 6 --seconds 20 \
      --variant base=<path to old midi_player.py> \
      --variant nap=python-engine/midi_player.py \
      --variant centre=python-engine/midi_player.py:centre \
      --json benchmarks/player-ab.json

A variant spec is NAME=PATH[:centre][:cal]. ":centre" passes the measured
per-injection cost into playback_loop as inject_cost, which turns on chord
centring; without it inject_cost stays None and the loop aims exactly as it
does today. ":cal" replaces the hardcoded 1.5 ms latency_offset with the
measured press-only cost, which is what ipc_main.py now does.
"""

import argparse
import importlib.util
import json
import statistics
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
ENGINE = ROOT / "python-engine"
sys.path.insert(0, str(ENGINE))
sys.path.insert(0, str(HERE))

from player_timing import RecordingKB, LoadGen, NULL_VK  # noqa: E402
from pynput.keyboard import Controller, KeyCode  # noqa: E402


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, str(path))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def pstats(samples, absolute=False):
    if not samples:
        return None
    vals = [abs(x) * 1000.0 if absolute else x * 1000.0 for x in samples]
    s = sorted(vals)
    n = len(s)

    def at(p):
        return s[min(n - 1, int(p * n))]

    return {
        "n": n,
        "mean": round(statistics.mean(s), 3),
        "p50": round(at(0.50), 3),
        "p95": round(at(0.95), 3),
        "p99": round(at(0.99), 3),
        "max": round(s[-1], 3),
        "min": round(s[0], 3),
        "over_5ms": sum(1 for x in vals if abs(x) > 5.0),
        "over_10ms": sum(1 for x in vals if abs(x) > 10.0),
        "over_20ms": sum(1 for x in vals if abs(x) > 20.0),
    }


def measure_inject_cost():
    """The costs the shipped player will actually aim with.

    This calls the REAL midi_player.calibrate_injection so the A/B measures
    the calibration that ships, not a second implementation of it that could
    drift from it. Returns (aim, chord_press, chord_tap) in seconds.
    """
    import importlib.util as _il
    spec = _il.spec_from_file_location("_ab_live_engine",
                                       str(ENGINE / "midi_player.py"))
    live = _il.module_from_spec(spec)
    spec.loader.exec_module(live)
    with live.hi_res_timer():
        aim, press, tap = live.calibrate_injection(Controller())
    if aim is None:
        aim = press = tap = 0.0015
    return aim, press, tap


def run_once(mod, midi, mapping, seconds, kb_mode, sustain, inject_cost,
             load, load_procs, latency=0.0015):
    mapping_data, note_to_key = mod.load_mapping(mapping, ENGINE)
    events, unmapped, total_dur, bpm, _g = mod.parse_midi(
        str(midi), note_to_key, 1.0)
    end_at = float(seconds) if seconds and seconds < total_dur else None

    kb = RecordingKB(kb_mode)
    state = mod.State(len(events), total_dur, bpm)

    stop_prog = threading.Event()
    emitted = {"n": 0}

    def prog():
        while not state.stop_event.is_set() and not stop_prog.is_set():
            elapsed = (state.frozen_elapsed
                       if state.frozen_elapsed is not None
                       else (time.perf_counter() - state.base_time
                             if state.base_time > 0 else 0.0))
            json.dumps({
                "event": "progress", "elapsed": round(elapsed, 4),
                "played": state.played_count,
                "focus_lost": bool(state.focus_lost),
                "user_paused": bool(state.user_paused),
                "frozen_elapsed": None,
                "base_time_perf": round(state.base_time, 6),
            }, separators=(",", ":"))
            emitted["n"] += 1
            time.sleep(0.05)

    def fake_focus_monitor():
        while not state.stop_event.is_set():
            mod.focused_id()
            time.sleep(0.025)

    threading.Thread(target=prog, daemon=True, name="progress").start()
    threading.Thread(target=fake_focus_monitor, daemon=True,
                     name="focus-monitor").start()

    gen = LoadGen(load, load_procs, (seconds or total_dur))
    gen.start()

    err = {}

    def session():
        try:
            kwargs = {}
            if inject_cost is not None:
                kwargs["inject_cost"] = inject_cost
            mod.playback_loop(events, state, kb, latency, None, True,
                              sustain, end_at, **kwargs)
        except BaseException as e:  # noqa: BLE001
            err["error"] = repr(e)

    th = threading.Thread(target=session, daemon=True, name="session")
    t0 = time.perf_counter()
    c0 = time.process_time()
    th.start()
    th.join(timeout=(seconds or total_dur) + 30)
    wall = time.perf_counter() - t0
    cpu = time.process_time() - c0
    state.stop_event.set()
    state.pause_event.set()
    stop_prog.set()
    gen.stop()
    if err:
        raise SystemExit("variant raised: " + err["error"])

    base = state.base_time
    wake, land, cost, chordpos = [], [], [], []
    pos = 0
    for k, (entry, exit_) in enumerate(kb.presses):
        if k >= len(events):
            break
        ideal = base + events[k][0]
        wake.append(entry - ideal)
        land.append(exit_ - ideal)
        cost.append(exit_ - entry)
        if k > 0 and (events[k][0] - events[k - 1][0]) < 0.003:
            pos += 1
        else:
            pos = 0
        chordpos.append(min(pos, 7))
    return {"wake": wake, "land": land, "cost": cost, "pos": chordpos,
            "wall": wall, "cpu": cpu, "notes": len(land),
            "progress": emitted["n"]}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--midi", default=str(HERE / "fixtures" / "player-dense.mid"))
    p.add_argument("--mapping", default="virtualpiano")
    p.add_argument("--seconds", type=float, default=20.0)
    p.add_argument("--kb", default="nullkey", choices=("nullkey", "stub"))
    p.add_argument("--sustain", action="store_true")
    p.add_argument("--rounds", type=int, default=4)
    p.add_argument("--load", default="none",
                   choices=("none", "cpu", "forge-below", "forge-low"))
    p.add_argument("--load-procs", type=int, default=12)
    p.add_argument("--variant", action="append", default=[],
                   help="NAME=PATH[:centre]")
    p.add_argument("--json", default="")
    args = p.parse_args()

    variants = []
    for i, spec in enumerate(args.variant):
        name, _, rest = spec.partition("=")
        cal = False
        centre = False
        while True:
            if rest.endswith(":cal"):
                cal = True
                rest = rest[:-4]
            elif rest.endswith(":centre"):
                centre = True
                rest = rest[:-7]
            else:
                break
        path = Path(rest).resolve()
        variants.append({"name": name, "path": str(path), "centre": centre,
                         "cal": cal,
                         "mod": load_module("_ab_%d_%s" % (i, name), path)})
    if not variants:
        raise SystemExit("need at least one --variant NAME=PATH")

    aim_cost, chord_press, chord_tap = measure_inject_cost()
    print("calibrated injection cost: isolated press %.3f ms, back-to-back "
          "press %.3f ms, back-to-back press+release %.3f ms"
          % (aim_cost * 1000.0, chord_press * 1000.0, chord_tap * 1000.0))

    pool = {v["name"]: {"wake": [], "land": [], "cost": [], "pos": [],
                        "notes": 0, "runs": 0, "cpu": [], "wall": [],
                        "round_max": [], "round_p99": []}
            for v in variants}

    for r in range(args.rounds):
        order = variants if r % 2 == 0 else list(reversed(variants))
        for v in order:
            res = run_once(v["mod"], Path(args.midi), args.mapping,
                           args.seconds, args.kb, args.sustain,
                           (chord_press if args.sustain else chord_tap)
                           if v["centre"] else None,
                           args.load, args.load_procs,
                           aim_cost if v["cal"] else 0.0015)
            acc = pool[v["name"]]
            acc["wake"] += res["wake"]
            acc["land"] += res["land"]
            acc["cost"] += res["cost"]
            acc["pos"] += res["pos"]
            acc["notes"] += res["notes"]
            acc["cpu"].append(res["cpu"])
            acc["wall"].append(res["wall"])
            acc["runs"] += 1
            ls = pstats(res["land"], absolute=True)
            acc["round_max"].append(ls["max"])
            acc["round_p99"].append(ls["p99"])
            print("  round %d  %-8s n=%-4d land mean%+7.3f p95%+7.3f "
                  "p99%+7.3f max%+8.3f" % (r + 1, v["name"], res["notes"],
                                           ls["mean"], ls["p95"], ls["p99"],
                                           ls["max"]))

    report = {"meta": {"when": time.strftime("%Y-%m-%dT%H:%M:%S"),
                       "args": vars(args),
                       "aim_cost_ms": round(aim_cost * 1000.0, 4),
                       "chord_press_ms": round(chord_press * 1000.0, 4),
                       "chord_tap_ms": round(chord_tap * 1000.0, 4)},
              "variants": {}}
    print("\n=== pooled over %d rounds ===" % args.rounds)
    for v in variants:
        acc = pool[v["name"]]
        by_pos = {}
        for pos, val in zip(acc["pos"], acc["land"]):
            by_pos.setdefault(pos, []).append(val)
        cost_by_pos = {}
        for pos, val in zip(acc["pos"], acc["cost"]):
            cost_by_pos.setdefault(pos, []).append(val)
        entry = {
            "path": v["path"], "centre": v["centre"], "cal": v["cal"],
            "runs": acc["runs"], "notes": acc["notes"],
            "process_cpu_pct_of_wall": round(
                100.0 * sum(acc["cpu"]) / sum(acc["wall"]), 3),
            # Median of the per-round maxima. On a machine where other work is
            # running, one environmental scheduler stall lands in whichever
            # round it lands in and owns the pooled max; the median round max
            # says what the worst note of a typical run costs.
            "median_round_max_ms": round(
                statistics.median(acc["round_max"]), 3),
            "round_max_ms": acc["round_max"],
            "median_round_p99_ms": round(
                statistics.median(acc["round_p99"]), 3),
            "land_err_ms": pstats(acc["land"]),
            "land_abs_err_ms": pstats(acc["land"], absolute=True),
            "wake_err_ms": pstats(acc["wake"]),
            "press_cost_ms": pstats(acc["cost"]),
            "land_abs_by_chord_pos_ms": {
                "pos_%d" % k: pstats(vv, absolute=True)
                for k, vv in sorted(by_pos.items())},
            "land_signed_by_chord_pos_ms": {
                "pos_%d" % k: pstats(vv)
                for k, vv in sorted(by_pos.items())},
            # What one injection actually costs at each position in a chord.
            # pos_0 is the cost the aim offset must cancel (a note arriving
            # after a gap); pos_1+ is the back-to-back cost that chord
            # centring must compensate for. They are not the same number.
            "press_cost_by_chord_pos_ms": {
                "pos_%d" % k: pstats(vv)
                for k, vv in sorted(cost_by_pos.items())},
        }
        report["variants"][v["name"]] = entry
        a = entry["land_abs_err_ms"]
        s = entry["land_err_ms"]
        print("  %-8s n=%-5d |land| mean %6.3f p95 %6.3f p99 %6.3f max %7.3f "
              "| signed mean %+6.3f p99 %+6.3f max %+7.3f | >5ms %d >10ms %d"
              % (v["name"], entry["notes"], a["mean"], a["p95"], a["p99"],
                 a["max"], s["mean"], s["p99"], s["max"],
                 a["over_5ms"], a["over_10ms"]))
        print("           process CPU %.2f%% of wall | median round "
              "|land| p99 %.3f max %.3f  (round maxima %s)"
              % (entry["process_cpu_pct_of_wall"],
                 entry["median_round_p99_ms"], entry["median_round_max_ms"],
                 " ".join("%.1f" % x for x in entry["round_max_ms"])))
    print("\n  |land_err| by chord position (mean / p99 / max, ms)")
    for v in variants:
        e = report["variants"][v["name"]]
        row = []
        for k in sorted(e["land_abs_by_chord_pos_ms"],
                        key=lambda x: int(x.split("_")[1])):
            st = e["land_abs_by_chord_pos_ms"][k]
            row.append("%s %.2f/%.2f/%.2f" % (k[4:], st["mean"], st["p99"],
                                              st["max"]))
        print("    %-8s %s" % (v["name"], "  ".join(row)))

    if args.json:
        Path(args.json).write_text(json.dumps(report, indent=2),
                                   encoding="utf-8")
        print("\nwrote " + args.json)
    return 0


if __name__ == "__main__":
    sys.exit(main())
