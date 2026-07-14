/* GATE 2 — refrain stress fixtures (user amendment, 2026-07-10).
 * The classic failure mode for follow-along engines: the pointer
 * locking onto the WRONG occurrence in repeated text. Acceptance:
 * the pointer never silently jumps between refrain instances —
 * every commit is either corroborated (omission) or deferred to
 * the safe reading (repetition). */

import test from "node:test";
import assert from "node:assert/strict";
import { createTasmeeSession } from "../../src/tasmee-engine.js";
import { refFor, tokensOf, feed, verdicts, mistakes } from "./helpers.mjs";

const session = (words) => createTasmeeSession({ words });

/* Token stream helpers: recite ranges, with one range skipped or
 * one range recited twice. */
const toks = (...ranges) => ranges.flatMap((r) => tokensOf(refFor(r)));

/* ---------- Ar-Rahman: فبأي آلاء ربكما تكذبان (refrains 21/23/25) ---------- */

test("Rahman: correct recitation through refrains — zero mistakes", () => {
    const ref = refFor("55:19-25");
    const s = session(ref);
    feed(s, tokensOf(ref));
    assert.equal(mistakes(s), 0);
    assert.equal(s.summary().completed, true);
});

test("Rahman: skipping one refrain instance marks EXACTLY that instance", () => {
    const ref = refFor("55:19-25");
    const s = session(ref);
    feed(s, toks("55:19", "55:20", "55:21", "55:22", /* skip 23 */ "55:24", "55:25"));
    const v = verdicts(s);
    // the skipped instance:
    for (let pos = 1; pos <= 4; pos++) assert.equal(v[`55:23:${pos}`], "skipped");
    // its neighbors stayed correct — the pointer did not confuse instances:
    for (let pos = 1; pos <= 4; pos++) assert.equal(v[`55:21:${pos}`], "correct");
    for (let pos = 1; pos <= 4; pos++) assert.equal(v[`55:25:${pos}`], "correct");
    assert.equal(s.summary().counts.skipped, 4);
    assert.equal(s.summary().counts.insertions, 0);
    assert.equal(s.summary().completed, true);
});

test("Rahman: repeating one refrain instance is repetition, never a jump", () => {
    const ref = refFor("55:19-25");
    const s = session(ref);
    feed(s, toks("55:19", "55:20", "55:21", "55:21" /* repeat */, "55:22", "55:23", "55:24", "55:25"));
    assert.equal(mistakes(s), 0);
    assert.equal(s.summary().counts.repetitions, 4);
    assert.equal(s.summary().completed, true);
    const v = verdicts(s);
    for (let pos = 1; pos <= 3; pos++) assert.equal(v[`55:22:${pos}`], "correct");
});

/* ---------- Al-Mursalat: ويل يومئذ للمكذبين (refrains 15/19/24) ---------- */

test("Mursalat: correct recitation — zero mistakes", () => {
    const ref = refFor("77:15-24");
    const s = session(ref);
    feed(s, tokensOf(ref));
    assert.equal(mistakes(s), 0);
    assert.equal(s.summary().completed, true);
});

test("Mursalat: skipping refrain 77:19 marks exactly 77:19", () => {
    const ref = refFor("77:15-24");
    const s = session(ref);
    feed(s, toks("77:15", "77:16", "77:17", "77:18", /* skip 19 */ "77:20", "77:21", "77:22", "77:23", "77:24"));
    const v = verdicts(s);
    for (let pos = 1; pos <= 3; pos++) assert.equal(v[`77:19:${pos}`], "skipped");
    for (let pos = 1; pos <= 3; pos++) assert.equal(v[`77:15:${pos}`], "correct");
    for (let pos = 1; pos <= 3; pos++) assert.equal(v[`77:24:${pos}`], "correct");
    assert.equal(s.summary().counts.skipped, 3);
    assert.equal(s.summary().completed, true);
});

test("Mursalat: repeating refrain 77:15 twice — zero mistakes", () => {
    const ref = refFor("77:15-20");
    const s = session(ref);
    feed(s, toks("77:15", "77:15", "77:16", "77:17", "77:18", "77:19", "77:20"));
    assert.equal(mistakes(s), 0);
    assert.equal(s.summary().completed, true);
});

/* ---------- Al-Kafirun: near-identical ayahs (109:3 ≡ 109:5) ---------- */

test("Kafirun: correct recitation through identical ayahs", () => {
    const ref = refFor("109:1-6");
    const s = session(ref);
    feed(s, tokensOf(ref));
    assert.equal(mistakes(s), 0);
    assert.equal(s.summary().completed, true);
});

test("Kafirun: repeating 109:3 then continuing 109:4 — zero mistakes", () => {
    const ref = refFor("109:1-6");
    const s = session(ref);
    // repeat = re-recite 109:3's words after finishing them once,
    // then continue into 109:4 from its second word (ولا was already
    // consumed as 109:4's opening — text-identical, undecidable, and
    // harmless: the user did say it).
    const a3 = tokensOf(refFor("109:3"));
    const a4 = tokensOf(refFor("109:4"));
    feed(s, [...toks("109:1", "109:2", "109:3"), ...a3, ...a4.slice(1),
    ...toks("109:5", "109:6")]);
    assert.equal(mistakes(s), 0);
    assert.equal(s.summary().completed, true);
});

/* ---------- Adjacent repeats ---------- */

test("94:5–6 (near-identical adjacent ayahs): correct recitation", () => {
    const ref = refFor("94:5-8");
    const s = session(ref);
    feed(s, tokensOf(ref));
    assert.equal(mistakes(s), 0);
    assert.equal(s.summary().completed, true);
});

test("94:6 skipped: exactly 94:6 marked, later ayahs correct", () => {
    const ref = refFor("94:5-8");
    const s = session(ref);
    feed(s, toks("94:5", /* skip 6 */ "94:7", "94:8"));
    const v = verdicts(s);
    for (let pos = 1; pos <= 4; pos++) assert.equal(v[`94:6:${pos}`], "skipped");
    for (let pos = 1; pos <= 4; pos++) assert.equal(v[`94:5:${pos}`], "correct");
    assert.equal(s.summary().completed, true);
});

test("23:36 هيهات هيهات: adjacent identical words advance, no repetition-lock", () => {
    const ref = refFor("23:36");
    const s = session(ref);
    feed(s, tokensOf(ref));
    assert.equal(mistakes(s), 0);
    assert.equal(s.summary().counts.repetitions, 0);
    assert.equal(s.summary().completed, true);
});

test("23:36: reciting هيهات once skips exactly one of the pair", () => {
    const ref = refFor("23:36");
    const s = session(ref);
    const t = tokensOf(ref);
    t.splice(1, 1); // one هيهات
    feed(s, t);
    const v = verdicts(s);
    const pair = [v["23:36:1"], v["23:36:2"]].sort();
    assert.deepEqual(pair, ["correct", "skipped"]);
    assert.equal(s.summary().counts.skipped, 1);
    assert.equal(s.summary().completed, true);
});

test("resync inside refrain text anchors at the NEAREST forward instance", () => {
    // Recite 19–21, lose the place (6 unplaceable tokens arm the
    // stall), resume at a refrain. The re-anchor pair (فباي, الا)
    // matches BOTH 55:23 and 55:25 ahead — the contract is the
    // NEAREST instance (23): minimal skip damage, and the pointer
    // never overshoots a refrain instance.
    const ref = refFor("55:19-26");
    const s = createTasmeeSession({ words: ref });
    const garbage = ["بذخش", "ضغثم", "خذعف", "شذبق", "غظثف", "ذشخب"];
    feed(s, [...toks("55:19", "55:20", "55:21"), ...garbage,
    ...toks("55:23", "55:24", "55:25", "55:26")]);
    const v = verdicts(s);
    for (let pos = 1; pos <= 4; pos++) assert.equal(v[`55:22:${pos}`], "skipped");
    for (let pos = 1; pos <= 4; pos++) assert.equal(v[`55:23:${pos}`], "correct");
    for (let pos = 1; pos <= 4; pos++) assert.equal(v[`55:25:${pos}`], "correct");
    const rs = s.getEvents().filter((e) => e.type === "resync");
    assert.equal(rs.length, 1, "exactly one resync");
    assert.equal(s.summary().counts.skipped, 4, "only ayah 22 paid for the jump");
    assert.equal(s.summary().completed, true);
});

test("75:34–35 اولي لك فاولي: repeating 34 then continuing 35 — zero mistakes", () => {
    const ref = refFor("75:34-35");
    const s = session(ref);
    const a34 = tokensOf(refFor("75:34"));
    feed(s, [...a34, ...a34, ...tokensOf(refFor("75:35"))]);
    assert.equal(mistakes(s), 0);
    const v = verdicts(s);
    for (let pos = 1; pos <= 4; pos++) assert.equal(v[`75:35:${pos}`], "correct");
    assert.equal(s.summary().completed, true);
});
