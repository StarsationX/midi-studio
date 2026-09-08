#!/usr/bin/env python3
"""player_nap_ab.py -- isolates the approach-sleep strategy of playback_loop.

A whole-run A/B (player_ab.py) cannot resolve this change: the measurement
noise floor on one machine is about +/-1.5 ms at p99, and a note's error is
dominated by chord serialisation, not by which nap took it there. This probe
strips everything else away and replays ONLY the inner approach loop, tens of
thousands of times, so the overshoot distribution itself is measured.

  old:  nap = min(remaining - spin, poll)            one long sleep, then spin
  new:  nap = min(remaining - spin, remaining/2, poll)

Both spin the last 3 ms exactly as playback_loop does, both cap a single sleep
at 25 ms so pause/seek/stop stays as responsive as it is today, and both are
run inside hi_res_timer(). Strategies alternate sample by sample, so thermal
drift and background load land on both.

  python benchmarks/player_nap_ab.py --samples 3000 --json out.json
"""

import argparse
import json
import statistics
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "python-engine"))

import midi_player as engine  # noqa: E402

SPIN = engine._SPIN_THRESHOLD
POLL = engine._PAUSE_POLL_SLICE
perf = time.perf_counter


def approach(target, halve):
    """One event's worth of the inner sleep loop. Returns (err, naps)."""
    naps = 0
    while True:
        remaining = target - perf()
        if remaining <= 0:
            break
        if remaining > SPIN:
            nap = remaining - SPIN
            if halve:
                half = remaining * 0.5
                if nap > half:
                    nap = half
            if nap > POLL:
                nap = POLL
            time.sleep(nap)
            naps += 1
        else:
            while perf() < target:
                pass
            break
    return perf() - target, naps


def pstats(xs):
    s = sorted(x * 1000.0 for x in xs)
    n = len(s)

    def at(p):
        return s[min(n - 1, int(p * n))]

    return {"n": n, "mean": round(statistics.mean(s), 4),
            "p50": round(at(0.50), 4), "p95": round(at(0.95), 4),
            "p99": round(at(0.99), 4), "max": round(s[-1], 4),
            "over_1ms": sum(1 for x in s if x > 1.0),
            "over_3ms": sum(1 for x in s if x > 3.0)}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--samples", type=int, default=3000)
    p.add_argument("--gaps", default="22,25,50,100",
                   help="comma-separated gap lengths in ms")
    p.add_argument("--json", default="")
    args = p.parse_args()

    # Gap lengths playback_loop really issues on the dense fixture: a 16th-note
    # run (~100 ms), 32nds (~50 ms), and the two lengths the old code's final
    # nap actually took (22 ms after the 25 ms cap, and 25 ms itself).
    gaps = tuple(float(x) / 1000.0 for x in args.gaps.split(","))
    out = {"meta": {"when": time.strftime("%Y-%m-%dT%H:%M:%S"),
                    "samples_per_gap_per_strategy": args.samples,
                    "spin_ms": SPIN * 1000, "poll_ms": POLL * 1000},
           "gaps": {}}

    with engine.hi_res_timer():
        for g in gaps:
            errs = {False: [], True: []}
            naps = {False: 0, True: 0}
            for i in range(args.samples):
                for halve in ((False, True) if i % 2 == 0 else (True, False)):
                    e, n = approach(perf() + g, halve)
                    errs[halve].append(e)
                    naps[halve] += n
            key = "%dms" % round(g * 1000)
            out["gaps"][key] = {
                "old": pstats(errs[False]),
                "new": pstats(errs[True]),
                "naps_per_event_old": round(naps[False] / args.samples, 2),
                "naps_per_event_new": round(naps[True] / args.samples, 2),
            }
            o, n = out["gaps"][key]["old"], out["gaps"][key]["new"]
            print("gap %-6s old mean %+7.4f p95 %+7.4f p99 %+7.4f max %+8.4f "
                  ">3ms %-4d naps %.2f" % (key, o["mean"], o["p95"], o["p99"],
                                           o["max"], o["over_3ms"],
                                           out["gaps"][key]["naps_per_event_old"]))
            print("        new mean %+7.4f p95 %+7.4f p99 %+7.4f max %+8.4f "
                  ">3ms %-4d naps %.2f" % (n["mean"], n["p95"], n["p99"],
                                           n["max"], n["over_3ms"],
                                           out["gaps"][key]["naps_per_event_new"]))

    if args.json:
        Path(args.json).write_text(json.dumps(out, indent=2), encoding="utf-8")
        print("wrote " + args.json)
    return 0


if __name__ == "__main__":
    sys.exit(main())
