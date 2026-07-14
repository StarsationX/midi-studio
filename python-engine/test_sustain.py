"""Self-check for sustain mode in playback_loop. Run: python test_sustain.py"""
import sys
from pathlib import Path

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

    print("sustain self-check OK")


if __name__ == "__main__":
    main()
