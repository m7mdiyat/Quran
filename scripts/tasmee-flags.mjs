/* ============================================================
 * tasmee-flags.mjs — DEV DIAGNOSTIC (not gate evidence).
 *
 *   node scripts/tasmee-flags.mjs <clip.wav> [--decode=incremental]
 *        [--range s:a-b] [--trace 10-30]
 *
 * Runs the same pipeline as tasmee-bench.mjs and prints, per
 * mistake flag (substituted/skipped), the reference word, what was
 * heard, and the commit-timeline neighborhood — plus (--trace) the
 * per-chunk anchor/pending stream for a time window. Built for the
 * 01/02 quiet-voice seam-drop investigation (2026-07-11): classify
 * each flag as seam-placement vs stability-flap vs dup-window vs
 * edge/tail-guard vs plain model error before touching parameters.
 * ============================================================ */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { tasmeeNorm } from "../src/tasmee-norm.js";
import { createTasmeeSession } from "../src/tasmee-engine.js";
import { readWavMono, resampleTo16k, melFrontend, makeGreedyDecoder, NMEL, buildVad } from "../src/tasmee-pipeline.js";
import { createStreamController } from "../src/tasmee-stream.js";

const require = createRequire(import.meta.url);
const ort = require("onnxruntime-node");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATASET = JSON.parse(fs.readFileSync(path.join(ROOT, "public", "tasmee-words.json"), "utf8"));

const args = process.argv.slice(2);
const clipPath = args.find((a) => !a.startsWith("--"));
const argVal = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const DECODE_MODE = (argVal("--decode") === "incremental" || args.includes("--decode=incremental")) ? "incremental" : "window";
const traceArg = argVal("--trace") ?? args.find((a) => a.startsWith("--trace="))?.slice(8);
const [traceFrom, traceTo] = traceArg ? traceArg.split("-").map(Number) : [null, null];

const CHUNK_S = 0.3, WINDOW_S = 15, TAIL_PAD_S = 1.2, CONTEXT_S = 1.0, HOLDBACK_S = 0.3, FRAME_S = 0.08;
const INC_CONTEXT_S = 1.5, INC_EDGE_GUARD_S = 0.2;

function refFromRange(rangeStr) {
    const m = /^(\d+):(\d+)(?:-(\d+))?$/.exec(rangeStr);
    const s = Number(m[1]), from = Number(m[2]), to = Number(m[3] || m[2]);
    const out = [];
    for (let a = from; a <= to; a++) DATASET.verses[`${s}:${a}`].forEach((f, i) => { if (f) out.push({ vk: `${s}:${a}`, pos: i + 1, form: f }); });
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
const ref = argVal("--range") ? refFromRange(argVal("--range")) : refFromPage(/-p(\d{3})\.wav$/i.exec(clipPath)[1]);

const fileBuf = fs.readFileSync(clipPath);
const { rate, pcm: raw } = readWavMono(fileBuf.buffer.slice(fileBuf.byteOffset, fileBuf.byteOffset + fileBuf.byteLength));
const pcmReal = resampleTo16k(raw, rate);
const durS = pcmReal.length / 16000;
const pcm = new Float32Array(pcmReal.length + Math.round(TAIL_PAD_S * 16000));
pcm.set(pcmReal, 0);
const VAD_POLICY = (argVal("--vad") === "v2" || args.includes("--vad=v2")) ? "v2" : "historical";
const { isSpeech, findSilenceBefore } = buildVad(pcm, { policy: VAD_POLICY });



const vocabJson = JSON.parse(fs.readFileSync(path.join(ROOT, "models", "tasmee", "vocab.json"), "utf8"));
const VOCAB = [];
for (const [id, tok] of Object.entries(vocabJson)) VOCAB[Number(id)] = tok;
const BLANK = VOCAB.indexOf("<blank>") >= 0 ? VOCAB.indexOf("<blank>") : VOCAB.length - 1;
const GREEDY = makeGreedyDecoder(VOCAB, BLANK);
const sess = await ort.InferenceSession.create(path.join(ROOT, "models", "tasmee", "fastconformer_ar_ctc_q8pc-head.onnx")); // record artifact since 2026-07-11

async function decode(startS, endS) {
    const a = pcm.subarray(Math.floor(startS * 16000), Math.floor(endS * 16000));
    const { mel, T } = melFrontend(a);
    const out = await sess.run({
        audio_signal: new ort.Tensor("float32", mel, [1, NMEL, T]),
        length: new ort.Tensor("int64", BigInt64Array.from([BigInt(T)]), [1]),
    });
    const lp = out[sess.outputNames[0]];
    return GREEDY(lp.data, lp.dims[1], lp.dims[2], startS).words;
}

const session = createTasmeeSession({ words: ref });
const ctl = createStreamController({
    session, decode, isSpeech, findSilenceBefore, norm: tasmeeNorm,
    chunkS: CHUNK_S, windowS: WINDOW_S, contextS: CONTEXT_S, holdbackS: HOLDBACK_S, frameS: FRAME_S,
    mode: DECODE_MODE, incContextS: INC_CONTEXT_S, incEdgeGuardS: INC_EDGE_GUARD_S,
    debug: traceArg ? (chunkEnd, commitN, pending, anchorS) => {
        if (chunkEnd >= traceFrom && chunkEnd <= traceTo) console.error(
            `[${chunkEnd.toFixed(1)}s] anchor ${anchorS.toFixed(1)} commit ${commitN} | ` +
            pending.map((w) => `${w.text}(${w.startS.toFixed(1)}-${w.endS.toFixed(1)})`).join(" "));
    } : null,
});
const loopEndS = durS + TAIL_PAD_S;
for (let endS = CHUNK_S; endS < loopEndS + CHUNK_S; endS += CHUNK_S) await ctl.step(Math.min(endS, loopEndS));
ctl.flush(loopEndS);
session.stop(Math.round(loopEndS * 1000));
const { committed } = ctl.results();

console.log(`\n== flags: ${path.basename(clipPath)} · decode=${DECODE_MODE} ==`);
const words = session.getWords();
const revealEvents = session.getEvents().filter((e) => e.type === "reveal");
const tOf = (vk, pos) => revealEvents.find((e) => e.vk === vk && e.pos === pos)?.t;
for (const w of words) {
    if (w.verdict !== "substituted" && w.verdict !== "skipped") continue;
    const t = tOf(w.vk, w.pos);
    const tS = t !== undefined ? (t / 1000) : null;
    const near = tS === null ? [] : committed.filter((c) => Math.abs(c.endS - tS) < 3.5);
    console.log(`\nFLAG ${w.verdict.toUpperCase()} ${w.vk}:${w.pos} «${w.form}»` +
        (w.heard ? ` heard «${w.heard}»` : "") + (tS !== null ? ` @ reveal t=${tS.toFixed(1)}s` : ""));
    console.log(`  committed near: ` + near.map((c) => `${c.text}(${c.startS.toFixed(1)}-${c.endS.toFixed(1)}→c@${c.commitAtS.toFixed(1)})`).join(" "));
}
const ins = session.getEvents().filter((e) => e.type === "insertion");
if (ins.length) console.log(`\ninsertions: ` + ins.map((e) => `«${e.heard}» @idx${e.idx} t=${(e.t / 1000).toFixed(1)}s`).join(" · "));
/* tail summary — the end-of-clip flush region is where final-word
 * failures live; show what was committed vs what the engine did. */
console.log(`\ntail: last committed → ` + committed.slice(-6).map((c) => `${c.text}(${c.startS.toFixed(1)}-${c.endS.toFixed(1)}→c@${c.commitAtS.toFixed(1)})`).join(" "));
console.log(`tail: last ref words → ` + words.slice(-4).map((w) => `${w.vk}:${w.pos}«${w.form}»=${w.verdict}`).join(" · "));
console.log(`tail: last events → ` + session.getEvents().slice(-6).map((e) => `${e.type}${e.vk ? ` ${e.vk}:${e.pos ?? ""}` : ""}${e.heard ? `«${e.heard}»` : ""}@${(e.t / 1000).toFixed(1)}s`).join(" · "));
