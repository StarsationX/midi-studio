"""Which front-end is closer to exact math: torch fp32 (Python path) or forge-rs?

    python capped.py frontend_f64_check.py <py_dump_dir> <rs_dump_dir> [seg]

Rebuilds segment `seg` from the dumped mono 44.1 kHz audio and recomputes the
features entirely in float64 (numpy), then reports each implementation's
error against that reference.
"""
import math
import sys
from pathlib import Path

import numpy as np
from safetensors.numpy import load_file


def main():
    py, rs = Path(sys.argv[1]), Path(sys.argv[2])
    k = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    aux = load_file(str(Path(sys.argv[4]) if len(sys.argv) > 4 else
                        Path(__file__).resolve().parents[0] / "transkun_v2_aux.safetensors"))
    win = aux["frontend.windows"].astype(np.float64)
    f2m = aux["frontend.freq2mels"].astype(np.float64)
    x = np.load(py / "resampled.npy").astype(np.float32)
    x = x.mean(axis=1) if x.shape[1] > 1 else x[:, 0]
    fs, hop, W = 44100, 1024, 4096
    pad = math.ceil(8 * fs)
    xp = np.pad(x, (pad, pad))
    step = math.ceil(8 * fs / hop) * hop
    seg = math.ceil(16 * fs)
    s = xp[k * step:k * step + seg]
    s = np.pad(s, (0, seg - len(s)))
    T = math.ceil(seg / hop) + 1
    lp = W // 2
    rp = (T - 1) * hop + W // 2 - seg
    s = np.pad(s, (lp, rp)).astype(np.float64)
    frames = np.lib.stride_tricks.sliding_window_view(s, W)[::hop][:T]
    m = frames.mean()
    sd = frames.std(ddof=1)
    fn = (frames - m) / (sd + 1e-8)
    spec = np.fft.rfft(fn[:, None, :] * win[None], norm="ortho")      # [T, 6, F]
    p = np.abs(spec) ** 2
    mel = p @ f2m                                                      # [T, 6, M]
    eps = 1e-5
    ref = ((np.log(mel + eps) - math.log(eps)) / (-math.log(eps))).transpose(0, 2, 1)
    a = np.load(py / f"seg{k:02d}_features.npy")[0].astype(np.float64)
    b = np.load(rs / f"seg{k:02d}_features.npy")[0].astype(np.float64)
    melT = mel.transpose(0, 2, 1)
    big = ref > 0.05          # away from the mel ~ 0 floor where ulps are meaningless
    ulp = np.spacing(np.abs(ref).astype(np.float32)).astype(np.float64)
    for name, v in (("torch fp32 (python)", a), ("forge-rs", b)):
        e = np.abs(v - ref)
        i = np.unravel_index(np.argmax(e), e.shape)
        print(f"{name:20s} max|err| {e.max():.3e}  mean|err| {e.mean():.3e}  "
              f"(features>0.05: max {(e[big] / ulp[big]).max():.1f} ulp, mean {(e[big] / ulp[big]).mean():.3f} ulp)  "
              f"worst at t,m,w={tuple(int(z) for z in i)} ref={ref[i]:.6g} mel={melT[i]:.3e}")


if __name__ == "__main__":
    main()
