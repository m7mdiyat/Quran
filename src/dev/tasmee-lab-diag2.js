/* ============================================================
 * ⚠️ THROWAWAY DIAGNOSTIC #2 — tasmee-lab-diag2.js — DELETE AFTER READING.
 * (rm this file + its <script> tag in dev/tasmee-lab.html)
 *
 * Root-cause attribution for the live-vs-frozen decode gap:
 *  A. Scores BOTH surfaces per clip (live event log vs frozen replay) —
 *     which false flags exist where.
 *  B. LIVE-REPLAY TRACER: re-runs the EXACT live pipeline (real ORT via
 *     the worker's existing `decode` message; the real controller with
 *     its existing `debug` option; the real engine) over the captured
 *     PCM, logging every raw decode window + pending/commit decision.
 *     Reproduction is checked against the capture's committed list.
 *  C. Per-target-word attribution: for each failing word, what did every
 *     covering window actually decode, and where was it lost (never
 *     decoded / unstable / filtered-behind-frontier / guard)?
 *  D. CONTEXT SWEEPS: minimal right-context (frames) that recovers each
 *     word; left-context probe as the normalization/receptive-field
 *     control.
 * Diagnosis only. No live file is modified; no fix is implemented.
 * ============================================================ */

import { getClip } from "./tasmee-lab-db.js";
import { capture, SMOKE_PASSAGES } from "./tasmee-lab.js";
import { replayClip, scoreCorrectPile } from "./tasmee-lab-score.js";
import { createTasmeeSession } from "../tasmee-engine.js";
import { createStreamController } from "../tasmee-stream.js";
import { buildVad, FRAME_S } from "../tasmee-pipeline.js";
import { tasmeeNorm } from "../tasmee-norm.js";
import { TASMEE_LIVE } from "../tasmee-live-config.js";

const MODEL_URL = "/models/tasmee/fastconformer_ar_ctc_q8pc-head.onnx";
const VOCAB_URL = "/models/tasmee/vocab.json";
const SR = TASMEE_LIVE.sr;

/* ---------- one ORT worker, init once (no live session) ---------- */
let _w = null, _ready = null;
function ortWorker() {
    if (!_w) {
        _w = new Worker(new URL("../tasmee-worker.js", import.meta.url), { type: "module" });
        _ready = new Promise((res, rej) => {
            const h = (e) => {
                if (e.data?.type === "ready") { _w.removeEventListener("message", h); res(); }
                if (e.data?.type === "error") { _w.removeEventListener("message", h); rej(new Error(e.data.message)); }
            };
            _w.addEventListener("message", h);
            _w.postMessage({ type: "init", modelUrl: MODEL_URL, vocabUrl: VOCAB_URL });
        });
    }
    return _ready.then(() => _w);
}

/* Serialized ORT decode over a PCM buffer via the worker's existing
 * sessionless `decode` message — the same decodeSlice the live path runs. */
let _q = Promise.resolve();
function makeOrtDecode(pcm16k, rawLog = null) {
    return (startS, endS) =>
        (_q = _q.then(async () => {
            const w = await ortWorker();
            const slice = pcm16k.slice(Math.floor(startS * SR), Math.floor(endS * SR)); // worker liveDecode arithmetic
            const words = await new Promise((res, rej) => {
                const h = (e) => {
                    const m = e.data || {};
                    if (m.type === "decoded") { w.removeEventListener("message", h); res(m.words); }
                    else if (m.type === "error") { w.removeEventListener("message", h); rej(new Error(m.message)); }
                };
                w.addEventListener("message", h);
                w.postMessage({ type: "decode", pcm: slice, startS }, [slice.buffer]);
            });
            if (rawLog) rawLog.push({ startS, endS, words });
            return words;
        }));
}

/* ---------- live replay with full tracing (schedule = worker streamWav:
 * pump over pre-pad audio, drain over padded; same as the Phase-2 scorer,
 * but decode = REAL ORT) ---------- */
async function replayLiveTraced(clip) {
    const events = [];
    const session = createTasmeeSession({
        words: clip.ref.map((r) => ({ vk: r.vk, pos: r.pos, form: r.form })),
        onEvent: (e) => events.push(e),
    });
    const rawLog = [];
    const decode = makeOrtDecode(clip.pcm16k, rawLog);
    const trace = [];
    let vad = buildVad(clip.pcm16k.subarray(0, clip.pumpEndLen), { policy: TASMEE_LIVE.vadPolicy });
    const ctl = createStreamController({
        session, decode,
        isSpeech: (a, b) => vad.isSpeech(a, b),
        findSilenceBefore: (a, b) => vad.findSilenceBefore(a, b),
        norm: tasmeeNorm,
        ...TASMEE_LIVE.controller,
        debug: (chunkEnd, commitN, pending, anchorS) =>
            trace.push({ chunkEnd, anchorS, commitN, pending: pending.map((p) => ({ t: p.text, s: p.startS, e: p.endS })) }),
    });
    let next = TASMEE_LIVE.stepS;
    while (next <= clip.pumpEndLen / SR) { await ctl.step(next); next += TASMEE_LIVE.stepS; }
    vad = buildVad(clip.pcm16k, { policy: TASMEE_LIVE.vadPolicy });
    const endS = clip.pcm16k.length / SR;
    while (next < endS + TASMEE_LIVE.stepS) { await ctl.step(Math.min(next, endS)); next += TASMEE_LIVE.stepS; }
    ctl.flush(endS);
    session.stop(Math.round(endS * 1000));
    return { events, words: session.getWords(), committed: ctl.results().committed, trace, rawLog };
}

/* ---------- verdict summaries ---------- */
function verdictsFromEvents(clip, events) {
    const v = new Map(); // "vk:pos" → verdict
    for (const e of events) if (e.type === "reveal") v.set(`${e.vk}:${e.pos}`, e.verdict);
    const out = { false_skip: [], false_wrong: [], unrevealed: [], insertions: events.filter((e) => e.type === "insertion").length };
    for (const r of clip.ref) {
        const loc = `${r.vk}:${r.pos}`, verdict = v.get(loc);
        if (verdict === "skipped") out.false_skip.push(loc);
        else if (verdict === "substituted") out.false_wrong.push(loc);
        else if (!verdict) out.unrevealed.push(loc);
    }
    return out;
}
const fmtV = (s) =>
    `skip[${s.false_skip.join(",") || "—"}] wrong[${s.false_wrong.join(",") || "—"}] unrev[${s.unrevealed.join(",") || "—"}] ins:${s.insertions}`;

/* ---------- per-target attribution ---------- */
function overlapWords(words, s0, s1) {
    return words.filter((w) => w.endS >= s0 - 1e-6 && w.startS <= s1 + 1e-6);
}
/* locate the target's true span: first raw window containing a word whose
 * norm equals (or contains) the target norm */
function findSpan(rawLog, targetNorm) {
    for (const win of rawLog) {
        for (const w of win.words) {
            const n = tasmeeNorm(w.text);
            if (n === targetNorm || (n.length >= targetNorm.length && n.includes(targetNorm))) {
                return { s0: w.startS, s1: w.endS, from: win };
            }
        }
    }
    return null;
}

function attributeTarget(P, clip, rep, targetNorm, label) {
    P(`  ── target «${label}» (norm ${targetNorm})`);
    const span = findSpan(rep.rawLog, targetNorm);
    if (!span) { P(`     never decoded IN FULL by ANY live window → decode-level loss (context/normalization at every window)`); return { cls: "never", span: null }; }
    P(`     full reading exists in live windows: span ${span.s0.toFixed(2)}–${span.s1.toFixed(2)}s (first seen in window ${span.from.startS.toFixed(2)}–${span.from.endS.toFixed(2)})`);
    // committedEndS before each step (reconstruct from commitAtS)
    const cAt = rep.committed.map((c) => ({ e: c.endS, at: c.commitAtS }));
    const committedEndBefore = (chunkEnd) => Math.max(0, ...cAt.filter((c) => c.at < chunkEnd - 1e-9).map((c) => c.e));
    let seen = 0, filtered = 0, partial = 0;
    const stories = [];
    for (const win of rep.rawLog) {
        if (win.endS < span.s0 + 1e-6 || win.startS > span.s1) continue; // window doesn't reach the span
        const cover = overlapWords(win.words, span.s0, span.s1);
        const readings = cover.map((w) => `${w.text}[${w.startS.toFixed(2)}]`).join(" ") || "(nothing)";
        const full = cover.some((w) => { const n = tasmeeNorm(w.text); return n === targetNorm || n.includes(targetNorm); });
        const fullW = cover.find((w) => { const n = tasmeeNorm(w.text); return n === targetNorm || n.includes(targetNorm); });
        let note = "";
        if (full) {
            seen++;
            const cE = committedEndBefore(win.endS);
            if (fullW.startS < cE - TASMEE_LIVE.controller.frameS) { filtered++; note = ` ← FULL reading FILTERED (startS ${fullW.startS.toFixed(2)} < committedEnd ${cE.toFixed(2)} − frame) — behind the commit frontier, unreachable`; }
        } else if (cover.length) partial++;
        stories.push(`     win ${win.startS.toFixed(2)}–${win.endS.toFixed(2)}: ${readings}${full ? " ✔full" : ""}${note}`);
    }
    for (const s of stories.slice(0, 14)) P(s);
    if (stories.length > 14) P(`     … ${stories.length - 14} more covering windows`);
    const cls = filtered > 0 ? "filtered-behind-frontier" : seen >= 2 ? "seen-stable-lost-elsewhere" : seen === 1 ? "seen-once-unstable" : "partial-only";
    P(`     ⇒ covering windows: ${stories.length} · full-reading windows: ${seen} (filtered-behind-frontier: ${filtered}) · partial: ${partial} → class: ${cls.toUpperCase()}`);
    return { cls, span };
}

/* ---------- context sweeps ---------- */
async function sweeps(P, clip, rep, targetNorm, span) {
    if (!span) return;
    const dec = makeOrtDecode(clip.pcm16k);
    // deciding window: last raw window whose END sits inside/just past the span start but before span end (the edge that cut the word)
    const cutting = rep.rawLog.filter((w) => w.startS <= span.s0 && w.endS >= span.s0 - 0.2 && w.endS < span.s1 + 0.04);
    const base = cutting.length ? cutting[cutting.length - 1] : rep.rawLog.find((w) => w.endS >= span.s1);
    if (!base) { P(`     (no sweep window found)`); return; }
    const has = (words) => words.some((w) => { const n = tasmeeNorm(w.text); return n === targetNorm || n.includes(targetNorm); });
    P(`     sweep base window ${base.startS.toFixed(2)}–${base.endS.toFixed(2)} (reading: ${overlapWords(base.words, span.s0, span.s1).map((w) => w.text).join(" ") || "∅"})`);
    // E1 — right-context: how many extra frames past the base edge recover the full word?
    let recovered = null;
    const maxK = Math.min(16, Math.floor((clip.pcm16k.length / SR - base.endS) / FRAME_S));
    for (let K = 1; K <= maxK; K++) {
        const words = await dec(base.startS, base.endS + K * FRAME_S);
        if (has(words)) { recovered = K; break; }
    }
    P(`     E1 right-context sweep: full reading recovered at +${recovered ?? ">" + maxK} frames (${recovered ? (recovered * 80) + " ms" : "not within " + maxK * 80 + " ms"})`);
    // E2 — left-context probe (same right edge): does more left context alone recover it?
    const l = [];
    for (const K of [4, 8, 12]) {
        const a = Math.max(0, base.startS - K * FRAME_S);
        const words = await dec(a, base.endS);
        l.push(`+${K}f:${has(words) ? "YES" : "no"}`);
    }
    P(`     E2 left-context probe (right edge fixed): ${l.join("  ")}`);
}

/* ---------- targets per clip (from the two prior diagnostics) ---------- */
const TARGETS = {
    "ayoub-105-3-5-q8pc-head": [
        ["ابابيل", "أبابيل (live: أبابي)"],
        ["فجعلهم", "فجعلهم (live: فجلهم)"],
        ["بحجاره", "بحجارة (frozen-surface skip)"],
    ],
    "qasim-97-3-5-q8pc-head": [
        ["والروح", "والروح (flag: wrong)"],
        ["فيها", "فيها (flag: skip; في over-segmentation)"],
        ["باذن", "بإذن (flag: skip)"],
        ["ربهم", "ربهم (junk region)"],
    ],
    "qasim-99-6-8-q8pc-head": [],
};

async function ensureClip(id) {
    let clip = await getClip(id);
    if (!clip) {
        const [reciter, surah, from, to] = id.replace("-q8pc-head", "").split("-");
        const p = SMOKE_PASSAGES.find((x) => x.reciter === reciter && x.surah === +surah && x.from === +from && x.to === +to)
            || { reciter, surah: +surah, from: +from, to: +to };
        clip = await capture(p, MODEL_URL);
    }
    return clip;
}

export async function runDiag2() {
    const out = [];
    const P = (s = "") => out.push(s);
    P("═════════ THROWAWAY DIAGNOSTIC #2 — live-replay trace + attribution + context sweeps ═════════");
    P("");
    for (const id of Object.keys(TARGETS)) {
        const clip = await ensureClip(id);
        P(`──────────── ${id} (${clip.ref.length} ref words)`);

        // A. both surfaces
        const live = verdictsFromEvents(clip, clip.liveEvents || []);
        P(`  A. LIVE surface (capture event log):   ${fmtV(live)}`);
        const { vocabArr } = await (async () => {
            const j = await fetch(VOCAB_URL).then((r) => r.json());
            const va = []; for (const [i, t] of Object.entries(j)) va[Number(i)] = t;
            return { vocabArr: va };
        })();
        const framesMap = new Map();
        for (let i = 0; i < clip.indices.length; i++) framesMap.set(clip.indices[i], clip.data.subarray(i * clip.V, (i + 1) * clip.V));
        const frozen = await replayClip({ ...clip, framesMap, vocabArr });
        const fz = scoreCorrectPile(frozen);
        P(`  A. FROZEN surface (Phase-2 replay):    skip[${fz.locations.false_skip.join(",") || "—"}] wrong[${fz.locations.false_wrong.join(",") || "—"}] unrev[${fz.locations.unrevealed.join(",") || "—"}] ins:${fz.totals.insertions}`);

        // B. live replay trace + reproduction check
        const rep = await replayLiveTraced(clip);
        const repTxt = rep.committed.map((w) => tasmeeNorm(w.text)).join(" ");
        const capTxt = (clip.committedFull || []).map((w) => tasmeeNorm(w.text)).join(" ");
        P(`  B. live-replay reproduction vs capture: ${repTxt === capTxt ? "IDENTICAL (trace is faithful)" : "≠ DIVERGED (thread/order nondeterminism — trace is self-consistent but not byte-faithful)"}`);
        if (repTxt !== capTxt) { P(`     capture: ${capTxt}`); P(`     replay:  ${repTxt}`); }
        const repV = verdictsFromEvents(clip, rep.events);
        P(`     replay verdicts: ${fmtV(repV)}`);

        // C+D. per-target attribution + sweeps
        for (const [normT, label] of TARGETS[id]) {
            const { cls, span } = attributeTarget(P, clip, rep, normT, label);
            if (cls !== "never") await sweeps(P, clip, rep, normT, span);
            P("");
        }
        P("");
    }
    P("(end diagnostic #2)");
    return out.join("\n");
}

window.__labDiag2 = { runDiag2 };
