/* ACOUSTIC SECOND OPINION fixtures (M5, 2026-07-25).
 *
 * The reciter's complaint was that a wrong letter inside a word — or a
 * similar-sounding wrong word — went uncaught. It did, and not because
 * the thresholds were sloppy: a text comparison cannot see a mistake the
 * decoder already "corrected" away, and tightening it costs more than it
 * buys (the 4–5 tier at 0.85 → 5 false flags, clip 04 precision 0.75).
 *
 * So a second channel reads the AUDIO — canonical vs. deliberate
 * near-misses, force-aligned over the same frames. Measured at θ=1.0:
 * ZERO objections across 890 words of correct recitation (golden
 * 01–06 + the founder's control + the unplanted words of mistakes-A),
 * while catching اعمالهم→اعمارهم, which the matcher accepted.
 *
 * These fixtures pin the two properties the safety argument rests on:
 * the channel can only ever OBJECT (never rescue, never soften), and
 * every form of not-knowing reaches the engine as silence rather than
 * as a verdict. A channel that guesses when it cannot hear would paint
 * red marks on correct recitation, which is the one failure the reciter
 * will not forgive.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createTasmeeSession } from "../../src/tasmee-engine.js";
import { createAcousticChecker } from "../../src/tasmee-acoustic.js";
import { TASMEE_LIVE } from "../../src/tasmee-live-config.js";
import { tasmeeNorm } from "../../src/tasmee-norm.js";

const W = (vk, pos, form) => ({ vk, pos, form });
const REF = [W("1:1", 1, "بسم"), W("1:1", 2, "الله"), W("1:1", 3, "الرحمن"), W("1:1", 4, "الرحيم")];

/* A session whose acoustic channel is a stub: `answers` maps a reference
 * index to whatever the channel "hears" there. */
const mk = (answers = {}, margin = 1.0, extra = {}) => {
    const events = [];
    const asked = [];
    const s = createTasmeeSession({
        words: REF,
        onEvent: (e) => events.push(e),
        options: {
            ...TASMEE_LIVE.engine,
            acousticMargin: margin,
            acousticCheck: (idx, ctx) => { asked.push({ idx, ctx }); return answers[idx] ?? null; },
            ...extra,
        },
    });
    return { s, events, asked };
};
const verdictOf = (s, i) => s.getWords()[i].verdict;

/* ---------- the engine hook contract ---------- */

test("an objection above θ turns an accepted word into a substitution", () => {
    const { s, events } = mk({ 1: { margin: 2.4, variant: "الاه" } });
    s.feedToken("بسم", 100);
    s.feedToken("الله", 200);
    assert.equal(verdictOf(s, 1), "substituted");
    const rev = events.find((e) => e.type === "reveal" && e.idx === 1);
    assert.equal(rev.verdict, "substituted", "ONE reveal, already carrying the final verdict");
    assert.equal(rev.acoustic, 2.4, "the evidence travels with the verdict");
    assert.equal(rev.acousticVariant, "الاه");
    assert.equal(events.filter((e) => e.type === "reveal" && e.idx === 1).length, 1,
        "never green-then-red: the UI must not see two verdicts for one word");
});

test("an objection AT or BELOW θ changes nothing", () => {
    for (const m of [0.5, 1.0]) {
        const { s } = mk({ 1: { margin: m } });
        s.feedToken("بسم", 100);
        s.feedToken("الله", 200);
        assert.equal(verdictOf(s, 1), "correct", `margin ${m} must not flag at θ=1.0`);
    }
});

test("SILENCE IS NOT EVIDENCE: null, undefined, junk and throws all abstain", () => {
    const cases = [null, undefined, {}, { margin: null }, { margin: "2.0" }, { margin: NaN }];
    for (const answer of cases) {
        const { s } = mk({ 1: answer });
        s.feedToken("بسم", 100);
        s.feedToken("الله", 200);
        assert.equal(verdictOf(s, 1), "correct", `${JSON.stringify(answer)} must read as no objection`);
    }
    const events = [];
    const thrower = createTasmeeSession({
        words: REF, onEvent: (e) => events.push(e),
        options: { ...TASMEE_LIVE.engine, acousticCheck: () => { throw new Error("no frames"); } },
    });
    thrower.feedToken("بسم", 100);
    assert.equal(thrower.getWords()[0].verdict, "correct", "a channel that fails is a channel with no opinion");
});

test("the channel can OBJECT but never RESCUE — a flagged word stays flagged", () => {
    // the matcher hears a different word at slot 1; the channel is asked
    // nothing, and could not help if it were
    const { s, asked } = mk({ 1: { margin: -99 } });
    s.feedToken("بسم", 100);
    s.feedToken("العليم", 200);          // wrong word where الله was expected
    assert.equal(verdictOf(s, 1), "substituted");
    assert.ok(!asked.some((a) => a.idx === 1),
        "a word the matcher already flagged is not put to a second opinion");
});

test("the channel is only consulted where a token was ACCEPTED as the expected word", () => {
    const { s, asked } = mk();
    s.feedToken("بسم", 100);
    s.feedToken("الله", 200);
    assert.deepEqual(asked.map((a) => a.idx), [0, 1]);
    for (const a of asked) {
        assert.equal(typeof a.ctx.form, "string");
        assert.ok("span" in a.ctx, "the caller needs the span to find its frames");
    }
});

test("the token's audio span reaches the channel, successor end included", () => {
    const { asked, s } = mk();
    s.feedToken("بسم", 100, { startS: 1.0, endS: 1.4, rightEndS: 1.9 });
    assert.deepEqual(asked[0].ctx.span, { startS: 1.0, endS: 1.4, rightEndS: 1.9 });
});

test("NO HOOK ⇒ byte-identical to the pre-M5 engine", () => {
    const evA = [], evB = [];
    const a = createTasmeeSession({ words: REF, onEvent: (e) => evA.push(e), options: TASMEE_LIVE.engine });
    const b = createTasmeeSession({
        words: REF, onEvent: (e) => evB.push(e),
        options: { ...TASMEE_LIVE.engine, acousticCheck: null },
    });
    for (const s of [a, b]) { s.feedToken("بسم", 100); s.feedToken("الله", 200); s.stop(3000); }
    assert.equal(JSON.stringify(evA), JSON.stringify(evB));
});

/* ---------- the variant rules (the false-flag defence) ---------- */

const VOCAB = ["<blank>", "▁", "ا", "ب", "ت", "ث", "ج", "ح", "خ", "د", "ذ", "ر", "ز", "س", "ش",
    "ص", "ض", "ط", "ظ", "ع", "غ", "ف", "ق", "ك", "ل", "م", "ن", "ه", "و", "ي", "أ", "إ", "آ", "ة", "ى", "ئ", "ؤ", "ء",
    "َ", "ِ", "ُ", "ْ", "ّ"];
const mkChecker = (options) => createAcousticChecker({ vocab: VOCAB, blank: 0, options });

test("no variant may fold back onto the canonical (the equivalence rule)", () => {
    const c = mkChecker({ variantSet: "full" });
    for (const word of ["اعمالهم", "الرحمن", "موسي", "شاه", "يومنون"]) {
        const canon = tasmeeNorm(word);
        for (const v of c.variantsOf(canon)) {
            assert.notEqual(tasmeeNorm(v), canon,
                `${v} normalises onto ${canon} — the matcher calls those the SAME word, ` +
                `so flagging one as a near-miss of the other would fire on every hamza in the Quran`);
        }
    }
});

test("hamza seats, ta-marbuta and alef-maqsura are never proposed as mistakes", () => {
    const c = mkChecker({ variantSet: "full" });
    // اعمالهم's leading ا must never be "corrected" to أ/إ/آ
    assert.ok(!c.variantsOf("اعمالهم").some((v) => /^[أإآ]/.test(v)));
    // صلاه's ه (a folded ta-marbuta) is word-final anyway, but the fold
    // must hold wherever it appears
    for (const v of c.variantsOf("رحمه")) assert.notEqual(tasmeeNorm(v), "رحمه");
});

test("THE WORD-FINAL LETTER IS NEVER JUDGED (idgham/ikhfa/waqf)", () => {
    const c = mkChecker({ variantSet: "full" });
    for (const word of ["منهم", "اعمالهم", "الرحمن"]) {
        const head = word.slice(0, -1), last = word[word.length - 1];
        for (const v of c.variantsOf(word)) {
            assert.ok(v.length !== word.length || v[v.length - 1] === last,
                `${v} changes the final letter of ${word} — that letter assimilates into ` +
                `whatever follows it (golden 04's منهم scored its final م as ن by 2.84 nats, ` +
                `on a word nobody got wrong)`);
            assert.ok(v !== head, `${v} deletes the final letter of ${word}`);
        }
    }
});

test("THE WORD-INITIAL LETTER IS NEVER JUDGED EITHER (idgham runs both ways)", () => {
    const c = mkChecker({ variantSet: "full" });
    for (const word of ["نزل", "اعمالهم", "الرحمن"]) {
        const first = word[0], tail = word.slice(1);
        for (const v of c.variantsOf(word)) {
            assert.ok(v.length !== word.length || v[0] === first,
                `${v} changes the first letter of ${word} — the PREVIOUS word's final ` +
                `consonant merges into it (live path scored نُزِّلَ's initial ن as absent ` +
                `by 1.44 nats, on a word nobody got wrong)`);
            assert.ok(v !== tail, `${v} deletes the first letter of ${word}`);
        }
    }
});

test("the edge rules are knobs, not hardcoded (both directions provable)", () => {
    const loose = mkChecker({ variantSet: "full", skipFinal: false, skipInitial: false });
    assert.ok(loose.variantsOf("منهم").some((v) => v.length === 4 && v.slice(0, 3) === "منه" && v[3] !== "م"),
        "skipFinal:false must re-enable final-letter variants");
    assert.ok(loose.variantsOf("نزل").some((v) => v.length === 3 && v[0] !== "ن"),
        "skipInitial:false must re-enable initial-letter variants");
});

test("only the INTERIOR of a word is ever varied", () => {
    const c = mkChecker({ variantSet: "confusable" });
    // نزل: ن initial, ل final — the sole candidate is ز, which has no
    // confusable partner, so the channel has nothing at all to say
    assert.deepEqual(c.variantsOf("نزل"), []);
    // every variant of a longer word keeps both edges AND its length
    const vs = c.variantsOf("اعمالهم");
    assert.ok(vs.includes("اعمارهم"), "the founder's actual mistake must be reachable");
    for (const v of vs) {
        assert.equal(v.length, 7, `${v} changed the word's length — see deletions:false`);
        assert.equal(v[0], "ا", `${v} moved the first letter`);
        assert.equal(v[v.length - 1], "م", `${v} moved the last letter`);
    }
});

test("DELETIONS ARE OFF by default (length is madd, not spelling)", () => {
    const off = mkChecker({ variantSet: "full" });
    for (const v of off.variantsOf("اعمالهم")) assert.equal(v.length, 7);
    const on = mkChecker({ variantSet: "full", deletions: true });
    assert.ok(on.variantsOf("اعمالهم").some((v) => v.length === 6), "the knob still works");
});

test("the confusable set is a strict subset of the full sweep, and much smaller", () => {
    const full = mkChecker({ variantSet: "full" }).variantsOf("اعمالهم");
    const conf = mkChecker({ variantSet: "confusable" }).variantsOf("اعمالهم");
    assert.ok(conf.length < full.length / 4, `confusable ${conf.length} vs full ${full.length}`);
    for (const v of conf) assert.ok(full.includes(v), `${v} is not reachable from the full sweep`);
});

test("a word too short to have a judgeable interior yields no variants", () => {
    const c = mkChecker({ variantSet: "confusable" });
    // 2 letters: position 0 is the only candidate, position 1 is final —
    // and the check must then ABSTAIN rather than score an empty set
    assert.equal(c.check({ rows: [], V: VOCAB.length, f0: 0, f1: 0, form: "من" }), null);
});

test("check() abstains on missing frames rather than guessing", () => {
    const c = mkChecker({ variantSet: "confusable" });
    const V = VOCAB.length;
    const rows = Array.from({ length: 30 }, () => new Float32Array(V).fill(-3));
    rows[10] = null;                       // a hole in the ring
    assert.equal(c.check({ rows, V, f0: 8, f1: 14, form: "اعمالهم" }), null);
    assert.equal(c.check({ rows: rows.slice(0, 3), V, f0: 0, f1: 2, form: "اعمالهم" }), null,
        "too few frames to have an opinion");
});
