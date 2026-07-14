/* ============================================================
 * build-tasmee-words.mjs — GATE 1 of TASMEE-PLAN.md (§2.6).
 *
 * Builds public/tasmee-words.json: for every ayah, the ASR-facing
 * normalized match form of each word, index-aligned to the QCF4
 * page data's 1-based `position` field (the same field the Mushaf
 * renders from), so the runtime can pair a page word span with its
 * match form by (verse_key, position) alone — page-split-safe.
 *
 *   verses["7:206"] = ["ان","الذين", … , null]   // pos 12 = sajda ۩
 *
 * Sources (both already shipped in public/):
 *   - public/quran.json            Imlaei-leaning text (alquran.cloud
 *     format; BOM-prefixed; basmala embedded in every surah's first
 *     ayah; standalone waqf-mark tokens)
 *   - public/data/qcf4/pages/*.json  word truth: verse_key + position
 *     (type "word"; sajda marks are words with text "#NNNN")
 *
 * Word-segmentation bridge (Imlaei splits ≠ QCF fusions), measured
 * in the Gate 0 audit: strip mark-only tokens, strip the embedded
 * basmala, fuse vocative يا/ويا with the next word, fuse ها+أنتم,
 * plus the explicit EXCEPTIONS table below. The build FAILS (exit 1)
 * unless all 6,236 ayahs align exactly — never ship a guessed
 * alignment. scripts/audit-tasmee-words.mjs then re-verifies the
 * artifact independently (run it after every build).
 *
 * Run:  node scripts/build-tasmee-words.mjs
 * ============================================================ */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { tasmeeNorm } from "../src/tasmee-norm.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGES_DIR = path.join(ROOT, "public", "data", "qcf4", "pages");
const QURAN_PATH = path.join(ROOT, "public", "quran.json");
const OUT_PATH = path.join(ROOT, "public", "tasmee-words.json");

/* Normalized basmala prefix embedded in ayah 1 of every surah
 * except 1 (where it IS the ayah) and 9 (no basmala). */
const BASMALA = ["بسم", "الله", "الرحمن", "الرحيم"];

/* ------------------------------------------------------------
 * EXCEPTIONS — per-ayah token surgery applied AFTER the generic
 * rules, keyed by verse_key. Ops act on the NORMALIZED Imlaei
 * token array; `tok` values are normalized forms. Every entry
 * exists because the generic rules provably leave that ayah
 * misaligned (the build prints a residual report when they do).
 * Keep this table small and commented — it is Gate 1 acceptance
 * material (≤ ~40 entries).
 *   { op:"split", tok, into:[..] }  one Imlaei token ↔ N QCF words
 *   { op:"merge", first, second }   two Imlaei tokens ↔ 1 QCF word
 * ------------------------------------------------------------ */
const EXCEPTIONS = {
    // Imlaei writes بعدما as ONE word; QCF/Uthmani splits بَعْدَ مَا.
    "2:181": [{ op: "split", tok: "بعدما", into: ["بعد", "ما"] }],
    "8:6": [{ op: "split", tok: "بعدما", into: ["بعد", "ما"] }],
    "13:37": [{ op: "split", tok: "بعدما", into: ["بعد", "ما"] }],
    // QCF fuses يَبْنَؤُمَّ (يا ابنَ أمّ) into ONE word; the generic يا rule
    // already fused يا+ابن, so fold أم in too. (Known extreme
    // orthographic divergence — whitelisted in the audit's
    // similarity cross-check.)
    "20:94": [{ op: "merge", first: "ياابن", second: "ام" }],
    // QCF fuses وَأَلَّوِ (وأن لو) into ONE word.
    "72:16": [{ op: "merge", first: "وان", second: "لو" }],
};

/* ---------- QCF side: vk → [{pos, text, sajda}] ---------- */
function loadQcfWords() {
    const byVk = new Map();
    for (const f of fs.readdirSync(PAGES_DIR).sort()) {
        if (!f.endsWith(".json")) continue;
        const d = JSON.parse(fs.readFileSync(path.join(PAGES_DIR, f), "utf8"));
        for (const line of d.lines || []) {
            for (const w of line.words || []) {
                if (w.type !== "word") continue; // end/quarter/bismillah/header excluded
                const vk = w.verse_key;
                let list = byVk.get(vk);
                if (!list) byVk.set(vk, (list = []));
                list.push({
                    pos: w.position,
                    text: w.text || "",
                    sajda: String(w.text || "").startsWith("#"),
                });
            }
        }
    }
    for (const list of byVk.values()) list.sort((a, b) => a.pos - b.pos);
    return byVk;
}

/* ---------- Imlaei side: vk → normalized token array ---------- */
function imlaeiTokens(surahNo, ayahNo, rawText, problems) {
    // Normalize per raw token; mark-only tokens (ۖ ۗ ۛ ۩ …) collapse
    // to "" and drop out here.
    let toks = String(rawText).split(/\s+/).map(tasmeeNorm).filter(Boolean);

    // Embedded basmala on every surah's first ayah (except 1 & 9).
    if (ayahNo === 1 && surahNo !== 1 && surahNo !== 9) {
        const ok = toks.length >= 4 && BASMALA.every((b, i) => toks[i] === b);
        if (!ok) { problems.push(`${surahNo}:1 basmala prefix missing/odd`); }
        else toks = toks.slice(4);
    }

    // Vocative fusions: Uthmani/QCF writes يا+X and ويا+X as ONE word.
    // Same for ها+أنتم (هأنتم). Generic — the count audit + similarity
    // cross-check police any over-eager fusion.
    const fused = [];
    for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        if ((t === "يا" || t === "ويا") && i + 1 < toks.length) {
            fused.push(t + toks[i + 1]); i++; continue;
        }
        if (t === "ها" && toks[i + 1] === "انتم") {
            fused.push(t + toks[i + 1]); i++; continue;
        }
        fused.push(t);
    }
    return fused;
}

function applyExceptions(vk, toks) {
    const ops = EXCEPTIONS[vk];
    if (!ops) return toks;
    let out = toks.slice();
    for (const e of ops) {
        if (e.op === "split") {
            const i = out.indexOf(e.tok);
            if (i < 0) throw new Error(`${vk}: split tok not found: ${e.tok}`);
            out.splice(i, 1, ...e.into);
        } else if (e.op === "merge") {
            const i = out.findIndex((t, j) => t === e.first && out[j + 1] === e.second);
            if (i < 0) throw new Error(`${vk}: merge pair not found: ${e.first}+${e.second}`);
            out.splice(i, 2, e.first + e.second);
        } else {
            throw new Error(`${vk}: unknown op ${e.op}`);
        }
    }
    return out;
}

/* ---------- main ---------- */
const qcf = loadQcfWords();
const quran = JSON.parse(
    fs.readFileSync(QURAN_PATH, "utf8").replace(/^﻿/, "")
);

const verses = {};
const residuals = [];
const problems = [];
let words = 0, sajdas = 0;

for (const s of quran.data.surahs) {
    for (const a of s.ayahs) {
        const vk = `${s.number}:${a.numberInSurah}`;
        const qcfWords = qcf.get(vk);
        if (!qcfWords) { problems.push(`${vk}: missing from QCF4 pages`); continue; }

        let toks = imlaeiTokens(s.number, a.numberInSurah, a.text, problems);
        toks = applyExceptions(vk, toks);

        const recited = qcfWords.filter((w) => !w.sajda);
        if (recited.length !== toks.length) {
            residuals.push({ vk, qcf: qcfWords.map((w) => w.text), toks });
            continue;
        }

        // Emit: 1-based QCF position → slot; sajda positions → null.
        const maxPos = qcfWords[qcfWords.length - 1].pos;
        const arr = new Array(maxPos).fill(null);
        let ti = 0;
        for (const w of qcfWords) {
            if (w.sajda) { sajdas++; continue; }
            arr[w.pos - 1] = toks[ti++];
            words++;
        }
        // A null in a non-sajda slot would mean non-contiguous word
        // positions — the audit asserts this never happens.
        verses[vk] = arr;
    }
}

/* ---------- report ---------- */
if (problems.length) {
    console.error(`PROBLEMS (${problems.length}):`);
    for (const p of problems) console.error("  " + p);
}
if (residuals.length) {
    console.error(`\nRESIDUAL MISALIGNMENTS (${residuals.length}) — extend rules/EXCEPTIONS:`);
    for (const r of residuals.slice(0, 40)) {
        console.error(`  ${r.vk}  qcf=${r.qcf.length} imlaei=${r.toks.length}`);
        console.error(`    qcf : ${r.qcf.join(" ")}`);
        console.error(`    toks: ${r.toks.join(" ")}`);
    }
    process.exit(1);
}
if (problems.length) process.exit(1);

const out = {
    version: 1,
    counts: { verses: Object.keys(verses).length, words, sajdas },
    verses,
};
const json = JSON.stringify(out);
fs.writeFileSync(OUT_PATH, json);
const gz = zlib.gzipSync(json).length;
console.log(`tasmee-words.json written: ${Object.keys(verses).length} verses, ` +
    `${words} word forms, ${sajdas} sajda slots, ` +
    `${(json.length / 1024).toFixed(0)} KB raw / ${(gz / 1024).toFixed(0)} KB gz`);
