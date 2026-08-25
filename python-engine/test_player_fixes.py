"""Self-checks for the playback fixes. Run: python test_player_fixes.py"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import midi_document
import midi_player


def test_octave_fold():
    mapping = {n: chr(97 + (n % 26)) for n in range(36, 97)}
    resolve = midi_player.make_resolver(mapping)
    assert resolve(60) == mapping[60], "in-range note must not move"
    assert resolve(24) == mapping[36], "a note below the mapping folds up an octave"
    assert resolve(12) == mapping[36], "two octaves below folds up two"
    assert resolve(108) == mapping[96], "a note above the mapping folds down"
    assert midi_player.make_resolver(mapping, fold=False)(24) is None, \
        "fold=False keeps the old drop-it behaviour"


def test_unmapped_pitch_class_still_unmapped():
    # White-only layout: nothing anywhere plays C#, so folding must not invent one.
    white = {n: str(n) for n in range(36, 97) if n % 12 in (0, 2, 4, 5, 7, 9, 11)}
    resolve = midi_player.make_resolver(white)
    assert resolve(61) is None, "no key for this pitch class in any octave"
    assert resolve(24) == white[36], "but naturals still fold"


def test_bpm_estimate_beats_the_120_default():
    # 16ths at 174 BPM. Reported tempo used to be a flat 120 for every
    # transcription, which put the editor's quantize grid on the wrong beat.
    step = 60.0 / 174.0 / 4.0
    starts = [i * step for i in range(64)]
    assert abs(midi_document._bpm_from_onsets(starts, 120.0) - 174.0) < 2.0
    assert midi_document._bpm_from_onsets([0.0, 1.0], 120.0) == 120.0, \
        "too few onsets to guess from: keep the fallback"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
    print("all player fix checks passed")
