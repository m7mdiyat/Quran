/* ============================================================
 * tasmee-parity.mjs — GATE 3: onnxruntime-node vs onnxruntime-web
 * (WASM) parity checksum.
 *
 *   node scripts/tasmee-parity.mjs <clip.wav> [--model <path>]
 *
 * One clip → one mel tensor (src/tasmee-pipeline.js — the same
 * bytes the bench and the dev-harness worker run) → the SAME
 * [1,80,T] input through both backends → greedy token-id sequences
 * → sha256 compare. Token-level equality is the meaningful parity
 * bar (logit floats may differ in the last bits between backends);
 * on mismatch the script reports differing frame count + first
 * divergence instead of a bare FAIL. WASM runs numThreads=1 (the
 * WebView constraint) — its forward time is the first browser-class
 * RTF datapoint for the §5 profiling question.
 * ============================================================ */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { readWavMono, resampleTo16k, melFrontend, makeGreedyDecoder, NMEL } from "../src/tasmee-pipeline.js";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const clipPath = args.find((a) => !a.startsWith("--"));
if (!clipPath) { console.error("usage: node scripts/tasmee-parity.mjs <clip.wav> [--model <path>]"); process.exit(2); }
const argVal = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const MODEL_PATH = argVal("--model") || path.join(ROOT, "models", "tasmee", "fastconformer_ar_ctc_q8pc-head.onnx"); // record artifact since 2026-07-11
const VOCAB_PATH = path.join(path.dirname(MODEL_PATH), "vocab.json");
/* Re-export instrument (2026-07-11, per the re-export ruling):
 * --model-b <path>  cross-MODEL parity — the logit-parity guard that a
 *   re-quantized export still matches the reference (word-level bar;
 *   frame jitter reported, not bound — different quantizations
 *   legitimately jitter frames), PLUS model B's OWN node↔wasm runtime
 *   stability (the adoption point: the record model fails it on short
 *   windows; the re-export must not).
 * --window a-b  seconds; run parity on a short subsegment instead of
 *   the full clip — short-context marginality is where the truncation
 *   instability actually shows (full-clip context can mask it). */
const MODEL_B = argVal("--model-b");
const WINDOW = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(argVal("--window") || "");

const vocabJson = JSON.parse(fs.readFileSync(VOCAB_PATH, "utf8"));
const VOCAB = [];
for (const [id, tok] of Object.entries(vocabJson)) VOCAB[Number(id)] = tok;
const BLANK = VOCAB.indexOf("<blank>") >= 0 ? VOCAB.indexOf("<blank>") : VOCAB.length - 1;
const GREEDY = makeGreedyDecoder(VOCAB, BLANK);

/* ---------- shared input ---------- */
const fileBuf = fs.readFileSync(clipPath);
const { rate, pcm: raw } = readWavMono(fileBuf.buffer.slice(fileBuf.byteOffset, fileBuf.byteOffset + fileBuf.byteLength));
let pcm = resampleTo16k(raw, rate);
if (WINDOW) {
    const a = Math.floor(Number(WINDOW[1]) * 16000), b = Math.min(pcm.length, Math.floor(Number(WINDOW[2]) * 16000));
    pcm = pcm.subarray(a, b);
    console.log(`window: ${WINDOW[1]}–${WINDOW[2]}s (short-context probe)`);
}
const durS = pcm.length / 16000;
const { mel, T } = melFrontend(pcm);
console.log(`clip: ${path.basename(clipPath)} — ${durS.toFixed(1)}s → mel [1,${NMEL},${T}]`);
console.log(`model: ${path.basename(MODEL_PATH)}${MODEL_B ? ` vs ${path.basename(MODEL_B)}` : ""}`);

async function runBackend(name, ort, opts = {}, modelPath = MODEL_PATH) {
    const t0 = performance.now();
    // bytes, not a path — ort-web's loader has no filesystem path support
    // under node (ort-node accepts either; bytes keeps the call uniform).
    const sess = await ort.InferenceSession.create(new Uint8Array(fs.readFileSync(modelPath)), opts);
    const loadMs = performance.now() - t0;
    const feeds = {
        audio_signal: new ort.Tensor("float32", mel, [1, NMEL, T]),
        length: new ort.Tensor("int64", BigInt64Array.from([BigInt(T)]), [1]),
    };
    const t1 = performance.now();
    const out = await sess.run(feeds);
    const fwdMs = performance.now() - t1;
    const lp = out[sess.outputNames[0]];
    const { words, frameIds } = GREEDY(lp.data, lp.dims[1], lp.dims[2], 0);
    const sha = crypto.createHash("sha256").update(frameIds.join(",")).digest("hex");
    console.log(`\n[${name}] load ${loadMs.toFixed(0)}ms · forward ${fwdMs.toFixed(0)}ms · RTF ${(fwdMs / 1000 / durS).toFixed(3)}`);
    console.log(`[${name}] frames ${lp.dims[1]} · token-seq sha256 ${sha.slice(0, 16)}…`);
    console.log(`[${name}] transcript: ${words.map((w) => w.text).join(" ")}`);
    if (typeof sess.release === "function") await sess.release();
    return { frameIds, sha, words };
}

/* ---------- backends ---------- */
const ortNode = require("onnxruntime-node");
const ortWeb = require("onnxruntime-web");
ortWeb.env.wasm.numThreads = 1; // the WebView constraint
ortWeb.env.wasm.wasmPaths = path.join(ROOT, "node_modules", "onnxruntime-web", "dist") + path.sep;
const WASM_OPTS = { executionProviders: ["wasm"] };

const nodeRes = await runBackend(MODEL_B ? "A/node" : "node", ortNode);
const wasmRes = await runBackend(MODEL_B ? "A/wasm" : "wasm", ortWeb, WASM_OPTS);

/* ---------- comparison ----------
 * RATIFIED CONTRACT (2026-07-10): parity is WORD-LEVEL, not
 * checksum — cross-backend float non-determinism makes bit-exactness
 * the wrong contract; word sequence is what the engine consumes.
 * Pinned regression bound for SAME-model node↔wasm, asserted on EVERY
 * run (and re-run on any ORT version bump): frame-level token mismatch
 * ≤ 2% AND zero word-level diffs. Cross-MODEL comparison (--model-b)
 * binds the WORD level only — different quantizations legitimately
 * jitter frames, so the rate is reported, not bound. */
const FRAME_MISMATCH_BOUND = 0.02;
let failed = false;
function compare(label, a, b, { bindFrames }) {
    const wordsEqual = a.words.map((w) => w.text).join(" ") === b.words.map((w) => w.text).join(" ");
    let diff = 0, first = -1;
    const n = Math.min(a.frameIds.length, b.frameIds.length);
    for (let i = 0; i < n; i++) {
        if (a.frameIds[i] !== b.frameIds[i]) { diff++; if (first < 0) first = i; }
    }
    const frameRate = n ? diff / n : 0;
    console.log(`\n[${label}] frame mismatch ${diff}/${n} (${(frameRate * 100).toFixed(2)}%${bindFrames ? ` — bound ${FRAME_MISMATCH_BOUND * 100}%` : " — reported, not bound"})` + (first >= 0 ? `, first at frame ${first}` : ""));
    if (!wordsEqual) {
        console.log(`[${label}] FAIL — word-level transcripts differ`);
        failed = true;
    } else if (bindFrames && frameRate > FRAME_MISMATCH_BOUND) {
        console.log(`[${label}] FAIL — frame mismatch exceeds the pinned 2% bound (word-level still identical — investigate before trusting)`);
        failed = true;
    } else {
        console.log(`[${label}] PASS ${a.sha === b.sha ? "(frame-exact)" : "(word-level" + (bindFrames ? ", jitter within bound" : "") + ")"}`);
    }
}

compare(MODEL_B ? "A node↔wasm" : "node↔wasm", nodeRes, wasmRes, { bindFrames: true });

if (MODEL_B) {
    const bNode = await runBackend("B/node", ortNode, {}, MODEL_B);
    const bWasm = await runBackend("B/wasm", ortWeb, WASM_OPTS, MODEL_B);
    // model B's OWN runtime stability — the adoption point of the re-export
    compare("B node↔wasm (runtime stability)", bNode, bWasm, { bindFrames: true });
    // the logit-parity guard: re-export still matches the reference
    compare("A↔B on node (re-export guard)", nodeRes, bNode, { bindFrames: false });
    compare("A↔B on wasm", wasmRes, bWasm, { bindFrames: false });
}

process.exit(failed ? 1 : 0);
