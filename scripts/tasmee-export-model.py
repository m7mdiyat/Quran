# tasmee-export-model.py — GATE 3 model-provenance parity check.
# STATUS 2026-07-10: DEFERRED — this Mac has only Python 3.9.6 (system)
# and NeMo requires >=3.10; installing a new system Python was out of
# scope for the timebox.
#
# ENVIRONMENT — USE A PYTHON 3.11 VENV, NOT THE SYSTEM PYTHON. The
# Windows aligner box runs 3.13.2, which is likely ALSO outside NeMo's
# supported range — don't hit the same wall twice:
#   py -3.11 -m venv nemo-export && nemo-export\Scripts\activate    (Windows)
#   python3.11 -m venv nemo-export && . nemo-export/bin/activate    (unix)
#   pip install "nemo_toolkit[asr]" onnx onnxruntime
# (If 3.11 is absent, install it standalone; do NOT retarget the recipe
# at whatever python happens to resolve.)
#
# Recipe (from the reference repo's README; parameters are facts):
#   FastConformer hybrid -> CTC decoding -> ONNX export -> uint8 dynamic quant.
#
# Pinned environment (FILL WHEN RUN):
#   python == 3.11.x   nemo_toolkit[asr] == ?
#   torch == ?         onnx == ?          onnxruntime == ?

import nemo.collections.asr as nemo_asr
from onnxruntime.quantization import QuantType, quantize_dynamic

m = nemo_asr.models.ASRModel.from_pretrained(
    "nvidia/stt_ar_fastconformer_hybrid_large_pcd_v1.0"
)
m.change_decoding_strategy(decoder_type="ctc")
m.export("fastconformer_ar_ctc.onnx")
quantize_dynamic(
    "fastconformer_ar_ctc.onnx",
    "fastconformer_ar_ctc_q8.onnx",
    weight_type=QuantType.QUInt8,
)

# Then:  shasum -a 256 fastconformer_ar_ctc_q8.onnx
# vs models/tasmee/checksums.txt (artifact-of-record:
# 7e7f9aaccbf0f7d12104ebfee9a99625195454a359821139a777f389ec928b50).
# NOTE: dynamic quantization is not guaranteed byte-deterministic across
# onnxruntime versions — hash equality CONFIRMS provenance; inequality
# does not refute it and requires an output-parity check instead (same
# fixed mel input -> compare logits within tolerance).
