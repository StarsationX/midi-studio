"""Verify the conductor track against source pulse changes and clock time."""
import io
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pretty_midi
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python-engine"))
from expressive_to_midi import _apply_tempo_map, _tempo_map


def click_track(segments, rate=8000):
    signal = np.zeros(round(segments[-1][1] * rate), dtype=np.float32)
    click = np.hanning(80) * np.sin(2 * np.pi * np.arange(80) * 1830 / rate)
    start = 0.
    for bpm, end in segments:
        for beat in np.arange(start, end - .02, 60. / bpm):
            offset = round(beat * rate)
            signal[offset:offset + len(click)] += click
        start = end
    return signal


class TempoMapTests(unittest.TestCase):
    def test_changes_are_evidenced_and_keep_note_time(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "change.wav"
            sf.write(path, click_track([(106, 18.), (128, 38.)]), 8000)
            changes = _tempo_map(path)
        self.assertEqual(len(changes), 2)
        self.assertAlmostEqual(changes[0][1], 106., delta=.75)
        self.assertAlmostEqual(changes[1][1], 128., delta=.75)
        self.assertAlmostEqual(changes[1][0], 18., delta=2.)
        midi = pretty_midi.PrettyMIDI(initial_tempo=changes[0][1], resolution=960)
        track = pretty_midi.Instrument(0)
        midi.instruments.append(track)
        source_times = [.583, 17.987, 18.023, 29.051]
        track.notes = [pretty_midi.Note(81, 60 + i, t, t + .23) for i, t in enumerate(source_times)]
        result = io.BytesIO()
        _apply_tempo_map(midi, changes).write(result)
        result.seek(0)
        decoded = pretty_midi.PrettyMIDI(result)
        self.assertEqual(len(decoded.get_tempo_changes()[0]), 2)
        np.testing.assert_allclose([n.start for n in decoded.instruments[0].notes], source_times, atol=.0005)
        np.testing.assert_allclose([n.end for n in decoded.instruments[0].notes], np.array(source_times) + .23, atol=.0005)

    def test_steady_pulse_and_silent_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "steady.wav"
            sf.write(path, click_track([(98., 22.)]), 8000)
            changes = _tempo_map(path)
            self.assertEqual(len(changes), 1)
            self.assertAlmostEqual(changes[0][1], 98., delta=.75)
            silent = Path(tmp) / "silent-drums.wav"
            sf.write(silent, np.zeros(8000 * 7, dtype=np.float32), 8000)
            self.assertEqual(_tempo_map(silent), [(0., 120.)])
            self.assertEqual(_tempo_map(silent, fallback=path), changes)


if __name__ == "__main__":
    unittest.main()
