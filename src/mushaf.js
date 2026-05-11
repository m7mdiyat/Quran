/*
 * Mushaf reading mode — Madinah Mushaf 1441 AH (QCF4)
 *
 * Lazy-loads page JSONs and per-page WOFF2 fonts on demand, renders one
 * page at a time, supports swipe / keyboard / button navigation, ayah
 * tap menu (audio / open-tafsir / copy), and audio playback with
 * highlighting (single or continuous mode).
 *
 * Designed to live alongside Tafsir mode in src/app.js. Bridges in:
 *   - initMushaf(deps) — called from app.js init() with shared data
 *   - enterMushafMode(opts) / exitMushafMode()
 *   - openMushafAtAyah(s,a) / openMushafAtPage(p) / openMushafAtSurah(s)
 *   - isMushafMode()
 *
 * State is module-scoped; the module is a singleton for the page.
 */

"use strict";

const STORAGE = {
    MODE: "app_mode",
    LAST_PAGE: "mushaf_last_page",
    FONT_SIZE: "mushaf_font_size",
    AUDIO_MODE: "mushaf_audio_mode",
    RECITER: "audioReciter", // shared with Tafsir mode
};

const TOTAL_PAGES = 604;

/* Data caches */
const PAGE_CACHE = new Map(); // pageNo -> parsed JSON
const PAGE_INFLIGHT = new Map(); // pageNo -> Promise
const LOADED_FONTS = new Set(["QCF4_QBSML", "QCF4_Hafs_01"]); // declared in mushaf.css
let VERSES_LOOKUP = null; // { "s:a": { page, lines:[{line,word_start,word_end}] } }
let FONT_MAP = null; // { "1": "QCF4_Hafs_01", ... }
let CHAPTERS = null; // [{id, name_arabic, name, pages:[start,end], verses_count}]
let META_READY = null; // Promise

/* Runtime state */
let DEPS = null;
let MUSHAF_MODE = false;
let CURRENT_PAGE = 1;
let CURRENT_TARGET_VERSE = null; // "s:a" — highlight on next render
let ROOT_EL = null;
let PAGES_EL = null;
let TOPBAR_EL = null;
let SURAH_SELECT = null;
let PAGE_INPUT = null;
let JUZ_SELECT = null;
let ACTIVE_PAGE_EL = null;
let AYAH_MENU_EL = null;
let AYAH_MENU_VERSE = null;
let SETTINGS_EL = null;
let NOW_PLAYING_EL = null;
let IDLE_TIMER = null;

/* Audio state (separate from Tafsir-mode audio in app.js — independent
   Audio object so the modes don't fight over it). */
let AUDIO_PLAYER = null;
let AUDIO_VERSE = null; // "s:a" currently playing
let AUDIO_MODE = "single"; // "single" | "continuous"
let FONT_SIZE = "m"; // "s" | "m" | "l"

/* ---------------- bridging ---------------- */

export function initMushaf(deps) {
    DEPS = deps; // { surahMeta, quran, audioBase, reciters, reciterOrder, getCurrentReciter, setCurrentReciter, openTafsirForAyah, stopTafsirAudio }

    // Restore persisted prefs
    try {
        const fs = localStorage.getItem(STORAGE.FONT_SIZE);
        if (fs === "s" || fs === "m" || fs === "l") FONT_SIZE = fs;
        const am = localStorage.getItem(STORAGE.AUDIO_MODE);
        if (am === "single" || am === "continuous") AUDIO_MODE = am;
    } catch { }

    // Build the UI shell (idempotent)
    buildShell();

    // Wire global mode bridging (toggle buttons)
    document.querySelectorAll("[data-mode-toggle]").forEach((btn) => {
        btn.addEventListener("click", () => {
            setAppMode(MUSHAF_MODE ? "tafsir" : "mushaf");
        });
    });

    // Set initial data-app-mode if not yet set
    if (!document.documentElement.hasAttribute("data-app-mode")) {
        let saved = "tafsir";
        try {
            const v = localStorage.getItem(STORAGE.MODE);
            if (v === "mushaf" || v === "tafsir") saved = v;
        } catch { }
        document.documentElement.setAttribute("data-app-mode", saved);
        MUSHAF_MODE = saved === "mushaf";
    } else {
        MUSHAF_MODE = document.documentElement.getAttribute("data-app-mode") === "mushaf";
    }
    document.documentElement.setAttribute("data-font-size", FONT_SIZE);

    // Idle / chrome-fade tracker
    setupIdleTracker();

    // Keyboard navigation
    document.addEventListener("keydown", onKeyDown);

    return { setAppMode, openMushafAtAyah, openMushafAtPage, openMushafAtSurah, isMushafMode };
}

export function isMushafMode() {
    return MUSHAF_MODE;
}

export function setAppMode(mode, { skipUrlUpdate = false } = {}) {
    const wanted = mode === "mushaf" ? "mushaf" : "tafsir";
    const prev = MUSHAF_MODE ? "mushaf" : "tafsir";
    MUSHAF_MODE = wanted === "mushaf";
    document.documentElement.setAttribute("data-app-mode", wanted);
    try { localStorage.setItem(STORAGE.MODE, wanted); } catch { }

    if (MUSHAF_MODE && prev !== "mushaf") {
        // Stop any Tafsir-mode audio so we don't have two streams
        try { DEPS?.stopTafsirAudio?.(); } catch { }
        ensureCurrentPageRendered();
        if (!skipUrlUpdate) {
            const p = CURRENT_PAGE || 1;
            history.pushState({ mushaf: true, page: p }, "", `/read/page/${p}`);
            updateMushafSeo({ page: p });
        }
    } else if (!MUSHAF_MODE && prev !== "tafsir") {
        // Stop Mushaf audio
        stopMushafAudio();
        if (!skipUrlUpdate) {
            history.pushState({}, "", "/");
            // Reset SEO via DEPS if available; otherwise just home title
            document.title = "محمديات";
        }
    }
}

export async function openMushafAtAyah(s, a, opts = {}) {
    await ensureMetaLoaded();
    const key = `${s}:${a}`;
    const entry = VERSES_LOOKUP?.[key];
    const page = entry?.page || 1;
    CURRENT_TARGET_VERSE = key;
    setAppMode("mushaf", { skipUrlUpdate: true });
    await goToPage(page, { direction: "none" });
    const updateUrl = opts.updateUrl !== false;
    if (updateUrl) {
        history.pushState({ mushaf: true, page, target: key }, "", `/read/ayah/${s}/${a}`);
    }
    updateMushafSeo({ page, verse: key });
}

export async function openMushafAtPage(p, opts = {}) {
    await ensureMetaLoaded();
    setAppMode("mushaf", { skipUrlUpdate: true });
    CURRENT_TARGET_VERSE = null;
    await goToPage(Math.max(1, Math.min(TOTAL_PAGES, Number(p) || 1)), {
        direction: "none",
    });
    const updateUrl = opts.updateUrl !== false;
    if (updateUrl) {
        history.pushState({ mushaf: true, page: CURRENT_PAGE }, "", `/read/page/${CURRENT_PAGE}`);
    }
    updateMushafSeo({ page: CURRENT_PAGE });
}

export async function openMushafAtSurah(s, opts = {}) {
    await ensureMetaLoaded();
    const ch = CHAPTERS?.find((c) => c.id === Number(s));
    const page = ch?.pages?.[0] || 1;
    CURRENT_TARGET_VERSE = `${s}:1`;
    setAppMode("mushaf", { skipUrlUpdate: true });
    await goToPage(page, { direction: "none" });
    const updateUrl = opts.updateUrl !== false;
    if (updateUrl) {
        history.pushState({ mushaf: true, page, surah: Number(s) }, "", `/read/surah/${s}`);
    }
    updateMushafSeo({ page, surah: Number(s) });
}

/* ---------------- metadata + page loading ---------------- */

async function ensureMetaLoaded() {
    if (META_READY) return META_READY;
    META_READY = (async () => {
        const [verses, fontMap, index] = await Promise.all([
            fetch("/data/qcf4/verses.json").then((r) => r.json()),
            fetch("/data/qcf4/font-map.json").then((r) => r.json()),
            fetch("/data/qcf4/index.json").then((r) => r.json()),
        ]);
        VERSES_LOOKUP = verses;
        FONT_MAP = fontMap;
        CHAPTERS = index?.chapters || [];
        populateSurahSelect();
        populateJuzSelect();
    })();
    return META_READY;
}

async function fetchPage(pageNo) {
    if (PAGE_CACHE.has(pageNo)) return PAGE_CACHE.get(pageNo);
    if (PAGE_INFLIGHT.has(pageNo)) return PAGE_INFLIGHT.get(pageNo);
    const p = (async () => {
        const name = String(pageNo).padStart(3, "0");
        const res = await fetch(`/data/qcf4/pages/${name}.json`);
        if (!res.ok) throw new Error(`page ${pageNo} fetch failed: ${res.status}`);
        const data = await res.json();
        PAGE_CACHE.set(pageNo, data);
        return data;
    })();
    PAGE_INFLIGHT.set(pageNo, p);
    try {
        return await p;
    } finally {
        PAGE_INFLIGHT.delete(pageNo);
    }
}

function ensureFontDeclared(fontFamily) {
    if (LOADED_FONTS.has(fontFamily)) return;
    // Page fonts follow pattern QCF4_Hafs_NN — file is QCF4_Hafs_NN_W.woff2
    let fileName = `${fontFamily}_W.woff2`;
    if (fontFamily === "QCF4_QBSML") fileName = "QCF4_QBSML.woff2";
    const css = `@font-face { font-family: "${fontFamily}"; src: url("/fonts/qcf4/${fileName}") format("woff2"); font-display: block; }`;
    const style = document.createElement("style");
    style.dataset.qcf4Font = fontFamily;
    style.textContent = css;
    document.head.appendChild(style);
    LOADED_FONTS.add(fontFamily);
}

/* ---------------- UI shell construction ---------------- */

function buildShell() {
    if (document.getElementById("mushafRoot")) {
        ROOT_EL = document.getElementById("mushafRoot");
        PAGES_EL = document.getElementById("mushafPages");
        SURAH_SELECT = document.getElementById("mushafSurahSelect");
        PAGE_INPUT = document.getElementById("mushafPageInput");
        JUZ_SELECT = document.getElementById("mushafJuzSelect");
        AYAH_MENU_EL = document.getElementById("mushafAyahMenu");
        SETTINGS_EL = document.getElementById("mushafSettings");
        NOW_PLAYING_EL = document.getElementById("mushafNowPlaying");
        return;
    }

    const root = document.createElement("div");
    root.id = "mushafRoot";
    root.className = "mushaf-root";
    root.dir = "rtl";
    root.innerHTML = `
    <div class="mushaf-topbar" id="mushafTopbar">
      <div class="mushaf-topbar__group">
        <label class="mushaf-page-label" for="mushafSurahSelect">السورة</label>
        <select id="mushafSurahSelect" class="mushaf-select" aria-label="اختر سورة"></select>
      </div>
      <div class="mushaf-topbar__group">
        <label class="mushaf-page-label" for="mushafJuzSelect">الجزء</label>
        <select id="mushafJuzSelect" class="mushaf-select" aria-label="اختر جزء"></select>
      </div>
      <div class="mushaf-topbar__group">
        <label class="mushaf-page-label" for="mushafPageInput">صفحة</label>
        <input id="mushafPageInput" class="mushaf-page-input" type="number" min="1" max="${TOTAL_PAGES}" value="1" />
        <span class="mushaf-page-label">/ ${TOTAL_PAGES}</span>
      </div>
      <div class="mushaf-topbar__spacer"></div>
      <div class="mushaf-topbar__group mode-toggle--in-mushaf-bar">
        ${buildToggleMarkup()}
      </div>
    </div>
    <div class="mushaf-stage">
      <button type="button" class="mushaf-nav mushaf-nav--prev" id="mushafPrev" aria-label="الصفحة السابقة">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
      </button>
      <div class="mushaf-pages" id="mushafPages"></div>
      <button type="button" class="mushaf-nav mushaf-nav--next" id="mushafNext" aria-label="الصفحة التالية">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
      </button>
    </div>
    <div class="mushaf-ayah-menu" id="mushafAyahMenu" role="menu" aria-hidden="true">
      <button type="button" class="mushaf-ayah-menu__btn" data-act="play" aria-label="استمع للآية">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4v16l14-8z"/></svg>
      </button>
      <button type="button" class="mushaf-ayah-menu__btn" data-act="tafsir" aria-label="افتح التفسير">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5a2 2 0 012-2h6v18H5a2 2 0 01-2-2V5z"/><path d="M21 5a2 2 0 00-2-2h-6v18h6a2 2 0 002-2V5z"/></svg>
      </button>
      <button type="button" class="mushaf-ayah-menu__btn" data-act="copy" aria-label="انسخ نص الآية">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></svg>
      </button>
    </div>
    <div class="mushaf-settings" id="mushafSettings">
      <div class="mushaf-now-playing" id="mushafNowPlaying">
        <span class="mushaf-now-playing__name">—</span>
        <button type="button" class="mushaf-now-playing__btn" id="mushafNowPlayingBtn" aria-label="إيقاف/تشغيل">
          <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
        </button>
      </div>
      <button type="button" class="mushaf-settings__cog" id="mushafSettingsCog" aria-label="إعدادات">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9 1.65 1.65 0 004.27 7.18l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/>
        </svg>
      </button>
      <div class="mushaf-settings__panel">
        <div class="mushaf-settings__section">
          <span class="mushaf-settings__label">القارئ</span>
          <div class="mushaf-settings__row" data-settings-group="reciter"></div>
        </div>
        <div class="mushaf-settings__section">
          <span class="mushaf-settings__label">وضع التشغيل</span>
          <div class="mushaf-settings__row" data-settings-group="audio-mode">
            <button type="button" class="mushaf-settings__chip" data-val="single">آية واحدة</button>
            <button type="button" class="mushaf-settings__chip" data-val="continuous">متواصل</button>
          </div>
        </div>
        <div class="mushaf-settings__section">
          <span class="mushaf-settings__label">حجم الخط</span>
          <div class="mushaf-settings__row" data-settings-group="font-size">
            <button type="button" class="mushaf-settings__chip" data-val="s">صغير</button>
            <button type="button" class="mushaf-settings__chip" data-val="m">متوسط</button>
            <button type="button" class="mushaf-settings__chip" data-val="l">كبير</button>
          </div>
        </div>
      </div>
    </div>
  `;
    document.body.appendChild(root);

    ROOT_EL = root;
    PAGES_EL = document.getElementById("mushafPages");
    SURAH_SELECT = document.getElementById("mushafSurahSelect");
    PAGE_INPUT = document.getElementById("mushafPageInput");
    JUZ_SELECT = document.getElementById("mushafJuzSelect");
    AYAH_MENU_EL = document.getElementById("mushafAyahMenu");
    SETTINGS_EL = document.getElementById("mushafSettings");
    NOW_PLAYING_EL = document.getElementById("mushafNowPlaying");
    TOPBAR_EL = document.getElementById("mushafTopbar");

    wireTopbar();
    wireNav();
    wireAyahMenu();
    wireSwipe();
    wireSettings();
    buildReciterButtons();
    syncSettingsUI();
}

function buildToggleMarkup() {
    return `
    <div class="mode-toggle">
      <button type="button" class="mode-toggle__btn" data-mode-toggle aria-label="التبديل بين التفسير والمصحف">
        <div class="mode-toggle__icons">
          <span class="mode-toggle__icon mode-toggle__icon--tafsir" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 4h6a4 4 0 014 4v12a3 3 0 00-3-3H4z"/>
              <path d="M20 4h-6a4 4 0 00-4 4v12a3 3 0 013-3h7z"/>
            </svg>
          </span>
          <span class="mode-toggle__icon mode-toggle__icon--mushaf" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="2"/>
              <path d="M12 4v16"/>
              <path d="M7 9h2"/>
              <path d="M15 9h2"/>
              <path d="M7 14h2"/>
              <path d="M15 14h2"/>
            </svg>
          </span>
        </div>
        <span class="mode-toggle__knob"></span>
      </button>
    </div>
  `;
}

/** Build the toggle markup for the Tafsir search panel (called from app.js). */
export function getSearchPanelToggleHtml() {
    return `<div class="mode-toggle--in-search">${buildToggleMarkup()}</div>`;
}

/* ---------------- Topbar wiring ---------------- */

function populateSurahSelect() {
    if (!SURAH_SELECT || !CHAPTERS) return;
    SURAH_SELECT.innerHTML = '<option value="">—</option>' +
        CHAPTERS.map(
            (c) => `<option value="${c.id}">${c.id}. ${c.name_arabic}</option>`
        ).join("");
}

const JUZ_PAGES = [
    1, 22, 42, 62, 82, 102, 121, 142, 162, 182, 201, 222, 242, 262, 282,
    302, 322, 342, 362, 382, 402, 422, 442, 462, 482, 502, 522, 542, 562, 582,
]; // QCF4 page where each Juz starts (1-indexed)

function populateJuzSelect() {
    if (!JUZ_SELECT) return;
    JUZ_SELECT.innerHTML = '<option value="">—</option>' +
        JUZ_PAGES.map((p, i) => `<option value="${p}">${i + 1}</option>`).join("");
}

function wireTopbar() {
    SURAH_SELECT?.addEventListener("change", () => {
        const s = Number(SURAH_SELECT.value);
        if (!s) return;
        openMushafAtSurah(s);
        SURAH_SELECT.blur();
    });

    JUZ_SELECT?.addEventListener("change", () => {
        const p = Number(JUZ_SELECT.value);
        if (!p) return;
        openMushafAtPage(p);
        JUZ_SELECT.blur();
    });

    PAGE_INPUT?.addEventListener("change", () => {
        const p = Math.max(1, Math.min(TOTAL_PAGES, Number(PAGE_INPUT.value) || 1));
        PAGE_INPUT.value = String(p);
        openMushafAtPage(p);
        PAGE_INPUT.blur();
    });
    PAGE_INPUT?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            PAGE_INPUT.dispatchEvent(new Event("change"));
        }
    });
}

/* ---------------- Page navigation ---------------- */

function wireNav() {
    document.getElementById("mushafPrev")?.addEventListener("click", () => goPrev());
    document.getElementById("mushafNext")?.addEventListener("click", () => goNext());
}

function goPrev() {
    if (CURRENT_PAGE <= 1) return;
    CURRENT_TARGET_VERSE = null;
    goToPage(CURRENT_PAGE - 1, { direction: "right" });
    history.pushState({ mushaf: true, page: CURRENT_PAGE - 1 }, "", `/read/page/${CURRENT_PAGE - 1}`);
}

function goNext() {
    if (CURRENT_PAGE >= TOTAL_PAGES) return;
    CURRENT_TARGET_VERSE = null;
    goToPage(CURRENT_PAGE + 1, { direction: "left" });
    history.pushState({ mushaf: true, page: CURRENT_PAGE + 1 }, "", `/read/page/${CURRENT_PAGE + 1}`);
}

function onKeyDown(e) {
    if (!MUSHAF_MODE) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    // In a RTL Mushaf, ArrowLeft naturally advances (next page = leftward), ArrowRight goes back.
    if (e.key === "ArrowLeft") { e.preventDefault(); goNext(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); goPrev(); }
    else if (e.key === "PageDown") { e.preventDefault(); goNext(); }
    else if (e.key === "PageUp") { e.preventDefault(); goPrev(); }
    else if (e.key === "Home") { e.preventDefault(); openMushafAtPage(1); }
    else if (e.key === "End") { e.preventDefault(); openMushafAtPage(TOTAL_PAGES); }
    else if (e.key === "Escape") { closeAyahMenu(); }
}

function wireSwipe() {
    if (!PAGES_EL) return;
    let startX = 0, startY = 0, tracking = false;
    PAGES_EL.addEventListener("touchstart", (e) => {
        if (e.touches.length !== 1) return;
        tracking = true;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
    }, { passive: true });

    PAGES_EL.addEventListener("touchend", (e) => {
        if (!tracking) return;
        tracking = false;
        const t = e.changedTouches[0];
        const dx = t.clientX - startX;
        const dy = t.clientY - startY;
        if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy)) return;
        // RTL: swipe right (positive dx) = previous page; swipe left = next
        if (dx > 0) goPrev(); else goNext();
    }, { passive: true });
}

async function goToPage(p, { direction = "none" } = {}) {
    await ensureMetaLoaded();
    if (p === CURRENT_PAGE && ACTIVE_PAGE_EL) {
        // Already on this page — just re-apply target highlight if any
        applyTargetHighlight();
        return;
    }

    // Persist last page
    try { localStorage.setItem(STORAGE.LAST_PAGE, String(p)); } catch { }

    // Update page input
    if (PAGE_INPUT) PAGE_INPUT.value = String(p);

    // Update surah dropdown (best guess: first surah on the page)
    try {
        const data = await fetchPage(p);
        if (SURAH_SELECT && data.surahs?.[0]) {
            SURAH_SELECT.value = String(data.surahs[0].id);
        }
        renderPage(data, direction);
        CURRENT_PAGE = p;
        prefetchAdjacent(p);
        applyTargetHighlight();
    } catch (e) {
        console.error("Mushaf goToPage error:", e);
    }
}

function prefetchAdjacent(p) {
    if (p > 1) fetchPage(p - 1).catch(() => { });
    if (p < TOTAL_PAGES) fetchPage(p + 1).catch(() => { });
}

async function ensureCurrentPageRendered() {
    let target = CURRENT_PAGE;
    if (!target) {
        try {
            const last = Number(localStorage.getItem(STORAGE.LAST_PAGE));
            if (Number.isFinite(last) && last >= 1 && last <= TOTAL_PAGES) target = last;
        } catch { }
    }
    target = target || 1;
    if (!ACTIVE_PAGE_EL) {
        await goToPage(target, { direction: "none" });
    }
}

/* ---------------- Page rendering ---------------- */

function renderPage(data, direction = "none") {
    if (!PAGES_EL) return;
    ensureFontDeclared(data.font);
    // Declare any extra fonts referenced by words on this page (rare).
    for (const line of data.lines) {
        for (const w of line.words) {
            if (w.font && !LOADED_FONTS.has(w.font)) ensureFontDeclared(w.font);
        }
    }

    const newPage = document.createElement("div");
    newPage.className = "mushaf-page mushaf-page--enter-" + (direction === "left" ? "right" : direction === "right" ? "left" : "right");
    newPage.dataset.page = String(data.page);

    const inner = document.createElement("div");
    inner.className = "mushaf-page__inner";

    // Render lines, grouping word-type runs by verse_key so an entire ayah's
    // glyphs share one .mushaf-ayah parent (for highlight/audio/menu).
    for (const line of data.lines) {
        const lineEl = document.createElement("div");
        lineEl.className = "mushaf-line";

        // Detect special line types from the first word
        const first = line.words?.[0];
        const isSurahHeader = first?.type === "surah_header";
        const isBismillah = first?.type === "bismillah";
        if (isSurahHeader) lineEl.classList.add("mushaf-line--surah-header", "mushaf-line--center");
        else if (isBismillah) lineEl.classList.add("mushaf-line--bismillah", "mushaf-line--center");

        let currentAyahEl = null;
        let currentVerseKey = null;
        for (const w of line.words) {
            if (w.type === "surah_header") {
                // Header line content
                const span = document.createElement("span");
                span.className = "mushaf-word";
                span.style.fontFamily = `"${w.font}", serif`;
                span.textContent = w.char || w.text || "";
                lineEl.appendChild(span);
                continue;
            }
            if (w.type === "bismillah") {
                const span = document.createElement("span");
                span.className = "mushaf-word";
                span.style.fontFamily = `"${w.font}", serif`;
                span.textContent = w.char || w.text || "";
                lineEl.appendChild(span);
                continue;
            }

            const vk = w.verse_key || null;
            if (vk && vk !== currentVerseKey) {
                currentAyahEl = document.createElement("span");
                currentAyahEl.className = "mushaf-ayah";
                currentAyahEl.dataset.verseKey = vk;
                lineEl.appendChild(currentAyahEl);
                currentVerseKey = vk;
            }

            const wEl = document.createElement("span");
            wEl.className = w.type === "end" ? "mushaf-word mushaf-end" : "mushaf-word";
            wEl.style.fontFamily = `"${w.font}", serif`;
            wEl.textContent = w.char || w.text || "";
            // Tiny space between words (the QCF4 glyphs include their own spacing)
            if (currentAyahEl) currentAyahEl.appendChild(wEl);
            else lineEl.appendChild(wEl);
        }

        inner.appendChild(lineEl);
    }

    newPage.appendChild(inner);

    // Cross-fade swap: animate old out, new in
    const old = ACTIVE_PAGE_EL;
    PAGES_EL.appendChild(newPage);
    // Force reflow before transitioning in
    void newPage.offsetWidth;
    requestAnimationFrame(() => {
        newPage.classList.remove("mushaf-page--enter-right", "mushaf-page--enter-left");
        newPage.classList.add("mushaf-page--active");
        if (old) {
            old.classList.remove("mushaf-page--active");
            old.classList.add(direction === "left" ? "mushaf-page--exit-right" : "mushaf-page--exit-left");
            setTimeout(() => old.remove(), 320);
        }
    });
    ACTIVE_PAGE_EL = newPage;

    // Per-ayah click handler (event delegation)
    newPage.addEventListener("click", onPageClick);
    // Re-apply audio highlight if currently playing one on this page
    if (AUDIO_VERSE) highlightAyah(AUDIO_VERSE, "playing");
}

function applyTargetHighlight() {
    if (!ACTIVE_PAGE_EL || !CURRENT_TARGET_VERSE) return;
    const el = ACTIVE_PAGE_EL.querySelector(`.mushaf-ayah[data-verse-key="${CSS.escape(CURRENT_TARGET_VERSE)}"]`);
    if (!el) return;
    el.classList.add("mushaf-ayah--target");
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    // Subtle pulse: remove highlight after 4s
    setTimeout(() => el.classList.remove("mushaf-ayah--target"), 4000);
}

/* ---------------- Ayah click / floating menu ---------------- */

function onPageClick(e) {
    const ayahEl = e.target.closest(".mushaf-ayah");
    if (!ayahEl) {
        closeAyahMenu();
        return;
    }
    const vk = ayahEl.dataset.verseKey;
    openAyahMenu(vk, ayahEl);
}

function wireAyahMenu() {
    if (!AYAH_MENU_EL) return;
    AYAH_MENU_EL.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-act]");
        if (!btn || !AYAH_MENU_VERSE) return;
        const act = btn.dataset.act;
        if (act === "play") {
            playMushafAyah(AYAH_MENU_VERSE);
        } else if (act === "tafsir") {
            const [s, a] = AYAH_MENU_VERSE.split(":").map(Number);
            DEPS?.openTafsirForAyah?.(s, a);
        } else if (act === "copy") {
            copyAyahText(AYAH_MENU_VERSE);
        }
        closeAyahMenu();
    });
    document.addEventListener("click", (e) => {
        if (!MUSHAF_MODE) return;
        if (e.target.closest(".mushaf-ayah") || e.target.closest(".mushaf-ayah-menu")) return;
        closeAyahMenu();
    });
}

function openAyahMenu(verseKey, ayahEl) {
    if (!AYAH_MENU_EL || !ayahEl) return;
    AYAH_MENU_VERSE = verseKey;
    const rect = ayahEl.getBoundingClientRect();
    const rootRect = ROOT_EL.getBoundingClientRect();
    // Show first to measure
    AYAH_MENU_EL.classList.add("mushaf-ayah-menu--open");
    const menuW = AYAH_MENU_EL.offsetWidth;
    const menuH = AYAH_MENU_EL.offsetHeight;
    let left = rect.left + rect.width / 2 - menuW / 2 - rootRect.left;
    let top = rect.bottom + 8 - rootRect.top;
    // Clamp into viewport
    const maxLeft = rootRect.width - menuW - 8;
    if (left < 8) left = 8;
    if (left > maxLeft) left = maxLeft;
    if (top + menuH > rootRect.height - 8) {
        top = rect.top - menuH - 8 - rootRect.top;
    }
    AYAH_MENU_EL.style.left = `${left}px`;
    AYAH_MENU_EL.style.top = `${top}px`;
    AYAH_MENU_EL.setAttribute("aria-hidden", "false");
}

function closeAyahMenu() {
    AYAH_MENU_EL?.classList.remove("mushaf-ayah-menu--open");
    AYAH_MENU_EL?.setAttribute("aria-hidden", "true");
    AYAH_MENU_VERSE = null;
}

function copyAyahText(verseKey) {
    const [s, a] = verseKey.split(":").map(Number);
    const text = getAyahPlainText(s, a);
    if (!text) return;
    try { navigator.clipboard?.writeText(text); } catch { }
}

function getAyahPlainText(s, a) {
    // Prefer QURAN (the existing dataset) for unicode text.
    const surah = DEPS?.quran?.surahs?.find((x) => x.number === s);
    const ayah = surah?.ayahs?.find((y) => y.numberInSurah === a);
    return ayah?.text || "";
}

/* ---------------- Audio playback ---------------- */

function buildAyahAudioUrl(s, a) {
    const reciter = DEPS?.getCurrentReciter?.() || "alijaber";
    const reciterPath = DEPS?.reciters?.[reciter]?.path || reciter;
    const ss = String(s).padStart(3, "0");
    const aa = String(a).padStart(3, "0");
    const base = DEPS?.audioBase || "https://storage.googleapis.com/recitations-bucket-data/audio/";
    return `${base}${reciterPath}/${ss}/${ss}${aa}.mp3`;
}

function playMushafAyah(verseKey) {
    if (!verseKey) return;
    stopMushafAudio(); // also clears previous highlight

    const [s, a] = verseKey.split(":").map(Number);
    const url = buildAyahAudioUrl(s, a);
    AUDIO_PLAYER = new Audio(url);
    AUDIO_VERSE = verseKey;
    document.documentElement.setAttribute("data-audio-active", "1");
    updateNowPlayingUI();
    highlightAyah(verseKey, "playing");

    AUDIO_PLAYER.addEventListener("ended", async () => {
        if (AUDIO_MODE === "continuous") {
            const next = await getNextVerseKey(verseKey);
            if (next) {
                // Ensure we're on the page that contains the next ayah
                const nextPage = VERSES_LOOKUP?.[next]?.page;
                if (nextPage && nextPage !== CURRENT_PAGE) {
                    await goToPage(nextPage, { direction: "left" });
                    history.replaceState({ mushaf: true, page: nextPage }, "", `/read/page/${nextPage}`);
                }
                playMushafAyah(next);
                return;
            }
        }
        stopMushafAudio();
    });
    AUDIO_PLAYER.addEventListener("error", () => stopMushafAudio());
    AUDIO_PLAYER.play().catch((e) => {
        console.error("Mushaf audio play failed", e);
        stopMushafAudio();
    });
}

function stopMushafAudio() {
    if (AUDIO_PLAYER) {
        try { AUDIO_PLAYER.pause(); } catch { }
        AUDIO_PLAYER = null;
    }
    if (AUDIO_VERSE) clearHighlight(AUDIO_VERSE);
    AUDIO_VERSE = null;
    document.documentElement.removeAttribute("data-audio-active");
    updateNowPlayingUI();
}

function highlightAyah(verseKey, kind) {
    if (!ACTIVE_PAGE_EL) return;
    const els = ACTIVE_PAGE_EL.querySelectorAll(`.mushaf-ayah[data-verse-key="${CSS.escape(verseKey)}"]`);
    els.forEach((e) => e.classList.add(`mushaf-ayah--${kind}`));
}

function clearHighlight(verseKey) {
    if (!ACTIVE_PAGE_EL) return;
    const els = ACTIVE_PAGE_EL.querySelectorAll(`.mushaf-ayah[data-verse-key="${CSS.escape(verseKey)}"]`);
    els.forEach((e) => e.classList.remove("mushaf-ayah--playing"));
}

async function getNextVerseKey(verseKey) {
    if (!verseKey) return null;
    const [s, a] = verseKey.split(":").map(Number);
    const ch = CHAPTERS?.find((c) => c.id === s);
    if (!ch) return null;
    if (a < ch.verses_count) return `${s}:${a + 1}`;
    // Move to next surah's first ayah
    const next = CHAPTERS.find((c) => c.id === s + 1);
    if (!next) return null;
    return `${next.id}:1`;
}

/* ---------------- Settings panel ---------------- */

function buildReciterButtons() {
    if (!SETTINGS_EL || !DEPS?.reciters) return;
    const row = SETTINGS_EL.querySelector('[data-settings-group="reciter"]');
    if (!row) return;
    row.innerHTML = (DEPS.reciterOrder || Object.keys(DEPS.reciters))
        .map((key) => {
            const r = DEPS.reciters[key];
            return `<button type="button" class="mushaf-settings__chip" data-val="${key}">${r.name}</button>`;
        })
        .join("");
}

function wireSettings() {
    if (!SETTINGS_EL) return;
    const cog = document.getElementById("mushafSettingsCog");
    cog?.addEventListener("click", (e) => {
        e.stopPropagation();
        SETTINGS_EL.classList.toggle("mushaf-settings--open");
    });
    document.addEventListener("click", (e) => {
        if (!SETTINGS_EL.contains(e.target)) {
            SETTINGS_EL.classList.remove("mushaf-settings--open");
        }
    });
    SETTINGS_EL.addEventListener("click", (e) => {
        const chip = e.target.closest(".mushaf-settings__chip");
        if (!chip) return;
        const group = chip.closest("[data-settings-group]")?.dataset.settingsGroup;
        const val = chip.dataset.val;
        if (group === "reciter") {
            DEPS?.setCurrentReciter?.(val);
            // If audio currently playing, restart on new reciter
            if (AUDIO_VERSE) {
                const v = AUDIO_VERSE;
                stopMushafAudio();
                playMushafAyah(v);
            }
        } else if (group === "audio-mode") {
            AUDIO_MODE = val === "continuous" ? "continuous" : "single";
            try { localStorage.setItem(STORAGE.AUDIO_MODE, AUDIO_MODE); } catch { }
        } else if (group === "font-size") {
            FONT_SIZE = ["s", "m", "l"].includes(val) ? val : "m";
            try { localStorage.setItem(STORAGE.FONT_SIZE, FONT_SIZE); } catch { }
            document.documentElement.setAttribute("data-font-size", FONT_SIZE);
        }
        syncSettingsUI();
    });

    document.getElementById("mushafNowPlayingBtn")?.addEventListener("click", () => {
        if (!AUDIO_PLAYER) return;
        if (AUDIO_PLAYER.paused) AUDIO_PLAYER.play();
        else AUDIO_PLAYER.pause();
        updateNowPlayingUI();
    });
}

function syncSettingsUI() {
    if (!SETTINGS_EL) return;
    SETTINGS_EL.querySelectorAll('[data-settings-group="reciter"] .mushaf-settings__chip').forEach((c) => {
        c.setAttribute("aria-checked", c.dataset.val === DEPS?.getCurrentReciter?.() ? "true" : "false");
    });
    SETTINGS_EL.querySelectorAll('[data-settings-group="audio-mode"] .mushaf-settings__chip').forEach((c) => {
        c.setAttribute("aria-checked", c.dataset.val === AUDIO_MODE ? "true" : "false");
    });
    SETTINGS_EL.querySelectorAll('[data-settings-group="font-size"] .mushaf-settings__chip').forEach((c) => {
        c.setAttribute("aria-checked", c.dataset.val === FONT_SIZE ? "true" : "false");
    });
}

function updateNowPlayingUI() {
    if (!NOW_PLAYING_EL) return;
    const reciter = DEPS?.getCurrentReciter?.() || "alijaber";
    const name = DEPS?.reciters?.[reciter]?.name || "";
    const nameEl = NOW_PLAYING_EL.querySelector(".mushaf-now-playing__name");
    if (nameEl) nameEl.textContent = name || "—";
    const btn = document.getElementById("mushafNowPlayingBtn");
    if (btn) {
        const isPaused = !AUDIO_PLAYER || AUDIO_PLAYER.paused;
        btn.innerHTML = isPaused
            ? `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 4l14 8-14 8z"/></svg>`
            : `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>`;
    }
}

/* ---------------- Idle chrome fade ---------------- */

function setupIdleTracker() {
    const reset = () => {
        document.documentElement.removeAttribute("data-mushaf-idle");
        clearTimeout(IDLE_TIMER);
        IDLE_TIMER = setTimeout(() => {
            if (MUSHAF_MODE) document.documentElement.setAttribute("data-mushaf-idle", "1");
        }, 3000);
    };
    ["mousemove", "touchstart", "keydown", "scroll"].forEach((evt) => {
        document.addEventListener(evt, reset, { passive: true });
    });
    reset();
}

/* ---------------- SEO ---------------- */

function updateMushafSeo({ page, surah, verse } = {}) {
    let title = `قراءة المصحف — صفحة ${page} | محمديات`;
    if (verse) {
        const [s, a] = verse.split(":").map(Number);
        const surahName = chapterArabicName(s);
        title = `قراءة سورة ${surahName} آية ${a} في المصحف | محمديات`;
    } else if (surah) {
        const surahName = chapterArabicName(Number(surah));
        title = `قراءة سورة ${surahName} في المصحف | محمديات`;
    }
    document.title = title;
    const canonical = document.getElementById("canonicalLink");
    let url = `https://www.m7mdiyat.com/read/page/${page}`;
    if (verse) url = `https://www.m7mdiyat.com/read/ayah/${verse.replace(":", "/")}`;
    else if (surah) url = `https://www.m7mdiyat.com/read/surah/${surah}`;
    canonical?.setAttribute("href", url);
    document.getElementById("ogUrl")?.setAttribute("content", url);
    document.getElementById("ogTitle")?.setAttribute("content", title);
    document.getElementById("twTitle")?.setAttribute("content", title);
}

function chapterArabicName(s) {
    const ch = CHAPTERS?.find((c) => c.id === s);
    if (ch?.name_arabic) return ch.name_arabic;
    const fromMeta = DEPS?.surahMeta?.find((x) => x.number === s);
    return fromMeta?.name_ar || `${s}`;
}

/* Build the shell as soon as the module loads — this matters for first-paint
   when the URL is /read/* (the early-routing script set data-app-mode="mushaf"
   already, so the .mushaf-root element needs to exist immediately so the user
   doesn't see a flash of blank page while app data loads). */
function bootstrapShell() {
    if (document.body) buildShell();
    else document.addEventListener("DOMContentLoaded", buildShell);
    // On direct /read/* loads, kick off metadata + target page fetch immediately
    // so the page is ready by the time initMushaf wires DEPS.
    if (window._mushafInit) {
        ensureMetaLoaded();
        const m = window._mushafInit;
        if (m.page) fetchPage(m.page).catch(() => { });
    }
}
bootstrapShell();
