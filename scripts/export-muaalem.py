"""export-muaalem.py — muaalem (Layer 2) → ONNX + int8.

    python scripts/export-muaalem.py        # needs the quran-muaalem env

Writes models/muaalem/ (gitignored, ~2.8 GB with fp32 external data;
only muaalem-multilevel-int8.onnx + muaalem-meta.json are needed to run).

GATE: does muaalem survive leaving PyTorch?

Nothing about Layer 2 can ship until this works, so it runs before any
UI is written. Three questions, in order:

  1. Does Wav2Vec2BertForMultilevelCTC export to ONNX at all? It is a
     600M-parameter Conformer-style encoder; dynamic time axes and
     attention masks are where these exports usually break.
  2. Does the exported graph agree with PyTorch numerically? An export
     that runs but drifts is worse than one that fails loudly.
  3. How big is it after int8 dynamic quantization, and does the
     accuracy survive? (Measured separately by re-running the gate.)

ALL ELEVEN HEADS ARE EXPORTED, not just phonemes. Measured: the encoder
is 605,677,376 params and every head together is 76,875 — 0.0%. Dropping
the ten tajweed heads would save nothing, so the sifat feedback
(qalqala, ghunna, itbaq…) comes along for free.
"""
import json, os, time
import numpy as np
import torch
from quran_muaalem import Muaalem

OUT = "/Users/mohammed/Projects/m7mdiyat-vite/models/muaalem"
os.makedirs(OUT, exist_ok=True)

m = Muaalem(device="cpu")
# The package loads weights in its own dtype (half on some paths); CPU
# layer_norm refuses mixed precision, and ONNX export must be fp32 anyway
# — quantization comes later, from a clean fp32 graph.
print("loaded dtype:", m.dtype, flush=True)
model = m.model.eval().float()

# Level order is FIXED here and written alongside the model: ONNX outputs
# are positional, so the consumer needs this list to know which tensor is
# which head. Sorting keeps it stable across runs.
LEVELS = sorted(m.multi_level_tokenizer.id_to_vocab.keys())
VOCABS = {lv: m.multi_level_tokenizer.id_to_vocab[lv] for lv in LEVELS}
print("levels:", LEVELS, flush=True)
for lv in LEVELS:
    print(f"   {lv:<22} {len(VOCABS[lv])} classes", flush=True)


class PhonemeLevels(torch.nn.Module):
    """Flattens the dict output into a fixed tuple — ONNX has no dicts."""

    def __init__(self, inner, levels):
        super().__init__()
        self.inner = inner
        self.levels = levels

    def forward(self, input_features):
        out = self.inner(input_features=input_features, return_dict=False)[0]
        return tuple(out[lv] for lv in self.levels)


wrapper = PhonemeLevels(model, LEVELS).eval()

# A realistic dummy: the feature extractor emits [B, T, 160] for
# SeamlessM4T (80 mel bins, stacked in pairs). Probe it rather than
# assume, because the consumer has to reproduce this exactly.
probe = m.processor([np.zeros(16000 * 4, dtype=np.float32)], sampling_rate=16000, return_tensors="pt")
feat = probe["input_features"].float()
print(f"\nfeature extractor → {tuple(feat.shape)} {feat.dtype} "
      f"(for 4.0 s of audio ⇒ {feat.shape[1]/4:.1f} frames/s)", flush=True)
json.dump({
    "levels": LEVELS,
    "vocabs": {lv: (v if isinstance(v, list) else list(v)) for lv, v in VOCABS.items()},
    "featureDim": int(feat.shape[-1]),
    "framesPerSecond": float(feat.shape[1] / 4.0),
    "sampleRate": 16000,
}, open(f"{OUT}/muaalem-meta.json", "w"), ensure_ascii=False, indent=1)

with torch.no_grad():
    ref = wrapper(feat)
print("torch outputs:", [tuple(t.shape) for t in ref], flush=True)

fp32 = f"{OUT}/muaalem-multilevel.onnx"
print("\nexporting…", flush=True)
t0 = time.time()
torch.onnx.export(
    wrapper,
    (feat,),
    fp32,
    input_names=["input_features"],
    output_names=[f"logits_{lv}" for lv in LEVELS],
    dynamic_axes={"input_features": {0: "batch", 1: "frames"},
                  **{f"logits_{lv}": {0: "batch", 1: "out_frames"} for lv in LEVELS}},
    opset_version=17,          # well inside onnxruntime-web's support
    do_constant_folding=True,
    dynamo=False,
)
print(f"exported in {time.time()-t0:.0f}s → {os.path.getsize(fp32)/2**30:.2f} GB", flush=True)

# ---- parity: the export must AGREE, not merely run ----
import onnxruntime as ort
sess = ort.InferenceSession(fp32, providers=["CPUExecutionProvider"])
got = sess.run(None, {"input_features": feat.numpy()})
print("\nparity vs PyTorch (max abs diff per head):", flush=True)
worst = 0.0
for lv, a, b in zip(LEVELS, ref, got):
    d = float(np.abs(a.numpy() - b).max())
    worst = max(worst, d)
    print(f"   {lv:<22} {d:.3e}", flush=True)
print(f"   WORST {worst:.3e}  → {'OK' if worst < 1e-3 else 'DRIFT — do not ship'}", flush=True)

# ---- a different length, to prove the dynamic axis really is dynamic ----
p2 = m.processor([np.zeros(16000 * 8, dtype=np.float32)], sampling_rate=16000, return_tensors="pt")
g2 = sess.run(None, {"input_features": p2["input_features"].float().numpy()})
print(f"\n8 s input → {g2[0].shape} (dynamic time axis works)", flush=True)

print("\nquantizing int8…", flush=True)
from onnxruntime.quantization import quantize_dynamic, QuantType
int8 = f"{OUT}/muaalem-multilevel-int8.onnx"
t0 = time.time()
quantize_dynamic(fp32, int8, weight_type=QuantType.QInt8)
print(f"quantized in {time.time()-t0:.0f}s → {os.path.getsize(int8)/2**30:.2f} GB", flush=True)

s8 = ort.InferenceSession(int8, providers=["CPUExecutionProvider"])
g8 = s8.run(None, {"input_features": feat.numpy()})
print("\nint8 drift vs fp32 (max abs diff per head):", flush=True)
for lv, a, b in zip(LEVELS, ref, g8):
    print(f"   {lv:<22} {float(np.abs(a.numpy() - b).max()):.3e}", flush=True)

# argmax agreement matters more than raw drift — the decode is greedy
ph = LEVELS.index("phonemes")
a_ids = ref[ph].numpy().argmax(-1).ravel()
b_ids = np.asarray(g8[ph]).argmax(-1).ravel()
print(f"\nphoneme argmax agreement fp32 vs int8: "
      f"{(a_ids == b_ids).mean()*100:.2f}% of frames", flush=True)
# The vocabs written above come from id_to_vocab, which is a DICT
# {id: token} — list() on it yields the KEYS. Re-emit ordered by id, or
# every non-Python consumer decodes integers instead of phonemes.
vocabs = {}
for lv, d in m.multi_level_tokenizer.id_to_vocab.items():
    vocabs[lv] = [d[i] for i in sorted(d.keys())] if isinstance(d, dict) else list(d)
meta = json.load(open(f"{OUT}/muaalem-meta.json"))
meta["vocabs"] = vocabs
json.dump(meta, open(f"{OUT}/muaalem-meta.json", "w"), ensure_ascii=False, indent=1)
print("\nvocabs re-emitted ordered by id — e.g. phonemes[:6] =", vocabs["phonemes"][:6], flush=True)

print("\nNOTE: the argmax check above ran on SILENCE and proves nothing about", flush=True)
print("      accuracy. Verify on real recitation before trusting the int8 graph", flush=True)
print("      (measured 2026-07-26: 99.7% / 98.6% phoneme agreement vs PyTorch on", flush=True)
print("      golden 01-clean and mistakes-B; the differences are madd LENGTH,", flush=True)
print("      which the Layer-2 rules already discard as style).", flush=True)
print("\nDONE", flush=True)
