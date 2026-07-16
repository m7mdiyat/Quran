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
    },
};
