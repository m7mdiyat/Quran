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
        /* RUNAWAY GUARD (2026-07-26): hard ceiling on [anchorS, chunkEnd].
         * The anchor hysteresis pins relative to the FRONTIER, so a stalled
         * frontier leaves the window unbounded — measured growing to 18.4 s
         * on an 83 s session, ~6x the decode cost of a normal window, which
         * on wasm is far past real time and is what made live reveal go
         * sluggish partway through. Normal operation peaks at 7–8 s. */
        incMaxWindowS: 10,
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
    /* ACOUSTIC SECOND OPINION (M5, 2026-07-25) — BUILT, MEASURED, AND OFF.
     * A negative result, recorded in full so nobody pays for it twice.
     * Mechanism in src/tasmee-acoustic.js.
     *
     * THE IDEA. The matcher compares TEXT, and text is where letter-level
     * mistakes hide: the decoder "corrects" a wrong-but-similar word toward
     * the plausible before any comparison runs, and the thresholds must stay
     * lenient enough to survive ASR fuzz (tightening the 4-5 tier to 0.85
     * costs 5 false flags and takes clip 04 to P 0.75). So: score the audio
     * against the reference word and against deliberate near-misses of it,
     * force-aligned over the same frames, and see which the frames prefer.
     *
     * IT DOES NOT SEPARATE MISTAKES FROM CORRECT RECITATION. Measured on the
     * real streaming path, 10 clips / ~1000 words: zero objections, and the
     * founder's اعمالهم→اعمارهم plant scores -0.41, BELOW clean words. A
     * dedicated forward pass per word (the expensive fix) raises the plant to
     * 0.92 — and raises الحق, a word nobody got wrong, to 1.03. The highest
     * scorer in the clip is a false positive. No threshold exists.
     *
     * CORRECTION, recorded because it nearly shipped: an earlier run of this
     * showed "plant max 3.33 vs clean max 0.00" and looked decisive. It
     * sampled 9 clean words. On all 76 the separation is gone. A sample that
     * small could not have shown what it appeared to show.
     *
     * RULED OUT ALONG THE WAY, each by measurement rather than argument:
     *   decode WIDTH   — window mode's 15 s windows behave identically
     *   decode TIMING  — a fresh slice with +0.4 s trailing audio is no better
     *   frame MOSAIC   — tagging frames by decode pass and refusing mixed
     *                    windows (samePass, still in the buffer, cheap and
     *                    correct) changed nothing: the windows were already
     *                    single-pass
     * What remains is the model itself: this 115M CTC acoustic model does not
     * resolve single Arabic letters reliably enough for a per-word verdict.
     * That is a model problem, not a scheduling or threshold problem, and the
     * next real move is a better model or a fine-tune — not more of this.
     *
     * WHAT SURVIVES, and is worth keeping. Three false-positive classes were
     * found on CORRECT recitation, each with a phonological cause rather than
     * a fudge factor, each pinned by a fixture, and each a live hazard for
     * ANY future acoustic scorer (see variantsOf):
     *   word-FINAL letters assimilate into what follows or drop at a waqf —
     *     golden 04's منهم scored its final م as ن by 2.84 nats
     *   word-INITIAL letters take the previous word's final consonant by
     *     idgham — نُزِّلَ scored its initial ن as absent by 1.44
     *   deletions ask about LENGTH (madd), not identity — أَأُنزِلَ scored
     *     without one alef by 1.69
     * Plus the equivalence-class rule: without it a letter sweep "discovers"
     * that أعمالهم beats اعمالهم and flags every hamza in the Quran.
     *
     * enabled:false makes the engine hook simply absent — the pre-M5 pipeline
     * exactly, which is what the 04/05 P 1.00 / R 1.00 numbers are on. The
     * values below are what measurement settled; they are kept so re-opening
     * this is a re-measurement and not a re-derivation. */
    /* LAYER 2 (التدقيق العميق) — OFF. Built, measured, and shelved for a
     * reason that is not accuracy: it works (10/13 of the founder's planted
     * mistakes vs 3/13 for the live matcher, 0 false flags on 111 words of
     * his clean recitation) but it is a 605M-parameter model, and checking
     * one page costs ~11 model runs. Mohammed's MacBook ran hot and the
     * feature was, in his words, not productive — a slow button that
     * reports a count is not a teacher. Correct call.
     *
     * Nothing here is deleted. The rules, the phoneme reference, the JS
     * frontend, the marks/card/playback UI and the measurement harness are
     * all model-agnostic: they consume findings, not muaalem. If a small
     * streaming model is ever trained (the only route to live harakat —
     * MEASURED: the free live check catches 0/5 planted harakat, because
     * the small model writes the reference haraka regardless of what was
     * said), flip this back on and point the worker at it.
     *
     * Turning this on WITHOUT a lighter model brings the heat back. */
    deep: { enabled: false, modelMB: 570 },
    acoustic: {
        enabled: false,
        margin: 1.0,
        backWords: 2,
        padFrames: 2,
        contiguityS: 0.4,
        checker: { variantSet: "confusable", deletions: false, skipFinal: true, skipInitial: true },
    },
};
