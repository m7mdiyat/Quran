/* ============================================================
 * غريب القرآن — glowing word discovery + illumination counter
 *
 * Mushaf-mode learning feature: rare/difficult Quranic words
 * (غريب القرآن, ~6,100 entries from a classical gharib source)
 * glow gold on the rendered page; tapping one pops a compact
 * meaning tooltip out of the word, marks it learned (persisted),
 * and recolours the breathing glow to white everywhere that word
 * appears (so a learned word still beams, just no longer gold). A lantern (فانوس) widget in the Mushaf toolbar counts
 * all-time learned words and renders a per-page segmented
 * progress ring (one segment per gharib WORD on the page).
 *
 * Data: /gharib.json — minified [{s, a, w, m}] (surah, ayah,
 * vocalized imla'i word/phrase, meaning). The source book's
 * "page" field was dropped at copy time (it refers to the
 * printed book, not the mushaf). Loaded lazily on the first
 * Mushaf page render, indexed { "s:a" → [entries] }.
 *
 * Matching: QCF4 page data carries per-word vocalized imla'i
 * `text` (same spelling family as the gharib source), so each
 * entry is located inside its ayah by normalized word-span
 * search over the page data words — never against the QCF4
 * glyphs themselves. Three normalization tiers (strict → hamza
 * -seat folding → consonant skeleton) measured at 6,106/6,107
 * entries located across all 604 pages; the one remainder is a
 * source-data error (entry filed 9 ayahs away). Wrong-by-one
 * ayah numbers in the source (16 entries) are recovered by a
 * ±1-ayah fallback (the tooltip shows the found occurrence's
 * own meaning either way).
 *
 * DOM approach: no wrapper elements — matched words' existing
 * .mushaf-word spans (display:inline-block) are tagged with
 * .gharib-word + data-gh="<key>" (Arabic shaping and the exact
 * printed line layout stay untouched). The glow is EDGELESS and
 * attached to the letterforms themselves: each tagged span gets
 * data-ghc = its own glyph, and two pseudo-elements re-render
 * that glyph stacked on the word — a transparent-text layer
 * whose layered gold text-shadow is the halo (follows the glyph
 * contours, fades into nothing — no box/pill/outline of any
 * kind), plus a background-clip:text gold sheen ON the ink.
 * Both animate opacity only, with no per-word delay: every
 * gharib word on the page breathes and holds in the same phase.
 * Em-based sizing means zoom/autoFit need no re-measure. The
 * whole feature is toggleable from the lantern button: a
 * registered --gh-on custom property (transitioned) fades every
 * glow out/in smoothly; the off state persists in the store.
 *
 * Wiring: initGharib(deps) from app.js init(); mushaf.js calls
 * gharibTapTarget(el) from its click/touchend handlers (so the
 * long-press timer bookkeeping stays intact) and includes the
 * page data in its mushaf:page-rendered event detail.
 * ============================================================ */

"use strict";

import { prefersReducedMotion } from "./transitions.js";

/* ── Dev flag (Vite in the browser; harmless under Node audit) ── */
const DEV = (() => {
    try { return !!import.meta.env?.DEV; } catch { return false; }
})();

/* ============================================================
 * Normalization — three tiers, tuned against all 604 QCF4
 * pages (see scripts/audit-gharib.mjs). Tier rules are LOAD-
 * BEARING: the learned-words store keys off gharibNorm1 of the
 * gharib phrase, so changing tier-1 folds invalidates saved
 * progress. Extend tier 2/3 instead.
 *
 * All combining marks / invisibles are written as \u escapes
 * on purpose — editors and formatters mangle them as literals.
 * ============================================================ */

/* Quranic annotation marks (U+0610–061A, U+06D6–06ED, Arabic
 * Extended-A small marks U+08D3–08FF), tashkeel + superscript
 * alef (U+064B–0670), tatweel, zero-width/format chars, BOM. */
const MARKS_RE = /[\u0610-\u061A\u064B-\u0670\u06D6-\u06ED\u08D3-\u08FF\u0640\u200B-\u200F\uFEFF]/g;
const ENTITY_RE = /&#(\d+);/g;

/* Decode the QCF4 data's literal "&#NNNN;" HTML entities (it
 * encodes some combining marks that way, e.g. hamza-below in
 * تِلْقَاي&#1621;ِ), then fold combining-hamza seat pairs (letter +
 * U+0654/U+0655) into their precomposed seat letters so the
 * seat information survives the marks strip. */
function preClean(s) {
    let t = String(s).replace(ENTITY_RE, (_, d) => {
        const n = Number(d);
        return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    });
    return t
        .replace(/\u064A\u0655/g, "\u0626")  // ي + hamza below → ئ
        .replace(/\u064A\u0654/g, "\u0626")  // ي + hamza above → ئ
        .replace(/\u0627\u0655/g, "\u0625")  // ا + hamza below → إ
        .replace(/\u0627\u0654/g, "\u0623")  // ا + hamza above → أ
        .replace(/\u0648\u0654/g, "\u0624"); // و + hamza above → ؤ
}

/* Tier 1 — strict: strip marks, fold alef/hamza-seat/ya/ta
 * variants. ءا→ا covers the page's spelling of madda (ءَايَة vs
 * آيَة); ى→ا because alef maqsura is /ā/ in BOTH spellings here
 * (page: اشْتَرَىهُ، تُقَىة; gharib: مُوسَى). THE STORE-KEY TIER. */
export function gharibNorm1(s) {
    return preClean(s)
        .replace(MARKS_RE, "")
        .replace(/[ٱأإآ]/g, "ا") // ٱ أ إ آ → ا
        .replace(/ءا/g, "ا")               // ءا → ا
        .replace(/ى/g, "ا")                     // ى → ا
        .replace(/ؤ/g, "و")                     // ؤ → و
        .replace(/ئ/g, "ي")                     // ئ → ي
        .replace(/ة/g, "ه")                     // ة → ه
        .trim();
}

/* Tier 2 — hamza seats dropped + orthographic waw/alef folds
 * (بَاؤُوا↔بَاءُو، الصَّلَاة↔الصَّلَواة، سُنَّة↔سُنَّت، بَسْطَة↔بَصْطَة). Only
 * consulted when tier 1 finds no span, scoped to one ayah, and
 * still requires the full consecutive phrase — false-positive
 * risk is negligible (spot-checked in the audit). NOTE: the
 * final-ت→ه fold runs AFTER the alef drops on purpose — a ت
 * exposed by them must still fold (تَفْتَأُ↔تَفْتَؤُاْ both → تفه). */
function gharibNorm2(s) {
    return preClean(s)
        .replace(MARKS_RE, "")
        .replace(/[ٱآ]/g, "ا")             // ٱ آ → ا
        .replace(/[ءأإؤئ]/g, "") // drop hamza forms/seats
        .replace(/ى/g, "ا")                     // ى → ا
        .replace(/ة/g, "ه")                     // ة → ه
        .replace(/وا$/, "و")               // otiose final alef after waw
        .replace(/وا/g, "ا")               // mid-word صلواة-style waw
        .replace(/ا/g, "")                           // consonant skeleton (no alef)
        .replace(/ت$/, "ه")                     // feminine ta maftuha (سنت)
        .replace(/ص/g, "س")                     // ص → س (بصۜطة spelling)
        .replace(/(.)\1+/g, "$1")
        .trim();
}

/* Tier 3 — last resort: tier 2 minus ya/waw (rasm skeleton),
 * with EVERY ت folded to ه (a ت can sit pre- or post-drop final
 * depending on the side: ذَوَاتَى → ذه needs page ذتي → ذه too).
 * Handles seat-letter spellings like وَمَلَإِيْهِ↔وَمَلَئِهِ. */
function gharibNorm3(s) {
    return gharibNorm2(s)
        .replace(/[يو]/g, "")
        .replace(/ت/g, "ه")
        .replace(/(.)\1+/g, "$1");
}

/* ============================================================
 * Span matching over one ayah's word-text array
 * ============================================================ */

function findSpan(list, words) {
    const n = words.length;
    if (!n) return -1;
    outer: for (let i = 0; i <= list.length - n; i++) {
        for (let j = 0; j < n; j++) {
            if (list[i + j] !== words[j]) continue outer;
        }
        return i;
    }
    return -1;
}

/* Span match where ONE PAGE WORD may equal the join of 2–3
 * gharib words (fused vocatives: يَاوَيْلَتَى، يَأُوْلِي). Returns
 * {start, len} in page-word indices, or null. */
function findMerged(list, words) {
    for (let i = 0; i < list.length; i++) {
        let j = i, k = 0;
        while (k < words.length && j < list.length) {
            if (list[j] === words[k]) { j++; k++; continue; }
            if (k + 1 < words.length && list[j] === words[k] + words[k + 1]) { j++; k += 2; continue; }
            if (k + 2 < words.length && list[j] === words[k] + words[k + 1] + words[k + 2]) { j++; k += 3; continue; }
            break;
        }
        if (k === words.length) return { start: i, len: j - i };
    }
    return null;
}

const splitWords = (phrase) =>
    String(phrase).replace(/\.{2,}|…/g, " ").split(/\s+/).filter(Boolean);

/* Locate a gharib phrase inside one ayah's raw word texts.
 * Returns { start, len, tier } (page-word indices) or null.
 * Exported for the Node audit harness. */
export function locateInAyah(rawWordTexts, phrase) {
    const raw = splitWords(phrase);
    if (!raw.length) return null;
    const tiers = [[1, gharibNorm1], [2, gharibNorm2], [3, gharibNorm3]];
    for (const [tier, normFn] of tiers) {
        const list = rawWordTexts.map(normFn);
        const words = raw.map(normFn).filter(Boolean);
        if (!words.length) continue;
        const i = findSpan(list, words);
        if (i >= 0) return { start: i, len: words.length, tier };
        const m = findMerged(list, words);
        if (m) return { start: m.start, len: m.len, tier };
    }
    return null;
}

/* ============================================================
 * Data — lazy load + index
 * ============================================================ */

let _index = null;         // Map "s:a" → [entry]
let _dataPromise = null;

function indexData(arr) {
    const idx = new Map();
    for (const e of arr) {
        const key = `${e.s}:${e.a}`;
        let list = idx.get(key);
        if (!list) idx.set(key, (list = []));
        list.push(e);
    }
    return idx;
}

function loadData() {
    if (_dataPromise) return _dataPromise;
    _dataPromise = fetch("/gharib.json")
        .then((res) => {
            if (!res.ok) throw new Error(`gharib.json ${res.status}`);
            return res.json();
        })
        .then((arr) => {
            _index = indexData(arr);
            return _index;
        })
        .catch((e) => {
            _dataPromise = null; // allow retry on next page render
            if (DEV) console.warn("[gharib] data load failed:", e);
            return null;
        });
    return _dataPromise;
}

function entriesFor(s, a) {
    return _index?.get(`${s}:${a}`) || [];
}

/* Ensure the gharib dataset is loaded (resolves to the index Map, or
 * null on failure). The saved-words panel awaits this before reverse-
 * mapping learned keys back to their word/meaning. */
export function ensureGharibData() {
    return loadData();
}

/* ============================================================
 * Dev audit — entries that could not be located are collected
 * and reported once per page-render burst as a console.table.
 * Production: silent skip, never throws.
 * ============================================================ */

const _auditMisses = [];
let _auditTimer = 0;

function auditMiss(s, a, entry) {
    if (!DEV) return;
    _auditMisses.push({ surah: s, ayah: a, word: entry.w });
    clearTimeout(_auditTimer);
    _auditTimer = setTimeout(() => {
        if (_auditMisses.length) {
            console.groupCollapsed(`[gharib] ${_auditMisses.length} unlocatable entr${_auditMisses.length === 1 ? "y" : "ies"} (skipped)`);
            console.table(_auditMisses);
            console.groupEnd();
        }
    }, 1500);
}

/* ============================================================
 * Learned-words store — same mechanism as تدبّريات (notes.js):
 * plain localStorage, which Capacitor persists across app
 * restarts on iOS/Android. Forward-safe schema (the `off` flag
 * was added later — version stays 1 since it's additive; old
 * stores without it read as feature ON):
 *   m7_gharib = { "version": 1, "off": false, "words": [...] }
 * Everything else (counter total, ring segments) is DERIVED —
 * no duplicated counters that can drift. Toggling off never
 * touches `words`.
 * ============================================================ */

const STORE_KEY = "m7_gharib";
let _learned = null;     // Set<string>, lazy
let _featureOff = false; // lantern toggle; hydrated with the set

function learnedSet() {
    if (_learned) return _learned;
    let set = new Set();
    try {
        const raw = localStorage.getItem(STORE_KEY);
        if (raw) {
            const obj = JSON.parse(raw);
            if (obj && obj.version === 1 && Array.isArray(obj.words)) {
                set = new Set(obj.words.filter((w) => typeof w === "string"));
                _featureOff = obj.off === true;
            }
        }
    } catch { }
    _learned = set;
    return set;
}

function saveStore() {
    try {
        localStorage.setItem(STORE_KEY,
            JSON.stringify({ version: 1, off: _featureOff, words: [...learnedSet()] }));
    } catch { }
}

/* The stable identity of a gharib word/phrase — tier-1 norm of
 * its words joined by single spaces. Learned-state keys off
 * this, so one tap settles EVERY occurrence across the Quran. */
function keyForPhrase(phrase) {
    return splitWords(phrase).map(gharibNorm1).filter(Boolean).join(" ");
}

/* Mark a key learned. Returns true only on the FIRST time. */
function learn(key) {
    const set = learnedSet();
    if (set.has(key)) return false;
    set.add(key);
    saveStore();
    if (_onLearnHook) { try { _onLearnHook(key); } catch { } }
    return true;
}

export function gharibLearnedCount() {
    return learnedSet().size;
}

/* key → representative { w, m, s, a }, built once over the whole
 * dataset (earliest mushaf occurrence wins). The learned store keeps
 * only normalized keys; this is how the saved-words panel recovers
 * each word's vocalized text + meaning + a place to jump to. */
let _repByKey = null;
function repByKey() {
    if (_repByKey) return _repByKey;
    if (!_index) return new Map(); // not loaded — caller ensureGharibData() first
    const all = [];
    for (const list of _index.values()) for (const e of list) all.push(e);
    all.sort((x, y) => (x.s - y.s) || (x.a - y.a));
    const rep = new Map();
    for (const e of all) {
        const key = keyForPhrase(e.w);
        if (key && !rep.has(key)) rep.set(key, { w: e.w, m: e.m, s: e.s, a: e.a });
    }
    _repByKey = rep;
    return rep;
}

/* Every learned word as { key, w, m, s, a }, newest-first (reverse
 * learning order — the Set preserves insertion order across saves).
 * Needs ensureGharibData() resolved for w/m/s/a; a key with no dataset
 * match (≈impossible once loaded) degrades to the bare key so nothing
 * the user revealed silently disappears from their collection. */
export function gharibSavedWords() {
    const keys = [...learnedSet()];
    if (!keys.length) return [];
    const rep = repByKey();
    const out = [];
    for (let i = keys.length - 1; i >= 0; i--) {
        const k = keys[i];
        const r = rep.get(k);
        out.push(r ? { key: k, ...r } : { key: k, w: k, m: "", s: 0, a: 0 });
    }
    return out;
}

/* ============================================================
 * Page decoration — tags matched words' existing .mushaf-word
 * spans (never wraps: Arabic shaping + exact line layout stay
 * untouched). Runs per rendered page only.
 * ============================================================ */

let _onDecorateHook = null; // widget: ring rebuild (stage 5)
let _onLearnHook = null;    // widget: counter pop (stage 4)

/* "<key>@<vk>" → { w, m, s, a } — the tapped occurrence's own
 * entry, so the same word in two ayahs keeps its own meaning. */
const ENTRY_BY_REF = new Map();

/* Current page's gharib map for the ring: [{ vk, keys: [..] }]
 * in page (ayah) order. Rebuilt on every decoration. */
let PAGE_GHARIB = { page: 0, ayahs: [] };

function decoratePage(pageEl, pageData) {
    if (!pageEl || !pageData) return;
    closeTip(); // page navigation dismisses an open tooltip
    if (!_index) {
        loadData().then((idx) => {
            if (idx && pageEl.isConnected) decoratePage(pageEl, pageData);
        });
        return;
    }

    // Page-local word texts per verse key (insertion order = page order).
    // Each word carries its own DOM span index (`dom`): mushaf.js renders
    // EVERY vk-carrying entry as a .mushaf-word span inside the ayah
    // container — including the 199 quarter (۞) markers, which only exist
    // in the page data, not in this word list. Assuming word-index ==
    // span-index shifted every highlight in a ۞-carrying ayah onto the
    // WRONG word (e.g. 4:12 وَلَدٌ lit لَّهُنَّ). Counting every non-"end"
    // vk entry per ayah mirrors spansFor() exactly, wherever the marker
    // sits. (bismillah/surah_header entries never carry a verse_key and
    // render outside .mushaf-ayah — they can't desync the count.)
    const byVk = new Map();      // vk → [{ pos, text, dom }]
    const domCount = new Map();  // vk → rendered .mushaf-word spans so far
    const completeVk = new Set();// ayah fully on this page (start + end marker)
    const hasStart = new Set();
    for (const line of pageData.lines || []) {
        for (const w of line.words || []) {
            if (!w.verse_key) continue;
            if (w.type === "end") {
                if (hasStart.has(w.verse_key)) completeVk.add(w.verse_key);
                continue;
            }
            const dom = domCount.get(w.verse_key) || 0;
            domCount.set(w.verse_key, dom + 1);
            if (w.type !== "word") continue;
            let list = byVk.get(w.verse_key);
            if (!list) byVk.set(w.verse_key, (list = []));
            list.push({ pos: w.position || 0, text: w.text || "", dom });
            if ((w.position || 0) === 1) hasStart.add(w.verse_key);
        }
    }
    for (const list of byVk.values()) list.sort((a, b) => a.pos - b.pos);

    const spansFor = (vk) => pageEl.querySelectorAll(
        `.mushaf-ayah[data-verse-key="${CSS.escape(vk)}"] .mushaf-word:not(.mushaf-end)`
    );

    const pageAyahs = new Map(); // vk → Set<key>

    const tagEntry = (entry, vk) => {
        const words = byVk.get(vk);
        if (!words || !words.length) return false;
        const loc = locateInAyah(words.map((w) => w.text), entry.w);
        if (!loc) return false;
        const spans = spansFor(vk);
        if (!spans.length) return false;
        const end = Math.min(loc.start + loc.len, words.length);
        if (loc.start >= end) return false;

        const key = keyForPhrase(entry.w);
        if (!key) return false;
        // Overlap guard: a span already claimed by a DIFFERENT entry stays
        // with its first claimant; this entry is "located" either way (no
        // neighbor retry / no audit noise for overlapping phrase entries).
        for (let i = loc.start; i < end; i++) {
            const got = spans[words[i].dom]?.dataset.gh;
            if (got && got !== key) return true;
        }

        const [s, a] = vk.split(":").map(Number);
        ENTRY_BY_REF.set(`${key}@${vk}`, { w: entry.w, m: entry.m, s, a });
        const settled = learnedSet().has(key);
        for (let i = loc.start; i < end; i++) {
            const span = spans[words[i].dom];
            if (!span) continue;
            span.classList.add("gharib-word");
            if (settled) span.classList.add("gharib-word--settled");
            span.dataset.gh = key;
            span.dataset.ghRef = vk;
            // The glow pseudos re-render this exact glyph (content:
            // attr(data-ghc)) so the gold hugs the letterforms.
            span.dataset.ghc = span.textContent;
        }
        let keys = pageAyahs.get(vk);
        if (!keys) pageAyahs.set(vk, (keys = new Set()));
        keys.add(key);
        return true;
    };

    // Pass 1 — every entry against its own ayah.
    const pending = []; // [{ entry, homeVk }]
    for (const vk of byVk.keys()) {
        const [s, a] = vk.split(":").map(Number);
        for (const entry of entriesFor(s, a)) {
            if (!tagEntry(entry, vk)) pending.push({ entry, homeVk: vk });
        }
    }

    // Pass 2 — ±1-ayah fallback for the source's off-by-one entries,
    // only attempted (and only audit-logged) when the home ayah was
    // FULLY on this page (a split ayah legitimately lacks its words).
    for (const { entry, homeVk } of pending) {
        if (!completeVk.has(homeVk)) continue;
        const [s, a] = homeVk.split(":").map(Number);
        const found = [`${s}:${a + 1}`, `${s}:${a - 1}`]
            .some((nvk) => byVk.has(nvk) && tagEntry(entry, nvk));
        if (!found) auditMiss(s, a, entry);
    }

    // Ring source: page-ordered UNIQUE word keys (ayah tagging order =
    // page order; entry order inside an ayah follows the source). One
    // ring segment per word — every learned word advances the ring.
    const seenKeys = new Set();
    const orderedKeys = [];
    for (const keys of pageAyahs.values()) {
        for (const k of keys) {
            if (!seenKeys.has(k)) { seenKeys.add(k); orderedKeys.push(k); }
        }
    }
    PAGE_GHARIB = {
        page: pageData.page || 0,
        ayahs: [...pageAyahs.entries()].map(([vk, keys]) => ({ vk, keys: [...keys] })),
        keys: orderedKeys,
    };

    if (DEV) {
        // Expected-vs-rendered check. "json ayahs" counts ayahs on this
        // page whose OWN number carries gharib.json entries; "located
        // ayahs" is where words were FOUND (±1 fallback re-attributes a
        // handful); the ring renders ONE SEGMENT PER UNIQUE WORD.
        let jsonAyahs = 0;
        for (const vk of byVk.keys()) {
            const [s, a] = vk.split(":").map(Number);
            if (entriesFor(s, a).length) jsonAyahs++;
        }
        console.log(`[gharib] page ${PAGE_GHARIB.page}: json ayahs ${jsonAyahs} | located ayahs ${PAGE_GHARIB.ayahs.length} | ring segments (words) ${PAGE_GHARIB.keys.length}`);
    }

    // Park the tooltip in this root now (idempotent) so the first tap isn't the
    // first re-parent — its relayout settles before any tap.
    hostTipInRoot(pageEl.closest(".mushaf-root"));

    if (_onDecorateHook) { try { _onDecorateHook(PAGE_GHARIB); } catch { } }
}

/* Settle every occurrence of a key — pure CSS: --settling
 * transitions the ::before halo gold → white (and fades the
 * dark-theme molten ink off via --gw-x), so the beam keeps
 * breathing in white. Future pages render straight to --settled. */
function settleKey(key) {
    document.querySelectorAll(`.gharib-word[data-gh="${CSS.escape(key)}"]`)
        .forEach((el) => el.classList.add("gharib-word--settling"));
}

/* ============================================================
 * Feature toggle — the lantern button turns the whole gharib
 * layer on/off. The fade is a transitioned registered custom
 * property (--gh-on) that every glow opacity is multiplied by,
 * so the keyframes keep breathing while the light dims to
 * nothing — a true fade, both directions. After the fade-out
 * settles, body.gharib-off-done drops the glow pseudos
 * entirely (no invisible animations left running); turning
 * back on restores the layers first, then fades them in.
 * Learned totals are untouched by the toggle.
 * ============================================================ */

let _offDoneT = 0;

function applyGharibOff(off, fade) {
    const b = document.body;
    clearTimeout(_offDoneT);
    if (off) {
        b.classList.add("gharib-off");
        if (fade) {
            _offDoneT = setTimeout(() => b.classList.add("gharib-off-done"), 750);
        } else {
            b.classList.add("gharib-off-done");
        }
    } else {
        b.classList.remove("gharib-off-done");
        if (fade) {
            // Restore the glow layers this frame, fade them in the next —
            // the freshly re-created pseudos must commit at --gh-on:0
            // before the transition back to 1 starts.
            requestAnimationFrame(() => b.classList.remove("gharib-off"));
        } else {
            b.classList.remove("gharib-off");
        }
    }
}

function toggleGharibFeature() {
    _featureOff = !_featureOff;
    saveStore();
    if (_featureOff) closeTip();
    applyGharibOff(_featureOff, true);
    syncLanternState();
    hapticLight();
}

/* ============================================================
 * Meaning tooltip — a compact card that grows OUT of the tapped
 * word (transform-origin anchored at it). Meaning text only.
 * Above the word by default, flips below near the top, clamped
 * horizontally inside the page card. Dismissed by tapping
 * anywhere outside (that tap is CONSUMED — it never doubles as
 * an audio toggle), re-tapping the word, page nav, any scroll,
 * and Escape. Pop easing = the ported Transitions.dev spring
 * family (badge/digit cubic-bezier), CSS in public/mushaf.css.
 * ============================================================ */

let _tipEl = null;
let _tipOpenState = false;
let _tipKey = null;
let _tipSuppressUntil = 0; // the tap that dismissed the tip is consumed

const TIP_GAP = 9;     // px between the word box and the tip
const TIP_MARGIN = 10; // min inset from the page card edges

/* Display-only tashkeel reduction for the tooltip text (the
 * matching normalizers are untouched). Per request: drop the
 * harakat/sukun/dagger-alef/Quranic marks, KEEP the shadda with
 * its own linked haraka (the mark riding above/below it on the
 * same letter), and KEEP tanween. Combining hamza marks stay —
 * they are letter identity, not tashkeel.
 * Marks are written as \u escapes on purpose (editors mangle
 * combining chars as literals). */
const TIP_MARK_RE = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u08D3-\u08FF]/;

function tipDisplayText(s) {
    const out = [];
    let marks = []; // combining marks following the current base letter
    const flush = () => {
        if (!marks.length) return;
        const hasShadda = marks.includes("\u0651");
        for (const m of marks) {
            const c = m.codePointAt(0);
            if (c === 0x0651                               // shadda
                || c === 0x064B || c === 0x064C || c === 0x064D // tanween
                || c === 0x0654 || c === 0x0655) {         // hamza above/below
                out.push(m);
            } else if (hasShadda && (c === 0x064E || c === 0x064F || c === 0x0650)) {
                out.push(m);                               // shadda's own haraka
            } // everything else: dropped
        }
        marks = [];
    };
    for (const ch of String(s)) {
        if (TIP_MARK_RE.test(ch)) marks.push(ch);
        else { flush(); out.push(ch); }
    }
    flush();
    return out.join("");
}

/* The same tashkeel-reduced readability treatment the meaning tooltip
 * uses — exported for the saved-words panel so its meanings read
 * identically to the in-mushaf tip. */
export function gharibTipText(s) {
    return tipDisplayText(s);
}

function ensureTip() {
    if (_tipEl) return _tipEl;
    const el = document.createElement("div");
    el.className = "gharib-tip";
    el.setAttribute("role", "tooltip");
    el.setAttribute("dir", "rtl");
    el.setAttribute("aria-hidden", "true");
    document.body.appendChild(el);
    // Capture phase + stopPropagation: with the tip open, Escape must
    // close ONLY the tip — never also exit Mushaf fullscreen (whose own
    // document-level Escape handler runs in the bubble phase).
    document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape" || !_tipOpenState) return;
        e.stopPropagation();
        closeTip();
    }, true);
    _tipEl = el;
    return el;
}

/* Park the meaning tooltip INSIDE the given Mushaf root as an absolutely-
 * positioned child (idempotent). Called eagerly on each page render so the
 * FIRST tap isn't also the first re-parent: the re-parent's relayout settles
 * well before any tap, so the first placement reads stable geometry exactly
 * like every later one (kills the "first tap lands off, second is fine" bug). */
function hostTipInRoot(root) {
    if (!root) return;
    const tip = ensureTip();
    if (tip.parentElement !== root) root.appendChild(tip);
    tip.classList.add("gharib-tip--anchored");
}

function openTipFor(span, point) {
    const key = span.dataset.gh, vk = span.dataset.ghRef;
    const entry = ENTRY_BY_REF.get(`${key}@${vk}`);
    if (!entry) return;
    const tip = ensureTip();

    // Host the tip INSIDE the Mushaf root (a positioned ancestor the word
    // shares) as an absolutely-positioned child — NOT a position:fixed child of
    // <body>. On iOS WKWebView a fixed element on a scrolled document anchors
    // to the document at an unstable offset, so the card sometimes opened in
    // the wrong place until you tapped again / restarted. Living in the same
    // scroll/coordinate frame as the word, it's glued to it on every tap — the
    // first one included. Fixed-on-body fallback only if opened outside a root.
    const root = span.closest(".mushaf-root");
    if (root) {
        if (tip.parentElement !== root) root.appendChild(tip);
        tip.classList.add("gharib-tip--anchored");
    } else if (tip.parentElement !== document.body) {
        document.body.appendChild(tip);
        tip.classList.remove("gharib-tip--anchored");
    }

    // First-ever tap: persist + settle + counter/ring — immediately, as
    // one visible choreography (the tip hides nothing). Re-taps and
    // settled words just show the meaning; nothing increments.
    if (learn(key)) settleKey(key);

    // Re-pop when switching words: the pointerdown that dismissed the
    // previous word's tip started the close transition only a moment
    // ago — the tip is still at ~full scale, so a plain remove/add
    // here would "animate" 1 → 1 (an instant teleport). Snap to the
    // fully-closed state (scale .55, opacity 0) with transitions off
    // for one frame, so the pop always grows out of the NEW word.
    tip.style.transition = "none";
    tip.classList.remove("is-open");
    tip.textContent = tipDisplayText(entry.m);

    // Placement is a closure so it can run twice: once now, then again on the
    // next frame. The very first open in a session can read stale root scroll/
    // layout (the tip was just parented into the root), landing the card a line
    // off until the next tap — the rAF re-read below corrects it while the open
    // animation is still scaling in, so the nudge is invisible; an already-
    // correct placement re-applies identical values (a no-op).
    const place = () => {
    // Anchor to the WORD ITSELF (its getBoundingClientRect), never the tap
    // point — so the card lands in the same place wherever on the glyph you
    // press. Everything here is computed in VIEWPORT coords, then converted to
    // the host root's space at the end. A .mushaf-word's box is the full QCF4
    // LINE box (line-height 1.85 — far taller than the visible glyph, which
    // sits centred within it), so anchoring to box.top floats the card well
    // above the ink. Model the visible ink as a band around the box's vertical
    // centre, sized from the font em (≈ glyph height) so it needs no re-measure
    // on zoom. Horizontal centre + page clamp come from the box (WIDTH is
    // accurate). `point` is unused (kept for call-site compatibility).
    // A gharib occurrence can be a multi-word PHRASE — several .mushaf-word
    // spans the glow renders as one glowing unit. Anchor to the UNION box of
    // every span of THIS occurrence (same key + verse-ref) on the tapped span's
    // visual line, not the tapped span alone — so the card sits centred above
    // the whole word/phrase identically no matter which part you press. (A
    // phrase that wraps a line break anchors above the chunk you tapped.)
    const tappedRect = span.getBoundingClientRect();
    let uL = tappedRect.left, uR = tappedRect.right, uT = tappedRect.top, uB = tappedRect.bottom;
    const ayahEl = span.closest(".mushaf-ayah");
    if (ayahEl && key && vk) {
        ayahEl.querySelectorAll(
            `.gharib-word[data-gh="${CSS.escape(key)}"][data-gh-ref="${CSS.escape(vk)}"]`
        ).forEach((el) => {
            const r = el.getBoundingClientRect();
            if (Math.abs(r.top - tappedRect.top) > tappedRect.height * 0.5) return; // other line
            uL = Math.min(uL, r.left); uR = Math.max(uR, r.right);
            uT = Math.min(uT, r.top); uB = Math.max(uB, r.bottom);
        });
    }
    const box = { left: uL, right: uR, top: uT, bottom: uB, width: uR - uL, height: uB - uT };
    const pageEl = span.closest(".mushaf-page");
    const pr = pageEl?.getBoundingClientRect()
        || { left: 0, right: window.innerWidth };
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    const cx = box.left + box.width / 2;
    const minL = Math.max(pr.left + TIP_MARGIN, 8);
    const maxL = Math.min(pr.right - TIP_MARGIN, window.innerWidth - 8) - tw;
    const left = Math.min(Math.max(cx - tw / 2, minL), Math.max(maxL, minL));
    // Never tuck under the app's status bar / notch.
    const safeTop = 10 + (parseFloat(getComputedStyle(document.documentElement)
        .getPropertyValue("--m7-statusbar-height")) || 0);
    // Visible-ink band: box centre ± ~half the glyph height (from the em, so
    // it scales with zoom), clamped to never exceed the line box.
    const cy = box.top + box.height / 2;
    const em = parseFloat(getComputedStyle(span).fontSize) || (box.height / 1.85);
    const halfInk = Math.min(em * 0.62, box.height / 2);
    const inkTop = cy - halfInk, inkBottom = cy + halfInk;
    // Above the word by default; flip below ONLY when there's no room above.
    const above = inkTop - th - TIP_GAP >= safeTop;
    let top = above ? inkTop - th - TIP_GAP : inkBottom + TIP_GAP;
    top = Math.min(Math.max(top, safeTop), window.innerHeight - th - 10);
    // Convert the viewport coords into the host root's content space (offset by
    // the root's box position and its own scroll). For the fixed-on-body
    // fallback, origin stays 0 → plain viewport coords. Anchoring in the SAME
    // space as the word means there is no drift to chase: the tip lands on the
    // word the first time and every time.
    let originX = 0, originY = 0;
    if (root) {
        const rRect = root.getBoundingClientRect();
        // An absolute child is laid out from the parent's PADDING box, so add
        // the border widths (clientLeft/Top) and subtract scroll — the exact
        // frame the tip lives in. (.mushaf-root carries .glass's border.)
        originX = rRect.left + root.clientLeft - root.scrollLeft;
        originY = rRect.top + root.clientTop - root.scrollTop;
    }
    tip.style.left = `${(left - originX).toFixed(1)}px`;
    tip.style.top = `${(top - originY).toFixed(1)}px`;
    tip.classList.toggle("gharib-tip--below", !above);
    // The anchor arrow AND the growth origin both point at the word — measured
    // from the DESIRED viewport coords (where the tip now actually renders).
    const ax = Math.min(Math.max(cx - left, 14), Math.max(tw - 14, 14));
    tip.style.setProperty("--tip-ax", `${ax.toFixed(1)}px`);
    tip.style.transformOrigin = `${ax.toFixed(1)}px ${above ? "100%" : "0%"}`;
    };
    place();

    void tip.offsetWidth; // commit position/origin + snapped-closed state
    tip.style.transition = ""; // back to the stylesheet transitions
    tip.classList.add("is-open");
    tip.setAttribute("aria-hidden", "false");
    _tipOpenState = true;
    _tipKey = key;
    // Re-place after layout/scroll settle (see the closure note above) — only
    // while this very tip is still open for the same word.
    requestAnimationFrame(() => {
        if (_tipOpenState && _tipKey === key) place();
    });
}

function closeTip() {
    if (!_tipEl || !_tipOpenState) return;
    _tipOpenState = false;
    _tipKey = null;
    _tipEl.classList.remove("is-open");
    _tipEl.setAttribute("aria-hidden", "true");
}

/* ============================================================
 * Wiring
 * ============================================================ */

let DEPS = null;

/* Desktop hover: a glowing word owns its own interaction — the
 * ayah hover menu (مختصر/copy) must never pop over it. Called
 * by mushaf.js's mouseover handler. */
export function gharibHoverTarget(target) {
    return !_featureOff && !!target?.closest?.(".gharib-word");
}

/* Called by mushaf.js inside its click/touchend handlers BEFORE
 * the audio toggle. `point` is the tap's client {x, y} — used to
 * anchor the tooltip to the exact pressed spot (the only point
 * guaranteed to sit on the visible glyph). Returns true when the
 * tap was on a located gharib word (tooltip opened, audio
 * untouched) OR when this tap just dismissed an open tooltip
 * (consumed — dismissing must never double as an audio toggle). */
export function gharibTapTarget(target, point) {
    if (_featureOff) return false; // lantern off: plain Quran text
    if (Date.now() < _tipSuppressUntil) {
        _tipSuppressUntil = 0;
        return true;
    }
    const el = target?.closest?.(".gharib-word");
    if (!el || !el.dataset.gh || !el.dataset.ghRef) return false;
    openTipFor(el, point);
    return true;
}

/* deps: { surahMeta, isApp } — wired from app.js init(). */
export function initGharib(deps) {
    DEPS = deps || {};
    learnedSet(); // hydrates _featureOff alongside the words
    if (_featureOff) applyGharibOff(true, false); // restore persisted OFF, no fade
    document.addEventListener("mushaf:page-rendered", (e) => {
        const d = e.detail || {};
        decoratePage(d.el, d.data);
    });

    // Tooltip dismissal — pointerdown in the CAPTURE phase so it runs
    // before mushaf's tap handlers. Tapping anywhere outside the tip
    // closes it, and the same physical tap is consumed via the suppress
    // window above (each tap reaches gharibTapTarget exactly once: the
    // touch path preventDefault()s its synthetic click). Tapping a
    // DIFFERENT gharib word falls through — the normal routing swaps
    // the tooltip to it. The 700ms window outlives a slow tap but stays
    // under the long-press threshold's path (which never reaches
    // gharibTapTarget at all).
    document.addEventListener("pointerdown", (e) => {
        // Any tap dismisses an open lantern explainer (a hold on the
        // lantern itself just re-shows it 550ms later).
        if (_explainEl?.classList.contains("is-open")
            && !e.target?.closest?.(".gharib-tip--explain")) {
            hideLanternExplainer();
        }
        if (!_tipOpenState) return;
        if (e.target?.closest?.(".gharib-tip")) return;
        const word = e.target?.closest?.(".gharib-word");
        if (word && word.dataset.gh && word.dataset.ghRef && word.dataset.gh !== _tipKey) return;
        closeTip();
        _tipSuppressUntil = Date.now() + 700;
    }, true);

    // Any scroll (fullscreen zoom panning, panels) drifts a fixed-
    // position tip off its word — dismiss instead of tracking.
    document.addEventListener("scroll", () => {
        closeTip();
        hideLanternExplainer();
    }, { capture: true, passive: true });
}

/* ============================================================
 * Illumination counter widget — lantern (فانوس) + count badge +
 * per-page segmented progress ring. Lives in the Mushaf
 * toolbar's empty spacer zone (auto-hidden in fullscreen: the
 * fullscreen CSS hides every toolbar child except play).
 *
 * Badge entrance = Transitions.dev "Notification badge" port;
 * count increments = "Number pop-in" port (timings/easings
 * verbatim from the repo skills, CSS in public/mushaf.css,
 * gharib- prefixed). Counter + ring are DERIVED from the
 * learned set + the current page's decoration — never stored.
 * A fresh learn updates both immediately (the tooltip hides
 * nothing — settle, +1 pop and segment fill play together).
 *
 * RING GEOMETRY — the badge docks INTO the ring: segments span
 * 280° with an 80° notch at the badge's corner (1–2 o'clock).
 * Without the notch the LAST segment (ayah order runs counter-
 * clockwise from the top) always landed in the upper-right arc
 * — exactly under the badge — so every page looked one dash
 * short. No dash can sit under the badge by construction now.
 * The completion circle still draws all 360° (a continuous
 * ring passing under the docked badge reads as complete).
 * ============================================================ */

const RING_C = 22;            // svg center (44×44 viewBox)
const RING_R = 19;            // ring radius
const RING_GAP_DEG = 13;
const RING_NOTCH_DEG = 80;    // badge dock, centered at -45° (1–2 o'clock)
const RING_ARC_START = -85;   // notch edge nearest 12 o'clock
const RING_ARC_SPAN = 360 - RING_NOTCH_DEG;

let _widget = null;     // { root, segsG, fullCircle, badge, digits }
let _ring = null;       // rendered ring state: { page, n, filled: bool[], complete }

function hapticSuccess() {
    try {
        if (!DEPS?.isApp?.()) return;
        window.Capacitor?.Plugins?.Haptics?.notification?.({ type: "SUCCESS" });
    } catch { }
}

function hapticLight() {
    try {
        if (!DEPS?.isApp?.()) return;
        window.Capacitor?.Plugins?.Haptics?.impact?.({ style: "LIGHT" });
    } catch { }
}

/* فانوس — the FLAME is the focal point: big, filled warm gold
 * (CSS .gharib-lamp__flame), framed by a minimal stroked body
 * (handle loop, dome, collar, flared glass, pedestal). Unlit
 * grey when the feature is toggled off. */
const LAMP_SVG = `
  <svg class="gharib-lamp__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M10.7 3.2a1.55 1.55 0 0 1 2.6 0"/>
    <path d="M9.1 6.6c.3-1.7 1.4-2.6 2.9-2.6s2.6.9 2.9 2.6"/>
    <path d="M8.3 6.6h7.4"/>
    <path d="M9.2 6.6l-.5 7.2a1.3 1.3 0 0 0 1.3 1.4h4a1.3 1.3 0 0 0 1.3-1.4l-.5-7.2"/>
    <path class="gharib-lamp__flame" d="M12 7.9c-1.3 1.7-2 2.85-2 3.9a2 2 0 0 0 4 0c0-1.05-.7-2.2-2-3.9z"/>
    <path d="M10.4 15.2l-.6 2.9M13.6 15.2l.6 2.9"/>
    <path d="M9.6 18.1h4.8"/>
  </svg>`;

/* ── Lantern explainer — press-and-hold shows a tiny card that
 * says what the feature does (same .gharib-tip card family,
 * arrow pointing at the lantern). The card is DOM-ANCHORED:
 * appended INSIDE the lamp button and absolutely positioned
 * below it (CSS .gharib-lamp > .gharib-tip--explain), so the
 * browser keeps the arrow glued to the lantern in every state —
 * page scrolled, fullscreen re-anchor, anything. No screen-
 * coordinate math (the old fixed-position placement drifted off
 * the lamp in the app once the page was scrolled). Auto-hides
 * after 5.5s, or on any tap/scroll. The hold must never toggle
 * the feature: the click that follows a fired hold is swallowed,
 * and taps on the card itself don't reach the toggle. ── */

let _explainEl = null;
let _explainHideT = 0;
let _explainCloseT = 0;   // Transitions.dev modal: is-closing → removed after --modal-close-dur
let _lanternHoldFired = false;

/* Desktop web only (mouse + fine pointer, not the app): the lantern
 * explainer is hover-driven there — shown on pointer-enter, hidden on
 * leave. Touch and the app keep the press-and-hold path. */
function canHoverWeb() {
    try {
        return !DEPS?.isApp?.()
            && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    } catch { return false; }
}

/* The card lives on <body>, NOT inside the lamp. The lamp sits in the
 * backdrop-filtered .mushaf-root.glass; appending a child to it / lifting
 * its z-index on hover repainted the filter and jittered the lamp ("jump"
 * on hover). A body-level fixed card touches nothing in the glass. */
function ensureExplainer() {
    if (_explainEl) return _explainEl;
    const el = document.createElement("div");
    // --below = arrow on the top edge, pointing UP at the lantern.
    el.className = "gharib-tip gharib-tip--explain gharib-tip--below";
    el.setAttribute("dir", "rtl");
    el.setAttribute("role", "note");
    el.innerHTML = "<b>غريب القرآن</b>"
        + "مع كل لفظة قرآنية تفهمها: تتّسع حصيلتك، ويعمُق تدبّرك، وتُضاف نقطة إلى حسابك هنا";
    document.body.appendChild(el);
    _explainEl = el;
    return el;
}

/* Anchor the fixed card centred under the lamp, arrow pointing up at the
 * lamp's centre, clamped to the viewport. Re-run on every open (the lamp
 * may have moved); the card is dismissed on scroll, so it can't drift. */
function positionExplainer(el) {
    const root = _widget?.root;
    if (!root) return;
    const lamp = root.getBoundingClientRect();
    const GAP = 10, MARGIN = 8;
    const cw = el.offsetWidth;
    const cx = lamp.left + lamp.width / 2;
    const maxL = Math.max(window.innerWidth - MARGIN - cw, MARGIN);
    const left = Math.min(Math.max(cx - cw / 2, MARGIN), maxL);
    el.style.left = `${left.toFixed(1)}px`;
    el.style.top = `${(lamp.bottom + GAP).toFixed(1)}px`;
    const ax = Math.min(Math.max(cx - left, 14), Math.max(cw - 14, 14));
    el.style.setProperty("--tip-ax", `${ax.toFixed(1)}px`);
}

function hideLanternExplainer() {
    clearTimeout(_explainHideT);
    const el = _explainEl;
    if (!el || !el.classList.contains("is-open")) return;
    // Transitions.dev modal close: swap is-open → is-closing, then drop
    // is-closing after --modal-close-dur (150ms) back to the base closed
    // state (identical scale+opacity, so removing it never flickers).
    el.classList.remove("is-open");
    el.classList.add("is-closing");
    clearTimeout(_explainCloseT);
    _explainCloseT = setTimeout(() => el.classList.remove("is-closing"), 150);
}

function showLanternExplainer(autoHide = true) {
    if (!_widget?.root) return;
    const el = ensureExplainer();
    clearTimeout(_explainCloseT);
    // Transitions.dev modal: base/closing → is-open. Anchor first so the
    // grow happens from the placed spot; no reflow, so a re-hover mid-close
    // eases from the current frame instead of snapping.
    el.classList.remove("is-closing");
    positionExplainer(el);
    el.classList.add("is-open");
    clearTimeout(_explainHideT);
    // Web hover keeps the card up until the pointer leaves the lantern
    // (mouseleave hides it); the press-and-hold path (touch/app) still
    // auto-hides after 5.5s.
    if (autoHide) _explainHideT = setTimeout(hideLanternExplainer, 5500);
}

/* Reflect the toggle on the lantern: flame lit/unlit, ring +
 * badge dimmed, button semantics. */
function syncLanternState() {
    if (!_widget) return;
    _widget.root.classList.toggle("gharib-lamp--off", _featureOff);
    // No `title` — it surfaced a native browser tooltip on hover; the
    // explainer card already conveys the feature, and aria-pressed below
    // keeps the toggle state for screen readers.
    _widget.root.setAttribute("aria-pressed", String(!_featureOff));
}

function ensureWidget() {
    if (_widget) return _widget;
    const toolbar = document.getElementById("mushafToolbar");
    const spacer = toolbar?.querySelector(".mushaf-toolbar__spacer");
    if (!toolbar || !spacer) return null;

    const root = document.createElement("button");
    root.type = "button";
    root.id = "gharibLamp";
    root.className = "gharib-lamp";
    root.innerHTML = `
      <svg class="gharib-lamp__ring" viewBox="0 0 44 44" aria-hidden="true">
        <g class="gharib-lamp__segs"></g>
        <g transform="rotate(-90 ${RING_C} ${RING_C}) scale(1 -1) translate(0 -${RING_C * 2})">
          <circle class="gharib-lamp__full" cx="${RING_C}" cy="${RING_C}" r="${RING_R}" pathLength="1"/>
        </g>
      </svg>
      ${LAMP_SVG}
      <span class="gharib-lamp__bloom" aria-hidden="true"></span>
      <span class="gharib-badge" data-open="false" aria-hidden="true">
        <span class="gharib-badge__dot"><span class="gharib-digits"></span></span>
      </span>`;
    spacer.insertAdjacentElement("afterend", root);

    // The lantern is the feature toggle. stopPropagation matches the
    // other fullscreen-cluster buttons (background taps toggle chrome).
    root.addEventListener("click", (e) => {
        e.stopPropagation();
        // The explainer card lives INSIDE the button — taps on it
        // must never toggle the feature.
        if (e.target?.closest?.(".gharib-tip--explain")) return;
        if (_lanternHoldFired) { _lanternHoldFired = false; return; }
        hideLanternExplainer();
        toggleGharibFeature();
    });

    // Press-and-hold (~550ms) explains the feature instead of toggling.
    let holdT = 0;
    root.addEventListener("pointerdown", (e) => {
        if (e.target?.closest?.(".gharib-tip--explain")) return;
        _lanternHoldFired = false;
        clearTimeout(holdT);
        holdT = setTimeout(() => {
            _lanternHoldFired = true;
            hapticLight();
            showLanternExplainer();
        }, 550);
    });
    const cancelHold = () => clearTimeout(holdT);
    root.addEventListener("pointerup", cancelHold);
    root.addEventListener("pointercancel", cancelHold);
    root.addEventListener("pointerleave", cancelHold);
    root.addEventListener("contextmenu", (e) => e.preventDefault());

    // Desktop web: hovering the lantern shows the explainer; moving the
    // pointer off it hides the card. No auto-hide while hovering. Gated
    // to mouse/non-app so touch and the app are untouched (they keep the
    // press-and-hold path above).
    root.addEventListener("mouseenter", () => {
        if (canHoverWeb()) showLanternExplainer(false);
    });
    root.addEventListener("mouseleave", () => {
        if (canHoverWeb()) hideLanternExplainer();
    });

    _widget = {
        root,
        segsG: root.querySelector(".gharib-lamp__segs"),
        fullCircle: root.querySelector(".gharib-lamp__full"),
        badge: root.querySelector(".gharib-badge"),
        digits: root.querySelector(".gharib-digits"),
    };
    syncLanternState();
    return _widget;
}

/* ── Count badge ── */

function setCount(n, animate) {
    if (!_widget) return;
    const { badge, digits, root } = _widget;
    const str = Number(n).toLocaleString("ar-EG");
    digits.classList.remove("is-animating");
    digits.replaceChildren();
    const chars = [...str];
    chars.forEach((ch, i) => {
        const span = document.createElement("span");
        span.className = "gharib-digit";
        span.textContent = ch;
        // Repo pattern: the last two characters ride in behind the rest.
        if (i === chars.length - 2) span.dataset.stagger = "1";
        else if (i === chars.length - 1) span.dataset.stagger = "2";
        digits.appendChild(span);
    });
    if (animate && !prefersReducedMotion()) {
        void digits.offsetHeight; // restart the pop-in
        digits.classList.add("is-animating");
    }
    badge.dataset.open = n > 0 ? "true" : "false";
    root.setAttribute("aria-label", `غريب القرآن: ${str} كلمة متعلمة`);
}

/* ── Segmented ring ── */

const rad = (deg) => (deg * Math.PI) / 180;

/* Counter-clockwise arc (RTL reading direction) from a0 to a1,
 * angles in screen degrees (0 = 3 o'clock, +clockwise). */
function arcPath(a0, a1) {
    const x0 = RING_C + RING_R * Math.cos(rad(a0));
    const y0 = RING_C + RING_R * Math.sin(rad(a0));
    const x1 = RING_C + RING_R * Math.cos(rad(a1));
    const y1 = RING_C + RING_R * Math.sin(rad(a1));
    const large = Math.abs(a0 - a1) > 180 ? 1 : 0;
    return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${RING_R} ${RING_R} 0 ${large} 0 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/* Build n track+fill segment pairs, page word order running
 * counter-clockwise around the 280° arc (the 80° badge-dock
 * notch at 1–2 o'clock stays empty — see RING GEOMETRY above).
 * Returns the fill paths. */
function buildSegments(n) {
    const { segsG } = _widget;
    segsG.replaceChildren();
    const fills = [];
    const span = RING_ARC_SPAN / n;
    const gap = Math.min(RING_GAP_DEG, span * 0.35);
    for (let i = 0; i < n; i++) {
        const a0 = RING_ARC_START - i * span - gap / 2;
        const a1 = a0 - (span - gap);
        const d = arcPath(a0, a1);
        const track = document.createElementNS(SVG_NS, "path");
        track.setAttribute("class", "gharib-seg__track");
        track.setAttribute("d", d);
        const fill = document.createElementNS(SVG_NS, "path");
        fill.setAttribute("class", "gharib-seg__fill");
        fill.setAttribute("d", d);
        fill.setAttribute("pathLength", "1");
        segsG.appendChild(track);
        segsG.appendChild(fill);
        fills.push(fill);
    }
    return fills;
}

/* Render/refresh the ring for the current page state. One
 * segment per WORD (page-ordered) — each learned word fills its
 * own dash, so progress shows on EVERY tooltip viewing.
 * animate=false → settled states render quietly (page nav,
 * already-learned words, empty pages: no celebration replay). */
function updateRing(animate) {
    if (!_widget) return;
    const { root } = _widget;
    const keys = PAGE_GHARIB.keys || [];
    const n = keys.length;
    const set = learnedSet();
    const structural = !_ring || _ring.page !== PAGE_GHARIB.page || _ring.n !== n;

    if (structural) {
        root.classList.remove("is-complete", "is-celebrating", "is-empty");
        root.classList.add("no-anim"); // suppress transitions during rebuild
        _ring = {
            page: PAGE_GHARIB.page,
            n,
            keys,
            fills: n ? buildSegments(n) : (_widget.segsG.replaceChildren(), []),
            filled: keys.map((k) => set.has(k)),
            complete: false,
        };
        _ring.filled.forEach((f, i) => { if (f) _ring.fills[i].classList.add("is-filled"); });
        const complete = n === 0 || _ring.filled.every(Boolean);
        if (n === 0) root.classList.add("is-empty");
        if (complete) { root.classList.add("is-complete"); _ring.complete = true; }
        void root.offsetWidth; // commit no-anim state
        root.classList.remove("no-anim");
        return;
    }

    // Same page: fill each newly-learned word (animated sweep).
    let newlyFilled = false;
    keys.forEach((k, i) => {
        if (set.has(k) && !_ring.filled[i]) {
            _ring.filled[i] = true;
            newlyFilled = true;
            _ring.fills[i].classList.add("is-filled");
        }
    });
    if (!_ring.complete && n > 0 && _ring.filled.every(Boolean)) {
        _ring.complete = true;
        if (animate && newlyFilled && !prefersReducedMotion()) {
            // Let the last segment's sweep land, then connect the dashes
            // into one ring + soft illumination pulse + haptic. Guard on
            // the page: a flip inside this window rebuilds the ring and
            // must not inherit the celebration.
            const pg = _ring.page;
            setTimeout(() => {
                if (!_widget || !_ring?.complete || _ring.page !== pg) return;
                root.classList.add("is-complete", "is-celebrating");
                setTimeout(hapticSuccess, 600);
                setTimeout(() => root.classList.remove("is-celebrating"), 2400);
            }, 850);
        } else {
            // Reduced motion (or non-animated refresh): connect quietly.
            root.classList.add("no-anim", "is-complete");
            void root.offsetWidth;
            root.classList.remove("no-anim");
            if (animate) hapticSuccess(); // the tactile ack still lands
        }
    }
}

/* ── Visual update hooks ── */

_onLearnHook = () => {
    if (!ensureWidget()) return;
    setCount(gharibLearnedCount(), true);
    updateRing(true);
};

_onDecorateHook = () => {
    if (!ensureWidget()) return;
    setCount(gharibLearnedCount(), false);
    updateRing(false);
};

/* ============================================================
 * Forget a learned word — the saved-words panel's "remove".
 * The saved collection IS the learned set (one source of truth),
 * so removing a word un-reveals it everywhere: drop the key, walk
 * back every on-screen occurrence's glow to gold (undiscovered),
 * and refresh the lantern count + ring. Fully reversible — tapping
 * the word again in the Mushaf re-learns it. Returns true if the
 * set actually changed.
 * ============================================================ */
export function gharibForget(key) {
    const set = learnedSet();
    if (!set.has(key)) return false;
    set.delete(key);
    saveStore();
    // Revert any on-screen occurrence: drop the settled/settling
    // classes so the gold breathing glow returns. data-gh/-ghc stay,
    // so the span behaves as a fresh undiscovered word again.
    document.querySelectorAll(`.gharib-word[data-gh="${CSS.escape(key)}"]`)
        .forEach((el) => el.classList.remove("gharib-word--settled", "gharib-word--settling"));
    // Refresh the lantern if it's been built (best-effort — the store
    // is the source of truth; the next page decorate re-derives both
    // the count and the ring from the set regardless).
    if (_widget) {
        setCount(gharibLearnedCount(), false);
        _ring = null;        // force a structural ring rebuild from the new set
        updateRing(false);
    }
    return true;
}

/* Forget EVERY learned word — the saved-words panel's "reset all".
 * Empties the set, walks back every on-screen glow to gold, and
 * darkens the lantern to zero. Returns true if anything was cleared.
 * (The on/off toggle is untouched — only the learned words are.) */
export function gharibForgetAll() {
    const set = learnedSet();
    if (!set.size) return false;
    set.clear();
    saveStore();
    document.querySelectorAll(".gharib-word--settled, .gharib-word--settling")
        .forEach((el) => el.classList.remove("gharib-word--settled", "gharib-word--settling"));
    if (_widget) {
        setCount(0, false);
        _ring = null;        // structural ring rebuild from the now-empty set
        updateRing(false);
    }
    return true;
}
