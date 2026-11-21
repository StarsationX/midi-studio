"""Pinned GAME vocal note inference for Expressive Piano."""
import hashlib
import os
import shutil
import tempfile
import urllib.request
import zipfile
from math import ceil
from pathlib import Path

import numpy as np
import onnxruntime as ort
import pretty_midi
import soundfile as sf
import soxr
from scipy.fft import irfft, rfft
from scipy.ndimage import gaussian_filter1d


RELEASE = "GAME-1.0.3-medium-onnx"
MODEL_URL = f"https://github.com/openvpi/GAME/releases/download/v1.0.3/{RELEASE}.zip"
MODEL_SIZE = 179775226
MODEL_SHA256 = "5b7a21e64c6310efac399f5d12838fffa70565be162436b5a4a65f290721e7d8"
MODELS = {
    "encoder": 40809108,
    "segmenter": 80703699,
    "estimator": 74457404,
    "bd2dur": 4569,
    "dur2bd": 2632,
}
RATE = 44100


def _ready(directory: Path) -> bool:
    return all((directory / f"{name}.onnx").is_file()
               and (directory / f"{name}.onnx").stat().st_size == size
               for name, size in MODELS.items())


def vocal_model(models_base: Path) -> Path:
    """Download and verify once. Other jobs only see the completed directory."""
    cache = models_base / "game"
    directory = cache / RELEASE
    if _ready(directory):
        return directory

    cache.mkdir(parents=True, exist_ok=True)
    try:
        with tempfile.TemporaryDirectory(prefix=".game-", dir=cache) as scratch:
            work = Path(scratch)
            archive = work / "model.zip"
            digest = hashlib.sha256()
            received = 0
            next_report = 10
            print("Downloading the vocal model (180 MB, first run only).", flush=True)
            req = urllib.request.Request(MODEL_URL, headers={"User-Agent": "MIDI-Studio"})
            with urllib.request.urlopen(req, timeout=45) as response, archive.open("wb") as out:
                for block in iter(lambda: response.read(1 << 20), b""):
                    received += len(block)
                    if received > MODEL_SIZE:
                        raise ValueError("unexpected vocal model download size")
                    digest.update(block)
                    out.write(block)
                    percent = received * 100 // MODEL_SIZE
                    if percent >= next_report:
                        print(f"Vocal model download: {percent}%", flush=True)
                        next_report += 10
            if received != MODEL_SIZE or digest.hexdigest() != MODEL_SHA256:
                raise ValueError("vocal model download failed its integrity check")
            staged = work / RELEASE
            staged.mkdir()
            with zipfile.ZipFile(archive) as bundle:
                for name, size in MODELS.items():
                    filename = f"{name}.onnx"
                    member = bundle.getinfo(f"{RELEASE}/{filename}")
                    if member.file_size != size:
                        raise ValueError(f"unexpected size for {filename}")
                    with bundle.open(member) as src, (staged / filename).open("wb") as dst:
                        shutil.copyfileobj(src, dst)
            # Repair missing or truncated cached files after an interrupted install.
            # Each replacement is atomic and every racing installer has the same bytes.
            directory.mkdir(exist_ok=True)
            for file in staged.iterdir():
                dest = directory / file.name
                if not dest.is_file() or dest.stat().st_size != file.stat().st_size:
                    file.replace(dest)
    except (OSError, ValueError, KeyError, zipfile.BadZipFile) as exc:
        if not _ready(directory):
            raise RuntimeError(f"Could not prepare the GAME vocal model in {cache}: {exc}") from exc
    return directory


class Game:
    """Run the official ONNX segmentation and pitch-estimation graphs."""
    def __init__(self, directory: Path, threads: int):
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        options.log_severity_level = 3
        self.sessions = {
            name: ort.InferenceSession(str(directory / f"{name}.onnx"), options,
                                       providers=["CPUExecutionProvider"])
            for name in MODELS
        }

    def _run(self, name, **inputs):
        session = self.sessions[name]
        return session.run(None, {key.name: inputs[key.name] for key in session.get_inputs()})

    def notes(self, samples):
        length = np.array([len(samples) / RATE], dtype=np.float32)
        segmentation, estimation, frame_mask = self._run(
            "encoder", waveform=samples[None, :], duration=length)
        known, = self._run("dur2bd", durations=length[:, None], maskT=frame_mask)
        known = known & frame_mask
        boundaries = known
        for step in np.linspace(0, 1, 6, endpoint=False, dtype=np.float32):
            boundaries, = self._run(
                "segmenter", x_seg=segmentation, language=np.array([0], dtype=np.int64),
                known_boundaries=known, prev_boundaries=boundaries,
                t=np.array([step], dtype=np.float32), maskT=frame_mask,
                threshold=np.array(.23, dtype=np.float32), radius=np.array(2, dtype=np.int64),
            )
        durations, note_mask = self._run("bd2dur", boundaries=boundaries, maskT=frame_mask)
        voiced, pitches = self._run(
            "estimator", x_est=estimation, boundaries=boundaries, maskT=frame_mask,
            maskN=note_mask, threshold=np.array(.21, dtype=np.float32),
        )
        edges = np.r_[0., np.cumsum(durations[0], dtype=np.float64)]
        return zip(edges[:-1], edges[1:], voiced[0], pitches[0], strict=True)


def _vocal_frames(wave):
    """Measure level and reliable periodic pitch every 5 ms on centered windows."""
    rate, hop, width = 12000, 60, 480
    audio = soxr.resample(wave, RATE, rate)
    windows = np.lib.stride_tricks.sliding_window_view(np.pad(audio, (width // 2, width // 2)), width)[::hop]
    centers = windows[:, width // 4:3 * width // 4]
    rms = np.sqrt(np.einsum("ij,ij->i", centers, centers) / centers.shape[1])
    pitch = np.full(len(windows), np.nan, dtype=np.float32)
    # McLeod & Wyvill's normalized square difference function. A high, isolated
    # periodic peak serves as a second opinion when the note model is uncertain.
    lags = np.arange(7, 194)
    for first in range(0, len(windows), 512):
        frames = windows[first:first + 512]
        centered = frames - frames.mean(axis=1, keepdims=True)
        spectrum = rfft(centered, n=1024, axis=1)
        corr = irfft(spectrum.real ** 2 + spectrum.imag ** 2, n=1024, axis=1)[:, lags]
        energy = np.pad(np.cumsum(centered ** 2, axis=1), ((0, 0), (1, 0)))
        pairs = energy[:, width - lags] + energy[:, -1:] - energy[:, lags]
        clarity = 2 * corr / np.maximum(pairs, 1e-8)
        middle = clarity[:, 1:-1]
        peaks = (middle > clarity[:, :-2]) & (middle >= clarity[:, 2:])
        strength = np.max(np.where(peaks, middle, 0.), axis=1)
        usable = (strength >= .85) & (rms[first:first + len(frames)] >= .001)
        rows = np.flatnonzero(usable)
        selected = np.argmax(peaks[rows] & (middle[rows] >= .94 * strength[rows, None]), axis=1) + 1
        a, b, c = (clarity[rows, selected + delta] for delta in (-1, 0, 1))
        offset = np.clip(.5 * (a - c) / np.minimum(a - 2 * b + c, -1e-8), -.5, .5)
        pitch[first + rows] = 69 + 12 * np.log2(rate / ((lags[selected] + offset) * 440))
    return gaussian_filter1d(rms, .85), pitch


def _pitch_boundary(pitches, center, old, new, radius):
    """Require two short plateaus on either side of a distinct transition."""
    lo = max(0, center - radius - 8)
    hi = min(len(pitches), center + radius + 9)
    local = pitches[lo:hi]
    if len(local) < 16:
        return None
    # A single excursion of vibrato or a slow scoop lacks two stable plateaus.
    windows = np.lib.stride_tricks.sliding_window_view(local, 7)
    old_ends = np.flatnonzero(np.all(np.abs(windows - old) < .42, axis=1)) + 6
    new_starts = np.flatnonzero(np.all(np.abs(windows - new) < .42, axis=1))
    pairs = []
    for right in new_starts:
        left = np.searchsorted(old_ends, right) - 1
        if left >= 0 and right - old_ends[left] <= 5:
            boundary = lo + (old_ends[left] + right) / 2
            if abs(boundary - center) <= radius:
                pairs.append(boundary)
    return min(pairs, key=lambda point: abs(point - center), default=None)


def _align_phrase_attacks(wave, notes):
    """Use local vocal evidence to refine attacks and the singer's dynamics."""
    if not notes:
        return
    rms, pitches = _vocal_frames(wave)
    step = .005
    additions = []
    for i, note in enumerate(notes):
        last_end = notes[i - 1].end if i else 0.
        frame = round(note.start / step)
        if i and note.start - last_end <= .025:
            previous = notes[i - 1]
            if previous.pitch != note.pitch:
                edge = _pitch_boundary(pitches, frame, previous.pitch, note.pitch, 11)
                # The pitch of a new vowel often settles after the syllable has
                # already started. Only move a boundary later across a real
                # release in energy, or the piano itself will sound late.
                if edge is not None and edge > frame:
                    k = round(edge)
                    near = rms[max(0, k - 6):k + 2]
                    after = rms[k + 2:k + 10]
                    if not len(after) or np.min(near) >= .50 * np.median(after):
                        edge = None
            else:
                # A rearticulated pitch has a local drop and renewed energy.
                lo = max(round(previous.start / step) + 8, frame - 15, 0)
                hi = min(round(note.end / step) - 9, frame + 7, len(rms) - 10)
                edge = None
                if hi > lo:
                    dip = lo + np.argmin(rms[lo:hi + 1])
                    flank = min(np.median(rms[dip - 8:dip - 3]), np.median(rms[dip + 5:dip + 10]))
                    if rms[dip] < .36 * flank and flank > .004:
                        attack = np.flatnonzero(rms[dip:dip + 9] >= .55 * flank)
                        voiced = np.count_nonzero(np.abs(pitches[dip + 3:dip + 11] - note.pitch) < .45)
                        if len(attack) and voiced >= 5:
                            edge = dip + attack[0]
            if edge is not None and .012 < abs(edge * step - note.start) <= .055:
                start = float(edge * step)
                if previous.pitch != note.pitch:
                    # A pitch transition spans several analysis frames. Keep
                    # some weight on the model's syllable boundary.
                    start = .25 * note.start + .75 * start
                gap = max(note.start - previous.end, 0.)
                if start - gap >= previous.start + .045 and note.end >= start + .045:
                    previous.end, note.start = start - gap, start
            continue
        if i and note.start - last_end < .12:
            continue
        body = rms[frame + 2:min(frame + 18, round(note.end / step) + 1)]
        if len(body) < 3:
            continue
        level = float(np.quantile(body, .65))
        if not i and .015 < note.start <= .12 and level > .004:
            # A selection may begin during a sounding vowel with no preceding
            # silence. Preserve an audible note at the exact selection boundary.
            opening = pitches[2:max(6, frame)]
            if (np.min(rms[:4]) >= .55 * level and
                    np.all(np.abs(opening - note.pitch) < .4)):
                note.start = 0.
                continue
        search = max(round((last_end + .012) / step), frame - 24, 5)
        quiet = rms[max(0, search - 24):search - 2]
        if not len(quiet):
            continue
        noise = float(np.quantile(quiet, .30))
        if level < max(.006, 3.5 * noise):
            continue
        threshold = max(level * .46, noise * 3.1, .0025)
        for at in range(search, frame):
            if rms[at] < threshold or np.median(rms[at - 4:at]) >= threshold:
                continue
            if np.min(rms[at:at + 5]) < threshold * .70 or np.max(rms[at:at + 11]) < level * .50:
                continue
            # Breath and bleed can cross the energy threshold before the vowel.
            leading = pitches[at + 2:at + 10]
            tonal = leading[np.isfinite(leading)]
            held = pitches[at + 5:min(len(pitches), at + 20)]
            connected = rms[at:min(len(rms), at + 20)]
            pitched_onset = len(tonal) >= 5 and abs(np.median(tonal) - note.pitch) <= 5.4
            # Consonants count as part of a syllable when they lead directly
            # into its pitched body. A detached breath or drum leak falls away.
            joined_consonant = (len(held) >= 6 and np.count_nonzero(np.abs(held - note.pitch) < .6) >= 6
                                and np.min(connected) >= .55 * threshold)
            # Fricatives can be entirely aperiodic. Accept a strong, sustained
            # rise that stays connected to the model's vowel; discard an
            # independent attack separated from it by a quiet interval.
            gap = rms[at + 4:frame + 3] < .40 * threshold
            isolated = len(gap) >= 3 and np.any(gap[:-2] & gap[1:-1] & gap[2:])
            strong_rise = not isolated and np.max(rms[at:at + 11]) >= level * .63
            if pitched_onset or joined_consonant or strong_rise:
                note.start = at * step
                break
        # Recover a short, distinctly pitched pickup at the start of a phrase.
        # Require 65 ms of steady singing followed by a settled model pitch.
        start = round(note.start / step)
        initial = pitches[start + 2:start + 15]
        tonal = initial[np.isfinite(initial)]
        if len(tonal) < 11:
            continue
        pickup = round(float(np.median(tonal)))
        if not 1 <= abs(pickup - note.pitch) <= 5 or np.max(np.abs(tonal - pickup)) > .35:
            continue
        limit = min(round(note.end / step) - 13, start + 38)
        if limit <= start + 15:
            continue
        pivot = (limit + start + 15) // 2
        edge = _pitch_boundary(pitches, pivot, pickup, note.pitch, (limit - start - 15) // 2)
        if edge is not None and np.mean(np.abs(pitches[start + 2:round(edge) - 2] - pickup) < .40) >= .88:
            additions.append(pretty_midi.Note(note.velocity, pickup, note.start, edge * step))
            note.start = edge * step

    if additions:
        notes.extend(additions)
        notes.sort(key=lambda note: note.start)
    levels = []
    for note in notes:
        first = min(round(note.start / step) + 2, len(rms) - 1)
        last = min(len(rms), max(first + 1, round(note.end / step) - 1))
        levels.append(float(np.quantile(rms[first:last], .65)))
    reference = max(.001, float(np.median(levels)))
    for note, level in zip(notes, levels):
        relative_db = 20 * np.log10(max(level, .001) / reference)
        note.velocity = round(80 + float(np.clip(relative_db * .72, -8, 10)))


def _join_windows(notes, incoming, seam):
    """Splice at a syllable recognized by both overlapping model windows."""
    if not notes:
        return incoming
    anchors = []
    for j, right in enumerate(incoming):
        if right.start > seam + 1.8:
            break
        if right.end < seam - 1.8:
            continue
        for i in range(len(notes) - 1, -1, -1):
            left = notes[i]
            if left.end < right.start:
                break
            if left.pitch != right.pitch or abs(left.start - right.start) > .06:
                continue
            if min(left.end, right.end) - max(left.start, right.start) < .035:
                continue
            cost = abs(seam - right.start) + 2 * abs(left.start - right.start)
            anchors.append((cost, i, j))
    if anchors:
        _, i, j = min(anchors)
        # Both windows describe the same note. Keep its well-contextualized attack
        # from the earlier window and its release from the later one.
        incoming[j].start = notes[i].start
        return notes[:i] + incoming[j:]
    old = [note for note in notes if note.start < seam]
    new = [note for note in incoming if note.start >= seam]
    # A held note can fill the entire overlap and start outside the second window.
    if old and old[-1].end > seam:
        sustained = next((n for n in incoming if n.start < seam < n.end and n.pitch == old[-1].pitch), None)
        if sustained is not None:
            old[-1].end = sustained.end
    if old and new:
        old[-1].end = min(old[-1].end, new[0].start)
    return old + new


def transcribe_vocals(path: Path, directory: Path) -> list[pretty_midi.Note]:
    raw, rate = sf.read(path, dtype="float32", always_2d=True)
    wave = raw.mean(axis=1, dtype=np.float32)
    del raw
    if rate != RATE:
        wave = soxr.resample(wave, rate, RATE)
    if not len(wave):
        return []
    peak = float(np.quantile(np.abs(wave[::16]), .995))
    if peak < .001:
        return []
    wave *= min(1.8, .90 / peak)

    threads = max(1, min(8, int(os.environ.get("OMP_NUM_THREADS") or 4)))
    model = Game(directory, threads)
    duration = len(wave) / RATE
    chunk_count = ceil(duration / 12)
    notes = []
    for part in range(chunk_count):
        begin = part * 12
        stop = min(duration, begin + 12)
        first, last = round(max(0., begin - 3) * RATE), round(min(duration, stop + 3) * RATE)
        # Pad a very short extract for the encoder without extending the MIDI.
        samples = wave[first:last]
        if len(samples) < RATE:
            samples = np.pad(samples, (0, RATE - len(samples)))
        incoming = []
        for start, end, voiced, pitch in model.notes(samples):
            start += first / RATE
            end = min(duration, end + first / RATE)
            if not voiced or not 36 <= pitch <= 91 or end - start < .045:
                continue
            incoming.append(pretty_midi.Note(80, int(round(pitch)), float(start), float(end)))
        notes = _join_windows(notes, incoming, begin)
        print(f"Vocal analysis: {part + 1}/{chunk_count}", flush=True)
    _align_phrase_attacks(wave, notes)
    return notes
