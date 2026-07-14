/* Fixtures pinning the 2026-07-11 fix ruling (05 FP-cluster root
 * cause: idghām merger + CTC tail truncation breaking pair
 * corroboration — TASMEE-PLAN Gate 3 diagnosis block):
 *   fix #2 — idghām المتماثلين fusion (بل/هل/قد/إذ + identical first
 *            letter): correct tajweed merges the words; the ASR emits
 *            the second word alone (or fused) and NEITHER word flags.
 *   fix #1 — tail-truncation tolerance at PAIR sites only: an exact
 *            partner corroborates a strict-prefix member; a LONE
 *            truncated word still flags (the conservative bar).
 * Reference: Sad 38:8/38:12–13 — the real incident's neighborhood. */

import test from "node:test";
import assert from "node:assert/strict";
import { createTasmeeSession } from "../../src/tasmee-engine.js";
import { refFor, tokensOf, feed, verdicts, mistakes, count } from "./helpers.mjs";

/* 38:8 …ذكري(11) بل(12) لما(13) يذوقوا(14) عذاب(15) — the idghām pair
 * is بل+لما (لام merges into لام; the mushaf writes لَّمَّا). */

test("idghām NARROWED (05 ear-check): bare لما does NOT absorb بل — a genuine skip flags exactly once", () => {
    // The 05 incident's true state: بل@12 was a PLANTED SKIP; bare لما
    // is what that skip sounds like. The bare-form acceptance was a
    // documented dead end (it absorbed the plant) — the honest outcome
    // is ONE skip flag at 12 with the neighbors clean.
    const ref = refFor("38:8");
    const toks = tokensOf(ref).filter((t, i) => i !== 11); // drop بل@12 (idx 11)
    const s = createTasmeeSession({ words: ref });
    feed(s, toks);
    s.stop(99000);
    const v = verdicts(s);
    assert.equal(v["38:8:12"], "skipped"); // the real skip — flagged
    assert.equal(v["38:8:13"], "correct");
    assert.equal(v["38:8:14"], "correct");
    assert.equal(mistakes(s), 1);
});

test("idghām: fused token بللما accepted, both words correct", () => {
    const ref = refFor("38:8");
    const toks = tokensOf(ref);
    toks.splice(11, 2, "بللما"); // بل+لما as one ASR token
    const s = createTasmeeSession({ words: ref });
    feed(s, toks);
    s.stop(99000);
    const v = verdicts(s);
    assert.equal(v["38:8:12"], "correct");
    assert.equal(v["38:8:13"], "correct");
    assert.equal(mistakes(s), 0);
});

test("idghām does NOT over-absorb: بل before هم (letters differ) still flags a real skip", () => {
    const ref = refFor("38:8");
    const toks = tokensOf(ref).filter((t, i) => i !== 5); // drop بل@6 (idx 5) — followed by هم
    const s = createTasmeeSession({ words: ref });
    feed(s, toks);
    s.stop(99000);
    const v = verdicts(s);
    assert.equal(v["38:8:6"], "skipped"); // no idghām basis (ل ≠ ه) — honest flag
    assert.equal(v["38:8:7"], "correct");
});

test("truncation pair: exact-held jump corroborated by a tail-truncated successor (0c site) + truncated word committed by exact successor (0b site)", () => {
    // 38:12 كذبت قبلهم قوم نوح وعاد وفرعون(6) ذو(7) الاوتاد(8) + 38:13 وثمود…
    // Recites: …وعاد [skips وفرعون] ذو الاوت(truncated الاوتاد) وثمود…
    const ref = refFor("38:12", "38:13");
    const toks = tokensOf(ref);
    toks.splice(5, 1);            // skip وفرعون@6
    toks[toks.indexOf("الاوتاد")] = "الاوت"; // ASR tail-truncates (sim 0.714 < thMatch)
    const s = createTasmeeSession({ words: ref });
    feed(s, toks);
    s.stop(99000);
    const v = verdicts(s);
    assert.equal(v["38:12:6"], "skipped");  // the real skip — flagged once
    assert.equal(v["38:12:7"], "correct");  // ذو — the exact held token
    assert.equal(v["38:12:8"], "correct");  // الاوتاد — truncated, pair-corroborated
    assert.equal(v["38:13:1"], "correct");  // وثمود — the exact successor
    assert.equal(mistakes(s), 1);           // ONLY the planted skip
});

test("conservative bar: a LONE truncated word (no corroborating successor) still flags", () => {
    const ref = refFor("38:8");
    const toks = tokensOf(ref);
    toks[13] = "يذوق"; // يذوقوا truncated (idx 13 = pos 14)…
    toks.length = 14;  // …and the clip ends there — no successor ever arrives
    const s = createTasmeeSession({ words: ref });
    feed(s, toks);
    s.stop(99000);
    const v = verdicts(s);
    assert.equal(v["38:8:14"], "substituted"); // not silently absorbed
});

test("the full 38:8 incident, corrected truth: skipped بل + truncated يذوق → ONE honest flag, zero FPs", () => {
    // The real 05 cluster: بل@12 skipped (planted), ASR truncates
    // يذوقوا → يذوق. Pre-fix this fanned into 3 skips + 2 insertions;
    // the pair-tolerance contains it to exactly the planted flag.
    const ref = refFor("38:8");
    const toks = tokensOf(ref).filter((t, i) => i !== 11); // the planted skip
    toks[toks.indexOf("يذوقوا")] = "يذوق";                 // tail truncation
    const s = createTasmeeSession({ words: ref });
    feed(s, toks);
    s.stop(99000);
    const v = verdicts(s);
    assert.equal(v["38:8:12"], "skipped");  // the plant — exactly one flag
    for (const pos of [11, 13, 14, 15]) assert.equal(v[`38:8:${pos}`], "correct", `pos ${pos}`);
    assert.equal(mistakes(s), 1);
    assert.equal(count(s, "insertion"), 0);
});
