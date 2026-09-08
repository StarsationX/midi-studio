#!/usr/bin/env python3
"""player_sleep_ab.py -- is timeBeginPeriod(1) still helping?

midi_player.hi_res_timer() wraps the whole playback loop in
winmm.timeBeginPeriod(1), documented in the source as: "Without this,
time.sleep() snaps to the default ~15.6 ms quantum."

That was true of CPython on Windows for a long time. CPython 3.11 changed
time.sleep() on Windows to use a high-resolution waitable timer
(CreateWaitableTimerExW with CREATE_WAITABLE_TIMER_HIGH_RESOLUTION), which does
not depend on the global timer period at all. Windows 10 2004 also stopped
letting one process's timeBeginPeriod raise the period for everyone.

So the assumption needs re-testing rather than believing. This alternates
ON/OFF several times in one process so drift and thermal state cannot pick a
winner, and reports the OVERSHOOT distribution: how far past the requested wake
time sleep actually returned.

Overshoot is what matters to the player. playback_loop naps
`remaining - _SPIN_THRESHOLD` (3 ms) and then busy-waits the tail, so a note is
only late if a nap overshoots by MORE than 3 ms. The "over_3ms" column is
therefore the fraction of naps that can make a note late.

  python benchmarks/player_sleep_ab.py [--rounds 4] [--json out.json]
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

# The nap lengths playback_loop actually issues: it caps a nap at
# _PAUSE_POLL_SLICE (25 ms) and otherwise sleeps remaining - 3 ms.
NAPS = (0.005, 0.010, 0.022, 0.025)


def summ(v):
    s = sorted(x * 1000.0 for x in v)
    n = len(s)

    def at(p):
        return s[min(n - 1, int(p * n))]

    return {"n": n, "mean": round(statistics.mean(s), 4),
            "p50": round(at(0.50), 4), "p95": round(at(0.95), 4),
            "p99": round(at(0.99), 4), "max": round(s[-1], 4),
            "over_3ms": sum(1 for x in s if x > 3.0),
            "over_3ms_pct": round(100.0 * sum(1 for x in s if x > 3.0) / n, 2)}


def sample(nap, n):
    out = []
    for _ in range(n):
        t = time.perf_counter()
        time.sleep(nap)
        out.append(time.perf_counter() - t - nap)
    return out


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--rounds", type=int, default=4)
    p.add_argument("--n", type=int, default=250)
    p.add_argument("--json", default="")
    a = p.parse_args()

    print("\n=== time.sleep overshoot, timeBeginPeriod(1) ON vs OFF ===")
    print("  python %s   (sleep uses a high-resolution waitable timer from 3.11)"
          % sys.version.split()[0])
    res = {"python": sys.version.split()[0], "naps": {}}
    for nap in NAPS:
        on_all, off_all = [], []
        for _ in range(a.rounds):
            off_all += sample(nap, a.n)          # OFF first
            with engine.hi_res_timer():
                on_all += sample(nap, a.n)       # then ON
        res["naps"]["%.0fms" % (nap * 1000)] = {
            "off": summ(off_all), "on": summ(on_all)}
        o, n_ = summ(off_all), summ(on_all)
        print("  nap %5.0fms  OFF mean %6.3f p95 %6.3f p99 %6.3f max %7.3f  "
              ">3ms %5.2f%%" % (nap * 1000, o["mean"], o["p95"], o["p99"],
                                o["max"], o["over_3ms_pct"]))
        print("              ON  mean %6.3f p95 %6.3f p99 %6.3f max %7.3f  "
              ">3ms %5.2f%%" % (n_["mean"], n_["p95"], n_["p99"], n_["max"],
                                n_["over_3ms_pct"]))

    if a.json:
        Path(a.json).write_text(json.dumps(res, indent=2), encoding="utf-8")
        print("\nwrote " + a.json)
    return 0


if __name__ == "__main__":
    sys.exit(main())
