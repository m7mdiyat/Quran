/* ============================================================
 * tasmee-lab-score.js — DEV ONLY (tasmee-lab) Phase 2: deterministic
 * replay + scoring over FROZEN per-frame logprobs. No ORT.
 *
 * Composes the REAL live modules unchanged — createStreamController,
 * createTasmeeSession, makeGreedyDecoder, buildVad — with the live
 * config (TASMEE_LIVE, the same object the worker spreads), replacing
 * only the decode provider: each requested window's logprob matrix is
 * reconstructed from the capture sink and fed through the SAME greedy
 * decoder. Step schedule + VAD substrate replicate the worker's
 * streamWav semantics exactly (pump over pre-pad audio, then the
 * finishLive drain over flushed+padded audio).
 *
 * DETECTION-CONFIG SEAM: `detection` is threaded to the point between
 * "frozen logprobs → words" and the matcher. A future repair/threshold
 * layer plugs in as detection.transformWords(words, ctx) and can be
 * swept over the same frozen dumps. It is a NO-OP today by design.
 * ============================================================ */

import { createTasmeeSession } from "../tasmee-engine.js";
import { createStreamController } from "../tasmee-stream.js";
import { makeGreedyDecoder, buildVad, FRAME_S, HOP } from "../tasmee-pipeline.js";
import { tasmeeNorm } from "../tasmee-norm.js";
import { TASMEE_LIVE } from "../tasmee-live-config.js";

/* Model output frames for an n-sample window: T_mel = 1 + ⌊n/HOP⌋ (the
 * mel frontend's own arithmetic, tasmee-pipeline.js:196), then the
 * FastConformer's 8× subsampling rounds UP. Validated against every
 * captured window log at replay time (validateWindows). */
export const frameCountFor = (nSamples) => Math.ceil((1 + Math.floor(nSamples / HOP)) / 8);

export function validateWindows(windows) {
    const bad = [];
    for (const w of windows || []) {
        if (frameCountFor(w.n) !== w.T) bad.push({ ...w, expected: frameCountFor(w.n) });
    }
    return bad;
}

/* clip needs: framesMap (absIdx → Float32Array row view), V, blank,
 * vocabArr. Returns the decode provider for the controller. */
export function createFrozenDecodeProvider(clip, { detection = null } = {}) {
    const V = clip.V, SR = TASMEE_LIVE.sr;
    const GREEDY = makeGreedyDecoder(clip.vocabArr, clip.blank);
    const blankRow = new Float32Array(V).fill(-20);
    blankRow[clip.blank] = 0;
    let missing = 0, scratch = null;

    async function decode(startS, endS) {
        // The worker's exact slice arithmetic (tasmee-worker.js liveDecode).
        const n = Math.floor(endS * SR) - Math.floor(startS * SR);
        const T = frameCountFor(n);
        const base = Math.round(startS / FRAME_S);
        if (!scratch || scratch.length < T * V) scratch = new Float32Array(T * V);
        for (let t = 0; t < T; t++) {
            const row = clip.framesMap.get(base + t);
            if (row) scratch.set(row, t * V);
            else { scratch.set(blankRow, t * V); missing++; }
        }
        let words = GREEDY(scratch, T, V, startS).words;
        /* ── DETECTION-CONFIG SEAM (future repair/threshold layer) ──
         * Sits exactly between decoded words and the matcher/commit
         * machinery. NO-OP today; do not implement repair here yet. */
        if (detection && typeof detection.transformWords === "function") {
            words = detection.transformWords(words, {
                startS, endS, base, T, V,
                getFrame: (absIdx) => clip.framesMap.get(absIdx) || null,
            });
        }
        return words;
    }
    decode.missingCount = () => missing;
    return decode;
}

/* Replay one clip through the real controller+engine. Deterministic:
 * same clip + same detection config → identical events, always. */
export async function replayClip(clip, { detection = null } = {}) {
    const events = [];
    const session = createTasmeeSession({
        words: clip.ref.map((r) => ({ vk: r.vk, pos: r.pos, form: r.form })),
        onEvent: (ev) => events.push(ev),
    });
    const decode = createFrozenDecodeProvider(clip, { detection });

    // VAD substrate — worker streamWav semantics: pump steps see the
    // pre-flush/pre-pad audio; the drain steps see the padded whole.
    let vad = buildVad(clip.pcm16k.subarray(0, clip.pumpEndLen), { policy: TASMEE_LIVE.vadPolicy });
    const ctl = createStreamController({
        session, decode,
        isSpeech: (a, b) => vad.isSpeech(a, b),
        findSilenceBefore: (a, b) => vad.findSilenceBefore(a, b),
        norm: tasmeeNorm,
        ...TASMEE_LIVE.controller,
    });

    const SR = TASMEE_LIVE.sr, STEP = TASMEE_LIVE.stepS;
    let next = STEP;
    while (next <= clip.pumpEndLen / SR) {           // worker pump()
        await ctl.step(next);
        next += STEP;
    }
    vad = buildVad(clip.pcm16k, { policy: TASMEE_LIVE.vadPolicy });
    const endS = clip.pcm16k.length / SR;
    while (next < endS + STEP) {                     // worker finishLive() drain
        await ctl.step(Math.min(next, endS));
        next += STEP;
    }
    ctl.flush(endS);
    const summary = session.stop(Math.round(endS * 1000));

    return {
        events,
        words: session.getWords(),                   // [{vk,pos,verdict}]
        summary,
        committed: ctl.results().committed,
        missingFrames: decode.missingCount(),
    };
}

/* CORRECT-pile scoring: ground truth = every reference word recited
 * correctly in order → expected ZERO flags, ALL words revealed. */
export function scoreCorrectPile(replay) {
    const false_skip = [], false_wrong = [], unrevealed = [];
    for (const w of replay.words) {
        const loc = `${w.vk}:${w.pos}`;
        if (w.verdict === "skipped") false_skip.push(loc);
        else if (w.verdict === "substituted") false_wrong.push(loc);
        else if (!w.verdict) unrevealed.push(loc);
        // correct / hinted → as expected (hinted can't occur in replay)
    }
    const insertions = replay.events.filter((e) => e.type === "insertion").length;
    const repetitions = replay.events.filter((e) => e.type === "repetition").length;
    return {
        totals: {
            refWords: replay.words.length,
            false_skip: false_skip.length,
            false_wrong: false_wrong.length,
            unrevealed: unrevealed.length,
            insertions, repetitions,
        },
        locations: { false_skip, false_wrong, unrevealed },
        clean: false_skip.length + false_wrong.length + unrevealed.length === 0,
    };
}
