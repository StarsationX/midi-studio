"""Self-check for sustain mode in playback_loop. Run: python test_sustain.py"""
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import midi_player as mp


class FakeKb:
    def __init__(self):
        self.log = []
    def press(self, k):
        self.log.append(("down", k))
    def release(self, k):
        self.log.append(("up", k))


def run(events, sustain):
    state = mp.State(len(events), max(t + d for t, _, d, _, _ in events), 120)
    kb = FakeKb()
    mp.playback_loop(events, state, kb, 0.0, None, False, sustain)
    return kb.log


def test_live_tempo():
    import ipc_main as ipc

    events = [(0, "q", 0.4, 60, 0), (0.6, "w", 1, 62, 0),
              (0.9, "e", 1, 64, 0)]
    state = mp.State(len(events), 2, 120)
    bridge = ipc.Bridge.__new__(ipc.Bridge)  # no global hotkeys or real keyboard
    bridge.session_state = state
    kb = FakeKb()
    now = 10.0
    changed = None

    def sleep(dt):
        nonlocal now, changed
        now += dt
        if changed is None and now >= 10.1:
            changed = now
            assert kb.log == [("down", "q")]
            bridge.cmd_set_tempo({"tempo": 2})

    with patch.object(mp.time, "perf_counter", lambda: now), \
         patch.object(mp.time, "sleep", sleep), patch.object(mp, "_SPIN_THRESHOLD", 0):
        mp.playback_loop(events, state, kb, 0, None, False, True, end_at=0.8)
        assert kb.log == [("down", "q"), ("up", "q"), ("down", "w"), ("up", "w")]
        assert state.played_count == 2
        assert abs(now - (changed + (0.8 - (changed - 10)) / 2)) < 1e-8

        state.set_user_paused(True)
        state.freeze()
        now += 5
        bridge.cmd_set_tempo({"tempo": 0.5})
        assert not state.pause_event.is_set()
        assert abs(state.frozen_elapsed - 0.8) < 1e-8
        bridge.cmd_seek({"time": 1.2})
        assert state.seek_request == 0.6
        snapshots = []
        state.stop_event.clear()
        with patch.object(ipc, "emit", snapshots.append), \
             patch.object(mp.time, "sleep", lambda _: state.stop_event.set()):
            bridge._progress_loop(state)
        assert snapshots[0]["elapsed"] == snapshots[0]["frozen_elapsed"] == 1.6
        assert snapshots[0]["tempo"] == 0.5


def test_chord_deadline_at_double_speed():
    now = 10.0
    attacks = []
    class Keyboard(FakeKb):
        def press(self, key):
            attacks.append((key, now))

    def sleep(dt):
        nonlocal now
        now += dt

    events = [(1.0, key, 0.2, pitch, 0) for key, pitch in (("q", 60), ("w", 64), ("e", 67))]
    state = mp.State(len(events), 1.2, 120)
    state.set_tempo(2)
    with patch.object(mp.time, "perf_counter", lambda: now), \
         patch.object(mp.time, "sleep", sleep), patch.object(mp, "_SPIN_THRESHOLD", 0):
        mp.playback_loop(events, state, Keyboard(), 0.001, None, False, False, inject_cost=0.002)
    assert [key for key, _ in attacks] == ["q", "w", "e"]
    # Score second 1 at 2× falls at wall second 0.5. Subtract the 1ms
    # latency and 2ms mean serial chord delay in wall time, not score time.
    assert all(abs(t - 10.497) < 1e-8 for _, t in attacks), attacks


def main():
    events = [
        (0.00, "q", 0.50, 60, 0),   # long note
        (0.20, "w", 0.05, 62, 0),   # short note while q held
        (0.30, "q", 0.30, 60, 0),   # retrigger q while still held
    ]

    log = run(events, sustain=True)
    q_downs = [i for i, e in enumerate(log) if e == ("down", "q")]
    q_ups = [i for i, e in enumerate(log) if e == ("up", "q")]
    assert log[0] == ("down", "q"), log
    assert len(q_downs) == 2 and len(q_ups) == 2, log
    # retrigger releases the held key BEFORE the fresh press
    assert q_ups[0] < q_downs[1], log
    # final ring-out: last event is releasing the retriggered q
    assert log[-1] == ("up", "q"), log
    # w was pressed and released while q was held
    assert ("down", "w") in log and ("up", "w") in log, log

    # tap mode unchanged: press immediately followed by release
    log = run(events, sustain=False)
    assert log == [("down", "q"), ("up", "q"), ("down", "w"), ("up", "w"),
                   ("down", "q"), ("up", "q")], log

    test_live_tempo()
    test_chord_deadline_at_double_speed()
    print("sustain self-check OK")


if __name__ == "__main__":
    main()
