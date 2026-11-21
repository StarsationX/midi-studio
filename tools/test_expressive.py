"""Targeted timing, playability and output regressions for Expressive Piano."""
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pretty_midi
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python-engine"))
from expressive_arrange import arrange, bass_notes
from expressive_to_midi import _publish
from forge_vocals import RATE, _align_phrase_attacks


def note(pitch, start, end, velocity=80):
    return pretty_midi.Note(velocity, pitch, start, end)


class ExpressivePianoTests(unittest.TestCase):
    def test_advances_doubted_phrase_attack_from_waveform_only(self):
        t = np.arange(RATE * 2) / RATE
        attack = np.clip((t - .5) / .017, 0, 1)
        attack[t >= 1.0] = 0
        wave = (.3 * np.sin(2 * np.pi * 261.6 * t) * attack).astype(np.float32)
        notes = [note(60, .59, .79), note(62, .79, .99), note(64, 1.48, 1.71)]
        _align_phrase_attacks(wave, notes)
        self.assertLess(abs(notes[0].start - .508), .018)
        self.assertEqual([n.start for n in notes[1:]], [.79, 1.48])

    def test_bass_octave_and_rest(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bass.wav"
            t = np.arange(24000) / 12000
            wave = .2 * np.sin(2 * np.pi * 55 * t) + .1 * np.sin(2 * np.pi * 110 * t)
            wave[(t < .27) | (t > 1.13)] = 0
            sf.write(path, wave, 12000)
            notes = bass_notes(path)
            self.assertEqual([n.pitch for n in notes], [33])
            self.assertLess(abs(notes[0].start - .27), .045)
            self.assertLess(abs(notes[0].end - 1.13), .045)

    def test_repeated_plucked_bass_with_no_pitch_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "plucks.wav"
            t = np.arange(24000) / 12000
            starts = [.18, .51, .84, 1.17]
            envelope = np.zeros_like(t)
            for start in starts:
                age = t - start
                envelope += np.where(age >= 0, .30 * np.exp(-np.maximum(age, 0) / .16), 0)
            envelope[t > 1.5] = 0
            sf.write(path, envelope * np.sin(2 * np.pi * 55 * t), 12000)
            notes = bass_notes(path)
            self.assertEqual([n.pitch for n in notes], [33] * 4)
            np.testing.assert_allclose([n.start for n in notes], starts, atol=.035)

    def test_source_register_and_short_sung_rest(self):
        vocals = [note(48, .1, .4), note(47, 1.10, 1.55), note(89, 1.55, 1.85)]
        backing = [note(p, .65, .9) for p in (56, 63, 68)]
        midi = arrange(vocals, backing, [note(28, .0, .45), note(50, 1.60, 1.86)], 2., 120.)
        melody, left = (i.notes for i in midi.instruments)
        self.assertEqual([(n.pitch, n.start) for n in melody], [(n.pitch, n.start) for n in vocals])
        self.assertTrue(any(n.pitch == 50 and n.start == 1.60 for n in left))

    def test_sustained_harmony_keeps_its_own_releases_across_bass_attacks(self):
        vocals = [note(76, .0, 1.6)]
        backing = [note(60, .1, 1.40), note(64, .1, 1.05), note(67, .1, 1.45)]
        bass = [note(48, 0., .47), note(48, .5, .97), note(48, 1., 1.47)]
        midi = arrange(vocals, backing, bass, 1.6, 120.)
        chord = [n for n in midi.instruments[1].notes if n.start == .1]
        self.assertEqual([(n.pitch, n.end) for n in chord], [(52, 1.05), (55, 1.45)])

    def test_no_low_closed_triad_or_unobserved_harmony(self):
        backing = [note(p, 0., .9) for p in (48, 52, 55)]
        midi = arrange([note(72, 0., .9)], backing, [note(24, 0., .9)], 1., 120.)
        notes = midi.instruments[1].notes
        self.assertEqual([n.pitch for n in notes], [24, 31])

    def test_voice_clock_and_hand_span_with_dense_backing(self):
        vocals = [note(69, .137, .42), note(71, .42, 1.31)]
        backing = [note(p, t, t + .35) for t in np.arange(.10, 1.3, .11)
                   for p in (43, 45, 48, 51, 52, 58, 60, 63, 67, 69, 74)]
        bass = [note(41, 0, .52), note(36, .52, 1.3)]
        midi = arrange(vocals, backing, bass, 1.31, 89.)
        melody, left = (i.notes for i in midi.instruments)
        self.assertEqual([n.start for n in melody], [.137, .42])
        for start in sorted({n.start for n in left}):
            sounding = [n.pitch for n in left if n.start <= start < n.end]
            self.assertLessEqual(len(sounding), 3)
            self.assertLessEqual(max(sounding) - min(sounding), 12)
        self.assertLess(len(left), 13)
        self.assertAlmostEqual(midi.get_tempo_changes()[1][0], 89., places=1)

    def test_export_preserves_existing_midi_and_project(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "Piano.mid"
            output.write_bytes(b"existing MIDI")
            sibling = output.with_name("Piano (2).midstudio.json")
            sibling.write_bytes(b"existing project")
            midi = arrange([note(60, .23, .66)], [], [], .7, 120.)
            published = _publish(midi, output)
            self.assertEqual(published.name, "Piano (3).mid")
            self.assertEqual(output.read_bytes(), b"existing MIDI")
            self.assertEqual(sibling.read_bytes(), b"existing project")
            self.assertEqual(pretty_midi.PrettyMIDI(str(published)).instruments[0].notes[0].pitch, 60)


if __name__ == "__main__":
    unittest.main()
