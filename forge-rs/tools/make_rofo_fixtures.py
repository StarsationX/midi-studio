"""Golden fixtures for the BS-Roformer separation port (tests/separation.rs).

    python capped.py make_rofo_fixtures.py MSST_DIR [MODEL_DIR]

Writes into forge-rs/tests/fixtures/:
  rofo_hann.npy          torch.hann_window(2048)
  rofo_stft.npy          torch.stft of lcg(8192) -> [T][F][2]
  rofo_istft.npy         torch.istft(stft * lcg_mask, DC zeroed, length=8192)
  rofo_demix.json        MSST utils.model_utils.demix with a fake 2-stem model
  rofo_demix_<case>.npy  ... its output per case ([stems][ch][len])
  rofo_linspace.json     bit-hashes of torch.linspace(0,1,58880) / (1,0,58880)
  rofo_pcm16.npy         [2][n]: floats near / between PCM16 steps, and what
                         soundfile's sf.write(PCM_16) stored for them
With MODEL_DIR (BS-Rofo-SW-Fixed .yaml/.ckpt; slow, ~1 min CPU):
  rofo_chunk.json / rofo_chunk_dec.npy
                         BSRoformer.forward on one 588800-sample synth() chunk,
                         every 127th output sample

lcg(): x = ((s >> 48) as i16) / 32768 with s = s * 6364136223846793005 +
1442695040888963407 (mod 2^64), s0 = seed; Rust regenerates it bit-exactly.
"""
import json
import os
import sys
from pathlib import Path

import numpy as np

os.environ.setdefault("CUDA_VISIBLE_DEVICES", "-1")
import torch  # noqa: E402

HERE = Path(__file__).resolve().parent
FIX = HERE.parent / "tests" / "fixtures"
MSST = sys.argv[1]
MODEL_DIR = sys.argv[2] if len(sys.argv) > 2 else None
sys.path.insert(0, MSST)

M64 = (1 << 64) - 1


def lcg(n, seed):
    s = seed & M64
    out = np.empty(n, dtype=np.float32)
    for i in range(n):
        s = (s * 6364136223846793005 + 1442695040888963407) & M64
        v = (s >> 48) & 0xFFFF
        if v >= 0x8000:
            v -= 0x10000
        out[i] = np.float32(v) / np.float32(32768.0)
    return out


def synth(n, ch):
    """Bass saw + second saw + square + gated noise bursts, every op fp32
    and in a fixed order so Rust rebuilds it bit for bit."""
    f = np.float32
    t = np.arange(n, dtype=np.int64)
    saw1 = ((t * 3 + ch * 17) % 401).astype(np.float32) / f(401) - f(0.5)
    saw2 = ((t * 5) % 293).astype(np.float32) / f(293) - f(0.5)
    sq = np.where((t // 150) % 2 == 0, f(0.5), f(-0.5)).astype(np.float32)
    env = np.maximum(0, 3000 - (t % 11025)).astype(np.float32) / f(3000)
    noise = lcg(n, 30 + ch)
    x = saw1 * f(0.3)
    x = x + saw2 * (f(0.2) if ch == 0 else f(0.1))
    x = x + sq * f(0.1)
    x = x + (noise * env) * f(0.4)
    return x.astype(np.float32)


def fnv(a):
    h = 0xcbf29ce484222325
    for b in np.ascontiguousarray(a, dtype=np.float32).view(np.uint32).tolist():
        h ^= b
        h = (h * 0x100000001b3) & M64
    return "%016x" % h


def save(name, arr):
    np.save(FIX / name, np.ascontiguousarray(arr, dtype=np.float32))


def stft_fixtures():
    win = torch.hann_window(2048)
    save("rofo_hann.npy", win.numpy())
    x = torch.from_numpy(lcg(8192, 1))
    S = torch.stft(x, 2048, 512, 2048, win, center=True, normalized=False, return_complex=True)  # (F, T)
    save("rofo_stft.npy", torch.view_as_real(S).permute(1, 0, 2).numpy())
    F_, T_ = S.shape
    mr = torch.from_numpy(lcg(F_ * T_, 2)).reshape(T_, F_).T
    mi = torch.from_numpy(lcg(F_ * T_, 3)).reshape(T_, F_).T
    Y = S * torch.complex(mr, mi)
    Y[0] = 0
    y = torch.istft(Y, 2048, 512, 2048, win, center=True, normalized=False, length=8192)
    save("rofo_istft.npy", y.numpy())


class Fake(torch.nn.Module):
    """out[n][c][t] = x[c][(t + 7n) % L] * (n + 1) - x[1 - c][t] * 0.5"""
    def __init__(self, n):
        super().__init__()
        self.n = n

    def forward(self, x):  # (B, 2, L) -> (B, n, 2, L)
        outs = []
        for k in range(self.n):
            rolled = torch.roll(x, shifts=-7 * k, dims=-1) * float(k + 1)
            other = x.flip(1) * 0.5
            outs.append(rolled - other)
        return torch.stack(outs, dim=1)


def demix_fixtures():
    from ml_collections import ConfigDict
    from utils.model_utils import demix, _getWindowingArray
    cases = []
    for chunk, ovl, length, batch in [
        (2000, 2, 700, 1), (2000, 2, 1800, 1), (2000, 2, 5100, 1), (2000, 2, 5100, 3),
        (2205, 4, 7000, 1), (2205, 4, 7000, 2),
    ]:
        cfg = ConfigDict({
            "audio": {"chunk_size": chunk},
            "inference": {"num_overlap": ovl, "batch_size": batch},
            "training": {"instruments": ["a", "b"], "target_instrument": None, "use_amp": False},
        })
        seed = 10 + len(cases)
        mix = np.stack([lcg(length, seed), lcg(length, seed + 100)])
        out = demix(cfg, Fake(2), mix, torch.device("cpu"), "bs_roformer", pbar=False)
        arr = np.stack([out["a"], out["b"]])
        name = f"rofo_demix_{len(cases)}.npy"
        save(name, arr)
        cases.append({"chunk": chunk, "overlap": ovl, "length": length, "batch": batch,
                      "seed": seed, "file": name})
    json.dump({"cases": cases, "torch_cpu": torch.backends.cpu.get_cpu_capability()},
              open(FIX / "rofo_demix.json", "w"), indent=1)
    w = _getWindowingArray(588800, 58880)
    json.dump({
        "fadein": fnv(torch.linspace(0, 1, 58880).numpy()),
        "fadeout": fnv(torch.linspace(1, 0, 58880).numpy()),
        "window_588800": fnv(w.numpy()),
        "fadein_200": torch.linspace(0, 1, 200).tolist(),
    }, open(FIX / "rofo_linspace.json", "w"), indent=1)


def pcm16_fixture():
    import soundfile as sf
    import tempfile
    rng = np.random.default_rng(5)
    k = rng.integers(-32768, 32768, 6000)
    f = rng.choice([-0.5, -2e-5, -7.6e-6, -3e-6, 0.0, 3e-6, 7.6e-6, 0.3, -0.3, 0.5], 6000)
    x = np.concatenate([((k + f) / 32768).astype(np.float32),
                        np.linspace(-1.1, 1.1, 2001, dtype=np.float32)])
    p = os.path.join(tempfile.mkdtemp(), "p.wav")
    sf.write(p, x, 44100, subtype="PCM_16")
    y, _ = sf.read(p, dtype="int16")
    save("rofo_pcm16.npy", np.stack([x, y.astype(np.float32)]))


def chunk_fixture():
    import yaml
    from models.bs_roformer.bs_roformer import BSRoformer

    class Loader(yaml.SafeLoader):
        pass
    Loader.add_constructor("tag:yaml.org,2002:python/tuple", lambda l, n: tuple(l.construct_sequence(n)))
    cfg = yaml.load(open(os.path.join(MODEL_DIR, "BS-Rofo-SW-Fixed.yaml"), encoding="utf-8"), Loader=Loader)
    model = BSRoformer(**dict(cfg["model"]))
    sd = torch.load(os.path.join(MODEL_DIR, "BS-Rofo-SW-Fixed.ckpt"), map_location="cpu", weights_only=False)
    model.load_state_dict(sd.get("state_dict", sd) if isinstance(sd, dict) else sd)
    del sd
    model.eval()
    L = 588800
    x = torch.from_numpy(np.stack([synth(L, 0), synth(L, 1)])).unsqueeze(0)
    with torch.inference_mode():
        y = model(x)[0]  # (6, 2, L)
    dec = y[..., ::127].numpy()
    save("rofo_chunk_dec.npy", dec)
    json.dump({"length": L, "signal": "synth", "decimate": 127,
               "rms": [float(v) for v in y.pow(2).mean(dim=(1, 2)).sqrt()],
               "torch": torch.__version__},
              open(FIX / "rofo_chunk.json", "w"), indent=1)


torch.set_num_threads(8)
stft_fixtures()
demix_fixtures()
pcm16_fixture()
if MODEL_DIR:
    chunk_fixture()
print("fixtures written to", FIX)
