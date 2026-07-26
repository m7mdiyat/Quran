/* ============================================================
 * tasmee-deep-rules.js — Layer 2's judgement, in JS.
 *
 * Takes the reference phonemes (public/tasmee-phonemes.json) and what
 * the model heard (text + per-phoneme confidence), and returns findings:
 * which word, which unit, expected vs heard, how sure.
 *
 * PURE — no model, no audio, no DOM. Everything here is a decision about
 * what counts as a mistake, and every one of those decisions was settled
 * by measurement on real recitation rather than by argument:
 *
 *  1. ABSTAIN ON OMISSION. A unit the model did not emit is not evidence
 *     that it was said wrongly. Silence is not an accusation.
 *  2. CONFIDENT DISAGREEMENT ONLY. A hesitant disagreement is the model
 *     being unsure, not the reciter being wrong.
 *  3. NEVER JUDGE A WORD EDGE — including edges a MERGE has hidden. The
 *     phonetizer merges words across idgham (بَل لَّمَّا, لَشَىْءٌۭ
 *     يُرَادُ become single groups), which turns a word boundary into an
 *     interior position and silently disables this guard exactly where it
 *     is needed. MEASURED: لَشَىْءٌۭ يُرَادُ was flagged ي→ن on a clean
 *     recitation — tanwin + ya is idgham with ghunna, so the sound there
 *     genuinely IS nasal and the model heard correctly.
 *  4. MADD LENGTH IS NOT IDENTITY. How long a vowel is held is a
 *     recitation choice; runs of a madd carrier collapse before comparing.
 *  5. SEAT-EQUIVALENT LETTERS ARE THE SAME LETTER. Layer 1 folds the
 *     hamza seats and drops lone hamza, so ٱلسَّمَـٰوَٰتِ "expected ا,
 *     heard ء" is spelling convention, not a mistake — and reporting it
 *     would contradict the surface the reciter is looking at.
 *  6. IMPLAUSIBLE SUBSTITUTIONS ARE ALIGNMENT DRIFT. Nobody recites ذ as
 *     ل and no acoustic model confuses them; when the diff claims that it
 *     has slipped and is blaming the wrong position.
 *
 * Together these took a clean recitation of surah ص from 5 false flags in
 * 107 words to 0, while keeping every planted mistake.
 * ============================================================ */

const HARAKAT = new Set(["َ", "ِ", "ُ"]);          // fatha, kasra, damma
const MADD = new Set(["ا", "ۥ", "ۦ", "ى"]);   // alef, small waw, small yeh, alef maqsura
const NASAL_MARK = "ں";                                       // ikhfa nun — a realisation, not a letter

/* The 28 letters plus hamza seats. A WHITELIST: Quran Phonetic Script also
 * carries tajweed symbols (the ikhfa nun, ۾, ڇ) which encode how a sound is
 * REALISED, not which letter it is. Scoring one produced "expected ۾, heard
 * م" — a real tajweed distinction reported as a spelling mistake. */
const LETTERS = new Set([..."ابتثجحخدذرزسشصضطظعغفقكلمنهوي", ..."ءأإآؤئة"]);

/* Seat classes — same folds Layer 1's matcher uses. Lone hamza belongs with
 * alef because Layer 1 DROPS it outright. */
const SEAT = new Map();
for (const cls of ["اأإآٱء", "وؤ", "يئى", "هة"]) for (const c of cls) SEAT.set(c, cls[0]);
const fold = (ch) => SEAT.get(ch) || ch;

/* Acoustically plausible consonant confusions. A claimed substitution
 * outside this set is treated as alignment drift and dropped. */
const CONFUSABLE = {
    "ر": "لن", "ل": "رنم", "د": "لذتط", "ن": "رلم", "ه": "كحء",
    "ك": "هقغ", "ت": "يثدط", "ي": "تبن", "م": "نبو", "ب": "تنم",
    "س": "شصز", "ح": "خهع", "ع": "غاح", "ق": "كفخ", "ط": "تظد",
    "ص": "سضظ", "ث": "تسذ", "ذ": "زظثد", "ز": "سذص", "ظ": "ذضط",
    "ض": "دظص", "خ": "غحق", "غ": "خعق", "ف": "ثق", "ج": "شيز",
    "ش": "سج", "و": "مب", "ا": "ءه",
};

export const HARAKA_NAME = { "َ": "فتحة", "ِ": "كسرة", "ُ": "ضمة" };

/* ---- difflib.SequenceMatcher, ported faithfully ----
 * Python's difflib is NOT a standard diff: it recursively takes the longest
 * matching block and splits around it (Ratcliff-Obershelp). A Myers or LCS
 * diff produces different opcodes, which would produce different findings —
 * so the algorithm is reproduced rather than substituted. autojunk is off,
 * matching the Python call. */
export function opcodes(a, b) {
    const b2j = new Map();
    for (let i = 0; i < b.length; i++) {
        const k = b[i];
        if (!b2j.has(k)) b2j.set(k, []);
        b2j.get(k).push(i);
    }
    function longestMatch(alo, ahi, blo, bhi) {
        let besti = alo, bestj = blo, bestsize = 0;
        let j2len = new Map();
        for (let i = alo; i < ahi; i++) {
            const newj2len = new Map();
            for (const j of b2j.get(a[i]) || []) {
                if (j < blo) continue;
                if (j >= bhi) break;
                const k = (j2len.get(j - 1) || 0) + 1;
                newj2len.set(j, k);
                if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
            }
            j2len = newj2len;
        }
        return [besti, bestj, bestsize];
    }
    const blocks = [];
    const queue = [[0, a.length, 0, b.length]];
    while (queue.length) {
        const [alo, ahi, blo, bhi] = queue.pop();
        const [i, j, k] = longestMatch(alo, ahi, blo, bhi);
        if (k) {
            blocks.push([i, j, k]);
            if (alo < i && blo < j) queue.push([alo, i, blo, j]);
            if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
        }
    }
    blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    // merge adjacent blocks, then terminate with the sentinel difflib uses
    const merged = [];
    let [i1, j1, k1] = [0, 0, 0];
    for (const [i2, j2, k2] of blocks) {
        if (i1 + k1 === i2 && j1 + k1 === j2) k1 += k2;
        else { if (k1) merged.push([i1, j1, k1]); [i1, j1, k1] = [i2, j2, k2]; }
    }
    if (k1) merged.push([i1, j1, k1]);
    merged.push([a.length, b.length, 0]);

    const ops = [];
    let i = 0, j = 0;
    for (const [ai, bj, size] of merged) {
        let tag = "";
        if (i < ai && j < bj) tag = "replace";
        else if (i < ai) tag = "delete";
        else if (j < bj) tag = "insert";
        if (tag) ops.push([tag, i, ai, j, bj]);
        if (size) ops.push(["equal", ai, ai + size, bj, bj + size]);
        i = ai + size; j = bj + size;
    }
    return ops;
}

/* Collapse runs of a madd carrier, carrying a parallel tag array along. */
function collapse(seq, tags) {
    const o = [], ot = [];
    for (let i = 0; i < seq.length; i++) {
        if (o.length && seq[i] === o[o.length - 1] && MADD.has(seq[i])) continue;
        o.push(seq[i]); ot.push(tags[i]);
    }
    return [o, ot];
}

const isHaraka = (ch) => HARAKAT.has(ch);
const isLetter = (ch) => LETTERS.has(ch);

/* ---- the judgement ----
 * ref:   { groups: string[], wordsPerGroup: number[] }  from tasmee-phonemes.json
 * heard: { text: string, probs: number[] }              from the model
 * Returns findings: { group, wordOffset, kind: "har"|"con", expected, heard, conf }
 * `wordOffset` is which word WITHIN the group (0 unless the group is merged). */
export function judge(ref, heard, options = {}) {
    const opt = {
        conf: 0.9,          // rule 2 — the confidence bar
        harakat: true,      // 0.4% false flags measured: on by default
        letters: true,      // ~4% before the guards, ~0% after; caller decides
        mergeGuard: 2,      // rule 3 — positions either side of a hidden seam
        ...options,
    };
    const groups = ref.groups || [];
    const wpg = ref.wordsPerGroup || groups.map(() => 1);
    const text = heard.text || "";
    const probs = heard.probs || [];
    if (!groups.length || !text) return [];

    // reference stream, each unit tagged with its group
    const refChars = [], owner = [];
    groups.forEach((g, gi) => { for (const ch of g) { refChars.push(ch); owner.push(gi); } });

    const [refC, ownerC] = collapse(refChars, owner);
    const [hrdC, probC] = collapse([...text], probs);

    // rule 3: first/last unit of each class, per group
    const edges = new Map();   // `${group}|${kind}` → [first, last]
    for (let i = 0; i < refC.length; i++) {
        for (const [kind, test] of [["har", isHaraka], ["con", isLetter]]) {
            if (!test(refC[i])) continue;
            const k = `${ownerC[i]}|${kind}`;
            const e = edges.get(k);
            if (!e) edges.set(k, [i, i]); else e[1] = i;
        }
    }

    /* rule 3, extended: seams the phonetizer HID by merging. Positions are
     * counted within the group, so they survive the madd collapse only
     * approximately — hence the guard band rather than an exact index. */
    const seams = new Map();   // group → offsets (within the collapsed group)
    groups.forEach((g, gi) => {
        if ((wpg[gi] || 1) < 2) return;
        const start = ownerC.indexOf(gi);
        if (start < 0) return;
        let end = start;
        while (end + 1 < ownerC.length && ownerC[end + 1] === gi) end++;
        const len = end - start + 1;
        const parts = wpg[gi];
        const out = [];
        for (let p = 1; p < parts; p++) out.push(Math.round((len * p) / parts));
        seams.set(gi, out);
    });

    const found = [];
    for (const [tag, i1, i2, j1, j2] of opcodes(refC, hrdC)) {
        if (tag === "equal") continue;
        for (let i = i1; i < i2; i++) {
            const kind = isHaraka(refC[i]) ? "har" : (isLetter(refC[i]) ? "con" : null);
            if (!kind) continue;                                   // tajweed symbol: not a letter
            if (kind === "har" && !opt.harakat) continue;
            if (kind === "con" && !opt.letters) continue;
            const e = edges.get(`${ownerC[i]}|${kind}`);
            if (!e) continue;
            if (i === e[1]) continue;                              // word-final (waqf, idgham)
            if (kind === "con" && i === e[0]) continue;            // word-initial (idgham)

            const seam = seams.get(ownerC[i]);
            if (seam) {
                const gStart = ownerC.lastIndexOf(ownerC[i], i) >= 0
                    ? (() => { let s = i; while (s > 0 && ownerC[s - 1] === ownerC[i]) s--; return s; })() : i;
                const off = i - gStart;
                if (seam.some((sp) => Math.abs(off - sp) <= opt.mergeGuard)) continue;
            }

            const test = kind === "har" ? isHaraka : isLetter;
            const said = [];
            for (let j = j1; j < j2; j++) if (test(hrdC[j])) said.push([hrdC[j], probC[j] ?? 0, j]);
            if (!said.length) continue;                            // rule 1: model emitted nothing
            if (said.some(([ch]) => fold(ch) === fold(refC[i]))) continue;   // rule 5

            let best = said[0];
            for (const s of said) if (s[1] > best[1]) best = s;
            if (best[1] < opt.conf) continue;                      // rule 2
            if (kind === "con" && !(CONFUSABLE[fold(refC[i])] || "").includes(fold(best[0]))) continue; // rule 6

            // which word inside the group (0 unless merged)
            let wordOffset = 0;
            if (seam && seam.length) {
                let s = i; while (s > 0 && ownerC[s - 1] === ownerC[i]) s--;
                const off = i - s;
                wordOffset = seam.filter((sp) => off >= sp).length;
            }
            found.push({
                group: ownerC[i], wordOffset, kind,
                expected: refC[i], heard: best[0], conf: +best[1].toFixed(3),
                heardIndex: best[2],          // for the caller to attach a time
            });
        }
    }

    // one finding per (word, kind) — the most confident wins
    const best = new Map();
    for (const f of found) {
        const k = `${f.group}|${f.wordOffset}|${f.kind}`;
        const prev = best.get(k);
        if (!prev || f.conf > prev.conf) best.set(k, f);
    }
    return [...best.values()].sort((a, b) => a.group - b.group || a.wordOffset - b.wordOffset);
}

export const DEEP_RULES = { HARAKAT, MADD, LETTERS, CONFUSABLE, NASAL_MARK, fold };
