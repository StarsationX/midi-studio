"""Diff a forge-rs run against a py_reference.py run.

    python capped.py compare.py <py_dir> <rs_dir> [--json out.json]

Both dirs hold notes.json + a .mid, and optionally the --dump intermediates.
Prints note-level agreement (count, pitch, velocity, onset/offset ms),
MIDI byte equality, and per-tensor max abs / max rel differences.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np


def load_notes(d):
    return json.load(open(Path(d) / "notes.json"))["notes"]


def match_notes(a, b):
    """Pair notes by order (both are sorted by (start, end, pitch))."""
    rows = []
    for x, y in zip(a, b):
        rows.append((x, y))
    return rows


def tensor_diffs(py, rs):
    out = {}
    names = sorted(p.stem for p in Path(py).glob("*.npy"))
    for n in names:
        q = Path(rs) / f"{n}.npy"
        if not q.exists():
            continue
        a = np.load(Path(py) / f"{n}.npy", mmap_mode="r")
        b = np.load(q, mmap_mode="r")
        if a.shape != b.shape:
            out[n] = {"shape_py": list(a.shape), "shape_rs": list(b.shape)}
            continue
        a64 = np.asarray(a, dtype=np.float64)
        b64 = np.asarray(b, dtype=np.float64)
        d = np.abs(a64 - b64)
        scale = max(float(np.abs(a64).max()), 1e-30)
        out[n] = {"max_abs": float(d.max()), "max_rel_to_scale": float(d.max() / scale),
                  "n_diff": int((d > 0).sum()), "n": int(d.size)}
    paths = sorted(p.name for p in Path(py).glob("seg*_paths.json"))
    for n in paths:
        q = Path(rs) / n
        if q.exists():
            pa, pb = json.load(open(Path(py) / n)), json.load(open(q))
            out[n] = {"identical": pa == pb,
                      "n_intervals_py": sum(len(x) for x in pa["paths"]),
                      "n_intervals_rs": sum(len(x) for x in pb["paths"])}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("py_dir")
    ap.add_argument("rs_dir")
    ap.add_argument("--py-mid", default="ref.mid")
    ap.add_argument("--rs-mid", default="out.mid")
    ap.add_argument("--json")
    a = ap.parse_args()
    pn, rn = load_notes(a.py_dir), load_notes(a.rs_dir)
    res = {"n_py": len(pn), "n_rs": len(rn)}
    rows = match_notes(pn, rn)
    pitch_ok = all(x["pitch"] == y["pitch"] for x, y in rows)
    vel = [abs(x["velocity"] - y["velocity"]) for x, y in rows]
    on = [abs(x["start"] - y["start"]) * 1e3 for x, y in rows]
    off = [abs(x["end"] - y["end"]) * 1e3 for x, y in rows]
    flags = all(x["hasOnset"] == y["hasOnset"] and x["hasOffset"] == y["hasOffset"] for x, y in rows)
    res.update({
        "same_count": len(pn) == len(rn), "pitch_identical": pitch_ok, "flags_identical": flags,
        "max_velocity_diff": max(vel, default=0), "n_velocity_diff": sum(v > 0 for v in vel),
        "max_onset_diff_ms": max(on, default=0.0), "max_offset_diff_ms": max(off, default=0.0),
        "n_exact_start_end": sum(x["start"] == y["start"] and x["end"] == y["end"] for x, y in rows),
    })
    pm, rm = Path(a.py_dir) / a.py_mid, Path(a.rs_dir) / a.rs_mid
    if pm.exists() and rm.exists():
        res["midi_bytes_identical"] = pm.read_bytes() == rm.read_bytes()
    res["tensors"] = tensor_diffs(a.py_dir, a.rs_dir)
    for k, v in res.items():
        if k != "tensors":
            print(f"{k:22s} {v}")
    for k, v in res["tensors"].items():
        print(f"  {k:24s} {v}")
    if a.json:
        json.dump(res, open(a.json, "w"), indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
