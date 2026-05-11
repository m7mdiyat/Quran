/*
 * Mushaf reading mode — Madinah Mushaf 1441 AH (QCF4).
 *
 * UX model: the Mushaf is an INLINE panel that sits in the same DOM
 * slot as #tafsirSection. It is mutually exclusive with the Tafsir
 * view but otherwise lives inside the regular homepage layout.
 *
 * The toggle is a pure routing preference — it doesn't navigate, hide
 * UI, or change the URL. It only switches WHERE the next search-result
 * click goes:
 *   - Tafsir mode click → setPrimaryAyah (existing tafsir flow)
 *   - Mushaf mode click → opens this panel inline, hides #tafsirSection
 *
 * Direct loads of /read/page/N, /read/ayah/S/A, /read/surah/S open
 * the panel inline (search box and other chrome stay visible).
 *
 * Bridges:
 *   - initMushaf(deps) — wires the module to Quran data, reciter helpers,
 *     and Tafsir-side functions exposed by src/app.js
 *   - openMushafAtAyah(s,a) / openMushafAtPage(p) / openMushafAtSurah(s)
 *   - setAppMode("tafsir" | "mushaf") — toggle-only behavior
 *   - isMushafMode()
 */

"use strict";

const STORAGE = {
    MODE: "app_mode",
    LAST_PAGE: "mushaf_last_page",
    FONT_SIZE: "mushaf_font_size",
    AUDIO_MODE: "mushaf_audio_mode",
};

const TOTAL_PAGES = 604;

/* Data caches */
const PAGE_CACHE = new Map();
const PAGE_INFLIGHT = new Map();
const LOADED_FONTS = new Set(["QCF4_QBSML", "QCF4_Hafs_01"]); // declared in mushaf.css
let VERSES_LOOKUP = null;
let FONT_MAP = null;
let CHAPTERS = null;
let META_READY = null;

/* Runtime state */
let DEPS = null;
let MUSHAF_MODE = false;
let PANEL_OPEN = false;          // is the panel currently visible?
let CURRENT_PAGE = 0;            // last/currently rendered page in the panel
let CURRENT_TARGET_VERSE = null; // "s:a" — highlight on next render
let LAST_VIEWED_AYAH = null;     // {s, a} — used to restore Tafsir on toggle OFF

let ROOT_EL = null;
let PAGES_EL = null;
let ACTIVE_PAGE_EL = null;
let AYAH_MENU_EL = null;
let AYAH_MENU_VERSE = null;
let SETTINGS_EL = null;
let NOW_PLAYING_EL = null;
let NAV_PREV = null;
let NAV_NEXT = null;

/* Audio state (independent of Tafsir-mode audio in app.js) */
let AUDIO_PLAYER = null;
let AUDIO_VERSE = null;
let AUDIO_MODE = "single";
let FONT_SIZE = "m";

/* ============================================================
 * Public bridging
 * ============================================================ */

export function initMushaf(deps) {
    DEPS = deps;

    // Restore persisted prefs
    try {
        const fs = localStorage.getItem(STORAGE.FONT_SIZE);
        if (fs === "s" || fs === "m" || fs === "l") FONT_SIZE = fs;
        const am = localStorage.getItem(STORAGE.AUDIO_MODE);
        if (am === "single" || am === "continuous") AUDIO_MODE = am;
    } catch { }

    buildShell(); // idempotent — bootstrapShell() may have already run

    // Set initial mode from localStorage. The data-app-mode attr drives
    // only the toggle knob's CSS — it never hides any other UI.
    let saved = "tafsir";
    try {
        const v = localStorage.getItem(STORAGE.MODE);
        if (v === "mushaf" || v === "tafsir") saved = v;
    } catch { }
    MUSHAF_MODE = saved === "mushaf";
    document.documentElement.setAttribute("data-app-mode", saved);
    document.documentElement.setAttribute("data-font-size", FONT_SIZE);

    // Wire toggle buttons (both in the search panel; there may be just one)
    document.querySelectorAll("[data-mode-toggle]").forEach((btn) => {
        btn.addEventListener("click", () => {
            setAppMode(MUSHAF_MODE ? "tafsir" : "mushaf");
        });
    });

    // Keyboard navigation (only fires when panel is open + not in inputs)
    document.addEventListener("keydown", onKeyDown);

    syncSettingsUI();

    return {
        setAppMode, openMushafAtAyah, openMushafAtPage,
        openMushafAtSurah, isMushafMode, closeMushafPanel,
    };
}

export function isMushafMode() {
    return MUSHAF_MODE;
}

/**
 * Toggle behavior: pure internal state. No URL change. No UI hiding.
 * One exception: when switching from Mushaf→Tafsir while the panel is
 * visible, hide the panel and restore the Tafsir view for the last
 * ayah viewed in the panel.
 */
export function setAppMode(mode) {
    const wanted = mode === "mushaf" ? "mushaf" : "tafsir";
    const prev = MUSHAF_MODE ? "mushaf" : "tafsir";
    if (wanted === prev) return;

    MUSHAF_MODE = wanted === "mushaf";
    document.documentElement.setAttribute("data-app-mode", wanted);
    try { localStorage.setItem(STORAGE.MODE, wanted); } catch { }

    if (wanted === "tafsir" && PANEL_OPEN) {
        // Restore Tafsir view for the ayah the user was last looking at
        const target = LAST_VIEWED_AYAH;
        closePanel();
        if (target && DEPS?.openTafsirForAyah) {
            DEPS.openTafsirForAyah(target.s, target.a);
            history.replaceState({ s: target.s, a: target.a }, "", `/${target.s}/${target.a}`);
        }
    }
    // Switching INTO Mushaf mode does nothing visible — wait for a click.
}

export function closeMushafPanel() {
    if (PANEL_OPEN) closePanel();
}

/**
 * Open the Mushaf panel at a specific ayah. Hides the Tafsir view.
 * Used by:
 *   - search-result clicks in Mushaf mode
 *   - direct /read/ayah/S/A URL loads
 *   - browser popstate to a /read/ayah/S/A entry
 */
export async function openMushafAtAyah(s, a, opts = {}) {
    await ensureMetaLoaded();
    const key = `${s}:${a}`;
    const entry = VERSES_LOOKUP?.[key];
    const page = entry?.page || 1;
    CURRENT_TARGET_VERSE = key;
    LAST_VIEWED_AYAH = { s, a };
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
    LAST_VIEWED_AYAH = { s: Number(s), a: 1 };
    openPanel();
    await goToPage(page, { direction: "none" });
    if (opts.updateUrl !== false) {
        history.pushState({ mushaf: true, page, surah: Number(s) }, "", `/read/surah/${s}`);
    }
    updateMushafSeo({ page, surah: Number(s) });
}

/* ============================================================
 * Panel show/hide + Tafsir mutual exclusion
 * ============================================================ */

function openPanel() {
    if (!ROOT_EL) buildShell();
    if (PANEL_OPEN) return;
    PANEL_OPEN = true;
    ROOT_EL.classList.add("is-open");
    // Mark the wrapper so #tafsirSection / #versePanel hide via CSS belt + JS:
    const wrapper = ROOT_EL.parentElement;
    if (wrapper) wrapper.classList.add("has-mushaf");
    // Belt-and-suspenders: also explicitly hide the Tafsir card so the
    // existing animation/state inside it doesn't visually flicker.
    if (DEPS?.tafsirSectionEl) DEPS.tafsirSectionEl.classList.add("hidden");
}

function closePanel() {
    if (!PANEL_OPEN) return;
    PANEL_OPEN = false;
    ROOT_EL?.classList.remove("is-open");
    const wrapper = ROOT_EL?.parentElement;
    if (wrapper) wrapper.classList.remove("has-mushaf");
    if (DEPS?.tafsirSectionEl) {
        // Only un-hide if the Tafsir side has content; otherwise leave hidden.
        if (DEPS?.hasCurrentAyah?.()) DEPS.tafsirSectionEl.classList.remove("hidden");
    }
    stopMushafAudio();
    closeAyahMenu();
}

/* ============================================================
 * Data / font loading
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
 * Shell construction (inline panel — NO top bar)
 * ============================================================ */

function buildShell() {
    if (document.getElementById("mushafRoot")) {
        ROOT_EL = document.getElementById("mushafRoot");
        PAGES_EL = document.getElementById("mushafPages");
        AYAH_MENU_EL = document.getElementById("mushafAyahMenu");
        SETTINGS_EL = document.getElementById("mushafSettings");
        NOW_PLAYING_EL = document.getElementById("mushafNowPlaying");
        NAV_PREV = document.getElementById("mushafPrev");
        NAV_NEXT = document.getElementById("mushafNext");
        return;
    }

    // Find the insertion point: same wrapper as #tafsirSection.
    const tafsirSection = document.getElementById("tafsirSection");
    const wrapper = tafsirSection?.parentElement; // .mx-auto.max-w-4xl
    if (!wrapper) {
        // DOM not ready yet — defer.
        return;
    }

    const root = document.createElement("section");
    root.id = "mushafRoot";
    root.className = "mushaf-root glass rounded-3xl p-6";
    root.dir = "rtl";
    root.setAttribute("aria-label", "قارئ المصحف");
    root.innerHTML = `
    <div class="mushaf-stage">
      <button type="button" class="mushaf-nav mushaf-nav--prev" id="mushafPrev" aria-label="الصفحة السابقة">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
      </button>
      <div class="mushaf-pages" id="mushafPages"></div>
      <button type="button" class="mushaf-nav mushaf-nav--next" id="mushafNext" aria-label="الصفحة التالية">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
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
    wrapper.appendChild(root); // sibling of #tafsirSection

    ROOT_EL = root;
    PAGES_EL = document.getElementById("mushafPages");
    AYAH_MENU_EL = document.getElementById("mushafAyahMenu");
    SETTINGS_EL = document.getElementById("mushafSettings");
    NOW_PLAYING_EL = document.getElementById("mushafNowPlaying");
    NAV_PREV = document.getElementById("mushafPrev");
    NAV_NEXT = document.getElementById("mushafNext");

    wireNav();
    wireAyahMenu();
    wireSwipe();
    wireSettings();
    buildReciterButtons();
}

/* ============================================================
 * Page navigation (internal — these DO update the URL)
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
        // RTL: swipe right = previous page, swipe left = next
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
        renderPage(data, direction);
        CURRENT_PAGE = p;
        updateNavDisabledState();
        prefetchAdjacent(p);
        applyTargetHighlight();
        // Update last-viewed ayah for the toggle-OFF restore. If there's
        // an explicit target verse (search-result click), keep that as
        // the last-viewed ayah; otherwise fall back to the first verse
        // visible on the rendered page.
        if (CURRENT_TARGET_VERSE) {
            const [s, a] = CURRENT_TARGET_VERSE.split(":").map(Number);
            LAST_VIEWED_AYAH = { s, a };
        } else {
            const firstVerseKey = findFirstVerseKey(data);
            if (firstVerseKey) {
                const [s, a] = firstVerseKey.split(":").map(Number);
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

/* ============================================================
 * Page rendering — inline panel layout with Mushaf-style
 * surah header above the first ayah of each surah on the page
 * + page-number footer.
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
    if (direction !== "none") {
        newPage.classList.add("mushaf-page--animating");
        newPage.classList.add(direction === "left" ? "mushaf-page--enter-right" : "mushaf-page--enter-left");
    } else {
        newPage.classList.add("mushaf-page--active");
    }

    // Pre-scan: which verse_key begins each surah on this page?
    const firstAyahKeyPerSurah = new Map(); // surahId -> verse_key string ("S:A")
    for (const line of data.lines) {
        for (const w of line.words) {
            if (!w.verse_key) continue;
            const [sStr] = w.verse_key.split(":");
            const sId = Number(sStr);
            if (!firstAyahKeyPerSurah.has(sId)) {
                firstAyahKeyPerSurah.set(sId, w.verse_key);
            }
        }
    }

    let renderedSurahHeaderFor = new Set();

    for (let li = 0; li < data.lines.length; li++) {
        const line = data.lines[li];
        const first = line.words?.[0];
        const isSurahHeader = first?.type === "surah_header";
        const isBismillah = first?.type === "bismillah";

        // Skip QCF4's ornamental surah_header lines — we render our own
        // site-styled header above the first ayah of each surah instead.
        if (isSurahHeader) continue;

        // Inject a clean surah header above the first ayah of each surah
        // that starts on this page (including the first surah, even if
        // it's a continuation from the previous page).
        const firstWordVerseKey = line.words.find((w) => w.verse_key)?.verse_key;
        if (firstWordVerseKey) {
            const [sStr] = firstWordVerseKey.split(":");
            const sId = Number(sStr);
            if (!renderedSurahHeaderFor.has(sId) && firstAyahKeyPerSurah.get(sId) === firstWordVerseKey) {
                newPage.appendChild(buildSurahHeader(sId));
                renderedSurahHeaderFor.add(sId);
            } else if (renderedSurahHeaderFor.size === 0) {
                // Continuation case: first line on the page that contains a
                // verse, but it's mid-surah from the previous page.
                newPage.appendChild(buildSurahHeader(sId));
                renderedSurahHeaderFor.add(sId);
            }
        }

        const lineEl = document.createElement("div");
        lineEl.className = "mushaf-line";
        if (isBismillah) lineEl.classList.add("mushaf-line--bismillah");

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

        newPage.appendChild(lineEl);
    }

    // Page-number footer (folio)
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
            // After animation, drop the absolute-positioning class so the panel
            // sizes to the new page's height.
            setTimeout(() => newPage.classList.remove("mushaf-page--animating"), 320);
        });
    } else {
        if (old) old.remove();
    }

    ACTIVE_PAGE_EL = newPage;
    newPage.addEventListener("click", onPageClick);
    if (AUDIO_VERSE) highlightAyah(AUDIO_VERSE, "playing");
}

function buildSurahHeader(surahId) {
    const ch = CHAPTERS?.find((c) => c.id === surahId);
    const name = ch?.name_arabic || `${surahId}`;
    const wrap = document.createElement("div");
    wrap.className = "mushaf-surah-header";
    wrap.innerHTML = `
        <span class="mushaf-surah-header__label">سُورَة</span>
        <span class="mushaf-surah-header__name">${name}</span>
    `;
    return wrap;
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
 * Ayah click → floating menu
 * ============================================================ */

function onPageClick(e) {
    const ayahEl = e.target.closest(".mushaf-ayah");
    if (!ayahEl) { closeAyahMenu(); return; }
    openAyahMenu(ayahEl.dataset.verseKey, ayahEl);
}

function wireAyahMenu() {
    if (!AYAH_MENU_EL) return;
    AYAH_MENU_EL.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-act]");
        if (!btn || !AYAH_MENU_VERSE) return;
        const act = btn.dataset.act;
        const [s, a] = AYAH_MENU_VERSE.split(":").map(Number);
        if (act === "play") {
            playMushafAyah(AYAH_MENU_VERSE);
        } else if (act === "tafsir") {
            // Switch to Tafsir mode, hide panel, open tafsir for this ayah
            LAST_VIEWED_AYAH = { s, a };
            setAppMode("tafsir"); // setAppMode handles panel close + tafsir restore + URL
        } else if (act === "copy") {
            copyAyahText(AYAH_MENU_VERSE);
        }
        closeAyahMenu();
    });
    document.addEventListener("click", (e) => {
        if (!PANEL_OPEN) return;
        if (e.target.closest(".mushaf-ayah") || e.target.closest(".mushaf-ayah-menu")) return;
        closeAyahMenu();
    });
}

function openAyahMenu(verseKey, ayahEl) {
    if (!AYAH_MENU_EL || !ayahEl) return;
    AYAH_MENU_VERSE = verseKey;
    const rect = ayahEl.getBoundingClientRect();
    const rootRect = ROOT_EL.getBoundingClientRect();
    AYAH_MENU_EL.classList.add("mushaf-ayah-menu--open");
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
    const surah = DEPS?.quran?.surahs?.find((x) => x.number === s);
    const ayah = surah?.ayahs?.find((y) => y.numberInSurah === a);
    return ayah?.text || "";
}

/* ============================================================
 * Audio playback (independent of Tafsir-mode audio)
 * ============================================================ */

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
    updateNowPlayingUI();
    highlightAyah(verseKey, "playing");

    AUDIO_PLAYER.addEventListener("ended", async () => {
        if (AUDIO_MODE === "continuous") {
            const next = await getNextVerseKey(verseKey);
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
    const next = CHAPTERS.find((c) => c.id === s + 1);
    if (!next) return null;
    return `${next.id}:1`;
}

/* ============================================================
 * Settings panel
 * ============================================================ */

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
 * Bootstrap: try to build the shell at module load so it exists
 * in the DOM as early as possible for direct /read/* loads. If
 * #tafsirSection isn't ready yet, defer until DOMContentLoaded.
 * ============================================================ */
function bootstrapShell() {
    if (document.getElementById("tafsirSection")) {
        buildShell();
    } else if (document.body) {
        // tafsirSection lives further down in the DOM; module script may
        // run mid-parse. Wait for the rest of the document.
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
