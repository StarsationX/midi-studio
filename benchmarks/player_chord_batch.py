#!/usr/bin/env python3
"""player_chord_batch.py -- how much of the chord timing error is avoidable.

player_timing.py shows dispatch error growing ~2.3 ms per additional note of a
chord: every note of a chord shares one target time, but play_keys() issues two
separate SendInput calls per note (press, then release), so note k of a chord
cannot start until the 2(k-1) injections before it have finished.

SendInput's first argument is a COUNT: it takes an ARRAY of INPUT structs and
injects them as one batch, in order, atomically with respect to other input.
This measures the two shapes against each other for chord sizes 1..10:

  serial  -- what ships: 2 SendInput calls per note, k notes = 2k calls
  batched -- one SendInput call carrying all 2k structs

Both inject exactly the same key events in exactly the same order. The only
difference is how many kernel transitions pay for them.

Injection uses vk 0xFF (undefined) so nothing anywhere receives a character.

  python benchmarks/player_chord_batch.py [--json out.json] [--reps 120]
"""

import argparse
import ctypes
import json
import statistics
import sys
import time
from pathlib import Path

from pynput._util.win32 import INPUT, INPUT_union, KEYBDINPUT, SendInput

NULL_VK = 0xFF
KEYUP = KEYBDINPUT.KEYUP
SZ = ctypes.sizeof(INPUT)


def stats(samples):
    s = sorted(x * 1000.0 for x in samples)
    n = len(s)

    def at(p):
        return s[min(n - 1, int(p * n))]

    return {"n": n, "mean": round(statistics.mean(s), 4),
            "p50": round(at(0.50), 4), "p95": round(at(0.95), 4),
            "p99": round(at(0.99), 4), "max": round(s[-1], 4)}


def one(vk, up):
    return INPUT(type=INPUT.KEYBOARD,
                 value=INPUT_union(ki=KEYBDINPUT(
                     wVk=vk, wScan=0, dwFlags=(KEYUP if up else 0))))


def make_batch(k):
    """2k structs: press,release for each of k notes, in play order."""
    arr = (INPUT * (2 * k))()
    for i in range(k):
        arr[2 * i] = one(NULL_VK, False)
        arr[2 * i + 1] = one(NULL_VK, True)
    return arr


def serial_structs(k):
    return [(one(NULL_VK, False), one(NULL_VK, True)) for _ in range(k)]


def run(reps, pace):
    out = {"reps": reps, "pace_s": pace, "sizes": {}}
    print("  chord  serial (ms per whole chord)          batched (ms per whole chord)")
    for k in (1, 2, 3, 4, 6, 8, 10):
        pre_serial = serial_structs(k)
        pre_batch = make_batch(k)
        ser, bat = [], []
        for _ in range(reps):
            t0 = time.perf_counter()
            for down, up in pre_serial:
                SendInput(1, ctypes.byref(down), SZ)
                SendInput(1, ctypes.byref(up), SZ)
            ser.append(time.perf_counter() - t0)
            time.sleep(pace)
            t0 = time.perf_counter()
            SendInput(2 * k, ctypes.byref(pre_batch), SZ)
            bat.append(time.perf_counter() - t0)
            time.sleep(pace)
        s, b = stats(ser), stats(bat)
        out["sizes"][str(k)] = {"serial": s, "batched": b,
                               "speedup_mean": round(s["mean"] / max(b["mean"], 1e-9), 2)}
        print("  %5d  mean %7.3f p99 %7.3f max %7.3f   mean %7.3f p99 %7.3f "
              "max %7.3f   %5.1fx"
              % (k, s["mean"], s["p99"], s["max"], b["mean"], b["p99"],
                 b["max"], out["sizes"][str(k)]["speedup_mean"]))
    return out


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--reps", type=int, default=120)
    p.add_argument("--pace", type=float, default=0.02)
    p.add_argument("--json", default="")
    a = p.parse_args()
    print("\n=== chord dispatch: serial SendInput vs one batched call ===")
    print("  sizeof(INPUT) = %d  (a 32-byte struct makes SendInput fail "
          "silently and look 100x faster)" % SZ)
    r = run(a.reps, a.pace)
    r["sizeof_input"] = SZ
    if a.json:
        Path(a.json).write_text(json.dumps(r, indent=2), encoding="utf-8")
        print("\nwrote " + a.json)
    return 0


if __name__ == "__main__":
    sys.exit(main())
