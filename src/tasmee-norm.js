/* ============================================================
 * tasmee-norm.js — the ONE normalizer for وضع التسميع matching.
 *
 * Used by scripts/build-tasmee-words.mjs (dataset build),
 * scripts/audit-tasmee-words.mjs (verification) and, from Gate 2
 * on, src/tasmee-engine.js (ASR-token matching at runtime). The
 * matching contract is SYMMETRY: dataset forms and incoming ASR
 * tokens pass through the exact same function, so any bijective
 * fold is safe and any divergence between build and runtime is a
 * correctness bug. Do not fork this logic into a script-local
 * copy — import it (audit-gharib.mjs ⇐ src/gharib.js precedent).
 *
 * These folds are matching-only forms (never displayed): they
 * deliberately erase hamza seats, ta-marbuta/ha and alef variants
 * because Quran ASR output (standard Imlaei orthography) and the
 * page's QCF-derived hybrid spellings disagree on exactly those
 * (see TASMEE-PLAN.md §0.2/§2.6 and the gharib tiers they were
 * tuned against, src/gharib.js:98–146). NOT the same folds as
 * gharibNorm1 (alef-maqsura→ا there, →ي here): gharib pairs
 * Uthmani↔QCF, tasmee pairs Imlaei↔Imlaei-leaning-ASR. Changing a
 * fold here invalidates public/tasmee-words.json — rebuild +
 * re-audit (Gate 1 acceptance) whenever this file changes.
 *
 * EVERY code point in the code below is a \u escape on purpose —
 * editors/formatters (and chat channels) mangle combining marks
 * as literals (same rule as gharib.js). Comments name the letters
 * instead of embedding fragile literals.
 * ============================================================ */

/* Quranic annotation marks (U+0610–061A, U+06D6–06ED, Arabic
 * Extended-A small marks U+08D3–08FF), tashkeel + tanwin + dagger
 * alef (U+064B–0670 — the dagger is DROPPED, not expanded: both
 * sides of every comparison drop it, so salat with/without dagger
 * still meet at distance 1, absorbed by the engine threshold),
 * tatweel, zero-width/format chars, BOM. Identical range set to
 * gharib's MARKS_RE, audit-proven over all 604 QCF4 pages. */
const MARKS_RE = /[ؐ-ًؚ-ٰۖ-ۭ࣓-ࣿـ​-‏﻿]/g;

/* QCF4 page-data texts encode some combining marks as literal
 * "&#NNNN;" HTML entities (e.g. hamza-below U+0655) and use
 * combining-hamza pairs. Fold the pairs into precomposed seat
 * letters BEFORE the marks strip so the seat survives as letter
 * identity. Only needed for QCF-side text (the audit cross-check);
 * quran.json and ASR output never contain these. Mirrors gharib's
 * preClean (src/gharib.js:85). */
const ENTITY_RE = /&#(\d+);/g;
function preCleanQcf(s) {
    let t = String(s).replace(ENTITY_RE, (_, d) => {
        const n = Number(d);
        return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    });
    return t
        .replace(/يٕ/g, "ئ")  // yeh + hamza below → yeh-hamza
        .replace(/ئ/g, "ئ")  // yeh + hamza above → yeh-hamza
        .replace(/إ/g, "إ")  // alef + hamza below → alef-hamza-below
        .replace(/أ/g, "أ")  // alef + hamza above → alef-hamza-above
        .replace(/ؤ/g, "ؤ"); // waw + hamza above → waw-hamza
}

/* The matching fold. Order matters: marks strip first (exposes
 * seat letters), seat folds next, final non-letter sweep last
 * (drops sajda/quarter symbols, digits, latin — e.g. the sajda
 * "#1969" placeholders normalize to "" and are thereby
 * unmatchable by construction). */
export function tasmeeNorm(s) {
    return String(s)
        .replace(MARKS_RE, "")
        .replace(/[ٱأإآ]/g, "ا") // wasla/hamza-seated/madda alefs → alef
        .replace(/ؤ/g, "و")  // waw-hamza → waw
        .replace(/ئ/g, "ي")  // yeh-hamza → yeh
        .replace(/ء/g, "")        // lone hamza dropped (شاء↔شا)
        .replace(/ة/g, "ه")  // ta-marbuta → heh (pausal forms)
        .replace(/ى/g, "ي")  // alef-maqsura → yeh (موسى↔موسي)
        .replace(/[^ء-ي]/g, "")
        .trim();
}

/* QCF-side variant: entity/seat pre-clean, then the same fold.
 * Used ONLY by the Gate 1 audit's similarity cross-check — the
 * runtime engine never matches against QCF text. */
export function tasmeeNormQcf(s) {
    return tasmeeNorm(preCleanQcf(s));
}
