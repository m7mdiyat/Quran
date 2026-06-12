/* ============================================================
 * Gharib matching audit — verifies that src/gharib.js locates
 * every gharib entry inside its ayah across all 604 local QCF4
 * pages (public/data/qcf4/pages/*.json), including the ±1-ayah
 * fallback for the source's off-by-one ayah numbers.
 *
 *   node scripts/audit-gharib.mjs
 *
 * Expected: 6,106/6,107 located (99.98%). The single known miss
 * is a source-data error — بِرُوحِ الْقُدُسِ filed at 2:78 but the
 * phrase lives in 2:87 (9 ayahs away, beyond the fallback).
 * Run after ANY change to the normalization tiers in gharib.js.
 * ============================================================ */

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { locateInAyah } from "../src/gharib.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pagesDir = join(root, "public/data/qcf4/pages");

/* ayah "s:a" → ordered raw word texts (QCF4 word-type entries) */
const ayahWords = new Map();
for (const f of readdirSync(pagesDir).sort()) {
    if (!f.endsWith(".json")) continue;
    const page = JSON.parse(readFileSync(join(pagesDir, f), "utf8"));
    for (const line of page.lines) {
        for (const w of line.words) {
            if (!w.verse_key || w.type !== "word") continue;
            let list = ayahWords.get(w.verse_key);
            if (!list) ayahWords.set(w.verse_key, (list = []));
            list.push({ pos: w.position || 0, text: w.text || "" });
        }
    }
}
for (const list of ayahWords.values()) list.sort((a, b) => a.pos - b.pos);
const textsFor = (s, a) => (ayahWords.get(`${s}:${a}`) || []).map((w) => w.text);

const gharib = JSON.parse(readFileSync(join(root, "public/gharib.json"), "utf8"));

let t1 = 0, t2 = 0, t3 = 0, neighbor = 0;
const misses = [];
for (const e of gharib) {
    let hit = null, where = null;
    for (const a of [e.a, e.a + 1, e.a - 1]) {
        const texts = textsFor(e.s, a);
        if (!texts.length) continue;
        hit = locateInAyah(texts, e.w);
        if (hit) { where = a; break; }
    }
    if (!hit) { misses.push(`${e.s}:${e.a} | ${e.w}`); continue; }
    if (where !== e.a) neighbor++;
    if (hit.tier === 1) t1++; else if (hit.tier === 2) t2++; else t3++;
}

const total = gharib.length, matched = t1 + t2 + t3;
console.log(`total ${total} | tier1 ${t1} | tier2 ${t2} | tier3 ${t3}`);
console.log(`matched ${matched} (${((matched / total) * 100).toFixed(2)}%) | neighbor-ayah ${neighbor} | missed ${misses.length}`);
for (const m of misses) console.log("  MISS", m);
process.exit(misses.length > 1 ? 1 : 0); // 1 known source-data miss allowed
