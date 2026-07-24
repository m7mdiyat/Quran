/* PROVISIONAL PREVIEW fixtures (latency, 2026-07-20).
 *
 * The reciter's complaint was that a word took "a second or more" to appear.
 * A measured sweep showed the gates cannot simply be loosened: taking p50
 * from 1.12s to 0.40s takes planted-mistake precision on golden 04/05 from
 * 1.00 down to 0.20/0.17, and dropping the tail guard alone MISSES a real
 * mistake. So the ink moved earlier and the verdict did not.
 *
 * These fixtures pin the property the whole design rests on: preview() is
 * PURE. If it ever mutates session state, the commit gate's guarantees stop
 * being guarantees. */

import test from "node:test";
import assert from "node:assert/strict";
import { createTasmeeSession } from "../../src/tasmee-engine.js";
import { TASMEE_LIVE } from "../../src/tasmee-live-config.js";

const W = (vk, pos, form) => ({ vk, pos, form });
const REF = [W("1:1", 1, "بسم"), W("1:1", 2, "الله"), W("1:1", 3, "الرحمن"), W("1:1", 4, "الرحيم")];
const mk = () => {
    const events = [];
    const s = createTasmeeSession({ words: REF, onEvent: (e) => events.push(e), options: TASMEE_LIVE.engine });
    return { s, events };
};
const snap = (s) => JSON.stringify(s.getWords());

test("preview announces the words heard, in pointer order", () => {
    const { s, events } = mk();
    const idx = s.preview(["بسم", "الله"], 100);
    assert.deepEqual(idx, [0, 1]);
    assert.deepEqual(events.filter((e) => e.type === "preview").map((e) => e.idx), [0, 1]);
});

test("preview is PURE: no verdicts, no pointer movement, no reveals", () => {
    const { s, events } = mk();
    const before = snap(s);
    s.preview(["بسم", "الله", "الرحمن"], 100);
    assert.equal(snap(s), before, "reference state untouched");
    assert.equal(events.filter((e) => e.type === "reveal").length, 0, "no reveal emitted");
    // the real token still classifies from the ORIGINAL pointer afterwards
    s.feedToken("بسم", 200);
    assert.equal(s.getWords()[0].verdict, "correct");
});

test("preview stops at the first word that misses the acceptance bar", () => {
    const { s } = mk();
    // الرحمن in slot 2 does not match الله → the run stops, nothing beyond
    assert.deepEqual(s.preview(["بسم", "الرحمن"], 100), [0]);
});

test("a half-spoken word previews NOTHING (fragments miss the bar)", () => {
    const { s, events } = mk();
    assert.deepEqual(s.preview(["الرح"], 100), []);
    assert.equal(events.filter((e) => e.type === "preview").length, 0,
        "a fragment must never put a glyph on screen");
});

test("each index announces at most once", () => {
    const { s, events } = mk();
    s.preview(["بسم"], 100);
    s.preview(["بسم"], 200);
    s.preview(["بسم"], 300);
    assert.equal(events.filter((e) => e.type === "preview" && e.idx === 0).length, 1);
});

test("an already-judged word is never re-previewed", () => {
    const { s, events } = mk();
    s.feedToken("بسم", 100);
    s.preview(["بسم"], 200);
    assert.equal(events.filter((e) => e.type === "preview" && e.idx === 0).length, 0);
});

test("preview cannot rescue a wrong word: the verdict still lands", () => {
    const { s } = mk();
    s.preview(["بسم"], 100);          // ink appears for بسم
    s.feedToken("بسم", 200);
    s.feedToken("العليم", 300);        // wrong word where الله was expected
    s.stop(4000);
    assert.equal(s.getWords()[1].verdict, "substituted",
        "provisional ink never softens the verdict that follows");
});
