/* DECODE-WINDOW CEILING fixtures (2026-07-26).
 *
 * Mohammed reported that live reveal "started following what I recite so
 * slowly" partway through a session. It was not the model and not the
 * matcher — it was the decode window growing without bound.
 *
 * In incremental mode the window is [anchorS, chunkEnd]. The anchor
 * re-pins on hysteresis against the FRONTIER (min of committedEnd and the
 * first pending word's start), and `windowS` — the cap that would have
 * bounded this — lives in the else-branch and does not apply here. So
 * when the frontier stalls, because a word keeps re-decoding and never
 * commits, nothing bounds the window at all: chunkEnd keeps advancing and
 * every decode gets more expensive than the last.
 *
 * MEASURED on his own 83 s recitation of page 507: 6 s at t=70 s, 11 s at
 * t=77 s, 17.9 s at t=84 s, still climbing. An 18 s window is ~6x the
 * decode cost of a 3 s one, and the ship path is wasm where RTF is ~1 at
 * a normal window — so the pipeline drops far behind real time and never
 * catches up. The offline bench could not have caught this: it builds the
 * VAD once and its own clips never stalled the frontier long enough.
 *
 * These fixtures pin the guard, and pin that it is ONLY a guard: on every
 * golden clip the window peaks around 8 s and the ceiling never fires, so
 * all seven clips stayed byte-identical (04/05 P 1.00 · R 1.00 · FP 0).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createStreamController } from "../../src/tasmee-stream.js";
import { TASMEE_LIVE } from "../../src/tasmee-live-config.js";

/* A session stub: the controller only needs these to run. */
const stubSession = () => ({
    feedToken() { }, tick() { }, getEvents() { return []; },
    preview() { return []; }, applyReverdict() { return []; },
});

/* Drives the controller with a decode that NEVER lets a word settle, which
 * is what a stalled frontier looks like from the controller's side. */
async function runStalled(opts = {}) {
    const asked = [];
    const ctl = createStreamController({
        session: stubSession(),
        decode: async (startS, endS) => {
            asked.push({ startS, endS, win: endS - startS });
            /* One word whose start keeps sliding, so it can never agree with
             * itself across two decodes and never commits. */
            return [{ text: "كلمة", startS: endS - 0.9 + Math.random() * 1e-3, endS: endS - 0.1 }];
        },
        isSpeech: () => true,                 // continuous speech: no silence release
        findSilenceBefore: () => null,        // and no snap available either
        norm: (t) => t,
        ...TASMEE_LIVE.controller,
        ...opts,
    });
    for (let t = 0.3; t <= 90; t += 0.3) await ctl.step(+t.toFixed(2));
    return asked;
}

test("a stalled frontier cannot grow the decode window without bound", async () => {
    const asked = await runStalled();
    const worst = Math.max(...asked.map((a) => a.win));
    const cap = TASMEE_LIVE.controller.incMaxWindowS;
    assert.ok(worst <= cap + 0.35,
        `window reached ${worst.toFixed(1)}s against a ${cap}s ceiling — the runaway guard is not holding, ` +
        `and live reveal will fall behind real time on wasm partway through a session`);
});

test("without the ceiling the window DOES run away (the bug is real)", async () => {
    /* Guards the guard: if some future refactor makes the window bounded by
     * something else, this test fails and the ceiling can be reconsidered
     * rather than cargo-culted. */
    const asked = await runStalled({ incMaxWindowS: Infinity });
    const worst = Math.max(...asked.map((a) => a.win));
    assert.ok(worst > 30,
        `expected an unbounded window to exceed 30s over a 90s stalled session, got ${worst.toFixed(1)}s`);
});

test("the ceiling only ever moves the anchor FORWARD", async () => {
    const asked = await runStalled();
    for (let i = 1; i < asked.length; i++) {
        assert.ok(asked[i].startS >= asked[i - 1].startS - 1e-9,
            `decode start went backwards (${asked[i - 1].startS} → ${asked[i].startS}); ` +
            `re-decoding already-consumed audio would re-open committed words`);
    }
});

test("a healthy session never reaches the ceiling", async () => {
    /* The window peaks near 7–8 s in normal operation, which is why every
     * golden clip stayed byte-identical when the ceiling was added. Here the
     * frontier advances normally (each decode returns a settled word at a
     * stable position), so the guard must stay dormant. */
    const asked = [];
    let n = 0;
    const ctl = createStreamController({
        session: stubSession(),
        decode: async (startS, endS) => {
            asked.push(endS - startS);
            const w = [];
            for (let k = Math.max(0, Math.floor(startS)); k < endS - 0.5; k++) {
                w.push({ text: `w${k}`, startS: k, endS: k + 0.6 });
            }
            n++;
            return w;
        },
        isSpeech: () => true,
        findSilenceBefore: (fromS) => Math.max(0, fromS - 0.1),
        norm: (t) => t,
        ...TASMEE_LIVE.controller,
    });
    for (let t = 0.3; t <= 60; t += 0.3) await ctl.step(+t.toFixed(2));
    assert.ok(n > 0, "decode was never called");
    assert.ok(Math.max(...asked) < TASMEE_LIVE.controller.incMaxWindowS,
        `a healthy session touched the ceiling (${Math.max(...asked).toFixed(1)}s) — ` +
        `the guard is set too tight and is now shaping normal behaviour`);
});
