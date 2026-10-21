"""Render a MIDI file to a piano-ish WAV with a small additive synth.

    python make_fixture.py <in.mid | --demo out.mid> <out.wav> [--sr 44100]
        [--channels 1] [--start 0] [--dur 20]

Not a real piano, but every note has a hammer-like attack, inharmonic
partials and a pitch-dependent decay, which is enough for Transkun to give a
stable, note-rich transcription to compare implementations on. `--demo`
writes a short built-in progression (melody + arpeggio + bass + sustain
pedal) as the source MIDI instead of reading one.
"""
import argparse
import sys

import numpy as np
import pretty_midi
import soundfile as sf


def demo_midi(path):
    pm = pretty_midi.PrettyMIDI(resolution=480, initial_tempo=100.0)
    inst = pretty_midi.Instrument(program=0)
    beat = 60.0 / 100.0
    chords = [(48, [60, 64, 67]), (43, [59, 62, 67]), (45, [60, 64, 69]), (41, [60, 65, 69])]
    melody = [72, 74, 76, 79, 77, 76, 74, 72, 71, 72, 74, 76, 72, 69, 71, 72]
    t = 0.0
    for bar, (bass, triad) in enumerate(chords * 1):
        inst.notes.append(pretty_midi.Note(70, bass, t, t + 4 * beat * 0.95))
        for k in range(8):
            p = triad[k % 3] + (12 if k >= 6 else 0)
            v = 50 + 6 * (k % 4)
            inst.notes.append(pretty_midi.Note(v, p, t + k * beat / 2, t + (k + 1) * beat / 2 * 0.9))
        for k in range(4):
            p = melody[(bar * 4 + k) % len(melody)]
            inst.notes.append(pretty_midi.Note(85 - 4 * k, p, t + k * beat, t + (k + 0.8) * beat))
        inst.control_changes.append(pretty_midi.ControlChange(64, 100, t + 0.05))
        inst.control_changes.append(pretty_midi.ControlChange(64, 0, t + 4 * beat - 0.1))
        t += 4 * beat
    inst.notes.append(pretty_midi.Note(90, 84, t, t + 1.2))
    inst.notes.append(pretty_midi.Note(80, 36, t, t + 1.4))
    pm.instruments.append(inst)
    pm.write(path)
    return pm


def render(pm, sr, channels, start, dur):
    n = int(round(dur * sr))
    out = np.zeros((n, channels), dtype=np.float64)
    rng = np.random.default_rng(1234)
    notes = [nt for i in pm.instruments if not i.is_drum for nt in i.notes]
    for nt in notes:
        s, e = nt.start - start, nt.end - start
        if e <= 0 or s >= dur:
            continue
        f0 = 440.0 * 2.0 ** ((nt.pitch - 69) / 12.0)
        vel = nt.velocity / 127.0
        tail = 0.12
        length = min(e + tail, dur) - max(s, 0.0)
        i0 = int(round(max(s, 0.0) * sr))
        m = int(round(length * sr))
        if m <= 0:
            continue
        t = (np.arange(m) / sr) + max(0.0, -s)
        held = (e - max(s, 0.0))
        base_tau = float(np.clip(4.0 * 2.0 ** (-(nt.pitch - 48) / 18.0), 0.25, 6.0))
        sig = np.zeros(m)
        B = 0.00012 * 2.0 ** ((nt.pitch - 60) / 24.0)
        for k in range(1, 16):
            fk = k * f0 * np.sqrt(1.0 + B * k * k)
            if fk > 0.45 * sr or fk > 9000:
                break
            amp = (1.0 / k ** 1.1) * vel ** (0.25 * (k - 1))
            tau = base_tau / (1.0 + 0.35 * (k - 1))
            ph = rng.uniform(0, 2 * np.pi)
            sig += amp * np.exp(-t / tau) * np.sin(2 * np.pi * fk * t + ph)
        attack = np.minimum(1.0, t / 0.003)
        rel = np.where(t < held, 1.0, np.exp(-(t - held) / 0.06))
        noise = rng.standard_normal(m) * np.exp(-t / 0.01) * 0.05
        sig = (sig * attack + noise) * rel * vel ** 1.5 * 0.2
        pan = np.clip((nt.pitch - 21) / 87.0, 0.0, 1.0)
        gains = [1.0] if channels == 1 else [np.cos(pan * np.pi / 2) * 1.2, np.sin(pan * np.pi / 2) * 1.2]
        for c in range(channels):
            out[i0:i0 + m, c] += sig[: n - i0] * gains[c] if i0 + m > n else sig * gains[c]
    peak = np.abs(out).max()
    if peak > 0:
        out *= 0.89 / peak
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("out")
    ap.add_argument("--demo", action="store_true", help="write the built-in demo MIDI to src first")
    ap.add_argument("--sr", type=int, default=44100)
    ap.add_argument("--channels", type=int, default=1)
    ap.add_argument("--start", type=float, default=0.0)
    ap.add_argument("--dur", type=float, default=None)
    a = ap.parse_args()
    pm = demo_midi(a.src) if a.demo else pretty_midi.PrettyMIDI(a.src)
    dur = a.dur if a.dur is not None else pm.get_end_time() - a.start + 0.5
    audio = render(pm, a.sr, a.channels, a.start, dur)
    sf.write(a.out, audio if a.channels > 1 else audio[:, 0], a.sr, subtype="PCM_16")
    print(f"{a.out}: {dur:.2f}s @ {a.sr} Hz x{a.channels}")


if __name__ == "__main__":
    sys.exit(main())
