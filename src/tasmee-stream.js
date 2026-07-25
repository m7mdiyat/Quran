/* ============================================================
 * tasmee-stream.js — the streaming controller ("worker core").
 * Extracted verbatim from scripts/tasmee-bench.mjs so the bench
 * (onnxruntime-node) and the dev-harness worker (onnxruntime-web)
 * run the SAME control flow: pinned window with silence-snapped
 * anchor jumps, word-identity stability commit, madd-aware dedup +
 * latency anchoring, end-of-clip flush, and the hesitation wiring
 * (ticks only during VAD-silence, on the ACTIVITY CLOCK —
 * lastCommittedAudioEnd + silenceRun — so decoder commit-lag
 * cancels out; see tests/tasmee/wiring.test.mjs).
 *
 * Host supplies the environment: `decode` (backend-specific ONNX
 * runner → words), `isSpeech`/`findSilenceBefore` (VAD view), and
 * the engine session. The controller owns all streaming state.
 * ============================================================ */

export function createStreamController({
    session,            // tasmee engine session
    decode,             // async (startS, endS) → [{text,startS,endS}]
    isSpeech,           // (fromS, toS) → bool
    findSilenceBefore,  // (fromS, minS) → snapS | null (2 consecutive silent slots)
    norm,               // tasmeeNorm
    chunkS = 0.3,
    windowS = 15,
    contextS = 1.0,
    holdbackS = 0.3,
    frameS = 0.08,
    /* --decode=window|incremental (redesign authorized 2026-07-10,
     * checkpoint ruling #2). WINDOW is the reference until
     * incremental matches/beats it on the golden matrix.
     *
     * INCREMENTAL: instead of re-decoding a growing pinned window
     * (up to windowS per 0.3 s chunk ⇒ the ~25× re-decode factor),
     * each step decodes a SHORT sliding segment
     *   [segStart, chunkEnd],  segStart = ⌊(min(committedEnd,
     *   firstPendingStart) − incContextS) / chunkS⌋ · chunkS
     * PINNED parameters (seam tests assert them):
     *   incContextS — left-context overlap behind the commit/pending
     *     frontier. The segment start is derived from the frontier
     *     MINUS this margin, so the window can never open mid-word
     *     inside uncommitted speech — the الخناس truncation class is
     *     eliminated by construction, not by luck (a stalled pending
     *     word EXTENDS the segment backward rather than being cut).
     *   incEdgeGuardS — words whose CTC start falls this close to a
     *     non-zero segment start are discarded as potential left-edge
     *     truncations (reflect-padding artifacts live there).
     *   incDupWinS — commit-dedup window. Incremental is permanently
     *     in the "window just moved" state window mode only enters
     *     after an anchor jump (a slide every chunk re-segments the
     *     same audio, shifting a committed word's re-decoded start by
     *     more than frameS), so the wide post-jump dup window applies
     *     ALWAYS, not for 1.2 s. Golden 05 pins that planted phrase
     *     repeats still land (repetition acceptance) — real repeats
     *     restart well outside this window.
     *   TAIL GUARD (stitch rule, incremental only) — the LAST pending
     *     word commits only with right-context corroboration: a
     *     further word visible in the same decode, or VAD-silence
     *     after its end. A short window's tail re-segments an
     *     in-progress word into a stable-looking PREFIX fragment
     *     (الن before الناس, جن before جند — holdback alone cannot
     *     catch it because both sightings agree); a word mid-utterance
     *     has continuing speech after it, a finished word has either
     *     its successor or silence. flush() is the end-of-clip
     *     backstop, unchanged. Stability + holdback are UNTOUCHED —
     *     this only holds the frontier word while speech continues.
     *   Segment start is quantized to the chunk grid so mel frame
     *     timing is identical across consecutive decodes — the
     *     stability gate's ±2·frameS start-time identity keeps
     *     working while the window slides every chunk.
     * The stability contract itself (word identity in 2 consecutive
     * decodes + holdback) is UNTOUCHED — same code path. */
    mode = "window",
    incContextS = 1.5,
    incEdgeGuardS = 0.2,
    incDupWinS = 0.45,
    incMaxContextS = 4,
    /* Hard ceiling on the incremental decode window — the runaway guard.
     * See the re-pin site for the measurement; 10 s sits well above the
     * ~7–8 s peak of normal operation, so it fires only when the frontier
     * has genuinely stalled. */
    incMaxWindowS = 10,
    /* AMENDMENT CHANNEL (2026-07-16, from the live-vs-frozen diagnosis):
     * while decode windows still cover a committed word's span, later
     * STABLE re-readings may amend its heard-text (the correct fuller
     * readings the pending filter otherwise structurally discards).
     * null = off. {stability: sightings required (same bar as commits),
     * minOverlapFrac: time-overlap fraction to assign a re-read word to
     * a committed record}. Amendments never touch the commit gate,
     * committedEndS, dup suppression (which reads .text, not the
     * amendment), or the live engine pointer — verdicts are re-derived
     * via session.applyReverdict (shadow replay, same matcher). The
     * reference is structurally unreachable here: this module never
     * sees reference words at all. */
    amend = null,
    /* TAIL GUARD on/off (measurement knob, default = ON = shipped
     * behaviour). The guard holds the frontier word until a successor has
     * itself cleared holdback, which during continuous recitation costs a
     * FULL WORD of reveal latency — the dominant term in the measured p50.
     * Exposed so the latency/accuracy trade can be swept rather than
     * argued about. */
    tailGuard = true,
    debug = null,
}) {
    let committedEndS = 0;
    const committed = [];   // {text, startS, endS, extEndS, commitAtS}
    let prevPending = [];
    let firstCommitAtS = null;
    let anchorS = 0;
    let lastJumpS = -Infinity;
    let silenceStartS = null;
    let heldTail = null;    // last word the tail guard held — end-of-stream release via flush()
    const latencies = [];

    function tickOnSilence(chunkEnd) {
        const run = chunkEnd - silenceStartS;
        session.tick(Math.round((committedEndS + run) * 1000));
    }

    /* Dup comparison, incremental only: collapse a TRAILING repeated
     * character before comparing (إِلاَّا → الا) — an elongated
     * re-decode of the last word normalizes differently and slips the
     * equality check (01's إلا/إِلاَّا pair, flagged in both modes).
     * Trailing-only keeps الله/إله-class distinctions intact. */
    const dupForm = (t) => mode === "incremental" ? norm(t).replace(/(.)\1+$/u, "$1") : norm(t);

    function commitWord(w, atS, latAnchorS = null, rightEndS = null) {
        const last = committed[committed.length - 1];
        const dupWin = mode === "incremental" ? incDupWinS
            : (w.startS - lastJumpS < 1.2) ? 0.45 : frameS;
        if (last && dupForm(w.text) === dupForm(last.text) && w.startS <= last.extEndS + dupWin) return;
        committed.push({ ...w, extEndS: latAnchorS ?? w.endS, commitAtS: atS });
        latencies.push(atS - (latAnchorS ?? w.endS));
        const evBefore = session.getEvents().filter((e) => e.type === "reveal").length;
        /* Third arg is ADDITIVE and ignored by the matcher: it carries the
         * word's audio span so a caller holding the frames (the worker's
         * logprob ring) can offer an acoustic second opinion at reveal
         * time. Nothing in the commit gate reads it.
         *
         * `rightEndS` is the SETTLED SUCCESSOR's end. It matters more than
         * it looks: a forced alignment whose last word is the target has
         * nothing to pin the target's right boundary against, and the
         * resulting span is soft enough to wreck the comparison (measured:
         * clean-word margin p99 3.40 without right context, 0.34 with).
         * The commit gate ALREADY waits for that successor — the tail guard
         * requires it — so this costs no latency, it just stops throwing
         * away corroboration the pipeline had already paid for. */
        session.feedToken(w.text, Math.round(w.endS * 1000), { startS: w.startS, endS: w.endS, rightEndS });
        if (firstCommitAtS === null &&
            session.getEvents().filter((e) => e.type === "reveal").length > evBefore) firstCommitAtS = atS;
        committedEndS = Math.max(committedEndS, w.endS); // settled end — never the extension
        // RESYNC-vs-AMEND semantics (deliberate, fixture-pinned): once ANY
        // amendment exists, the amended transcript is authoritative — every
        // later commit (incl. resync-triggered skips) re-derives verdicts
        // from it, so a resync can never durably stomp an amended word.
        if (amendedAny) reverdictNeeded = true;
    }

    /* ---------- amendment channel ---------- */
    const amendCand = new Map();   // committedIndex → {joined, firstStart, count}
    let amendedAny = false;        // once true, every new commit re-reconciles
    let reverdictNeeded = false;   // batched: at most one shadow replay per step

    /* Track later re-readings of committed spans in this step's RAW decode
     * (`rawWords` is the pre-filter output — exactly what the pending
     * filter discards for committed spans). A reading must be SETTLED
     * (cleared holdback), assigned by dominant time-overlap, DIFFER from
     * the current effective heard-text, and repeat stably (amend.stability
     * sightings, start within ±2·frameS — the commit gate's own identity
     * bar) before it amends. A contradicting reading resets the candidate;
     * an absent one (flapping-empty window) does not. Horizon closes
     * naturally when the anchor passes the word's span. */
    function trackAmend(rawWords, chunkEnd) {
        const settled = rawWords.filter((w) => w.endS <= chunkEnd - holdbackS + 1e-9 && w.endS > w.startS);
        if (!settled.length) return;
        // committed records still covered by the current window (scan a
        // bounded recent tail; committed is commit-ordered ≈ time-ordered)
        const covered = [];
        // bounded by the ANCHOR (the physical horizon), with a generous
        // record cap as a cost backstop only — a tight cap (20) measurably
        // dropped the founder's منا record mid-horizon during a junk-commit
        // burst, losing its amendment (2026-07-16 page trace).
        for (let ci = committed.length - 1; ci >= 0 && covered.length < 64; ci--) {
            const c = committed[ci];
            const cEnd = Math.max(c.endS, c.extEndS || 0);
            if (cEnd < anchorS) break;
            covered.push(ci);
        }
        if (!covered.length) return;
        /* Overlap of a re-read word with a committed record. CTC spike
         * records (startS === endS — single-token emissions get zero width;
         * the founder's mis-split منا committed exactly so) are matched by
         * POINT CONTAINMENT with a ±2·frameS tolerance and given a small
         * nominal overlap so argmax assignment still works. */
        const ovWith = (w, c) => {
            const s0 = c.startS, s1 = Math.max(c.endS, c.extEndS || 0);
            if (s1 - s0 < frameS) {
                const tol = 2 * frameS;
                return (w.startS - tol <= s0 && s0 <= w.endS + tol) ? Math.min(w.endS - w.startS, 3 * frameS) : 0;
            }
            return Math.min(w.endS, s1) - Math.max(w.startS, s0);
        };
        /* MONOTONIC BLOCK ASSIGNMENT (2026-07-19 — replaces per-word
         * argmax). Argmax chose each re-read word's record INDEPENDENTLY,
         * so under CTC time volatility adjacent re-readings could both
         * claim one record while its true partner got nothing (the
         * الله→سبيل cross-binding class); the starved record never
         * accumulated sightings and its amendment died.
         *
         * Speech is monotonic, so the assignment must be. We take the
         * OVERLAP-CONNECTED COMPONENTS of the (word × record) bipartite
         * graph: because both sequences are time-ordered, every component
         * is automatically a contiguous run of words against a contiguous
         * run of records. That expresses all three real shapes with one
         * rule — 1↔1 (the founder's منا spike), many-words↔1-record (a
         * mis-split commit re-read whole), and 1-word↔many-records (a
         * wide re-reading absorbing a junk-commit burst, which the
         * one-word-per-record model could not represent at all and which
         * argmax only ever handled by accident, by landing on whichever
         * record happened to carry the fewest reconfirmations).
         *
         * Deterministic and STABLE across steps: the component of a given
         * word is fixed by span containment, not by a tie-break that can
         * move as the record set grows — which is what lets a reading
         * accumulate its sightings on one key. Blocks larger than
         * blockCap in either direction are DROPPED, never amended: a long
         * accidental overlap chain must fall back to pre-amendment
         * behaviour rather than rewrite a wide span. */
        const recs = covered.slice().sort((a, b) => committed[a].startS - committed[b].startS);
        const ws0 = settled.slice().sort((a, b) => a.startS - b.startS);
        const cap = amend.blockCap ?? 4;
        const wOf = new Int32Array(ws0.length).fill(-1);   // word → component
        const rOf = new Int32Array(recs.length).fill(-1);  // record → component
        let nComp = 0;
        for (let i = 0; i < ws0.length; i++) {
            for (let j = 0; j < recs.length; j++) {
                if (ovWith(ws0[i], committed[recs[j]]) <= 0) continue;
                const a = wOf[i], b = rOf[j];
                if (a < 0 && b < 0) { wOf[i] = rOf[j] = nComp++; }
                else if (a < 0) wOf[i] = b;
                else if (b < 0) rOf[j] = a;
                else if (a !== b) {                        // merge: chain through a shared span
                    for (let k = 0; k < ws0.length; k++) if (wOf[k] === b) wOf[k] = a;
                    for (let k = 0; k < recs.length; k++) if (rOf[k] === b) rOf[k] = a;
                }
            }
        }
        const blocks = new Map();                          // comp → {ws, cis}
        for (let i = 0; i < ws0.length; i++) if (wOf[i] >= 0) (blocks.get(wOf[i]) ?? blocks.set(wOf[i], { ws: [], cis: [] }).get(wOf[i])).ws.push(ws0[i]);
        for (let j = 0; j < recs.length; j++) if (rOf[j] >= 0) (blocks.get(rOf[j]) ?? blocks.set(rOf[j], { ws: [], cis: [] }).get(rOf[j])).cis.push(recs[j]);
        const byCi = new Map();                            // first record of the block → {ws, cis}
        for (const blk of blocks.values()) {
            if (!blk.ws.length || !blk.cis.length) continue;
            if (blk.ws.length > cap || blk.cis.length > cap) continue;   // refuse, don't guess
            const wS = Math.min(...blk.ws.map((w) => w.startS)), wE = Math.max(...blk.ws.map((w) => w.endS));
            const cS = Math.min(...blk.cis.map((ci) => committed[ci].startS));
            const cE = Math.max(...blk.cis.map((ci) => Math.max(committed[ci].endS, committed[ci].extEndS || 0)));
            const ov = Math.min(wE, cE) - Math.max(wS, cS);
            const cDur = cE - cS;
            if (cDur >= frameS) {                          // real spans keep the dominance bar
                const minDur = Math.min(wE - wS, cDur);
                if (ov < amend.minOverlapFrac * minDur) continue;
            }
            blk.cis.sort((a, b) => committed[a].startS - committed[b].startS);
            byCi.set(blk.cis[0], blk);
        }
        for (const [ci, blk] of byCi) {
            const ws = blk.ws.slice().sort((a, b) => a.startS - b.startS);
            const joined = ws.map((w) => norm(w.text)).join(" ");
            const c = committed[ci];
            // a block's effective reading is every record in it, in time order
            const effective = blk.cis
                .flatMap((k) => committed[k].amendTexts ?? [committed[k].text])
                .map(norm).filter(Boolean).join(" ");
            /* ACCUMULATIVE MAJORITY bar (2026-07-16, from the founder-clip
             * page-vs-lab divergence): window re-readings of a marginal
             * word flap non-consecutively (…منن، مان، منا، ما، منا…) and a
             * strict consecutive bar dies to one junk window — and which
             * window flaps varies with WASM thread context on knife-edge
             * audio. Each reading accumulates sightings across the horizon
             * (start-aligned within ±2·frameS); a reading amends when it
             * reaches amend.stability sightings AND strictly outnumbers
             * both the current reading's reconfirmations and every rival.
             * A healthy commit keeps reconfirming (eff count grows) so
             * junk flaps can never outvote it. */
            /* Tally keyed by the block's FIRST RECORD, never by its shape.
             * The hypothesis identity is the READING TEXT (st.readings is
             * keyed by it), and the shape rides along on the reading. Keying
             * the tally by shape instead fragments it: block membership
             * flaps step to step as neighbouring records enter and leave the
             * window, so the correct reading kept restarting from zero while
             * junk spellings accumulated (measured on the founder's منا —
             * منا reached 2 sightings across two shapes and could never
             * outvote a junk منن that had 2 on one). */
            let st = amendCand.get(ci);
            if (!st) amendCand.set(ci, st = { effOf: new Map(), readings: new Map() });
            /* Reconfirmations are counted PER EFFECTIVE TEXT, not once per
             * record. `eff` protects a healthy commit by making its own
             * re-sightings outvote junk flaps — but a block that has grown
             * covers a DIFFERENT span, whose combined reading has never been
             * reconfirmed at all. Charging the block hypothesis for the
             * single-record history is what let a stale sub-span tally veto a
             * correct wide re-reading (the resync/junk-burst class). */
            const eff = st.effOf.get(effective) || 0;
            if (amend.trace) amend.trace({ at: chunkEnd, ci, cis: blk.cis, text: c.text, span: [c.startS, c.endS], joined, effective, eff, cands: [...st.readings.entries()].map(([k, v]) => `${k}:${v.count}`).join("|") });
            if (joined === effective) { st.effOf.set(effective, eff + 1); continue; }   // reconfirmed
            let r = st.readings.get(joined);
            if (!r || Math.abs(r.firstStart - ws[0].startS) > 2 * frameS + 1e-6) {
                st.readings.set(joined, r = { count: 0, firstStart: ws[0].startS });
            }
            r.count++;
            r.texts = ws.map((w) => w.text);
            r.cis = blk.cis.slice();                   // shape to apply if this reading wins
            const rivals = [...st.readings.values()].filter((x) => x !== r).map((x) => x.count);
            if (r.count >= amend.stability && r.count > eff && r.count > Math.max(0, ...rivals)) {
                // the whole block's span now reads as `r.texts`: the first
                // record carries the reading, the rest are ABSORBED (empty →
                // fireReverdict emits nothing for them). committedEndS, dup
                // suppression and the live pointer are untouched.
                c.amendTexts = r.texts;
                c.amendedAtS = chunkEnd;
                for (const k of r.cis) {
                    if (k === ci) continue;
                    committed[k].amendTexts = [];
                    committed[k].amendedAtS = chunkEnd;
                }
                for (const k of r.cis) amendCand.delete(k);
                amendedAny = true;
                reverdictNeeded = true;
            }
        }
    }

    /* ---------- disagreement ⇒ UNVERIFIED (M1b, 2026-07-19) ----------
     * Some spans the model simply cannot settle. The founder's منا is the
     * signature case: five re-readings over the horizon, FIVE DISTINCT
     * spellings (منان بعدد / منن / مان / منا / ما), the correct one
     * appearing exactly once and never repeating, and the committed text
     * itself never re-appearing. The stability bar rightly refuses to amend
     * — but asserting "you skipped this" on evidence that self-contradicts
     * five ways is a claim the data does not support either.
     *
     * So when a span's re-readings persistently contradict BOTH the commit
     * and each other, its negative verdict is SUPPRESSED and reported as
     * unverified. Nothing is invented: no reading is selected, the
     * reference is never consulted, the commit gate is untouched. The
     * criterion is exactly the observed signature:
     *   · the committed text was never CONFIRMED — its own re-sightings
     *     never reached the same bar an amendment must clear. A healthy
     *     word (and a real mistake the model hears consistently) keeps
     *     re-reading as itself and sails past this, which is what stops
     *     `unverified` from becoming a leniency channel;
     *   · no reading ever reached the stability bar (else it would have
     *     amended);
     *   · at least `disagreeMin` DISTINCT contradicting readings — one or
     *     two flaps are ordinary CTC noise, not irreducible disagreement.
     * Evaluated when the anchor passes the span (horizon close), so a span
     * still accumulating evidence is never prematurely written off. */
    function finalizeAmendCands(force = false) {
        for (const [ci, st] of amendCand) {
            const c = committed[ci];
            if (!c) { amendCand.delete(ci); continue; }
            const cEnd = Math.max(c.endS, c.extEndS || 0);
            if (!force && cEnd >= anchorS) continue;         // horizon still open
            const counts = [...st.readings.values()].map((r) => r.count);
            const effMax = Math.max(0, ...st.effOf.values());
            if (effMax < amend.stability && counts.length >= (amend.disagreeMin ?? 3) &&
                Math.max(0, ...counts) < amend.stability) {
                c.unverified = true;
                reverdictNeeded = true;
            }
            amendCand.delete(ci);
        }
    }

    /* Re-derive verdicts from the full effective (amended) transcript.
     * Formed ONLY from decode outputs; feeds the SHADOW session, never
     * the live one (repetition tolerance and pointer state untouched). */
    function fireReverdict(chunkEnd) {
        if (typeof session.applyReverdict !== "function") return;
        const tokens = [];
        for (const c of committed) {
            for (const t of (c.amendTexts ?? [c.text])) {
                tokens.push({ text: t, tMs: Math.round(c.endS * 1000), unverified: !!c.unverified });
            }
        }
        session.applyReverdict(tokens, Math.round(chunkEnd * 1000));
    }

    return {
        async step(chunkEnd) {
            if (mode === "incremental") {
                // Slide every step: frontier = the earliest audio we still
                // care about (committed end, or the first pending word if
                // stability has it in flight — never truncate it). The
                // segment start SNAPS to VAD silence behind the frontier —
                // the same clean-boundary policy window mode uses at anchor
                // jumps, applied every step: a mid-speech window start
                // destabilizes the CTC segmentation of everything after it
                // (the جاءم/أجع mangle class), which stability cannot catch
                // because both short decodes share the same cut. Fallback
                // when no silence exists within incMaxContextS: the fixed
                // incContextS margin, quantized to the chunk grid.
                const frontierS = Math.min(committedEndS, prevPending.length ? prevPending[0].startS : Infinity);
                // ANCHOR HYSTERESIS (2026-07-11, from the quiet-voice
                // diagnosis): re-pin only when the window is deeper than
                // incMaxContextS — NOT per step. A per-commit-moving anchor
                // gave the two stability sightings different left contexts;
                // marginal (whisper) words flapped between readings or
                // vanished and never agreed twice (the dominant seam-drop
                // class). With hysteresis this is a mini pinned window —
                // window mode's proven design at ~1/4 scale.
                if (frontierS - anchorS > incMaxContextS) {
                    // snap AND depth compose: search backward from
                    // frontier − incContextS so the boundary is silence-clean
                    // and the context is never shallower than incContextS —
                    // a snap into the micro-gap right before the frontier word
                    // starves the decode (a long-madd final word flaps between
                    // fused/split readings until a junk split agrees twice).
                    const snap = findSilenceBefore(Math.max(0, frontierS - incContextS), Math.max(0, frontierS - incMaxContextS));
                    anchorS = snap ?? Math.max(0, Math.floor((frontierS - incContextS) / chunkS) * chunkS);
                }
                /* HARD WINDOW CEILING (2026-07-26). The hysteresis above pins
                 * the anchor relative to the FRONTIER, so when the frontier
                 * stalls — a word that keeps re-decoding and never commits —
                 * it cannot bound the window at all: chunkEnd keeps advancing
                 * and [anchorS, chunkEnd] grows without limit. The windowS cap
                 * lives in the else-branch and does NOT apply here.
                 *
                 * MEASURED on Mohammed's own 83 s recitation of page 507:
                 * the window sat at 6 s through t=70 s, then 11 s at t=77 s
                 * and 17.9 s at t=84 s — still climbing. An 18 s window costs
                 * ~6x a 3 s one, and on the ship path (wasm, RTF ~1 at a
                 * normal window) that is far past real time, so the pipeline
                 * falls behind and never recovers. That is exactly the
                 * "it started following me slowly partway through" report.
                 *
                 * This is a SAFETY VALVE, not a policy change: it pins
                 * relative to chunkEnd (the only reference that still moves
                 * when the frontier is stuck), only ever moves the anchor
                 * FORWARD, and prefers a silence boundary exactly as every
                 * other re-pin does. In normal operation the window peaks
                 * around 7–8 s, so at the shipped ceiling it never fires. */
                if (chunkEnd - anchorS > incMaxWindowS) {
                    const lo = Math.max(0, chunkEnd - incMaxWindowS);
                    const snap = findSilenceBefore(Math.max(0, chunkEnd - incContextS), lo);
                    anchorS = Math.max(anchorS, snap ?? Math.floor(lo / chunkS) * chunkS);
                }
                // no jump bookkeeping: lastJumpS stays -Infinity; the wide
                // dup window applies permanently via incDupWinS instead.
            } else if (chunkEnd - anchorS > windowS) {
                // anchor jumps snap to (2-slot) silence — a mid-word window
                // start truncates the boundary word and the truncation then
                // passes stability.
                const snap = findSilenceBefore(Math.max(0, committedEndS - 0.2), Math.max(0, committedEndS - 4));
                anchorS = snap ?? Math.max(0, committedEndS - contextS);
                lastJumpS = committedEndS; // artifact zone = commit frontier at jump time
                prevPending = [];
            }
            const chunkHasSpeech = isSpeech(chunkEnd - chunkS, chunkEnd);
            if (!chunkHasSpeech) {
                if (silenceStartS === null) silenceStartS = chunkEnd - chunkS;
                tickOnSilence(chunkEnd);
                if (prevPending.length === 0) return;
            } else {
                silenceStartS = null;
            }
            const words = await decode(anchorS, chunkEnd);
            let pending = words.filter((w) => w.startS >= committedEndS - frameS && w.endS > committedEndS + 1e-3);
            if (mode === "incremental" && anchorS > 0) {
                // left-edge guard: a word starting inside the guard band of a
                // non-zero segment start may be a truncation artifact.
                pending = pending.filter((w) => w.startS >= anchorS + incEdgeGuardS);
            }
            /* Fix #4 note (2026-07-11): a controller-side duration guard
             * for onset fragments was tried here and REVERTED same day —
             * the CTC assigns single-token words a near-zero span
             * (startS==endS at the spike), so any duration test swallows
             * the muqatta'at (ص@38:1:1 went from correct to skipped on
             * 05). The guard lives in the ENGINE instead (leading-
             * fragment rule in classifyPlain), which knows the reference
             * and cannot eat an expected letter-word. */
            // stability at WORD IDENTITY (tasmeeNorm) — surface tashkeel
            // flaps with right-context and stalled commits by a second+.
            let commitN = 0;
            for (let i = 0; i < Math.min(pending.length, prevPending.length); i++) {
                const a = pending[i], b = prevPending[i];
                if (norm(a.text) === norm(b.text) &&
                    Math.abs(a.startS - b.startS) <= 2 * frameS + 1e-6 &&
                    a.endS <= chunkEnd - holdbackS) commitN = i + 1;
                else break;
            }
            if (tailGuard && mode === "incremental" && commitN > 0 && anchorS > 0) {
                // tail guard (sliding phase only — at anchor 0 the decode
                // is full-context from clip start, byte-equivalent to
                // window mode's opening, where the fragment hazard does
                // not exist and the guard only taxed the opening word):
                // the frontier word waits for a successor that has itself
                // CLEARED HOLDBACK, or for silence in the ~0.3 s right
                // after its end. Mere successor visibility is not
                // corroboration — a junk fragment pair (يَو + الْحساب,
                // وال + الناسية) decoded inside the unstable tail zone
                // corroborates itself otherwise. The silence check is a
                // BOUNDED lookahead: a fragment's parent word keeps
                // sounding immediately after the fragment's end, while a
                // finished word before a pause has silence right there —
                // checking all the way to the chunk edge instead would
                // close the release forever once any later speech arrives
                // (held ص through its madd + pause on golden 01).
                const succ = pending[commitN];
                const succSettled = succ !== undefined && succ.endS <= chunkEnd - holdbackS;
                const wEnd = pending[commitN - 1].endS;
                // pause window [end+0.1, end+0.4] capped at the chunk edge.
                // A stricter full-0.6s-observable variant was measured
                // (2026-07-11) and bought nothing the anchor hysteresis
                // hadn't already fixed, at +0.1s p50 — reverted.
                const pauseAfter = !isSpeech(wEnd + 0.1, Math.min(wEnd + 0.4, chunkEnd));
                if (!succSettled && !pauseAfter) {
                    // remember the held word: at end-of-stream there is no
                    // successor, and under a sensitive VAD trailing room
                    // tone can read as "speech" forever — if the FINAL
                    // decode then flaps empty, prevPending is wiped and the
                    // flush backstop would lose a word that already passed
                    // stability + holdback (02-whisper final-word FAIL
                    // under the v2 VAD candidate). flush() releases it.
                    heldTail = { ...pending[commitN - 1] };
                    commitN--;
                }
            }
            for (let i = 0; i < commitN; i++) {
                // pending[i+1] is the next word in this same decode (for the
                // last committed word that is the tail guard's `succ`) — its
                // end is the right anchor the acoustic check needs.
                const right = pending[i + 1] ? pending[i + 1].endS : null;
                commitWord(pending[i], chunkEnd, Math.max(pending[i].endS, prevPending[i]?.endS ?? 0), right);
            }
            /* PROVISIONAL INK (latency): hand the still-uncommitted words to
             * the engine's PURE preview so the UI can show them now. Nothing
             * about the commit path above or below this line changes. */
            if (typeof session.preview === "function" && pending.length > commitN) {
                session.preview(pending.slice(commitN).map((w) => w.text), Math.round(chunkEnd * 1000));
            }
            prevPending = pending.slice(commitN);
            if (amend && mode === "incremental") { trackAmend(words, chunkEnd); finalizeAmendCands(); }
            if (reverdictNeeded) { reverdictNeeded = false; fireReverdict(chunkEnd); }
            if (debug) debug(chunkEnd, commitN, pending, anchorS);
        },

        /* Backstop after the tail-pad silence flush: anything still
         * pending survived ≥1 decode over fully-padded audio. If the
         * final decode flapped empty, a word the tail guard was holding
         * (already stability- and holdback-cleared) is released here —
         * the startS re-check makes this a no-op when it committed
         * normally in the meantime. */
        flush(loopEndS) {
            for (const w of prevPending) commitWord(w, loopEndS);
            if (prevPending.length === 0 && heldTail && heldTail.startS >= committedEndS - frameS) {
                commitWord(heldTail, loopEndS);
            }
            prevPending = [];
            if (amend) finalizeAmendCands(true);   // end of stream: every horizon closes
            if (reverdictNeeded) { reverdictNeeded = false; fireReverdict(loopEndS); }
        },

        results() {
            return { committed, latencies, firstCommitAtS };
        },
    };
}
