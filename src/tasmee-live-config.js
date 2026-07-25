/* ============================================================
 * tasmee-live-config.js — THE live tasmee pipeline configuration
 * (config-of-record, TASMEE-PLAN Gate 3/4 rulings), extracted from
 * src/tasmee-worker.js so dev tooling (the tasmee-lab replay scorer)
 * composes the streaming controller with EXACTLY the values the live
 * worker uses — one source of truth, no copy that can drift.
 *
 * Values are UNCHANGED from the worker's literals (2026-07-13 wiring):
 * any change here changes live behavior and must go through the
 * standard adoption-ruling flow (7 clips × 2 surfaces).
 * ============================================================ */

export const TASMEE_LIVE = {
    sr: 16000,          // engine-side PCM rate (post-resample)
    stepS: 0.3,         // live step cadence (worker STEP_S)
    tailPadS: 1.2,      // end-of-session silence pad (worker TAIL_PAD_S, #6 flush)
    vadPolicy: "v2",    // adopted for the incremental stack (2026-07-11 ruling)
    controller: {       // createStreamController options — config-of-record
        chunkS: 0.3,
        windowS: 15,
        contextS: 1.0,
        holdbackS: 0.3,
        frameS: 0.08,
        mode: "incremental",
        incContextS: 1.5,
        incEdgeGuardS: 0.2,
        /* AMENDMENT CHANNEL (2026-07-16): stability = sightings required
         * before a re-reading amends a committed word (same bar as the
         * commit gate's two-sighting contract); minOverlapFrac = time-
         * overlap fraction for assigning a re-read word to a committed
         * span (0.5 = dominant overlap; founder-clip fusion pairs align
         * at ~0.8–1.0, junk grazes fall below). */
        amend: { stability: 2, minOverlapFrac: 0.5 },
    },
    /* ENGINE options — createTasmeeSession({options}). Single source of
     * truth: the worker, the bench and the lab replay all spread this, so
     * strictness cannot drift between the surface that ships and the
     * surfaces that measure it. See tasmee-engine.js `thTiers` for the
     * per-tier evidence behind each number. */
    engine: {
        thTiers: [
            { maxLen: 3, th: 1.00 },      // exact — free (0 FF at 1.00, n=127)
            { maxLen: 5, th: 0.75 },      // unchanged — tightening costs FF here
            { maxLen: 7, th: 0.875 },     // 6 of 7 letter plants live in this tier
            { maxLen: Infinity, th: 0.75 }, // NEVER tighten: 5 FF in 10 words at 0.90
        ],
    },
    /* UI negative-verdict deferral ("flag when sure, wait while unsure").
     * capS: murky-case hold before painting a flag — founder-47:4's
     * amendment landed 1.8 s after the bad commit, so 2.0 covers the
     * measured case with margin (tunable; tighten after a louder-mic
     * retest). earlyDelayS/blatantSimMax: the EARLY-FLAG path — a
     * substitution whose token sim ≤ blatantSimMax is a gross mismatch
     * (boundary artifacts measured at sim 0.60–0.70: نا/منا 0.67,
     * منم/منا 0.67 — all ABOVE 0.5; real wrong-word subs score below),
     * so it paints after only earlyDelayS. Skips and insertions always
     * wait capS: skips are precisely the amendable class. */
    flagDefer: { capS: 2.0, earlyDelayS: 0.5, blatantSimMax: 0.5 },
    /* ACOUSTIC SECOND OPINION (M5, 2026-07-25) — OFF, and the reason is
     * the useful part. See src/tasmee-acoustic.js for the mechanism.
     *
     * THE MECHANISM WORKS. Given frames from ONE self-consistent forward
     * pass, canonical-vs-near-miss discrimination separates the founder's
     * planted letter mistakes from correct recitation cleanly:
     *     frames from a whole-clip pass  plant max  2.90 · clean max  0.00
     *     frames from a fresh 2s slice   plant max  3.33 · clean max  0.00
     * On those frames it catches اعمالهم→اعمارهم, which the text matcher
     * accepts as correct — a real mistake, invisible to string comparison.
     *
     * IT DOES NOT WORK ON THE FRAMES THE LIVE RING HOLDS, and this is not
     * a threshold that needs tuning. Wired end-to-end and measured on the
     * real streaming path over 10 clips / ~1000 words: ZERO false
     * objections (largest margin anywhere −0.10, i.e. the canonical won
     * outright on every word) and ZERO catches — the same اعمالهم scores
     * −0.41 there. No threshold separates them; the signal is absent, not
     * mis-thresholded.
     *
     * WHY. The ring keys frames by absolute index with latest-decode-wins,
     * so a single word's frames are a MOSAIC of several overlapping
     * decodes, each with its own anchor. A forced alignment over a frame
     * sequence that is not internally consistent cannot resolve one letter.
     * Ruled out first, both by measurement: decode WIDTH (window mode's
     * 15 s windows behave identically) and decode TIMING (a fresh slice
     * with only +0.4 s of trailing audio scores BEST of all).
     *
     * THE FIX, MEASURED BUT NOT BUILT: score on a dedicated batched pass —
     * one decode of a ~3 s slice behind the live frontier, covering ~6
     * words, scored together. ~+17% compute (vs ~+90% scoring each word
     * with its own pass, which is why it must be batched). It costs a
     * product decision, not just code: objections would land ~1–2 s after
     * the word, so either the green verdict waits (~0.5–1 s later than
     * today; the provisional ink at 0.3 s is unaffected either way) or a
     * word turns green then red. That is Mohammed's call.
     *
     * Everything below is the config that measurement settled, kept so the
     * fix above is a scheduling change and not a re-derivation:
     *   margin θ=1.0     · the clean distribution's max is −0.10, so θ=1.0
     *                      carries a full nat of headroom
     *   backWords 2, padFrames 2, contiguityS 0.4  · the −2/+1 window
     *   variantSet confusable · the full 28-letter sweep measured 12%
     *                      false flags at θ=0.5 (vs 1%) for 139 Viterbi
     *                      passes/word instead of 11 — worse on both axes
     *   deletions false, skipFinal/skipInitial true · see variantsOf; each
     *                      of the three fixed a specific measured false
     *                      positive on correct recitation
     * enabled:false makes the engine hook simply absent — the pre-M5
     * pipeline exactly, which is what the 04/05 P/R 1.00 numbers are on. */
    acoustic: {
        enabled: false,
        margin: 1.0,
        backWords: 2,
        padFrames: 2,
        contiguityS: 0.4,
        checker: { variantSet: "confusable", deletions: false, skipFinal: true, skipInitial: true },
    },
};
