import os
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent
FFMPEG_SHARED_BIN = str(ROOT / "ffmpeg" / "ffmpeg-master-latest-win64-lgpl-shared" / "bin")
if Path(FFMPEG_SHARED_BIN).exists():
    os.environ["PATH"] = FFMPEG_SHARED_BIN + os.pathsep + os.environ.get("PATH", "")
    os.add_dll_directory(FFMPEG_SHARED_BIN)

import librosa
import librosa.display
import numpy as np
import pretty_midi
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches


def find_piano_stem(mp3_path: Path) -> Path | None:
    candidate = mp3_path.parent / "stems" / mp3_path.stem / "stems" / mp3_path.stem / "piano.wav"
    if candidate.exists():
        return candidate
    matches = list((mp3_path.parent / "stems" / mp3_path.stem).rglob("piano.wav"))
    return matches[0] if matches else None


def main() -> int:
    if len(sys.argv) < 3:
        print("Usage: analyze.py <original.mp3> <output.mid> [piano.wav]")
        return 1
    mp3 = Path(sys.argv[1]).resolve()
    midi = Path(sys.argv[2]).resolve()
    piano = Path(sys.argv[3]).resolve() if len(sys.argv) > 3 else find_piano_stem(mp3)
    if piano is None or not piano.exists():
        print("Could not locate piano.wav stem; please pass it as 3rd arg.")
        return 1

    print(f"Loading MIDI:        {midi.name}")
    print(f"Loading piano stem:  {piano.name}")
    print(f"Loading original:    {mp3.name}")

    pm = pretty_midi.PrettyMIDI(str(midi))
    total_notes = sum(len(i.notes) for i in pm.instruments)
    midi_dur = pm.get_end_time()

    y_piano, sr = librosa.load(str(piano), sr=22050, mono=True)
    y_orig, _ = librosa.load(str(mp3), sr=22050, mono=True)

    duration = max(midi_dur, len(y_piano) / sr, len(y_orig) / sr)
    print(f"\nMIDI notes: {total_notes}   MIDI dur: {midi_dur:.1f}s   audio dur: {len(y_piano)/sr:.1f}s")

    bucket_s = 1.0
    n = int(np.ceil(duration / bucket_s))
    bucket_t = np.arange(n) * bucket_s

    midi_density = np.zeros(n)
    for inst in pm.instruments:
        for note in inst.notes:
            i = int(note.start / bucket_s)
            if 0 <= i < n:
                midi_density[i] += 1

    hop = 512
    rms_piano = librosa.feature.rms(y=y_piano, hop_length=hop)[0]
    rms_orig = librosa.feature.rms(y=y_orig, hop_length=hop)[0]
    t_rms = librosa.frames_to_time(np.arange(len(rms_piano)), sr=sr, hop_length=hop)

    piano_buckets = np.zeros(n)
    orig_buckets = np.zeros(n)
    for i, t in enumerate(t_rms):
        b = int(t / bucket_s)
        if 0 <= b < n:
            piano_buckets[b] = max(piano_buckets[b], rms_piano[i])
            orig_buckets[b] = max(orig_buckets[b], rms_orig[i])

    p_norm = piano_buckets / max(piano_buckets.max(), 1e-9)
    m_norm = midi_density / max(midi_density.max(), 1)
    o_norm = orig_buckets / max(orig_buckets.max(), 1e-9)

    gap_mask = (p_norm > 0.30) & (m_norm < 0.10)
    gaps: list[tuple[int, int]] = []
    i = 0
    while i < n:
        if gap_mask[i]:
            j = i
            while j + 1 < n and (gap_mask[j + 1] or (j + 1 - i) < 2 and gap_mask[j + 1]):
                j += 1
            while j + 1 < n and gap_mask[j + 1]:
                j += 1
            gaps.append((i, j))
            i = j + 1
        else:
            i += 1
    gaps = [(s, e) for s, e in gaps if (e - s + 1) >= 2]

    print("\n=== Drop-out regions (piano stem audible, MIDI sparse) ===")
    if not gaps:
        print("  none detected at threshold (RMS>0.30 norm, density<0.10 norm)")
    else:
        for s, e in gaps:
            mm_s, ss_s = divmod(s, 60)
            mm_e, ss_e = divmod(e, 60)
            print(f"  {mm_s:02d}:{ss_s:02d} - {mm_e:02d}:{ss_e:02d}  (len {e-s+1}s)")

    fig, axes = plt.subplots(3, 1, figsize=(15, 9), sharex=True)

    ax = axes[0]
    for inst in pm.instruments:
        for note in inst.notes:
            ax.add_patch(mpatches.Rectangle((note.start, note.pitch - 0.4), note.end - note.start, 0.8,
                                            color="steelblue", linewidth=0))
    ax.set_ylim(20, 109)
    ax.set_xlim(0, duration)
    ax.set_ylabel("MIDI pitch")
    ax.set_title(f"MIDI piano roll ({total_notes} notes)")
    for s, e in gaps:
        ax.axvspan(s, e + 1, color="red", alpha=0.15)

    ax = axes[1]
    D = librosa.amplitude_to_db(np.abs(librosa.stft(y_piano, hop_length=hop)), ref=np.max)
    librosa.display.specshow(D, sr=sr, hop_length=hop, x_axis="time", y_axis="log", ax=ax, cmap="magma")
    ax.set_title("Piano stem spectrogram (log freq)")
    ax.set_ylabel("Hz")
    for s, e in gaps:
        ax.axvspan(s, e + 1, color="red", alpha=0.20)

    ax = axes[2]
    ax.plot(bucket_t, o_norm, label="Original mix RMS", color="gray", alpha=0.5)
    ax.plot(bucket_t, p_norm, label="Piano stem RMS", color="orange")
    ax.plot(bucket_t, m_norm, label="MIDI note density", color="steelblue")
    for s, e in gaps:
        ax.axvspan(s, e + 1, color="red", alpha=0.15)
    ax.set_xlabel("Time (s)")
    ax.set_ylabel("Normalized")
    ax.set_title("MIDI density vs piano stem energy (red = drop-outs)")
    ax.legend(loc="upper right")
    ax.set_xlim(0, duration)

    plt.tight_layout()
    out_png = midi.with_name(midi.stem + "_analysis.png")
    plt.savefig(out_png, dpi=120)
    print(f"\nVisualization saved: {out_png}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
