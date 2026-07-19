/* LENGTH-TIERED θ_match fixtures (M2, 2026-07-19).
 *
 * The founder planted 7 deliberate single-letter swaps. The model HEARD
 * three of them perfectly and the matcher forgave them anyway, because one
 * changed letter in a 6–8 letter skeleton scores 0.833–0.857 and θ was a
 * flat 0.75. Raising θ globally is not the answer — measured over 474
 * correct reference words the cost of tightening is wildly uneven by word
 * length. These fixtures pin the tier boundaries and, just as importantly,
 * pin the tiers we deliberately did NOT tighten.
 *
 * Tiers live in src/tasmee-live-config.js (TASMEE_LIVE.engine.thTiers) —
 * one source of truth for the worker, the bench and the lab replay. */

import test from "node:test";
import assert from "node:assert/strict";
import { createTasmeeSession } from "../../src/tasmee-engine.js";
import { TASMEE_LIVE } from "../../src/tasmee-live-config.js";

const W = (vk, pos, form) => ({ vk, pos, form });
const verdictOf = (words, pos) => words.find((w) => w.pos === pos)?.verdict;

/* Feed tokens through a session carrying the SHIPPED tier config. */
function run(refForms, tokens, options = TASMEE_LIVE.engine) {
    const words = refForms.map((f, i) => W("2:1", i + 1, f));
    const s = createTasmeeSession({ words, options });
    let t = 0;
    for (const tok of tokens) s.feedToken(tok, (t += 600));
    s.stop(t + 2000);
    return s.getWords();
}

/* ── the founder's own case: أعمالهم → أعمارهم, one letter in 7.
 * sim = 1 − 1/7 = 0.857, which θ=0.75 forgave and 0.875 catches. */
test("6–7 tier: one swapped letter in a 7-letter word is now a mistake", () => {
    const w = run(["الذين", "كفروا", "اعمالهم"], ["الذين", "كفروا", "اعمارهم"]);
    assert.equal(verdictOf(w, 3), "substituted", "أعمارهم flagged against أعمالهم");
});

test("6–7 tier: الرقاب → الحقاب (one letter in 6) is now a mistake", () => {
    const w = run(["فضرب", "الرقاب", "حتي"], ["فضرب", "الحقاب", "حتي"]);
    assert.equal(verdictOf(w, 2), "substituted");
});

/* Correct recitation in the same tier must stay correct — the tightening
 * must not turn ordinary exact hearing into a flag. */
test("6–7 tier: the correctly-recited word stays correct", () => {
    const w = run(["فضرب", "الرقاب", "حتي"], ["فضرب", "الرقاب", "حتي"]);
    assert.equal(verdictOf(w, 2), "correct");
});

/* ── 8+ tier deliberately NOT tightened: 5 false flags in only 10 words at
 * 0.90 on the measured corpus. A single-letter difference in a long word
 * stays forgiven — that is a measured trade, not an oversight. */
test("8+ tier stays lenient (measured: tightening it costs 5 FF in 10 words)", () => {
    const w = run(["يستطيعون"], ["يستطيعو"]);   // 8 letters, one edit → sim 0.875
    assert.equal(verdictOf(w, 1), "correct", "long words keep the loose threshold");
});

/* ── 4–5 tier unchanged: only one plant lives here and tightening starts
 * costing false flags immediately. */
test("4–5 tier unchanged: one letter in a 5-letter word is still forgiven", () => {
    const w = run(["الحمد", "لله"], ["الحمر", "لله"]);   // sim = 0.8
    assert.equal(verdictOf(w, 1), "correct");
});

/* ── ≤3 tier is EXACT and free (0 false flags at 1.00 over 127 words):
 * short words are heard exactly or not at all. */
test("≤3 tier: a 3-letter word must match exactly", () => {
    const wOk = run(["قل", "هو", "الله", "احد"], ["قل", "هو", "الله", "احد"]);
    assert.equal(verdictOf(wOk, 4), "correct");
    const wBad = run(["قل", "هو", "الله", "احد"], ["قل", "هو", "الله", "اجد"]);
    assert.notEqual(verdictOf(wBad, 4), "correct", "احد vs اجد is not accepted");
});

/* ── the tiers are OFF unless configured, so every pre-M2 fixture keeps
 * pinning flat-θ behaviour and the change cannot leak in silently. */
test("thTiers null ⇒ flat thMatch (pre-M2 behaviour preserved)", () => {
    const w = run(["الذين", "كفروا", "اعمالهم"], ["الذين", "كفروا", "اعمارهم"], {});
    assert.equal(verdictOf(w, 3), "correct", "flat θ=0.75 still forgives 0.857");
});
