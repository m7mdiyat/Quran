/* GATE 2 — synthetic ASR-noise sweep (amended 2026-07-10: single
 * seeds pinned floors on noise-placement luck at n=127 — the sweep
 * runs 20 seeds per WER level and pins the regression floor on the
 * MIN across seeds; mean and min are printed for the gate record.
 * Corruption is deterministic (seeded): same engine + same seeds →
 * same rates, so exact pins are safe. Move them only with evidence. */

import test from "node:test";
import assert from "node:assert/strict";
import { createTasmeeSession } from "../../src/tasmee-engine.js";
import { refFor, tokensOf, feed, corrupt } from "./helpers.mjs";

const SEEDS = Array.from({ length: 20 }, (_, i) => 1009 + i * 37);

function runOne(wer, seed) {
    const ref = refFor("2:6-16"); // 127 words incl. long ayahs
    const s = createTasmeeSession({ words: ref });
    feed(s, corrupt(tokensOf(ref), wer, seed));
    s.stop(999999);
    return {
        len: ref.length,
        pointer: s.getState().pointer,
        rate: s.summary().counts.correct / ref.length,
    };
}

/* Floors = observed MIN across the 20-seed sweep at pin time
 * (2026-07-10, post echo-rule + stall-resync: means .980/.957/.936). */
for (const { wer, floor } of [
    { wer: 0.05, floor: 0.937 },
    { wer: 0.10, floor: 0.897 },
    { wer: 0.15, floor: 0.866 },
]) {
    test(`noise ${wer * 100}% WER × 20 seeds: min correct-rate ≥ ${floor}, all derail-free`, () => {
        const rates = [];
        for (const seed of SEEDS) {
            const r = runOne(wer, seed);
            assert.ok(r.pointer >= r.len - 2,
                `seed ${seed}: pointer ${r.pointer}/${r.len} — engine derailed`);
            rates.push(r.rate);
        }
        const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
        const min = Math.min(...rates);
        console.log(`  noise ${(wer * 100).toFixed(0)}% WER sweep: mean ${mean.toFixed(3)}, min ${min.toFixed(3)} (n=${SEEDS.length})`);
        assert.ok(min >= floor, `min ${min.toFixed(3)} < pinned floor ${floor}`);
    });
}
