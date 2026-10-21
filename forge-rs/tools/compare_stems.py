"""Per-stem parity of two MSST-layout stem folders (reference vs candidate).

    python compare_stems.py REF_DIR CAND_DIR [--json OUT]

Both dirs hold <instr>.wav (searched recursively). Prints, per stem, the max
absolute sample difference and the SDR of the candidate against the
reference: 10 log10(sum ref^2 / sum (ref - cand)^2).
"""
import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf


def stems(d):
    return {p.stem: p for p in sorted(Path(d).rglob("*.wav"))}


def main():
    ref, cand = stems(sys.argv[1]), stems(sys.argv[2])
    rows = []
    for name, rp in ref.items():
        if name not in cand:
            print(f"{name:10s} MISSING in candidate")
            continue
        a, sra = sf.read(str(rp), dtype="float32", always_2d=True)
        b, srb = sf.read(str(cand[name]), dtype="float32", always_2d=True)
        assert sra == srb and a.shape == b.shape, (name, a.shape, b.shape, sra, srb)
        a64, d64 = a.astype(np.float64), (a.astype(np.float64) - b.astype(np.float64))
        err = float((d64 ** 2).sum())
        sdr = float("inf") if err == 0 else 10 * np.log10((a64 ** 2).sum() / err)
        row = {"stem": name, "max_abs_diff": float(np.abs(d64).max()), "sdr_db": sdr,
               "ref_peak": float(np.abs(a).max()), "ref_rms": float(np.sqrt((a64 ** 2).mean())),
               "samples": int(a.shape[0]), "identical": int((a == b).sum()), "total": int(a.size)}
        rows.append(row)
        print(f"{name:10s} max|diff| {row['max_abs_diff']:.3e}  SDR {sdr:7.2f} dB  "
              f"(ref peak {row['ref_peak']:.3f} rms {row['ref_rms']:.4f}, "
              f"{row['identical']}/{row['total']} bit-identical)")
    if "--json" in sys.argv:
        json.dump(rows, open(sys.argv[sys.argv.index("--json") + 1], "w"), indent=1)


if __name__ == "__main__":
    main()
