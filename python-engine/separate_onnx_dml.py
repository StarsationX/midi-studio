"""GPU separation via ONNX Runtime + DirectML — for machines with no CUDA.

NVIDIA users get the SOTA BS-Rofo piano roformer on CUDA (see song_to_midi.py).
Everyone else (AMD/Intel GPUs on Windows — e.g. an RX 580) otherwise falls back
to a 20-40 min CPU separation. This runs an MDX-Net instrumental model on the
DmlExecutionProvider instead: the heavy conv runs on ANY DirectX 12 GPU, while
torch does the cheap STFT on CPU. Output is a vocal-removed instrumental wav for
Transkun to transcribe.

Quality is below the dedicated 6-stem piano roformer (this only strips vocals,
not drums/bass), but it turns a multi-minute CPU grind into seconds on the GPU.

CLI: separate_onnx_dml.py <input_audio> <output_dir>   (or --selfcheck)
Writes <output_dir>/<stem>_instrumental.wav and prints its path as "OUT|<path>".
"""
import os
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
import torch

# MDX-Net Inst_HQ_3 params (from UVR's model_data); the model IO is
# [batch, 4, dim_f, dim_t] = 2 stereo channels x (real, imag).
N_FFT, HOP, DIM_F, DIM_T, SR = 6144, 1024, 3072, 256, 44100
COMPENSATE = 1.018
CHUNK = HOP * (DIM_T - 1)   # 261120 samples per model window
TRIM = N_FFT // 2           # 3072; discarded edge of each window (overlap-add)
GEN = CHUNK - 2 * TRIM      # usable samples per window after trimming both edges

MODEL_NAME = "UVR-MDX-NET-Inst_HQ_3.onnx"


def _providers():
    import onnxruntime as ort
    avail = ort.get_available_providers()
    # DirectML = any DX12 GPU (AMD/Intel/NVIDIA); CPU is the universal fallback.
    return [p for p in ("DmlExecutionProvider", "CPUExecutionProvider") if p in avail]


class _STFT:
    """torch STFT matching UVR's MDX layout: (b,2,t) <-> (b,4,DIM_F,frames)."""

    def __init__(self):
        self.window = torch.hann_window(N_FFT, periodic=True)

    def forward(self, x):                       # (b, 2, t) -> (b, 4, DIM_F, frames)
        b = x.shape[:-2]
        c, t = x.shape[-2:]
        x = x.reshape(-1, t)
        x = torch.stft(x, N_FFT, HOP, window=self.window, center=True, return_complex=True)
        x = torch.view_as_real(x)               # (-1, n_bins, frames, 2)
        x = x.permute(0, 3, 1, 2)               # (-1, 2, n_bins, frames)
        x = x.reshape(*b, c * 2, x.shape[-2], x.shape[-1])
        return x[..., :DIM_F, :]

    def inverse(self, x):                        # (b, 4, DIM_F, frames) -> (b, 2, t)
        b = x.shape[:-3]
        c, f, t = x.shape[-3:]
        n = N_FFT // 2 + 1
        x = torch.cat([x, torch.zeros([*b, c, n - f, t])], -2)   # restore cropped top bin(s)
        x = x.reshape(-1, 2, n, t).permute(0, 2, 3, 1).contiguous()
        x = torch.view_as_complex(x)
        x = torch.istft(x, N_FFT, HOP, window=self.window, center=True)
        return x.reshape(*b, 2, -1)


def _load_stereo(path):
    wav, sr = sf.read(str(path), dtype="float32", always_2d=True)   # (n, ch)
    wav = wav.T
    if wav.shape[0] == 1:
        wav = np.concatenate([wav, wav], 0)
    elif wav.shape[0] > 2:
        wav = wav[:2]
    if sr != SR:
        import librosa
        wav = librosa.resample(wav, orig_sr=sr, target_sr=SR)
    return np.ascontiguousarray(wav)


def separate(in_path: Path, out_dir: Path, model_path: Path) -> Path:
    import onnxruntime as ort
    sess = ort.InferenceSession(str(model_path), providers=_providers())
    used = sess.get_providers()[0]
    print(f"  ONNX provider: {used}"
          + ("  (GPU)" if used == "DmlExecutionProvider" else "  (CPU fallback)"))
    in_name, out_name = sess.get_inputs()[0].name, sess.get_outputs()[0].name

    mix = _load_stereo(in_path)
    n = mix.shape[1]
    stft = _STFT()

    pad = GEN - n % GEN
    mixp = np.concatenate(
        [np.zeros((2, TRIM), np.float32), mix, np.zeros((2, pad + TRIM), np.float32)], 1)

    pieces = []
    i = 0
    while i < n + pad:
        chunk = torch.from_numpy(mixp[:, i:i + CHUNK])[None]      # (1, 2, CHUNK)
        spec = stft.forward(chunk).numpy()                        # (1, 4, DIM_F, DIM_T)
        pred = sess.run([out_name], {in_name: spec})[0]
        wave = stft.inverse(torch.from_numpy(pred))[0]            # (2, CHUNK)
        pieces.append(wave[:, TRIM:-TRIM].numpy())
        i += GEN

    inst = (np.concatenate(pieces, 1)[:, :n] * COMPENSATE).astype(np.float32)
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{in_path.stem}_instrumental.wav"
    sf.write(str(out), inst.T, SR)
    return out


def _selfcheck():
    # The reshape/permute chain is the easy thing to get wrong; verify forward+
    # inverse round-trips a random signal (cropping the single top bin loses a
    # sliver, so we check high correlation, not bit-exactness).
    stft = _STFT()
    x = torch.randn(1, 2, CHUNK)
    y = stft.inverse(stft.forward(x))
    m = min(x.shape[-1], y.shape[-1])
    a, b = x[..., :m].flatten(), y[..., :m].flatten()
    corr = torch.corrcoef(torch.stack([a, b]))[0, 1].item()
    assert corr > 0.99, f"STFT round-trip broken: corr={corr:.4f}"
    print(f"selfcheck OK (round-trip corr={corr:.4f})")


def main() -> int:
    if "--selfcheck" in sys.argv:
        _selfcheck()
        return 0
    if len(sys.argv) < 3:
        print("Usage: separate_onnx_dml.py <input_audio> <output_dir> [model_path]")
        return 1
    in_path = Path(sys.argv[1]).resolve()
    out_dir = Path(sys.argv[2]).resolve()
    model_path = Path(sys.argv[3]) if len(sys.argv) > 3 else Path(
        os.environ.get("MIDI_STUDIO_MODELS_DIR", ".")) / "onnx" / MODEL_NAME
    if not model_path.exists():
        print(f"Model not found: {model_path}")
        return 1
    out = separate(in_path, out_dir, model_path)
    print(f"OUT|{out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
