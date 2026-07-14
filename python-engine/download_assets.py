"""Download BS-Rofo-SW-Fixed model + FFmpeg shared DLLs into the repo folder.
Resumes interrupted transfers, retries on transient failures, sets a UA + timeout."""
import os
import socket
import sys
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent

# When the provisioner runs us it points MIDI_STUDIO_MODELS_DIR at the forge-env
# models dir, so assets land where song_to_midi.py reads them. Falls back to the
# co-located repo folder for a dev/source run.
_MODELS_BASE = Path(os.environ.get("MIDI_STUDIO_MODELS_DIR") or (ROOT / "models"))
MODEL_DIR = _MODELS_BASE / "bs_rofo_sw"
# The upstream HuggingFace repo (jarredou/BS-ROFO-SW-Fixed) went gated and now
# returns HTTP 401, so we host a copy on our own GitHub release. GitHub CDN
# supports range requests, so _fetch's resume still works.
_ASSET_BASE_URL = "https://github.com/StarsationX/midi-studio/releases/download/assets-v1"
CKPT_URL = f"{_ASSET_BASE_URL}/BS-Rofo-SW-Fixed.ckpt"
YAML_URL = f"{_ASSET_BASE_URL}/BS-Rofo-SW-Fixed.yaml"

# MDX-Net instrumental model for the ONNX + DirectML separation path (non-CUDA
# GPUs, e.g. AMD RX 580). Hosted on the public UVR model mirror.
ONNX_DIR = _MODELS_BASE / "onnx"
MDX_NAME = "UVR-MDX-NET-Inst_HQ_3.onnx"
MDX_URL = ("https://github.com/TRvlvr/model_repo/releases/download/"
           f"all_public_uvr_models/{MDX_NAME}")

# Transkun v2 acoustic model as ONNX for the DirectML transcription path
# (non-CUDA GPUs). Exported from transkun 2.0.1; semi-CRF decode stays in
# the transkun Python package at runtime. Hosted on our assets release.
TRANSKUN_ONNX_FILES = ("transkun_v2.onnx", "transkun_v2.onnx.data",
                       "transkun_v2_config.json")

# FFmpeg sits next to the env (sibling of models) so song_to_midi.py finds it there.
FFMPEG_DIR = (_MODELS_BASE.parent / "ffmpeg") if os.environ.get("MIDI_STUDIO_MODELS_DIR") else (ROOT / "ffmpeg")
FFMPEG_URL = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl-shared.zip"

USER_AGENT = "midi-forge-installer/1.0 (+https://github.com/StarsationX/midi-forge)"
READ_TIMEOUT = 30
MAX_ATTEMPTS = 4


def _human(n: int | float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:6.1f} {unit}"
        n /= 1024
    return f"{n:6.1f} TB"


def _head_size(url: str) -> int | None:
    try:
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=15) as r:
            n = r.headers.get("Content-Length")
            return int(n) if n else None
    except Exception:
        return None


def _fetch(url: str, dest: Path, label: str) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")

    if dest.exists() and dest.stat().st_size > 0:
        remote = _head_size(url)
        local = dest.stat().st_size
        if remote is None or remote == local:
            print(f"  [skip ] {label} ({_human(local)} already present)")
            return
        print(f"  [stale] {label}: local {_human(local)} vs remote {_human(remote)} - re-downloading")
        dest.unlink()

    for attempt in range(1, MAX_ATTEMPTS + 1):
        already = tmp.stat().st_size if tmp.exists() else 0
        headers = {"User-Agent": USER_AGENT}
        if already > 0:
            headers["Range"] = f"bytes={already}-"
            print(f"  [retry] {label}: resuming from {_human(already)} (attempt {attempt}/{MAX_ATTEMPTS})")
        else:
            print(f"  [get  ] {label} (attempt {attempt}/{MAX_ATTEMPTS})")
            print(f"          {url}")

        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=READ_TIMEOUT) as r:
                # 206 = partial-content; 200 = full (server ignored Range)
                if already > 0 and r.status != 206:
                    already = 0
                    mode = "wb"
                else:
                    mode = "ab" if already > 0 else "wb"

                remaining = int(r.headers.get("Content-Length", "0"))
                total = already + remaining if remaining else None
                read = already
                last_pct = -5
                with open(tmp, mode) as f:
                    while True:
                        chunk = r.read(1024 * 256)
                        if not chunk:
                            break
                        f.write(chunk)
                        read += len(chunk)
                        if total:
                            pct = int(read * 100 / total)
                            if pct - last_pct >= 5:
                                print(f"          {pct:3d}%  {_human(read)} / {_human(total)}")
                                last_pct = pct

            tmp.replace(dest)
            print(f"          done ({_human(dest.stat().st_size)})")
            return

        except (urllib.error.URLError, socket.timeout, ConnectionError, OSError, TimeoutError) as e:
            err = f"{type(e).__name__}: {e}"
            print(f"          [error] {err}")
            if attempt < MAX_ATTEMPTS:
                wait = 2 ** attempt
                print(f"          retrying in {wait}s...")
                time.sleep(wait)
            else:
                raise RuntimeError(f"{label} failed after {MAX_ATTEMPTS} attempts: {err}")


def fetch_model() -> None:
    print("Model: BS-Rofo-SW-Fixed (SOTA 6-stem piano separator)")
    _fetch(YAML_URL, MODEL_DIR / "BS-Rofo-SW-Fixed.yaml", "BS-Rofo-SW-Fixed.yaml")
    _fetch(CKPT_URL, MODEL_DIR / "BS-Rofo-SW-Fixed.ckpt", "BS-Rofo-SW-Fixed.ckpt")


def fetch_onnx() -> None:
    print("\nMDX-Net ONNX model (DirectML separation for non-NVIDIA GPUs):")
    _fetch(MDX_URL, ONNX_DIR / MDX_NAME, MDX_NAME)
    print("\nTranskun v2 ONNX model (DirectML transcription for non-NVIDIA GPUs):")
    for name in TRANSKUN_ONNX_FILES:
        _fetch(f"{_ASSET_BASE_URL}/{name}", ONNX_DIR / name, name)


def fetch_ffmpeg() -> None:
    print("\nFFmpeg shared DLLs (BtbN build):")
    target = FFMPEG_DIR / "ffmpeg-master-latest-win64-lgpl-shared"
    if (target / "bin" / "ffmpeg.exe").exists():
        print("  [skip ] FFmpeg already extracted")
        return
    zip_path = FFMPEG_DIR / "ffmpeg.zip"
    _fetch(FFMPEG_URL, zip_path, "ffmpeg-master-latest-win64-lgpl-shared.zip")
    print(f"  [unzip] -> {FFMPEG_DIR}")
    try:
        with zipfile.ZipFile(zip_path) as z:
            z.extractall(FFMPEG_DIR)
    except zipfile.BadZipFile as e:
        zip_path.unlink(missing_ok=True)
        raise RuntimeError(f"FFmpeg zip is corrupt ({e}); deleted, please re-run install.bat") from e
    zip_path.unlink()
    print("          done")


def main() -> int:
    socket.setdefaulttimeout(READ_TIMEOUT)
    try:
        fetch_model()
        fetch_onnx()
        fetch_ffmpeg()
    except Exception as e:
        print(f"\n[ERROR] {type(e).__name__}: {e}")
        return 1
    print("\nAll assets ready.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
