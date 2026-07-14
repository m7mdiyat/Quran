/* GATE 2 addendum #2 — substitution echoing an earlier recited word.
 *
 * The trap (from the worked truth example): saying يؤمنون where
 * يوقنون is expected (2:4:12), with يؤمنون sitting BEHIND the
 * pointer (2:4:2). A naive engine reads that as a harmless
 * repetition (or worse, a fuzzy correct). CONTRACT: a mistake must
 * be flagged at the position — substitution preferred, corroborated
 * omission acceptable, silent repetition is a FAIL.
 *
 * Word pairs below were mined from the real dataset (similarity in
 * brackets). All 13 refrain fixtures must stay green alongside
 * these — the deferral resolver prefers the behind reading ONLY
 * when the next token actually continues the behind run. */

import test from "node:test";
import assert from "node:assert/strict";
import { createTasmeeSession } from "../../src/tasmee-engine.js";
import { refFor, tokensOf, feed, verdicts, mistakes } from "./helpers.mjs";

const FLAGGED = ["substituted", "skipped"]; // acceptable mistake classes

test("E1 same-ayah echo, match band: يؤمنون for يوقنون (2:4:12, echo at 2:4:2 — sim 0.83)", () => {
    const ref = refFor("2:4-5");
    const s = createTasmeeSession({ words: ref });
    const toks = tokensOf(ref);
    toks[11] = "يؤمنون"; // said instead of يوقنون; continuation (2:5) follows
    feed(s, toks);
    const v = verdicts(s);
    assert.ok(FLAGGED.includes(v["2:4:12"]), `2:4:12 must be flagged, got ${v["2:4:12"]}`);
    assert.equal(v["2:4:12"], "substituted", "substitution preferred");
    assert.equal(v["2:4:2"], "correct", "the echoed word itself stays correct");
    assert.equal(v["2:5:1"], "correct");
    assert.equal(s.summary().counts.substituted, 1);
    assert.equal(s.summary().counts.skipped, 0);
    assert.equal(s.summary().completed, true);
});

test("E1b echo at the LAST word: stop() commits the flag, never silent", () => {
    const ref = refFor("2:4");
    const s = createTasmeeSession({ words: ref });
    const toks = tokensOf(ref);
    toks[11] = "يؤمنون";
    feed(s, toks);
    const sum = s.stop(99999);
    assert.equal(verdicts(s)["2:4:12"], "substituted");
    assert.equal(sum.completed, true);
});

test("E2 prior-ayah echo, match band: اليك for اولئك (2:5:1, echo at 2:4:5 — sim 0.80)", () => {
    const ref = refFor("2:4-5");
    const s = createTasmeeSession({ words: ref });
    const a4 = tokensOf(refFor("2:4"));
    const a5 = tokensOf(refFor("2:5"));
    a5[0] = "اليك"; // said instead of اولئك
    feed(s, [...a4, ...a5]);
    const v = verdicts(s);
    assert.ok(FLAGGED.includes(v["2:5:1"]), `2:5:1 must be flagged, got ${v["2:5:1"]}`);
    assert.equal(v["2:5:1"], "substituted");
    assert.equal(v["2:5:2"], "correct");
    assert.equal(s.summary().completed, true);
});

test("E2b echo whose continuation matches BOTH readings: flagged (class may differ), never silent", () => {
    // الذين for والذين at 2:4:1 (echo 2:3:1, sim 0.83) — the next word
    // يؤمنون continues both the behind run (2:3:2) and the pointer
    // reading (2:4:2), so the resolver takes the non-destructive
    // behind path first; the mistake must STILL surface (as skips
    // via corroborated omission when the texts diverge).
    const ref = refFor("2:3-4");
    const s = createTasmeeSession({ words: ref });
    const a3 = tokensOf(refFor("2:3"));
    const a4 = tokensOf(refFor("2:4"));
    a4[0] = "الذين";
    feed(s, [...a3, ...a4]);
    const v = verdicts(s);
    assert.ok(FLAGGED.includes(v["2:4:1"]), `2:4:1 must be flagged, got ${v["2:4:1"]}`);
    assert.ok(mistakes(s) >= 1, "a mistake is surfaced — silent repetition is the FAIL");
    assert.equal(s.summary().completed, true);
});

test("E3 sub-band echo: الذين for اليك (2:4:5, echo at 2:3:1 — sim 0.60)", () => {
    const ref = refFor("2:3-4");
    const s = createTasmeeSession({ words: ref });
    const a3 = tokensOf(refFor("2:3"));
    const a4 = tokensOf(refFor("2:4"));
    a4[4] = "الذين"; // said instead of اليك
    feed(s, [...a3, ...a4]);
    const v = verdicts(s);
    assert.equal(v["2:4:5"], "substituted");
    assert.equal(v["2:4:6"], "correct");
    assert.equal(s.summary().counts.substituted, 1);
    assert.equal(s.summary().counts.skipped, 0);
    assert.equal(s.summary().completed, true);
});

test("E4 regression: exact-at-pointer is IMMUNE to the echo rule", () => {
    // Correct recitation of 2:3-2:4 passes THROUGH يؤمنون at 2:4:2
    // (exact echo at 2:3:2) and والذين at 2:4:1 (fuzzy echo 2:3:1):
    // exact equality at the pointer must always win — zero flags.
    const ref = refFor("2:3-4");
    const s = createTasmeeSession({ words: ref });
    feed(s, tokensOf(ref));
    assert.equal(mistakes(s), 0);
    assert.equal(s.summary().counts.repetitions, 0);
    assert.equal(s.summary().completed, true);
});

test("E5 regression: waw-family echo وعلي/علي inside 2:7 — dropped waw is flagged", () => {
    // 2:7: … علي(3) قلوبهم(4) وعلي(5) سمعهم(6) … — saying علي at
    // position 5 (dropping the waw) exactly echoes position 3 while
    // fuzzy-matching the expected وعلي (0.75): must flag, not absorb.
    const ref = refFor("2:7");
    const s = createTasmeeSession({ words: ref });
    const toks = tokensOf(ref);
    toks[4] = "علي";
    feed(s, toks);
    const v = verdicts(s);
    assert.ok(FLAGGED.includes(v["2:7:5"]), `2:7:5 must be flagged, got ${v["2:7:5"]}`);
    assert.equal(s.summary().completed, true);
});
