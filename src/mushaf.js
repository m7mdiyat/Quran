/*
 * Mushaf reading mode — Madinah Mushaf 1441 AH (QCF4).
 *
 * UX model:
 *   - Inline panel that sits in the same DOM slot as #tafsirSection.
 *   - Mutually exclusive with the Tafsir view.
 *   - The mode toggle is bidirectional and panel-reopening: toggling
 *     into Mushaf at any time re-shows the panel for the currently
 *     selected ayah (LAST_VIEWED_AYAH || DEPS.getCurrentAyah()).
 *   - Single click on an ayah plays its audio; hover (desktop) or
 *     long-press (mobile) opens a 3-button floating menu (Play,
 *     Tafsir, Settings). The settings popover lives inside the menu.
 *   - Selecting Quran text and copying produces clean Unicode text
 *     (from quran.json), not QCF4 PUA glyphs.
 *   - The "target surah" is rendered at full opacity; other surahs
 *     on the same page are dimmed and non-interactive.
 */

"use strict";

const STORAGE = {
    MODE: "app_mode",
    LAST_PAGE: "mushaf_last_page",
    FONT_SIZE: "mushaf_font_size",
    AUDIO_MODE: "mushaf_audio_mode",
};

const TOTAL_PAGES = 604;
const LONG_PRESS_MS = 500;
const HOVER_SHOW_MS = 150;
const HOVER_HIDE_MS = 140;
const SWIPE_THRESHOLD = 50;
const MOVE_CANCEL_THRESHOLD = 10;

/* SVG icon set — Lucide-derived, currentColor, stroke 1.8, 24px viewbox. */
const ICONS = {
    bookOpen: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3H8a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 4.5A1.5 1.5 0 0 0 20.5 3H16a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>`,
    bookMarked: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4a2 2 0 0 1 2-2h11v18H7a2 2 0 0 0-2 2z"/><path d="M14 2v8l-2.5-1.5L9 10V2"/></svg>`,
    play: `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M7 4.5v15a.75.75 0 0 0 1.15.633l12-7.5a.75.75 0 0 0 0-1.266l-12-7.5A.75.75 0 0 0 7 4.5z"/></svg>`,
    pause: `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="4.5" width="4" height="15" rx="1"/><rect x="14" y="4.5" width="4" height="15" rx="1"/></svg>`,
    gear: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9 1.65 1.65 0 0 0 4.27 7.18l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
    chevronRight: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>`,
    chevronLeft: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>`,
};

/* Data caches */
const PAGE_CACHE = new Map();
const PAGE_INFLIGHT = new Map();
const LOADED_FONTS = new Set(["QCF4_QBSML", "QCF4_Hafs_01"]);
let VERSES_LOOKUP = null;
let FONT_MAP = null;
let CHAPTERS = null;
let META_READY = null;

/* Runtime state */
let DEPS = null;
let MUSHAF_MODE = false;
let PANEL_OPEN = false;
let CURRENT_PAGE = 0;
let CURRENT_TARGET_VERSE = null;  // "s:a" — initial highlight on next render
let TARGET_SURAH = null;          // surah id whose ayahs render at full opacity
let LAST_VIEWED_AYAH = null;      // {s, a} — drives toggle restore in both directions

let ROOT_EL = null;
let PAGES_EL = null;
let ACTIVE_PAGE_EL = null;
let AYAH_MENU_EL = null;
let AYAH_MENU_VERSE = null;
let AYAH_MENU_ANCHOR = null;      // the .mushaf-ayah currently anchoring the menu
let NAV_PREV = null;
let NAV_NEXT = null;

/* Audio state */
let AUDIO_PLAYER = null;
let AUDIO_VERSE = null;
let AUDIO_MODE = "single";
let FONT_SIZE = "m";
let CURRENT_RECITER_LOCAL = null; // cached reciter for stable comparisons

/* Hover/long-press timers */
let HOVER_SHOW_TIMER = null;
let HOVER_HIDE_TIMER = null;
let LONG_PRESS_TIMER = null;
let LONG_PRESS_FIRED = false;
let TOUCH_START = null; // {x, y, target}
let TOUCH_MOVED = false;

/* ============================================================
 * Public API
 * ============================================================ */

export function initMushaf(deps) {
    DEPS = deps;

    try {
        const fs = localStorage.getItem(STORAGE.FONT_SIZE);
        if (fs === "s" || fs === "m" || fs === "l") FONT_SIZE = fs;
        const am = localStorage.getItem(STORAGE.AUDIO_MODE);
        if (am === "single" || am === "continuous") AUDIO_MODE = am;
    } catch { }

    buildShell();

    let saved = "tafsir";
    try {
        const v = localStorage.getItem(STORAGE.MODE);
        if (v === "mushaf" || v === "tafsir") saved = v;
    } catch { }
    MUSHAF_MODE = saved === "mushaf";
    document.documentElement.setAttribute("data-app-mode", saved);
    document.documentElement.setAttribute("data-font-size", FONT_SIZE);

    document.querySelectorAll("[data-mode-toggle]").forEach((btn) => {
        btn.addEventListener("click", () => {
            setAppMode(MUSHAF_MODE ? "tafsir" : "mushaf");
        });
    });

    document.addEventListener("keydown", onKeyDown);

    return {
        setAppMode, openMushafAtAyah, openMushafAtPage,
        openMushafAtSurah, isMushafMode, closeMushafPanel,
    };
}

export function isMushafMode() {
    return MUSHAF_MODE;
}

/**
 * Toggle mode. Pure routing-preference except for two side effects:
 *   - Toggle OFF while panel is visible → hide panel, restore tafsir
 *     for the last viewed ayah, replaceState the URL to /S/A.
 *   - Toggle ON while a selected ayah exists (from either mode) →
 *     open the panel inline at that ayah.
 */
export function setAppMode(mode) {
    const wanted = mode === "mushaf" ? "mushaf" : "tafsir";
    if ((wanted === "mushaf") === MUSHAF_MODE) return;

    MUSHAF_MODE = wanted === "mushaf";
    document.documentElement.setAttribute("data-app-mode", wanted);
    try { localStorage.setItem(STORAGE.MODE, wanted); } catch { }

    if (wanted === "tafsir") {
        if (PANEL_OPEN) {
            const target = LAST_VIEWED_AYAH || DEPS?.getCurrentAyah?.();
            closePanel();
            if (target && DEPS?.openTafsirForAyah) {
                DEPS.openTafsirForAyah(target.s, target.a);
                history.replaceState({ s: target.s, a: target.a }, "", `/${target.s}/${target.a}`);
            }
        }
        return;
    }

    // wanted === "mushaf" — open the panel at the currently selected ayah.
    const fromTafsir = DEPS?.getCurrentAyah?.();
    const target = LAST_VIEWED_AYAH || fromTafsir || null;
    if (target) {
        openMushafAtAyah(target.s, target.a);
    }
    // If no ayah has ever been selected, do nothing — wait for first click.
}

export function closeMushafPanel() {
    if (PANEL_OPEN) closePanel();
}

export async function openMushafAtAyah(s, a, opts = {}) {
    await ensureMetaLoaded();
    const key = `${s}:${a}`;
    const entry = VERSES_LOOKUP?.[key];
    const page = entry?.page || 1;
    CURRENT_TARGET_VERSE = key;
    TARGET_SURAH = Number(s);
    LAST_VIEWED_AYAH = { s: Number(s), a: Number(a) };
    openPanel();
    await goToPage(page, { direction: "none" });
    if (opts.updateUrl !== false) {
        history.pushState({ mushaf: true, page, target: key }, "", `/read/ayah/${s}/${a}`);
    }
    updateMushafSeo({ page, verse: key });
}

export async function openMushafAtPage(p, opts = {}) {
    await ensureMetaLoaded();
    p = Math.max(1, Math.min(TOTAL_PAGES, Number(p) || 1));
    CURRENT_TARGET_VERSE = null;
    // Target surah will be set to first surah on page after render.
    TARGET_SURAH = null;
    openPanel();
    await goToPage(p, { direction: "none" });
    if (opts.updateUrl !== false) {
        history.pushState({ mushaf: true, page: p }, "", `/read/page/${p}`);
    }
    updateMushafSeo({ page: p });
}

export async function openMushafAtSurah(s, opts = {}) {
    await ensureMetaLoaded();
    const ch = CHAPTERS?.find((c) => c.id === Number(s));
    const page = ch?.pages?.[0] || 1;
    CURRENT_TARGET_VERSE = `${s}:1`;
    TARGET_SURAH = Number(s);
    LAST_VIEWED_AYAH = { s: Number(s), a: 1 };
    openPanel();
    await goToPage(page, { direction: "none" });
    if (opts.updateUrl !== false) {
        history.pushState({ mushaf: true, page, surah: Number(s) }, "", `/read/surah/${s}`);
    }
    updateMushafSeo({ page, surah: Number(s) });
}

/* ============================================================
 * Panel open/close + mutual exclusion with Tafsir view
 * ============================================================ */

function openPanel() {
    if (!ROOT_EL) buildShell();
    if (PANEL_OPEN) return;
    PANEL_OPEN = true;
    ROOT_EL.classList.add("is-open");
    const wrapper = ROOT_EL.parentElement;
    if (wrapper) wrapper.classList.add("has-mushaf");
    if (DEPS?.tafsirSectionEl) DEPS.tafsirSectionEl.classList.add("hidden");
}

function closePanel() {
    if (!PANEL_OPEN) return;
    PANEL_OPEN = false;
    ROOT_EL?.classList.remove("is-open");
    const wrapper = ROOT_EL?.parentElement;
    if (wrapper) wrapper.classList.remove("has-mushaf");
    if (DEPS?.tafsirSectionEl) {
        if (DEPS?.hasCurrentAyah?.()) DEPS.tafsirSectionEl.classList.remove("hidden");
    }
    stopMushafAudio();
    closeAyahMenu();
}

/* ============================================================
 * Data + font loading
 * ============================================================ */

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
    try { return await p; }
    finally { PAGE_INFLIGHT.delete(pageNo); }
}

function ensureFontDeclared(fontFamily) {
    if (LOADED_FONTS.has(fontFamily)) return;
    const fileName = fontFamily === "QCF4_QBSML" ? "QCF4_QBSML.woff2" : `${fontFamily}_W.woff2`;
    const css = `@font-face { font-family: "${fontFamily}"; src: url("/fonts/qcf4/${fileName}") format("woff2"); font-display: block; }`;
    const style = document.createElement("style");
    style.dataset.qcf4Font = fontFamily;
    style.textContent = css;
    document.head.appendChild(style);
    LOADED_FONTS.add(fontFamily);
}

/* ============================================================
 * Shell construction (inline panel — NO top bar, NO floating cog)
 * ============================================================ */

function buildShell() {
    if (document.getElementById("mushafRoot")) {
        ROOT_EL = document.getElementById("mushafRoot");
        PAGES_EL = document.getElementById("mushafPages");
        AYAH_MENU_EL = document.getElementById("mushafAyahMenu");
        NAV_PREV = document.getElementById("mushafPrev");
        NAV_NEXT = document.getElementById("mushafNext");
        return;
    }

    const tafsirSection = document.getElementById("tafsirSection");
    const wrapper = tafsirSection?.parentElement;
    if (!wrapper) return;

    const root = document.createElement("section");
    root.id = "mushafRoot";
    root.className = "mushaf-root glass rounded-3xl p-6";
    root.dir = "rtl";
    root.setAttribute("aria-label", "قارئ المصحف");
    root.innerHTML = `
    <div class="mushaf-stage">
      <button type="button" class="mushaf-nav mushaf-nav--prev" id="mushafPrev" aria-label="الصفحة السابقة">${ICONS.chevronLeft}</button>
      <div class="mushaf-pages" id="mushafPages"></div>
      <button type="button" class="mushaf-nav mushaf-nav--next" id="mushafNext" aria-label="الصفحة التالية">${ICONS.chevronRight}</button>
    </div>

    <!-- Ayah floating menu: two views (main / settings) -->
    <div class="mushaf-ayah-menu" id="mushafAyahMenu" data-view="main" role="menu" aria-hidden="true">
      <div class="mushaf-ayah-menu__main">
        <button type="button" class="mushaf-ayah-menu__btn" data-act="play" aria-label="استمع للآية">${ICONS.play}</button>
        <button type="button" class="mushaf-ayah-menu__btn" data-act="tafsir" aria-label="افتح التفسير">${ICONS.bookOpen}</button>
        <button type="button" class="mushaf-ayah-menu__btn" data-act="settings" aria-label="إعدادات">${ICONS.gear}</button>
      </div>
      <div class="mushaf-ayah-menu__settings">
        <div class="mushaf-settings__row" data-settings-group="reciter"></div>
        <div class="mushaf-settings__row" data-settings-group="audio-mode">
          <button type="button" class="mushaf-settings__chip" data-val="single">آية</button>
          <button type="button" class="mushaf-settings__chip" data-val="continuous">متواصل</button>
        </div>
        <div class="mushaf-settings__row" data-settings-group="font-size">
          <button type="button" class="mushaf-settings__chip" data-val="s">ص</button>
          <button type="button" class="mushaf-settings__chip" data-val="m">و</button>
          <button type="button" class="mushaf-settings__chip" data-val="l">ك</button>
        </div>
      </div>
    </div>
  `;
    wrapper.appendChild(root);

    ROOT_EL = root;
    PAGES_EL = document.getElementById("mushafPages");
    AYAH_MENU_EL = document.getElementById("mushafAyahMenu");
    NAV_PREV = document.getElementById("mushafPrev");
    NAV_NEXT = document.getElementById("mushafNext");

    wireNav();
    wireMenu();
    wirePageSwipe();
    wireCopy();
    buildReciterChips();
    syncSettingsUI();
}

/* ============================================================
 * Page navigation (these DO update the URL)
 * ============================================================ */

function wireNav() {
    NAV_PREV?.addEventListener("click", () => goPrev());
    NAV_NEXT?.addEventListener("click", () => goNext());
}

function goPrev() {
    if (CURRENT_PAGE <= 1) return;
    CURRENT_TARGET_VERSE = null;
    const target = CURRENT_PAGE - 1;
    goToPage(target, { direction: "right" });
    history.pushState({ mushaf: true, page: target }, "", `/read/page/${target}`);
    updateMushafSeo({ page: target });
}

function goNext() {
    if (CURRENT_PAGE >= TOTAL_PAGES) return;
    CURRENT_TARGET_VERSE = null;
    const target = CURRENT_PAGE + 1;
    goToPage(target, { direction: "left" });
    history.pushState({ mushaf: true, page: target }, "", `/read/page/${target}`);
    updateMushafSeo({ page: target });
}

function onKeyDown(e) {
    if (!PANEL_OPEN) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
    if (e.key === "ArrowLeft") { e.preventDefault(); goNext(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); goPrev(); }
    else if (e.key === "PageDown") { e.preventDefault(); goNext(); }
    else if (e.key === "PageUp") { e.preventDefault(); goPrev(); }
    else if (e.key === "Escape") { closeAyahMenu(); }
}

function wirePageSwipe() {
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
        if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dx) < Math.abs(dy)) return;
        if (dx > 0) goPrev(); else goNext();
    }, { passive: true });
}

async function goToPage(p, { direction = "none" } = {}) {
    await ensureMetaLoaded();
    if (p === CURRENT_PAGE && ACTIVE_PAGE_EL) {
        applyTargetHighlight();
        return;
    }
    try { localStorage.setItem(STORAGE.LAST_PAGE, String(p)); } catch { }

    try {
        const data = await fetchPage(p);

        // If there's no explicit target verse, the target surah is the
        // first surah present on the page.
        if (!CURRENT_TARGET_VERSE && data.surahs?.length) {
            TARGET_SURAH = data.surahs[0].id;
        }

        renderPage(data, direction);
        CURRENT_PAGE = p;
        updateNavDisabledState();
        prefetchAdjacent(p);
        applyTargetHighlight();

        if (CURRENT_TARGET_VERSE) {
            const [s, a] = CURRENT_TARGET_VERSE.split(":").map(Number);
            LAST_VIEWED_AYAH = { s, a };
        } else {
            // Last viewed = first verse of the target surah on this page,
            // falling back to the first verse on the page.
            const fv = findFirstVerseKeyForSurah(data, TARGET_SURAH) || findFirstVerseKey(data);
            if (fv) {
                const [s, a] = fv.split(":").map(Number);
                LAST_VIEWED_AYAH = { s, a };
            }
        }
    } catch (e) {
        console.error("Mushaf goToPage error:", e);
    }
}

function updateNavDisabledState() {
    if (NAV_PREV) NAV_PREV.disabled = CURRENT_PAGE <= 1;
    if (NAV_NEXT) NAV_NEXT.disabled = CURRENT_PAGE >= TOTAL_PAGES;
}

function prefetchAdjacent(p) {
    if (p > 1) fetchPage(p - 1).catch(() => { });
    if (p < TOTAL_PAGES) fetchPage(p + 1).catch(() => { });
}

function findFirstVerseKey(data) {
    for (const line of data.lines) {
        for (const w of line.words) {
            if (w.verse_key) return w.verse_key;
        }
    }
    return null;
}

function findFirstVerseKeyForSurah(data, surahId) {
    if (!surahId) return null;
    for (const line of data.lines) {
        for (const w of line.words) {
            if (!w.verse_key) continue;
            const [sStr] = w.verse_key.split(":");
            if (Number(sStr) === surahId) return w.verse_key;
        }
    }
    return null;
}

/* ============================================================
 * Page rendering
 *
 * Order of elements per surah on a page:
 *   1. clean surah name header (skipping QCF4 ornamental header line)
 *   2. bismillah line (only if it precedes verse 1 in the data — i.e.,
 *      not for Al-Fatihah and not for At-Tawbah)
 *   3. verse lines
 *
 * Non-target surahs are tagged with data-surah; CSS dims them.
 * ============================================================ */

function renderPage(data, direction = "none") {
    if (!PAGES_EL) return;

    ensureFontDeclared(data.font);
    for (const line of data.lines) {
        for (const w of line.words) {
            if (w.font && !LOADED_FONTS.has(w.font)) ensureFontDeclared(w.font);
        }
    }

    const newPage = document.createElement("div");
    newPage.className = "mushaf-page";
    newPage.dataset.page = String(data.page);
    if (TARGET_SURAH) newPage.dataset.targetSurah = String(TARGET_SURAH);
    if (direction !== "none") {
        newPage.classList.add("mushaf-page--animating");
        newPage.classList.add(direction === "left" ? "mushaf-page--enter-right" : "mushaf-page--enter-left");
    } else {
        newPage.classList.add("mushaf-page--active");
    }

    // Pre-scan: identify the *first verse key* of each surah on this page,
    // so we know exactly where to inject the clean surah header.
    const firstVerseKeyPerSurah = new Map();
    for (const line of data.lines) {
        for (const w of line.words) {
            if (!w.verse_key) continue;
            const [sStr] = w.verse_key.split(":");
            const sId = Number(sStr);
            if (!firstVerseKeyPerSurah.has(sId)) {
                firstVerseKeyPerSurah.set(sId, w.verse_key);
            }
        }
    }

    let renderedSurahHeaderFor = new Set();
    let pendingBismillah = null; // bismillah-line waiting for the next surah header

    for (let li = 0; li < data.lines.length; li++) {
        const line = data.lines[li];
        const first = line.words?.[0];
        const isSurahHeaderLine = first?.type === "surah_header";
        const isBismillahLine = first?.type === "bismillah";

        // Skip QCF4 ornamental surah_header lines entirely.
        if (isSurahHeaderLine) continue;

        // Buffer bismillah; we emit it AFTER the next surah header.
        if (isBismillahLine) {
            pendingBismillah = line;
            continue;
        }

        const firstVerseInLine = line.words.find((w) => w.verse_key)?.verse_key;
        if (firstVerseInLine) {
            const [sStr] = firstVerseInLine.split(":");
            const sId = Number(sStr);

            const isFirstVerseOfSurahOnPage = firstVerseKeyPerSurah.get(sId) === firstVerseInLine;
            const isContinuationFirstSurah = renderedSurahHeaderFor.size === 0;

            if (!renderedSurahHeaderFor.has(sId) && (isFirstVerseOfSurahOnPage || isContinuationFirstSurah)) {
                newPage.appendChild(buildSurahHeader(sId));
                renderedSurahHeaderFor.add(sId);

                // Emit pending bismillah after the header.
                if (pendingBismillah) {
                    newPage.appendChild(buildLineElement(pendingBismillah, sId));
                    pendingBismillah = null;
                }
            }
        }

        // Determine the surah this line belongs to (for data-surah tagging).
        const lineSurahId = firstVerseInLine ? Number(firstVerseInLine.split(":")[0]) : null;
        newPage.appendChild(buildLineElement(line, lineSurahId));
    }

    // Page-number footer
    const footer = document.createElement("div");
    footer.className = "mushaf-page-footer";
    footer.textContent = `صفحة ${data.page}`;
    newPage.appendChild(footer);

    // Swap with animation
    const old = ACTIVE_PAGE_EL;
    PAGES_EL.appendChild(newPage);

    if (direction !== "none") {
        void newPage.offsetWidth;
        requestAnimationFrame(() => {
            newPage.classList.remove("mushaf-page--enter-right", "mushaf-page--enter-left");
            newPage.classList.add("mushaf-page--active");
            if (old) {
                old.classList.add("mushaf-page--animating");
                old.classList.remove("mushaf-page--active");
                old.classList.add(direction === "left" ? "mushaf-page--exit-right" : "mushaf-page--exit-left");
                setTimeout(() => old.remove(), 320);
            }
            setTimeout(() => newPage.classList.remove("mushaf-page--animating"), 320);
        });
    } else {
        if (old) old.remove();
    }

    ACTIVE_PAGE_EL = newPage;
    wireAyahInteractions(newPage);
    if (AUDIO_VERSE) highlightAyah(AUDIO_VERSE, "playing");
}

function buildSurahHeader(surahId) {
    const ch = CHAPTERS?.find((c) => c.id === surahId);
    const name = ch?.name_arabic || `${surahId}`;
    const wrap = document.createElement("div");
    wrap.className = "mushaf-surah-header";
    if (TARGET_SURAH && surahId !== TARGET_SURAH) {
        wrap.classList.add("mushaf-surah-header--dimmed");
    }
    wrap.dataset.surah = String(surahId);
    wrap.textContent = name;
    return wrap;
}

function buildLineElement(line, lineSurahId) {
    const lineEl = document.createElement("div");
    lineEl.className = "mushaf-line";
    if (line.words?.[0]?.type === "bismillah") {
        lineEl.classList.add("mushaf-line--bismillah");
        // Dim the bismillah if it belongs to a non-target surah.
        if (TARGET_SURAH && lineSurahId && lineSurahId !== TARGET_SURAH) {
            lineEl.classList.add("mushaf-line--dimmed");
        }
    }
    if (lineSurahId) lineEl.dataset.surah = String(lineSurahId);

    let currentAyahEl = null;
    let currentVerseKey = null;
    for (const w of line.words) {
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
            const sId = Number(vk.split(":")[0]);
            currentAyahEl.dataset.surah = String(sId);
            if (TARGET_SURAH && sId !== TARGET_SURAH) {
                currentAyahEl.classList.add("mushaf-ayah--dimmed");
            }
            lineEl.appendChild(currentAyahEl);
            currentVerseKey = vk;
        }

        const wEl = document.createElement("span");
        wEl.className = w.type === "end" ? "mushaf-word mushaf-end" : "mushaf-word";
        wEl.style.fontFamily = `"${w.font}", serif`;
        wEl.textContent = w.char || w.text || "";
        if (currentAyahEl) currentAyahEl.appendChild(wEl);
        else lineEl.appendChild(wEl);
    }
    return lineEl;
}

function applyTargetHighlight() {
    if (!ACTIVE_PAGE_EL || !CURRENT_TARGET_VERSE) return;
    const el = ACTIVE_PAGE_EL.querySelector(`.mushaf-ayah[data-verse-key="${CSS.escape(CURRENT_TARGET_VERSE)}"]`);
    if (!el) return;
    el.classList.add("mushaf-ayah--target");
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => el.classList.remove("mushaf-ayah--target"), 4000);
}

/* ============================================================
 * Ayah interactions: single click → play, hover → menu (desktop),
 * long-press → menu (mobile). The menu DOES NOT intercept clicks
 * on the ayah itself — clicks always play.
 * ============================================================ */

function wireAyahInteractions(pageEl) {
    // Desktop: capture-phase mouseenter on the page; we delegate to ayah.
    pageEl.addEventListener("mouseover", (e) => {
        const ayah = e.target.closest(".mushaf-ayah");
        if (!ayah) return;
        if (isAyahNonInteractive(ayah)) return;
        scheduleMenuShow(ayah);
    });
    pageEl.addEventListener("mouseout", (e) => {
        const ayah = e.target.closest(".mushaf-ayah");
        if (!ayah) return;
        // Mouse may be entering the menu — relatedTarget tells us where it went.
        const to = e.relatedTarget;
        if (to && (AYAH_MENU_EL?.contains(to) || to.closest?.(".mushaf-ayah") === ayah)) return;
        scheduleMenuHide();
    });

    // Click → play (toggle if same ayah)
    pageEl.addEventListener("click", (e) => {
        const ayah = e.target.closest(".mushaf-ayah");
        if (!ayah) return;
        if (isAyahNonInteractive(ayah)) return;
        const vk = ayah.dataset.verseKey;
        toggleAudioForAyah(vk);
    });

    // Mobile: touchstart begins long-press timer; tap → play.
    pageEl.addEventListener("touchstart", (e) => {
        if (e.touches.length !== 1) return;
        const ayah = e.target.closest(".mushaf-ayah");
        if (!ayah) return;
        if (isAyahNonInteractive(ayah)) return;
        TOUCH_START = { x: e.touches[0].clientX, y: e.touches[0].clientY, target: ayah };
        TOUCH_MOVED = false;
        LONG_PRESS_FIRED = false;
        clearTimeout(LONG_PRESS_TIMER);
        LONG_PRESS_TIMER = setTimeout(() => {
            if (!TOUCH_MOVED) {
                LONG_PRESS_FIRED = true;
                showMenu(ayah);
            }
        }, LONG_PRESS_MS);
    }, { passive: true });

    pageEl.addEventListener("touchmove", (e) => {
        if (!TOUCH_START) return;
        const t = e.touches[0];
        const dx = t.clientX - TOUCH_START.x;
        const dy = t.clientY - TOUCH_START.y;
        if (Math.abs(dx) > MOVE_CANCEL_THRESHOLD || Math.abs(dy) > MOVE_CANCEL_THRESHOLD) {
            TOUCH_MOVED = true;
            clearTimeout(LONG_PRESS_TIMER);
        }
    }, { passive: true });

    pageEl.addEventListener("touchend", (e) => {
        clearTimeout(LONG_PRESS_TIMER);
        const start = TOUCH_START;
        TOUCH_START = null;
        if (!start) return;
        if (LONG_PRESS_FIRED || TOUCH_MOVED) return; // menu already shown, or swipe
        // Tap → play. preventDefault to suppress the synthetic click that
        // would otherwise fire next and re-trigger toggleAudio.
        const ayah = start.target;
        e.preventDefault();
        toggleAudioForAyah(ayah.dataset.verseKey);
    });
}

function isAyahNonInteractive(ayahEl) {
    if (!TARGET_SURAH) return false;
    return ayahEl.dataset.surah && Number(ayahEl.dataset.surah) !== TARGET_SURAH;
}

function scheduleMenuShow(ayah) {
    clearTimeout(HOVER_HIDE_TIMER);
    if (AYAH_MENU_ANCHOR === ayah && AYAH_MENU_EL?.classList.contains("mushaf-ayah-menu--open")) return;
    clearTimeout(HOVER_SHOW_TIMER);
    HOVER_SHOW_TIMER = setTimeout(() => showMenu(ayah), HOVER_SHOW_MS);
}

function scheduleMenuHide() {
    clearTimeout(HOVER_SHOW_TIMER);
    clearTimeout(HOVER_HIDE_TIMER);
    HOVER_HIDE_TIMER = setTimeout(() => {
        // Switch to main view when closing so next open is fresh
        AYAH_MENU_EL?.setAttribute("data-view", "main");
        closeAyahMenu();
    }, HOVER_HIDE_MS);
}

function wireMenu() {
    if (!AYAH_MENU_EL) return;

    // Keep menu open while mouse is inside
    AYAH_MENU_EL.addEventListener("mouseenter", () => clearTimeout(HOVER_HIDE_TIMER));
    AYAH_MENU_EL.addEventListener("mouseleave", () => scheduleMenuHide());

    AYAH_MENU_EL.addEventListener("click", (e) => {
        // Settings chip clicks
        const chip = e.target.closest(".mushaf-settings__chip");
        if (chip) {
            handleSettingsChip(chip);
            return;
        }
        const btn = e.target.closest("[data-act]");
        if (!btn || !AYAH_MENU_VERSE) return;
        const act = btn.dataset.act;
        if (act === "play") {
            toggleAudioForAyah(AYAH_MENU_VERSE);
        } else if (act === "tafsir") {
            const [s, a] = AYAH_MENU_VERSE.split(":").map(Number);
            LAST_VIEWED_AYAH = { s, a };
            setAppMode("tafsir");
        } else if (act === "settings") {
            // Toggle into the settings sub-view (don't close)
            const view = AYAH_MENU_EL.getAttribute("data-view") === "settings" ? "main" : "settings";
            AYAH_MENU_EL.setAttribute("data-view", view);
            // Reposition: settings view is wider.
            if (AYAH_MENU_ANCHOR) showMenu(AYAH_MENU_ANCHOR, { reposition: true });
            syncSettingsUI();
            return;
        } else {
            return;
        }
        closeAyahMenu();
    });

    // Click outside the menu closes it (mobile + edge cases).
    document.addEventListener("click", (e) => {
        if (!PANEL_OPEN) return;
        if (e.target.closest(".mushaf-ayah") || e.target.closest(".mushaf-ayah-menu")) return;
        closeAyahMenu();
    });
}

function showMenu(ayahEl, { reposition = false } = {}) {
    if (!AYAH_MENU_EL || !ayahEl) return;
    if (!reposition) {
        AYAH_MENU_VERSE = ayahEl.dataset.verseKey;
        AYAH_MENU_ANCHOR = ayahEl;
        AYAH_MENU_EL.setAttribute("data-view", "main");
        AYAH_MENU_EL.classList.add("mushaf-ayah-menu--open");
        AYAH_MENU_EL.setAttribute("aria-hidden", "false");
    }
    // Position
    const rect = ayahEl.getBoundingClientRect();
    const rootRect = ROOT_EL.getBoundingClientRect();
    const menuW = AYAH_MENU_EL.offsetWidth;
    const menuH = AYAH_MENU_EL.offsetHeight;
    let left = rect.left + rect.width / 2 - menuW / 2 - rootRect.left;
    let top = rect.bottom + 8 - rootRect.top;
    const maxLeft = rootRect.width - menuW - 8;
    if (left < 8) left = 8;
    if (left > maxLeft) left = maxLeft;
    if (top + menuH > rootRect.height - 8) {
        top = rect.top - menuH - 8 - rootRect.top;
    }
    AYAH_MENU_EL.style.left = `${left}px`;
    AYAH_MENU_EL.style.top = `${top}px`;
}

function closeAyahMenu() {
    clearTimeout(HOVER_SHOW_TIMER);
    clearTimeout(HOVER_HIDE_TIMER);
    AYAH_MENU_EL?.classList.remove("mushaf-ayah-menu--open");
    AYAH_MENU_EL?.setAttribute("aria-hidden", "true");
    AYAH_MENU_VERSE = null;
    AYAH_MENU_ANCHOR = null;
}

/* ============================================================
 * Audio playback (click on ayah toggles; settings live in menu)
 * ============================================================ */

function toggleAudioForAyah(verseKey) {
    if (!verseKey) return;
    if (AUDIO_VERSE === verseKey && AUDIO_PLAYER) {
        // Same ayah currently selected: toggle play/pause
        if (AUDIO_PLAYER.paused) {
            AUDIO_PLAYER.play().catch((e) => console.error("resume failed", e));
        } else {
            AUDIO_PLAYER.pause();
        }
        return;
    }
    playMushafAyah(verseKey);
}

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
    stopMushafAudio();
    const [s, a] = verseKey.split(":").map(Number);
    const url = buildAyahAudioUrl(s, a);
    AUDIO_PLAYER = new Audio(url);
    AUDIO_VERSE = verseKey;
    document.documentElement.setAttribute("data-audio-active", "1");
    highlightAyah(verseKey, "playing");

    AUDIO_PLAYER.addEventListener("ended", async () => {
        if (AUDIO_MODE === "continuous") {
            const next = getNextVerseKey(verseKey);
            if (next) {
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

function getNextVerseKey(verseKey) {
    if (!verseKey) return null;
    const [s, a] = verseKey.split(":").map(Number);
    const ch = CHAPTERS?.find((c) => c.id === s);
    if (!ch) return null;
    if (a < ch.verses_count) return `${s}:${a + 1}`;
    const next = CHAPTERS.find((c) => c.id === s + 1);
    if (!next) return null;
    return `${next.id}:1`;
}

/* ============================================================
 * Settings (inside the per-ayah menu)
 * ============================================================ */

function buildReciterChips() {
    if (!AYAH_MENU_EL || !DEPS?.reciters) return;
    const row = AYAH_MENU_EL.querySelector('[data-settings-group="reciter"]');
    if (!row) return;
    row.innerHTML = (DEPS.reciterOrder || Object.keys(DEPS.reciters))
        .map((key) => {
            const r = DEPS.reciters[key];
            return `<button type="button" class="mushaf-settings__chip" data-val="${key}">${r.name}</button>`;
        })
        .join("");
}

function handleSettingsChip(chip) {
    const group = chip.closest("[data-settings-group]")?.dataset.settingsGroup;
    const val = chip.dataset.val;
    if (group === "reciter") {
        DEPS?.setCurrentReciter?.(val);
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
}

function syncSettingsUI() {
    if (!AYAH_MENU_EL) return;
    const reciter = DEPS?.getCurrentReciter?.();
    AYAH_MENU_EL.querySelectorAll('[data-settings-group="reciter"] .mushaf-settings__chip').forEach((c) => {
        c.setAttribute("aria-checked", c.dataset.val === reciter ? "true" : "false");
    });
    AYAH_MENU_EL.querySelectorAll('[data-settings-group="audio-mode"] .mushaf-settings__chip').forEach((c) => {
        c.setAttribute("aria-checked", c.dataset.val === AUDIO_MODE ? "true" : "false");
    });
    AYAH_MENU_EL.querySelectorAll('[data-settings-group="font-size"] .mushaf-settings__chip').forEach((c) => {
        c.setAttribute("aria-checked", c.dataset.val === FONT_SIZE ? "true" : "false");
    });
}

/* ============================================================
 * Clean-text copy
 *
 * QCF4 renders Quran via PUA glyphs. When the user selects ayahs
 * and presses Cmd+C, we replace the clipboard text with the
 * standard Unicode text for each touched ayah (looked up via
 * DEPS.getAyahPlainText, which reads QURAN.json).
 * ============================================================ */

function wireCopy() {
    if (!ROOT_EL) return;
    ROOT_EL.addEventListener("copy", (e) => {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
        if (!ROOT_EL.contains(sel.anchorNode)) return;
        const range = sel.getRangeAt(0);
        const seen = new Set();
        const texts = [];
        ROOT_EL.querySelectorAll(".mushaf-ayah").forEach((el) => {
            if (!el.dataset.verseKey) return;
            if (seen.has(el.dataset.verseKey)) return;
            if (!range.intersectsNode(el)) return;
            seen.add(el.dataset.verseKey);
            const [s, a] = el.dataset.verseKey.split(":").map(Number);
            const clean = DEPS?.getAyahPlainText?.(s, a);
            if (clean) texts.push(clean);
        });
        if (!texts.length) return;
        e.clipboardData.setData("text/plain", texts.join(" "));
        e.preventDefault();
    });
}

/* ============================================================
 * SEO
 * ============================================================ */

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

/* ============================================================
 * Bootstrap
 * ============================================================ */
function bootstrapShell() {
    if (document.getElementById("tafsirSection")) {
        buildShell();
    } else if (document.body) {
        document.addEventListener("DOMContentLoaded", buildShell);
    } else {
        document.addEventListener("DOMContentLoaded", buildShell);
    }
    if (window._mushafInit) {
        ensureMetaLoaded();
        const m = window._mushafInit;
        if (m.page) fetchPage(m.page).catch(() => { });
    }
}
bootstrapShell();
