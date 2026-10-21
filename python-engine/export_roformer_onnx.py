"""CPU-only feasibility export of the BS-Roformer network body (STFT/iSTFT excluded).

Two variants:
  stock : trace the original modules as-is (shows what the legacy exporter does with them)
  dml   : rewritten forward - <=3-D matmuls, precomputed rotary cos/sin, manual softmax attention
Input  : spec features (1, T, F*S*2) = rearrange(view_as_real(stft), 'b s f t c -> b t (f s c)')
Output : masks (1, N, T, F*S*2) same layout, real/imag interleaved.
"""
import os, sys, time, math, json
os.environ["CUDA_VISIBLE_DEVICES"] = "-1"
import torch
import torch.nn.functional as F

MSST = sys.argv[1]
MODEL_DIR = sys.argv[2]
OUT = sys.argv[3]
T = int(sys.argv[4]) if len(sys.argv) > 4 else 256
VARIANTS = sys.argv[5].split(",") if len(sys.argv) > 5 else ["stock", "dml"]
sys.path.insert(0, MSST)
torch.set_num_threads(8)

import yaml
from models.bs_roformer.bs_roformer import BSRoformer

class Loader(yaml.SafeLoader):
    pass
Loader.add_constructor("tag:yaml.org,2002:python/tuple", lambda l, n: tuple(l.construct_sequence(n)))
cfg = yaml.load(open(os.path.join(MODEL_DIR, "BS-Rofo-SW-Fixed.yaml"), encoding="utf-8"), Loader=Loader)
mcfg = dict(cfg["model"])
print("model cfg:", {k: v for k, v in mcfg.items() if k != "freqs_per_bands"}, "bands:", len(mcfg["freqs_per_bands"]))

model = BSRoformer(**mcfg)
sd = torch.load(os.path.join(MODEL_DIR, "BS-Rofo-SW-Fixed.ckpt"), map_location="cpu", weights_only=False)
if isinstance(sd, dict) and "state_dict" in sd:
    sd = sd["state_dict"]
missing, unexpected = model.load_state_dict(sd, strict=False)
print("missing:", len(missing), "unexpected:", len(unexpected), missing[:5], unexpected[:5])
model.eval()
nparams = sum(p.numel() for p in model.parameters())
print("params: %.1fM" % (nparams / 1e6))


def rms(x, gamma, scale):
    return F.normalize(x, dim=-1) * (scale * gamma)


class StockBody(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, x):
        m = self.m
        from einops import rearrange, pack, unpack
        x = m.band_split(x)
        for time_t, freq_t in m.layers:
            x = rearrange(x, 'b t f d -> b f t d')
            x, ps = pack([x], '* t d')
            x = time_t(x)
            x, = unpack(x, ps, '* t d')
            x = rearrange(x, 'b f t d -> b t f d')
            x, ps = pack([x], '* f d')
            x = freq_t(x)
            x, = unpack(x, ps, '* f d')
        x = m.final_norm(x)
        return torch.stack([fn(x) for fn in m.mask_estimators], dim=1)


def rope_tables(n, dim_head, rot):
    seq = torch.arange(n, dtype=torch.float32)
    freqs = torch.einsum('i,f->if', seq, rot.freqs.float())
    freqs = freqs.repeat_interleave(2, dim=-1)  # (n, d)
    return freqs.cos(), freqs.sin()


class DmlBody(torch.nn.Module):
    """Same math, every matmul <= 3-D, rotary as constant tables, rotate_half as a constant matmul."""
    def __init__(self, m, T):
        super().__init__()
        self.m = m
        self.T = T
        self.nb = len(m.band_split.dim_inputs)
        dh = 64
        tr = m.layers[0][0].layers[0][0].rotary_embed
        fr = m.layers[0][1].layers[0][0].rotary_embed
        tc, ts = rope_tables(T, dh, tr)
        fc, fs = rope_tables(self.nb, dh, fr)
        self.register_buffer("tcos", tc); self.register_buffer("tsin", ts)
        self.register_buffer("fcos", fc); self.register_buffer("fsin", fs)
        # rotate_half(x) = x @ R : pairs (x0,x1) -> (-x1, x0)
        R = torch.zeros(dh, dh)
        for i in range(0, dh, 2):
            R[i + 1, i] = -1.0
            R[i, i + 1] = 1.0
        self.register_buffer("R", R)

    def attn(self, a, x, cos, sin):
        # x: (B, n, d) 3-D
        B, n, d = x.shape
        h, dh = a.heads, 64
        xn = rms(x, a.norm.gamma, a.norm.scale)
        qkv = F.linear(xn, a.to_qkv.weight)                       # (B,n,3*h*dh)
        qkv = qkv.reshape(B, n, 3, h, dh).permute(2, 0, 3, 1, 4)   # (3,B,h,n,dh)
        q = qkv[0].reshape(B * h, n, dh)
        k = qkv[1].reshape(B * h, n, dh)
        v = qkv[2].reshape(B * h, n, dh)
        q = q * cos + torch.matmul(q, self.R) * sin
        k = k * cos + torch.matmul(k, self.R) * sin
        sim = torch.bmm(q, k.transpose(1, 2)) * (dh ** -0.5)
        out = torch.bmm(sim.softmax(dim=-1), v)                    # (B*h, n, dh)
        gates = F.linear(xn, a.to_gates.weight, a.to_gates.bias).sigmoid()  # (B,n,h)
        out = out.reshape(B, h, n, dh) * gates.permute(0, 2, 1).unsqueeze(-1)
        out = out.permute(0, 2, 1, 3).reshape(B, n, h * dh)
        return F.linear(out, a.to_out[0].weight)

    def ff(self, f, x):
        net = f.net
        x = rms(x, net[0].gamma, net[0].scale)
        x = F.gelu(F.linear(x, net[1].weight, net[1].bias))
        return F.linear(x, net[4].weight, net[4].bias)

    def transformer(self, t, x, cos, sin):
        for a, f in t.layers:
            x = self.attn(a, x, cos, sin) + x
            x = self.ff(f, x) + x
        return x

    def forward(self, x):
        m, T, nb = self.m, self.T, self.nb
        # band split: x (1, T, Fin) -> (T, nb, d)
        bs = m.band_split
        parts = x[0].split(bs.dim_inputs, dim=-1)
        feats = [F.linear(rms(p, net[0].gamma, net[0].scale), net[1].weight, net[1].bias)
                 for p, net in zip(parts, bs.to_features)]
        x = torch.stack(feats, dim=1)                              # (T, nb, d)
        for time_t, freq_t in m.layers:
            x = x.permute(1, 0, 2)                                 # (nb, T, d)
            x = self.transformer(time_t, x, self.tcos, self.tsin)
            x = x.permute(1, 0, 2)                                 # (T, nb, d)
            x = self.transformer(freq_t, x, self.fcos, self.fsin)
        x = rms(x, m.final_norm.gamma, m.final_norm.scale)
        bands = x.unbind(dim=1)                                    # nb x (T, d)
        stems = []
        for me in m.mask_estimators:
            outs = []
            for b, mlp in zip(bands, me.to_freqs):
                seq = mlp[0]
                h = torch.tanh(F.linear(b, seq[0].weight, seq[0].bias))
                h = F.linear(h, seq[2].weight, seq[2].bias)
                half = h.shape[-1] // 2  # GLU as Slice/Slice, not Split (ORT #32146: DML fuses Split->Sigmoid->Mul wrong)
                outs.append(h[:, :half] * torch.sigmoid(h[:, half:]))
            stems.append(torch.cat(outs, dim=-1))
        return torch.stack(stems, dim=0).unsqueeze(0)              # (1, N, T, Fin)


fin = sum(model.band_split.dim_inputs)
torch.manual_seed(0)
x = torch.randn(1, T, fin) * 0.5
print("input", tuple(x.shape))

results = {}
with torch.inference_mode():
    t0 = time.time(); ref = StockBody(model)(x); t_ref = time.time() - t0
print("torch stock fwd %.2fs out %s" % (t_ref, tuple(ref.shape)))

# sanity: full model forward from raw audio vs body on real stft features (layout check)
with torch.inference_mode():
    L = (T - 1) * 512
    audio = torch.randn(1, 2, L) * 0.1
    full = model(audio)                                            # (1, N, 2, L)
    win = torch.hann_window(2048)
    st = torch.stft(audio.reshape(2, L), 2048, 512, 2048, win, return_complex=True)  # (2, F, T)
    st = torch.view_as_real(st).permute(2, 1, 0, 3).reshape(1, st.shape[2], -1)  # b t (f s c)
    mk = StockBody(model)(st)                                      # (1,N,T,Fin)
    spec = torch.view_as_complex(st.reshape(1, 1, -1, 1025 * 2, 2).contiguous())  # (1,1,T,(f s))
    mask = torch.view_as_complex(mk.reshape(1, 6, -1, 1025 * 2, 2).contiguous())
    y = (spec * mask).reshape(1, 6, -1, 1025, 2).permute(0, 1, 4, 3, 2).reshape(12, 1025, -1)
    y[:, 0] = 0
    rec = torch.istft(y, 2048, 512, 2048, win, length=L).reshape(1, 6, 2, L)
    print("layout check (external stft/istft vs model()): max abs diff %.3e" % (rec - full).abs().max().item())

for var in VARIANTS:
    body = StockBody(model) if var == "stock" else DmlBody(model, T)
    body.eval()
    if var == "dml":
        with torch.inference_mode():
            alt = body(x)
        print("dml rewrite vs stock torch: max abs diff %.3e" % (alt - ref).abs().max().item())
    path = os.path.join(OUT, f"bsrofo_body_{var}_T{T}.onnx")
    t0 = time.time()
    try:
        torch.onnx.export(body, (x,), path, dynamo=False, opset_version=17,
                          input_names=["spec"], output_names=["mask"], do_constant_folding=True)
        print(f"[{var}] export OK in %.1fs -> {path}" % (time.time() - t0))
    except Exception as e:
        import traceback; traceback.print_exc()
        print(f"[{var}] export FAILED: {type(e).__name__}: {str(e)[:500]}")
        continue
    import onnx
    mdl = onnx.load(path, load_external_data=False)
    ops = {}
    for n in mdl.graph.node:
        ops[n.op_type] = ops.get(n.op_type, 0) + 1
    print(f"[{var}] nodes={len(mdl.graph.node)} ops={dict(sorted(ops.items(), key=lambda kv: -kv[1]))}")
    # max matmul input rank via shape inference
    try:
        inf = onnx.shape_inference.infer_shapes_path(path, path + ".shapes.onnx")
        mi = onnx.load(path + ".shapes.onnx", load_external_data=False)
        ranks = {vi.name: len(vi.type.tensor_type.shape.dim) for vi in list(mi.graph.value_info) + list(mi.graph.input)}
        for ini in mi.graph.initializer:
            ranks[ini.name] = len(ini.dims)
        mm = [max(ranks.get(i, -1) for i in n.input) for n in mi.graph.node if n.op_type in ("MatMul", "Gemm", "Einsum")]
        hist = {}
        for r in mm: hist[r] = hist.get(r, 0) + 1
        print(f"[{var}] matmul max-input-rank histogram: {hist}")
        os.remove(path + ".shapes.onnx")
    except Exception as e:
        print(f"[{var}] shape inference skipped: {e}")
    import onnxruntime as ort
    so = ort.SessionOptions(); so.intra_op_num_threads = 8
    sess = ort.InferenceSession(path, so, providers=["CPUExecutionProvider"])
    t0 = time.time(); o = sess.run(None, {"spec": x.numpy()})[0]; t1 = time.time() - t0
    t0 = time.time(); o = sess.run(None, {"spec": x.numpy()})[0]; t2 = time.time() - t0
    d = abs(o - ref.numpy()).max()
    print(f"[{var}] ORT CPU run1 %.2fs run2 %.2fs | torch CPU %.2fs | max abs diff vs torch %.3e (ref max %.3f)" % (t1, t2, t_ref, d, abs(ref.numpy()).max()))
    print(f"[{var}] file size %.1f MB" % (sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT) if f.startswith(os.path.basename(path))) / 1e6))
