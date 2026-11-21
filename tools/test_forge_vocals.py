"""Audio-grounded regressions for Expressive Piano vocal timing."""
from pathlib import Path
import sys
import unittest

import numpy as np
import pretty_midi

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python-engine"))
from forge_vocals import RATE, _align_phrase_attacks, _join_windows


def note(key, start, end):
    return pretty_midi.Note(80, key, start, end)


def sing(parts, duration=1.2, vibrato=0):
    t = np.arange(round(duration * RATE)) / RATE
    frequency = np.full_like(t, 220.)
    gain = np.zeros_like(t)
    for key, start, end, level in parts:
        active = (t >= start) & (t < end)
        pitch = key + vibrato * np.sin(2 * np.pi * 5.7 * t[active])
        frequency[active] = 440 * np.exp2((pitch - 69) / 12)
        gain[active] = level * np.clip((t[active] - start) / .006, 0, 1)
    phase = 2 * np.pi * np.cumsum(frequency) / RATE
    return ((np.sin(phase) + .35 * np.sin(2 * phase)) * gain).astype(np.float32)


class VocalTimingTests(unittest.TestCase):
    def test_late_pitch_change_advances_without_delaying_sung_consonants(self):
        wave = sing([(62, .12, .42, .19), (65, .42, .69, .22), (64, .69, .99, .16)])
        ns = [note(62, .12, .46), note(65, .46, .65), note(64, .65, .99)]
        _align_phrase_attacks(wave, ns)
        np.testing.assert_allclose([n.start for n in ns], [.12, .42, .65], atol=.016)
        self.assertEqual([n.end for n in ns[:-1]], [n.start for n in ns[1:]])

    def test_clip_start_inside_sounding_note_and_blank_clip(self):
        wave = sing([(60, 0., .46, .22)])
        wave = wave[round(.03 * RATE):]
        ns = [note(60, .060, .42)]
        _align_phrase_attacks(wave, ns)
        self.assertEqual(ns[0].start, 0.)
        quiet = [note(60, .060, .42)]
        _align_phrase_attacks(np.zeros(RATE, dtype=np.float32), quiet)
        self.assertEqual(quiet[0].start, .060)

    def test_repeated_syllable_requires_a_release_and_reattack(self):
        wave = sing([(64, .12, .46, .16), (64, .49, 1., .16)])
        ns = [note(64, .12, .534), note(64, .534, 1.)]
        _align_phrase_attacks(wave, ns)
        self.assertAlmostEqual(ns[1].start, .493, delta=.016)
        wave = sing([(64, .12, 1., .16)], vibrato=.4)
        ns = [note(64, .12, .534), note(64, .534, 1.)]
        _align_phrase_attacks(wave, ns)
        self.assertEqual(ns[1].start, .534)
        self.assertEqual(len(ns), 2)

    def test_stable_phrase_pickup_and_separate_loudness(self):
        wave = sing([(68, .30, .405, .16), (69, .405, .66, .3), (72, .74, 1., .05)])
        ns = [note(69, .385, .66), note(72, .74, 1.)]
        _align_phrase_attacks(wave, ns)
        self.assertEqual([n.pitch for n in ns], [68, 69, 72])
        np.testing.assert_allclose([n.start for n in ns], [.30, .405, .74], atol=.016)
        self.assertGreater(ns[1].velocity, ns[0].velocity)
        self.assertGreater(ns[0].velocity, ns[2].velocity)

    def test_noise_before_vowel_and_vibrato_do_not_spawn_pickups(self):
        wave = sing([(69, .4, .91, .2)], vibrato=.58)
        noise = np.random.default_rng(7).normal(0., .23, round(RATE * .08))
        wave[round(.29 * RATE):round(.29 * RATE) + len(noise)] = noise
        ns = [note(69, .427, .91)]
        _align_phrase_attacks(wave, ns)
        self.assertEqual(len(ns), 1)
        self.assertGreaterEqual(ns[0].start, .38)
        self.assertLessEqual(ns[0].start, .428)

    def test_late_overlap_and_early_overlap_do_not_drop_the_boundary_syllable(self):
        for a, b in [(12.02, 11.98), (11.98, 12.02)]:
            old = [note(60, 11.5, a), note(64, a, 12.3)]
            new = [note(60, 11.49, b), note(64, b, 12.32), note(60, 12.33, 12.6)]
            joined = _join_windows(old, new, 12.)
            self.assertEqual([n.pitch for n in joined], [60, 64, 60])
            self.assertTrue(all(x.end <= y.start for x, y in zip(joined, joined[1:])))
            self.assertEqual(joined[-1].end, 12.6)

    def test_held_note_across_both_window_edges_is_kept_once(self):
        old, new = [note(65, 4., 15.)], [note(65, 9., 21.)]
        joined = _join_windows(old, new, 12.)
        self.assertEqual([(n.start, n.end) for n in joined], [(4., 21.)])


if __name__ == "__main__":
    unittest.main()
