/* GATE 2 — recovery fixtures (user amendments #2 and #3):
 * behind-pointer merge after a stumble, and insertion stability
 * for non-Quranic utterances. */

import test from "node:test";
import assert from "node:assert/strict";
import { createTasmeeSession } from "../../src/tasmee-engine.js";
import { refFor, tokensOf, feed, verdicts, count } from "./helpers.mjs";

test("behind-merge: stumble → back 2 ayahs → re-recite through → continue, zero FALSE mistakes", () => {
    const ref = refFor("2:6-9");
    const s = createTasmeeSession({ words: ref });

    const a6 = tokensOf(refFor("2:6"));
    const a7 = tokensOf(refFor("2:7"));
    const a8 = tokensOf(refFor("2:8"));
    const a9 = tokensOf(refFor("2:9"));

    // First pass: 2:6, 2:7 fully; 2:8 with a stumble at word 3
    // (من → substituted near-miss "منن"), stop mid-ayah after it.
    const stumbled8 = a8.slice(0, 3);
    stumbled8[2] = "منن"; // vs من: short-word exact rule → not a match; sub band? من len2 exact… falls to insertion? see assertion below
    feed(s, [...a6, ...a7, ...stumbled8]);

    // Go BACK two ayahs (to 2:7 start), re-recite 2:7 + 2:8 fully
    // correct, then continue 2:9 to the end.
    feed(s, [...a7, ...a8, ...a9], { startMs: 60000 });

    const sum = s.summary();
    const v = verdicts(s);
    // The original stumble is the ONLY blemish; the word ended
    // correct on the re-pass or stayed as first classified — but
    // nothing NEW was flagged by going back:
    assert.equal(sum.counts.skipped, 0, "no false skips from the go-back");
    assert.ok(sum.counts.substituted + sum.counts.insertions <= 1,
        "at most the one real stumble is flagged");
    assert.ok(sum.counts.repetitions >= a7.length,
        "the re-recited stretch registered as repetition, not mistakes");
    // Everything else correct and the session completed:
    assert.equal(v["2:9:1"], "correct");
    assert.equal(sum.completed, true);
});

test("insertion stability: استغفر الله mid-recitation (with الله expected nearby!) never derails", () => {
    // 2:9 = يخدعون الله والذين امنوا... — الله IS the next-next word,
    // so the استغفر الله tail is the exact trap the corroboration
    // guard exists for.
    const ref = refFor("2:8-9");
    const s = createTasmeeSession({ words: ref });
    const a8 = tokensOf(refFor("2:8"));
    const a9 = tokensOf(refFor("2:9"));
    feed(s, [...a8, "استغفر", "الله", ...a9]);
    const sum = s.summary();
    const v = verdicts(s);
    assert.equal(sum.counts.skipped, 0, "الله bait did not fake an omission");
    assert.equal(sum.counts.substituted, 0);
    // The spec is flag-or-ignore, never derail: استغفر is an
    // insertion; الله may legitimately land as insertion OR as a
    // repetition-echo of the just-recited بالله (sim 0.8) — both are
    // non-destructive readings, neither touches the pointer.
    assert.equal(sum.counts.insertions + sum.counts.repetitions, 2);
    assert.ok(sum.counts.insertions >= 1, "استغفر flagged as insertion");
    assert.equal(v["2:9:1"], "correct");
    assert.equal(v["2:9:2"], "correct");
    assert.equal(sum.completed, true);
});

test("insertion stability: cough-like noise tokens are inert", () => {
    const ref = refFor("2:6");
    const s = createTasmeeSession({ words: ref });
    const toks = tokensOf(ref);
    feed(s, [toks[0], "كح", "كح", ...toks.slice(1)]);
    const sum = s.summary();
    assert.equal(sum.counts.skipped + sum.counts.substituted, 0);
    assert.equal(sum.counts.insertions, 2);
    assert.equal(sum.completed, true);
});

test("hesitation while a deferral is pending still points at the right word", () => {
    const ref = refFor("2:6");
    const s = createTasmeeSession({ words: ref });
    s.feedToken("ان", 0);
    s.feedToken("عليهم", 400); // becomes an omission candidate (deferred)
    s.tick(5000);
    const h = s.getEvents().filter((e) => e.type === "hesitation");
    assert.equal(h.length, 1);
    assert.equal(h[0].vk, "2:6");
    assert.equal(h[0].pos, 2, "hint anchor stays at the committed pointer");
    assert.equal(count(s, "reveal"), 1, "deferred candidate revealed nothing");
});
