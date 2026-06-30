"""Smoke test run at the end of install.bat. Reports anything missing or broken.
Exit 0 = ready. Exit 1 = warnings (install may still work, just with issues)."""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent

# Assets (FFmpeg/model/MSST) live in the provisioned forge-env, not this script
# dir; resolve a base that holds them, falling back to ROOT for dev/source.
_ASSET_BASE = Path(sys.executable).resolve().parent
if _ASSET_BASE.name.lower() in ("python", "scripts"):
    _ASSET_BASE = _ASSET_BASE.parent
if not (_ASSET_BASE / "ffmpeg").exists() and (ROOT / "ffmpeg").exists():
    _ASSET_BASE = ROOT
MODELS_BASE = Path(os.environ.get("MIDI_STUDIO_MODELS_DIR") or (_ASSET_BASE / "models"))

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
# torchcodec is NOT checked: it's only pulled in as a torchaudio companion and is
# never used at runtime (MSST loads via librosa, transkun via pydub→ffmpeg.exe, our
# scripts via soundfile). It also dlopen-loads the FFmpeg shared libs and only ships
# cores for FFmpeg 4–8, so when the unpinned BtbN "master" build rolls to a newer
# FFmpeg major it fails to load — which used to fail the whole install for nothing.
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
check_file(MODELS_BASE / "bs_rofo_sw" / "BS-Rofo-SW-Fixed.ckpt", "BS-Rofo-SW-Fixed.ckpt", min_bytes=600 * 1024 * 1024)
check_file(MODELS_BASE / "bs_rofo_sw" / "BS-Rofo-SW-Fixed.yaml", "BS-Rofo-SW-Fixed.yaml", min_bytes=100)

# ffmpeg.exe in the shared build is a small stub; the codec code is in the DLLs.
# Verify the DLLs are present instead.
ffmpeg_bin = _ASSET_BASE / "ffmpeg" / "ffmpeg-master-latest-win64-lgpl-shared" / "bin"
check_file(ffmpeg_bin / "ffmpeg.exe", "ffmpeg.exe", min_bytes=100_000)
if ffmpeg_bin.exists():
    dll_count = sum(1 for _ in ffmpeg_bin.glob("*.dll"))
    if dll_count >= 6:
        print(f"{PASS} FFmpeg shared DLLs ({dll_count} found)")
    else:
        print(f"{FAIL} FFmpeg shared DLLs: only {dll_count} found (expected 6+)")
        issues.append("FFmpeg shared DLLs missing")

check_file(_ASSET_BASE / "msst" / "inference.py", "msst/inference.py", min_bytes=100)

# Non-fatal: the MDX-Net ONNX model + DirectML provider power GPU separation on
# non-NVIDIA cards. Missing => that path falls back to CPU, so warn, don't fail.
onnx_model = MODELS_BASE / "onnx" / "UVR-MDX-NET-Inst_HQ_3.onnx"
if onnx_model.exists():
    print(f"{PASS} MDX-Net ONNX model ({onnx_model.stat().st_size / (1024 * 1024):.0f} MB)")
else:
    print(f"{WARN} MDX-Net ONNX model missing (DirectML separation unavailable)")
    warnings.append("MDX-Net ONNX model missing - non-NVIDIA GPU separation falls back to CPU")
try:
    import onnxruntime as _ort
    if "DmlExecutionProvider" in _ort.get_available_providers():
        print(f"{PASS} DirectML provider available (GPU separation for non-NVIDIA)")
    else:
        print(f"{WARN} DirectML provider not available (onnxruntime-directml not installed?)")
except Exception:
    pass

print()
if issues:
    print(f"{len(issues)} issue(s) found:")
    for x in issues:
        print(f"  - {x}")
    print("\nmidi-forge will not run correctly until these are fixed. Re-run install.bat to retry.")
    sys.exit(1)
if warnings:
    # Warnings are NON-FATAL — e.g. "no CUDA" on an AMD/Intel/no-GPU machine just
    # means slower CPU-mode transcription, not a broken install. Exiting non-zero
    # here would make the provisioner reject a perfectly usable setup at 95%.
    print(f"{len(warnings)} warning(s) (setup is still usable):")
    for x in warnings:
        print(f"  - {x}")

print("All checks passed. midi-forge is ready.")
sys.exit(0)
