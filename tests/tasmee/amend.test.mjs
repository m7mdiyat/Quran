/* AMENDMENT-CHANNEL fixtures (2026-07-16). Contract under test:
 * while decode windows still cover a committed word's span, later
 * STABLE re-readings (amend.stability sightings, start within
 * ±2·frameS) amend the committed heard-text; verdicts are re-derived
 * through the SAME matcher via session.applyReverdict (shadow replay);
 * once anything is amended, every later commit re-reconciles (resync
 * semantics); amendments never re-feed the live session and never
 * consult the reference to FORM a reading; the window closes when the
 * anchor passes the span. NOTE a structural property the fixtures
 * respect: decodes only happen while speech (or a pending word)
 * continues — amendment material exists only then, exactly as live.
 * Driven like the incremental seam fixtures: scripted STAGED decode
 * against a REAL engine session. */

import test from "node:test";
import assert from "node:assert/strict";
import { createTasmeeSession } from "../../src/tasmee-engine.js";
import { tasmeeNorm } from "../../src/tasmee-norm.js";
import { createStreamController } from "../../src/tasmee-stream.js";

const CHUNK_S = 0.3, HOLDBACK_S = 0.3, FRAME_S = 0.08;
const AMEND = { stability: 2, minOverlapFrac: 0.5 };   // config-of-record values

const W = (vk, pos, form) => ({ vk, pos, form });

/* Staged timeline: decode uses the LAST stage whose fromEnd ≤ segment
 * end (readings evolve with window composition, as live). Containment
 * rule identical to the seam fixtures. */
function makeStaged(stages) {
    const all = stages.flatMap((s) => s.words);
    return {
        isSpeech: (a, b) => all.some((w) => w.startS < b && w.endS > a),
        decode(segStart, segEnd) {
            let words = stages[0].words;
            for (const s of stages) if (segEnd >= s.fromEnd - 1e-9) words = s.words;
            return words
                .filter((w) => w.endS > segStart && w.endS <= segEnd)
                .map((w) => ({ ...w }));
        },
    };
}

async function run(refWords, stages, { untilS, amend = AMEND, ctlExtra = {}, sessionOptions = {} } = {}) {
    const events = [];
    const session = createTasmeeSession({ words: refWords, onEvent: (e) => events.push(e), options: sessionOptions });
    const tl = makeStaged(stages);
    const ctl = createStreamController({
        session,
        decode: (a, b) => Promise.resolve(tl.decode(a, b)),
        isSpeech: (a, b) => tl.isSpeech(a, b),
        findSilenceBefore: () => null,
        norm: tasmeeNorm,
        chunkS: CHUNK_S, holdbackS: HOLDBACK_S, frameS: FRAME_S,
        mode: "incremental", incContextS: 1.5, incEdgeGuardS: 0.2,
        amend, ...ctlExtra,
    });
    for (let t = CHUNK_S; t <= untilS + 1e-9; t += CHUNK_S) await ctl.step(+t.toFixed(2));
    ctl.flush(untilS);
    session.stop(Math.round(untilS * 1000));
    return { events, session, ctl, words: session.getWords() };
}

const verdictOf = (words, vk, pos) => words.find((w) => w.vk === vk && w.pos === pos)?.verdict;
const amendsOf = (events) => events.filter((e) => e.type === "amend");

/* Shared founder-47:4 shape: fusion span first commits as «من»+«بعد»
 * (منا flagged), speech continues (واما فداء حتي), later windows stably
 * re-read «منا». */
function founderShape() {
    const ref = [W("47:4", 12, "فاما"), W("47:4", 13, "منا"), W("47:4", 14, "بعد"),
                 W("47:4", 15, "واما"), W("47:4", 16, "فدا"), W("47:4", 17, "حتي")];
    const early = [
        { text: "فاما", startS: 0.5, endS: 1.0 },
        { text: "من", startS: 1.2, endS: 1.6 },      // blob → flags منا
        { text: "بعد", startS: 1.7, endS: 2.1 },
        { text: "واما", startS: 2.4, endS: 2.8 },
        { text: "فدا", startS: 3.0, endS: 3.5 },
        { text: "حتي", startS: 3.8, endS: 4.3 },
    ];
    const late = early.map((w) => (w.startS === 1.2 ? { ...w, text: "منا" } : w));
    // late stage right after the blob commits (~2.4s): a real mis-split blob
    // does not keep reconfirming (founder evidence: eff=0), so fixtures model that
    return { ref, stages: [{ fromEnd: 0, words: early }, { fromEnd: 2.7, words: late }] };
}

/* ── 1. amend-improves (the founder-47:4 shape) */
test("amend improves: committed blob later re-read correctly → flag dies", async () => {
    const { ref, stages } = founderShape();
    const { events, words, ctl } = await run(ref, stages, { untilS: 6.0 });
    // pre-amendment: منا was flagged (skipped — the founder's exact shape)
    const firstReveal = events.find((e) => e.type === "reveal" && e.pos === 13);
    assert.ok(firstReveal && firstReveal.verdict !== "correct", `منا first flagged (${firstReveal?.verdict})`);
    // amendment fired and flipped it
    const am = amendsOf(events).find((e) => e.pos === 13);
    assert.ok(am, "amend event for منا");
    assert.equal(am.to, "correct");
    assert.equal(verdictOf(words, "47:4", 13), "correct");
    // committed record: original text preserved, amendment aside
    const rec = ctl.results().committed.find((c) => tasmeeNorm(c.text) === "من");
    assert.ok(rec && rec.amendTexts && tasmeeNorm(rec.amendTexts[0]) === "منا");
});

/* ── 2a. worsening evidence — DEFAULT mode: recorded, NOT applied.
 * Measured rationale (2026-07-16 rig): symmetric worsening let degraded
 * deep-window re-readings overwrite good commits on marginal audio
 * (02-whisper 0→10 false flags). Default: verdict stays; evidence event
 * emitted for diagnostics / the future repair layer. */
test("worsening re-reading: evidence recorded, verdict NOT changed (default)", async () => {
    const ref = [W("2:32", 1, "قال"), W("2:32", 2, "الحكيم"), W("2:32", 3, "تنزيل")];
    const early = [
        { text: "قال", startS: 0.5, endS: 0.9 },
        { text: "الحكيم", startS: 1.1, endS: 1.7 },  // model-prior autocorrect: passes
        { text: "تنزيل", startS: 2.0, endS: 2.6 },
    ];
    const late = early.map((w) => (w.startS === 1.1 ? { ...w, text: "العليم" } : w)); // what was really said
    const { events, words } = await run(ref, [{ fromEnd: 0, words: early }, { fromEnd: 2.4, words: late }], { untilS: 4.5 });
    assert.equal(amendsOf(events).filter((e) => e.pos === 2).length, 0, "no applied amendment");
    const ev = events.find((e) => e.type === "amend_evidence" && e.pos === 2);
    assert.ok(ev, "worsening evidence recorded");
    assert.equal(ev.to, "substituted");
    assert.equal(verdictOf(words, "2:32", 2), "correct", "verdict unchanged in default mode");
});

/* ── 2b. strict mode (amendApplyWorsen — future repair-layer territory,
 * NOT the ship default): the same scenario applies the late catch. */
test("strict mode applies the late catch (amendApplyWorsen)", async () => {
    const ref = [W("2:32", 1, "قال"), W("2:32", 2, "الحكيم"), W("2:32", 3, "تنزيل")];
    const early = [
        { text: "قال", startS: 0.5, endS: 0.9 },
        { text: "الحكيم", startS: 1.1, endS: 1.7 },
        { text: "تنزيل", startS: 2.0, endS: 2.6 },
    ];
    const late = early.map((w) => (w.startS === 1.1 ? { ...w, text: "العليم" } : w));
    const { events, words } = await run(ref, [{ fromEnd: 0, words: early }, { fromEnd: 2.4, words: late }],
        { untilS: 4.5, sessionOptions: { amendApplyWorsen: true } });
    const am = amendsOf(events).find((e) => e.pos === 2);
    assert.ok(am, "late-catch amend event");
    assert.equal(am.from, "correct");
    assert.equal(am.to, "substituted");
    assert.equal(verdictOf(words, "2:32", 2), "substituted");
});

/* ── 3. honesty guard (Class-B shape): a wrong committed reading whose
 * re-decodes KEEP saying the same wrong text is NEVER amended. */
test("no amendment without decode evidence: stable wrong reading stays flagged", async () => {
    const ref = [W("47:4", 13, "منا"), W("47:4", 14, "بعد"), W("47:4", 15, "واما")];
    const stable = [
        { text: "ننبعد", startS: 0.5, endS: 1.3 },   // ayoub-style blob, re-read identically forever
        { text: "واما", startS: 1.6, endS: 2.0 },
    ];
    const { events, words } = await run(ref, [{ fromEnd: 0, words: stable }], { untilS: 4.2 });
    assert.equal(amendsOf(events).length, 0, "no amend events");
    assert.notEqual(verdictOf(words, "47:4", 13), "correct");
});

/* ── 4. stability bar: one sighting (then contradiction) does NOT amend;
 * two consecutive sightings DO. */
test("stability bar: one sighting no amend, two consecutive amend", async () => {
    const ref = [W("1:2", 1, "الحمد"), W("1:2", 2, "لله"), W("1:2", 3, "رب"), W("1:2", 4, "العالمين")];
    const mk = (second) => [
        { text: "الحمد", startS: 0.4, endS: 0.9 },
        { text: second, startS: 1.1, endS: 1.5 },
        { text: "رب", startS: 1.8, endS: 2.2 },
        { text: "العالمين", startS: 2.5, endS: 3.9 },
    ];
    const stages = [
        { fromEnd: 0, words: mk("له") },     // sub-band vs لله → flags
        { fromEnd: 2.4, words: mk("لله") },  // ONE sighting…
        { fromEnd: 2.7, words: mk("له") },   // …contradicted → reset
        { fromEnd: 3.3, words: mk("لله") },  // stable pair 3.3+3.6 → amend
    ];
    const { events, words, ctl } = await run(ref, stages, { untilS: 5.1 });
    // the CONTROLLER amendment happened exactly once, and only after the
    // stable pair (3.3+3.6) — never off the single contradicted sighting.
    const rec = ctl.results().committed.find((c) => tasmeeNorm(c.text) === "له");
    assert.ok(rec && rec.amendTexts && tasmeeNorm(rec.amendTexts[0]) === "لله", "amended once to لله");
    assert.ok(rec.amendedAtS >= 3.6 - 1e-9, `amended at ${rec.amendedAtS}s — after the stable pair`);
    const ams = amendsOf(events);
    assert.ok(ams.every((e) => e.t >= 3600), "no verdict change before the stable pair");
    assert.equal(verdictOf(words, "1:2", 2), "correct");
    // NOTE: multiple amend EVENTS for one word are designed churn — live
    // machinery (e.g. a pendingOmit resolving) can re-reveal after an
    // amendment; the every-commit-reconciles rule flips it back. The UI
    // deferral absorbs this invisibly (negative verdicts are held).
});

/* ── 5. horizon: once the anchor has passed a span, re-readings are
 * ignored — the amendment window is closed. */
test("horizon: no amendment once the anchor passed the span", async () => {
    const forms = ["براه", "من", "الله", "ورسوله", "الي", "الذين", "عاهدتم", "منن", "المشركين", "فسيحوا", "في", "الارض", "اربعه", "اشهر", "واعلموا"];
    const ref = forms.map((f, i) => W("9:1", i + 1, f));
    const flow = forms.map((f, i) => ({
        text: i === 0 ? "بره" : f,                    // بره fuzzy-passes براه (0.75)
        startS: 0.4 + i * 0.5, endS: 0.8 + i * 0.5,
    }));
    // the "better" re-reading appears at 7.5s — speech still flowing, but
    // the anchor has re-pinned far past the [0.4,0.8] span by then
    const late = flow.map((w, i) => (i === 0 ? { ...w, text: "براه" } : w));
    const { events, ctl } = await run(ref, [{ fromEnd: 0, words: flow }, { fromEnd: 7.5, words: late }], { untilS: 9.0 });
    assert.equal(amendsOf(events).filter((e) => e.pos === 1).length, 0, "no amendment after horizon closed");
    const rec = ctl.results().committed.find((c) => tasmeeNorm(c.text) === "بره");
    assert.ok(rec && !rec.amendTexts, "committed record unamended");
});

/* ── 6. resync interplay (the flagged risky interaction): resync commits
 * skips; amendments + the every-commit-reconciles rule resolve them. */
test("resync skips flip to correct when their spans are later read correctly", async () => {
    // ref gap between the last matched word and the resume point EXCEEDS the
    // K=4 lookahead (رحمه at j=5) so recovery goes through STALL-RESYNC, not
    // corroborated omission — the interplay this fixture pins.
    const ref = [W("24:35", 1, "كتاب"), W("24:35", 2, "نور"), W("24:35", 3, "هدي"),
                 W("24:35", 4, "عظه"), W("24:35", 5, "نبا"), W("24:35", 6, "خبر"),
                 W("24:35", 7, "رحمه"), W("24:35", 8, "بشري"), W("24:35", 9, "وذكري")];
    const g = (t, s) => ({ text: t, startS: s, endS: s + 0.25 });
    const early = [
        { text: "كتاب", startS: 0.4, endS: 0.8 },
        g("قشط", 1.1), g("زحف", 1.45), g("ضغث", 1.8), g("خذق", 2.15), g("ثعط", 2.5), g("غسق", 2.85),
        { text: "رحمه", startS: 3.2, endS: 3.6 },
        { text: "بشري", startS: 3.7, endS: 4.1 },
        { text: "وذكري", startS: 4.4, endS: 4.9 },
    ];
    const late = [
        early[0],
        { text: "نور", startS: 1.1, endS: 2.05 },    // spans the first junk cluster
        { text: "هدي", startS: 2.15, endS: 3.1 },    // spans the second
        ...early.slice(7),
    ];
    const { events, words } = await run(ref, [{ fromEnd: 0, words: early }, { fromEnd: 3.3, words: late }], { untilS: 6.6 });
    assert.ok(events.some((e) => e.type === "resync"), "stall-resync fired");
    const skipsFirst = events.filter((e) => e.type === "reveal" && e.verdict === "skipped").map((e) => e.pos);
    assert.ok(skipsFirst.includes(2) && skipsFirst.includes(3), `نور+هدي initially skipped (${skipsFirst})`);
    // amendments flip the words whose spans were later read correctly…
    assert.equal(verdictOf(words, "24:35", 2), "correct");
    assert.equal(verdictOf(words, "24:35", 3), "correct");
    // …and the words NEVER recited (no decode evidence) honestly stay skipped
    for (const pos of [4, 5, 6]) assert.equal(verdictOf(words, "24:35", pos), "skipped", `pos ${pos} stays skipped`);
});

/* ── 7. hesitation unaffected: identical timeline, channel on vs off →
 * identical hesitation/offer events. */
test("hesitation timing identical with amendment channel on/off", async () => {
    const ref = [W("1:1", 1, "بسم"), W("1:1", 2, "الله"), W("1:1", 3, "الرحمن"), W("1:1", 4, "الرحيم")];
    const early = [
        { text: "بسم", startS: 0.4, endS: 0.8 },
        { text: "اله", startS: 1.0, endS: 1.4 },     // fuzzy variant → amendable
        { text: "الرحمن", startS: 2.0, endS: 2.5 },
    ];
    const late = early.map((w) => (w.startS === 1.0 ? { ...w, text: "الله" } : w));
    const stages = [{ fromEnd: 0, words: early }, { fromEnd: 2.4, words: late }];
    // recitation stalls before الرحيم → long silence → hesitation offer
    const on = await run(ref, stages, { untilS: 8.4 });
    const off = await run(ref, stages, { untilS: 8.4, amend: null });
    const hes = (r) => r.events.filter((e) => e.type === "hesitation" || e.type === "hint_offer").map((e) => e.t);
    assert.deepEqual(hes(on), hes(off), "hesitation/offer events identical");
    assert.ok(hes(on).length >= 1, "hesitation actually fired");
    assert.ok((on.ctl.results().committed.some((c) => c.amendTexts)) &&
              !(off.ctl.results().committed.some((c) => c.amendTexts)), "channel actually differed");
});

/* ── 8. repetition tolerance preserved by construction: 3× repetition +
 * an amendment mid-stream → zero mistakes, reps logged, no re-feeds. */
test("3× repetition stays zero-mistake; amendments never re-feed tokens", async () => {
    const ref = [W("112:1", 1, "قل"), W("112:1", 2, "هو"), W("112:1", 3, "الله"), W("112:1", 4, "احد")];
    const early = [
        { text: "قل", startS: 0.4, endS: 0.7 },
        { text: "هو", startS: 0.9, endS: 1.2 },
        { text: "هو", startS: 1.8, endS: 2.1 },      // repetition (spaced past the 0.45s dup window)
        { text: "هو", startS: 2.7, endS: 3.0 },      // repetition
        { text: "اله", startS: 3.3, endS: 3.7 },     // fuzzy-passes الله → amendable
        { text: "احد", startS: 4.3, endS: 5.1 },     // long final word keeps decode alive
    ];
    const late = early.map((w) => (w.startS === 3.3 ? { ...w, text: "الله" } : w));
    // late stage begins only after اله has committed (stage flips mid-
    // stability would break ITS commit, which is a different scenario)
    const { events, words, session, ctl } = await run(ref, [{ fromEnd: 0, words: early }, { fromEnd: 4.8, words: late }], { untilS: 6.9 });
    const reps = events.filter((e) => e.type === "repetition");
    assert.ok(reps.length >= 2, `repetitions logged (${reps.length})`);
    for (const r of ref) assert.equal(verdictOf(words, r.vk, r.pos), "correct", `${r.form} correct`);
    // the amendment really happened (heard-text upgraded aside)
    assert.ok(ctl.results().committed.some((c) => c.amendTexts && tasmeeNorm(c.amendTexts[0]) === "الله"));
    // exactly ONE reveal per ref word on the live session (no re-feeds)
    for (let i = 0; i < ref.length; i++) {
        assert.equal(events.filter((e) => e.type === "reveal" && e.idx === i).length, 1, `single reveal for idx ${i}`);
    }
    const sum = session.summary();
    assert.equal(sum.counts.substituted + sum.counts.skipped, 0);
});

/* ── 10. CTC-spike record (the founder's actual منا shape): a committed
 * word with a ZERO-LENGTH span (startS === endS — single-token CTC
 * emission) is amendable via point-containment assignment. */
test("zero-span (CTC spike) committed word is amendable", async () => {
    const ref = [W("47:4", 12, "فاما"), W("47:4", 13, "منا"), W("47:4", 14, "بعد"), W("47:4", 15, "واما"), W("47:4", 16, "فدا"), W("47:4", 17, "حتي")];
    const early = [
        { text: "فاما", startS: 0.5, endS: 1.0 },
        { text: "من", startS: 1.3, endS: 1.3 },      // SPIKE — exactly what the founder clip committed
        { text: "بعد", startS: 1.7, endS: 2.1 },
        { text: "واما", startS: 2.4, endS: 2.8 },
        { text: "فدا", startS: 3.0, endS: 3.6 },
        { text: "حتي", startS: 3.9, endS: 4.5 },     // speech continues through the amendment stage
    ];
    const late = early.map((w) => (w.startS === 1.3 ? { text: "منا", startS: 1.2, endS: 1.6 } : w));
    const { events, words, ctl } = await run(ref, [{ fromEnd: 0, words: early }, { fromEnd: 3.9, words: late }], { untilS: 6.3 });
    const am = amendsOf(events).find((e) => e.pos === 13);
    assert.ok(am, "amend event for the spike-committed منا");
    assert.equal(verdictOf(words, "47:4", 13), "correct");
    const rec = ctl.results().committed.find((c) => tasmeeNorm(c.text) === "من");
    assert.ok(rec && rec.amendTexts && tasmeeNorm(rec.amendTexts[0]) === "منا");
});

/* ── 9. summary reconciliation: counts move with amendments. */
test("summary counts move with amendments", async () => {
    const { ref, stages } = founderShape();
    const { session } = await run(ref, stages, { untilS: 6.0 });
    const s = session.summary();
    assert.equal(s.counts.correct, ref.length, "all words correct after amendment");
    assert.equal(s.counts.substituted + s.counts.skipped, 0);
});

/* ── 12. DISAGREEMENT ⇒ UNVERIFIED (M1b, 2026-07-19).
 * The founder's منا signature: a committed span whose later re-readings
 * contradict BOTH the commit and each other — several DISTINCT spellings,
 * none repeating, the committed text never re-appearing. Nothing can be
 * amended (no reading reaches the stability bar) but asserting a mistake on
 * self-contradicting evidence is equally unsupported, so the negative
 * verdict is SUPPRESSED and reported as `unverified`. No reading is ever
 * selected and the reference is never consulted. */
test("persistent disagreement suppresses the flag → unverified, not skipped", async () => {
    const ref = [W("47:4", 12, "فاما"), W("47:4", 13, "منا"), W("47:4", 14, "بعد"),
                 W("47:4", 15, "واما"), W("47:4", 16, "فدا"), W("47:4", 17, "حتي")];
    const base = (mid) => [
        { text: "فاما", startS: 0.5, endS: 1.0 },
        ...(mid ? [{ text: mid, startS: 1.2, endS: 1.6 }] : []),
        { text: "بعد", startS: 1.7, endS: 2.1 },
        { text: "واما", startS: 2.4, endS: 2.8 },
        { text: "فدا", startS: 3.0, endS: 3.5 },
        { text: "حتي", startS: 3.8, endS: 4.3 },
    ];
    const { events, words } = await run(ref, [
        { fromEnd: 0, words: base("من") },      // commits as a mis-split «من»
        { fromEnd: 2.4, words: base("منن") },   // …then distinct re-readings,
        { fromEnd: 2.7, words: base("مان") },   //    none of them twice
        { fromEnd: 3.0, words: base("منا") },
        { fromEnd: 3.3, words: base(null) },    // and finally nothing at all
    ], { untilS: 5.4 });
    assert.equal(verdictOf(words, "47:4", 13), "unverified",
        "منا reported unverified rather than asserted as skipped");
    // it was flagged first (live), then suppressed — never silently correct
    const first = events.find((e) => e.type === "reveal" && e.pos === 13);
    assert.ok(first && first.verdict !== "correct", `first reveal was a flag (${first?.verdict})`);
    // no reading was adopted: the committed record keeps its own text
    assert.ok(!amendsOf(events).some((e) => e.pos === 13 && e.to === "correct"),
        "no reading was selected as a correction");
});

/* ── 13. RECALL GUARD (the non-negotiable half of #12): a REAL mistake the
 * model hears CONSISTENTLY keeps reconfirming its own commit, so the
 * disagreement criterion never fires and the flag stands. This is what
 * stops "unverified" from becoming a leniency channel. */
test("consistently-heard wrong word stays flagged (never softened to unverified)", async () => {
    const ref = [W("2:32", 1, "قال"), W("2:32", 2, "الحكيم"), W("2:32", 3, "تنزيل")];
    const words0 = [
        { text: "قال", startS: 0.4, endS: 0.8 },
        { text: "العليم", startS: 1.0, endS: 1.5 },   // sim 0.667 → substitution range, heard identically every time
        { text: "تنزيل", startS: 1.8, endS: 2.3 },
    ];
    const { words } = await run(ref, [{ fromEnd: 0, words: words0 }], { untilS: 4.2 });
    assert.equal(verdictOf(words, "2:32", 2), "substituted",
        "a stably-misheard word keeps its flag");
});
