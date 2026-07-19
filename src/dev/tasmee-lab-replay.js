/* ============================================================
 * tasmee-lab-replay.js — PERMANENT lab scoring mode: LIVE-FAITHFUL
 * trace-replay (promoted from the throwaway diag2/diag3 instruments,
 * 2026-07-16).
 *
 * Re-runs the EXACT live pipeline over a captured clip: real ORT
 * decodes through the worker's own sessionless `decode` message (the
 * same decodeSlice the live path runs), the real stream controller
 * (config-of-record spread, `debug` hook for tracing), the real
 * engine. Reproduction is checked against the capture's committed
 * list — on every clip measured to date the replay is byte-identical.
 *
 * THIS is the verdict surface for accuracy gates and tuning. The
 * frozen-logprob replay (tasmee-lab-score.js) is LOGPROB-INSPECTION
 * ONLY: its latest-decode-wins rows diverge from live on marginal
 * words and have manufactured phantom flags — never score verdicts
 * on it.
 * ============================================================ */

import { getClip } from "./tasmee-lab-db.js";
import { createTasmeeSession } from "../tasmee-engine.js";
import { createStreamController } from "../tasmee-stream.js";
import { buildVad } from "../tasmee-pipeline.js";
import { tasmeeNorm } from "../tasmee-norm.js";
import { TASMEE_LIVE } from "../tasmee-live-config.js";

const MODEL_URL = "/models/tasmee/fastconformer_ar_ctc_q8pc-head.onnx";
const VOCAB_URL = "/models/tasmee/vocab.json";
const SR = TASMEE_LIVE.sr;

/* One shared ORT worker for all replays (model loaded once). */
let _w = null, _ready = null;
export function ortWorker() {
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

/* Serialized real-ORT decode over a PCM buffer; optionally logs every
 * raw window (pre-filter visibility the controller itself never has). */
let _q = Promise.resolve();
export function makeOrtDecode(pcm16k, rawLog = null) {
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

/* Live-faithful replay. `controllerOverrides` lets a caller flip
 * controller options (e.g. {amend:null} for a pre-amendment baseline) —
 * default = the exact live config. */
export async function replayLiveTraced(clip, { controllerOverrides = {}, engineOptions = {} } = {}) {
    const events = [];
    const session = createTasmeeSession({
        words: clip.ref.map((r) => ({ vk: r.vk, pos: r.pos, form: r.form })),
        onEvent: (e) => events.push(e),
        // DEV: engine option overrides (e.g. {thMatch: 0.875}) so a strictness
        // change can be MEASURED through the real matcher rather than
        // estimated from a single run's similarity numbers. Default {} = live.
        options: engineOptions,
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
        ...controllerOverrides,
        debug: (chunkEnd, commitN, pending, anchorS) =>
            trace.push({ chunkEnd, anchorS, commitN, pending: pending.map((p) => ({ t: p.text, s: p.startS, e: p.endS })) }),
    });
    let next = TASMEE_LIVE.stepS;
    while (next <= clip.pumpEndLen / SR) { await ctl.step(next); next += TASMEE_LIVE.stepS; }
    vad = buildVad(clip.pcm16k, { policy: TASMEE_LIVE.vadPolicy });
    const endS = clip.pcm16k.length / SR;
    while (next < endS + TASMEE_LIVE.stepS) { await ctl.step(Math.min(next, endS)); next += TASMEE_LIVE.stepS; }
    ctl.flush(endS);
    const summary = session.stop(Math.round(endS * 1000));
    const committed = ctl.results().committed;
    return {
        events,
        words: session.getWords(),
        summary,
        committed,
        trace,
        rawLog,
        // reproduction check vs the ORIGINAL capture (both ran the same
        // config; a controllerOverrides replay may legitimately differ)
        reproduction: committed.map((w) => tasmeeNorm(w.text)).join(" ") ===
            (clip.committedFull || []).map((w) => tasmeeNorm(w.text)).join(" "),
    };
}

/* Verdict summary vs the clip's reference (correct-pile scoring). */
export function scoreVerdicts(clip, words, events) {
    const v = new Map();
    for (const w of words) if (w.verdict) v.set(`${w.vk}:${w.pos}`, w.verdict);
    const out = { false_skip: [], false_wrong: [], unrevealed: [] };
    for (const r of clip.ref) {
        const loc = `${r.vk}:${r.pos}`, verdict = v.get(loc);
        if (verdict === "skipped") out.false_skip.push(loc);
        else if (verdict === "substituted") out.false_wrong.push(loc);
        else if (!verdict) out.unrevealed.push(loc);
    }
    out.insertions = events.filter((e) => e.type === "insertion").length;
    out.amends = events.filter((e) => e.type === "amend").length;
    out.flags = out.false_skip.length + out.false_wrong.length + out.unrevealed.length;
    // de-fuzzing metric: how many correct words were heard EXACTLY
    let exact = 0, correct = 0;
    const heardOf = new Map();
    for (const e of events) if (e.type === "reveal" || e.type === "amend") {
        if (e.heard) heardOf.set(`${e.vk}:${e.pos}`, e.heard);
    }
    for (const r of clip.ref) {
        if (v.get(`${r.vk}:${r.pos}`) === "correct") {
            correct++;
            const h = heardOf.get(`${r.vk}:${r.pos}`);
            if (h && tasmeeNorm(h) === r.form) exact++;
        }
    }
    out.exactHeard = { exact, correct };
    return out;
}

/* High-level: live-faithful scoring of a stored clip. */
export async function scoreLiveClip(clipId, { controllerOverrides = {}, engineOptions = {} } = {}) {
    const clip = await getClip(clipId);
    if (!clip) throw new Error(`no clip ${clipId}`);
    const rep = await replayLiveTraced(clip, { controllerOverrides, engineOptions });
    const score = scoreVerdicts(clip, rep.words, rep.events);
    return { clip, rep, score };
}
