#!/usr/bin/env python3
"""Self-check for the Player's aim-compensation maths.

Run:  python-engine/python/python.exe python-engine/test_player_timing_fixes.py
Prints "player timing fixes: OK" and exits 0, or asserts.

These guard the two things chord centring relies on that a reader could break
without noticing: the group's aim is the MEAN serial delay (so the chord
straddles the beat instead of trailing or leading it), and the aim can never
be pulled earlier than the previous group can finish injecting.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import midi_player as engine


def ev(t):
    return (t, "a", 0.2, 60, 0)


def close(a, b, tol=1e-9):
    return abs(a - b) < tol


def main():
    c = 0.0016

    # No cost measured -> exactly the behaviour the player shipped with.
    assert engine.chord_aim_shifts([ev(0.0), ev(0.0)], None) == [0.0, 0.0]
    assert engine.chord_aim_shifts([ev(0.0), ev(0.0)], 0.0) == [0.0, 0.0]

    # A single note is never moved. Only chords are wrong, and only chords
    # are compensated.
    s = engine.chord_aim_shifts([ev(0.0), ev(0.5), ev(1.0)], c)
    assert s == [0.0, 0.0, 0.0], s

    # An n-note chord is aimed earlier by the MEAN serial delay,
    # (n-1)/2 * cost, so it straddles the beat: note 0 lands that much early
    # and note n-1 that much late, instead of 0..+(n-1)*cost.
    for n in (2, 4, 8):
        group = [ev(0.001 * k) for k in range(n)] if n <= 3 else \
            [ev(0.0002 * k) for k in range(n)]
        s = engine.chord_aim_shifts(group, c)
        want = (n - 1) * 0.5 * c
        assert all(close(x, want) for x in s), (n, s, want)
        # every member of a chord shares one shift, or they would no longer
        # be simultaneous
        assert len(set(s)) == 1, s

    # Notes further apart than the chord window are separate groups.
    s = engine.chord_aim_shifts([ev(0.0), ev(0.004), ev(0.008)], c)
    assert s == [0.0, 0.0, 0.0], s

    # chord_stagger rolls a chord out beyond the window, so a rolled chord is
    # correctly left alone: the stagger is the user asking for the notes NOT
    # to be simultaneous, and centring it would fight that.
    rolled = [ev(0.0), ev(0.01), ev(0.02), ev(0.03)]
    assert engine.chord_aim_shifts(rolled, c) == [0.0] * 4

    # The clamp: a chord immediately behind another chord may not be aimed
    # before the one in front of it can finish injecting.
    gap = 0.004      # > the 3 ms window, so these are two chords not one
    tight = [ev(0.0), ev(0.0), ev(0.0), ev(0.0),          # 4-note chord at 0
             ev(gap), ev(gap), ev(gap), ev(gap)]          # another 4 ms later
    s = engine.chord_aim_shifts(tight, c)
    first, second = s[0], s[4]
    assert close(first, 1.5 * c), s
    # Unclamped the second group would also want 1.5*c. What it actually gets
    # is the room left after the first group's four injections, never less
    # than zero.
    room = gap - ((0.0 - first) + 4 * c)
    assert close(second, max(0.0, room)), (second, room)
    assert second >= 0.0
    # aims stay in timeline order: group 2 is never aimed before group 1
    assert (gap - second) >= (0.0 - first)
    # ...and the notes still group as TWO chords, not one, at this spacing
    assert len(set(s)) == 2, s

    # Calibration must return the three costs in the order they can only fall
    # in -- isolated press <= back-to-back press <= back-to-back press+release
    # -- or the caller's plausibility clamp silently rejects every real
    # measurement and playback quietly reverts to the old fixed guess.
    if sys.platform == "win32":
        aim, press, tap = engine.calibrate_injection(
            engine.Controller(), burst_samples=8, spaced_samples=4,
            spacing=0.01)
        assert aim is not None and aim > 0, aim
        assert press <= tap, (press, tap)

    print("player timing fixes: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
