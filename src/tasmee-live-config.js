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
};
