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

    function commitWord(w, atS, latAnchorS = null) {
        const last = committed[committed.length - 1];
        const dupWin = mode === "incremental" ? incDupWinS
            : (w.startS - lastJumpS < 1.2) ? 0.45 : frameS;
        if (last && dupForm(w.text) === dupForm(last.text) && w.startS <= last.extEndS + dupWin) return;
        committed.push({ ...w, extEndS: latAnchorS ?? w.endS, commitAtS: atS });
        latencies.push(atS - (latAnchorS ?? w.endS));
        const evBefore = session.getEvents().filter((e) => e.type === "reveal").length;
        session.feedToken(w.text, Math.round(w.endS * 1000));
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
        for (let ci = committed.length - 1; ci >= 0 && covered.length < 20; ci--) {
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
        // dominant-overlap assignment: each settled word → one committed record
        const byCi = new Map();
        for (const w of settled) {
            let best = -1, bestOv = 0;
            for (const ci of covered) {
                const ov = ovWith(w, committed[ci]);
                if (ov > bestOv) { bestOv = ov; best = ci; }
            }
            if (best < 0) continue;
            const c = committed[best];
            const cDur = Math.max(c.endS, c.extEndS || 0) - c.startS;
            if (cDur >= frameS) {                    // real spans keep the dominance bar
                const minDur = Math.min(w.endS - w.startS, cDur);
                if (bestOv < amend.minOverlapFrac * minDur) continue;
            }
            if (!byCi.has(best)) byCi.set(best, []);
            byCi.get(best).push(w);
        }
        for (const [ci, ws] of byCi) {
            ws.sort((a, b) => a.startS - b.startS);
            const joined = ws.map((w) => norm(w.text)).join(" ");
            const c = committed[ci];
            const effective = (c.amendTexts ?? [c.text]).map(norm).join(" ");
            if (amend.trace) amend.trace({ at: chunkEnd, ci, text: c.text, span: [c.startS, c.endS], joined, effective, cand: amendCand.get(ci)?.count ?? 0 });
            if (joined === effective) { amendCand.delete(ci); continue; }   // current reading reconfirmed
            const prev = amendCand.get(ci);
            if (prev && prev.joined === joined && Math.abs(prev.firstStart - ws[0].startS) <= 2 * frameS + 1e-6) {
                prev.count++;
                if (prev.count >= amend.stability) {
                    c.amendTexts = ws.map((w) => w.text);
                    c.amendedAtS = chunkEnd;
                    amendCand.delete(ci);
                    amendedAny = true;
                    reverdictNeeded = true;
                }
            } else {
                amendCand.set(ci, { joined, firstStart: ws[0].startS, count: 1 });
            }
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
                tokens.push({ text: t, tMs: Math.round(c.endS * 1000) });
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
            if (mode === "incremental" && commitN > 0 && anchorS > 0) {
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
                commitWord(pending[i], chunkEnd, Math.max(pending[i].endS, prevPending[i]?.endS ?? 0));
            }
            prevPending = pending.slice(commitN);
            if (amend && mode === "incremental") trackAmend(words, chunkEnd);
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
            if (reverdictNeeded) { reverdictNeeded = false; fireReverdict(loopEndS); }
        },

        results() {
            return { committed, latencies, firstCommitAtS };
        },
    };
}
