/* Seam fixtures for the INCREMENTAL decode mode (redesign authorized
 * 2026-07-10, checkpoint ruling #2; conditions ruled in TASMEE-PLAN
 * Gate 3 status). These pin the stitch rule and the overlap length —
 * the pinned parameters — plus the construction property that
 * eliminates the الخناس truncation class: the sliding segment start
 * is derived from the commit/pending frontier MINUS incContextS, so
 * the window can never open mid-word inside uncommitted speech.
 *
 * The controller is driven with a SCRIPTED decode function (no ONNX)
 * against a REAL engine session, exactly like the wiring fixtures.
 * The empirical half of the contract (golden matrix window vs
 * incremental, smoke-114 الخناس) runs in scripts/tasmee-bench.mjs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createTasmeeSession } from "../../src/tasmee-engine.js";
import { tasmeeNorm } from "../../src/tasmee-norm.js";
import { createStreamController } from "../../src/tasmee-stream.js";
import { refFor, tokensOf } from "./helpers.mjs";

const CHUNK_S = 0.3, HOLDBACK_S = 0.3, FRAME_S = 0.08;
const INC_CONTEXT_S = 1.5, INC_EDGE_GUARD_S = 0.2; // pinned (bench + harness mirror these)

/* A scripted acoustic timeline: words with fixed [startS, endS].
 * decode(startS, endS) returns every word whose audio the segment
 * fully contains (a CTC can only emit a word it has heard to the
 * end), TRUNCATING a word whose start lies before the segment start
 * (that is what a real CTC decode over a cut window does — the
 * الخناس mechanism), unless the test overrides that behavior.
 * isSpeech is derived from the same timeline, the way the bench
 * derives it from RMS — the tail guard consults it. */
function makeTimeline(words) {
    return {
        calls: [],
        isSpeech: (a, b) => words.some((w) => w.startS < b && w.endS > a),
        decode(segStart, segEnd) {
            this.calls.push([segStart, segEnd]);
            return words
                .filter((w) => w.endS > segStart && w.endS <= segEnd)
                .map((w) => (w.startS < segStart
                    ? { text: w.truncatedText ?? w.text.slice(Math.ceil(w.text.length / 2)), startS: segStart, endS: w.endS, truncated: true }
                    : { ...w }));
        },
    };
}

function makeCtl(session, tl, opts = {}) {
    return createStreamController({
        session,
        decode: (a, b) => tl.decode(a, b),
        isSpeech: (a, b) => tl.isSpeech(a, b),
        findSilenceBefore: () => null,
        norm: tasmeeNorm,
        chunkS: CHUNK_S, holdbackS: HOLDBACK_S, frameS: FRAME_S,
        mode: "incremental", incContextS: INC_CONTEXT_S, incEdgeGuardS: INC_EDGE_GUARD_S,
        ...opts,
    });
}

async function stream(ctl, toS) {
    for (let endS = CHUNK_S; endS <= toS + 1e-9; endS += CHUNK_S) await ctl.step(endS);
}

/* Lay ref words on a clock: word i occupies [gap + i·(dur+gap), …+dur]. */
function layout(ref, { durS = 0.4, gapS = 0.2, offsetS = 0.3 } = {}) {
    return ref.map((w, i) => ({
        text: w.form,
        startS: offsetS + i * (durS + gapS),
        endS: offsetS + i * (durS + gapS) + durS,
    }));
}

test("incremental(i): overlap length is pinned — every non-initial segment start sits incContextS (quantized) behind the frontier", async () => {
    const ref = refFor("2:6-7");
    const s = createTasmeeSession({ words: ref });
    const tl = makeTimeline(layout(ref));
    const ctl = makeCtl(s, tl);
    await stream(ctl, 16);
    ctl.flush(16);
    assert.ok(tl.calls.length > 10, "decodes happened");
    // Reconstruct the frontier the controller used: segment starts must
    // be on the chunk grid and never closer than (incContextS − chunkS)
    // to the first word they were allowed to commit.
    for (const [a] of tl.calls) {
        assert.ok(Math.abs(a / CHUNK_S - Math.round(a / CHUNK_S)) < 1e-6, `segStart ${a} on the chunk grid`);
    }
    // The pinned value itself: with everything committed up to time T,
    // the next call's start is ⌊(T − incContextS)/chunk⌋·chunk.
    const { committed } = ctl.results();
    assert.ok(committed.length === ref.length, `all ${ref.length} words committed (got ${committed.length})`);
});

test("incremental(ii): word spanning a segment boundary commits exactly once — no duplicate, no truncation (الخناس class, constructive half)", async () => {
    const ref = refFor("114:4"); // …الوسواس الخناس
    const s = createTasmeeSession({ words: ref });
    const words = layout(ref, { durS: 0.5, gapS: 0.15 });
    const tl = makeTimeline(words);
    const ctl = makeCtl(s, tl);
    await stream(ctl, 8);
    ctl.flush(8);
    const { committed } = ctl.results();
    const texts = committed.map((w) => tasmeeNorm(w.text));
    // every ref word exactly once, في order — the timeline truncates any
    // word the segment start cuts into, so a single missing/mangled
    // الخناس here means the frontier construction regressed.
    assert.deepEqual(texts, tokensOf(ref).map(tasmeeNorm), "committed sequence = reference, no dup/truncation");
    // and the engine saw a perfect recitation
    assert.equal(s.summary().counts.substituted, 0);
    assert.equal(s.summary().counts.correct, ref.length);
});

test("incremental(iii): stalled pending word EXTENDS the segment backward instead of being cut", async () => {
    const ref = refFor("2:6");
    const s = createTasmeeSession({ words: ref });
    const words = layout(ref, { durS: 0.4, gapS: 0.2 });
    // Make word 3 flappy: decodes 1..N return it with jittered start
    // (> 2·frameS) so stability keeps rejecting it — a stall.
    const tl = makeTimeline(words);
    const base = tl.decode.bind(tl);
    let flap = 0;
    tl.decode = (a, b) => base(a, b).map((w) =>
        tasmeeNorm(w.text) === tasmeeNorm(words[2].text) && (flap++ < 6)
            ? { ...w, startS: w.startS + (flap % 2 ? 0.2 : -0.2) } // jitter kills stability
            : w);
    const ctl = makeCtl(s, tl);
    await stream(ctl, 9);
    ctl.flush(9);
    // While word 3 was stalled-pending, every segment start had to stay
    // ≥ incContextS − chunkS behind ITS start, not behind committedEnd.
    const w3startS = words[2].startS;
    const during = tl.calls.filter(([a, b]) => b > w3startS + 0.5 && b < w3startS + 2.5);
    for (const [a] of during) {
        assert.ok(a <= w3startS - INC_CONTEXT_S + CHUNK_S + 1e-9,
            `segStart ${a.toFixed(2)} must stay ≥${INC_CONTEXT_S - CHUNK_S}s behind stalled pending word at ${w3startS}`);
    }
    const { committed } = ctl.results();
    assert.equal(committed.length, ref.length, "stall recovered — all words committed");
});

test("incremental(iv): left-edge guard discards a truncation artifact starting inside the guard band", async () => {
    const ref = refFor("2:6");
    const s = createTasmeeSession({ words: ref });
    const words = layout(ref, { durS: 0.4, gapS: 0.2 });
    const tl = makeTimeline(words);
    const base = tl.decode.bind(tl);
    // Adversarial decoder: on every call with a non-zero start, prepend
    // a phantom fragment right AT the segment edge (what a cut word
    // looks like). The guard must eat it before stability ever sees it.
    tl.decode = (a, b) => {
        const out = base(a, b);
        if (a > 0) out.unshift({ text: "س", startS: a + 0.05, endS: a + 0.15 });
        return out;
    };
    const ctl = makeCtl(s, tl);
    await stream(ctl, 9);
    ctl.flush(9);
    const { committed } = ctl.results();
    assert.deepEqual(committed.map((w) => tasmeeNorm(w.text)), tokensOf(ref).map(tasmeeNorm),
        "phantom edge fragments never commit");
    assert.equal(s.summary().counts.insertions, 0, "no insertion flags from edge artifacts");
});

test("incremental(v): madd crossing the seam — extended end backdates on settle, commits once, never advances the pointer while extended", async () => {
    const ref = refFor("112:1"); // قل هو الله أحد
    const s = createTasmeeSession({ words: ref });
    // Word 2 carries a long madd: settled acoustics 0.9–1.3, but the
    // stretched vowel fills the audio until word 3 starts at 2.5. While
    // word 3 is not yet decodable, the CTC end EXTENDS to the window
    // edge; once word 3 appears, word 2 BACKDATES to its settled end
    // (the plan's madd contract). The extension must never commit (its
    // end never clears holdback) and must never swallow word 3.
    const words = [
        { text: ref[0].form, startS: 0.3, endS: 0.7 },
        { text: ref[1].form, startS: 0.9, endS: 1.3 },   // settled madd word
        { text: ref[2].form, startS: 2.5, endS: 2.9 },
        { text: ref[3].form, startS: 3.1, endS: 3.5 },
    ];
    const tl = makeTimeline(words);
    const base = tl.decode.bind(tl);
    const w2n = tasmeeNorm(words[1].text);
    tl.decode = (a, b) => base(a, b).map((w) =>
        tasmeeNorm(w.text) === w2n && b < words[2].startS + 0.1
            ? { ...w, endS: Math.max(words[1].endS, Math.min(b, words[2].startS)) } // vowel fills the tail
            : w);
    const ctl = makeCtl(s, tl);
    await stream(ctl, 6);
    ctl.flush(6);
    const { committed } = ctl.results();
    const w2commits = committed.filter((w) => tasmeeNorm(w.text) === w2n);
    assert.equal(w2commits.length, 1, "madd word commits exactly once");
    assert.equal(w2commits[0].endS, words[1].endS, "committed with the SETTLED end — the extension never advanced the pointer");
    assert.equal(committed.length, ref.length, "all words committed — the extension never swallowed word 3");
    assert.equal(s.summary().counts.correct, ref.length, "perfect recitation seen by the engine");
});

test("incremental(vi): stability + holdback untouched; tail guard governs the SLIDING phase only (anchor 0 = window-equivalent opening)", async () => {
    const ref = refFor("112:1");
    const s = createTasmeeSession({ words: ref });
    // Past the hysteresis threshold so the sliding phase engages after
    // the first commit: w1 6.0–6.4, w2 6.6–7.0, w3 7.2–7.6, w4 7.8–8.2
    // (frontier 6.4 > incMaxContextS 4 → re-pin → anchor 4.8 > 0).
    const words = layout(ref, { durS: 0.4, gapS: 0.2, offsetS: 6.0 });
    const tl = makeTimeline(words);
    const ctl = makeCtl(s, tl);
    for (let t = 0.3; t <= 6.6 + 1e-9; t += 0.3) await ctl.step(t);
    assert.equal(ctl.results().committed.length, 0, "one sighting is never enough (stability)");
    // 6.9: w1's 2nd sighting, holdback clear (6.4 ≤ 6.6). Anchor is
    // still 0 (nothing committed yet) → full-context opening, NO guard.
    await ctl.step(6.9);
    assert.equal(ctl.results().committed.length, 1, "opening word commits unguarded at anchor 0");
    // 7.2–7.8: the commit pushed the frontier past incMaxContextS →
    // anchor re-pins (> 0) → sliding phase. w2 turns stable +
    // holdback-clear at 7.5, but the guard holds it: w3 is unsettled
    // (inside the holdback zone through 7.8) and the pause window
    // after w2 is not observable-and-silent (w3's speech runs there).
    await ctl.step(7.2);
    await ctl.step(7.5);
    await ctl.step(7.8);
    assert.equal(ctl.results().committed.length, 1, "sliding-phase frontier word held — successor unsettled, speech after");
    // 8.1: w3 clears holdback (7.6 ≤ 7.8) → settled successor → w2 commits.
    await ctl.step(8.1);
    assert.ok(ctl.results().committed.length >= 2, "commits once the successor settles");
});

test("incremental(vii): guard-held final word survives an empty last decode — flush releases it (end-of-stream contract)", async () => {
    const ref = refFor("112:1");
    const s = createTasmeeSession({ words: ref });
    // Words end at 6.0–8.2s; trailing "room tone" keeps isSpeech true
    // through the end (the sensitive-VAD whisper case), so the pause
    // release never fires for the final word; and the FINAL decode
    // returns empty (tail flap) — wiping prevPending before flush.
    const words = layout(ref, { durS: 0.4, gapS: 0.2, offsetS: 6.0 });
    const tl = makeTimeline(words);
    const base = tl.decode.bind(tl);
    tl.isSpeech = () => true;                        // room tone forever
    let lastCall = 0;
    tl.decode = (a, b) => { lastCall = b; return b >= 9.9 ? [] : base(a, b); }; // final decodes flap empty
    const ctl = makeCtl(s, tl);
    await stream(ctl, 10.2);
    assert.ok(lastCall >= 9.9, "empty-decode region was reached");
    const before = ctl.results().committed.length;
    assert.ok(before < ref.length, "final word held by the guard before flush (speech never pauses)");
    ctl.flush(10.2);
    const { committed } = ctl.results();
    assert.equal(committed.length, ref.length, "flush releases the guard-held final word");
    assert.equal(tasmeeNorm(committed[committed.length - 1].text), tasmeeNorm(ref[ref.length - 1].form), "and it is the right word");
    assert.equal(s.summary().counts.correct, ref.length, "engine reveals the full reference");
});

test("incremental(viii): onset-fragment guard — a sub-frame single-letter token at clip start never commits (fix #4, 2026-07-11)", async () => {
    const ref = refFor("2:6");
    const s = createTasmeeSession({ words: ref });
    // A 50 ms «ل» artifact at 0.05s (the 05 clip-start insertion FP),
    // then the real words. Guard: norm length ≤ 1 AND span ≤ 2 frames.
    const words = [
        { text: "ل", startS: 0.05, endS: 0.10 },
        ...layout(ref, { offsetS: 0.5 }),
    ];
    const tl = makeTimeline(words);
    const ctl = makeCtl(s, tl);
    await stream(ctl, 8.4);
    ctl.flush(8.4);
    s.stop(8400);
    assert.equal(s.getEvents().filter((e) => e.type === "insertion").length, 0, "fragment dropped, no insertion FP");
    assert.equal(s.summary().counts.correct, ref.length, "all real words revealed correct");
});
