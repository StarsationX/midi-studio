#!/usr/bin/env python3
"""Out-of-process capability probe for the heavy forge env. Run by the FORGE
interpreter so torch is never imported into the realtime player sidecar. Prints
exactly one JSON object to stdout, then exits."""
import json

out = {"torch": False, "cuda": False, "dml": False, "gpu": None,
       "transkun": False, "basic_pitch": False, "yt_dlp": False}
try:
    import torch  # type: ignore
    out["torch"] = True
    try:
        out["cuda"] = bool(torch.cuda.is_available())
        if out["cuda"]:
            out["gpu"] = torch.cuda.get_device_name(0)
    except Exception:
        pass
except Exception:
    pass

# No CUDA doesn't mean no GPU: AMD/Intel DX12 cards run separation and
# transcription via ONNX Runtime + DirectML. Label them so the UI doesn't
# claim "CPU mode".
if not out["cuda"]:
    try:
        import onnxruntime  # type: ignore
        if "DmlExecutionProvider" in onnxruntime.get_available_providers():
            out["dml"] = True
            try:
                import subprocess
                r = subprocess.run(
                    ["powershell", "-NoProfile", "-Command",
                     "(Get-CimInstance Win32_VideoController).Name"],
                    capture_output=True, text=True, timeout=15)
                names = [l.strip() for l in r.stdout.splitlines() if l.strip()
                         and "virtual" not in l.lower()]
                out["gpu"] = f"{names[0]} (DirectML)" if names else "DirectX 12 GPU (DirectML)"
            except Exception:
                out["gpu"] = "DirectX 12 GPU (DirectML)"
    except Exception:
        pass
for _m in ("transkun", "basic_pitch", "yt_dlp"):
    try:
        __import__(_m)
        out[_m] = True
    except Exception:
        pass
print(json.dumps(out))
