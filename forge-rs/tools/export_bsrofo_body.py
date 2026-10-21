"""Export the BS-Roformer (BS-Rofo-SW-Fixed) network BODY to ONNX for forge-rs.

    python capped.py export_bsrofo_body.py MSST_DIR MODEL_DIR OUT.onnx [T_MAX] [T_TRACE]

STFT / mask multiply / iSTFT stay outside the graph (forge-rs does them).
  input  "spec" (1, T, 4100) = rearrange(view_as_real(stft), 'b s f t c -> b t (f s c)')
  output "mask" (1, 6, T, 4100), same layout, real/imag interleaved.

The time axis is dynamic up to T_MAX (default 1151: MSST's chunk_size
588800 at hop 512 with center=True, 1 + 588800 / 512); the rotary tables
are built for T_MAX and sliced to the input length. The trace runs at the
small T_TRACE (default 64): tracing at 1151 needs > 7.5 GiB (activations on
top of ~5.6 GiB of weight copies + protobuf serialisation), at 64 it fits.
The graph is the "dml" rewrite from
python-engine/export_roformer_onnx.py (<= 3-D matmuls, constant rotary
tables), plus one change: the time-axis attention runs in ATTN_GROUPS slices
of the (bands * heads) batch so ORT never holds the full
(496, T, T) score tensor (2.6 GB at T=1151) at once.

Memory discipline (the user's 8 GB rule): run under capped.py (7.5 GiB Job
Object), no ORT session in this process, checkpoint dict freed after load,
everything under torch.inference_mode / no_grad.
"""
import gc
import os
import sys
import time

os.environ["CUDA_VISIBLE_DEVICES"] = "-1"
import torch
import torch.nn.functional as F

MSST, MODEL_DIR, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
T = int(sys.argv[4]) if len(sys.argv) > 4 else 1151
T_TRACE = int(sys.argv[5]) if len(sys.argv) > 5 else 64
ATTN_GROUPS = int(os.environ.get("ATTN_GROUPS", "8"))
sys.path.insert(0, MSST)
torch.set_num_threads(8)

import yaml  # noqa: E402
from models.bs_roformer.bs_roformer import BSRoformer  # noqa: E402


class Loader(yaml.SafeLoader):
    pass


Loader.add_constructor("tag:yaml.org,2002:python/tuple", lambda l, n: tuple(l.construct_sequence(n)))
cfg = yaml.load(open(os.path.join(MODEL_DIR, "BS-Rofo-SW-Fixed.yaml"), encoding="utf-8"), Loader=Loader)
mcfg = dict(cfg["model"])

model = BSRoformer(**mcfg)
sd = torch.load(os.path.join(MODEL_DIR, "BS-Rofo-SW-Fixed.ckpt"), map_location="cpu", weights_only=False)
if isinstance(sd, dict) and "state_dict" in sd:
    sd = sd["state_dict"]
missing, unexpected = model.load_state_dict(sd, strict=False)
del sd
gc.collect()
assert not missing and not unexpected, (missing[:5], unexpected[:5])
model.eval()
for p in model.parameters():
    p.requires_grad_(False)
print("params: %.1fM  T_max=%d  T_trace=%d  attn_groups=%d" % (sum(p.numel() for p in model.parameters()) / 1e6, T, T_TRACE, ATTN_GROUPS))


# EXACT_ACT=1 spells Sigmoid / Tanh through Exp: ORT's CPU Sigmoid / Tanh are
# MLAS approximations (Sigmoid up to 1.5e-7 abs / 2% rel on tiny outputs,
# Tanh 3.3e-7 abs; torch ~3e-8). Measured on real music it does not matter:
# the network itself moves its masks by ~6e-5 for a 1e-7 relative input
# nudge, which swamps both, and stems came out the same (78.3 vs 78.3 dB
# SDR vs MSST). It also makes ORT session creation 3x slower (39 s vs 12 s),
# so it is off by default.
EXACT_ACT = os.environ.get("EXACT_ACT", "0") == "1"


def sigmoid(x):
    return 1.0 / (1.0 + torch.exp(-x)) if EXACT_ACT else torch.sigmoid(x)


def tanh(x):
    return 1.0 - 2.0 / (torch.exp(2.0 * x) + 1.0) if EXACT_ACT else torch.tanh(x)


def rms(x, gamma, scale):
    return F.normalize(x, dim=-1) * (scale * gamma)


def rope_tables(n, rot):
    seq = torch.arange(n, dtype=torch.float32)
    freqs = torch.einsum("i,f->if", seq, rot.freqs.float())
    freqs = freqs.repeat_interleave(2, dim=-1)
    return freqs.cos(), freqs.sin()


class Body(torch.nn.Module):
    def __init__(self, m, T):
        super().__init__()
        self.m = m
        self.nb = len(m.band_split.dim_inputs)
        dh = 64
        tc, ts = rope_tables(T, m.layers[0][0].layers[0][0].rotary_embed)
        fc, fs = rope_tables(self.nb, m.layers[0][1].layers[0][0].rotary_embed)
        self.register_buffer("tcos", tc)
        self.register_buffer("tsin", ts)
        self.register_buffer("fcos", fc)
        self.register_buffer("fsin", fs)
        R = torch.zeros(dh, dh)
        for i in range(0, dh, 2):
            R[i + 1, i] = -1.0
            R[i, i + 1] = 1.0
        self.register_buffer("R", R)

    def sdpa(self, q, k, v, cos, sin, groups):
        dh = q.shape[-1]
        n = q.shape[1]
        cos, sin = cos[:n], sin[:n]
        q = q * cos + torch.matmul(q, self.R) * sin
        k = k * cos + torch.matmul(k, self.R) * sin
        outs = []
        for qg, kg, vg in zip(q.chunk(groups, 0), k.chunk(groups, 0), v.chunk(groups, 0)):
            sim = torch.bmm(qg, kg.transpose(1, 2)) * (dh ** -0.5)
            outs.append(torch.bmm(sim.softmax(dim=-1), vg))
        return outs[0] if groups == 1 else torch.cat(outs, dim=0)

    def attn(self, a, x, cos, sin, groups):
        B, n, d = x.shape
        h, dh = a.heads, 64
        xn = rms(x, a.norm.gamma, a.norm.scale)
        qkv = F.linear(xn, a.to_qkv.weight)
        qkv = qkv.reshape(B, n, 3, h, dh).permute(2, 0, 3, 1, 4)
        q = qkv[0].reshape(B * h, n, dh)
        k = qkv[1].reshape(B * h, n, dh)
        v = qkv[2].reshape(B * h, n, dh)
        out = self.sdpa(q, k, v, cos, sin, groups)
        gates = sigmoid(F.linear(xn, a.to_gates.weight, a.to_gates.bias))
        out = out.reshape(B, h, n, dh) * gates.permute(0, 2, 1).unsqueeze(-1)
        out = out.permute(0, 2, 1, 3).reshape(B, n, h * dh)
        return F.linear(out, a.to_out[0].weight)

    def ff(self, f, x):
        net = f.net
        x = rms(x, net[0].gamma, net[0].scale)
        x = F.gelu(F.linear(x, net[1].weight, net[1].bias))
        return F.linear(x, net[4].weight, net[4].bias)

    def transformer(self, t, x, cos, sin, groups):
        for a, f in t.layers:
            x = self.attn(a, x, cos, sin, groups) + x
            x = self.ff(f, x) + x
        return x

    def forward(self, x):
        m = self.m
        bs = m.band_split
        parts = x[0].split(bs.dim_inputs, dim=-1)
        feats = [F.linear(rms(p, net[0].gamma, net[0].scale), net[1].weight, net[1].bias)
                 for p, net in zip(parts, bs.to_features)]
        x = torch.stack(feats, dim=1)                                   # (T, nb, d)
        for time_t, freq_t in m.layers:
            x = x.permute(1, 0, 2)                                      # (nb, T, d)
            x = self.transformer(time_t, x, self.tcos, self.tsin, ATTN_GROUPS)
            x = x.permute(1, 0, 2)                                      # (T, nb, d)
            x = self.transformer(freq_t, x, self.fcos, self.fsin, 1)
        x = rms(x, m.final_norm.gamma, m.final_norm.scale)
        bands = x.unbind(dim=1)
        stems = []
        for me in m.mask_estimators:
            outs = []
            for b, mlp in zip(bands, me.to_freqs):
                seq = mlp[0]
                h = tanh(F.linear(b, seq[0].weight, seq[0].bias))
                h = F.linear(h, seq[2].weight, seq[2].bias)
                half = h.shape[-1] // 2
                outs.append(h[:, :half] * sigmoid(h[:, half:]))
            stems.append(torch.cat(outs, dim=-1))
        return torch.stack(stems, dim=0).unsqueeze(0)                   # (1, N, T, Fin)


fin = sum(model.band_split.dim_inputs)
body = Body(model, T).eval()
torch.manual_seed(0)
x = torch.randn(1, T_TRACE, fin) * 0.5

if os.environ.get("CHECK_SMALL", "1") == "1":
    # cheap sanity of the rewrite vs the stock modules, at a small T
    Ts = 64
    xs = torch.randn(1, Ts, fin) * 0.5
    small = Body(model, Ts).eval()
    with torch.inference_mode():
        from einops import rearrange, pack, unpack
        y = model.band_split(xs)
        for time_t, freq_t in model.layers:
            y = rearrange(y, "b t f d -> b f t d")
            y, ps = pack([y], "* t d")
            y = time_t(y)
            y, = unpack(y, ps, "* t d")
            y = rearrange(y, "b f t d -> b t f d")
            y, ps = pack([y], "* f d")
            y = freq_t(y)
            y, = unpack(y, ps, "* f d")
        y = model.final_norm(y)
        ref = torch.stack([fn(y) for fn in model.mask_estimators], dim=1)
        alt = small(xs)
    print("rewrite vs stock (T=%d): max abs diff %.3e" % (Ts, (alt - ref).abs().max().item()))
    del small, ref, alt, y
    gc.collect()

t0 = time.time()


def export():
    torch.onnx.export(body, (x,), OUT, dynamo=False, opset_version=17,
                      input_names=["spec"], output_names=["mask"], do_constant_folding=True,
                      dynamic_axes={"spec": {1: "T"}, "mask": {2: "T"}})


with torch.inference_mode():
    export()
print("export OK in %.1fs -> %s (%.1f MB)" % (time.time() - t0, OUT, os.path.getsize(OUT) / 1e6))

try:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import memcap
    memcap.report()
except Exception:
    pass
