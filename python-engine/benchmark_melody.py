"""Score generated melody MIDI files against manually checked references."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from midi_document import load_midi


def score_notes(generated: list[dict], reference: list[dict], tolerance: float) -> dict:
    used = set()
    matches = 0
    timing_error = 0.0
    for expected in reference:
        choices = [
            (abs(note["start"] - expected["start"]), index)
            for index, note in enumerate(generated)
            if index not in used and note["pitch"] == expected["pitch"]
            and abs(note["start"] - expected["start"]) <= tolerance
        ]
        if choices:
            error, index = min(choices)
            used.add(index)
            matches += 1
            timing_error += error
    precision = matches / len(generated) if generated else 0.0
    recall = matches / len(reference) if reference else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {
        "matches": matches,
        "generatedNotes": len(generated),
        "referenceNotes": len(reference),
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "meanOnsetErrorMs": round(1000 * timing_error / matches, 2) if matches else None,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--tolerance", type=float, default=0.08)
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    results = []
    for item in manifest.get("tracks", []):
        generated = load_midi((args.manifest.parent / item["generated"]).resolve())
        reference = load_midi((args.manifest.parent / item["reference"]).resolve())
        result = score_notes(generated["notes"], reference["notes"], args.tolerance)
        result["name"] = item.get("name") or Path(item["generated"]).stem
        results.append(result)
    mean_f1 = sum(item["f1"] for item in results) / len(results) if results else 0.0
    print(json.dumps({"tracks": results, "meanF1": round(mean_f1, 4)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
