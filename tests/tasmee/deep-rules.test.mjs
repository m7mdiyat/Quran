/* LAYER 2 RULES — PARITY WITH PYTHON (2026-07-26).
 *
 * The rules are the product. Every guard in them was added because a
 * specific clean recitation got falsely flagged, and a port that merely
 * sounds equivalent will differ on exactly those cases. So the JS is held
 * to the Python's OUTPUT — same reference, same decoded phonemes, same
 * confidences in, same findings out — not to a description of it.
 *
 * The fixtures are real: Mohammed's own recitation of surah ص page 453
 * (clean, must yield nothing) and page 507 with six deliberate mistakes
 * (must yield all six). They carry the exact model output, so these tests
 * need no model and run in milliseconds.
 *
 * Also pinned here: the shipped reference (public/tasmee-phonemes.json)
 * must equal what the authoritative Python phonetizer produced. If those
 * drift, every finding silently points at the wrong phonemes.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { judge, opcodes, DEEP_RULES } from "../../src/tasmee-deep-rules.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const fx = (n) => JSON.parse(fs.readFileSync(path.join(HERE, `${n}.json`), "utf8"));
const key = (r) => `${r.group}|${r.kind}|${r.expected}|${r.heard}`;
const has = (n) => fs.existsSync(path.join(HERE, `${n}.json`));

test("difflib port: longest-match recursion, not a generic diff", () => {
    /* Python's difflib recursively takes the LONGEST matching block and
     * splits around it. A Myers/LCS diff yields different opcodes on the
     * same input, which yields different findings — so the algorithm is
     * reproduced, not substituted. Verified against Python on 61 random and
     * real phoneme strings at the time of writing; this keeps the shape. */
    assert.deepEqual(opcodes([..."abcd"], [..."abcd"]), [["equal", 0, 4, 0, 4]]);
    assert.deepEqual(opcodes([..."abcd"], [..."abxd"]),
        [["equal", 0, 2, 0, 2], ["replace", 2, 3, 2, 3], ["equal", 3, 4, 3, 4]]);
    assert.deepEqual(opcodes([], [..."ab"]), [["insert", 0, 0, 0, 2]]);
    assert.deepEqual(opcodes([..."ab"], []), [["delete", 0, 2, 0, 0]]);
});

test("CLEAN recitation of surah ص yields exactly what Python yields (nothing)",
    { skip: has("fx-sad-453") ? false : "fixture absent" }, () => {
        const x = fx("fx-sad-453");
        const got = judge({ groups: x.groups, wordsPerGroup: x.wordsPerGroup },
            { text: x.heardText, probs: x.probs }, { conf: x.conf });
        assert.equal(x.findings.length, 0, "the fixture itself must be a clean take");
        assert.deepEqual(got.map(key).sort(), [],
            `false flags on correct recitation: ${JSON.stringify(got)}`);
    });

test("SIX planted mistakes are found, identically to Python",
    { skip: has("fx-test") ? false : "fixture absent" }, () => {
        const x = fx("fx-test");
        const got = judge({ groups: x.groups, wordsPerGroup: x.wordsPerGroup },
            { text: x.heardText, probs: x.probs }, { conf: x.conf });
        assert.equal(x.findings.length, 6, "fixture should carry six findings");
        assert.deepEqual(got.map(key).sort(), x.findings.map(key).sort());
        // five harakat, one letter — the split matters: harakat is the channel
        // that ships on by default, and it is the one carrying this clip
        assert.equal(got.filter((f) => f.kind === "har").length, 5);
        assert.equal(got.filter((f) => f.kind === "con").length, 1);
    });

test("the confidence bar is respected", { skip: has("fx-test") ? false : "fixture absent" }, () => {
    const x = fx("fx-test");
    const ref = { groups: x.groups, wordsPerGroup: x.wordsPerGroup };
    const heard = { text: x.heardText, probs: x.probs };
    const lo = judge(ref, heard, { conf: 0.5 }).length;
    const hi = judge(ref, heard, { conf: 0.999 }).length;
    assert.ok(lo >= x.findings.length, "a lower bar cannot find fewer");
    assert.ok(hi <= x.findings.length, "a higher bar cannot find more");
});

test("each channel can be switched off independently", { skip: has("fx-test") ? false : "fixture absent" }, () => {
    const x = fx("fx-test");
    const ref = { groups: x.groups, wordsPerGroup: x.wordsPerGroup };
    const heard = { text: x.heardText, probs: x.probs };
    assert.ok(judge(ref, heard, { conf: x.conf, letters: false }).every((f) => f.kind === "har"));
    assert.ok(judge(ref, heard, { conf: x.conf, harakat: false }).every((f) => f.kind === "con"));
    assert.deepEqual(judge(ref, heard, { conf: x.conf, harakat: false, letters: false }), []);
});

test("degenerate inputs return nothing instead of throwing", () => {
    assert.deepEqual(judge({ groups: [], wordsPerGroup: [] }, { text: "", probs: [] }), []);
    assert.deepEqual(judge({ groups: ["كَفَرُوا"], wordsPerGroup: [1] }, { text: "", probs: [] }), []);
    assert.doesNotThrow(() => judge({ groups: ["كَفَرُوا"] }, { text: "كَفَرُوا" }));
});

test("hamza and alef are the same letter (Layer 1 drops lone hamza)", () => {
    const { fold } = DEEP_RULES;
    for (const c of "أإآٱء") assert.equal(fold(c), fold("ا"), `${c} must fold onto alef`);
    assert.equal(fold("ة"), fold("ه"));
    assert.equal(fold("ى"), fold("ي"));
    assert.notEqual(fold("د"), fold("ذ"), "genuinely distinct letters must not fold");
});

test("the SHIPPED reference equals the authoritative Python phonetizer",
    { skip: has("fx-sad-453") ? false : "fixture absent" }, () => {
        /* public/tasmee-phonemes.json is generated by quran_phonetizer and is
         * what the app will actually compare against. If it drifts from what
         * the checker was validated on, every finding silently points at the
         * wrong phonemes — and nothing else in the system would notice. */
        const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, "public/tasmee-phonemes.json"), "utf8"));
        const x = fx("fx-sad-453");
        const [surah, span] = x.range.split(":");
        const [from, to] = span.split("-").map(Number);
        const groups = [];
        for (let a = from; a <= to; a++) groups.push(...shipped.verses[`${surah}:${a}`].p.split(" "));
        assert.deepEqual(groups, x.groups,
            "the shipped phoneme reference no longer matches what the checker was validated against");
    });
