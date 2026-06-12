"""drums_to_midi.py — Drums pipeline: separate -> drum stem -> classified drum MIDI.

Stage [1/3] separation reuses song_to_midi.run_separation (BS-Roformer 6-stem),
stage [2/3] onset-detects the drum stem and classifies each hit by band energy
(kick / snare / closed & open hat / toms / crash / ride), stage [3/3] writes a
General-MIDI drum track (channel 10 notes: 36/38/42/46/41/45/48/49/51).

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

ONSET_DELTA = float(os.environ.get("ONSET_DELTA", "0.07"))
MIN_GAP_MS = int(os.environ.get("DRUM_MIN_GAP_MS", "50"))
SKIP_SEP = os.environ.get("SKIP_SEPARATION", "0") in ("1", "true", "True", "yes")

# GM drum notes
KICK, SNARE, CHAT, OHAT = 36, 38, 42, 46
TOM_LO, TOM_MID, TOM_HI = 41, 45, 48
CRASH, RIDE = 49, 51


def band_energy(S, freqs, lo, hi):
    m = (freqs >= lo) & (freqs < hi)
    return S[m].sum(axis=0) if m.any() else np.zeros(S.shape[1])


def classify_hits(wav: Path):
    import librosa
    y, sr = librosa.load(str(wav), sr=22050, mono=True)
    hop = 256
    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=hop)) ** 2
    freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)

    sub = band_energy(S, freqs, 20, 110)       # kick body
    low = band_energy(S, freqs, 110, 300)      # snare/tom body
    mid = band_energy(S, freqs, 300, 1200)     # tom/snare crack
    hi  = band_energy(S, freqs, 3500, 10500)   # hats/cymbals

    env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    onsets = librosa.onset.onset_detect(onset_envelope=env, sr=sr, hop_length=hop,
                                        delta=ONSET_DELTA, backtrack=False, units="frames")
    times = librosa.frames_to_time(onsets, sr=sr, hop_length=hop)
    n_frames = S.shape[1]
    p95 = {k: np.percentile(v, 95) + 1e-9 for k, v in
           {"sub": sub, "low": low, "mid": mid, "hi": hi}.items()}

    hits = []  # (t, note, velocity 0-1)
    for f, t in zip(onsets, times):
        a, b = f, min(f + 6, n_frames)          # ~70 ms analysis window
        e_sub = sub[a:b].max() / p95["sub"]
        e_low = low[a:b].max() / p95["low"]
        e_mid = mid[a:b].max() / p95["mid"]
        e_hi  = hi[a:b].max()  / p95["hi"]
        # cymbal decay: high band still ringing ~180 ms later?
        c = min(f + 16, n_frames - 1)
        ring = (hi[c] / (hi[a:b].max() + 1e-9)) if b > a else 0.0
        strength = float(np.clip(env[f] / (np.percentile(env, 95) + 1e-9), 0.15, 1.0))

        labels = []
        if e_sub > 0.5 and e_sub >= e_low:
            labels.append(KICK)
        if e_low > 0.45 and e_mid > 0.35 and e_hi > 0.2:
            labels.append(SNARE)
        elif e_low > 0.55 and e_mid > 0.3 and e_hi <= 0.2:   # pitched body, no crack = tom
            labels.append(TOM_MID if e_mid >= e_low * 0.6 else TOM_LO)
        if e_hi > 0.4:
            if ring > 0.5 and e_hi > 0.7:
                labels.append(CRASH if e_mid > 0.25 else RIDE)
            else:
                labels.append(OHAT if ring > 0.3 else CHAT)
        if not labels:                                        # quiet/ambiguous -> hat tick
            labels.append(CHAT)
        for note in labels[:2]:                               # cap 2 voices per onset
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

    if SKIP_SEP:
        print("\n[1/3] Separation skipped (input is already a drum stem)")
        drum_wav = src
    else:
        from song_to_midi import run_separation, safe_name
        work_dir = src.parent / "stems" / safe_name(src.stem)
        work_dir.mkdir(parents=True, exist_ok=True)
        out_dir = run_separation(src, work_dir)
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

    out_midi = src.with_suffix(".mid")
    print(f"\n[3/3] Cleaning MIDI (writing drum track)")
    write_midi(hits, out_midi)
    print(f"\nDONE.\n  Stem: {drum_wav}\n  MIDI:       {out_midi}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
