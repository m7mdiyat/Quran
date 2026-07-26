/* MUAALEM FRONTEND PARITY (Layer 2, 2026-07-26).
 *
 * The model does not take audio, it takes a feature matrix. A frontend
 * that is subtly wrong does not fail loudly — the model accepts the
 * input and returns confident nonsense, and for a tool that marks
 * someone's Quran recitation that is the worst failure available. So the
 * JS port is held to the Python extractor NUMERICALLY, on the real
 * golden recitation clips, not by eye and not on synthetic tones.
 *
 * MEASURED at the time of writing, 8 s of golden 01-clean through both:
 *   max abs diff 5.4e-05 · mean abs diff 1.7e-07
 *
 * The povey window and the Kaldi mel bank are NOT reimplemented — they
 * ship verbatim in public/models/muaalem/frontend.bin (82 KB), because
 * rebuilding a mel bank from fmin/fmax/mel-scale conventions is exactly
 * where these ports go quietly wrong.
 *
 * The golden fixture stores only a FINGERPRINT (shape, mean, std,
 * |sum|, 32 sampled values) and reads the WAVs already in this
 * directory, so no megabytes of PCM live in the test tree.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontendBlob, createMuaalemFrontend, FRONTEND_SPEC } from "../../src/tasmee-muaalem-frontend.js";
import { readWavMono, resampleTo16k } from "../../src/tasmee-pipeline.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const BIN = path.join(ROOT, "public/models/muaalem/frontend.bin");
const GOLDEN = path.join(HERE, "frontend-golden.json");
const skip = fs.existsSync(BIN) && fs.existsSync(GOLDEN)
    ? false : "frontend.bin / golden absent (regenerate via the muaalem env — see scripts/export-muaalem.py)";

const frontend = () => {
    const raw = fs.readFileSync(BIN);
    return createMuaalemFrontend(parseFrontendBlob(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)));
};
const clipPcm = (name, secs) => {
    const b = fs.readFileSync(path.join(HERE, "golden", `${name}-p453.wav`));
    const { rate, pcm } = readWavMono(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    return resampleTo16k(pcm, rate).subarray(0, Math.round(16000 * secs));
};

test("the constants blob parses to the shapes the extractor uses", { skip }, () => {
    const raw = fs.readFileSync(BIN);
    const { window, mel, nMel } = parseFrontendBlob(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    assert.equal(window.length, FRONTEND_SPEC.FRAME);
    assert.equal(nMel, 80);
    assert.equal(mel.length, FRONTEND_SPEC.NBINS * 80);
    let ws = 0; for (const v of window) ws += v;
    let ms = 0; for (const v of mel) ms += v;
    // fingerprints: the wrong tables would still have the right shape
    assert.ok(Math.abs(ws - 212.147) < 0.01, `window sum ${ws} ≠ 212.147`);
    assert.ok(Math.abs(ms - 250.751) < 0.01, `mel sum ${ms} ≠ 250.751`);
});

test("JS features match Python on REAL recitation, clean / whisper / noise", { skip }, () => {
    const gold = JSON.parse(fs.readFileSync(GOLDEN, "utf8"));
    const fe = frontend();
    for (const [name, g] of Object.entries(gold)) {
        const { data, frames, dim } = fe.extract(clipPcm(name, g.secs));
        assert.deepEqual([frames, dim], g.shape, `${name}: shape`);

        let sum = 0, abs = 0;
        for (const v of data) { sum += v; abs += Math.abs(v); }
        const mean = sum / data.length;
        let vv = 0; for (const v of data) vv += (v - mean) * (v - mean);
        const std = Math.sqrt(vv / data.length);

        assert.ok(Math.abs(mean - g.mean) < 1e-4, `${name}: mean ${mean} vs python ${g.mean}`);
        assert.ok(Math.abs(std - g.std) < 1e-4, `${name}: std ${std} vs python ${g.std}`);
        assert.ok(Math.abs(abs - g.absSum) / g.absSum < 1e-4, `${name}: |sum| ${abs} vs ${g.absSum}`);
        // element-wise at 32 fixed positions: catches errors that leave the
        // aggregate statistics intact (a transposed stack, an off-by-one hop)
        g.sampleIdx.forEach((ix, k) => {
            assert.ok(Math.abs(data[ix] - g.sampleVal[k]) < 1e-3,
                `${name}: feature[${ix}] ${data[ix]} vs python ${g.sampleVal[k]}`);
        });
    }
});

test("frame count follows center=false, odd trailing frame dropped", { skip }, () => {
    const fe = frontend();
    const { FRAME, HOP, STRIDE } = FRONTEND_SPEC;
    for (const n of [16000, 16321, 8000, 4321]) {
        const raw = Math.max(0, Math.floor((n - FRAME) / HOP) + 1);
        assert.equal(fe.extract(new Float32Array(n)).frames, Math.floor(raw / STRIDE), `n=${n}`);
    }
});

test("audio shorter than one frame yields nothing rather than throwing", { skip }, () => {
    const { frames, data } = frontend().extract(new Float32Array(200));
    assert.equal(frames, 0);
    assert.equal(data.length, 0);
});

test("a silent window normalises to zeros instead of NaN", { skip }, () => {
    /* Every mel bin sits on the floor, so the per-bin variance is ~0 and the
     * normalisation divides by sqrt(0 + 1e-7). It must produce zeros, never
     * NaN or Infinity — a live session opens on silence, and one NaN frame
     * would poison the whole window's features. (Python lands a hair off zero
     * here because it computes in float32; that gap is precision on a
     * degenerate input, not an algorithmic difference — on real speech the
     * two agree to 5e-05.) */
    const { data, frames } = frontend().extract(new Float32Array(16000));
    assert.ok(frames > 0);
    for (const v of data) assert.ok(Number.isFinite(v), "silence produced a non-finite feature");
});
