/* ============================================================
 * tasmee-engine.js — GATE 2 of TASMEE-PLAN.md (§2).
 *
 * The alignment engine for وضع التسميع: consumes STABLE ASR tokens
 * (already past the worker's decode-stability gate) plus clock
 * ticks, classifies each token against the expected word sequence,
 * and emits reveal/mistake/repetition events. PURE by contract:
 * no DOM, no audio, no timers, no Date.now() — time only ever
 * arrives as the tMs arguments. That is what makes the whole
 * fixture matrix in tests/tasmee/ runnable without a microphone
 * (Gate 2), and what keeps every field bug reproducible as a
 * fixture forever.
 *
 * Design invariants (tests pin all of these):
 *  - Reveals never retract. Nothing is emitted for a token whose
 *    interpretation is still ambiguous; commitment is deferred
 *    until evidence disambiguates (see AMBIGUITY below).
 *  - Words BEHIND the pointer are re-recitation, NEVER a mistake
 *    (the Tarteel complaint case — our differentiator).
 *  - OMISSIONS always need corroboration: a token matching ahead
 *    at p+j (any j ≥ 1) is held until the NEXT token confirms the
 *    jump by matching p+j+1. Without this, an inserted phrase
 *    whose tail happens to match a nearby expected word (e.g.
 *    استغفر الله right before an expected …الله…) would falsely
 *    skip real words. Cost: omission reveals lag by one token.
 *  - REFRAIN SAFETY (فبأي آلاء ربكما تكذبان ×31): a token matching
 *    both behind AND ahead is undecidable from text alone —
 *    repeating the previous refrain reads identically to skipping
 *    to the next one. The engine runs BOTH cursors silently and
 *    buffers until a token matches only one continuation; only
 *    then does it commit. The pointer never silently jumps
 *    between refrain instances.
 * ============================================================ */

import { tasmeeNorm } from "./tasmee-norm.js";

/* ---------- similarity ---------- */

function lev(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
        const cur = [i];
        for (let j = 1; j <= n; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
                prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        prev = cur;
    }
    return prev[n];
}

/* Normalized similarity with the short-word rule: particles like
 * من/ما/لا are 1 edit from each other, so words where either side
 * is ≤ 2 letters must match EXACTLY — a threshold cannot separate
 * them. */
function wordSim(a, b) {
    if (!a || !b) return 0;
    if (a.length <= 2 || b.length <= 2) return a === b ? 1 : 0;
    return 1 - lev(a, b) / Math.max(a.length, b.length);
}

/* ---------- muqatta'at ---------- */

/* Letter → recited name, post-tasmeeNorm (hamza dropped: هاء→ها,
 * طاء→طا…). Expansion is generated per letter so all 14 openings
 * (الم المص الر المر كهيعص طه طسم طس يس ص حم عسق ق ن) are covered
 * without a per-opening table. */
const LETTER_NAMES = {
    "ا": "الف", "ل": "لام", "م": "ميم", "ص": "صاد", "ر": "را",
    "ك": "كاف", "ه": "ها", "ي": "يا", "ع": "عين", "ط": "طا",
    "س": "سين", "ح": "حا", "ق": "قاف", "ن": "نون",
};
const MUQ_FORMS = new Set([
    "الم", "المص", "الر", "المر", "كهيعص", "طه", "طسم", "طس", "يس",
    "ص", "حم", "عسق", "ق", "ن",
]);
function muqExpansion(form) {
    if (!MUQ_FORMS.has(form)) return null;
    const names = [...form].map((ch) => LETTER_NAMES[ch]);
    return names.every(Boolean) ? names : null;
}

/* Normalized basmala, for the optional prefix (§2.1 / D4). */
const BASMALA = ["بسم", "الله", "الرحمن", "الرحيم"];

/* ---------- idghām (fix #2, ruled 2026-07-11) ----------
 * إدغام المتماثلين الصغير across a word boundary: the sakin final
 * letter of these particles merges into an IDENTICAL first letter of
 * the next word — بَل لَّمَّا → بَلَّمَّا, هَل لَّكُم, قَد دَّخَلُوا,
 * إِذ ذَّهَبَ. This is CORRECT tajweed (the mushaf itself marks it:
 * the next word's first letter carries shadda), so the ASR
 * legitimately hears one merged utterance and often emits only the
 * second word. Flagging that penalizes correct recitation — the 05
 * FP-cluster root cause. CONSERVATIVE BY RULING: table limited to the
 * cite-able متماثلين particles, the next word's first letter must
 * equal the particle's final letter, and only an EXACT match on the
 * second word (or the exact fused forms) is accepted — anything
 * fuzzier stays a mistake. Deliberately EXCLUDED: the متقاربين
 * mergers (e.g. بل ران — which Hafs reads with سكتة, no merger) —
 * a rule we can't cite cleanly for all cases doesn't go in. */
const IDGHAM_PARTICLES = new Set(["بل", "هل", "قد", "اذ"]);

/* ---------- session ---------- */

export function createTasmeeSession({ words, basmala = false, onEvent = null, options = {} } = {}) {
    const opt = {
        lookahead: 4,      // K — omission scan depth
        thMatch: 0.75,     // accept as the expected word
        thSub: 0.45,       // below match, above this → substitution
        backWindow: 30,    // repetition scan depth behind the pointer
        hesitationMs: 4000,
        hesitationBoundaryMs: 8000, // waqf grace; enforced ≥ 2× hesitationMs
        ambiguityCap: 8,   // buffered tokens before defaulting to repetition
        prefixSim: 0.85,   // split-fragment prefix acceptance
        stallCap: 6,       // unplaceable tokens before resync arms
        resyncWindow: 60,  // forward scan depth for stall recovery
        offerThreshold: 3, // consecutive unplaceable attempts at a frozen
                           // pointer before a hint is OFFERED (auto-offer #2)
        /* Amendment channel: apply WORSENING verdict changes (correct/
         * unrevealed → flagged) from re-verdicts? MEASURED HARM when true
         * (2026-07-16): on marginal audio (02-whisper), degraded deep-
         * window re-readings stabilize twice and overwrite good commits —
         * 0→10 false flags; smoke 20/20→19/20. Default FALSE: worsening
         * evidence is EMITTED (amend_evidence) but not applied — improve-
         * only keeps the real-mistake catch rate exactly at baseline
         * (mistakes are caught at commit time) while false flags fall.
         * True re-enables symmetric application (future repair layer /
         * strict mode — needs its own gate run before ever shipping). */
        amendApplyWorsen: false,
        /* LENGTH-TIERED ACCEPTANCE (M2, 2026-07-19). `thMatch` alone cannot
         * separate a real letter swap from ordinary ASR fuzz: one changed
         * letter in a 6–8 letter skeleton scores 0.833–0.857, so θ=0.75
         * forgave 3 of the founder's 7 deliberate swaps that the model had
         * heard PERFECTLY. Measured over 474 correct reference words, the
         * cost of tightening is wildly uneven by word length, so the
         * threshold is tiered rather than raised globally:
         *   ≤3 letters  exact — 0 false flags even at 1.00 (n=127). Short
         *               words are always heard exactly or not at all.
         *   4–5         unchanged — only 1 plant lives here and tightening
         *               starts costing false flags immediately (n=226).
         *   6–7         0.875 — 6 of the 7 letter plants live in this tier;
         *               0.875 clears 0.857 (one swap in 7 letters) (n=84).
         *   8+          unchanged — 5 false flags in only 10 words at 0.90.
         *               NEVER tighten this tier.
         * Applied ONLY where a token is accepted AS the expected word.
         * Scanning thresholds (lookahead, behind-scan, ambiguity, shadow)
         * stay at thMatch: tightening those changes omission and repetition
         * dynamics, a different risk surface with no measured benefit.
         * null ⇒ flat thMatch (the pre-M2 behaviour every fixture pins). */
        thTiers: null,
        ...options,
    };

    /* Acceptance threshold for a REFERENCE word, by skeleton length. */
    const thAccept = (form) => {
        if (!opt.thTiers) return opt.thMatch;
        const L = form ? form.length : 0;
        for (const t of opt.thTiers) if (L <= t.maxLen) return t.th;
        return opt.thMatch;
    };

    /* Reference sequence. `form` is the tasmee-words.json match form
     * (already normalized); `expand` the muqatta'at letter-name
     * sequence when applicable. */
    const ref = [];
    const addWords = (list) => {
        for (const w of list) {
            if (!w || typeof w.form !== "string" || !w.form) continue; // sajda nulls etc.
            ref.push({ vk: w.vk, pos: w.pos, form: w.form, expand: muqExpansion(w.form), verdict: null });
        }
    };
    addWords(words || []);

    let p = 0;               // next expected word index
    let done = false;
    const events = [];
    const insertions = [];

    // Optional basmala prefix (D4): consumed silently, never an omission.
    let prefixAt = basmala ? 0 : BASMALA.length;

    // Deferred-decision state — mutually exclusive by construction.
    let shadow = null;       // {cursor} — confirmed re-recitation run
    let amb = null;          // {behindCursor, aheadStart, aheadCursor, buffer[]}
    let pendingOmit = null;  // {token, idx} — ahead match awaiting corroboration
    let pendingSplit = null; // {parts[], joined} — fragments of a fused expected word
    let pendingSub = null;   // {token, s1, behindIdx} — echo-substitution deferral
    let muqSeq = null;       // {names[], at} — letter-name sequence in progress

    let loop = null;         // {from, to, passes, pass}
    let lastActivityTs = 0;
    let hesitationArmed = true;

    /* Stall/resync state (Gate 2 addendum #1 — found by the 20-seed
     * sweep): when a drop-cluster puts the live stream further ahead
     * than the lookahead can see, the pointer can NEVER catch up and
     * every token becomes an insertion forever. `stall` counts
     * consecutive UNPLACEABLE tokens only — insertions, not
     * repetitions — so a long legitimate re-recitation run (refrain
     * riffs!) can never arm a forward jump. Once armed, resync
     * requires TWO consecutive tokens matching forward (one exact) —
     * the same corroboration bar omissions have. */
    let stall = 0;
    let prevTok = null;
    let stuckOfferedAt = -1;  // pointer index a stuck-hint was last offered at

    /* ---------- emit / reveal ---------- */

    const emit = (e) => { events.push(e); if (onEvent) onEvent(e); };

    const lastOfAyah = (idx) => idx + 1 >= ref.length || ref[idx + 1].vk !== ref[idx].vk;

    function reveal(idx, verdict, extra, tMs) {
        const w = ref[idx];
        w.verdict = verdict;
        emit({ type: "reveal", t: tMs, idx, vk: w.vk, pos: w.pos, verdict, ...extra });
        if (lastOfAyah(idx)) emit({ type: "ayah_completed", t: tMs, vk: w.vk });
        lastActivityTs = tMs;
        hesitationArmed = true;
    }

    /* Advance the pointer to `next`, honoring loop mode and
     * completion. All pointer movement funnels through here. */
    function advanceTo(next, tMs) {
        p = next;
        if (loop && p > loop.to) {
            loop.pass++;
            emit({ type: "loop_pass", t: tMs, pass: loop.pass, of: loop.passes });
            if (loop.pass < loop.passes) {
                p = loop.from;
                emit({ type: "loop_reset", t: tMs, from: loop.from });
            } else {
                loop = null;
            }
        }
        if (p >= ref.length && !done) {
            done = true;
            emit({ type: "completed", t: tMs });
        }
    }

    /* ---------- matching primitives ---------- */

    const simAt = (t, idx) => (idx >= 0 && idx < ref.length) ? wordSim(t, ref[idx].form) : 0;

    /* Best behind-pointer match: highest similarity wins; scanning
     * from p-1 downward makes ties resolve to the NEAREST (most
     * recently recited) occurrence — the likeliest one to repeat. */
    function bestBehind(t) {
        let best = null;
        const lo = Math.max(0, p - opt.backWindow);
        for (let i = p - 1; i >= lo; i--) {
            const s = simAt(t, i);
            if (s >= opt.thMatch && (!best || s > best.s)) best = { idx: i, s };
        }
        return best;
    }

    /* Nearest ahead match within the lookahead window (smallest j). */
    function bestAhead(t) {
        for (let j = 1; j <= opt.lookahead; j++) {
            const s = simAt(t, p + j);
            if (s >= opt.thMatch) return { idx: p + j, j, s };
        }
        return null;
    }

    /* Nearest EXACT equal behind the pointer (echo-substitution guard). */
    function exactBehindIdx(t) {
        const lo = Math.max(0, p - opt.backWindow);
        for (let i = p - 1; i >= lo; i--) if (ref[i].form === t) return i;
        return -1;
    }

    const isPrefixish = (t, form) =>
        t.length >= 2 && form.length - t.length >= 2 &&
        wordSim(t, form.slice(0, t.length)) >= opt.prefixSim;

    /* CTC tail-truncation tolerance (fix #1, ruled 2026-07-11):
     * accepted ONLY at pair-corroborated sites — never for a lone
     * word. The ASR clips word tails (يذوقوا→يذوق, إله→إل); when the
     * PARTNER word of a pair matches exactly, the truncated member may
     * match as a strict prefix (≥3 chars, missing tail ≤3). A lone
     * truncated word stays a mismatch — the conservative bar against
     * a truncation matching the WRONG reference word. */
    const truncPrefix = (t, form) =>
        typeof form === "string" && t.length >= 3 &&
        form.length > t.length && form.length - t.length <= 3 &&
        form.startsWith(t);

    /* ---------- deferred-state resolution helpers ---------- */

    function resolveAmbAsRepetition(tMs) {
        for (const b of amb.buffer) {
            emit({ type: "repetition", t: tMs, idx: b.idx, heard: b.tok });
        }
        // Keep following the behind run if it hasn't rejoined yet.
        shadow = amb.behindCursor < p ? { cursor: amb.behindCursor } : null;
        amb = null;
    }

    function resolveAmbAsOmission(tMs) {
        for (let i = p; i < amb.aheadStart; i++) reveal(i, "skipped", {}, tMs);
        let idx = amb.aheadStart;
        for (const b of amb.buffer) reveal(idx++, "correct", { heard: b.tok }, tMs);
        amb = null;
        advanceTo(idx, tMs);
    }

    function flushPendingOmit(tMs) {
        // Candidate not corroborated: the held token was NOT a jump.
        const t = pendingOmit.token;
        pendingOmit = null;
        classifyPlain(t, tMs, /*allowAhead*/ false);
    }

    function flushPendingSplit(tMs) {
        const joined = pendingSplit.joined;
        pendingSplit = null;
        classifyPlain(joined, tMs, /*allowAhead*/ false);
    }

    /* Substitution-or-insertion only — the tail of classification,
     * also used when a deferred interpretation collapses (ahead
     * rescans disabled there: the evidence already failed once). */
    function classifyPlain(t, tMs, allowAhead) {
        /* Leading-fragment rule (fix #4, ruled 2026-07-11, engine-side
         * after the controller duration-guard proved unimplementable —
         * CTC spike spans): a SINGLE-LETTER token that matched nothing
         * BEFORE the first reveal is pre-recitation breath/noise (05's
         * clip-start «ل»), not content — ignore it silently. Expected
         * letter-words (ص ق ن) never reach here: they match at rule
         * 1/1b first. After recitation begins, single-letter inserts
         * flag normally. */
        if (p === 0 && t.length <= 1) return;
        if (p >= ref.length) {
            insertions.push({ idx: p, heard: t });
            emit({ type: "insertion", t: tMs, idx: p, heard: t });
            return;
        }
        const s1 = simAt(t, p);
        if (s1 >= thAccept(ref[p].form)) { reveal(p, "correct", { heard: t, sim: s1 }, tMs); advanceTo(p + 1, tMs); return; }
        if (allowAhead) {
            const ahead = bestAhead(t);
            if (ahead) { pendingOmit = { token: t, idx: ahead.idx }; return; }
        }
        if (s1 >= opt.thSub) { reveal(p, "substituted", { heard: t, sim: s1 }, tMs); advanceTo(p + 1, tMs); return; }
        insertions.push({ idx: p, heard: t });
        emit({ type: "insertion", t: tMs, idx: p, heard: t });
    }

    /* ---------- the classifier ---------- */

    function classify(t, tMs) {
        /* 0a — muqatta'at letter-name sequence in progress. */
        if (muqSeq) {
            const want = muqSeq.names[muqSeq.at];
            if (wordSim(t, want) >= opt.thMatch || t === want) {
                muqSeq.at++;
                if (muqSeq.at === muqSeq.names.length) {
                    const idx = p;
                    muqSeq = null;
                    reveal(idx, "correct", { heard: "(letter names)" }, tMs);
                    advanceTo(idx + 1, tMs);
                }
                return;
            }
            // Abandoned mid-sequence: the consumed names become one
            // insertion; the current token classifies fresh.
            const heard = muqSeq.names.slice(0, muqSeq.at).join(" ");
            muqSeq = null;
            insertions.push({ idx: p, heard });
            emit({ type: "insertion", t: tMs, idx: p, heard });
            // fall through
        }

        /* 0b — split fragments held for a fused expected word
         * (ياايها ⇐ "يا"+"ايها", يبنؤم-class up to 3 fragments). */
        if (pendingSplit) {
            const joined = pendingSplit.joined + t;
            if (simAt(joined, p) >= opt.thMatch) {
                pendingSplit = null;
                reveal(p, "correct", { heard: joined }, tMs);
                advanceTo(p + 1, tMs);
                return;
            }
            if (pendingSplit.parts.length < 2 && p < ref.length && isPrefixish(joined, ref[p].form)) {
                pendingSplit.parts.push(t);
                pendingSplit.joined = joined;
                return;
            }
            /* Fix #1 (pair site 3): the "fragment" never completes
             * because the ASR TRUNCATED the word (يذوقوا → يذوق) — if
             * what we hold is a strict prefix of the pointer word and
             * the CURRENT token matches the successor exactly, that
             * exact successor is the pair corroboration: commit the
             * truncated word as correct instead of flushing it into a
             * substitution flag. */
            if (p + 1 < ref.length && t === ref[p + 1].form && truncPrefix(pendingSplit.joined, ref[p].form)) {
                const heard = pendingSplit.joined;
                pendingSplit = null;
                reveal(p, "correct", { heard, truncated: true }, tMs);
                advanceTo(p + 1, tMs);
                classify(t, tMs); // lands on rule 1 at the successor
                return;
            }
            flushPendingSplit(tMs); // held fragments alone → plain classify
            // current token continues below
        }

        /* 0c — omission candidate awaiting corroboration. Fix #1: a
         * corroborator that is a tail-truncated PREFIX of the next
         * reference word also confirms the jump — but only when the
         * held token matched its word EXACTLY (word A exact, word B
         * prefix — the pair bar). */
        if (pendingOmit) {
            const cand = pendingOmit;
            if (simAt(t, cand.idx + 1) >= opt.thMatch ||
                (cand.token === ref[cand.idx].form && cand.idx + 1 < ref.length && truncPrefix(t, ref[cand.idx + 1].form))) {
                pendingOmit = null;
                for (let i = p; i < cand.idx; i++) reveal(i, "skipped", {}, tMs);
                reveal(cand.idx, "correct", { heard: cand.token }, tMs);
                advanceTo(cand.idx + 1, tMs);
                classify(t, tMs); // lands on rule 1 at the new pointer
                return;
            }
            flushPendingOmit(tMs);
            // current token continues below
        }

        /* 0c2 — echo-substitution deferral (Gate 2 addendum #2): the
         * previous token fuzzy-matched the pointer word while (near-)
         * exactly matching an earlier RECITED word — a real mistake
         * that reads like a repetition (said يؤمنون where يوقنون was
         * expected, with يؤمنون sitting behind). One token decides:
         * if it CONTINUES the behind run, this was re-recitation
         * (repetition, no flag); otherwise the at-pointer reading
         * wins and the mistake is FLAGGED as a substitution. Silent
         * repetition of a real mistake is the failure mode this
         * exists to prevent. */
        if (pendingSub) {
            const ps = pendingSub;
            pendingSub = null;
            const contBehind = ps.behindIdx + 1 < p && simAt(t, ps.behindIdx + 1) >= opt.thMatch;
            if (contBehind) {
                emit({ type: "repetition", t: tMs, idx: ps.behindIdx, heard: ps.token });
                shadow = { cursor: ps.behindIdx + 1 };
                classify(t, tMs); // rule 2 consumes the continuation
                return;
            }
            reveal(p, "substituted", { heard: ps.token, sim: ps.s1, echoOf: ps.behindIdx }, tMs);
            advanceTo(p + 1, tMs);
            classify(t, tMs);
            return;
        }

        /* 0d — ambiguity mode: behind and ahead runs both alive. */
        if (amb) {
            const behindNext = amb.behindCursor < p ? amb.behindCursor : -1;
            const mB = behindNext >= 0 && simAt(t, behindNext) >= opt.thMatch;
            const mA = amb.aheadCursor < ref.length && simAt(t, amb.aheadCursor) >= opt.thMatch;
            const caughtUp = amb.behindCursor >= p; // behind run reached the pointer
            if (mB && mA) {
                amb.buffer.push({ tok: t, idx: amb.behindCursor });
                amb.behindCursor++;
                amb.aheadCursor++;
                if (amb.buffer.length >= opt.ambiguityCap) resolveAmbAsRepetition(tMs);
                return;
            }
            if (mB) {
                amb.buffer.push({ tok: t, idx: amb.behindCursor });
                amb.behindCursor++;
                resolveAmbAsRepetition(tMs);
                return;
            }
            if (mA && !caughtUp) {
                amb.buffer.push({ tok: t, idx: amb.aheadCursor });
                amb.aheadCursor++;
                resolveAmbAsOmission(tMs);
                return;
            }
            // Neither continuation (or the behind run caught up to the
            // pointer): repetition is the safe, non-destructive read.
            resolveAmbAsRepetition(tMs);
            // current token continues below (often a rule-1 match at p)
        }

        /* 0e — optional basmala prefix (never an omission). */
        if (prefixAt < BASMALA.length) {
            if (p < ref.length && simAt(t, p) >= opt.thMatch) {
                prefixAt = BASMALA.length; // dismissed — user went straight in
            } else if (wordSim(t, BASMALA[prefixAt]) >= opt.thMatch) {
                emit({ type: "basmala", t: tMs, at: prefixAt });
                prefixAt++;
                lastActivityTs = tMs;
                hesitationArmed = true;
                return;
            }
            // neither prefix nor R[0]: fall through to normal rules
        }

        if (p >= ref.length) { classifyPlain(t, tMs, false); return; }

        /* 1 — MATCH at the pointer (always tried first: adjacent
         * identical words — هيهات هيهات — must advance, not loop).
         * EXACT equality always wins; a FUZZY match is downgraded to
         * an echo-substitution deferral when the token exactly equals
         * an earlier recited word (Gate 2 addendum #2) — unless it
         * exactly continues an active re-recitation run, which keeps
         * priority (rule 2 consumes it). */
        const s1 = simAt(t, p);
        if (s1 >= thAccept(ref[p].form)) {
            const exactAtP = t === ref[p].form;
            const shadowExact = !!shadow && shadow.cursor < p && t === ref[shadow.cursor].form;
            if (exactAtP || !shadowExact) {
                if (!exactAtP) {
                    const echoIdx = exactBehindIdx(t);
                    if (echoIdx >= 0) {
                        pendingSub = { token: t, s1, behindIdx: echoIdx };
                        lastActivityTs = tMs;
                        return;
                    }
                }
                shadow = null;
                reveal(p, "correct", { heard: t, sim: s1 }, tMs);
                advanceTo(p + 1, tMs);
                return;
            }
            // fuzzy at p but exactly continues the run → fall through
        }

        /* 1b — muqatta'at sequence start. Single-letter openings
         * (ص ق ن) complete on their one name immediately. */
        if (ref[p].expand && (wordSim(t, ref[p].expand[0]) >= opt.thMatch || t === ref[p].expand[0])) {
            if (ref[p].expand.length === 1) {
                reveal(p, "correct", { heard: t }, tMs);
                advanceTo(p + 1, tMs);
            } else {
                muqSeq = { names: ref[p].expand, at: 1 };
                lastActivityTs = tMs;
            }
            return;
        }

        /* 1c — merged token: ASR fused two expected words. */
        if (p + 1 < ref.length && !ref[p].expand && !ref[p + 1].expand) {
            const joined = ref[p].form + ref[p + 1].form;
            if (joined.length >= 4 && wordSim(t, joined) >= opt.thMatch) {
                reveal(p, "correct", { heard: t, merged: true }, tMs);
                reveal(p + 1, "correct", { heard: t, merged: true }, tMs);
                advanceTo(p + 2, tMs);
                return;
            }
        }

        /* 1c2 — idghām merger (fix #2, ruled 2026-07-11; NARROWED same
         * day by the 05 ear-check): pointer on بل/هل/قد/إذ whose sakin
         * final letter merges into an identical first letter of the
         * next word — accept the FUSED token forms only (بللما/بلما).
         * The original rule ALSO accepted the bare second word (لما
         * alone) on the theory that ASR drops the merged particle —
         * but the one measured incident behind that theory turned out
         * to be a REAL PLANTED SKIP mispositioned in the truth file
         * (38:8 pos 6 → 12): bare لما is exactly what a genuine skip
         * of بل sounds like, and accepting it absorbed the plant —
         * the over-match failure mode the fix ruling explicitly
         * guarded against. Fused tokens carry evidence of the
         * particle's acoustics; the bare form does not. Zero measured
         * true-merger cases currently justify the bare form —
         * documented dead end unless one appears. */
        if (p + 1 < ref.length && IDGHAM_PARTICLES.has(ref[p].form) &&
            ref[p + 1].form[0] === ref[p].form[ref[p].form.length - 1] &&
            (t === ref[p].form + ref[p + 1].form ||
                t === ref[p].form.slice(0, -1) + ref[p + 1].form)) {
            reveal(p, "correct", { heard: t, idgham: true }, tMs);
            reveal(p + 1, "correct", { heard: t, idgham: true }, tMs);
            advanceTo(p + 2, tMs);
            return;
        }

        /* 2 — shadow run continuation (confirmed re-recitation). */
        if (shadow) {
            if (shadow.cursor >= p) {
                shadow = null; // rejoined the pointer; rule 1 already failed, keep going
            } else if (simAt(t, shadow.cursor) >= opt.thMatch) {
                emit({ type: "repetition", t: tMs, idx: shadow.cursor, heard: t });
                shadow.cursor++;
                if (shadow.cursor >= p) shadow = null;
                lastActivityTs = tMs;
                return;
            } else {
                shadow = null; // run broke
            }
        }

        /* 3 — behind / ahead scan with refrain-safe deferral. */
        const behind = bestBehind(t);
        const ahead = bestAhead(t);
        if (behind && s1 >= opt.thSub) {
            // Gate 2 addendum #2 (sub band): a behind-match that is
            // ALSO a near-miss of the pointer word must not start a
            // silent repetition — defer one token; the at-pointer
            // (mistake) reading wins unless the behind run continues.
            pendingSub = { token: t, s1, behindIdx: behind.idx };
            lastActivityTs = tMs;
            return;
        }
        if (behind && ahead) {
            amb = {
                behindCursor: behind.idx + 1,
                aheadStart: ahead.idx,
                aheadCursor: ahead.idx + 1,
                buffer: [{ tok: t, idx: behind.idx }],
            };
            lastActivityTs = tMs;
            return;
        }
        if (behind) {
            emit({ type: "repetition", t: tMs, idx: behind.idx, heard: t });
            shadow = { cursor: behind.idx + 1 };
            if (shadow.cursor >= p) shadow = null;
            lastActivityTs = tMs;
            return;
        }
        if (ahead) {
            pendingOmit = { token: t, idx: ahead.idx };
            lastActivityTs = tMs;
            return;
        }

        /* 1d — split fragment start (checked after behind/ahead so a
         * full-word repetition isn't mistaken for a fragment). */
        if (isPrefixish(t, ref[p].form)) {
            pendingSplit = { parts: [t], joined: t };
            lastActivityTs = tMs;
            return;
        }

        /* 4/5 — substitution or insertion. */
        classifyPlain(t, tMs, false);
    }

    /* ---------- public API ---------- */

    /* Try to re-anchor the pointer after a stall: previous + current
     * token must match ref[q-1], ref[q] (≥ thMatch, at least one
     * exact) somewhere ahead. Words jumped over are marked skipped —
     * the engine could not confirm them; honest, and strictly better
     * than wedging the session. */
    function tryResync(t, tMs) {
        if (!prevTok) return false;
        const hi = Math.min(ref.length - 1, p + opt.resyncWindow);
        for (let q = p + 2; q <= hi; q++) {
            const sPrev = simAt(prevTok, q - 1);
            const sCur = simAt(t, q);
            // Fix #1 (pair site 2): exact previous word + tail-truncated
            // current corroborates the same as two full matches.
            const truncPair = prevTok === ref[q - 1].form && truncPrefix(t, ref[q].form);
            if ((sPrev >= opt.thMatch && sCur >= opt.thMatch &&
                (prevTok === ref[q - 1].form || t === ref[q].form)) || truncPair) {
                emit({ type: "resync", t: tMs, from: p, to: q - 1 });
                shadow = null; amb = null; pendingOmit = null; pendingSplit = null; pendingSub = null; muqSeq = null;
                for (let i = p; i < q - 1; i++) reveal(i, "skipped", {}, tMs);
                reveal(q - 1, "correct", { heard: prevTok }, tMs);
                reveal(q, "correct", { heard: t }, tMs);
                stall = 0;
                advanceTo(q + 1, tMs);
                return true;
            }
        }
        return false;
    }

    return {
        feedToken(rawToken, tMs = 0) {
            if (done) return;
            const t = tasmeeNorm(rawToken);
            if (!t) return;
            lastActivityTs = tMs;
            if (stall >= opt.stallCap && tryResync(t, tMs)) { prevTok = t; return; }
            const pBefore = p;
            const insBefore = insertions.length;
            classify(t, tMs);
            if (p > pBefore || done) {
                stall = 0;
                stuckOfferedAt = -1;   // progress clears the stuck-offer latch
            } else {
                stall += insertions.length - insBefore; // deferral flushes count too
                // Auto-offer #2 (repeated failed attempts at the same pointer =
                // genuinely stuck): a CLOSE wrong word is a substitution that
                // advances the pointer, so p only stays frozen on far-off /
                // unplaceable attempts. When those pile up past offerThreshold,
                // OFFER a hint — once per stuck position. onEvent-ONLY (never
                // pushed to events[]), so summary + the Gate 2 fixtures are
                // unchanged; an offer is not a logged outcome, only an accepted
                // hint is (as "hinted").
                if (onEvent && stall >= opt.offerThreshold && stuckOfferedAt !== p && p < ref.length) {
                    stuckOfferedAt = p;
                    onEvent({ type: "hint_offer", t: tMs, idx: p, vk: ref[p].vk, pos: ref[p].pos, reason: "attempts" });
                }
            }
            // repetitions / deferrals neither arm nor reset the stall
            prevTok = t;
        },

        /* Clock tick from the audio layer (or test). Emits at most
         * one hesitation per stall; re-arms on any activity.
         * WAQF-AWARE (Gate 3 pre-acceptance add): at an ayah boundary
         * — pointer on the first word of a new ayah, i.e. the reciter
         * just closed an ayah (or the session just started) — the
         * grace period is hesitationBoundaryMs, enforced ≥ 2× the
         * mid-ayah threshold. Pausing at waqf is correct practice,
         * not hesitation. */
        tick(tMs) {
            if (done || !hesitationArmed) return;
            if (p >= ref.length) return;
            const boundary = p === 0 || ref[p].vk !== ref[p - 1].vk;
            const graceMs = boundary
                ? Math.max(opt.hesitationBoundaryMs, opt.hesitationMs * 2)
                : opt.hesitationMs;
            if (tMs - lastActivityTs >= graceMs) {
                hesitationArmed = false;
                emit({ type: "hesitation", t: tMs, idx: p, vk: ref[p].vk, pos: ref[p].pos });
            }
        },

        /* Hint: reveal the whole next word (A1). */
        hint(tMs = 0) {
            if (done || p >= ref.length) return;
            reveal(p, "hinted", {}, tMs);
            advanceTo(p + 1, tMs);
        },

        extendReference(list) {
            addWords(list || []);
            if (ref.length && p < ref.length) done = false;
        },

        setLoop({ from, to, passes = 3 }) {
            loop = { from, to, passes, pass: 0 };
            if (p < from || p > to) p = from;
        },

        /* End of session: deferred interpretations resolve to their
         * safe readings (never invent a mistake from silence). */
        stop(tMs = 0) {
            if (pendingSplit) flushPendingSplit(tMs);
            if (pendingOmit) flushPendingOmit(tMs);
            if (pendingSub) {
                // Silent repetition of a real mistake is not acceptable
                // (Gate 2 addendum #2): unresolved echo commits as the flag.
                const ps = pendingSub;
                pendingSub = null;
                reveal(p, "substituted", { heard: ps.token, sim: ps.s1, echoOf: ps.behindIdx }, tMs);
                advanceTo(p + 1, tMs);
            }
            if (amb) resolveAmbAsRepetition(tMs);
            done = true;
            return this.summary();
        },

        summary() {
            const counts = { correct: 0, substituted: 0, skipped: 0, hinted: 0, unverified: 0, insertions: 0, repetitions: 0, hesitations: 0 };
            const perAyah = {};
            /* Word verdicts count by FINAL state per word (a Map replayed
             * from the event stream): an amendment moving a verdict — or an
             * amend landing BEFORE the live reveal (null→correct then a
             * later reveal) — must not double-count. Event-derived, so a
             * fixture-scripted stream still sums identically. */
            const byIdx = new Map();
            for (const e of events) {
                if (e.type === "reveal" || e.type === "amend") {
                    byIdx.set(e.idx, { verdict: e.type === "amend" ? e.to : e.verdict, vk: e.vk });
                } else if (e.type === "insertion") counts.insertions++;
                else if (e.type === "repetition") counts.repetitions++;
                else if (e.type === "hesitation") counts.hesitations++;
                else if (e.type === "amend_insertions") {
                    // authoritative recount from the amended transcript
                    counts.insertions = e.insertions.length;
                }
            }
            for (const { verdict, vk } of byIdx.values()) {
                counts[["correct", "substituted", "skipped", "unverified"].includes(verdict) ? verdict : "hinted"]++;
                const a = (perAyah[vk] ||= { correct: 0, substituted: 0, skipped: 0, hinted: 0, unverified: 0 });
                a[verdict]++;
            }
            // `unverified` is deliberately OUTSIDE attempted/accuracy: it is an
            // abstention, not a graded outcome — averaging it in either
            // direction would state a confidence the evidence does not carry.
            const attempted = counts.correct + counts.substituted + counts.skipped + counts.hinted;
            return {
                counts,
                perAyah,
                attempted,
                accuracy: attempted ? counts.correct / attempted : 1,
                completed: done && p >= ref.length,
            };
        },

        getState() {
            return {
                pointer: p, length: ref.length, done,
                deferred: !!(amb || pendingOmit || pendingSplit || pendingSub || muqSeq),
            };
        },
        getEvents() { return events.slice(); },
        getWords() { return ref.map((w) => ({ vk: w.vk, pos: w.pos, verdict: w.verdict })); },

        /* ---------- AMENDMENT API (2026-07-16) ----------
         * The amendment channel (stream controller) upgrades a committed
         * token's heard-text when later decode windows stably re-read it.
         * Verdicts are then RE-DERIVED by replaying the full amended token
         * sequence through a SHADOW session — the SAME matcher, the SAME
         * thresholds, this very constructor — and diffing per-word
         * verdicts. Nothing is re-fed to the LIVE session (repetition
         * tolerance untouched by construction), no live pointer state
         * moves, and the reference is never consulted to FORM a reading —
         * it only scores whatever the model re-decoded, exactly as it
         * scores first decodes. */
        reverdict(tokens) {
            const shadow = createTasmeeSession({
                words: ref.map((r) => ({ vk: r.vk, pos: r.pos, form: r.form })),
                basmala, options,
            });
            let last = 0;
            /* UNVERIFIED ATTRIBUTION (M1b). A token the controller marked
             * unverified covers a span whose re-readings never agreed; the
             * question is which reference words its uncertainty reaches.
             * Token adjacency is NOT enough: an omission is only revealed
             * once a LATER token corroborates the jump (§"OMISSIONS always
             * need corroboration"), so the founder's منا is skipped two
             * tokens after the unsettled من. Attribution is therefore
             * POSITIONAL — open a window at the reference position the
             * pointer had reached when the unverified token arrived, mark
             * the negative verdicts revealed inside it, and close on the
             * first CORRECT reveal past its start (evidence has resumed).
             * Capped so one unsettled span can never blanket a passage. */
            const unverifiedIdx = new Set();
            const WINDOW_CAP = 3;
            let seen = 0, maxRevealed = -1, win = null;
            const scan = (from, to) => {
                const evs = shadow.getEvents();
                for (let j = from; j < to; j++) {
                    const e = evs[j];
                    if (e.type !== "reveal") continue;
                    if (win && e.idx >= win.start) {
                        if (e.verdict === "skipped" || e.verdict === "substituted") {
                            if (unverifiedIdx.size - win.base < WINDOW_CAP) unverifiedIdx.add(e.idx);
                        } else if (e.verdict === "correct" && e.idx > win.start) win = null;
                    }
                    if (e.idx > maxRevealed) maxRevealed = e.idx;
                }
            };
            for (const tk of tokens) {
                const t = tk.tMs ?? last + 500;
                if (tk.unverified && !win) win = { start: maxRevealed + 1, base: unverifiedIdx.size };
                shadow.feedToken(tk.text, t);
                const n = shadow.getEvents().length;
                scan(seen, n);
                seen = n;
                if (t > last) last = t;
            }
            shadow.stop(last + 1500);
            scan(seen, shadow.getEvents().length);   // end-of-session flush reveals
            const heard = new Map(), insertions = [];
            for (const e of shadow.getEvents()) {
                if (e.type === "reveal") heard.set(e.idx, e.heard);
                else if (e.type === "insertion") insertions.push({ idx: e.idx, heard: e.heard });
            }
            return { words: shadow.getWords(), heard, insertions, unverifiedIdx };
        },

        /* Diff a shadow re-verdict against the live state and emit
         * `amend` events for every changed word. Rules:
         *  - hinted words are FROZEN (user-action verdicts are not
         *    token-derived; a shadow replay cannot know about hints);
         *  - a word the live session revealed but the shadow never
         *    reached is left untouched (never un-reveal; counted in the
         *    amend_insertions event as `unsupported` for diagnostics);
         *  - verdicts may IMPROVE (skip/sub → correct: false flag dies)
         *    and may WORSEN (fuzzy-passed correct → substituted: late
         *    catch — never-lenient is symmetric). */
        applyReverdict(tokens, tMs = 0) {
            const sh = this.reverdict(tokens);
            const changes = [];
            let unsupported = 0;
            for (let i = 0; i < ref.length; i++) {
                const cur = ref[i].verdict;
                let nv = sh.words[i] && sh.words[i].verdict;
                /* M1b: a negative verdict the model could not settle is
                 * reported as UNVERIFIED rather than asserted as a mistake.
                 * Downgrade-only — it can never turn a correct word negative,
                 * and it never manufactures a positive one either. */
                if (sh.unverifiedIdx && sh.unverifiedIdx.has(i) &&
                    (nv === "skipped" || nv === "substituted")) nv = "unverified";
                if (cur === "hinted") continue;
                if (!nv) { if (cur) unsupported++; continue; }
                if (nv === cur) continue;
                if (nv === "unverified" && cur === "correct") continue;   // never downgrade a correct word
                // WORSENING (correct or unrevealed → flagged): apply only in
                // strict mode; otherwise record as evidence (diagnostics /
                // future repair layer) without touching the verdict.
                const worsens = (nv === "substituted" || nv === "skipped") && (cur === "correct" || cur == null);
                if (worsens && !opt.amendApplyWorsen) {
                    emit({ type: "amend_evidence", t: tMs, idx: i, vk: ref[i].vk, pos: ref[i].pos, from: cur ?? null, to: nv, heard: sh.heard.get(i) });
                    continue;
                }
                ref[i].verdict = nv;
                const ev = {
                    type: "amend", t: tMs, idx: i, vk: ref[i].vk, pos: ref[i].pos,
                    from: cur ?? null, to: nv, heard: sh.heard.get(i),
                };
                emit(ev);
                changes.push(ev);
            }
            emit({ type: "amend_insertions", t: tMs, insertions: sh.insertions, unsupported });
            return changes;
        },
    };
}
