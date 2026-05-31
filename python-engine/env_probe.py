#!/usr/bin/env python3
"""Out-of-process capability probe for the heavy forge env. Run by the FORGE
interpreter so torch is never imported into the realtime player sidecar. Prints
exactly one JSON object to stdout, then exits."""
import json

out = {"torch": False, "cuda": False, "gpu": None,
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
for _m in ("transkun", "basic_pitch", "yt_dlp"):
    try:
        __import__(_m)
        out[_m] = True
    except Exception:
        pass
print(json.dumps(out))
