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
    VOLUME: "mushaf_volume",
};

const TOTAL_PAGES = 604;
const LONG_PRESS_MS = 500;
const HOVER_SHOW_MS = 150;
const HOVER_HIDE_MS = 350; // grace period: lets cursor travel ayah → menu without losing it
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
    volumeMute: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4z"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>`,
    volumeLow: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`,
    volumeHigh: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`,
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
let PLAYBACK_BAR_EL = null;
let PLAYBACK_LABEL_EL = null;
let PLAYBACK_PLAY_BTN = null;
let PLAYBACK_PREV_BTN = null;
let PLAYBACK_NEXT_BTN = null;
let PLAYBACK_HIDE_TIMER = null;

/* Audio state */
let AUDIO_PLAYER = null;
let AUDIO_VERSE = null;
let AUDIO_MODE = "single";
let AUDIO_VOLUME = 0.8;          // 0..1
let MUTED_PREV_VOLUME = 0.8;     // volume to restore when un-muting
let PRELOADED_AUDIO = null;      // { key, el } — eager next-ayah audio for continuous mode
let FONT_SIZE = "m";             // "s" (صغير) | "m" (عادي, default) — old "l" is migrated to "m"
let CURRENT_RECITER_LOCAL = null;

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
        if (fs === "s" || fs === "m") FONT_SIZE = fs;
        else if (fs === "l" || fs === "كبير") {
            // Migration: old "l" (large) no longer exists — map to "m".
            FONT_SIZE = "m";
            localStorage.setItem(STORAGE.FONT_SIZE, "m");
        }
        const am = localStorage.getItem(STORAGE.AUDIO_MODE);
        if (am === "single" || am === "continuous") AUDIO_MODE = am;
        const vol = parseFloat(localStorage.getItem(STORAGE.VOLUME));
        if (Number.isFinite(vol) && vol >= 0 && vol <= 1) {
            AUDIO_VOLUME = vol;
            if (vol > 0) MUTED_PREV_VOLUME = vol;
        }
    } catch { }

    buildShell();
    // The auto-bootstrap at module bottom may have run buildShell() before
    // DEPS existed, in which case the reciter row would be empty. Repopulate
    // it now that we have DEPS, and re-sync the active-state highlighting.
    buildReciterChips();
    syncSettingsUI();

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
export async function setAppMode(mode) {
    const wanted = mode === "mushaf" ? "mushaf" : "tafsir";
    if ((wanted === "mushaf") === MUSHAF_MODE) return;

    // Fix 6: stop any audio playing in BOTH modes before switching. The user
    // is changing context — audio should not bleed across the toggle.
    stopMushafAudio();
    try { DEPS?.stopAudio?.(); } catch { }

    MUSHAF_MODE = wanted === "mushaf";
    document.documentElement.setAttribute("data-app-mode", wanted);
    try { localStorage.setItem(STORAGE.MODE, wanted); } catch { }

    if (wanted === "tafsir") {
        if (PANEL_OPEN) {
            const target = LAST_VIEWED_AYAH || DEPS?.getCurrentAyah?.();
            await fadeOutPanel(ROOT_EL);
            // Stage the tafsir view at opacity 0 BEFORE unhiding it so the
            // transition from hidden→opacity-1 doesn't flash at full opacity.
            const tafsirEl = DEPS?.tafsirSectionEl;
            if (tafsirEl) tafsirEl.classList.add("mode-fade-in");
            closePanel();
            if (target && DEPS?.openTafsirForAyah) {
                DEPS.openTafsirForAyah(target.s, target.a);
                history.replaceState({ s: target.s, a: target.a }, "", `/${target.s}/${target.a}`);
            }
            commitFadeIn(tafsirEl);
        }
        return;
    }

    // wanted === "mushaf" — open the panel at the currently selected ayah.
    // ALWAYS prefer the tafsir's current ayah so switching modes shows the same ayah.
    const fromTafsir = DEPS?.getCurrentAyah?.();
    const target = fromTafsir || LAST_VIEWED_AYAH || null;
    if (target) {
        const tafsirEl = DEPS?.tafsirSectionEl;
        if (tafsirEl && !tafsirEl.classList.contains("hidden")) {
            await fadeOutPanel(tafsirEl);
        }
        // Stage the mushaf root at opacity 0 BEFORE openPanel removes display:none.
        ROOT_EL?.classList.add("mode-fade-in");
        // noScroll: the mode toggle must not move the viewport (Fix 3).
        await openMushafAtAyah(target.s, target.a, { noScroll: true });
        commitFadeIn(ROOT_EL);
    }
    // If no ayah has ever been selected, do nothing — wait for first click.
}

/* Fix 4: fade helpers used by setAppMode. We don't tear down the existing
 * panel-toggle logic — we just bracket it with opacity transitions. */
function fadeOutPanel(el) {
    if (!el) return Promise.resolve();
    return new Promise((resolve) => {
        el.classList.add("mode-fade-out");
        // Wait one frame so the class is applied, then resolve after transition.
        setTimeout(() => {
            el.classList.remove("mode-fade-out");
            resolve();
        }, 180);
    });
}

function commitFadeIn(el) {
    if (!el) return;
    // The caller is responsible for having already added `mode-fade-in`
    // BEFORE making the element visible. We only flush it back to opacity 1
    // here, after layout has settled with the staged opacity:0.
    requestAnimationFrame(() => {
        requestAnimationFrame(() => el.classList.remove("mode-fade-in"));
    });
    // Safety net in case the rAF chain misses (tab backgrounded, etc.)
    setTimeout(() => el.classList.remove("mode-fade-in"), 260);
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
    await goToPage(page, { direction: "none", noScroll: !!opts.noScroll });
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

export function preloadMushafData() {
    ensureMetaLoaded().then(() => {
        preloadFont("QCF4_Hafs_01");
        preloadFont("QCF4_QBSML");
    }).catch(() => { });
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

/**
 * Force the network to fetch a QCF4 font before it's actually used on a
 * rendered page, so navigating to that page doesn't pause for ~800KB.
 * Idempotent: if the font is already loaded or declared, this is a no-op
 * apart from the document.fonts.add().
 */
function preloadFont(fontFamily) {
    if (!fontFamily) return;
    ensureFontDeclared(fontFamily);
    if (typeof FontFace === "undefined" || !document.fonts) return;
    // Avoid duplicate FontFace registration
    for (const ff of document.fonts) {
        if (ff.family === fontFamily) return;
    }
    const fileName = fontFamily === "QCF4_QBSML" ? "QCF4_QBSML.woff2" : `${fontFamily}_W.woff2`;
    const face = new FontFace(fontFamily, `url("/fonts/qcf4/${fileName}") format("woff2")`);
    face.load().then((f) => {
        try { document.fonts.add(f); } catch { }
    }).catch(() => { });
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
        PLAYBACK_BAR_EL = null;
        PLAYBACK_LABEL_EL = null;
        PLAYBACK_PLAY_BTN = document.getElementById("mushafToolbarPlay");
        PLAYBACK_PREV_BTN = null;
        PLAYBACK_NEXT_BTN = null;
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
    <!-- Toolbar: Settings + Play/Stop -->
    <div class="mushaf-toolbar" id="mushafToolbar">
      <div class="mushaf-toolbar__btn-wrap" id="mushafSettingsWrap">
        <button type="button" class="mushaf-toolbar__btn mushaf-toolbar__btn--settings" id="mushafToolbarSettings" aria-label="إعدادات">${ICONS.gear}</button>
        <div class="mushaf-toolbar__dropdown mushaf-toolbar__dropdown--settings" id="mushafSettingsDropdown">
          <div class="mushaf-settings__section">
            <div class="mushaf-settings__label">القارئ</div>
            <div class="mushaf-settings__row mushaf-settings__row--pills" data-settings-group="reciter"></div>
          </div>
          <div class="mushaf-settings__section">
            <div class="mushaf-settings__label">حجم الخط</div>
            <div class="mushaf-settings__row" data-settings-group="font-size">
              <button type="button" class="mushaf-settings__chip" data-val="m">عادي</button>
              <button type="button" class="mushaf-settings__chip" data-val="s">صغير</button>
            </div>
          </div>
          <div class="mushaf-settings__section">
            <div class="mushaf-settings__label">طريقة التشغيل</div>
            <div class="mushaf-settings__row" data-settings-group="audio-mode">
              <button type="button" class="mushaf-settings__chip" data-val="single">آية واحدة</button>
              <button type="button" class="mushaf-settings__chip" data-val="continuous">تشغيل متواصل</button>
            </div>
          </div>
        </div>
      </div>
      <div class="mushaf-toolbar__btn-wrap" id="mushafPlayWrap">
        <button type="button" class="mushaf-toolbar__btn mushaf-toolbar__btn--play" id="mushafToolbarPlay" aria-label="تشغيل/إيقاف" data-playing="false">${ICONS.play}</button>
        <div class="mushaf-toolbar__dropdown mushaf-toolbar__dropdown--volume" id="mushafVolDropdown">
          <div class="mushaf-settings__section">
            <div class="mushaf-settings__label">مستوى الصوت</div>
            <div class="mushaf-toolbar__vol-row">
              <button type="button" class="mushaf-toolbar__vol-btn" id="mushafVolDown" aria-label="خفض"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19.5 12h-15"/></svg></button>
              <input type="range" id="mushafVolSlider" min="0" max="100" value="80" class="mushaf-toolbar__slider">
              <button type="button" class="mushaf-toolbar__vol-btn" id="mushafVolUp" aria-label="رفع"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4.5v15m7.5-7.5h-15"/></svg></button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="mushaf-stage">
      <button type="button" class="mushaf-nav mushaf-nav--prev" id="mushafPrev" aria-label="الصفحة السابقة">${ICONS.chevronRight}</button>
      <div class="mushaf-pages" id="mushafPages"></div>
      <button type="button" class="mushaf-nav mushaf-nav--next" id="mushafNext" aria-label="الصفحة التالية">${ICONS.chevronLeft}</button>
    </div>

    <!-- Ayah menu: tafsir only (settings moved to toolbar) -->
    <div class="mushaf-ayah-menu" id="mushafAyahMenu" data-view="main" role="menu" aria-hidden="true">
      <div class="mushaf-ayah-menu__main">
        <button type="button" class="mushaf-ayah-menu__btn" data-act="tafsir" aria-label="افتح التفسير">${ICONS.bookOpen}</button>
      </div>
    </div>
  `;
    wrapper.appendChild(root);

    ROOT_EL = root;
    PAGES_EL = document.getElementById("mushafPages");
    AYAH_MENU_EL = document.getElementById("mushafAyahMenu");
    NAV_PREV = document.getElementById("mushafPrev");
    NAV_NEXT = document.getElementById("mushafNext");
    PLAYBACK_BAR_EL = null;
    PLAYBACK_LABEL_EL = null;
    PLAYBACK_PLAY_BTN = document.getElementById("mushafToolbarPlay");
    PLAYBACK_PREV_BTN = null;
    PLAYBACK_NEXT_BTN = null;

    wireNav();
    wireMenu();
    wirePageSwipe();
    wireCopy();
    wireToolbar();
    buildReciterChips();
    syncSettingsUI();

    if (window.ResizeObserver) {
        new ResizeObserver(() => {
            if (PANEL_OPEN) autoFitFontSize();
        }).observe(PAGES_EL);
    }
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

async function goToPage(p, { direction = "none", noScroll = false } = {}) {
    await ensureMetaLoaded();
    if (p === CURRENT_PAGE && ACTIVE_PAGE_EL) {
        applyTargetHighlight({ noScroll });
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
        applyTargetHighlight({ noScroll });

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
    for (let d = 1; d <= 2; d++) {
        if (p - d >= 1) fetchPage(p - d).then((data) => preloadFont(data.font)).catch(() => { });
        if (p + d <= TOTAL_PAGES) fetchPage(p + d).then((data) => preloadFont(data.font)).catch(() => { });
    }
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

    // --- Page swap with @keyframes fade animation ---
    const old = ACTIVE_PAGE_EL;
    PAGES_EL.appendChild(newPage);

    if (direction !== "none" && old) {
        // New page fades in from 0% → 100% opacity
        newPage.classList.add("mushaf-page--fade-in");
        // Old page fades out and is removed when animation ends
        old.classList.add("mushaf-page--animating", "mushaf-page--fade-out");
        old.addEventListener("animationend", () => old.remove(), { once: true });
        // Safety fallback in case animationend doesn't fire
        setTimeout(() => { if (old.parentNode) old.remove(); }, 300);
    } else {
        // No animation needed (initial load or direct navigation)
        if (old) old.remove();
    }

    ACTIVE_PAGE_EL = newPage;
    wireAyahInteractions(newPage);
    if (AUDIO_VERSE) highlightAyah(AUDIO_VERSE, "playing");
    autoFitFontSize();
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
    wrap.innerHTML = `
      <span class="mushaf-surah-header__label">سورة</span>
      <span class="mushaf-surah-header__name">${name}</span>
    `;
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

function applyTargetHighlight({ noScroll = false } = {}) {
    if (!ACTIVE_PAGE_EL || !CURRENT_TARGET_VERSE) return;
    const els = ACTIVE_PAGE_EL.querySelectorAll(`.mushaf-ayah[data-verse-key="${CSS.escape(CURRENT_TARGET_VERSE)}"]`);
    if (!els.length) return;
    els.forEach((el) => el.classList.add("mushaf-ayah--target"));
    if (!noScroll) {
        els[0].scrollIntoView({ behavior: "smooth", block: "center" });
    }
    setTimeout(() => els.forEach((el) => el.classList.remove("mushaf-ayah--target")), 4000);
}

function autoFitFontSize() {
    if (!ACTIVE_PAGE_EL || !PAGES_EL) return;
    
    // Reset to CSS default so we can measure the natural unscaled width
    ACTIVE_PAGE_EL.style.removeProperty('--font-size');
    const containerWidth = PAGES_EL.clientWidth - 16; // 8px padding each side
    if (containerWidth <= 0) return;

    document.fonts.ready.then(() => {
        if (!ACTIVE_PAGE_EL) return;
        
        let maxLineWidth = 0;
        const lines = ACTIVE_PAGE_EL.querySelectorAll('.mushaf-line');
        lines.forEach((line) => {
            const width = line.scrollWidth;
            if (width > maxLineWidth) maxLineWidth = width;
        });

        if (maxLineWidth > 0) {
            const currentFontSizeStr = window.getComputedStyle(ACTIVE_PAGE_EL).getPropertyValue('--font-size');
            const baseFontSize = parseFloat(currentFontSizeStr) || 32;

            // Scale to fit exactly, minus 2% for anti-aliasing safety margin
            const scale = (containerWidth / maxLineWidth) * 0.98;
            
            let newSize = baseFontSize * scale;
            
            // Limit maximum font size so it doesn't get gigantic on wide desktop monitors
            if (newSize > 38) newSize = 38;
            
            ACTIVE_PAGE_EL.style.setProperty('--font-size', `${newSize}px`);
        }
    });
}

/* ============================================================
 * Ayah interactions: single click → play, hover → menu (desktop),
 * long-press → menu (mobile). The menu DOES NOT intercept clicks
 * on the ayah itself — clicks always play.
 * ============================================================ */

function wireAyahInteractions(pageEl) {
    // Desktop: hover only opens the menu for ayahs in the TARGET surah.
    // Clicking a non-target surah triggers a smooth focus switch (Fix 3),
    // so non-target ayahs are interactive but don't get the action menu.
    // Hover menu disabled — no popup on mouseover.

    // Click → either play (target surah) or smooth focus-switch (dimmed surah).
    pageEl.addEventListener("click", (e) => {
        const ayah = e.target.closest(".mushaf-ayah");
        const header = e.target.closest(".mushaf-surah-header");
        if (ayah) {
            if (isAyahDimmed(ayah)) {
                const sId = Number(ayah.dataset.surah);
                if (sId) transitionToTargetSurah(sId);
                return;
            }
            toggleAudioForAyah(ayah.dataset.verseKey);
            return;
        }
        if (header && header.classList.contains("mushaf-surah-header--dimmed")) {
            const sId = Number(header.dataset.surah);
            if (sId) transitionToTargetSurah(sId);
        }
    });

    // Mobile: long-press shows menu (only for target ayahs); tap plays / switches.
    pageEl.addEventListener("touchstart", (e) => {
        if (e.touches.length !== 1) return;
        const ayah = e.target.closest(".mushaf-ayah");
        if (!ayah) return;
        // Dimmed ayahs use the tap to switch surahs; no long-press menu.
        if (isAyahDimmed(ayah)) {
            TOUCH_START = { x: e.touches[0].clientX, y: e.touches[0].clientY, target: ayah, dimmed: true };
            TOUCH_MOVED = false;
            return;
        }
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
        const ayah = start.target;
        e.preventDefault();
        if (start.dimmed) {
            const sId = Number(ayah.dataset.surah);
            if (sId) transitionToTargetSurah(sId);
            return;
        }
        toggleAudioForAyah(ayah.dataset.verseKey);
    });
}

function isAyahDimmed(ayahEl) {
    if (!TARGET_SURAH) return false;
    return ayahEl.dataset.surah && Number(ayahEl.dataset.surah) !== TARGET_SURAH;
}

/* Fix 3: smoothly shift target-surah focus to `newSurahId`. Two phases:
 *   1) instantly toggle dim classes on the current page so the fade is visible
 *      to the user (CSS already animates opacity 250ms on these elements)
 *   2) navigate to the new surah's first page once the fade settles; if the
 *      first page is the current page, step 1 is the whole transition.
 */
async function transitionToTargetSurah(newSurahId) {
    if (!newSurahId || newSurahId === TARGET_SURAH) return;
    await ensureMetaLoaded();

    // Phase 1: re-tag dim classes on existing DOM.
    TARGET_SURAH = newSurahId;
    if (ACTIVE_PAGE_EL) {
        ACTIVE_PAGE_EL.dataset.targetSurah = String(newSurahId);
        ACTIVE_PAGE_EL.querySelectorAll(".mushaf-ayah").forEach((el) => {
            const sId = Number(el.dataset.surah);
            el.classList.toggle("mushaf-ayah--dimmed", !!sId && sId !== newSurahId);
        });
        ACTIVE_PAGE_EL.querySelectorAll(".mushaf-surah-header").forEach((el) => {
            const sId = Number(el.dataset.surah);
            el.classList.toggle("mushaf-surah-header--dimmed", !!sId && sId !== newSurahId);
        });
        ACTIVE_PAGE_EL.querySelectorAll(".mushaf-line--bismillah").forEach((el) => {
            const sId = Number(el.dataset.surah);
            el.classList.toggle("mushaf-line--dimmed", !!sId && sId !== newSurahId);
        });
    }

    // Phase 2: locate new surah's first page; navigate after the fade if needed.
    const ch = CHAPTERS?.find((c) => c.id === newSurahId);
    const firstPage = ch?.pages?.[0] || 1;
    LAST_VIEWED_AYAH = { s: newSurahId, a: 1 };

    history.pushState({ mushaf: true, page: firstPage, surah: newSurahId }, "", `/read/surah/${newSurahId}`);
    updateMushafSeo({ page: firstPage, surah: newSurahId });

    if (firstPage !== CURRENT_PAGE) {
        await new Promise((r) => setTimeout(r, 280));
        CURRENT_TARGET_VERSE = `${newSurahId}:1`;
        await goToPage(firstPage, { direction: "none" });
    }
    closeAyahMenu();
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
    AYAH_MENU_EL.addEventListener("mouseenter", () => clearTimeout(HOVER_HIDE_TIMER));
    AYAH_MENU_EL.addEventListener("mouseleave", () => scheduleMenuHide());
    AYAH_MENU_EL.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-act]");
        if (!btn || !AYAH_MENU_VERSE) return;
        if (btn.dataset.act === "tafsir") {
            const [s, a] = AYAH_MENU_VERSE.split(":").map(Number);
            LAST_VIEWED_AYAH = { s, a };
            setAppMode("tafsir");
            closeAyahMenu();
        }
    });
    document.addEventListener("click", (e) => {
        if (!PANEL_OPEN) return;
        if (e.target.closest(".mushaf-ayah") || e.target.closest(".mushaf-ayah-menu")) return;
        closeAyahMenu();
    });
}

/* ============================================================
 * Toolbar wiring — settings dropdown, play/stop, volume slider
 * ============================================================ */
function wireToolbar() {
    const settingsWrap = document.getElementById("mushafSettingsWrap");
    const settingsDD = document.getElementById("mushafSettingsDropdown");
    const settingsBtn = document.getElementById("mushafToolbarSettings");
    const playWrap = document.getElementById("mushafPlayWrap");
    const volDD = document.getElementById("mushafVolDropdown");
    const playBtn = document.getElementById("mushafToolbarPlay");

    // --- Settings dropdown hover ---
    if (settingsWrap && settingsDD) {
        let hideT = null;
        settingsWrap.addEventListener("mouseenter", () => { clearTimeout(hideT); settingsDD.classList.add("mushaf-toolbar__dropdown--open"); syncSettingsUI(); });
        settingsWrap.addEventListener("mouseleave", () => { clearTimeout(hideT); hideT = setTimeout(() => settingsDD.classList.remove("mushaf-toolbar__dropdown--open"), 350); });
        settingsBtn?.addEventListener("click", (e) => { e.stopPropagation(); settingsDD.classList.toggle("mushaf-toolbar__dropdown--open"); syncSettingsUI(); });
    }

    // --- Volume dropdown: shows only while audio is playing ---
    if (playWrap && volDD) {
        let volHideT = null;
        playWrap.addEventListener("mouseenter", () => {
            if (!AUDIO_VERSE) return; // only show when audio is active
            clearTimeout(volHideT);
            volDD.classList.add("mushaf-toolbar__dropdown--open");
        });
        playWrap.addEventListener("mouseleave", () => { clearTimeout(volHideT); volHideT = setTimeout(() => volDD.classList.remove("mushaf-toolbar__dropdown--open"), 350); });
    }

    // --- Play button click ---
    playBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        if (AUDIO_VERSE) toggleAudioForAyah(AUDIO_VERSE);
        else if (LAST_VIEWED_AYAH) toggleAudioForAyah(`${LAST_VIEWED_AYAH.s}:${LAST_VIEWED_AYAH.a}`);
    });

    // --- Volume slider + buttons ---
    const volSlider = document.getElementById("mushafVolSlider");
    const volDown = document.getElementById("mushafVolDown");
    const volUp = document.getElementById("mushafVolUp");
    if (volSlider) {
        volSlider.value = String(Math.round(AUDIO_VOLUME * 100));
        volSlider.addEventListener("input", () => applyVolume(Number(volSlider.value) / 100, { persist: true }));
    }
    volDown?.addEventListener("click", () => { const v = Math.max(0, AUDIO_VOLUME - 0.1); applyVolume(v, { persist: true }); if (volSlider) volSlider.value = String(Math.round(v * 100)); });
    volUp?.addEventListener("click", () => { const v = Math.min(1, AUDIO_VOLUME + 0.1); applyVolume(v, { persist: true }); if (volSlider) volSlider.value = String(Math.round(v * 100)); });

    // --- Chip clicks in settings dropdown ---
    settingsDD?.addEventListener("click", (e) => { const chip = e.target.closest(".mushaf-settings__chip"); if (chip) handleSettingsChip(chip); });

    // --- Close dropdowns on outside click ---
    document.addEventListener("click", (e) => {
        if (settingsWrap && !settingsWrap.contains(e.target)) settingsDD?.classList.remove("mushaf-toolbar__dropdown--open");
        if (playWrap && !playWrap.contains(e.target)) volDD?.classList.remove("mushaf-toolbar__dropdown--open");
    });
}

function setPlaybackPlayingState(playing) {
    if (!PLAYBACK_PLAY_BTN) return;
    PLAYBACK_PLAY_BTN.innerHTML = playing ? ICONS.pause : ICONS.play;
    PLAYBACK_PLAY_BTN.setAttribute("aria-label", playing ? "إيقاف" : "تشغيل");
    PLAYBACK_PLAY_BTN.setAttribute("data-playing", playing ? "true" : "false");
}

function toArabicDigits(n) {
    const map = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"];
    return String(n).split("").map((d) => /\d/.test(d) ? map[Number(d)] : d).join("");
}

function applyVolume(v, { persist = false, trackUnmute = true } = {}) {
    AUDIO_VOLUME = Math.max(0, Math.min(1, v));
    if (trackUnmute && AUDIO_VOLUME > 0) MUTED_PREV_VOLUME = AUDIO_VOLUME;
    if (AUDIO_PLAYER) AUDIO_PLAYER.volume = AUDIO_VOLUME;
    if (PRELOADED_AUDIO?.el) PRELOADED_AUDIO.el.volume = AUDIO_VOLUME;
    if (persist) {
        try { localStorage.setItem(STORAGE.VOLUME, String(AUDIO_VOLUME)); } catch { }
    }
    updateVolumeIcon();
}

function updateVolumeIcon() {
    const btn = document.getElementById("mushafVolumeIcon");
    if (!btn) return;
    const pct = AUDIO_VOLUME * 100;
    const icon = pct === 0
        ? ICONS.volumeMute
        : pct <= 50 ? ICONS.volumeLow : ICONS.volumeHigh;
    btn.innerHTML = icon;
    btn.setAttribute("aria-label", pct === 0 ? "إلغاء كتم الصوت" : "كتم الصوت");
    btn.classList.toggle("mushaf-volume-icon--muted", pct === 0);
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
    // Sync selected ayah to URL + state so tafsir tab picks it up
    const [vs, va] = verseKey.split(":").map(Number);
    if (Number.isFinite(vs) && Number.isFinite(va)) {
        LAST_VIEWED_AYAH = { s: vs, a: va };
        history.replaceState({ mushaf: true, page: CURRENT_PAGE, target: verseKey }, "", `/${vs}/${va}`);
    }
    if (AUDIO_VERSE === verseKey && AUDIO_PLAYER) {
        // Same ayah currently selected: toggle play/pause
        if (AUDIO_PLAYER.paused) {
            AUDIO_PLAYER.play().catch((e) => console.error("resume failed", e));
            setPlaybackPlayingState(true);
        } else {
            AUDIO_PLAYER.pause();
            setPlaybackPlayingState(false);
            // Stay visible while paused — only auto-hide on stop.
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

/* Fix 2: fetch+decode the next ayah's audio while the current one plays so
 * the cross-ayah gap in continuous mode is bounded by play()'s decode-already-
 * cached path (~10-50ms) instead of a cold fetch (~200-500ms). */
function preloadAyahAudio(verseKey) {
    if (!verseKey) return;
    if (PRELOADED_AUDIO?.key === verseKey) return;
    discardPreloadedAudio();
    const [s, a] = verseKey.split(":").map(Number);
    const url = buildAyahAudioUrl(s, a);
    const el = new Audio();
    el.preload = "auto";
    el.volume = AUDIO_VOLUME;
    el.src = url;
    try { el.load(); } catch { }
    PRELOADED_AUDIO = { key: verseKey, el };
}

function discardPreloadedAudio() {
    if (!PRELOADED_AUDIO) return;
    try {
        PRELOADED_AUDIO.el.pause();
        PRELOADED_AUDIO.el.removeAttribute("src");
        PRELOADED_AUDIO.el.load();
    } catch { }
    PRELOADED_AUDIO = null;
}

function playMushafAyah(verseKey) {
    if (!verseKey) return;

    // Pick up the preloaded element if it matches; otherwise build fresh.
    let nextAudio;
    if (PRELOADED_AUDIO?.key === verseKey) {
        nextAudio = PRELOADED_AUDIO.el;
        PRELOADED_AUDIO = null;
    } else {
        const [s, a] = verseKey.split(":").map(Number);
        nextAudio = new Audio(buildAyahAudioUrl(s, a));
    }
    nextAudio.volume = AUDIO_VOLUME;

    // Swap highlight FIRST — visual feedback should not wait on the network.
    if (AUDIO_VERSE && AUDIO_VERSE !== verseKey) clearHighlight(AUDIO_VERSE);
    const prevPlayer = AUDIO_PLAYER;
    AUDIO_PLAYER = nextAudio;
    AUDIO_VERSE = verseKey;
    document.documentElement.setAttribute("data-audio-active", "1");
    highlightAyah(verseKey, "playing");
    if (prevPlayer && prevPlayer !== nextAudio) {
        try { prevPlayer.pause(); } catch { }
    }

    // Reflect state on each play.
    setPlaybackPlayingState(true);
    nextAudio.addEventListener("play", () => setPlaybackPlayingState(true));
    nextAudio.addEventListener("pause", () => {
        if (AUDIO_PLAYER === nextAudio && !nextAudio.ended) setPlaybackPlayingState(false);
    });

    nextAudio.addEventListener("ended", async () => {
        if (AUDIO_MODE === "continuous") {
            const next = getNextVerseKey(verseKey);
            if (next) {
                const nextPage = VERSES_LOOKUP?.[next]?.page;
                if (nextPage && nextPage !== CURRENT_PAGE) {
                    // Instant page swap — no slide animation — so the audio
                    // gap stays under ~100ms even at page boundaries.
                    await goToPage(nextPage, { direction: "none" });
                    history.replaceState({ mushaf: true, page: nextPage }, "", `/read/page/${nextPage}`);
                }
                playMushafAyah(next);
                return;
            }
        }
        stopMushafAudio();
    });
    nextAudio.addEventListener("error", () => stopMushafAudio());
    nextAudio.play().catch((e) => {
        console.error("Mushaf audio play failed", e);
        stopMushafAudio();
    });

    // Eagerly fetch the successor while this ayah plays.
    if (AUDIO_MODE === "continuous") {
        const upcoming = getNextVerseKey(verseKey);
        if (upcoming) preloadAyahAudio(upcoming);
    } else {
        discardPreloadedAudio();
    }
}

function stopMushafAudio() {
    if (AUDIO_PLAYER) {
        try { AUDIO_PLAYER.pause(); } catch { }
        AUDIO_PLAYER = null;
    }
    discardPreloadedAudio();
    if (AUDIO_VERSE) clearHighlight(AUDIO_VERSE);
    AUDIO_VERSE = null;
    document.documentElement.removeAttribute("data-audio-active");
    setPlaybackPlayingState(false);
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

function getPrevVerseKey(verseKey) {
    if (!verseKey) return null;
    const [s, a] = verseKey.split(":").map(Number);
    if (a > 1) return `${s}:${a - 1}`;
    const prev = CHAPTERS?.find((c) => c.id === s - 1);
    if (!prev) return null;
    return `${prev.id}:${prev.verses_count}`;
}

/* ============================================================
 * Settings (inside the per-ayah menu)
 * ============================================================ */

function buildReciterChips() {
    if (!DEPS?.reciters) return;
    const dd = document.getElementById("mushafSettingsDropdown");
    if (!dd) return;
    const row = dd.querySelector('[data-settings-group="reciter"]');
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
        discardPreloadedAudio();
        if (AUDIO_VERSE) {
            const v = AUDIO_VERSE;
            stopMushafAudio();
            playMushafAyah(v);
        }
    } else if (group === "audio-mode") {
        AUDIO_MODE = val === "continuous" ? "continuous" : "single";
        try { localStorage.setItem(STORAGE.AUDIO_MODE, AUDIO_MODE); } catch { }
        if (AUDIO_MODE === "continuous" && AUDIO_VERSE) {
            const upcoming = getNextVerseKey(AUDIO_VERSE);
            if (upcoming) preloadAyahAudio(upcoming);
        } else {
            discardPreloadedAudio();
        }
    } else if (group === "font-size") {
        FONT_SIZE = (val === "s") ? "s" : "m";
        try { localStorage.setItem(STORAGE.FONT_SIZE, FONT_SIZE); } catch { }
        document.documentElement.setAttribute("data-font-size", FONT_SIZE);
    }
    syncSettingsUI();
}

function syncSettingsUI() {
    const dd = document.getElementById("mushafSettingsDropdown");
    if (!dd) return;
    const reciter = DEPS?.getCurrentReciter?.();
    dd.querySelectorAll('[data-settings-group="reciter"] .mushaf-settings__chip').forEach((c) => {
        c.setAttribute("aria-checked", c.dataset.val === reciter ? "true" : "false");
    });
    dd.querySelectorAll('[data-settings-group="audio-mode"] .mushaf-settings__chip').forEach((c) => {
        c.setAttribute("aria-checked", c.dataset.val === AUDIO_MODE ? "true" : "false");
    });
    dd.querySelectorAll('[data-settings-group="font-size"] .mushaf-settings__chip').forEach((c) => {
        c.setAttribute("aria-checked", c.dataset.val === FONT_SIZE ? "true" : "false");
    });
    // Sync volume slider
    const volSlider = document.getElementById("mushafVolSlider");
    if (volSlider) volSlider.value = String(Math.round(AUDIO_VOLUME * 100));
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
