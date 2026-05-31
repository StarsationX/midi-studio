"""Smoke test run at the end of install.bat. Reports anything missing or broken.
Exit 0 = ready. Exit 1 = warnings (install may still work, just with issues)."""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent

# torchcodec dlopen-loads the FFmpeg shared libs at import time - put them on PATH
# before importing anything that touches torchcodec/torchaudio.
FFMPEG_BIN = ROOT / "ffmpeg" / "ffmpeg-master-latest-win64-lgpl-shared" / "bin"
if FFMPEG_BIN.exists():
    os.environ["PATH"] = str(FFMPEG_BIN) + os.pathsep + os.environ.get("PATH", "")
    try:
        os.add_dll_directory(str(FFMPEG_BIN))
    except (AttributeError, OSError):
        pass

PASS = "  [OK  ]"
WARN = "  [WARN]"
FAIL = "  [FAIL]"

issues: list[str] = []
warnings: list[str] = []


def check_import(name: str, attr: str | None = None) -> None:
    try:
        mod = __import__(name, fromlist=[attr] if attr else [])
        if attr and not hasattr(mod, attr):
            print(f"{FAIL} {name}.{attr} missing")
            issues.append(f"{name}.{attr} missing")
            return
        ver = getattr(mod, "__version__", "?")
        print(f"{PASS} import {name} ({ver})")
    except Exception as e:
        print(f"{FAIL} import {name}: {type(e).__name__}: {e}")
        issues.append(f"{name} import: {e}")


def check_file(path: Path, label: str, min_bytes: int = 1) -> None:
    if not path.exists():
        print(f"{FAIL} {label} missing  ({path})")
        issues.append(f"{label} missing")
        return
    sz = path.stat().st_size
    if sz < min_bytes:
        print(f"{FAIL} {label} too small: {sz} bytes < {min_bytes}")
        issues.append(f"{label} truncated")
        return
    mb = sz / (1024 * 1024)
    print(f"{PASS} {label} ({mb:.1f} MB)" if mb >= 0.1 else f"{PASS} {label} ({sz} bytes)")


print("Python packages:")
check_import("torch")
check_import("torchaudio")
check_import("torchcodec")
check_import("pretty_midi")
check_import("librosa")
check_import("soundfile")
check_import("pydub")
check_import("numpy")
check_import("transkun")
check_import("basic_pitch")
check_import("onnxruntime")
check_import("PySide6.QtWidgets", attr="QApplication")

print("\nCUDA:")
try:
    import torch
    if torch.cuda.is_available():
        print(f"{PASS} CUDA available -> {torch.cuda.get_device_name(0)}")
        print(f"         compute capability sm_{torch.cuda.get_device_capability(0)[0]}{torch.cuda.get_device_capability(0)[1]}")
    else:
        print(f"{WARN} CUDA not available - separation will fall back to CPU (~20-40 min per song)")
        warnings.append("CUDA not detected - check NVIDIA driver is up to date")
except Exception as e:
    print(f"{FAIL} CUDA check failed: {e}")
    issues.append(f"CUDA check: {e}")

print("\nAssets:")
check_file(ROOT / "models" / "bs_rofo_sw" / "BS-Rofo-SW-Fixed.ckpt", "BS-Rofo-SW-Fixed.ckpt", min_bytes=600 * 1024 * 1024)
check_file(ROOT / "models" / "bs_rofo_sw" / "BS-Rofo-SW-Fixed.yaml", "BS-Rofo-SW-Fixed.yaml", min_bytes=100)

# ffmpeg.exe in the shared build is a small stub; the codec code is in the DLLs.
# Verify the DLLs are present instead.
ffmpeg_bin = ROOT / "ffmpeg" / "ffmpeg-master-latest-win64-lgpl-shared" / "bin"
check_file(ffmpeg_bin / "ffmpeg.exe", "ffmpeg.exe", min_bytes=100_000)
if ffmpeg_bin.exists():
    dll_count = sum(1 for _ in ffmpeg_bin.glob("*.dll"))
    if dll_count >= 6:
        print(f"{PASS} FFmpeg shared DLLs ({dll_count} found)")
    else:
        print(f"{FAIL} FFmpeg shared DLLs: only {dll_count} found (expected 6+)")
        issues.append("FFmpeg shared DLLs missing")

check_file(ROOT / "msst" / "inference.py", "msst/inference.py", min_bytes=100)

print()
if issues:
    print(f"{len(issues)} issue(s) found:")
    for x in issues:
        print(f"  - {x}")
    print("\nmidi-forge will not run correctly until these are fixed. Re-run install.bat to retry.")
    sys.exit(1)
if warnings:
    print(f"{len(warnings)} warning(s):")
    for x in warnings:
        print(f"  - {x}")
    sys.exit(1)

print("All checks passed. midi-forge is ready.")
sys.exit(0)
