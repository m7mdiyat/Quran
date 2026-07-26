/* MEL CACHE — BYTE EQUALITY (2026-07-26).
 *
 * The incremental controller re-decodes a sliding window every 0.3 s, so
 * each second of audio has its mel recomputed 10–25 times: 20% of total
 * compute, measured, producing numbers we already had. On the ship path
 * (onnxruntime-web at RTF 0.9–1.2) that 20% decides whether the pipeline
 * keeps up with normal recitation at all.
 *
 * A cache that returns ALMOST the same numbers is worse than no cache: the
 * decode would drift with nothing failing loudly. So these fixtures assert
 * the cached path is BYTE-IDENTICAL to the uncached one across the exact
 * access pattern the controller produces — overlapping windows on the
 * chunk grid, growing and sliding.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { melFrontend, createMelCache, NMEL, HOP } from "../../src/tasmee-pipeline.js";

const SR = 16000, GRID = Math.round(0.3 * SR);   // the chunk grid: 4800 samples = 30 hops
function signal(n, seed = 3) {
    const a = new Float32Array(n);
    let x = seed;
    for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; a[i] = ((x / 0x7fffffff) - 0.5) * 0.3; }
    return a;
}

test("a cached slice is byte-identical to an uncached one", () => {
    const pcm = signal(SR * 6);
    const cache = createMelCache();
    for (const n of [SR * 2, SR * 3, SR * 4]) {
        const plain = melFrontend(pcm.subarray(0, n));
        const cached = melFrontend(pcm.subarray(0, n), cache, 0);
        assert.equal(cached.T, plain.T);
        assert.deepEqual(Array.from(cached.mel), Array.from(plain.mel), `n=${n}`);
    }
});

test("SLIDING windows on the chunk grid stay byte-identical", () => {
    /* The real access pattern: the anchor advances in 0.3 s steps and the
     * window end grows, so the same absolute frame is requested from many
     * different slice offsets. That is precisely where a cache keyed by the
     * wrong index, or reused across an unsafe edge, would diverge. */
    const pcm = signal(SR * 12, 11);
    const cache = createMelCache();
    for (let a = 0; a <= GRID * 8; a += GRID) {
        for (const len of [SR * 2, SR * 3.5, SR * 5]) {
            const end = Math.min(pcm.length, a + Math.round(len));
            const slice = pcm.subarray(a, end);
            if (slice.length < SR) continue;
            const base = Math.round(a / HOP);
            const plain = melFrontend(slice);
            const cached = melFrontend(slice, cache, base);
            assert.deepEqual(Array.from(cached.mel), Array.from(plain.mel),
                `anchor=${a} len=${end - a}`);
        }
    }
    assert.ok(cache.size > 50, "the cache should actually be retaining columns");
});

test("the cache genuinely reuses, rather than silently recomputing", () => {
    const pcm = signal(SR * 4, 7);
    const cache = createMelCache();
    melFrontend(pcm, cache, 0);
    const filled = cache.size;
    assert.ok(filled > 100, `expected many cached columns, got ${filled}`);
    // second identical call must not need to add anything new
    melFrontend(pcm, cache, 0);
    assert.equal(cache.size, filled, "a repeat call added columns — the key is unstable");
});

test("prune drops only what is behind the frontier", () => {
    const pcm = signal(SR * 4, 5);
    const cache = createMelCache();
    melFrontend(pcm, cache, 0);
    const before = cache.size;
    cache.prune(100);
    assert.ok(cache.size < before, "prune removed nothing");
    assert.equal(cache.get(50), undefined, "a column behind the frontier survived");
    assert.ok(cache.get(150) !== undefined, "a column ahead of the frontier was dropped");
});
