/* ============================================================
 * tasmee-tashkeel.js — the HONEST harakat check (M3, 2026-07-19).
 *
 * PURE by contract (no DOM, no audio, no timers) so the whole rule set
 * is fixture-testable, same as the engine.
 *
 * WHY THIS SHAPE, and what was rejected. An ACOUSTIC haraka verifier was
 * built and measured against the founder's deliberate harakat changes and
 * REJECTED: scoring expected-vs-actual vowels on the model's own frame
 * logprobs, the calibration noise (the same word, same speaker, recited
 * correctly TWICE) runs to p90 10.15 / p99 20.76 nats — larger than the
 * deliberate-change signal itself. Catching 6 of 7 planted changes would
 * have cost ~26 false accusations per 100 words. Do not rebuild it.
 *
 * What IS reliable is much simpler. Measured over the same corpus, when
 * the model EMITS a word-internal haraka it is almost never wrong
 * (0.10–0.47%); it just frequently emits nothing at all (38–65% of
 * positions in the streaming path, 9–30% with full context). So this
 * check reads only what the model volunteered:
 *
 *   · compare the emitted haraka to the canonical one, position by position
 *   · ABSTAIN on any position where the model emitted nothing
 *   · ALWAYS ignore the word-FINAL vowel — waqf legitimately drops or
 *     changes it, so a reciter pausing on a word is not making a mistake
 *   · ABSTAIN unless the two letter sequences align exactly; a different
 *     spelling means we are not looking at the same word
 *
 * The result is deliberately three-state. "Couldn't verify" is a real
 * answer here and is returned far more often than either verdict — that
 * is the honest cost of only ever speaking when the evidence does.
 * ============================================================ */

/* Combining marks we compare. Shadda/tanwin/dagger-alef are NOT compared:
 * shadda is gemination rather than a vowel, tanwin lives on the final
 * position we already ignore, and the dagger alef is orthographic. */
const HARAKAT = new Set(["َ", "ِ", "ُ", "ْ"]);  // fatha kasra damma sukun
/* Everything combining: Quranic annotation marks, tashkeel, tanwin,
 * dagger alef, tatweel, zero-width/format chars. Same range set as
 * tasmee-norm's MARKS_RE — kept in sync deliberately. */
const MARK_RE = /[ؐ-ًؚ-ٰۖ-ۭ࣓-ࣿـ​-‏﻿]/;

export const HARAKA_NAME = {
    "َ": "fatha", "ِ": "kasra", "ُ": "damma", "ْ": "sukun",
};

/* Split a vocalised word into [{c, h}] — each letter with the FIRST
 * comparable haraka that follows it. */
export function splitHarakat(s) {
    const out = [];
    for (const ch of String(s || "")) {
        if (MARK_RE.test(ch)) {
            if (out.length && HARAKAT.has(ch) && !out[out.length - 1].h) out[out.length - 1].h = ch;
        } else if (ch.trim()) {
            out.push({ c: ch, h: "" });
        }
    }
    return out;
}

/* Letter-only skeleton for the alignment gate (NOT tasmeeNorm: this one
 * keeps hamza seats and ta-marbuta, because a spelling difference is
 * exactly the signal that we are not comparing the same rendering). */
const letters = (pairs) => pairs.map((p) => p.c).join("");

/**
 * @param {string} canonical  vocalised reference word (mushaf text)
 * @param {string} heardRaw   the model's emitted word, tashkeel included
 * @returns {{state:"match"|"mismatch"|"abstain", checked:number,
 *            reason?:string, at?:number, expected?:string, got?:string}}
 */
export function checkTashkeel(canonical, heardRaw) {
    const a = splitHarakat(canonical), b = splitHarakat(heardRaw);
    if (!a.length || !b.length) return { state: "abstain", checked: 0, reason: "empty" };
    if (letters(a) !== letters(b)) return { state: "abstain", checked: 0, reason: "spelling" };
    let checked = 0, omitted = 0;
    for (let i = 0; i < a.length - 1; i++) {           // word-INTERNAL only (waqf)
        if (!a[i].h) continue;                          // reference has no vowel here
        if (!b[i].h) { omitted++; continue; }           // model volunteered nothing
        checked++;
        if (a[i].h !== b[i].h) {
            // A contradicted position is evidence on its own — report it even
            // if other positions were silent.
            return {
                state: "mismatch", checked, at: i,
                expected: HARAKA_NAME[a[i].h], got: HARAKA_NAME[b[i].h],
            };
        }
    }
    /* "Verified" means EVERY word-internal vowel was actually compared.
     * Partial agreement is not verification: on أَضَلَّ the model often marks
     * only the alef and stays silent on the ض — precisely the position the
     * founder altered. Calling that "correct" would be a false assurance,
     * so a single omission drops the whole word to abstain. */
    if (omitted) return { state: "abstain", checked, reason: "omitted" };
    return checked ? { state: "match", checked } : { state: "abstain", checked: 0, reason: "omitted" };
}
