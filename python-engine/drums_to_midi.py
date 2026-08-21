"""drums_to_midi.py — Drums pipeline: separate -> drum stem -> classified drum MIDI.

Stage [1/3] separation reuses song_to_midi.run_separation (BS-Roformer 6-stem),
stage [2/3] onset-detects the drum stem and classifies each hit by band energy
for the pictured Roblox 8-pad kit, stage [3/3] writes a General-MIDI drum track.

Env knobs:
  SKIP_SEPARATION=1   input is already a drum stem
  ONSET_DELTA         onset sensitivity (default 0.07; lower = more hits)
  DRUM_MIN_GAP_MS     per-class retrigger gap (default 50)
"""
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import numpy as np
from audio_utils import audio_window_from_env

ONSET_DELTA = float(os.environ.get("ONSET_DELTA", "0.07"))
MIN_GAP_MS = int(os.environ.get("DRUM_MIN_GAP_MS", "50"))
SKIP_SEP = os.environ.get("SKIP_SEPARATION", "0") in ("1", "true", "True", "yes")

# GM drum notes. The drums.json preset maps these to the pictured kit:
#   C kick, A snare, W/S hats, H/J/D toms, K cymbals.
KICK, SNARE, CHAT, OHAT = 36, 38, 42, 46
TOM_LO, TOM_MID, TOM_HI = 41, 45, 48
CRASH, RIDE = 49, 51


def band_energy(S, freqs, lo, hi):
    m = (freqs >= lo) & (freqs < hi)
    return S[m].sum(axis=0) if m.any() else np.zeros(S.shape[1])


def _norm(v):
    p = np.percentile(v, 95) + 1e-9
    return v / p


def _frame_peak_freq(S, freqs, a, b, lo, hi):
    m = (freqs >= lo) & (freqs < hi)
    if not m.any() or b <= a:
        return 0.0
    band = S[m, a:b].mean(axis=1)
    return float(freqs[m][int(np.argmax(band))])


def classify_hits(wav: Path):
    import librosa
    y, sr = librosa.load(str(wav), sr=22050, mono=True)
    hop = 256
    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=hop)) ** 2
    freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)

    sub = _norm(band_energy(S, freqs, 25, 115))          # kick body
    low = _norm(band_energy(S, freqs, 115, 260))         # tom/snare body
    body = _norm(band_energy(S, freqs, 260, 900))        # tom tone / snare meat
    crack = _norm(band_energy(S, freqs, 900, 3500))      # snare crack
    metal = _norm(band_energy(S, freqs, 3500, 11500))    # hats/cymbals

    env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    onsets = librosa.onset.onset_detect(onset_envelope=env, sr=sr, hop_length=hop,
                                        delta=ONSET_DELTA, wait=1, pre_max=3,
                                        post_max=3, pre_avg=8, post_avg=8,
                                        backtrack=True, units="frames")
    times = librosa.frames_to_time(onsets, sr=sr, hop_length=hop)
    n_frames = S.shape[1]

    hits = []  # (t, note, velocity 0-1)
    for f, t in zip(onsets, times):
        a, b = f, min(f + 7, n_frames)          # ~80 ms attack window
        e_sub = float(sub[a:b].max())
        e_low = float(low[a:b].max())
        e_body = float(body[a:b].max())
        e_crack = float(crack[a:b].max())
        e_metal = float(metal[a:b].max())
        c = min(f + 18, n_frames - 1)
        ring = float(metal[c] / (metal[a:b].max() + 1e-9)) if b > a else 0.0
        strength = float(np.clip(env[f] / (np.percentile(env, 95) + 1e-9), 0.15, 1.0))

        labels = []
        if e_sub > 0.48 and e_sub > e_low * 0.95 and e_sub > e_metal * 0.55:
            labels.append(KICK)

        snare_score = e_low * 0.55 + e_body * 0.45 + e_crack * 0.65
        tom_score = e_low * 0.65 + e_body * 0.75
        if snare_score > 0.58 and e_crack > 0.32 and e_metal < max(1.15, e_crack * 2.2):
            labels.append(SNARE)
        elif tom_score > 0.62 and e_metal < 0.62 and e_sub < 1.2:
            peak = _frame_peak_freq(S, freqs, a, b, 90, 900)
            if peak and peak < 190:
                labels.append(TOM_LO)       # H
            elif peak and peak < 340:
                labels.append(TOM_MID)      # J
            else:
                labels.append(TOM_HI)       # D

        if e_metal > 0.38 and e_metal > max(e_low, e_body) * 0.9:
            if ring > 0.48 or e_metal > 1.2:
                labels.append(CRASH if e_crack > 0.22 or e_body > 0.25 else RIDE)
            else:
                labels.append(OHAT if ring > 0.24 else CHAT)

        # Quiet/ambiguous transients are usually hat ticks in separated drum stems.
        if not labels and e_metal > 0.18:
            labels.append(CHAT)

        # Keep the physically plausible layers: kick + snare/hat, or snare + hat.
        labels = labels[:2]
        for note in labels:
            hits.append((float(t), note, strength))

    # per-class retrigger gap
    gap = MIN_GAP_MS / 1000.0
    last = {}
    out = []
    for t, note, v in sorted(hits):
        if note in last and t - last[note] < gap:
            continue
        last[note] = t
        out.append((t, note, v))
    return out


def write_midi(hits, out_midi: Path):
    import pretty_midi
    pm = pretty_midi.PrettyMIDI()
    inst = pretty_midi.Instrument(program=0, is_drum=True, name="Drums")
    for t, note, v in hits:
        vel = int(40 + 87 * v)
        inst.notes.append(pretty_midi.Note(velocity=vel, pitch=note, start=t, end=t + 0.1))
    pm.instruments.append(inst)
    pm.write(str(out_midi))


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: drums_to_midi.py <audio_file>")
        return 1
    src = Path(sys.argv[1]).resolve()
    if not src.exists():
        print(f"File not found: {src}")
        return 1
    print(f"Input: {src.name}")
    work_dir = src.parent / "stems" / src.stem
    process_src = audio_window_from_env(src, work_dir)

    if SKIP_SEP:
        print("\n[1/3] Separation skipped (input is already a drum stem)")
        drum_wav = process_src
    else:
        from song_to_midi import run_separation, safe_name
        work_dir = src.parent / "stems" / safe_name(src.stem)
        work_dir.mkdir(parents=True, exist_ok=True)
        out_dir = run_separation(process_src, work_dir)
        cands = [p for p in out_dir.rglob("*drum*.wav") if p.is_file()]
        if not cands:
            listing = "\n  ".join(str(p) for p in out_dir.rglob("*.wav"))
            raise RuntimeError(f"No drum stem found:\n  {listing}")
        drum_wav = cands[0]
        print(f"  using drum stem -> {drum_wav.name}")

    print(f"\n[2/3] Transcribing drums (onset + band classification, delta={ONSET_DELTA})")
    t0 = time.time()
    hits = classify_hits(drum_wav)
    by = {}
    for _, n, _ in hits:
        by[n] = by.get(n, 0) + 1
    names = {36: "kick", 38: "snare", 42: "chat", 46: "ohat", 41: "tomL", 45: "tomM",
             48: "tomH", 49: "crash", 51: "ride"}
    print(f"  {len(hits)} hits in {time.time()-t0:.1f}s — " +
          ", ".join(f"{names.get(k, k)}:{v}" for k, v in sorted(by.items())))

    out_midi = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else src.with_suffix(".mid")
    print(f"\n[3/3] Cleaning MIDI (writing drum track)")
    write_midi(hits, out_midi)
    print(f"\nDONE.\n  Stem: {drum_wav}\n  MIDI:       {out_midi}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
