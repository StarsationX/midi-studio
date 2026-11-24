"""Compare two piano reductions against the same recording-aligned MIDI onsets."""
import argparse
from collections import defaultdict
import json
from pathlib import Path

import mido


def read_onsets(path, offset, start, end):
    times = defaultdict(list)
    elapsed = offset
    for msg in mido.MidiFile(path):
        elapsed += msg.time  # Mido merges tracks and applies the file's tempo changes.
        if elapsed >= end:
            break
        if (elapsed >= start and msg.type == 'note_on' and msg.velocity > 0
                and msg.channel != 9):
            times[msg.note].append(elapsed)
    return times


def compare(reference, generated, tolerance):
    hits = 0
    for key, ref in reference.items():
        got = generated.get(key, ())
        i = j = 0
        # Pair the earliest feasible onsets. For one pitch on a single clock,
        # exchanging a crossing pair never reduces the number of feasible pairs.
        while i < len(ref) and j < len(got):
            delta = got[j] - ref[i]
            if delta < -tolerance:
                j += 1
            elif delta > tolerance:
                i += 1
            else:
                hits += 1
                i += 1
                j += 1
    expected = sum(map(len, reference.values()))
    produced = sum(map(len, generated.values()))
    return {'matched': hits, 'extras': produced - hits, 'missed': expected - hits,
            'precision': round(hits / produced, 4) if produced else None,
            'recall': round(hits / expected, 4) if expected else None,
            'f1': round(2 * hits / (expected + produced), 4) if expected + produced else None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('reference', 'before', 'after'):
        parser.add_argument(name, type=Path)
    parser.add_argument('--start', type=float, default=0, help='inclusive source seconds')
    parser.add_argument('--end', type=float, required=True, help='exclusive source seconds')
    parser.add_argument('--reference-offset', type=float, default=0, help='source time minus score time')
    parser.add_argument('--clip-offset', type=float, default=0, help='source time at both outputs’ time zero')
    parser.add_argument('--tolerance-ms', type=float, default=50)
    args = parser.parse_args()
    if not args.end > args.start or not args.tolerance_ms >= 0:
        parser.error('require end > start and nonnegative tolerance')
    ref = read_onsets(args.reference, args.reference_offset, args.start, args.end)
    report = {name: compare(ref, read_onsets(getattr(args, name), args.clip_offset, args.start, args.end),
                            args.tolerance_ms / 1000) for name in ('before', 'after')}
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
