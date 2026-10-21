"""Dev tool: export the non-backbone Transkun v2 tensors for forge-rs.

Run inside the forge-env (needs torch + transkun + safetensors):
    python export_transkun_aux.py [out_dir]

transkun_v2.onnx covers backbone + interval scorer only. The Rust port
(forge-rs) does the rest natively and needs these fp32 tensors, written to
transkun_v2_aux.safetensors next to the ONNX model:

  frontend.windows    [6, 4096]    Hann + 5 learned Gaussian windows, exactly
                                   as Spectrum.forward builds them
  frontend.freq2mels  [2049, 229]  torchaudio mel filterbank buffer
  velocity.{0,3}.{weight,bias}     velocityPredictor  Linear-GELU-Linear
  refined_of.{0,3}.{weight,bias}   refinedOFPredictor Linear-GELU-Linear

Taking the windows and filterbank from torch (instead of recomputing them in
Rust) keeps the front-end constants bit-identical to the Python path.
"""
import json
import sys
from pathlib import Path

import torch
from safetensors.torch import save_file


def load_model():
    import moduleconf
    import transkun
    pretrained = Path(transkun.__file__).resolve().parent / "pretrained"
    confManager = moduleconf.parseFromFile(str(pretrained / "2.0.conf"))
    TransKun = confManager["Model"].module.TransKun
    conf = confManager["Model"].config
    ckpt = torch.load(str(pretrained / "2.0.pt"), map_location="cpu")
    model = TransKun(conf=conf)
    sd = ckpt.get("best_state_dict") or ckpt.get("state_dict") or ckpt
    model.load_state_dict(sd, strict=False)
    model.eval()
    return model, conf


def main():
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / "onnx_out"
    out_dir.mkdir(parents=True, exist_ok=True)
    model, conf = load_model()
    torch.set_grad_enabled(False)

    spec = model.framewiseFeatureExtractor.spectrogramExtractor
    if spec.nExtraWins > 0:
        windows = torch.cat([spec.win.unsqueeze(0), spec.winGen.get().t()], dim=0)
    else:
        windows = spec.win.unsqueeze(0)

    tensors = {
        "frontend.windows": windows,
        "frontend.freq2mels": model.framewiseFeatureExtractor.freq2mels,
    }
    for prefix, seq in (("velocity", model.velocityPredictor),
                        ("refined_of", model.refinedOFPredictor)):
        for idx in (0, 3):
            tensors[f"{prefix}.{idx}.weight"] = seq[idx].weight
            tensors[f"{prefix}.{idx}.bias"] = seq[idx].bias
        assert isinstance(seq[1], torch.nn.GELU) and seq[1].approximate == "none"
    tensors = {k: v.detach().to(torch.float32).contiguous().clone() for k, v in tensors.items()}

    meta = {
        "fs": str(conf.fs), "hopSize": str(conf.hopSize), "windowSize": str(conf.windowSize),
        "segmentSizeInSecond": str(conf.segmentSizeInSecond),
        "segmentHopSizeInSecond": str(conf.segmentHopSizeInSecond),
        "n_mels": str(conf.n_mels), "eps": str(model.framewiseFeatureExtractor.eps),
        "targetMIDIPitch": json.dumps(list(model.targetMIDIPitch)),
        "version": "transkun-v2-aux-1",
    }
    path = out_dir / "transkun_v2_aux.safetensors"
    save_file(tensors, str(path), metadata=meta)
    for k, v in tensors.items():
        print(f"{k:28s} {tuple(v.shape)}")
    print(f"OK -> {path}")


if __name__ == "__main__":
    main()
