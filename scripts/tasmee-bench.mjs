/* ============================================================
 * tasmee-bench.mjs — GATE 3 evidence command (TASMEE-PLAN §5).
 *
 *   node scripts/tasmee-bench.mjs <clip.wav> [--range 2:1-5]
 *        [--truth <clip>.truth.json] [--page NNN] [--model <path>] [--debug]
 *
 * Thin onnxruntime-node HOST over the shared modules — the SAME
 * bytes the dev-harness worker runs in the browser:
 *   src/tasmee-pipeline.js  WAV / 48→16k FIR resample (A4) / mel / greedy
 *   src/tasmee-stream.js    streaming controller (stability, jumps,
 *                           hesitation wiring on the activity clock)
 *   src/tasmee-report.js    byte-identical bench block
 * plus the bench-only truth scorer (tasmee-truth-v1, adjusted rules
 * of 2026-07-10). Truth absent → smoke mode (validation, not gate
 * evidence).
 * ============================================================ */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { tasmeeNorm } from "../src/tasmee-norm.js";
import { createTasmeeSession } from "../src/tasmee-engine.js";
import { readWavMono, resampleTo16k, melFrontend, makeGreedyDecoder, NMEL, buildVad } from "../src/tasmee-pipeline.js";
import { createStreamController } from "../src/tasmee-stream.js";
import { TASMEE_LIVE } from "../src/tasmee-live-config.js";
import { buildBenchBlock, buildEnvLines } from "../src/tasmee-report.js";
import os from "node:os";
import crypto from "node:crypto";

const require = createRequire(import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATASET = JSON.parse(fs.readFileSync(path.join(ROOT, "public", "tasmee-words.json"), "utf8"));

/* ---------- args ---------- */
const args = process.argv.slice(2);
const clipPath = args.find((a) => !a.startsWith("--"));
if (!clipPath) { console.error("usage: node scripts/tasmee-bench.mjs <clip.wav> [--range s:a-b | --page NNN] [--truth file]"); process.exit(2); }
const argVal = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
/* Artifact-of-record (TASMEE-PLAN Gate 3 provenance): v0.1.0
 * fastconformer_ar_ctc_q8.onnx from the release URL verified by
 * Mohammed on 2026-07-10. models/candidate/ is selectable via
 * --model for the post-Gate-3 A/B only. */
/* ARTIFACT-OF-RECORD since 2026-07-11 (Mohammed's adoption ruling):
 * q8pc-head — our own re-export from the NVIDIA checkpoint (per-channel
 * dynamic QUInt8, decoder head fp32; sha256 e2dfe38c8c64…). Fixes the
 * wasm short-word truncation class (smoke 20/20 both surfaces), 02 at
 * 0/1 flags, 04 P 1.00/FP 0 both surfaces, wasm RTF ~1.0. The previous
 * record (fastconformer_ar_ctc_q8.onnx, tilawa v0.1.0) stays on disk as
 * the fallback — select via --model. */
const MODEL_PATH = argVal("--model") || path.join(ROOT, "models", "tasmee", "fastconformer_ar_ctc_q8pc-head.onnx");
const VOCAB_PATH = path.join(path.dirname(MODEL_PATH), "vocab.json");

/* Streaming parameters (mirrored by the harness worker). */
const CHUNK_S = 0.3, WINDOW_S = 15, TAIL_PAD_S = 1.2, CONTEXT_S = 1.0, HOLDBACK_S = 0.3, FRAME_S = 0.08;
/* Incremental-mode pinned parameters (seam tests assert these). */
const INC_CONTEXT_S = 1.5, INC_EDGE_GUARD_S = 0.2;
const DECODE_MODE = (argVal("--decode") === "incremental" || args.includes("--decode=incremental")) ? "incremental" : "window";
/* VAD policy per decode mode (ADOPTED 2026-07-11): incremental's
 * config of record is v2 (every budget met, truth clips P 0.60);
 * window keeps historical — its reference role is defined on it and
 * v2-window is a documented dead end. --vad=v2|historical overrides. */
const VAD_POLICY = (argVal("--vad") === "v2" || args.includes("--vad=v2")) ? "v2"
    : (argVal("--vad") === "historical" || args.includes("--vad=historical")) ? "historical"
    : (DECODE_MODE === "incremental" ? "v2" : "historical");

/* ---------- ORT backend (STANDING acceptance surface, ruled 2026-07-11) --
 * --ort=node (default): onnxruntime-node native kernels — the fast dev
 *   signal.
 * --ort=web: onnxruntime-web's WASM backend running under node —
 *   ort-wasm-simd-threaded.wasm, the SAME dist file the browser ships
 *   (ort.node.min.mjs and the ship-path ort.wasm.min.mjs both resolve
 *   the ort-wasm-simd-threaded.mjs loader; the binary's sha256 prints
 *   in the env line as the receipt). Flags mirror the browser posture:
 *   numThreads=1 (xoi=false ⇒ ort-web runs 1 regardless), no proxy.
 * Ruling: every future accuracy claim runs on BOTH surfaces — node for
 * speed of iteration, wasm for ship-path truth. This closes the
 * "score one runtime, ship another" gap exposed by the 18/20-vs-20/20
 * incremental smoke delta. */
const ORT_BACKEND = (argVal("--ort") === "web" || args.includes("--ort=web")) ? "web" : "node";
let ort, ORT_ENV_BACKEND, ORT_ENV_BINARY;
if (ORT_BACKEND === "web") {
    ort = await import("onnxruntime-web");
    ort.env.wasm.numThreads = 1;
    const wasmFile = path.join(ROOT, "node_modules", "onnxruntime-web", "dist", "ort-wasm-simd-threaded.wasm");
    const wasmSha = crypto.createHash("sha256").update(fs.readFileSync(wasmFile)).digest("hex");
    // package.json isn't in ort-web's exports map — read it off disk.
    const webVersion = JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules", "onnxruntime-web", "package.json"), "utf8")).version;
    ORT_ENV_BACKEND = `wasm (onnxruntime-web ${webVersion} under node)`;
    ORT_ENV_BINARY = `ort-wasm-simd-threaded.wasm (sha256 ${wasmSha.slice(0, 12)}… — same dist file the browser fetches)`;
} else {
    ort = require("onnxruntime-node");
    ORT_ENV_BACKEND = `cpu (onnxruntime-node ${require("onnxruntime-node/package.json").version})`;
    ORT_ENV_BINARY = "native";
}

/* ---------- reference ---------- */
function refFromRange(rangeStr) {
    const m = /^(\d+):(\d+)(?:-(\d+))?$/.exec(rangeStr);
    if (!m) throw new Error(`bad --range ${rangeStr}`);
    const s = Number(m[1]), from = Number(m[2]), to = Number(m[3] || m[2]);
    const out = [];
    for (let a = from; a <= to; a++) {
        const arr = DATASET.verses[`${s}:${a}`];
        if (!arr) throw new Error(`missing verse ${s}:${a}`);
        arr.forEach((f, i) => { if (f) out.push({ vk: `${s}:${a}`, pos: i + 1, form: f }); });
    }
    return out;
}
function refFromPage(pageNo) {
    const p = String(pageNo).padStart(3, "0");
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, "public", "data", "qcf4", "pages", `${p}.json`), "utf8"));
    const out = [];
    for (const line of d.lines || []) for (const w of line.words || []) {
        if (w.type !== "word" || String(w.text || "").startsWith("#")) continue;
        const form = DATASET.verses[w.verse_key]?.[w.position - 1];
        if (form) out.push({ vk: w.verse_key, pos: w.position, form });
    }
    return out;
}

const truthPath = argVal("--truth") ?? (fs.existsSync(clipPath.replace(/\.wav$/i, ".truth.json")) ? clipPath.replace(/\.wav$/i, ".truth.json") : null);
const truth = truthPath ? JSON.parse(fs.readFileSync(truthPath, "utf8")) : null;
let ref;
if (argVal("--range")) ref = refFromRange(argVal("--range"));
else if (truth?.range) {
    const [sF, aF] = truth.range.vkFrom.split(":").map(Number);
    const [sT, aT] = truth.range.vkTo.split(":").map(Number);
    if (sF !== sT) throw new Error("truth.range must stay within one surah (use --page for pages)");
    ref = refFromRange(`${sF}:${aF}-${aT}`);
} else if (argVal("--page") || /-p(\d{3})\.wav$/i.test(clipPath)) {
    ref = refFromPage(argVal("--page") || /-p(\d{3})\.wav$/i.exec(clipPath)[1]);
} else { console.error("no reference: pass --range, --page, or a truth file with range"); process.exit(2); }

/* ---------- audio ---------- */
const fileBuf = fs.readFileSync(clipPath);
const { rate, pcm: raw } = readWavMono(fileBuf.buffer.slice(fileBuf.byteOffset, fileBuf.byteOffset + fileBuf.byteLength));
const pcmReal = resampleTo16k(raw, rate);
const durS = pcmReal.length / 16000;
/* #6 — end-of-clip flush: pad trailing silence so in-flight words get
 * their second stable decode + clear the holdback BEFORE stop(). */
const pcm = new Float32Array(pcmReal.length + Math.round(TAIL_PAD_S * 16000));
pcm.set(pcmReal, 0);

/* VAD — shared implementation (src/tasmee-pipeline.js). */
const { onsetS, isSpeech, findSilenceBefore } = buildVad(pcm, { policy: VAD_POLICY });

/* ---------- model ---------- */
const vocabJson = JSON.parse(fs.readFileSync(VOCAB_PATH, "utf8"));
const VOCAB = [];
for (const [id, tok] of Object.entries(vocabJson)) VOCAB[Number(id)] = tok;
const BLANK = VOCAB.indexOf("<blank>") >= 0 ? VOCAB.indexOf("<blank>") : VOCAB.length - 1;
const GREEDY = makeGreedyDecoder(VOCAB, BLANK);
const MODEL_SHA = fs.existsSync(path.join(path.dirname(MODEL_PATH), "checksums.txt"))
    ? (fs.readFileSync(path.join(path.dirname(MODEL_PATH), "checksums.txt"), "utf8").split("\n")
        .find((l) => l.includes(path.basename(MODEL_PATH))) || "").split(/\s+/)[0] : null;

// ort-web has no filesystem loader — hand it the model bytes directly.
const sess = ORT_BACKEND === "web"
    ? await ort.InferenceSession.create(new Uint8Array(fs.readFileSync(MODEL_PATH)))
    : await ort.InferenceSession.create(MODEL_PATH);
let RAW_INPUT = false; // raw-waveform in-graph vs mel-outside (artifact-of-record)
try {
    await sess.run({
        audio_signal: new ort.Tensor("float32", new Float32Array(1600), [1, 1600]),
        length: new ort.Tensor("int64", BigInt64Array.from([1600n]), [1]),
    });
    RAW_INPUT = true;
} catch { RAW_INPUT = false; }

let computeMs = 0, melMs = 0, ortMs = 0; // split = C3 attribution (our DSP vs ORT kernels)
async function decode(startS, endS) {
    const a = pcm.subarray(Math.floor(startS * 16000), Math.floor(endS * 16000));
    const t0 = performance.now();
    let feeds;
    if (RAW_INPUT) {
        feeds = {
            audio_signal: new ort.Tensor("float32", a, [1, a.length]),
            length: new ort.Tensor("int64", BigInt64Array.from([BigInt(a.length)]), [1]),
        };
    } else {
        const { mel, T } = melFrontend(a);
        feeds = {
            audio_signal: new ort.Tensor("float32", mel, [1, NMEL, T]),
            length: new ort.Tensor("int64", BigInt64Array.from([BigInt(T)]), [1]),
        };
    }
    const tMel = performance.now();
    melMs += tMel - t0;
    const out = await sess.run(feeds);
    ortMs += performance.now() - tMel;
    computeMs += performance.now() - t0;
    const lp = out[sess.outputNames[0]];
    return GREEDY(lp.data, lp.dims[1], lp.dims[2], startS).words;
}

/* ---------- run ---------- */
const session = createTasmeeSession({
    words: ref,
    onEvent: args.includes("--log-amends")
        ? (e) => { if (e.type === "amend") console.error(`[amend] ${e.vk}:${e.pos} ${e.from}→${e.to} heard=${e.heard} @${(e.t / 1000).toFixed(1)}s`); }
        : undefined,
});
const ctl = createStreamController({
    session, decode, isSpeech, findSilenceBefore, norm: tasmeeNorm,
    chunkS: CHUNK_S, windowS: WINDOW_S, contextS: CONTEXT_S, holdbackS: HOLDBACK_S, frameS: FRAME_S,
    mode: DECODE_MODE, incContextS: INC_CONTEXT_S, incEdgeGuardS: INC_EDGE_GUARD_S,
    // AMENDMENT CHANNEL (2026-07-16): ships ON (config-of-record);
    // --no-amend gives the pre-amendment baseline for A/B.
    amend: args.includes("--no-amend") ? null : TASMEE_LIVE.controller.amend,
    debug: args.includes("--debug")
        ? (chunkEnd, commitN, pending) => console.error(`[${chunkEnd.toFixed(1)}s] commit ${commitN} | pending: ` +
            pending.map((w) => `${w.text}(${w.startS.toFixed(1)}-${w.endS.toFixed(1)})`).join(" "))
        : null,
});
/* Ruling #3 — live-feed accounting: chunk i is only AVAILABLE at
 * its audio time; the processor starts at max(available, free) and
 * backlog = finish − available. --feed=fast computes this on a
 * virtual clock from measured per-step compute (no pacing);
 * --feed=realtime additionally paces arrival with real sleeps
 * (exposes GC/thermal effects). As-fast-as-compute feeding alone
 * masks live queue growth whenever RTF > 1. */
const FEED = (argVal("--feed") === "realtime" || args.includes("--feed=realtime")) ? "realtime" : "fast";
const loopEndS = durS + TAIL_PAD_S;
let procFreeS = 0, maxBacklogS = 0, endBacklogS = 0;
const wall0 = performance.now();
for (let endS = CHUNK_S; endS < loopEndS + CHUNK_S; endS += CHUNK_S) {
    const chunkEnd = Math.min(endS, loopEndS);
    if (FEED === "realtime") {
        const targetMs = chunkEnd * 1000 - (performance.now() - wall0);
        if (targetMs > 0) await new Promise((r) => setTimeout(r, targetMs));
    }
    const t0 = performance.now();
    await ctl.step(chunkEnd);
    const stepS = (performance.now() - t0) / 1000;
    const startS = Math.max(chunkEnd, procFreeS);
    procFreeS = startS + stepS;
    endBacklogS = Math.max(0, procFreeS - chunkEnd);
    maxBacklogS = Math.max(maxBacklogS, endBacklogS);
}
ctl.flush(loopEndS);
const summary = session.stop(Math.round(loopEndS * 1000));
const { committed, latencies, firstCommitAtS } = ctl.results();

/* ---------- report (shared block) ---------- */
const block = buildBenchBlock({
    clipName: path.basename(clipPath),
    modelName: path.basename(MODEL_PATH),
    modelSha: MODEL_SHA,
    inputMode: RAW_INPUT ? "raw-waveform" : "mel (ours)",
    rate, durS, onsetS, ref, committed, latencies, firstCommitAtS, computeMs,
    session, summary, norm: tasmeeNorm, truthLoaded: !!truth,
    feed: { mode: FEED, maxBacklogS, endBacklogS },
    computeSplit: { melMs, ortMs },
    envLines: buildEnvLines({
        backend: ORT_ENV_BACKEND,
        binary: ORT_ENV_BINARY,
        flags: ORT_BACKEND === "web"
            ? `numThreads=${ort.env.wasm.numThreads} simd=${ort.env.wasm.simd ?? "n/a"} proxy=${ort.env.wasm.proxy ?? "false"}`
            : "n/a",
        vad: VAD_POLICY,
        webgpu: "n/a",
        mem: `totalmem=${(os.totalmem() / 2 ** 30).toFixed(0)}GB`,
        platform: `node ${process.version} ${process.platform} ${process.arch}`,
        decode: DECODE_MODE === "incremental"
            ? `incremental (incContextS=${INC_CONTEXT_S} incEdgeGuardS=${INC_EDGE_GUARD_S} chunkS=${CHUNK_S} holdbackS=${HOLDBACK_S})`
            : `window (windowS=${WINDOW_S} contextS=${CONTEXT_S} chunkS=${CHUNK_S} holdbackS=${HOLDBACK_S})`,
    }),
});
console.log(block.text);

/* ---------- truth scoring (bench-only) ---------- */
if (truth) {
    const posOf = (idx) => ref[Math.min(idx, ref.length - 1)];
    const flags = session.getWords().map((w, i) => ({ ...w, i })).filter((w) => w.verdict === "substituted" || w.verdict === "skipped")
        .map((w) => ({ kind: "flag", cls: w.verdict === "substituted" ? "sub" : "skip", vk: w.vk, pos: w.pos, used: false }));
    const inserts = session.getEvents().filter((e) => e.type === "insertion")
        .map((e) => { const w = posOf(e.idx); return { kind: "insert", cls: "insert", vk: w.vk, pos: w.pos, used: false }; });
    const hes = session.getEvents().filter((e) => e.type === "hesitation")
        .map((e) => ({ kind: "hes", cls: "hesitate", vk: e.vk, pos: e.pos, used: false }));
    const detected = [...flags, ...inserts, ...hes];

    const wordsOfSpan = (ev) => {
        const list = [];
        const addAyah = (vk, from, to) => {
            const arr = DATASET.verses[vk] || [];
            arr.forEach((f, i) => { if (f && i + 1 >= (from || 1) && i + 1 <= (to || arr.length)) list.push(`${vk}:${i + 1}`); });
        };
        if (ev.vk && ev.pos) list.push(`${ev.vk}:${ev.pos}`);
        else if (ev.vk) addAyah(ev.vk, ev.from, ev.to);
        else if (ev.vkFrom) {
            const [s, aF] = ev.vkFrom.split(":").map(Number);
            const aT = Number(ev.vkTo.split(":")[1]);
            for (let a = aF; a <= aT; a++) addAyah(`${s}:${a}`);
        }
        return new Set(list);
    };

    let TP = 0, FN = 0;
    const matrix = {};
    const bump = (t, d) => { (matrix[t] ||= {}); matrix[t][d] = (matrix[t][d] || 0) + 1; };
    const repeatSpans = [];
    let expectedN = 0;

    for (const ev of truth.events || []) {
        if (ev.act === "repeat") { repeatSpans.push(wordsOfSpan(ev)); continue; }
        expectedN++;
        let hit = null;
        if (ev.act === "sub") hit = detected.find((d) => !d.used && d.kind === "flag" && d.vk === ev.vk && d.pos === ev.pos);
        else if (ev.act === "skip") {
            const span = wordsOfSpan(ev);
            const all = detected.filter((d) => !d.used && d.kind === "flag" && span.has(`${d.vk}:${d.pos}`));
            if (all.length) { all.forEach((d) => (d.used = true)); hit = all[0]; }
        } else if (ev.act === "insert") hit = detected.find((d) => !d.used && d.kind === "insert" && d.vk === ev.vk && Math.abs(d.pos - (ev.afterPos + 1)) <= 1);
        else if (ev.act === "hesitate") hit = detected.find((d) => !d.used && d.kind === "hes" && d.vk === ev.vk && Math.abs(d.pos - ev.pos) <= 1);
        if (hit) { hit.used = true; TP++; bump(ev.act, hit.cls); }
        else { FN++; bump(ev.act, "missed"); }
    }
    const fps = detected.filter((d) => !d.used);
    const repViolations = fps.filter((d) => d.kind === "flag" && repeatSpans.some((s) => s.has(`${d.vk}:${d.pos}`)));
    const precision = TP + fps.length ? TP / (TP + fps.length) : 1;
    const recall = expectedN ? TP / expectedN : 1;
    /* Per-INCIDENT diagnostic (ruled 2026-07-11): one engine failure
     * can fan into several FP EVENTS (the 38:8 idghām incident
     * produced 5). Cluster unused detections by reference adjacency
     * (same ayah, positions within 2). PER-EVENT REMAINS BINDING —
     * five flags on screen is five flags to the user; per-incident is
     * the honest count of distinct failures. Report both, never swap. */
    const fpSorted = fps.map((d) => ({ a: Number(String(d.vk).split(":")[1]), pos: d.pos }))
        .sort((x, y) => x.a - y.a || x.pos - y.pos);
    let fpIncidents = 0, prevFp = null;
    for (const f of fpSorted) {
        if (!prevFp || f.a !== prevFp.a || f.pos - prevFp.pos > 2) fpIncidents++;
        prevFp = f;
    }
    const pIncident = TP + fpIncidents ? TP / (TP + fpIncidents) : 1;

    console.log(`\ndetection (binding): P ${precision.toFixed(2)} (≥0.80) · R ${recall.toFixed(2)} (≥0.90) · TP ${TP} FP ${fps.length} FN ${FN}`);
    console.log(`  per-incident (diagnostic, NOT binding): P ${pIncident.toFixed(2)} — ${fps.length} FP event(s) in ${fpIncidents} incident(s) (adjacency-clustered)`);
    console.log(`  note: spurious hesitations count as FPs (precision); planted-only applies to recall.`);
    console.log(`repetition acceptance: ${repViolations.length === 0 ? "PASS" : "FAIL"} — ${repViolations.length} mistake flag(s) inside planted repeat ranges (must be 0)`);
    console.log(`classification matrix (truth → detected):`);
    for (const [t, row] of Object.entries(matrix)) console.log(`  ${t.padEnd(8)} ${Object.entries(row).map(([k, v]) => `${k}:${v}`).join("  ")}`);
    if (fps.length) console.log(`false positives:\n${fps.map((d) => `  ${d.kind} @ ${d.vk}:${d.pos}`).join("\n")}`);
} else {
    console.log(`\n(no truth file — smoke mode: pipeline validation only, not gate evidence)`);
}
