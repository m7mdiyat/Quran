/* ============================================================
 * tasmee-acoustic.js — the ACOUSTIC EVIDENCE channel (relative
 * variant discrimination over retained CTC frames).
 *
 * WHY THIS EXISTS. The matcher compares TEXT: the model's decoded
 * token against the reference form, by string similarity. Two things
 * leak through that comparison and neither is fixable by tuning it:
 *
 *   1. The decoder's output is its best guess, and the guess is pulled
 *      toward the plausible. A wrong-but-similar word is often
 *      "corrected" to the reference word before any comparison runs —
 *      the mistake is gone before the matcher can see it.
 *   2. The similarity thresholds must stay lenient enough to survive
 *      ordinary ASR noise. MEASURED: tightening the 4–5 tier from 0.75
 *      to 0.85 adds 5 false substitutions on golden 02/03 and drops
 *      clip 04 precision to 0.75, under the 0.80 floor. Leniency that
 *      survives noise is also blindness to one-letter swaps. It is a
 *      wall, not an oversight.
 *
 * So this channel does not ask the model what it heard. It asks
 * whether the audio SUPPORTS the reference word better than it
 * supports a deliberate near-miss of it — canonical vs. every
 * single-letter substitution and deletion, force-aligned over the SAME
 * frames. Segmentation uncertainty, speaker, channel and model bias
 * all cancel in the comparison, which is why the RELATIVE form works
 * where the absolute one (GOP against a threshold) did not: Δ moved
 * 7–9 nats on a one-frame shift when the two candidates did not share
 * a span, and moves ~0 when they do.
 *
 * MEASURED (2026-07-24, founder clips, worst-3 statistic):
 *   correct recitation — canonical wins 79/80 words
 *   planted letter mistakes — a wrong variant wins on 4/7
 *   the text matcher alone caught 3/7; union = 5/7
 *
 * WHAT IT COSTS. Nothing new is downloaded and nothing new is decoded.
 * The per-frame logprobs already exist (tasmee-logprob-buffer.js has
 * been retaining them since the boundary-repair groundwork); this is a
 * Viterbi pass over a matrix we were throwing away.
 *
 * ---- THE EQUIVALENCE-CLASS RULE (the load-bearing design choice) ----
 * The reference forms available at runtime are tasmeeNorm'd: hamza
 * seats, ta-marbuta and alef-maqsura are deliberately folded away
 * because Quran ASR and the page's QCF spellings disagree on exactly
 * those. A naive letter sweep would therefore "discover" that the
 * audio prefers أعمالهم over the reference's اعمالهم and flag every
 * hamza-initial word in the Quran.
 *
 * Two halves fix that, and they are the same idea applied twice:
 *   - the LATTICE is class-expanded — an ا position accepts any of
 *     ا أ إ آ ٱ, و accepts ؤ, ي accepts ئ ى, ه accepts ة, and lone
 *     hamza and every diacritic are optional zero-advance arcs. The
 *     canonical lattice represents the equivalence CLASS, which is
 *     exactly what the matcher means by "this word".
 *   - a VARIANT is admissible only if it survives tasmeeNorm as a
 *     genuinely different string. أعمالهم normalizes back onto the
 *     canonical and is dropped before it can be scored.
 * Net: this channel can only ever flag a difference the matcher would
 * also call a difference. The two channels cannot disagree about what
 * "a different word" means, by construction.
 *
 * PURE: no ORT, no I/O, no globals. Frames come in as rows.
 * ============================================================ */

import { tasmeeNorm } from "./tasmee-norm.js";

const NEG = -Infinity;

/* Seat classes — the tasmeeNorm folds, read backwards. A normalized
 * letter maps to every orthographic form that folds ONTO it, so the
 * lattice accepts whichever one the model actually emitted. */
const SEATS = {
    "ا": "اأإآٱ",   // alef ← alef, +hamza-above, +hamza-below, madda, wasla
    "و": "وؤ",                     // waw  ← waw, waw-hamza
    "ي": "يئى",               // yeh  ← yeh, yeh-hamza, alef-maqsura
    "ه": "هة",                     // heh  ← heh, ta-marbuta
};

/* The letters a substitution may swap IN. Arabic letters only — the
 * seat variants are excluded because they fold back onto their class
 * and would be dropped by the admissibility rule anyway. */
const ALPHABET = "ابتثجحخدذرزس"
    + "شصضطظعغفقكلمنهوي";

/* Confusion pairs — the acoustically plausible swaps, used when the
 * caller asks for the cheap variant set. Same map the 2026-07-24
 * discrimination run used. */
const CONFUSABLE = {
    "ر": "لن", "ل": "رن", "د": "لذ", "ن": "رل",
    "ه": "كح", "ك": "هق", "ت": "يث", "ي": "تب",
    "م": "نب", "ب": "تن", "س": "شص", "ح": "خه",
    "ع": "غا", "ق": "كف", "ط": "تظ", "ص": "سض",
};

const WORD_MARK = "▁";     // SentencePiece word-initial marker

/* Vocabulary key for lattice lookup: the word mark survives, everything
 * else goes through the SAME fold the matcher uses. A token that folds
 * to "" is pure diacritics (or a lone hamza) and becomes a zero-advance
 * arc — the model omits vowels 38–65% of the time, so requiring them
 * here would punish correct recitation. */
function tokenKey(tok) {
    if (!tok || /^<.*>$/.test(tok)) return null;         // <blank>, <unk>, …
    const mark = tok.startsWith(WORD_MARK) ? WORD_MARK : "";
    return mark + tasmeeNorm(mark ? tok.slice(1) : tok);
}

export function createAcousticChecker({ vocab, blank, options = {} } = {}) {
    if (!Array.isArray(vocab) || !vocab.length) throw new Error("createAcousticChecker: vocab array required");
    const BLANK = Number.isInteger(blank) ? blank : vocab.length - 1;

    const opt = {
        /* "full" sweeps every Arabic letter at every position; "confusable"
         * restricts to the acoustically plausible pairs. Full is stricter
         * evidence (a variant beating the canonical is harder to dismiss)
         * and costs ~7× the Viterbi passes. */
        variantSet: "full",
        /* DELETIONS ARE OFF. A deletion asks "is this letter there?", which
         * on a CTC lattice is indistinguishable from "is this letter SHORT?"
         * — and length is a recitation-style choice (madd), not a mistake.
         * MEASURED on golden 01, clean recitation: أَأُنزِلَ scored without
         * one of its two alefs by 1.69 nats, and كَذَّبَتْ scored without its
         * ب by 1.32 — the channel's only two objections on the clip, both
         * wrong, both deletions. They also break the premise the relative
         * test rests on: a substitution scores two candidates of the SAME
         * structure over the same frames, so everything but letter identity
         * cancels; a deletion changes the lattice length and that no longer
         * holds. Set true only with fresh evidence. */
        deletions: false,
        skipFinal: true,            // see variantsOf — a word EDGE is phonology, not spelling
        skipInitial: true,          //   (both ends, same argument: idgham works in both directions)
        /* Frames of slack added around the caller's span before aligning.
         * CTC emissions are spikes: a greedy word span is tight around the
         * spike and can clip the word's actual acoustic extent. Both
         * canonical and variants see the SAME padded frames, so the padding
         * cannot bias the comparison — it only stops it being starved. */
        padFrames: 2,
        minFrames: 4,               // below this a span carries no usable evidence
        maxLen: 12,                 // skip pathological long forms (cost guard)
        ...options,
    };

    /* ---- vocab index: normalized key → token ids that spell it ---- */
    const byKey = new Map();        // key → number[]
    const zeroIds = [];             // tokens that fold to nothing (diacritics, hamza)
    let maxKeyLen = 1;
    for (let id = 0; id < vocab.length; id++) {
        if (id === BLANK) continue;
        const key = tokenKey(vocab[id]);
        if (key === null) continue;
        if (key === "" || key === WORD_MARK) { zeroIds.push(id); continue; }
        let a = byKey.get(key);
        if (!a) byKey.set(key, (a = []));
        a.push(id);
        if (key.length > maxKeyLen) maxKeyLen = key.length;
    }
    if (!byKey.size) throw new Error("createAcousticChecker: vocab produced no usable tokens");

    /* ---- lattice: positions over the normalized string, one arc per
     * (span, token id). Multi-id spans expand to parallel arcs so the CTC
     * transition rules (repeat / different-id entry) stay exactly the
     * rules they were when this was validated. ---- */
    function buildLattice(normWords) {
        const list = Array.isArray(normWords) ? normWords : [normWords];
        const bounds = [];
        let s = "";
        for (const w of list) { const st = s.length + 1; s += WORD_MARK + w; bounds.push([st, s.length]); }
        const N = s.length;
        const arcs = [];
        const out = Array.from({ length: N + 1 }, () => []);
        const inn = Array.from({ length: N + 1 }, () => []);
        const add = (u, v, id) => {
            const a = { u, v, id, k: arcs.length };
            arcs.push(a); out[u].push(a); inn[v].push(a);
        };
        for (let i = 0; i < N; i++) {
            for (let L = 1; L <= maxKeyLen && i + L <= N; L++) {
                const ids = byKey.get(s.slice(i, i + L));
                if (ids) for (const id of ids) add(i, i + L, id);
            }
        }
        /* Zero-advance arcs: a diacritic (or lone hamza) the model emits
         * costs nothing, and one it omits costs nothing either. */
        for (let u = 0; u <= N; u++) for (const id of zeroIds) add(u, u, id);
        // reachability — an unspellable candidate scores nothing at all
        const seen = new Uint8Array(N + 1); seen[0] = 1;
        for (let i = 0; i <= N; i++) if (seen[i]) for (const a of out[i]) if (a.v > i) seen[a.v] = 1;
        return seen[N] ? { arcs, out, inn, N, bounds } : null;
    }

    /* Viterbi over the lattice, restricted to frames [t0,t1] of `rows`.
     * Returns the best path score plus the token chosen at each frame. */
    function align(L, rows, t0, t1) {
        const { arcs, out, inn, N } = L;
        const S = N + 1 + arcs.length;          // 0..N = blank@position, then one state per arc
        let cur = new Float64Array(S).fill(NEG);
        const bp = [];
        const r0 = rows[t0];
        cur[0] = r0[BLANK];
        for (const a of out[0]) cur[N + 1 + a.k] = r0[a.id];
        for (let t = t0 + 1; t <= t1; t++) {
            const r = rows[t];
            const nxt = new Float64Array(S).fill(NEG);
            const back = new Int32Array(S).fill(-1);
            for (let v = 0; v <= N; v++) {
                let best = cur[v], bi = v;
                for (const a of inn[v]) { const c = cur[N + 1 + a.k]; if (c > best) { best = c; bi = N + 1 + a.k; } }
                if (best > NEG) { nxt[v] = best + r[BLANK]; back[v] = bi; }
            }
            for (const a of arcs) {
                let best = cur[N + 1 + a.k], bi = N + 1 + a.k;          // repeat this token
                if (cur[a.u] > best) { best = cur[a.u]; bi = a.u; }      // enter from blank at u
                for (const p of inn[a.u]) if (p.id !== a.id) {           // enter from a different token ending at u
                    const c = cur[N + 1 + p.k]; if (c > best) { best = c; bi = N + 1 + p.k; }
                }
                if (best > NEG) { nxt[N + 1 + a.k] = best + r[a.id]; back[N + 1 + a.k] = bi; }
            }
            bp.push(back); cur = nxt;
        }
        let end = N, bestv = cur[N];
        for (const a of inn[N]) { const c = cur[N + 1 + a.k]; if (c > bestv) { bestv = c; end = N + 1 + a.k; } }
        if (!isFinite(bestv)) return null;
        const tok = new Int32Array(t1 - t0 + 1);
        const pos = new Int32Array(t1 - t0 + 1);
        const tokOf = (st) => (st <= N ? BLANK : arcs[st - N - 1].id);
        const posOf = (st) => (st <= N ? st : arcs[st - N - 1].v);
        let st = end;
        for (let i = bp.length - 1; i >= 0; i--) {
            tok[i + 1] = tokOf(st); pos[i + 1] = posOf(st);
            st = bp[i][st];
        }
        tok[0] = tokOf(st); pos[0] = posOf(st);
        return { score: bestv, tok, pos };
    }

    /* Frame span of every word in a sequence, from ONE Viterbi pass over
     * the whole concatenated lattice. Used offline (span quality reference)
     * and available to any caller that would rather not trust the greedy
     * decoder's spike-tight word timings. Returns [f0,f1] ABSOLUTE frame
     * indices per word, or [-1,-1] where the path never entered the word. */
    function alignSequence({ rows, V, t0, t1, forms }) {
        const norms = forms.map((f) => tasmeeNorm(f || "") || "ا");   // never drop: index alignment is load-bearing
        const L = buildLattice(norms);
        if (!L) return null;
        for (let t = t0; t <= t1; t++) if (!rows[t] || rows[t].length !== V) return null;
        const a = align(L, rows, t0, t1);
        if (!a) return null;
        return L.bounds.map(([cs, ce]) => {
            let f0 = -1, f1 = -1;
            for (let i = 0; i < a.pos.length; i++) {
                const p = a.pos[i];
                if (p > cs && p <= ce) { if (f0 < 0) f0 = t0 + i; f1 = t0 + i; }
            }
            return [f0, f1];
        });
    }

    /* Per-frame goodness against the unconstrained best path, summarised
     * by the mean of the WORST THREE frames.
     *
     * Word-mean dilutes the thing we are looking for: one wrong consonant
     * is 1–2 frames out of ~25, and averaging buries it under the 23 the
     * reciter got right. Phone-level rather than word-level localisation is
     * why the standard GOP literature scores per-phone, and the worst-3
     * mean is the cheapest statistic that keeps that property while staying
     * robust to a single outlier frame. */
    function worst3(rows, t0, t1, free, tok) {
        const per = [];
        for (let t = t0; t <= t1; t++) per.push(rows[t][tok[t - t0]] - free[t - t0]);
        per.sort((a, b) => a - b);
        const n = Math.min(3, per.length);
        let acc = 0;
        for (let i = 0; i < n; i++) acc += per[i];
        return acc / n;
    }

    /* Candidate near-misses of `norm`, already filtered through the
     * equivalence rule: anything that folds back onto the canonical is not
     * a different word and never gets scored.
     *
     * NEITHER EDGE OF THE WORD IS EVER JUDGED, and for the same reason at
     * both ends: an edge consonant is not a fixed acoustic target, it is
     * whatever the words on either side of it make it.
     *
     *   FINAL — assimilates into what follows (idgham, ikhfa, iqlab) or is
     *     dropped at a waqf. MEASURED: on golden 04 the word منهم scored
     *     its final م as ن by 2.84 nats, the largest margin in the clip, on
     *     a word nobody got wrong. Flagging it takes 04 from precision 1.00
     *     to 0.75 — under the floor, on a phonological rule.
     *   INITIAL — the mirror image: idgham merges the PREVIOUS word's final
     *     consonant into this word's initial one, and the alignment's left
     *     boundary is least certain exactly there. MEASURED: on the live
     *     path نُزِّلَ (in بِمَا نُزِّلَ) scored its initial ن as absent by
     *     1.44 nats — the channel's only objection on that clip, and a
     *     false one.
     *
     * The same reasoning already excludes the word-final VOWEL from the
     * harakat variant test (waqf changes it legitimately). The cost is real
     * and worth stating plainly: a mistake confined to the first or last
     * letter of a word is invisible to this channel, and stays the text
     * matcher's job. Short words lose most of their interior and simply
     * abstain — which is the correct outcome, not a gap to paper over. */
    function variantsOf(norm) {
        const seen = new Set([norm]);
        const outv = [];
        const push = (v) => {
            const n = tasmeeNorm(v);
            if (!n || n.length < 2 || seen.has(n)) return;
            seen.add(n); outv.push(n);
        };
        const last = norm.length - 1;
        for (let c = 0; c < norm.length; c++) {
            if (opt.skipFinal && c === last) continue;
            if (opt.skipInitial && c === 0) continue;
            const alts = opt.variantSet === "confusable" ? (CONFUSABLE[norm[c]] || "") : ALPHABET;
            for (const x of alts) if (x !== norm[c]) push(norm.slice(0, c) + x + norm.slice(c + 1));
            if (opt.deletions && norm.length >= 3) push(norm.slice(0, c) + norm.slice(c + 1));
        }
        return outv;
    }

    /* ---- the public call ----
     * rows: Float32Array[] indexed by ABSOLUTE frame (holes allowed —
     *       a span with any hole is declined rather than guessed at)
     * f0,f1: the word's frame span, inclusive, before padding
     * form:  the reference word, tasmeeNorm'd (what the matcher holds)
     *
     * Returns null when there is not enough evidence to have an opinion —
     * the caller must treat null as "no objection", never as "wrong". */
    function check({ rows, V, f0, f1, form, padFrames }) {
        const norm = tasmeeNorm(form || "");
        if (!norm || norm.length < 2 || norm.length > opt.maxLen) return null;
        const pad = padFrames == null ? opt.padFrames : padFrames;
        const t0 = Math.max(0, f0 - pad), t1 = Math.min(rows.length - 1, f1 + pad);
        if (!(t1 - t0 + 1 >= opt.minFrames)) return null;
        for (let t = t0; t <= t1; t++) if (!rows[t] || rows[t].length !== V) return null;

        // unconstrained per-frame best — the denominator, shared by every candidate
        const free = new Float64Array(t1 - t0 + 1);
        for (let t = t0; t <= t1; t++) {
            const r = rows[t];
            let m = -Infinity;
            for (let v = 0; v < V; v++) if (r[v] > m) m = r[v];
            free[t - t0] = m;
        }

        const scoreOf = (w) => {
            const L = buildLattice(w);
            if (!L) return null;
            const a = align(L, rows, t0, t1);
            return a ? worst3(rows, t0, t1, free, a.tok) : null;
        };

        const canon = scoreOf(norm);
        if (canon == null) return null;

        let best = -Infinity, bestWord = null, n = 0;
        for (const v of variantsOf(norm)) {
            const s = scoreOf(v);
            if (s == null) continue;
            n++;
            if (s > best) { best = s; bestWord = v; }
        }
        if (!n) return null;
        return {
            form: norm, canon, best, variant: bestWord, nVariants: n,
            margin: best - canon,           // > 0 ⇒ the audio prefers a near-miss
            frames: t1 - t0 + 1,
        };
    }

    return { check, variantsOf, alignSequence, _buildLattice: buildLattice, blank: BLANK };
}

/* ============================================================
 * createAcousticHook — the engine-facing adapter. ONE implementation,
 * shared by the live worker and the offline bench, because a channel
 * that ships one behaviour and is graded on another is not graded at
 * all (same rule as tasmee-live-config.js: no copy that can drift).
 *
 * Turns the engine's question ("was this really the reference word?")
 * into a frame window and asks the checker. Everything here is
 * ABSTENTION-BIASED: every path that cannot assemble solid evidence
 * returns null, which the engine reads as "no objection". A wrong
 * abstention costs a missed mistake. A wrong objection paints a red
 * mark on a word the reciter said correctly — far worse, and the thing
 * the reciter will not forgive.
 *
 * The window is [up to two accepted predecessors → the settled
 * successor]. The successor is the part that matters: without it the
 * target's right boundary floats and clean words start scoring like
 * mistakes (clean margin p99 3.40 without, 0.34 with). The commit gate
 * already waited for that successor — the tail guard requires it — so
 * this reuses corroboration the pipeline had already paid for rather
 * than spending any new latency.
 * ============================================================ */
export function createAcousticHook({ checker, buffer, vocabSize, refForms, frameS = 0.08, config = {} } = {}) {
    if (!checker || !buffer || !Array.isArray(refForms)) return null;
    const backWords = config.backWords ?? 2;
    const padFrames = config.padFrames ?? 2;
    const contiguityS = config.contiguityS ?? 0.4;
    const seen = new Map();          // ref idx → the span this channel accepted it on
    const fr = (s) => Math.max(0, Math.round(s / frameS));

    return function acousticCheck(idx, ctx) {
        const sp = ctx && ctx.span;
        if (!sp) return null;
        /* No settled successor (end of stream, or the tail guard released on
         * silence instead) ⇒ no right anchor ⇒ abstain. At a waqf the final
         * letter and vowel are legitimately altered anyway, so this is the
         * right place to have no opinion. */
        if (typeof sp.rightEndS !== "number" || !(sp.rightEndS > sp.endS)) return null;
        if (idx + 1 >= refForms.length) return null;

        /* Left context: only predecessors THIS channel already accepted, and
         * only while they stay contiguous in time. A gap means a pause or a
         * skip, and a lattice asserting words the reciter did not say there
         * would misplace every boundary after it. */
        const forms = [];
        let firstStart = sp.startS;
        for (let q = idx - 1, n = 0; q >= 0 && n < backWords; q--, n++) {
            const prev = seen.get(q);
            if (!prev || firstStart - prev.endS > contiguityS) break;
            forms.unshift(refForms[q]);
            firstStart = prev.startS;
        }
        const at = forms.length;                 // where the target sits in the window
        forms.push(refForms[idx], refForms[idx + 1]);

        /* ONE DECODE PASS PER WINDOW, and this is the difference between a
         * channel that works and one that does not. The ring overwrites
         * latest-decode-wins, so a window covering several words can be
         * STITCHED from passes with different anchors — and a Viterbi path
         * across an inconsistent frame sequence cannot resolve one letter.
         * MEASURED: identical scoring separates plants from clean words by
         * 2.90 nats on frames from a single pass and by nothing at all on a
         * mixed window. So: try the full window, and if it is mixed, retry
         * with the left context dropped (the target and its successor are
         * the most recently written and most likely to share a pass). Still
         * mixed ⇒ abstain, which is always safe. */
        let f0 = Math.max(0, fr(firstStart) - padFrames);
        const f1 = fr(sp.rightEndS) + padFrames;
        let atIdx = at, useForms = forms;
        if (buffer.samePass && !buffer.samePass(f0, f1)) {
            f0 = Math.max(0, fr(sp.startS) - padFrames);
            if (!buffer.samePass(f0, f1)) return null;
            atIdx = 0;
            useForms = [refForms[idx], refForms[idx + 1]];
        }
        if (f1 - f0 < 6) return null;
        const rows = buffer.getRange(f0, f1);
        for (const r of rows) if (!r) return null;   // a hole in the ring ⇒ no opinion

        const spans = checker.alignSequence({ rows, V: vocabSize, t0: 0, t1: rows.length - 1, forms: useForms });
        if (!spans || !spans[atIdx] || spans[atIdx][0] < 0) return null;
        const res = checker.check({ rows, V: vocabSize, f0: spans[atIdx][0], f1: spans[atIdx][1], form: refForms[idx] });
        seen.set(idx, { startS: sp.startS, endS: sp.endS });
        return res;
    };
}

export { SEATS, ALPHABET, CONFUSABLE, tokenKey };
