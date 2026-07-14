/* Worker WIRING contract for hesitation (authorized 2026-07-10,
 * TASMEE-PLAN Gate 3 status block): the audio layer calls
 * session.tick() ONLY during VAD-silence, timestamped on the
 * ACTIVITY CLOCK — lastCommittedAudioEnd + silenceRun. The engine's
 * lastActivityTs is definitionally the last committed word's audio
 * end, so the engine-measured gap equals the TRUE silence run and
 * decoder commit-lag cancels out of the arithmetic (ticking with
 * wall/clip time let a stability stall fire through a 0.5 s breath
 * gap on the 114 smoke). The engine is untouched — time still
 * arrives only as arguments; these fixtures drive a REAL engine
 * session exactly the way the fixed worker does.
 *
 * The bench implements this policy (scripts/tasmee-bench.mjs,
 * tickOnSilence); the dev-harness worker must ship the same policy
 * and keep the per-hesitation position + audio-gap print
 * byte-identical (it doubles as stability-stall telemetry for the
 * WASM p50 profiling).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createTasmeeSession } from "../../src/tasmee-engine.js";
import { refFor, tokensOf, count } from "./helpers.mjs";

/* Drive a session per the worker contract: feedToken carries the
 * word's AUDIO end time; tick fires only for VAD-silent chunks. */
function drive(session, events) {
    for (const e of events) {
        if (e.tok !== undefined) session.feedToken(e.tok, e.t);
        else if (e.silent) session.tick(e.t);
        // speech chunks without commits: NO tick — that is the fix
    }
}

const silenceTicks = (fromMs, toMs, stepMs = 300) => {
    const out = [];
    for (let t = fromMs; t <= toMs; t += stepMs) out.push({ t, silent: true });
    return out;
};

test("wiring(i): commit-lag under continuous speech fires ZERO hesitations", () => {
    const ref = refFor("2:6");
    const s = createTasmeeSession({ words: ref });
    const toks = tokensOf(ref);
    // Two words commit normally, then the decoder stalls for 9 s of
    // CONTINUOUS speech (no silent chunk → no tick), then the stalled
    // words burst-commit with their real audio times.
    drive(s, [
        { tok: toks[0], t: 400 },
        { tok: toks[1], t: 800 },
        // 0.8 s → 9.8 s: VAD = speech throughout; nothing to tick
        { tok: toks[2], t: 9200 }, // burst arrives late (commit-lag)
        { tok: toks[3], t: 9500 },
        { tok: toks[4], t: 9800 },
    ]);
    assert.equal(count(s, "hesitation"), 0, "commit-lag must never read as hesitation");
});

test("wiring(ii): TRUE silence of the same duration still fires", () => {
    const ref = refFor("2:6");
    const s = createTasmeeSession({ words: ref });
    const toks = tokensOf(ref);
    drive(s, [
        { tok: toks[0], t: 400 },
        { tok: toks[1], t: 800 }, // mid-ayah pointer; last activity 800
        ...silenceTicks(1100, 9800),
    ]);
    assert.equal(count(s, "hesitation"), 1, "real 4 s+ silence fires exactly once");
    const h = s.getEvents().find((e) => e.type === "hesitation");
    assert.ok(h.t >= 4800 && h.t <= 5200, `fired ~4 s after last activity, got t=${h.t}`);
});

test("wiring(iv): commit-lag + SHORT breath gap fires nothing (the 114-smoke class)", () => {
    const ref = refFor("2:6");
    const s = createTasmeeSession({ words: ref });
    const toks = tokensOf(ref);
    // Words committed with audio ends up to 800 ms; the decoder then
    // stalls while speech continues to ~14.5 s; a 0.6 s breath gap
    // follows. Activity-clock ticks: base = last committed audio end
    // (800) + silence run (≤600) → gap ≤ 600 ms → NO fire, even
    // though wall time is 14 s past the last commit.
    drive(s, [
        { tok: toks[0], t: 400 },
        { tok: toks[1], t: 800 },
        // speech (stalled decoder): no ticks
        { t: 800 + 300, silent: true },  // activity-clock: run 300ms
        { t: 800 + 600, silent: true },  // activity-clock: run 600ms
    ]);
    assert.equal(count(s, "hesitation"), 0, "short true gap after commit-lag must not fire");
});

test("wiring(iii): boundary 2× grace unchanged under the new wiring", () => {
    const ref = refFor("2:6-7");
    const s = createTasmeeSession({ words: ref });
    const t6 = tokensOf(refFor("2:6"));
    const events = t6.map((tok, i) => ({ tok, t: 400 * (i + 1) }));
    const lastT = 400 * t6.length; // ayah completed → pointer at 2:7:1 (boundary)
    drive(s, [...events, ...silenceTicks(lastT + 300, lastT + 7800)]);
    assert.equal(count(s, "hesitation"), 0, "mid-ayah duration must NOT fire at waqf");
    drive(s, [{ t: lastT + 8100, silent: true }]);
    assert.equal(count(s, "hesitation"), 1, "true boundary stall fires at 2× grace");
});
