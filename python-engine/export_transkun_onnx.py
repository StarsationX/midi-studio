"""Dev tool: export the Transkun 2.0.1 acoustic front-end to ONNX.

Run inside the forge-env (needs torch + transkun + onnx):
    python export_transkun_onnx.py [out_dir]

Exports `processFramesBatch` (gain norm + spectrogram + transformer backbone +
interval scorer) with THREE outputs — score, noise, ctx — unlike the
piano_trainer export this is based on, which dropped ctx and therefore lost
the velocity / refined onset-offset heads (their decoder hardcodes velocity
80). With ctx exported, transcribe_onnx_dml.py can run transkun's own
`transcribe()` end-to-end: ONNX backbone on DirectML, tiny heads + semi-CRF
decode on CPU torch.

Input:  frames [1, 1, T, windowSize]  (audio must be mono; makeFrame runs
        outside the graph — transcribe() already produces exactly this shape)
Output: score [T, T, 90], noise [T-1, 90], ctx [1, 90, T, D]

Weights are stored as external data named transkun_v2.onnx.data to match the
assets-release naming that download_assets.py expects.
"""
import json
import math
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

import torch

import moduleconf
from transkun.Util import makeFrame
from transkun.LayersTransformer import MultiHeadAttentionKernel

# SDPA doesn't export cleanly to ONNX; swap in manual matmul/softmax attention
# (numerically identical) before tracing — same idea as piano_trainer's export,
# with one extra constraint: DirectML rejects MatMul on tensors above 4-D
# ("The parameter is incorrect"), and this attention runs per pitch-symbol so
# its tensors are 5-D+. Flatten every matmul to 2-D/3-D and reshape back.
def _mm2(a, w):
    out = a.reshape(-1, a.shape[-1]) @ w
    return out.reshape(*a.shape[:-1], w.shape[-1])


def _bmm(a, b):
    lead = a.shape[:-2]
    out = torch.bmm(a.reshape(-1, *a.shape[-2:]), b.reshape(-1, *b.shape[-2:]))
    return out.reshape(*lead, *out.shape[-2:])


def _patched_attn_forward(self, query, key=None, value=None):
    if key is None:
        key = query
    if value is None:
        value = key
    q = _mm2(query, self.q_proj_weight)
    k = _mm2(key, self.k_proj_weight)
    v = _mm2(value, self.v_proj_weight)
    q = q.unflatten(-1, (self.num_heads, self.head_dim)).transpose(-2, -3)
    k = k.unflatten(-1, (self.num_heads, self.head_dim)).transpose(-2, -3)
    v = v.unflatten(-1, (self.num_heads, self.head_dim)).transpose(-2, -3)
    scale = 1.0 / math.sqrt(self.head_dim)
    attn = torch.softmax(_bmm(q, k.transpose(-2, -1)) * scale, dim=-1)
    fetched = _bmm(attn, v).transpose(-2, -3).flatten(-2, -1)
    out = self.out_proj(fetched.reshape(-1, fetched.shape[-1]))
    return out.reshape(*fetched.shape[:-1], out.shape[-1])


MultiHeadAttentionKernel.forward = _patched_attn_forward

# The interval scorer's einsum ("iped,ipbd->ipeb" — a plain q·kᵀ) exports as
# an ONNX Einsum node, which the DirectML EP fails to register at session
# init (AbiCustomRegistry "parameter is incorrect"). Same math via bmm.
from transkun.LayersTransformer import ScaledInnerProductIntervalScorer


def _patched_scorer_forward(self, ctx):
    q, k, diag = (self.map(ctx)).split(
        [self.size * self.expansionFactor, self.size * self.expansionFactor, 1],
        dim=-1)
    q = q / math.sqrt(q.shape[-1])
    S = _bmm(q, k.transpose(-1, -2))          # einsum("iped,ipbd->ipeb")
    tmpIdx_e = torch.arange(S.shape[-2], device=S.device)
    tmpIdx_b = torch.arange(S.shape[-1], device=S.device)
    len_eb = (tmpIdx_e.unsqueeze(-1) - tmpIdx_b.unsqueeze(0)).abs()
    if self.lengthScaling == "linear":
        S = S * len_eb
    elif self.lengthScaling == "sqrt":
        S = S * len_eb.float().sqrt()
    elif self.lengthScaling != "none":
        raise Exception("Unrecognized lengthScaling")
    # diag_embed isn't exportable at opset 17; d·I is the same diagonal matrix.
    d = diag.squeeze(-1)
    eye = torch.eye(d.shape[-1], dtype=d.dtype, device=d.device)
    S = S + d.unsqueeze(-1) * eye
    b = (diag * 0.0)[..., 1:, 0]
    return S.permute(2, 3, 0, 1).contiguous(), b.permute(2, 0, 1).contiguous()


ScaledInnerProductIntervalScorer.forward = _patched_scorer_forward

# Same DML 4-D limit applies to the mel filterbank projection, which sees the
# 5-D multi-window spectrogram. Identical math, flattened matmul.
from transkun.Util import MelSpectrum


def _patched_mel_forward(self, frames):
    spectrogram = self.spectrogramExtractor(frames)
    spectrogram = spectrogram.abs().pow(2)
    if self.toMono and len(spectrogram.shape) >= 4:
        spectrogram = spectrogram.mean(dim=-4, keepdim=True)
    mel = _mm2(spectrogram.transpose(-1, -2), self.freq2mels).transpose(-1, -2)
    if self.log:
        eps = self.eps
        mel = ((mel + eps).log() - math.log(eps)) / (-math.log(eps))
    return mel


MelSpectrum.forward = _patched_mel_forward


def load_model():
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


class AcousticFront(torch.nn.Module):
    """Backbone + interval scorer only. The spectrogram front-end (gain norm +
    windowed FFT + mel) runs in torch on CPU at runtime instead — it's
    millisecond-cheap, and the ONNX DFT op crashes the DirectML EP outright.
    Mirrors ModelTransformer.processFramesBatch after the feature extractor."""

    def __init__(self, m):
        super().__init__()
        assert m.useInnerProductScorer, "export assumes the inner-product scorer"
        self.m = m

    def forward(self, features):
        # features: framewiseFeatureExtractor output, viewed [nB*nCh, T, F, C]
        ctx = self.m.backbone(
            features,
            outputIndices=torch.tensor(self.m.targetMIDIPitch))
        S, S_skip = self.m.scorer(ctx)
        return S.flatten(-2, -1), S_skip.flatten(-2, -1), ctx


def frames_to_features(model, frames):
    """Gain norm + feature extraction, exactly as processFramesBatch does
    before the backbone (ModelTransformer.py:159-172)."""
    mean = torch.mean(frames, dim=[1, 2, 3], keepdim=True)
    std = torch.std(frames, dim=[1, 2, 3], keepdim=True)
    features = model.framewiseFeatureExtractor((frames - mean) / (std + 1e-8)).contiguous()
    return features.view(frames.shape[0] * 1, *features.shape[-3:])


def main():
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / "onnx_out"
    out_dir.mkdir(parents=True, exist_ok=True)
    onnx_path = out_dir / "transkun_v2.onnx"

    model, conf = load_model()
    # Gradient checkpointing is a no-op in eval and the TorchScript tracer
    # can't trace through CheckpointFunction — force the bypass path.
    model.backbone.useGradientCheckpoint = False
    wrapper = AcousticFront(model).eval()

    seg_samples = int(conf.segmentSizeInSecond * conf.fs)
    dummy_audio = torch.randn(1, seg_samples)          # mono slice [C=1, N]
    frames = makeFrame(dummy_audio, model.hopSize, model.windowSize).unsqueeze(0)
    with torch.no_grad():
        features = frames_to_features(model, frames)
    print(f"frames: {tuple(frames.shape)} -> features: {tuple(features.shape)}")

    with torch.no_grad():
        score, noise, ctx = wrapper(features)
    print(f"score {tuple(score.shape)}  noise {tuple(noise.shape)}  ctx {tuple(ctx.shape)}")

    # STATIC shapes on purpose: transcribe() zero-pads every slice to the full
    # 16 s segment, so T is always 691. Symbolic T makes the exporter emit
    # shape-arithmetic subgraphs whose dynamic Reshapes crash the DirectML EP
    # ("Application Error"); static shapes constant-fold all of that away.
    # Legacy TorchScript exporter (dynamo=False), static shapes, opset 17:
    # the dynamo exporter's graphs crash the DirectML EP in several distinct
    # ways (5-D fused matmuls, CastLike, shape-chain reshapes, and finally an
    # opaque init failure). The legacy exporter emits the same battle-tested
    # graph style as the UVR/MDX models that DML runs fine.
    torch.onnx.export(
        wrapper, (features,), str(onnx_path),
        input_names=["features"], output_names=["score", "noise", "ctx"],
        opset_version=17, do_constant_folding=True, dynamo=False,
    )

    # The dynamo exporter emits ONNX local functions, which crash the DirectML
    # EP at session init (AbiCustomRegistry "parameter is incorrect"). Inline
    # everything into a flat graph, then repack weights as external data under
    # the release-asset name.
    import os
    import onnx
    from onnx.inliner import inline_local_functions
    m = onnx.load(str(onnx_path))          # pulls external data into memory
    m = inline_local_functions(m)

    # optimize=False leaves CastLike nodes in the graph; the DirectML EP has
    # no kernel for them and dies at session init. Rewrite to plain Cast with
    # the target dtype resolved from the "like" operand.
    inferred = onnx.shape_inference.infer_shapes(m, data_prop=True)
    dtypes = {vi.name: vi.type.tensor_type.elem_type
              for vi in list(inferred.graph.value_info)
              + list(inferred.graph.input) + list(inferred.graph.output)}
    for init_t in m.graph.initializer:
        dtypes[init_t.name] = init_t.data_type
    n_castlike = 0
    for node in m.graph.node:
        if node.op_type == "CastLike":
            to = dtypes.get(node.input[1])
            assert to, f"cannot resolve dtype of {node.input[1]} for {node.name}"
            node.op_type = "Cast"
            del node.input[1]
            del node.attribute[:]
            node.attribute.append(onnx.helper.make_attribute("to", to))
            n_castlike += 1
    print(f"rewrote {n_castlike} CastLike -> Cast")
    # onnx resolves the external-data location against the CWD, not the model
    # dir — chdir so the exists-check and the write both land in out_dir.
    cwd = os.getcwd()
    os.chdir(out_dir)
    try:
        # optimize=False leaves constant-foldable shape chains
        # (Shape→Concat→Reshape) in the graph; DML dies on them at init.
        # Fold with ORT's BASIC level — ONNX-compliant, no matmul re-fusion.
        import onnxruntime as ort
        Path("_prefold.onnx.data").unlink(missing_ok=True)
        onnx.save_model(m, "_prefold.onnx", save_as_external_data=True,
                        all_tensors_to_one_file=True,
                        location="_prefold.onnx.data", size_threshold=1024)
        so = ort.SessionOptions()
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
        so.optimized_model_filepath = "_folded.onnx"
        ort.InferenceSession("_prefold.onnx", so, providers=["CPUExecutionProvider"])
        m = onnx.load("_folded.onnx")
        for f in ("_prefold.onnx", "_prefold.onnx.data", "_folded.onnx"):
            Path(f).unlink(missing_ok=True)

        Path("transkun_v2.onnx.data").unlink(missing_ok=True)
        onnx.save_model(m, "transkun_v2.onnx", save_as_external_data=True,
                        all_tensors_to_one_file=True,
                        location="transkun_v2.onnx.data", size_threshold=1024)
    finally:
        os.chdir(cwd)

    # Guard: DirectML rejects MatMul with >4-D inputs and ONNX functions —
    # fail the export loudly if either ever sneaks back in.
    checked = onnx.shape_inference.infer_shapes(onnx.load(str(onnx_path)), data_prop=True)
    assert len(checked.functions) == 0, "local functions present — DML will fail at init"
    rank = {vi.name: len(vi.type.tensor_type.shape.dim)
            for vi in list(checked.graph.value_info) + list(checked.graph.input)
            + list(checked.graph.output)}
    for init in checked.graph.initializer:
        rank[init.name] = len(init.dims)
    offenders = [n.name for n in checked.graph.node
                 if n.op_type in ("MatMul", "Gemm")
                 and any(rank.get(i, -1) > 4 for i in n.input)]
    assert not offenders, f">4-D matmuls present (DML-incompatible): {offenders}"
    assert not any(n.op_type == "Einsum" for n in checked.graph.node), "Einsum present"

    json.dump({
        "fs": conf.fs, "hopSize": conf.hopSize, "windowSize": conf.windowSize,
        "segmentSizeInSecond": conf.segmentSizeInSecond,
        "segmentHopSizeInSecond": conf.segmentHopSizeInSecond,
        "targetMIDIPitch": list(model.targetMIDIPitch),
        "input_samples": seg_samples, "T": int(score.shape[0]),
        "input": "features", "outputs": ["score", "noise", "ctx"],
        "version": "v2-ctx-features",
    }, open(out_dir / "transkun_v2_config.json", "w"), indent=2)

    # Numerical sanity: ONNX (CPU EP) vs the patched torch model. Scores are
    # large-magnitude logits and op-fusion reorders float math, so judge the
    # RELATIVE error; end-to-end MIDI equivalence is the real acceptance gate.
    import onnxruntime as ort
    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    o_score, o_noise, o_ctx = sess.run(None, {"features": features.numpy()})
    worst = 0.0
    for name, a, b in (("score", score, o_score), ("noise", noise, o_noise), ("ctx", ctx, o_ctx)):
        diff = (a - torch.from_numpy(b)).abs().max().item()
        scale = max(a.abs().max().item(), 1e-6)
        rel = diff / scale
        worst = max(worst, rel)
        print(f"max|torch-onnx| {name}: {diff:.2e}  (rel {rel:.2e}, scale {scale:.1f})")
    assert worst < 0.05, f"outputs diverged badly (rel {worst:.2e})"
    print(f"OK -> {onnx_path}")


if __name__ == "__main__":
    main()
