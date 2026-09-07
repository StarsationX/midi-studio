#!/usr/bin/env python3
"""player_inject_cost.py -- where the ~0.85 ms per injected key event goes.

player_chord_batch.py showed SendInput's cost is per-INPUT-struct, not per call:
batching a whole chord into one syscall is 1.0x. So the only way to make chords
land closer to the beat is to make each event cheaper, or to issue fewer of
them. This isolates the candidate causes, each as an A/B on the same machine in
the same process:

  1 keyboard vs mouse injection
      A low-level KEYBOARD hook installed by any process on the system is
      called synchronously for every injected key event and the injecting
      thread blocks until it returns. Mouse events go through a separate hook
      chain. If keyboard is much slower than mouse, the cost is hook dispatch
      and is environmental, not ours.

  2 GIL re-acquisition
      ctypes releases the GIL around a foreign call and must take it back on
      return. The player runs alongside a 20 Hz progress thread and a 40 Hz
      focus monitor, and sys.getswitchinterval() defaults to 5 ms, so a
      foreign call returning between switches can wait behind another thread.
      Measured with no sibling threads, with the two the app really runs, and
      with a shorter switch interval.

  3 our own hotkey hook
      ipc_main.py installs pynput GlobalHotKeys (WH_KEYBOARD_LL) in the same
      process that injects. Measured with it off and on.

Injection uses vk 0xFF (undefined) and a 0-pixel relative mouse move, so
nothing anywhere receives a character or moves.

  python benchmarks/player_inject_cost.py [--json out.json]
"""

import argparse
import ctypes
import json
import statistics
import sys
import threading
import time
from pathlib import Path

from pynput._util.win32 import INPUT, INPUT_union, KEYBDINPUT, MOUSEINPUT, SendInput
from pynput.keyboard import GlobalHotKeys

SZ = ctypes.sizeof(INPUT)
NULL_VK = 0xFF


def stats(samples):
    s = sorted(x * 1000.0 for x in samples)
    n = len(s)

    def at(p):
        return s[min(n - 1, int(p * n))]

    return {"n": n, "mean": round(statistics.mean(s), 4),
            "p50": round(at(0.50), 4), "p95": round(at(0.95), 4),
            "p99": round(at(0.99), 4), "max": round(s[-1], 4)}


KEY_DOWN = INPUT(type=INPUT.KEYBOARD,
                 value=INPUT_union(ki=KEYBDINPUT(wVk=NULL_VK, wScan=0, dwFlags=0)))
KEY_UP = INPUT(type=INPUT.KEYBOARD,
               value=INPUT_union(ki=KEYBDINPUT(wVk=NULL_VK, wScan=0,
                                               dwFlags=KEYBDINPUT.KEYUP)))
MOUSE_NUDGE = INPUT(type=INPUT.MOUSE,
                    value=INPUT_union(mi=MOUSEINPUT(dx=0, dy=0, mouseData=0,
                                                    dwFlags=MOUSEINPUT.MOVE,
                                                    time=0, dwExtraInfo=None)))


def measure(struct, n=400, pace=0.02):
    ref = ctypes.byref(struct)
    ts = []
    for _ in range(n):
        t0 = time.perf_counter()
        SendInput(1, ref, SZ)
        ts.append(time.perf_counter() - t0)
        time.sleep(pace)
    return stats(ts)


class Siblings:
    """The two daemon threads ipc_main.py runs alongside playback."""

    def __init__(self, on):
        self.on = on
        self.stop = threading.Event()

    def __enter__(self):
        if not self.on:
            return self

        def progress():
            while not self.stop.is_set():
                json.dumps({"event": "progress", "elapsed": time.perf_counter(),
                            "played": 0, "focus_lost": False,
                            "user_paused": False, "frozen_elapsed": None,
                            "base_time_perf": 0.0}, separators=(",", ":"))
                time.sleep(0.05)

        def focus():
            u32 = ctypes.WinDLL("user32")
            while not self.stop.is_set():
                u32.GetForegroundWindow()
                time.sleep(0.025)

        for fn, name in ((progress, "progress"), (focus, "focus-monitor")):
            threading.Thread(target=fn, daemon=True, name=name).start()
        time.sleep(0.2)
        return self

    def __exit__(self, *_):
        self.stop.set()
        time.sleep(0.1)
        return False


def row(label, s):
    print("  %-46s mean %7.4f p50 %7.4f p95 %7.4f p99 %7.4f max %8.4f"
          % (label, s["mean"], s["p50"], s["p95"], s["p99"], s["max"]))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--n", type=int, default=400)
    p.add_argument("--json", default="")
    a = p.parse_args()
    out = {"sizeof_input": SZ, "switch_interval_default": sys.getswitchinterval()}

    print("\n=== 1. keyboard vs mouse injection (hook chain) ===")
    out["key_down_alone"] = measure(KEY_DOWN, a.n)
    row("SendInput keyboard down", out["key_down_alone"])
    out["key_up_alone"] = measure(KEY_UP, a.n)
    row("SendInput keyboard up", out["key_up_alone"])
    out["mouse_alone"] = measure(MOUSE_NUDGE, a.n)
    row("SendInput mouse move dx=0 dy=0", out["mouse_alone"])

    print("\n=== 2. GIL re-acquisition against the app's sibling threads ===")
    with Siblings(False):
        out["key_no_siblings"] = measure(KEY_DOWN, a.n)
    row("keyboard down, no sibling threads", out["key_no_siblings"])
    with Siblings(True):
        out["key_with_siblings"] = measure(KEY_DOWN, a.n)
    row("keyboard down, progress + focus threads", out["key_with_siblings"])
    old = sys.getswitchinterval()
    sys.setswitchinterval(0.0005)
    with Siblings(True):
        out["key_with_siblings_fast_switch"] = measure(KEY_DOWN, a.n)
    row("keyboard down, siblings, switchinterval 0.5ms",
        out["key_with_siblings_fast_switch"])
    sys.setswitchinterval(old)

    print("\n=== 3. our own GlobalHotKeys low-level hook ===")
    out["key_no_hotkeys"] = measure(KEY_DOWN, a.n)
    row("keyboard down, no GlobalHotKeys", out["key_no_hotkeys"])
    hk = GlobalHotKeys({"<f13>": lambda: None, "<f14>": lambda: None,
                        "<f15>": lambda: None})
    hk.start()
    hk.wait()
    time.sleep(0.3)
    out["key_with_hotkeys"] = measure(KEY_DOWN, a.n)
    hk.stop()
    row("keyboard down, GlobalHotKeys running", out["key_with_hotkeys"])

    if a.json:
        Path(a.json).write_text(json.dumps(out, indent=2), encoding="utf-8")
        print("\nwrote " + a.json)
    return 0


if __name__ == "__main__":
    sys.exit(main())
