"""Download FFmpeg shared DLLs. Model weights are never fetched from mirrors.
Resumes interrupted transfers, retries on transient failures, sets a UA + timeout."""
import hashlib
import os
import shutil
import socket
import sys
import tempfile
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
ONNX_DIR = _MODELS_BASE / "onnx"
TRANSKUN_ONNX_FILES = ("transkun_v2.onnx", "transkun_v2.onnx.data",
                       "transkun_v2_config.json")

# FFmpeg sits next to the env (sibling of models) so song_to_midi.py finds it there.
FFMPEG_DIR = (_MODELS_BASE.parent / "ffmpeg") if os.environ.get("MIDI_STUDIO_MODELS_DIR") else (ROOT / "ffmpeg")
FFMPEG_BUILD = "ffmpeg-N-125875-g5d4d3bdc61-win64-lgpl-shared"
FFMPEG_URL = f"https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/autobuild-2026-07-31-14-10/{FFMPEG_BUILD}.zip"
FFMPEG_SHA256 = "6a2e25e2280df8f2071c14155a314ef32ec08100d56e5f32e41a9d7fd8b50cd3"

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


def prepare_transkun_onnx() -> bool:
    """Use existing graphs or the licensed export shipped with this installer."""
    for name in TRANSKUN_ONNX_FILES:
        dest = ONNX_DIR / name
        if dest.is_file():
            continue
        source = next((p for p in (ROOT.parent / "assets" / "onnx" / name,
                                  ROOT.parent / "forge-rs" / "assets" / "onnx" / name)
                       if p.is_file()), None)
        if source is None:
            return False
        dest.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=dest.parent) as tmp:
            verified_copy = Path(tmp) / name
            shutil.copyfile(source, verified_copy)
            verified_copy.replace(dest)
    return True


def fetch_ffmpeg() -> None:
    print("\nFFmpeg shared DLLs (BtbN build):")
    target = FFMPEG_DIR / "ffmpeg-master-latest-win64-lgpl-shared"
    if (target / "bin" / "ffmpeg.exe").exists():
        print("  [skip ] FFmpeg already extracted")
        return
    zip_path = FFMPEG_DIR / "ffmpeg.zip"
    _fetch(FFMPEG_URL, zip_path, FFMPEG_BUILD + ".zip")
    with zip_path.open("rb") as archive:
        verified = hashlib.file_digest(archive, "sha256").hexdigest() == FFMPEG_SHA256
    if not verified:
        zip_path.unlink()
        raise RuntimeError("FFmpeg archive SHA-256 mismatch; please run setup again.")
    print(f"  [unzip] -> {FFMPEG_DIR}")
    try:
        with tempfile.TemporaryDirectory(dir=FFMPEG_DIR) as tmp, zipfile.ZipFile(zip_path) as z:
            z.extractall(tmp)
            shutil.copytree(Path(tmp) / FFMPEG_BUILD, target, dirs_exist_ok=True)
    except zipfile.BadZipFile as e:
        zip_path.unlink(missing_ok=True)
        raise RuntimeError(f"FFmpeg zip is corrupt ({e}); deleted, please re-run install.bat") from e
    zip_path.unlink()
    print("          done")


def main() -> int:
    socket.setdefaulttimeout(READ_TIMEOUT)
    try:
        fetch_ffmpeg()
    except Exception as e:
        print(f"\n[ERROR] {type(e).__name__}: {e}")
        return 1
    print("\nAll assets ready.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
