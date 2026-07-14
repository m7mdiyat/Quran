/* ============================================================
 * tasmee-worker.js — the acoustic worker for وضع التسميع (Piece 4,
 * TASMEE-PLAN §"tasmee-worker.js").
 *
 * onnxruntime-web (WASM EP, single-threaded — no SharedArrayBuffer,
 * no COOP/COEP) + the SAME shared DSP the offline bench uses
 * (src/tasmee-pipeline.js): 48→16 kHz resample, NeMo-matching mel
 * frontend, greedy CTC decode. Fed live audio from the main thread;
 * runs the stream controller + engine (co-located, so the
 * controller's synchronous session.getEvents() works) and posts
 * ENGINE EVENTS back to main for applyEvent() → DOM.
 *
 * Ship model: fastconformer_ar_ctc_q8.onnx — MEL input
 * (audio_signal [1,80,T] + length [T]) → logprobs [1,T,1025].
 * (Auto-probes raw-vs-mel so a future raw-in-graph export still works.)
 *
 * PINNED (plan): session init happens on/after the mic-tap gesture,
 * never at page load — this worker is spawned from the mic-tap path.
 * ============================================================ */

import * as ort from "onnxruntime-web/wasm";   // WASM-only build (no WebGPU/JSEP): plain ort-wasm-simd-threaded.*
import { createTasmeeSession } from "./tasmee-engine.js";
import { readWavMono, resampleTo16k, makeStreamResampler16k, melFrontend, makeGreedyDecoder, NMEL, buildVad } from "./tasmee-pipeline.js";
import { createStreamController } from "./tasmee-stream.js";
import { tasmeeNorm } from "./tasmee-norm.js";

/* ADAPTIVE threads — never hardcode single-threaded. In the app the FlyingFox
 * local server sets COOP/COEP → crossOriginIsolated=true → SharedArrayBuffer →
 * real threads (device-verified numThreads=4, 320ms vs 434ms). The Vite dev
 * server has no COOP/COEP → crossOriginIsolated=false → 1 thread. Same code. */
ort.env.wasm.numThreads = self.crossOriginIsolated
    ? Math.max(1, Math.min(4, (self.navigator && navigator.hardwareConcurrency) || 4))
    : 1;

let sess = null, VOCAB = null, BLANK = 0, GREEDY = null, RAW_INPUT = false;

/* Point ORT at its WASM assets. The Emscripten GLUE (.mjs) is dynamic-imported
 * by ORT at runtime; under Vite's dev server a plain URL to it gets rewritten
 * with `?import` and fails to fetch. So we fetch the glue ourselves and hand
 * ORT a BLOB url — a runtime blob: specifier is invisible to Vite's import
 * analysis, so it can't be rewritten. The .wasm is a normal static asset
 * (Vite serves .wasm raw). Dev paths are /ort/*; the ship build bundles/copies
 * these alongside the app. */
async function setupOrtWasm(base = "/ort/") {
    const glue = await fetch(base + "ort-wasm-simd-threaded.mjs").then((r) => {
        if (!r.ok) throw new Error(`ort glue ${r.status}`); return r.text();
    });
    const mjsUrl = URL.createObjectURL(new Blob([glue], { type: "text/javascript" }));
    ort.env.wasm.wasmPaths = { mjs: mjsUrl, wasm: base + "ort-wasm-simd-threaded.wasm" };
}

async function loadModel(modelUrl, vocabUrl) {
    await setupOrtWasm();
    const [modelBuf, vocabJson] = await Promise.all([
        fetch(modelUrl).then((r) => { if (!r.ok) throw new Error(`model ${r.status}`); return r.arrayBuffer(); }),
        fetch(vocabUrl).then((r) => { if (!r.ok) throw new Error(`vocab ${r.status}`); return r.json(); }),
    ]);
    VOCAB = [];
    for (const [id, tok] of Object.entries(vocabJson)) VOCAB[Number(id)] = tok;
    BLANK = VOCAB.indexOf("<blank>") >= 0 ? VOCAB.indexOf("<blank>") : VOCAB.length - 1;
    GREEDY = makeGreedyDecoder(VOCAB, BLANK);
    sess = await ort.InferenceSession.create(new Uint8Array(modelBuf), { executionProviders: ["wasm"] });
    // Probe: does audio_signal want raw waveform [1,N] or mel [1,80,T]?
    RAW_INPUT = false;
    try {
        await sess.run({
            audio_signal: new ort.Tensor("float32", new Float32Array(1600), [1, 1600]),
            length: new ort.Tensor("int64", BigInt64Array.from([1600n]), [1]),
        });
        RAW_INPUT = true;
    } catch (e) { RAW_INPUT = false; }
}

/* Decode a 16 kHz mono slice → words[{text,startS,endS}]. Mirrors the bench's
 * decode() byte-for-byte (mel → session.run → greedy) so device and offline
 * hit the model identically (A4/parity rule). */
async function decodeSlice(pcm16k, startS = 0) {
    let feeds;
    if (RAW_INPUT) {
        feeds = {
            audio_signal: new ort.Tensor("float32", pcm16k, [1, pcm16k.length]),
            length: new ort.Tensor("int64", BigInt64Array.from([BigInt(pcm16k.length)]), [1]),
        };
    } else {
        const { mel, T } = melFrontend(pcm16k);
        feeds = {
            audio_signal: new ort.Tensor("float32", mel, [1, NMEL, T]),
            length: new ort.Tensor("int64", BigInt64Array.from([BigInt(T)]), [1]),
        };
    }
    const out = await sess.run(feeds);
    const lp = out[sess.outputNames[0]];      // logprobs [1,T,V]
    return GREEDY(lp.data, lp.dims[1], lp.dims[2], startS).words;
}

/* ---------- LIVE STREAMING (engine + incremental stream controller here) ----
 * Raw 48 k blocks arrive from main → streamed 16 k → the incremental controller
 * re-decodes short segments and drives the engine, whose events post to main
 * for applyEvent() → DOM reveals. Engine + controller are co-located because
 * the controller reads session.getEvents() synchronously. */
const STEP_S = 0.3, TAIL_PAD_S = 1.2, SR = 16000;
let resampler = null, pcm = new Float32Array(1 << 18), pcmLen = 0;
let liveSession = null, liveCtl = null, liveVad = null, nextStepS = 0, finishing = false, stepping = false;

function ensurePcm(n) {
    if (pcmLen + n > pcm.length) {
        const g = new Float32Array(Math.max(pcm.length * 2, pcmLen + n));
        g.set(pcm.subarray(0, pcmLen)); pcm = g;
    }
}
function appendPcm(block) { if (block.length) { ensurePcm(block.length); pcm.set(block, pcmLen); pcmLen += block.length; } }

async function liveDecode(startS, endS) {
    const a = pcm.subarray(Math.floor(startS * SR), Math.floor(endS * SR));
    return decodeSlice(a, startS);
}

function setupLive(ref) {
    resampler = makeStreamResampler16k(48000);
    pcmLen = 0; nextStepS = STEP_S; finishing = false; stepping = false;
    liveSession = createTasmeeSession({
        words: ref.map((r) => ({ vk: r.vk, pos: r.pos, form: r.form })),
        onEvent: (ev) => self.postMessage({ type: "event", event: ev }),
    });
    // RAW ASR TRANSCRIPT — capture every token the model commits BEFORE the engine
    // matches it against the reference, so "what the model actually heard" is
    // visible live. Diagnoses mishearing (audio/model) vs the matcher.
    const _feed = liveSession.feedToken.bind(liveSession);
    liveSession.feedToken = (token, tMs) => {
        self.postMessage({ type: "transcript", token, tMs });
        return _feed(token, tMs);
    };
    liveVad = buildVad(pcm.subarray(0, 0), { policy: "v2" });
    liveCtl = createStreamController({
        session: liveSession,
        decode: liveDecode,
        isSpeech: (a, b) => liveVad.isSpeech(a, b),
        findSilenceBefore: (a, b) => liveVad.findSilenceBefore(a, b),
        norm: tasmeeNorm,
        chunkS: STEP_S, windowS: 15, contextS: 1.0, holdbackS: 0.3, frameS: 0.08,
        mode: "incremental", incContextS: 1.5, incEdgeGuardS: 0.2,   // config-of-record
    });
}

/* Serialized stepper: rebuild the VAD on the audio so far, then run the
 * controller for every 0.3 s boundary now covered by committed audio. */
async function pump() {
    if (stepping) return;
    stepping = true;
    try {
        while (nextStepS <= pcmLen / SR) {
            liveVad = buildVad(pcm.subarray(0, pcmLen), { policy: "v2" });
            await liveCtl.step(nextStepS);
            nextStepS += STEP_S;
        }
    } finally { stepping = false; }
}

function ingestRaw48k(block) {             // push raw + append streamed 16 k (no stepping)
    if (!resampler) return;
    resampler.push(block);
    appendPcm(resampler.pull());
}

async function finishLive() {
    if (!liveCtl) return null;
    finishing = true;
    appendPcm(resampler.flush());                       // truncated-edge tail
    const pad = Math.round(TAIL_PAD_S * SR);            // #6 end-of-clip flush: pad trailing silence
    ensurePcm(pad); pcm.fill(0, pcmLen, pcmLen + pad); pcmLen += pad;
    const endS = pcmLen / SR;
    while (nextStepS < endS + STEP_S) {                 // drain remaining + tail-pad
        liveVad = buildVad(pcm.subarray(0, pcmLen), { policy: "v2" });
        await liveCtl.step(Math.min(nextStepS, endS));
        nextStepS += STEP_S;
    }
    liveCtl.flush(endS);
    const summary = liveSession.stop(Math.round(endS * 1000));
    const { committed } = liveCtl.results();
    resampler = null; liveCtl = null; liveSession = null;
    return { summary, committed };
}

self.onmessage = async (e) => {
    const m = e.data || {};
    try {
        if (m.type === "init") {
            const t0 = performance.now();
            await loadModel(m.modelUrl, m.vocabUrl);
            const tLoaded = performance.now();
            await decodeSlice(new Float32Array(16000), 0);   // 1 s warmup
            if (m.ref) setupLive(m.ref);                     // arm the live engine + controller
            self.postMessage({
                type: "ready",
                rawInput: RAW_INPUT,
                inputNames: sess.inputNames,
                outputNames: sess.outputNames,
                vocabSize: VOCAB.length,
                blank: BLANK,
                numThreads: ort.env.wasm.numThreads,
                crossOriginIsolated: self.crossOriginIsolated,
                live: !!m.ref,
                loadMs: Math.round(tLoaded - t0),
                warmupMs: Math.round(performance.now() - tLoaded),
            });
        } else if (m.type === "audio") {
            ingestRaw48k(m.pcm);                          // raw 48 k block from the mic
            pump();                                       // fire-and-forget; self-serializes
        } else if (m.type === "stop") {
            const r = await finishLive();
            self.postMessage({ type: "stopped", summary: r && r.summary, committed: r && r.committed ? r.committed.length : 0 });
        } else if (m.type === "streamWav") {
            // TEST: feed a golden WAV through the LIVE path (raw 48 k in blocks) →
            // events + committed set, to diff the streaming wire vs the bench.
            const { rate, pcm: raw } = readWavMono(m.buf);
            const t0 = performance.now();
            const BLK = 2048;
            for (let i = 0; i < raw.length; i += BLK) ingestRaw48k(raw.subarray(i, Math.min(i + BLK, raw.length)));
            await pump();
            const r = await finishLive();
            self.postMessage({
                type: "stopped", rate, ms: Math.round(performance.now() - t0),
                committed: r && r.committed ? r.committed.length : 0,
                committedText: r && r.committed ? r.committed.map((w) => w.text || w.form || "").join(" ") : "",
            });
        } else if (m.type === "decode") {
            // dev/test path: decode a supplied 16 kHz slice, return words + timing
            const t0 = performance.now();
            const words = await decodeSlice(m.pcm, m.startS || 0);
            self.postMessage({ type: "decoded", words, ms: Math.round(performance.now() - t0) });
        } else if (m.type === "decodeWav") {
            // parity path: WAV bytes → readWavMono → resample → decode, exactly the
            // bench's flow, so a whole-clip decode can be diffed browser-vs-node.
            const t0 = performance.now();
            const { rate, pcm: wavPcm } = readWavMono(m.buf);
            const pcm16k = resampleTo16k(wavPcm, rate);
            const words = await decodeSlice(pcm16k, 0);
            self.postMessage({ type: "decoded", words, ms: Math.round(performance.now() - t0), rate, samples16k: pcm16k.length });
        }
    } catch (err) {
        self.postMessage({ type: "error", where: m.type, message: String((err && err.message) || err), stack: err && err.stack });
    }
};
