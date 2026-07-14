/* GATE 2 — core classification matrix (TASMEE-PLAN §5 GATE 2).
 * Run: node --test tests/tasmee/ */

import test from "node:test";
import assert from "node:assert/strict";
import { createTasmeeSession } from "../../src/tasmee-engine.js";
import { refFor, tokensOf, feed, verdicts, count, mistakes } from "./helpers.mjs";

const session = (words, extra = {}) => createTasmeeSession({ words, ...extra });

test("perfect recitation: every word correct, zero mistakes, completed", () => {
    const ref = refFor("2:6-10");
    const s = session(ref);
    feed(s, tokensOf(ref));
    const sum = s.summary();
    assert.equal(sum.counts.correct, ref.length);
    assert.equal(mistakes(s), 0);
    assert.equal(sum.completed, true);
    assert.equal(sum.accuracy, 1);
    assert.equal(count(s, "ayah_completed"), 5);
});

test("substitution: near-miss word marked substituted, pointer advances", () => {
    const ref = refFor("2:6"); // ان الذين كفروا سوا عليهم اانذرتهم ام لم تنذرهم لا يومنون
    const s = session(ref);
    const toks = tokensOf(ref);
    toks[2] = "كرهوا"; // vs كفروا → sim 0.6: substitution band
    feed(s, toks);
    const v = verdicts(s);
    assert.equal(v["2:6:3"], "substituted");
    assert.equal(s.summary().counts.substituted, 1);
    assert.equal(s.summary().counts.skipped, 0);
    assert.equal(s.summary().completed, true);
});

test("omission (j=1) with corroboration: skipped word marked, no derail", () => {
    const ref = refFor("2:6");
    const s = session(ref);
    const toks = tokensOf(ref);
    toks.splice(1, 1); // drop الذين
    feed(s, toks);
    const v = verdicts(s);
    assert.equal(v["2:6:2"], "skipped");
    assert.equal(s.summary().counts.skipped, 1);
    assert.equal(s.summary().counts.correct, ref.length - 1);
    assert.equal(s.summary().completed, true);
});

test("omission (multi-word jump) with corroboration", () => {
    const ref = refFor("2:8"); // ومن الناس من يقول امنا بالله وباليوم الاخر...
    const s = session(ref);
    const toks = tokensOf(ref);
    toks.splice(2, 3); // drop من يقول امنا → resume at بالله (j=4... wait j=3+1? بالله is 4th ahead)
    feed(s, toks);
    const v = verdicts(s);
    assert.equal(v["2:8:3"], "skipped");
    assert.equal(v["2:8:4"], "skipped");
    assert.equal(v["2:8:5"], "skipped");
    assert.equal(v["2:8:6"], "correct");
    assert.equal(s.summary().counts.skipped, 3);
    assert.equal(s.summary().completed, true);
});

test("uncorroborated ahead-match becomes insertion, not a skip", () => {
    const ref = refFor("2:6");
    const s = session(ref);
    // ان, then عليهم (matches ahead at pos5), then الذين (does NOT
    // corroborate pos6) → عليهم must fall back to insertion.
    feed(s, ["ان", "عليهم", "الذين", "كفروا", "سوا", "عليهم", "اانذرتهم", "ام", "لم", "تنذرهم", "لا", "يومنون"]);
    const v = verdicts(s);
    assert.equal(s.summary().counts.skipped, 0);
    assert.equal(s.summary().counts.insertions, 1);
    assert.equal(v["2:6:2"], "correct");
    assert.equal(s.summary().completed, true);
});

test("plain insertion: non-matching token never moves the pointer", () => {
    const ref = refFor("2:6");
    const s = session(ref);
    feed(s, ["ان", "استغفر", "الذين"]);
    assert.equal(s.summary().counts.insertions, 1);
    assert.equal(verdicts(s)["2:6:2"], "correct");
    assert.equal(s.getState().pointer, 2);
});

test("merged token: one ASR token covering two expected words", () => {
    const ref = refFor("2:2"); // ذلك الكتاب لا ريب فيه هدي للمتقين
    const s = session(ref);
    feed(s, ["ذلك", "الكتاب", "لاريب", "فيه", "هدي", "للمتقين"]);
    const v = verdicts(s);
    assert.equal(v["2:2:3"], "correct");
    assert.equal(v["2:2:4"], "correct");
    assert.equal(mistakes(s), 0);
    assert.equal(s.summary().completed, true);
});

test("split tokens: يا + ايها resolve to the fused expected word", () => {
    const ref = refFor("2:21"); // ياايها الناس اعبدوا...
    const s = session(ref);
    feed(s, ["يا", "ايها", ...tokensOf(ref).slice(1)]);
    assert.equal(verdicts(s)["2:21:1"], "correct");
    assert.equal(mistakes(s), 0);
    assert.equal(s.summary().completed, true);
});

test("triple split: يا + ابن + ام resolve to يبنؤم (20:94)", () => {
    const ref = refFor("20:94");
    const s = session(ref);
    const rest = tokensOf(ref).slice(2);
    feed(s, ["قال", "يا", "ابن", "ام", ...rest]);
    assert.equal(verdicts(s)["20:94:2"], "correct");
    assert.equal(mistakes(s), 0);
    assert.equal(s.summary().completed, true);
});

test("muqatta'at: literal token", () => {
    const ref = refFor("2:1-2");
    const s = session(ref);
    feed(s, ["الم", ...tokensOf(refFor("2:2"))]);
    assert.equal(verdicts(s)["2:1:1"], "correct");
    assert.equal(mistakes(s), 0);
});

test("muqatta'at: letter-name sequence الف لام ميم", () => {
    const ref = refFor("2:1-2");
    const s = session(ref);
    feed(s, ["الف", "لام", "ميم", ...tokensOf(refFor("2:2"))]);
    assert.equal(verdicts(s)["2:1:1"], "correct");
    assert.equal(mistakes(s), 0);
    assert.equal(s.summary().completed, true);
});

test("muqatta'at: abandoned sequence → one insertion, recitation recovers", () => {
    const ref = refFor("2:1-2");
    const s = session(ref);
    feed(s, ["الف", "لام", ...tokensOf(refFor("2:2"))]);
    const v = verdicts(s);
    assert.equal(s.summary().counts.insertions, 1);
    assert.equal(v["2:1:1"], "skipped"); // الم jumped over, corroborated by الكتاب
    assert.equal(v["2:2:1"], "correct");
    assert.equal(s.summary().completed, true);
});

test("muqatta'at: single-letter opening ص via letter name صاد", () => {
    const ref = refFor("38:1");
    const s = session(ref);
    feed(s, ["صاد", ...tokensOf(ref).slice(1)]);
    assert.equal(verdicts(s)["38:1:1"], "correct");
    assert.equal(mistakes(s), 0);
});

test("basmala optional prefix: recited → basmala events, never omission", () => {
    const ref = refFor("2:1-2");
    const s = session(ref, { basmala: true });
    feed(s, ["بسم", "الله", "الرحمن", "الرحيم", "الم", ...tokensOf(refFor("2:2"))]);
    assert.equal(count(s, "basmala"), 4);
    assert.equal(mistakes(s), 0);
    assert.equal(s.summary().completed, true);
});

test("basmala optional prefix: skipped silently", () => {
    const ref = refFor("2:1-2");
    const s = session(ref, { basmala: true });
    feed(s, ["الم", ...tokensOf(refFor("2:2"))]);
    assert.equal(count(s, "basmala"), 0);
    assert.equal(mistakes(s), 0);
    assert.equal(s.summary().completed, true);
});

test("basmala partial then content: prefix dismissed without mistakes", () => {
    const ref = refFor("2:1-2");
    const s = session(ref, { basmala: true });
    feed(s, ["بسم", "الله", "الم", ...tokensOf(refFor("2:2"))]);
    assert.equal(count(s, "basmala"), 2);
    assert.equal(mistakes(s), 0);
    assert.equal(s.summary().completed, true);
});

test("hesitation: fires once per stall, re-arms after activity", () => {
    const ref = refFor("2:6");
    const s = session(ref);
    s.feedToken("ان", 0);
    s.tick(3999);
    assert.equal(count(s, "hesitation"), 0);
    s.tick(4000);
    assert.equal(count(s, "hesitation"), 1);
    s.tick(5000); // still stalled — must NOT re-fire before re-arm
    assert.equal(count(s, "hesitation"), 1);
    s.hint(4100); // reveal re-arms
    s.tick(8200);
    assert.equal(count(s, "hesitation"), 2);
    assert.equal(verdicts(s)["2:6:2"], "hinted");
});

test("waqf-aware hesitation: identical pause fires mid-ayah, NOT at ayah end", () => {
    const ref = refFor("2:6-7");
    // Mid-ayah: two words in, a 5 s pause fires the hint pulse.
    const s1 = session(ref);
    feed(s1, ["ان", "الذين"]); // last activity t=400
    s1.tick(400 + 5000);
    assert.equal(count(s1, "hesitation"), 1);
    // Ayah end: 2:6 fully recited → pointer sits on 2:7:1 (boundary).
    // The SAME 5 s pause fires NOTHING — pausing at waqf is correct
    // practice; the doubled grace (8 s) still catches a true stall.
    const s2 = session(ref);
    const endT = feed(s2, tokensOf(refFor("2:6")));
    const lastActivity = endT - 400;
    s2.tick(lastActivity + 5000);
    assert.equal(count(s2, "hesitation"), 0, "no hint at waqf for the mid-ayah duration");
    s2.tick(lastActivity + 8000);
    assert.equal(count(s2, "hesitation"), 1, "a true boundary stall still fires at 2×");
});

test("waqf-aware hesitation: session start counts as a boundary", () => {
    const ref = refFor("2:6");
    const s = session(ref);
    s.tick(5000);
    assert.equal(count(s, "hesitation"), 0);
    s.tick(8000);
    assert.equal(count(s, "hesitation"), 1);
});

test("loop mode: range recited N times, passes counted, zero mistakes", () => {
    const ref = refFor("2:6");
    const s = session(ref);
    s.setLoop({ from: 0, to: ref.length - 1, passes: 2 });
    feed(s, tokensOf(ref));
    assert.equal(count(s, "loop_pass"), 1);
    assert.equal(count(s, "loop_reset"), 1);
    assert.equal(s.summary().completed, false);
    feed(s, tokensOf(ref), { startMs: 20000 });
    assert.equal(count(s, "loop_pass"), 2);
    assert.equal(s.summary().completed, true);
    assert.equal(mistakes(s), 0);
});

test("extendReference: session crosses the boundary seamlessly", () => {
    const page1 = refFor("2:6");
    const page2 = refFor("2:7");
    const s = session(page1);
    const t1 = tokensOf(page1);
    feed(s, t1.slice(0, t1.length - 2));
    assert.equal(s.summary().completed, false);
    s.extendReference(page2);
    feed(s, [...t1.slice(-2), ...tokensOf(page2)], { startMs: 10000 });
    assert.equal(mistakes(s), 0);
    assert.equal(s.summary().completed, true);
    assert.equal(verdicts(s)["2:7:1"], "correct");
});

test("stop(): unresolved deferrals settle safely (no invented skips)", () => {
    const ref = refFor("2:6");
    const s = session(ref);
    feed(s, ["ان", "عليهم"]); // عليهم held as omission candidate
    const sum = s.stop(5000);
    assert.equal(sum.counts.skipped, 0);
    assert.equal(sum.counts.insertions, 1);
    assert.equal(sum.completed, false);
});
