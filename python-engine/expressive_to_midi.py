"""Forge entry point for a full song arranged as two-hand solo piano."""
import json
import io
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import numpy as np
import mido
import pretty_midi
import soundfile as sf

import song_to_midi as forge
from audio_utils import audio_window_from_env
from expressive_arrange import arrange, bass_notes
from forge_vocals import transcribe_vocals, vocal_model


def _sum_stems(stems, out):
    """Mix the backing in blocks so long or multichannel songs stay bounded."""
    from contextlib import ExitStack

    with ExitStack() as stack:
        tracks = [stack.enter_context(sf.SoundFile(path)) for path in stems]
        rate = tracks[0].samplerate
        length = tracks[0].frames
        if any((track.samplerate, track.frames) != (rate, length) for track in tracks):
            raise RuntimeError("Separated instruments are not on the same audio timeline.")
        with sf.SoundFile(out, "w", rate, 1, subtype="FLOAT") as target:
            for start in range(0, length, rate):
                block = sum(track.read(rate, dtype="float32", always_2d=True).mean(axis=1)
                            for track in tracks)
                target.write(block / len(tracks))


def _separate(src, work):
    backing = work / "backing.wav"
    if forge._resolve_backend() == "onnx_dml":
        import separate_onnx_dml as mdx

        if not forge.ONNX_MDX_MODEL.is_file() or not forge.ONNX_DRUMS_MODEL.is_file():
            raise RuntimeError("DirectML separation requires locally installed instrumental and drum models.")
        vocals = work / "vocals.wav"
        mdx.separate_vocals_backing(src, vocals, backing, forge.ONNX_MDX_MODEL, forge.ONNX_DRUMS_MODEL)
        return vocals, backing, None, None

    folder = forge.run_separation(src, work, stage_marker="[2/6]")
    stems = {p.stem.rsplit("_", 1)[-1].lower(): p for p in folder.rglob("*.wav")}
    required = {"vocals", "bass", "piano", "guitar", "other"}
    missing = required.difference(stems)
    if missing:
        raise RuntimeError(f"Separation did not return the expected stems: {', '.join(sorted(missing))}.")
    _sum_stems([stems[name] for name in ("piano", "guitar", "other")], backing)
    return stems["vocals"], backing, stems["bass"], stems.get("drums")


def _onset_envelope(path):
    """Positive spectral changes on a 10 ms clock, with bounded audio buffers."""
    from scipy.fft import next_fast_len, rfft

    envelope = []
    with sf.SoundFile(path) as reader:
        rate = reader.samplerate
        hop = max(1, round(rate / 100))
        width = hop * 4
        window = np.hanning(width).astype(np.float32)
        fft = next_fast_len(width)
        carry = np.zeros(width - hop, np.float32)
        previous = np.zeros(fft // 2 + 1, np.float32)
        for block in reader.blocks(blocksize=400 * hop, dtype="float32", always_2d=True):
            wave = np.concatenate((carry, block.mean(axis=1)))
            if len(wave) < width:
                break
            frames = np.lib.stride_tricks.sliding_window_view(wave, width)[::hop]
            spectrum = np.log1p(abs(rfft(frames * window, n=fft)) * (100. / width))
            rise = np.diff(spectrum, axis=0, prepend=previous[None, :]).clip(min=0)
            envelope.extend(rise.mean(axis=1))
            previous = spectrum[-1]
            carry = wave[-(width - hop):]
    return np.asarray(envelope), rate / hop


def _pulse_scores(window, frames_per_second, bpms):
    from scipy.signal import correlate

    centered = window - np.mean(window)
    corr = correlate(centered, centered, mode="full", method="fft")[len(window) - 1:]
    if not len(corr) or corr[0] < 1e-11:
        return np.zeros_like(bpms)
    corr /= corr[0]
    lags = 60 * frames_per_second / bpms
    indices = np.arange(len(corr))
    # A single autocorrelation peak has many half/double-time interpretations.
    # Longer lags also give finer tempo resolution than a single 10 ms frame.
    return sum(weight * np.interp(n * lags, indices, corr, right=0)
               for n, weight in ((1, .36), (2, .29), (4, .23), (8, .12)))


def _tempo_map(path, fallback=None):
    envelope, fps = _onset_envelope(path)
    if len(envelope) < 4 * fps or np.max(envelope) < .00012:
        return _tempo_map(fallback) if fallback is not None else [(0., 120.)]
    candidates = np.arange(48., 212.1, .25)
    # Prefer familiar quarter-note pulse levels when several periodicities fit.
    prior = np.exp(-.16 * np.log2(candidates / 118.) ** 2)
    duration = len(envelope) / fps
    radius = min(6., duration / 2)
    times = np.arange(radius, max(radius, duration - radius) + .01, 1.)
    estimates = []
    for t in times:
        window = envelope[round((t - radius) * fps):round((t + radius) * fps)]
        scores = _pulse_scores(window, fps, candidates) * prior
        best = np.argmax(scores)
        if scores[best] >= .16:
            estimates.append((t, candidates[best]))
    if not estimates:
        return _tempo_map(fallback) if fallback is not None else [(0., 120.)]

    # Ignore short interruptions (drum breaks, fills, isolated octave errors).
    runs = []
    for t, bpm in estimates:
        if not runs or abs(np.log2(bpm / np.median(runs[-1][1][-5:]))) > .048:
            runs.append(([], []))
        runs[-1][0].append(t)
        runs[-1][1].append(bpm)
    stable = [run for run in runs if len(run[0]) >= min(5, len(times))]
    if not stable:
        values = max(runs, key=lambda run: len(run[0]))[1]
        if len(values) < min(3, len(times)):
            return _tempo_map(fallback) if fallback is not None else [(0., 120.)]
        return [(0., float(np.median(values)))]

    sections = []
    for centers, values in stable:
        bpm = float(np.median(values))
        if sections:
            previous = sections[-1][1]
            bpm *= 2. ** round(np.log2(previous / bpm))
            if abs(np.log2(previous / bpm)) < .043:
                sections[-1][2] = centers[-1]
                continue
            # Classify both periodicities around the transition with a short
            # aperture. Only place a change when both sections have support.
            approach = max(sections[-1][2] - 3., centers[0] - 8.)
            depart = min(centers[0] + 3., duration - 1.)
            probes = np.arange(max(1., approach), depart, .15)
            differences = []
            for t in probes:
                short = envelope[max(0, round((t - 2.) * fps)):round((t + 2.) * fps)]
                old, new = _pulse_scores(short, fps, np.array([previous, bpm]))
                differences.append(old - new)
            start = float(probes[np.argmax(np.cumsum(differences))]) if len(probes) else centers[0]
        else:
            start = 0.
        sections.append([start, bpm, centers[-1]])
    return [(start, bpm) for start, bpm, _ in sections]


def _apply_tempo_map(midi, changes):
    """Encode the map first and retain the original source seconds on every note."""
    if len(changes) == 1:
        return midi
    conductor = mido.MidiFile(ticks_per_beat=midi.resolution)
    track = conductor.add_track()
    previous_time = 0.
    previous_tempo = mido.bpm2tempo(changes[0][1])
    for seconds, bpm in changes:
        ticks = round(mido.second2tick(seconds - previous_time, midi.resolution, previous_tempo))
        previous_time += mido.tick2second(ticks, midi.resolution, previous_tempo)
        previous_tempo = mido.bpm2tempo(bpm)
        track.append(mido.MetaMessage("set_tempo", tempo=previous_tempo, time=ticks))
    buffer = io.BytesIO()
    conductor.save(file=buffer)
    buffer.seek(0)
    timed = pretty_midi.PrettyMIDI(buffer)
    timed.instruments = midi.instruments
    return timed


def _publish(midi, requested):
    """Publish a complete file under an unused name, even when jobs overlap."""
    with tempfile.TemporaryDirectory(prefix=".forge-midi-", dir=requested.parent) as scratch:
        complete = Path(scratch) / "arrangement.mid"
        midi.write(str(complete))
        for n in range(1, 10001):
            path = requested if n == 1 else requested.with_stem(f"{requested.stem} ({n})")
            if path.with_suffix(".midstudio.json").exists():
                continue
            try:
                if os.name == "nt":
                    # Windows rename fails atomically when the destination exists.
                    complete.rename(path)
                else:
                    os.link(complete, path)
                return path
            except FileExistsError:
                continue
        raise RuntimeError(f"No unused export name is available for {requested.name}.")


def main():
    if len(sys.argv) != 3:
        raise ValueError("Usage: expressive_to_midi.py INPUT OUTPUT.mid")
    source, requested = (Path(p).resolve() for p in sys.argv[1:])
    if not source.is_file():
        raise FileNotFoundError(f"Input audio was not found: {source}")
    if requested.suffix.lower() != ".mid":
        raise ValueError("The output must have a .mid extension.")
    requested.parent.mkdir(parents=True, exist_ok=True)
    print(f"Input: {source}", flush=True)
    print("[1/6] Prepare vocal model", flush=True)
    model = vocal_model(forge.MODELS_BASE)
    root = Path(os.environ.get("MIDI_STUDIO_FORGE_ENV_DIR") or tempfile.gettempdir()) / "work"
    root.mkdir(parents=True, exist_ok=True)
    # One isolated workspace per run, including two simultaneous jobs on one file.
    work = Path(tempfile.mkdtemp(prefix="expressive-", dir=root))
    try:
        audio = audio_window_from_env(source, work)
        print("[2/6] Separate vocals and backing", flush=True)
        vocals, backing, bass, drums = _separate(audio, work)
        duration = sf.info(backing).duration
        if duration <= 0:
            raise RuntimeError("Selected audio has no samples.")

        print("[3/6] Detect vocal melody", flush=True)
        lead_notes = transcribe_vocals(vocals, model)
        print(f"Detected {len(lead_notes)} vocal notes.", flush=True)

        print("[4/6] Transcribe accompaniment", flush=True)
        notes = []
        with sf.SoundFile(backing) as file:
            has_backing = any(np.max(np.abs(block)) >= .001
                              for block in file.blocks(blocksize=65536, dtype="float32"))
        if has_backing:
            raw_midi = work / "backing.mid"
            forge.transcribe_to_midi(backing, raw_midi, stage_marker="[4/6]")
            notes = [n for i in pretty_midi.PrettyMIDI(str(raw_midi)).instruments
                     for n in i.notes if 0 <= n.start < duration]
            for note in notes:
                note.end = min(duration, note.end)
        bass_line = bass_notes(bass) if bass is not None else None

        print("[5/6] Voice the piano arrangement", flush=True)
        changes = _tempo_map(drums, fallback=backing) if drums else _tempo_map(backing)
        midi = arrange(lead_notes, notes, bass_line, duration, changes[0][1])
        midi = _apply_tempo_map(midi, changes)
        print("Tempo guide: " + ", ".join(f"{bpm:.2f} BPM at {t:.2f}s" for t, bpm in changes), flush=True)
        count = sum(len(track.notes) for track in midi.instruments)
        if not count:
            raise RuntimeError("No playable notes were detected in the selected audio.")

        print("[6/6] Save piano MIDI", flush=True)
        output = _publish(midi, requested)
    finally:
        forge.cleanup_work(work)
    result = {
        "midiPath": str(output),
        "candidates": {"clean": str(output)},
        "candidateCounts": {"clean": count},
        "sourceAudio": str(source),
        "channelNames": {str(i): t.name for i, t in enumerate(midi.instruments)},
    }
    print("RESULT|" + json.dumps(result), flush=True)
    print("DONE", flush=True)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"Error: {exc}", file=sys.stderr, flush=True)
        sys.exit(1)
