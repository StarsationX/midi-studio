"""Print Medley's key profiles for the bundled Grand Piano (developer-only: numpy, soundfile).

Fit integrated power, not single peaks: a velocity has to work for short strikes
and for held notes. This script is not part of Forge or the installer.
"""
import base64
import io
import re
from pathlib import Path

import numpy as np
import soundfile as sf

BANK = Path(__file__).resolve().parents[1] / 'renderer/soundfonts/FluidR3_GM/acoustic_grand_piano-mp3.js'
RATE = 44100
WINDOWS = np.array([0.065, 0.125, 0.25, 0.5, 1.0, 2.0])
RATES = np.arange(0.4, 24.0, 0.1)
# Integral of a unit-power key with exponential decay.
ENERGY = -np.expm1(-RATES[:, None] * WINDOWS) / RATES[:, None]


def load_bank():
    bank = {}
    for letter, sharp, octave, data in re.findall(r'"([A-G])(#?)(-?\d+)"\s*:\s*"data:audio/[^;]+;base64,([^"\s]+)"', BANK.read_text()):
        pitch = 12 * (int(octave) + 1) + 'C D EF G A B'.index(letter) + bool(sharp)
        wave, rate = sf.read(io.BytesIO(base64.b64decode(data, validate=True)), dtype='float32', always_2d=True)
        if rate != RATE:
            raise ValueError(f'{pitch}: expected {RATE} Hz, got {rate}')
        bank[pitch] = wave
    return bank


def profile(bank, pitch):
    key = min(bank, key=lambda p: (abs(p - pitch), p))
    wave = bank[key]
    if pitch != key:
        pos = np.arange(0, len(wave) - 1, 2 ** ((pitch - key) / 12))
        frames = np.arange(len(wave))
        wave = np.column_stack([np.interp(pos, frames, channel) for channel in wave.T]).astype('float32')
    mono = wave.mean(axis=1).astype('float64')
    attack = round(0.004 * RATE)
    mono[:attack] *= np.linspace(0, 1, attack)
    blocks = mono[:len(mono) // 128 * 128].reshape(-1, 128)
    ends = np.clip(np.rint(WINDOWS * RATE / 128).astype(int), 1, len(blocks)) - 1
    total = np.cumsum(np.mean(blocks ** 2, axis=1))[ends]
    low = np.cumsum(blocks.mean(axis=1) ** 2)[ends]
    offsets = np.log(total * (128 / RATE) / ENERGY)
    levels = offsets.mean(axis=1)
    best = ((offsets - levels[:, None]) ** 2).mean(axis=1).argmin()
    return np.exp(levels[best]), RATES[best], (low / total).mean()


if __name__ == '__main__':
    bank = load_bank()
    profiles = np.array([profile(bank, pitch) for pitch in range(21, 109)])
    profiles[:, 0] /= np.median(profiles[:, 0])
    for i in range(0, len(profiles), 6):
        print('    ' + ', '.join('(%.3f, %.1f, %.3f)' % tuple(row) for row in profiles[i:i + 6]) + ',')
