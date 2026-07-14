/* ============================================================
 * audit-tasmee-words.mjs — GATE 1 verification (TASMEE-PLAN §5).
 *
 * Independently re-derives every invariant of public/tasmee-words.json
 * from the raw sources. Count-matching alone cannot catch a WRONG
 * pairing (e.g. a fusion rule merging the wrong neighbors keeps
 * counts equal) — the similarity cross-check below is the guard
 * that can: every dataset form is compared against the normalized
 * QCF text at its exact position; low-similarity pairs must be on
 * the explicit whitelist or the audit fails.
 *
 * Exit 0 = Gate 1 data acceptance holds. Run after EVERY change to
 * src/tasmee-norm.js or scripts/build-tasmee-words.mjs (same
 * discipline as scripts/audit-gharib.mjs).
 *
 * Run:  node scripts/audit-tasmee-words.mjs
 * ============================================================ */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { tasmeeNormQcf } from "../src/tasmee-norm.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGES_DIR = path.join(ROOT, "public", "data", "qcf4", "pages");
const DATA_PATH = path.join(ROOT, "public", "tasmee-words.json");

const GZ_LIMIT_KB = 400;
const SIM_THRESHOLD = 0.5;

/* Low-similarity pairs that are KNOWN extreme Uthmani/Imlaei
 * orthographic divergences, reviewed by hand. Every entry needs a
 * comment saying why it is legitimate. Format "vk:pos". */
const SIM_WHITELIST = new Map([
    // يَبْنَؤُمَّ (QCF, one fused word) ↔ يا ابن أم (Imlaei, three words
    // fused by the build) — the worst divergence in the corpus.
    ["20:94:2", true],
]);

let failures = 0;
const fail = (msg) => { failures++; console.error("FAIL  " + msg); };

/* ---------- load ---------- */
const data = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
const verses = data.verses;

const qcf = new Map(); // vk -> [{pos,text,sajda}]
for (const f of fs.readdirSync(PAGES_DIR).sort()) {
    if (!f.endsWith(".json")) continue;
    const d = JSON.parse(fs.readFileSync(path.join(PAGES_DIR, f), "utf8"));
    for (const line of d.lines || []) {
        for (const w of line.words || []) {
            if (w.type !== "word") continue;
            let list = qcf.get(w.verse_key);
            if (!list) qcf.set(w.verse_key, (list = []));
            list.push({ pos: w.position, text: w.text || "", sajda: String(w.text || "").startsWith("#") });
        }
    }
}
for (const list of qcf.values()) list.sort((a, b) => a.pos - b.pos);

/* ---------- 1. coverage ---------- */
const dsKeys = Object.keys(verses);
if (dsKeys.length !== 6236) fail(`verse count ${dsKeys.length} ≠ 6236`);
if (qcf.size !== 6236) fail(`QCF verse count ${qcf.size} ≠ 6236`);
for (const vk of qcf.keys()) if (!verses[vk]) fail(`missing verse ${vk}`);
for (const vk of dsKeys) if (!qcf.has(vk)) fail(`extra verse ${vk}`);

/* ---------- 2–4. structural invariants + totals ---------- */
const LETTERS_RE = /^[ء-ي]+$/;
let words = 0, sajdas = 0;
for (const vk of dsKeys) {
    const arr = verses[vk];
    const qw = qcf.get(vk);
    if (!qw) continue;
    const maxPos = qw[qw.length - 1].pos;
    if (arr.length !== maxPos) fail(`${vk}: array length ${arr.length} ≠ max word pos ${maxPos}`);
    // positions must be exactly 1..maxPos with no gaps (word+sajda)
    const posSet = new Set(qw.map((w) => w.pos));
    for (let p = 1; p <= maxPos; p++) {
        if (!posSet.has(p)) fail(`${vk}: word positions not contiguous at ${p}`);
    }
    for (const w of qw) {
        const v = arr[w.pos - 1];
        if (w.sajda) {
            sajdas++;
            if (v !== null) fail(`${vk}:${w.pos}: sajda slot must be null, got "${v}"`);
        } else {
            words++;
            if (typeof v !== "string" || !v.length) { fail(`${vk}:${w.pos}: empty/non-string form`); continue; }
            if (!LETTERS_RE.test(v)) fail(`${vk}:${w.pos}: non-letter chars in "${v}"`);
        }
    }
}
if (words !== 77433) fail(`recited word total ${words} ≠ 77433`);
if (sajdas !== 15) fail(`sajda total ${sajdas} ≠ 15`);
if (data.counts?.words !== 77433 || data.counts?.sajdas !== 15 || data.counts?.verses !== 6236) {
    fail(`meta counts ${JSON.stringify(data.counts)} disagree with derived totals`);
}

/* ---------- 5. similarity cross-check (the wrong-pair guard) ---------- */
function lev(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
        const cur = [i];
        for (let j = 1; j <= n; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        prev = cur;
    }
    return prev[n];
}
const sim = (a, b) => 1 - lev(a, b) / Math.max(a.length, b.length, 1);

let simChecked = 0, simSum = 0;
const lowPairs = [];
for (const vk of dsKeys) {
    const arr = verses[vk];
    for (const w of qcf.get(vk) || []) {
        if (w.sajda) continue;
        const form = arr[w.pos - 1];
        if (typeof form !== "string") continue;
        const qn = tasmeeNormQcf(w.text);
        const s = sim(form, qn);
        simChecked++; simSum += s;
        if (s < SIM_THRESHOLD && !SIM_WHITELIST.has(`${vk}:${w.pos}`)) {
            lowPairs.push({ vk, pos: w.pos, form, qn, s });
        }
    }
}
if (lowPairs.length) {
    fail(`${lowPairs.length} unexplained low-similarity pairs (<${SIM_THRESHOLD}):`);
    for (const p of lowPairs.slice(0, 25)) {
        console.error(`      ${p.vk}:${p.pos}  imlaei="${p.form}" qcf="${p.qn}" sim=${p.s.toFixed(2)}`);
    }
}

/* ---------- 6. spot checks (plan §5 GATE 1 list) ---------- */
const spot = (cond, label) => { if (!cond) fail(`spot: ${label}`); };
spot(verses["2:1"]?.length === 1 && verses["2:1"][0] === "الم", "2:1 muqattaat الم is one word");
spot(verses["19:1"]?.length === 1 && verses["19:1"][0] === "كهيعص", "19:1 كهيعص is one word");
spot(verses["2:3"]?.[4] === "الصلاه", "2:3 pos5 = الصلاة (folded)");
spot(verses["2:43"]?.includes("الزكاه"), "2:43 contains الزكاة (folded)");
spot(verses["2:85"]?.includes("الحياه"), "2:85 contains الحياة (folded)");
spot(verses["2:275"]?.includes("الربا"), "2:275 contains الربا");
spot((verses["2:218"] || []).some((w) => typeof w === "string" && w.startsWith("رحم")), "2:218 contains رحمت/رحمة form");
spot((verses["66:10"] || []).some((w) => typeof w === "string" && w.startsWith("امرا")), "66:10 contains امرأت form");
spot(verses["2:21"]?.[0] === "ياايها", "2:21 pos1 = يا+أيها fused");
spot(verses["3:66"]?.[0] === "هاانتم", "3:66 pos1 = ها+أنتم fused");
spot(verses["28:82"]?.includes("ويكان") && verses["28:82"]?.includes("ويكانه"),
    "28:82 contains ويكأن + ويكأنه (mid-ayah)");
{
    const a = verses["2:181"] || [];
    const i = a.indexOf("بعد");
    spot(i >= 0 && a[i + 1] === "ما", "2:181 بعدما split into بعد + ما");
}
spot(verses["7:206"]?.length === 12 && verses["7:206"][11] === null, "7:206 sajda pos12 is null");
spot(verses["1:1"]?.length === 4 && verses["1:1"][0] === "بسم", "1:1 basmala kept (it IS the ayah)");
spot(verses["9:1"]?.[0] === "براه" || verses["9:1"]?.[0] === "براءه", "9:1 has no basmala prefix");

/* ---------- 7. size ---------- */
const raw = fs.readFileSync(DATA_PATH);
const gzKb = zlib.gzipSync(raw).length / 1024;
if (gzKb > GZ_LIMIT_KB) fail(`gz size ${gzKb.toFixed(0)} KB > ${GZ_LIMIT_KB} KB`);

/* ---------- verdict ---------- */
console.log(`checked: ${dsKeys.length} verses, ${words} forms, ${sajdas} sajda slots; ` +
    `mean QCF↔Imlaei similarity ${(simSum / simChecked).toFixed(3)}; ` +
    `${(raw.length / 1024).toFixed(0)} KB raw / ${gzKb.toFixed(0)} KB gz`);
if (failures) { console.error(`\nAUDIT FAILED — ${failures} failure(s)`); process.exit(1); }
console.log("AUDIT PASSED — 6236/6236 ayahs aligned, all invariants hold");
