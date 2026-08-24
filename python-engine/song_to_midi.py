import os
import hashlib
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
# Embeddable Python (launcher / portable bundle) doesn't auto-add the script
# dir to sys.path, so a sibling `import audio_utils` would fail. Add it ourselves.
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
# Provisioned assets (model / MSST / FFmpeg) live in the forge-env dir, not this
# (read-only when packaged) script dir. Resolve a base that actually contains them,
# falling back to ROOT for a co-located dev/source checkout.
def _forge_env_root():
    p = Path(sys.executable).resolve().parent
    return p.parent if p.name.lower() in ("python", "scripts") else p

_ASSET_BASE = _forge_env_root()
if not (_ASSET_BASE / "msst").exists() and (ROOT / "msst").exists():
    _ASSET_BASE = ROOT
MODELS_BASE = Path(os.environ.get("MIDI_STUDIO_MODELS_DIR") or (_ASSET_BASE / "models"))

FFMPEG_SHARED_BIN = str(_ASSET_BASE / "ffmpeg" / "ffmpeg-master-latest-win64-lgpl-shared" / "bin")
if Path(FFMPEG_SHARED_BIN).exists():
    os.environ["PATH"] = FFMPEG_SHARED_BIN + os.pathsep + os.environ.get("PATH", "")
    os.add_dll_directory(FFMPEG_SHARED_BIN)

import pretty_midi
import torch

from audio_utils import audio_window_from_env, expand_velocities, find_python, normalize_wav_in_place

# sys.executable in dev = venv\Scripts\python.exe; in portable bundle = python\python.exe.
PY = find_python()
MSST_DIR = _ASSET_BASE / "msst"
BS_ROFO_DIR = MODELS_BASE / "bs_rofo_sw"
BS_ROFO_YAML = BS_ROFO_DIR / "BS-Rofo-SW-Fixed.yaml"
BS_ROFO_CKPT = BS_ROFO_DIR / "BS-Rofo-SW-Fixed.ckpt"
ONNX_MDX_MODEL = MODELS_BASE / "onnx" / "UVR-MDX-NET-Inst_HQ_3.onnx"
ONNX_DRUMS_MODEL = MODELS_BASE / "onnx" / "kuielab_b_drums.onnx"

# Which separator to use:
#   msst     - BS-Rofo 6-stem piano roformer (SOTA; CUDA, or slow on CPU)
#   onnx_dml - MDX-Net on ONNX Runtime + DirectML (any DX12 GPU, e.g. AMD RX 580)
#   auto     - CUDA -> msst; else DirectML GPU -> onnx_dml; else msst on CPU
SEPARATION_BACKEND = os.environ.get("SEPARATION_BACKEND", "auto").lower()

MIN_NOTE_SEC = float(os.environ.get("MIN_NOTE_SEC", "0.05"))
MIN_VELOCITY = int(os.environ.get("MIN_VELOCITY", "20"))
USE_TTA = os.environ.get("USE_TTA", "0") in ("1", "true", "True", "yes")
BIGSHIFTS = int(os.environ.get("BIGSHIFTS", "1"))
PIANO_MIN_PITCH = int(os.environ.get("PIANO_MIN_PITCH", "21"))   # A0
PIANO_MAX_PITCH = int(os.environ.get("PIANO_MAX_PITCH", "108"))  # C8
SEGMENT_HOP = os.environ.get("SEGMENT_HOP")   # seconds; smaller = more overlap = better recall
SEGMENT_SIZE = os.environ.get("SEGMENT_SIZE")  # seconds; usually keep at default
if SEGMENT_HOP and not SEGMENT_SIZE:
    SEGMENT_SIZE = "16"  # transkun needs both or it crashes; 16s matches its training window
LOUDNESS_NORM = os.environ.get("LOUDNESS_NORM", "1") in ("1", "true", "True", "yes")
TARGET_RMS_DB = float(os.environ.get("TARGET_RMS_DB", "-20.0"))
PEAK_CEILING_DB = float(os.environ.get("PEAK_CEILING_DB", "-1.0"))
VELOCITY_GAMMA = float(os.environ.get("VELOCITY_GAMMA", "0.85"))

# "General" mode: instead of transcribing only the piano stem, mix every pitched
# stem (everything except drums/percussion) and run Transkun on that. For songs
# with no real piano this gives a far closer reduction than basic-pitch, because
# Transkun is a much stronger acoustic model than basic-pitch and separation has
# already stripped the percussion that would otherwise confuse it.
GENERAL_MODE = os.environ.get("GENERAL_MODE", "0") in ("1", "true", "True", "yes")
EXCLUDE_STEMS = [s.strip().lower() for s in
                 os.environ.get("EXCLUDE_STEMS", "drum,percussion").split(",") if s.strip()]
EXCLUDE_VOCALS = os.environ.get("EXCLUDE_VOCALS", "0") in ("1", "true", "True", "yes")
# Cap simultaneous notes (keep loudest per chord) for cleaner piano-key playback.
MAX_POLYPHONY = int(os.environ.get("MAX_POLYPHONY", "0"))


def safe_name(name: str) -> str:
    # MSST discovers input files with glob, so [], (), *, ? etc. in the name
    # (common in YouTube titles) break discovery. Strip them to a plain name.
    cleaned = re.sub(r'[\[\]()*?{}<>:"|!&#%$]', "_", name)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" ._")
    return cleaned or "audio"


def stage_input(src: Path, stage_dir: Path) -> Path:
    stage_dir.mkdir(parents=True, exist_ok=True)
    # Stage under a glob-safe filename so MSST's file scan finds it.
    staged = stage_dir / (safe_name(src.stem) + src.suffix)
    if staged.exists():
        staged.unlink()
    try:
        os.link(src, staged)
    except OSError:
        shutil.copy2(src, staged)
    return staged


def _separation_batch() -> int:
    """Chunks per forward for BS-Rofo, scaled to VRAM (stock config is 1)."""
    env = os.environ.get("SEPARATION_BATCH")
    if env:
        return max(1, int(env))
    try:
        if torch.cuda.is_available():
            gb = torch.cuda.get_device_properties(0).total_memory / 2**30
            # thresholds sit slightly under nominal sizes: an "8 GB" card
            # reports ~7.99 GB
            return 6 if gb >= 11.5 else 4 if gb >= 7.5 else 2 if gb >= 5.5 else 1
    except Exception:
        pass
    return 1


def work_root(src: Path, suffix: str = "") -> Path:
    """Scratch folder for separated stems.

    These are several GB per song. They used to land in <song folder>/stems and
    stay there forever, quietly eating the user's disk (and failing outright on a
    read-only or cloud-synced music folder). Keep them with the Forge engine,
    keyed by a hash of the source path so two songs with the same name can't
    collide, and delete them when the run ends unless FORGE_KEEP_STEMS=1.
    """
    base = os.environ.get("MIDI_STUDIO_FORGE_ENV_DIR", "")
    root = Path(base) / "work" if base else src.parent / "stems"
    tag = hashlib.sha1(str(src.resolve()).encode("utf-8", "replace")).hexdigest()[:8]
    work = root / f"{safe_name(src.stem)}{suffix}-{tag}"
    work.mkdir(parents=True, exist_ok=True)
    return work


def cleanup_work(work_dir: Path) -> None:
    if os.environ.get("FORGE_KEEP_STEMS") == "1":
        print(f"  (kept stems: {work_dir})")
        return
    shutil.rmtree(work_dir, ignore_errors=True)


def _patched_msst_config(work_dir: Path, batch: int) -> Path:
    """Copy of the BS-Rofo YAML with inference.batch_size bumped. Textual edit
    on purpose: the YAML carries !!python/tuple tags that safe_load rejects,
    and a byte-preserving copy can't break MSST's own loader."""
    import re
    text = BS_ROFO_YAML.read_text(encoding="utf-8")
    new, n = re.subn(
        r"(inference:\s*(?:\n[ \t]+[^\n]*)*?\n[ \t]+batch_size:)[ \t]*\d+",
        rf"\g<1> {batch}", text, count=1)
    if n != 1:
        print("  [warn] couldn't patch inference.batch_size, using stock config")
        return BS_ROFO_YAML
    patched = work_dir / "bs_rofo_inference.yaml"
    patched.write_text(new, encoding="utf-8")
    return patched


def run_separation(src: Path, work_dir: Path) -> Path:
    """Run MSST BS-Roformer and return the folder of separated stem .wav files."""
    batch = _separation_batch()
    print(f"\n[1/3] Separating with BS-Rofo-SW-Fixed (SOTA 6-stem, batch {batch})")
    t0 = time.time()
    input_dir = work_dir / "input"
    output_dir = work_dir / "stems"
    output_dir.mkdir(parents=True, exist_ok=True)
    stage_input(src, input_dir)

    config = _patched_msst_config(work_dir, batch) if batch > 1 else BS_ROFO_YAML
    cmd = [
        str(PY), "inference.py",
        "--model_type", "bs_roformer",
        "--config_path", str(config),
        "--start_check_point", str(BS_ROFO_CKPT),
        "--input_folder", str(input_dir),
        "--store_dir", str(output_dir),
        "--device_ids", "0",
    ]
    if USE_TTA:
        cmd.append("--use_tta")
    if BIGSHIFTS > 1:
        cmd += ["--bigshifts", str(BIGSHIFTS)]
    # TF32 for cuBLAS/cuDNN inside MSST without touching its code.
    env = dict(os.environ, NVIDIA_TF32_OVERRIDE="1")
    rc = subprocess.run(cmd, cwd=str(MSST_DIR), check=False, env=env).returncode
    if rc != 0:
        raise RuntimeError(f"MSST inference failed with exit code {rc}")
    print(f"  separation done in {time.time() - t0:.1f}s")
    return output_dir


def separate_piano(src: Path, work_dir: Path) -> Path:
    output_dir = run_separation(src, work_dir)
    candidates = [p for p in output_dir.rglob("*piano*.wav") if p.is_file()]
    if not candidates:
        listing = "\n  ".join(str(p.relative_to(output_dir)) for p in output_dir.rglob("*") if p.is_file())
        raise RuntimeError(f"No piano stem found in {output_dir}:\n  {listing}")
    print(f"  using piano stem -> {candidates[0].name}")
    return candidates[0]


def mix_pitched_stems(src: Path, work_dir: Path) -> Path:
    """Separate, then sum every pitched stem (all but drums/percussion, and
    optionally vocals) into one wav for Transkun. The strong general path."""
    import numpy as np
    import soundfile as sf

    output_dir = run_separation(src, work_dir)
    wavs = sorted(p for p in output_dir.rglob("*.wav") if p.is_file())
    if not wavs:
        raise RuntimeError(f"Separation produced no stems in {output_dir}")
    excl = list(EXCLUDE_STEMS) + (["vocal"] if EXCLUDE_VOCALS else [])
    picked = [p for p in wavs if not any(x in p.name.lower() for x in excl)] or wavs
    print(f"  mixing {len(picked)} pitched stem(s): "
          f"{', '.join(p.stem.rsplit('_', 1)[-1] for p in picked)}")

    mix, sr = None, None
    for p in picked:
        audio, s = sf.read(str(p), always_2d=True, dtype="float32")
        if sr is None:
            sr = s
        elif s != sr:
            print(f"  (skipping {p.name}: sample-rate {s} != {sr})")
            continue
        if mix is None:
            mix = audio.copy()
        else:
            n = min(len(mix), len(audio))
            c = min(mix.shape[1], audio.shape[1])
            mix = mix[:n, :c] + audio[:n, :c]
    if mix is None:
        raise RuntimeError("No usable stems to mix.")

    peak = float(np.abs(mix).max())
    if peak > 1.0:                       # prevent clipping after summing
        mix = mix / peak * 0.98
    out = work_dir / "general_mix.wav"
    sf.write(str(out), mix, sr)
    return out


TRANSCRIBE_BACKEND = os.environ.get("TRANSCRIBE_BACKEND", "auto").lower()
TRANSKUN_ONNX = MODELS_BASE / "onnx" / "transkun_v2.onnx"


def _resolve_transcribe_backend() -> str:
    if TRANSCRIBE_BACKEND in ("cuda", "cpu", "onnx_dml"):
        return TRANSCRIBE_BACKEND
    if torch.cuda.is_available():
        return "cuda"
    try:
        import onnxruntime as ort
        if "DmlExecutionProvider" in ort.get_available_providers():
            if not TRANSKUN_ONNX.exists():
                # Installs provisioned before v2.3.0 lack the model, fetch it
                # now (idempotent, ~54 MB) instead of silently using the CPU.
                from download_assets import fetch_transkun_onnx
                print("Transkun ONNX model missing, downloading (one-time)...")
                if not fetch_transkun_onnx():
                    return "cpu"       # offline; next run retries
            return "onnx_dml"
    except Exception:
        pass
    return "cpu"


def transcribe_to_midi(piano_wav: Path, out_midi: Path) -> None:
    backend = _resolve_transcribe_backend()
    print(f"\n[2/3] Transcribing with Transkun V2 (SOTA piano MIDI), {backend}")
    t0 = time.time()
    env = os.environ
    if backend in ("cuda", "onnx_dml"):
        # Pipelined backbone (batched TF32 on CUDA / prefetch on DirectML)
        # overlapping the CPU semi-CRF decode. SEGMENT_HOP is honoured via env.
        cmd = [str(PY), str(Path(__file__).resolve().parent / "transcribe_fast.py"),
               str(piano_wav), str(out_midi)]
        env = dict(os.environ, TRANSCRIBE_BACKEND=backend)
    else:
        # Use `-m transkun.transcribe` instead of transkun.exe so it works in the
        # portable bundle (no console_scripts shims in embedded Python).
        cmd = [str(PY), "-m", "transkun.transcribe", str(piano_wav), str(out_midi),
               "--device", backend]
        if SEGMENT_HOP:
            cmd += ["--segmentHopSize", SEGMENT_HOP]
        if SEGMENT_SIZE:
            cmd += ["--segmentSize", SEGMENT_SIZE]
    rc = subprocess.run(cmd, check=False, env=env).returncode
    if rc != 0:
        raise RuntimeError(f"Transkun failed with exit code {rc}")
    print(f"  done in {time.time() - t0:.1f}s")


def _cap_polyphony(notes, max_poly):
    """Limit chord density: group notes by near-equal onset, keep the loudest."""
    if max_poly <= 0 or len(notes) <= max_poly:
        return notes
    notes = sorted(notes, key=lambda n: n.start)
    out, group, gstart = [], [], None
    Q = 0.035
    for nt in notes:
        if gstart is None or nt.start - gstart <= Q:
            if gstart is None:
                gstart = nt.start
            group.append(nt)
        else:
            out.extend(group if len(group) <= max_poly
                       else sorted(group, key=lambda n: n.velocity, reverse=True)[:max_poly])
            group, gstart = [nt], nt.start
    out.extend(group if len(group) <= max_poly
               else sorted(group, key=lambda n: n.velocity, reverse=True)[:max_poly])
    return out


def clean_midi(midi_path: Path) -> tuple[int, int]:
    pm = pretty_midi.PrettyMIDI(str(midi_path))
    before = sum(len(i.notes) for i in pm.instruments)
    for inst in pm.instruments:
        notes = [
            n for n in inst.notes
            if (n.end - n.start) >= MIN_NOTE_SEC
            and n.velocity >= MIN_VELOCITY
            and PIANO_MIN_PITCH <= n.pitch <= PIANO_MAX_PITCH
        ]
        notes = _cap_polyphony(notes, MAX_POLYPHONY)
        expand_velocities(notes, gamma=VELOCITY_GAMMA, floor=MIN_VELOCITY)
        inst.notes = notes
    after = sum(len(i.notes) for i in pm.instruments)
    pm.write(str(midi_path))
    return before, after


def recover_sparse_piano(stem_wav: Path, out_midi: Path, note_count: int,
                         work_dir: Path) -> int:
    """Use the broad recognizer only when Transkun clearly under-reads a stem."""
    try:
        import soundfile as sf
        duration = float(sf.info(str(stem_wav)).duration)
    except Exception:
        duration = 0.0

    sparse_limit = max(24, int(duration * 0.8))
    if note_count >= sparse_limit:
        return note_count

    print(f"  Transkun result is sparse ({note_count} notes / {duration:.1f}s); "
          "checking the broad recognizer...")
    fallback = work_dir / "fallback_basic_pitch.mid"
    try:
        rc = subprocess.run(
            [str(PY), str(ROOT / "stem_to_midi.py"), str(stem_wav), str(fallback)],
            check=False, env=os.environ).returncode
        if rc != 0 or not fallback.exists():
            print("  [warn] broad-recognizer check failed; keeping Transkun output")
            return note_count
        candidate = pretty_midi.PrettyMIDI(str(fallback))
        candidate_count = sum(len(inst.notes) for inst in candidate.instruments)
        richer_limit = max(note_count * 2, int(duration * 1.2))
        if candidate_count >= richer_limit:
            shutil.copy2(fallback, out_midi)
            print(f"  Recovery selected: {candidate_count} notes instead of {note_count}")
            return candidate_count
        print(f"  Broad recognizer found {candidate_count} notes; keeping cleaner Transkun output")
        return note_count
    except Exception as exc:
        print(f"  [warn] broad-recognizer check failed ({exc}); keeping Transkun output")
        return note_count
    finally:
        try:
            fallback.unlink(missing_ok=True)
        except Exception:
            pass


def _resolve_backend() -> str:
    if SEPARATION_BACKEND in ("msst", "onnx_dml"):
        return SEPARATION_BACKEND
    if torch.cuda.is_available():        # NVIDIA: BS-Rofo on CUDA is best
        return "msst"
    try:                                 # no CUDA: prefer a DX12 GPU over slow CPU
        import onnxruntime as ort
        if "DmlExecutionProvider" in ort.get_available_providers():
            if not ONNX_MDX_MODEL.exists():
                from download_assets import fetch_mdx_onnx
                print("MDX ONNX model missing, downloading (one-time)...")
                if not fetch_mdx_onnx():
                    return "msst"      # offline; next run retries
            return "onnx_dml"
    except Exception:
        pass
    return "msst"


def separate_onnx(src: Path, work_dir: Path) -> Path:
    """Vocal-removed instrumental via MDX-Net on ONNX Runtime + DirectML (GPU)."""
    print("\n[1/3] Separating with MDX-Net (ONNX Runtime + DirectML GPU)")
    if not ONNX_MDX_MODEL.exists():
        raise RuntimeError(f"ONNX model missing: {ONNX_MDX_MODEL}")
    t0 = time.time()
    import separate_onnx_dml as on
    out = on.separate(src, work_dir, ONNX_MDX_MODEL)
    print(f"  instrumental -> {out.name} ({time.time() - t0:.1f}s)")
    return out


def separate_onnx_general(src: Path, work_dir: Path) -> Path:
    """General mode on DirectML: instrumental minus the drums stem, every
    pitched instrument, mirroring mix_pitched_stems on the CUDA path."""
    print("\n[1/3] Separating with MDX-Net (ONNX + DirectML, general: −vocals −drums)")
    if not ONNX_DRUMS_MODEL.exists():
        from download_assets import fetch_drums_onnx
        print("Drums ONNX model missing, downloading (one-time)...")
        if not fetch_drums_onnx():
            print("  drums model unavailable (offline?), using instrumental only")
            return separate_onnx(src, work_dir)
    t0 = time.time()
    import separate_onnx_dml as on
    out = on.separate_general(src, work_dir, ONNX_MDX_MODEL, ONNX_DRUMS_MODEL)
    print(f"  general mix -> {out.name} ({time.time() - t0:.1f}s)")
    return out


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: song_to_midi.py <audio_file>")
        return 1

    src = Path(sys.argv[1]).resolve()
    if not src.exists():
        print(f"File not found: {src}")
        return 1

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Device: {device}" + (f" ({torch.cuda.get_device_name(0)})" if device == "cuda" else ""))
    print(f"Input: {src.name}")

    # Sanitize the work-dir name too: MSST globs the input folder path, and
    # brackets/parens in it would be read as glob character classes.
    work_dir = work_root(src)
    process_src = audio_window_from_env(src, work_dir)

    backend = _resolve_backend()
    if backend == "onnx_dml":
        print("Separator: MDX-Net (ONNX + DirectML). GPU path for non-CUDA cards")
        if GENERAL_MODE:
            print("Mode: General (vocals + drums removed, all pitched stems kept)")
            stem_wav = separate_onnx_general(process_src, work_dir)
        else:
            stem_wav = separate_onnx(process_src, work_dir)
    elif GENERAL_MODE:
        print("Mode: General (mixing all pitched stems, not just piano)")
        stem_wav = mix_pitched_stems(process_src, work_dir)
    else:
        stem_wav = separate_piano(process_src, work_dir)

    if LOUDNESS_NORM:
        print(f"    Normalizing stem to {TARGET_RMS_DB} dB RMS (peak ceiling {PEAK_CEILING_DB} dB)")
        normalize_wav_in_place(stem_wav, target_rms_db=TARGET_RMS_DB, peak_ceiling_db=PEAK_CEILING_DB)

    out_midi = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else src.with_suffix(".mid")
    transcribe_to_midi(stem_wav, out_midi)

    print(f"\n[3/3] Cleaning MIDI (drop notes < {MIN_NOTE_SEC}s or velocity < {MIN_VELOCITY}"
          + (f", cap {MAX_POLYPHONY} simultaneous" if MAX_POLYPHONY else "") + f"); velocity gamma {VELOCITY_GAMMA}")
    before, after = clean_midi(out_midi)
    print(f"  {before} -> {after} notes (dropped {before - after})")

    if not GENERAL_MODE:
        after = recover_sparse_piano(stem_wav, out_midi, after, work_dir)

    print(f"\nDONE.\n  Stem: {stem_wav}\n  MIDI:       {out_midi}")
    cleanup_work(work_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
