"""Regenerate forge-rs/tests/fixtures from the real Python implementations.

    python capped.py make_test_fixtures.py [--e2e REF_DIR]

Model-free fixtures (always):
  crf_score.npy / crf_noise.npy / crf_expected.json
        transkun.CRF.viterbiBackward on a small random problem
  soxr_in.npy / soxr_out_*.npy
        soxr.resample (HQ) of a deterministic stereo signal, 48k->44.1k and
        16k->44.1k (mono)
  midi_notes.json / midi_expected.mid / midi_clean_expected.mid
        transkun.Data.writeMidi -> pretty_midi bytes, then transcribe.clean_midi
With --e2e REF_DIR (a py_reference.py output dir for demo_16k.wav):
  demo_16k.expected.json / demo_16k.expected.mid
"""
import argparse
import json
import shutil
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
FIX = HERE.parent / "tests" / "fixtures"
REPO = HERE.parent.parent


def crf():
    import torch
    from transkun.CRF.NeuralSemiCRFInterval import viterbiBackward
    g = torch.Generator().manual_seed(7)
    T, B = 48, 6
    score = torch.randn(T, T, B, generator=g) * 3 - 1.0
    # a few strong intervals so paths are non-trivial
    for b in range(B):
        for s, e in ((2, 9), (12, 20), (25, 26), (30, 44)):
            score[e, s + b % 3, b] += 25.0
    # exact ties between skip and interval paths exercise first-max semantics
    score[10, 10, 0] = 0.0
    noise = torch.zeros(T - 1, B)
    forced = [0, 3, 5, 0, 11, 2]
    out = {"T": T, "B": B, "forced": forced,
           "with_forced": viterbiBackward(score, noise, forced),
           "no_forced": viterbiBackward(score, noise, None)}
    np.save(FIX / "crf_score.npy", score.numpy().astype(np.float32))
    np.save(FIX / "crf_noise.npy", noise.numpy().astype(np.float32))
    json.dump(out, open(FIX / "crf_expected.json", "w"))


def soxr_fixture():
    import soxr
    rng = np.random.default_rng(3)
    n = 12000
    t = np.arange(n) / 48000.0
    x = np.stack([0.4 * np.sin(2 * np.pi * 440 * t) + 0.05 * rng.standard_normal(n),
                  0.3 * np.sin(2 * np.pi * 1234.5 * t) + 0.05 * rng.standard_normal(n)], axis=1)
    x = x.astype(np.float32)
    np.save(FIX / "soxr_in.npy", x)
    np.save(FIX / "soxr_out_48k_st.npy", soxr.resample(x, 48000, 44100))
    np.save(FIX / "soxr_out_16k_mono.npy", soxr.resample(np.ascontiguousarray(x[:, :1]), 16000, 44100))


def midi_fixture():
    sys.path.insert(0, str(REPO / "python-engine"))
    from transkun.Data import Note, writeMidi
    import transcribe as app_tr
    rng = np.random.default_rng(11)
    notes = []
    for i in range(120):
        p = int(rng.integers(21, 109))
        s = float(rng.uniform(0, 20))
        d = float(rng.choice([0.0002, 0.01, 0.0299, 0.03, 0.2, 1.5]))
        v = int(rng.integers(0, 128))
        notes.append(Note(s, s + d, p, v))
    # pedals, an exact half-tick start (banker's rounding), a note ending
    # where the same pitch restarts, pitch 108 / 21 edges, out-of-range pitch
    notes += [Note(0.5, 4.0, -64, 100), Note(4.5, 9.25, -64, 70), Note(1.0, 2.0, -67, 40),
              Note(0.5 * 60 / (120 * 960) * 3, 0.9, 60, 64), Note(3.0, 3.5, 72, 90),
              Note(3.5, 4.0, 72, 91), Note(5.0, 5.2, 108, 30), Note(6.0, 6.1, 21, 30),
              Note(7.0, 7.4, 110, 50), Note(0.0, 0.25, 64, 19)]
    notes.sort(key=lambda x: (x.start, x.end, x.pitch))
    # mimic resolveOverlapping's guarantee (no same-pitch overlap)
    last = {}
    for n in notes:
        if n.pitch in last and last[n.pitch].end > n.start:
            last[n.pitch].end = n.start
        last[n.pitch] = n
    notes = [n for n in notes if n.start < n.end]
    notes.sort(key=lambda x: (x.start, x.end, x.pitch))
    json.dump({"notes": [dict(start=n.start, end=n.end, pitch=n.pitch, velocity=n.velocity,
                              hasOnset=True, hasOffset=True) for n in notes]},
              open(FIX / "midi_notes.json", "w"))
    writeMidi(notes).write(str(FIX / "midi_expected.mid"))
    shutil.copyfile(FIX / "midi_expected.mid", FIX / "midi_clean_expected.mid")
    before, after = app_tr.clean_midi(FIX / "midi_clean_expected.mid")
    print(f"midi fixture: {len(notes)} notes, clean {before} -> {after}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--e2e")
    a = ap.parse_args()
    FIX.mkdir(parents=True, exist_ok=True)
    crf()
    soxr_fixture()
    midi_fixture()
    if a.e2e:
        d = Path(a.e2e)
        shutil.copyfile(d / "notes.json", FIX / "demo_16k.expected.json")
        shutil.copyfile(d / "ref.mid", FIX / "demo_16k.expected.mid")
    for p in sorted(FIX.iterdir()):
        print(f"{p.name:32s} {p.stat().st_size:8d}")


if __name__ == "__main__":
    main()
