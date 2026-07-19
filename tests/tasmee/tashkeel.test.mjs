/* HONEST HARAKAT CHECK fixtures (M3, 2026-07-19).
 * Three states, and the abstentions matter as much as the verdicts:
 * the check only ever speaks when the model volunteered a haraka. */

import test from "node:test";
import assert from "node:assert/strict";
import { checkTashkeel, splitHarakat } from "../../src/tasmee-tashkeel.js";

/* ── the founder's فداء plant: فِدَاءً recited فَدَاءً. The model emitted
 * the fatha it heard, so the check can speak — this is the one harakat
 * plant that surfaces in the live streaming path. */
test("catches the founder's فداء plant (kasra → fatha, emitted)", () => {
    const r = checkTashkeel("فِدَاءً", "فَدَاءَ");
    assert.equal(r.state, "mismatch");
    assert.equal(r.expected, "kasra");
    assert.equal(r.got, "fatha");
});

/* ── فضرب, his two-change word: فَضَرْبَ recited فَضِرِب, model emitted
 * فَضْرِبْ. The ض position differs (fatha vs sukun) → mismatch. */
test("catches فضرب (emitted harakat differ from canonical)", () => {
    assert.equal(checkTashkeel("فَضَرْبَ", "فَضْرِبْ").state, "mismatch");
});

/* ── ABSTAIN when the model emitted nothing. This is the common case:
 * 38–65% of word-internal positions are omitted in the streaming path.
 * Silence is never evidence of a mistake. */
test("abstains when the model omitted the haraka entirely", () => {
    const r = checkTashkeel("أَضَلَّ", "أضل");
    assert.equal(r.state, "abstain");
    assert.equal(r.reason, "omitted");
});

test("abstains on a partially-marked word rather than guessing", () => {
    // canonical marks both ض and ل; the model marked only the alef
    const r = checkTashkeel("أَضَلَّ", "أَضل");
    assert.equal(r.state, "abstain");
});

/* ── WAQF: the word-FINAL vowel is legitimately dropped or changed when a
 * reciter pauses. It is never compared, in either direction. */
test("waqf: a changed word-FINAL vowel is NOT a mistake", () => {
    // canonical ends with damma, reciter paused and read sukun
    assert.equal(checkTashkeel("الْحَرْبُ", "الْحَرْبْ").state, "match");
});

test("waqf: a dropped word-FINAL vowel is NOT a mistake", () => {
    assert.equal(checkTashkeel("الرِّقَابِ", "الرِّقَاب").state, "match");
});

/* ── correct recitation passes cleanly. */
test("fully-matching harakat → match", () => {
    const r = checkTashkeel("الَّذِينَ", "الَّذِينَ");
    assert.equal(r.state, "match");
    assert.ok(r.checked > 0);
});

/* ── a different spelling means we are not looking at the same rendering;
 * comparing vowels across it would be meaningless. */
test("abstains when the letter sequences differ", () => {
    const r = checkTashkeel("أَعْمَالَهُمْ", "أَعْمَارَهُمْ");
    assert.equal(r.state, "abstain");
    assert.equal(r.reason, "spelling");
});

/* ── shadda is gemination, not a vowel: its presence or absence alone
 * must never raise a mistake. */
test("shadda alone is not a haraka mismatch", () => {
    assert.equal(checkTashkeel("الَّذِينَ", "الَذِينَ").state, "match");
});

test("splitHarakat pairs each letter with its first comparable mark", () => {
    const p = splitHarakat("فَضَرْبَ");
    assert.deepEqual(p.map((x) => x.c).join(""), "فضرب");
    assert.deepEqual(p.map((x) => x.h), ["َ", "َ", "ْ", "َ"]);
});
