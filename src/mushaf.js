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

import { surahAudio } from "./surahAudio.js";

/* ============================================================
 * QCF4 asset source + offline caching (Capacitor app only)
 *
 * Website (isApp() === false): getQCF4Base() is "" so every asset URL
 *   stays a same-origin path (/data/qcf4/…, /fonts/qcf4/…) — behaviour
 *   is byte-for-byte identical to before.
 * App (isApp() === true): assets are fetched from GCS and stored in the
 *   Cache API under "qcf4-v1". On first Mushaf open the full set is
 *   downloaded once (~50MB); afterwards everything is served from cache,
 *   so the Mushaf works fully offline.
 *
 * Detection is a CALL-TIME function, not a module-level constant:
 * window.Capacitor is injected by the native bridge AFTER the page
 * scripts evaluate, so a const captured at module load was always false
 * in the app. The fallback only covers the brief window before Capacitor
 * is ready: the Android app is served from https://localhost with NO port,
 * whereas the dev/preview server uses an explicit port (localhost:5173) and
 * the real website uses m7mdiyat.com — so a phone on the WEBSITE (or the dev
 * server) is never mistaken for the app, and no download screen appears.
 * ============================================================ */
const QCF4_GCS_BASE = "https://storage.googleapis.com/m7mdiyat-tafsir-data";
const QCF4_CACHE_NAME = "qcf4-v1";
const QCF4_READY_FLAG = "qcf4_ready_v1"; // localStorage marker: full set cached

function isApp() {
    if (typeof window === "undefined") return false;
    if (window.Capacitor !== undefined) return true;
    return window.location.hostname === "localhost"
        && window.location.port === ""
        && navigator.userAgent.includes("Android");
}

function getQCF4Base() {
    return isApp() ? QCF4_GCS_BASE : "";
}

let _qcf4CachePromise = null;
function qcf4Cache() {
    if (!_qcf4CachePromise) _qcf4CachePromise = caches.open(QCF4_CACHE_NAME);
    return _qcf4CachePromise;
}

/* Cache-first fetch for QCF4 assets. On the website this is a plain
 * fetch(); in the app it checks the Cache API first, falling back to the
 * network and storing the response for next time (offline support). */
async function qcf4Fetch(url) {
    if (!isApp() || typeof caches === "undefined") return fetch(url);
    const cache = await qcf4Cache();
    const hit = await cache.match(url);
    if (hit) return hit;
    const res = await fetch(url);
    if (res.ok) {
        try { await cache.put(url, res.clone()); } catch { }
    }
    return res;
}

function qcf4IsReady() {
    if (!isApp()) return true;
    try { return localStorage.getItem(QCF4_READY_FLAG) === "1"; } catch { return false; }
}

const STORAGE = {
    MODE: "app_mode",
    LAST_PAGE: "mushaf_last_page",
    FONT_SIZE: "mushaf_font_size",
    AUDIO_MODE: "mushaf_audio_mode",
    VOLUME: "mushaf_volume",
    SPEED: "mushaf_speed",
};

const TOTAL_PAGES = 604;
const LONG_PRESS_MS = 500;
const HOVER_SHOW_MS = 150;
const HOVER_HIDE_MS = 800;   // grace period: keep the menu around long enough to aim at + click it
const HOVER_SWITCH_MS = 400; // ayah→ayah: brief hold before cross-fading the menu over
const MENU_FADE_MS = 170;     // > the CSS opacity transition, so the fade-out fully completes
const SWIPE_THRESHOLD = 50;
const MOVE_CANCEL_THRESHOLD = 10;

/* SVG icon set — Lucide-derived, currentColor, stroke 1.8, 24px viewbox. */
const ICONS = {
    bookMarked: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4a2 2 0 0 1 2-2h11v18H7a2 2 0 0 0-2 2z"/><path d="M14 2v8l-2.5-1.5L9 10V2"/></svg>`,
    play: `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M7 4.5v15a.75.75 0 0 0 1.15.633l12-7.5a.75.75 0 0 0 0-1.266l-12-7.5A.75.75 0 0 0 7 4.5z"/></svg>`,
    pause: `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="4.5" width="4" height="15" rx="1"/><rect x="14" y="4.5" width="4" height="15" rx="1"/></svg>`,
    gear: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9 1.65 1.65 0 0 0 4.27 7.18l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
    chevronRight: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>`,
    chevronLeft: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>`,
    volumeMute: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4z"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>`,
    volumeLow: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`,
    volumeHigh: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`,
    sparkles: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0L14.06 8.5A2 2 0 0 0 15.5 9.94l6.14 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/></svg>`,
    close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
};

/* Data caches */
const PAGE_CACHE = new Map();
const PAGE_INFLIGHT = new Map();
// These two have a static @font-face in mushaf.css (same-origin src) and are
// treated as already-loaded on the website. In the app that src isn't bundled,
// so they must be loaded from GCS like every other font — see unsealAppFonts().
const PREDECLARED_FONTS = ["QCF4_QBSML", "QCF4_Hafs_01"];
const LOADED_FONTS = new Set(PREDECLARED_FONTS);
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
let MUKHTASAR_EL = null;
let MUKHTASAR_BODY_EL = null;
let MUKHTASAR_REF_EL = null;
let MUKHTASAR_MORE_BTN = null;
let MUKHTASAR_VERSE = null;       // "s:a" the quick-view card is currently showing
let MUKHTASAR_REQ_ID = 0;         // guards against out-of-order fetch responses
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
let AUDIO_SPEED = 1;             // 0.5..2
let MUTED_PREV_VOLUME = 0.8;     // volume to restore when un-muting
let FONT_SIZE = "m";             // "s" (صغير) | "m" (عادي, default) — old "l" is migrated to "m"
let CURRENT_RECITER_LOCAL = null;

/* Hover/long-press timers */
let HOVER_SHOW_TIMER = null;
let HOVER_HIDE_TIMER = null;
let MENU_SWITCH_TIMER = null; // the fade-out → reposition gap during an ayah→ayah switch
let MENU_HOVERED = false;     // cursor is currently inside the menu box → pin it open
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
        // Volume + speed: prefer the shared 'audioVolume' / 'audioSpeed' keys
        // (also used by app.js) so both modes load the same value. Fall back
        // to the legacy mushaf_* keys for users who only saved from Mushaf.
        const vol = parseFloat(localStorage.getItem("audioVolume"))
                 || parseFloat(localStorage.getItem(STORAGE.VOLUME));
        if (Number.isFinite(vol) && vol >= 0 && vol <= 1) {
            AUDIO_VOLUME = vol;
            if (vol > 0) MUTED_PREV_VOLUME = vol;
        }
        const speed = parseFloat(localStorage.getItem("audioSpeed"))
                   || parseFloat(localStorage.getItem(STORAGE.SPEED));
        if (Number.isFinite(speed) && speed >= 0.5 && speed <= 2) {
            AUDIO_SPEED = speed;
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
 * Sync the Mushaf-side speed/volume cache + UI from an outside change.
 * Called by app.js when the Tafsir tab adjusts speed/volume, so the Mushaf
 * slider/button shows the same value when the user switches over. Does NOT
 * touch the engine (the engine's _speed was already updated by the caller).
 */
export function syncSpeed(s) {
    AUDIO_SPEED = Math.max(0.5, Math.min(2, Number(s) || 1));
    if (AUDIO_PLAYER) AUDIO_PLAYER.playbackRate = AUDIO_SPEED;
    const slider = document.getElementById("mushafSpeedSlider");
    if (slider) slider.value = String(AUDIO_SPEED);
    const btn = document.getElementById("mushafSpeedBtn");
    if (btn) btn.textContent = `${AUDIO_SPEED}x`;
}

export function syncVolume(v) {
    AUDIO_VOLUME = Math.max(0, Math.min(1, Number(v) || 0));
    if (AUDIO_VOLUME > 0) MUTED_PREV_VOLUME = AUDIO_VOLUME;
    if (AUDIO_PLAYER) AUDIO_PLAYER.volume = AUDIO_VOLUME;
    const slider = document.getElementById("mushafVolSlider");
    if (slider) slider.value = String(Math.round(AUDIO_VOLUME * 100));
    updateVolumeIcon();
}

/**
 * Sync Mushaf-side play mode (single/continuous) from an outside change.
 * Called by app.js when the Tafsir tab flips the listening-mode chip, so
 * both chips reflect the same setting. Also updates the live engine's
 * continuous flag if it's running, so a running continuous→single (or
 * back) flip from Tafsir applies to the engine even while Mushaf is
 * hidden.
 */
export function syncAudioMode(mode) {
    const newMode = mode === "continuous" ? "continuous" : "single";
    if (AUDIO_MODE === newMode) return;
    AUDIO_MODE = newMode;
    try { localStorage.setItem(STORAGE.AUDIO_MODE, AUDIO_MODE); } catch { }
    syncSettingsUI();
    if (surahAudio.isActive()) surahAudio.setContinuous(AUDIO_MODE === "continuous");
}

/**
 * Toggle mode. Pure routing-preference except for two side effects:
 *   - Toggle OFF while panel is visible → hide panel, restore tafsir
 *     for the last viewed ayah, replaceState the URL to /S/A.
 *   - Toggle ON while a selected ayah exists (from either mode) →
 *     open the panel inline at that ayah.
 */
let MODE_TRANSITIONING = false;

export async function setAppMode(mode) {
    const wanted = mode === "mushaf" ? "mushaf" : "tafsir";
    if ((wanted === "mushaf") === MUSHAF_MODE) return;
    // Reject overlapping toggles. Without this, two clicks in quick
    // succession (or a click during the 180ms fade) race each other and the
    // panels end up in a half-applied state.
    if (MODE_TRANSITIONING) return;
    MODE_TRANSITIONING = true;
    try {

    // Audio preservation across the toggle:
    //   - engine playing → keep it (handoff to resumeXxxFromEngine).
    //   - per-ayah Audio playing in EITHER mode → leave it alone so the
    //     ayah finishes naturally. Single-mode reciting should only stop
    //     when the ayah ends, not when the user changes the view.
    //   - nothing playing → tear down stale highlight / data-audio-active
    //     so we don't carry visual residue across an idle toggle.
    const engineLive = surahAudio.isActive();
    const tafsirPerAyahLive = !!DEPS?.hasPerAyahAudio?.();
    const mushafPerAyahLive = !!AUDIO_PLAYER;
    const anyAudioLive = engineLive || tafsirPerAyahLive || mushafPerAyahLive;
    if (!anyAudioLive) {
        stopMushafAudio();
        try { DEPS?.stopAudio?.(); } catch { }
    }

    MUSHAF_MODE = wanted === "mushaf";
    document.documentElement.setAttribute("data-app-mode", wanted);
    try { localStorage.setItem(STORAGE.MODE, wanted); } catch { }

    if (wanted === "tafsir") {
        if (PANEL_OPEN) {
            const target = engineLive
                ? { s: surahAudio.getSurah(), a: surahAudio.getActiveAyah() }
                : (LAST_VIEWED_AYAH || DEPS?.getCurrentAyah?.());
            await fadeOutPanel(ROOT_EL);
            // Stage the tafsir view at opacity 0 BEFORE unhiding it so the
            // transition from hidden→opacity-1 doesn't flash at full opacity.
            const tafsirEl = DEPS?.tafsirSectionEl;
            if (tafsirEl) tafsirEl.classList.add("mode-fade-in");
            // Don't tear down ANY live playback during the close —
            // resumeTafsirFromEngine needs the engine intact; a Mushaf-side
            // per-ayah Audio should also keep playing until the ayah ends.
            closePanel({ keepAudio: anyAudioLive });
            if (engineLive && target && DEPS?.resumeTafsirFromEngine) {
                // Tear down Mushaf-side visual state (highlight, attr) without
                // touching the engine, then rebind engine→Tafsir handlers.
                if (AUDIO_VERSE) clearHighlight(AUDIO_VERSE);
                AUDIO_VERSE = null;
                document.documentElement.removeAttribute("data-audio-active");
                setPlaybackPlayingState(false);
                DEPS.resumeTafsirFromEngine();
                history.replaceState({ s: target.s, a: target.a }, "", `/${target.s}/${target.a}`);
            } else if (target && DEPS?.openTafsirForAyah) {
                DEPS.openTafsirForAyah(target.s, target.a);
                history.replaceState({ s: target.s, a: target.a }, "", `/${target.s}/${target.a}`);
            }
            commitFadeIn(tafsirEl);
        }
        return;
    }

    // wanted === "mushaf" — open the panel at the currently selected ayah.
    // ALWAYS prefer the tafsir's current ayah so switching modes shows the same ayah.
    // When engine is live, follow IT instead so we land on the actively-playing ayah.
    const target = engineLive
        ? { s: surahAudio.getSurah(), a: surahAudio.getActiveAyah() }
        : (DEPS?.getCurrentAyah?.() || LAST_VIEWED_AYAH || null);
    if (target) {
        const tafsirEl = DEPS?.tafsirSectionEl;
        if (tafsirEl && !tafsirEl.classList.contains("hidden")) {
            await fadeOutPanel(tafsirEl);
        }
        // Stage the mushaf root at opacity 0 BEFORE openPanel removes display:none.
        ROOT_EL?.classList.add("mode-fade-in");
        // noScroll: the mode toggle must not move the viewport (Fix 3).
        if (engineLive) {
            await resumeMushafFromEngine();
        } else {
            await openMushafAtAyah(target.s, target.a, { noScroll: true });
        }
        commitFadeIn(ROOT_EL);
    }
    // If no ayah has ever been selected, do nothing — wait for first click.
    } finally {
        MODE_TRANSITIONING = false;
    }
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
    await ensureMushafAssets();
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
    await ensureMushafAssets();
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
    await ensureMushafAssets();
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

function closePanel({ keepAudio = false } = {}) {
    if (!PANEL_OPEN) return;
    PANEL_OPEN = false;
    ROOT_EL?.classList.remove("is-open");
    const wrapper = ROOT_EL?.parentElement;
    if (wrapper) wrapper.classList.remove("has-mushaf");
    if (DEPS?.tafsirSectionEl) {
        if (DEPS?.hasCurrentAyah?.()) DEPS.tafsirSectionEl.classList.remove("hidden");
    }
    // keepAudio: setAppMode hands the live engine over to Tafsir without
    // stopping audio. The default closePanel still tears audio down so the
    // panel-close case (toggle off, etc.) behaves as before.
    if (!keepAudio) stopMushafAudio();
    closeAyahMenu();
    closeMukhtasarCard();
}

/* ============================================================
 * Data + font loading
 * ============================================================ */

async function ensureMetaLoaded() {
    if (META_READY) return META_READY;
    META_READY = (async () => {
        const base = getQCF4Base();
        const [verses, fontMap, index] = await Promise.all([
            qcf4Fetch(`${base}/data/qcf4/verses.json`).then((r) => r.json()),
            qcf4Fetch(`${base}/data/qcf4/font-map.json`).then((r) => r.json()),
            qcf4Fetch(`${base}/data/qcf4/index.json`).then((r) => r.json()),
        ]);
        VERSES_LOOKUP = verses;
        FONT_MAP = fontMap;
        CHAPTERS = index?.chapters || [];
    })();
    // If the load fails (e.g. GCS briefly unreachable on first launch),
    // clear the memoised promise so the next open retries instead of being
    // stuck on a rejected promise — and so the rejection can't surface as an
    // uncaught error at the (unrelated) current document URL.
    META_READY.catch(() => { META_READY = null; });
    return META_READY;
}

export function preloadMushafData() {
    ensureMetaLoaded().then(() => {
        preloadFont("QCF4_Hafs_01");
        preloadFont("QCF4_QBSML");
    }).catch(() => { });
}

/* Gate every Mushaf open. Always loads the small meta set (~3 JSONs); the bulk
 * QCF4 download is now user-initiated via the offline panel, so an app user
 * who never taps "download" simply streams pages from GCS on demand — same as
 * the website. */
async function ensureMushafAssets() {
    unsealAppFonts(); // app-only: retire the static same-origin @font-face rules early
    return ensureMetaLoaded();
}

// App-only: recitations stream from GCS (never cached), so playback needs a
// connection. Surface that in the toolbar when a play attempt fails offline.
const OFFLINE_AUDIO_MESSAGE = "الاستماع غير متاح بدون إنترنت";
let _mushafAudioMsgTimer = null;
function showMushafAudioOffline() {
    if (!isApp()) return;
    const el = document.getElementById("mushafAudioMsg");
    if (!el) return;
    el.textContent = OFFLINE_AUDIO_MESSAGE;
    el.classList.add("mushaf-toolbar__msg--show");
    clearTimeout(_mushafAudioMsgTimer);
    _mushafAudioMsgTimer = setTimeout(() => el.classList.remove("mushaf-toolbar__msg--show"), 4000);
}
function hideMushafAudioOffline() {
    const el = document.getElementById("mushafAudioMsg");
    if (el) el.classList.remove("mushaf-toolbar__msg--show");
    clearTimeout(_mushafAudioMsgTimer);
}

/* ============================================================
 * QCF4 offline download — user-initiated from the offline panel.
 *
 * Pub/sub: the panel subscribes on open to receive the live state
 * (idle / downloading / done / offline / error) and replay the
 * current progress. Closing the panel doesn't pause the download —
 * it keeps running and the flag is set on success regardless.
 * ============================================================ */

const QCF4_DL_MESSAGES = [
    "جارٍ تجهيز ميزة التدبر",
    "بعد اكتمال التحميل، لن تحتاج للإنترنت",
    "استعدّ لتجربة تدبّر فريدة",
    "لحظات تفصلك عن صفحات المصحف",
    "تدبّر القرآن، متى شئت وأينما كنت",
    "اقرأ، تدبّر، واغتنم الأجرَين",
];
const QCF4_DL_FINAL_MESSAGE = "المصحف جاهز! اضغط مطولًا على الآية لتفسيرها";

let QCF4_STATE = { status: "idle", pct: 0, done: 0, total: 0, message: "" };
const QCF4_LISTENERS = new Set();
let QCF4_DL_INFLIGHT = null;
let _qcf4OnlineArmed = false;

function setQcf4State(patch) {
    QCF4_STATE = { ...QCF4_STATE, ...patch };
    for (const fn of QCF4_LISTENERS) { try { fn(QCF4_STATE); } catch { } }
}

export function getQcf4State() {
    if (qcf4IsReady()) return { status: "done" };
    return { ...QCF4_STATE };
}

export function subscribeQcf4(fn) {
    QCF4_LISTENERS.add(fn);
    try { fn(getQcf4State()); } catch { }
    return () => QCF4_LISTENERS.delete(fn);
}

export function isQcf4Ready() { return qcf4IsReady(); }
export const QCF4_TOTAL_MB = 189;

/* Wipe the QCF4 cache and ready flag so the offline panel can offer
 * "delete to free space". Resets the meta promise so subsequent reads
 * re-populate the cache lazily. Safe to call when already-clean. */
export async function deleteQcf4Cache() {
    try { localStorage.removeItem(QCF4_READY_FLAG); } catch { }
    try { await caches.delete(QCF4_CACHE_NAME); } catch { }
    _qcf4CachePromise = null;
    META_READY = null;
    FONT_MAP = null;
    CHAPTERS = null;
    VERSES_LOOKUP = null;
    PAGE_CACHE.clear();
    setQcf4State({ status: "idle", pct: 0, done: 0, total: 0, message: "" });
}

/* Download all QCF4 assets into the cache: 3 meta JSONs, 604 page JSONs, all
 * woff2 fonts. The cache.put happens inside qcf4Fetch — we count a file done
 * once qcf4Fetch returns a successful response. Cache hits on already-fetched
 * pages (from normal browsing) make the download appear to resume instantly. */
export async function downloadQcf4Assets() {
    if (QCF4_DL_INFLIGHT) return QCF4_DL_INFLIGHT;

    if (!navigator.onLine) {
        setQcf4State({ status: "offline", message: "لا يوجد اتصال بالإنترنت" });
        armQcf4OnlineRetry();
        return { ok: false, offline: true };
    }

    QCF4_DL_INFLIGHT = (async () => {
        setQcf4State({ status: "downloading", pct: 0, done: 0, total: 1, message: QCF4_DL_MESSAGES[0] });

        // Rotate the Arabic encouragement messages every 2.5s.
        let msgIdx = 0;
        const rotation = setInterval(() => {
            msgIdx = (msgIdx + 1) % QCF4_DL_MESSAGES.length;
            setQcf4State({ message: QCF4_DL_MESSAGES[msgIdx] });
        }, 2500);

        try {
            await ensureMetaLoaded();
        } catch {
            clearInterval(rotation);
            setQcf4State({ status: "offline", message: "لا يوجد اتصال بالإنترنت" });
            armQcf4OnlineRetry();
            return { ok: false, offline: true };
        }

        const fontFamilies = new Set(Object.values(FONT_MAP || {}));
        fontFamilies.add("QCF4_QBSML"); // surah-header font (not present in font-map)

        const base = getQCF4Base();
        const urls = [];
        for (let i = 1; i <= TOTAL_PAGES; i++) {
            urls.push(`${base}/data/qcf4/pages/${String(i).padStart(3, "0")}.json`);
        }
        for (const family of fontFamilies) {
            const fileName = family === "QCF4_QBSML" ? "QCF4_QBSML.woff2" : `${family}_W.woff2`;
            urls.push(`${base}/fonts/qcf4/${fileName}`);
        }

        const total = urls.length + 3; // + the 3 meta files already fetched above
        let done = 3;
        setQcf4State({ done, total, pct: Math.round((done / total) * 100) });

        async function downloadBatch(batch, countProgress) {
            const queue = batch.slice();
            const failures = [];
            const CONCURRENCY = 6;
            async function worker() {
                while (queue.length) {
                    const url = queue.shift();
                    try {
                        const res = await qcf4Fetch(url);
                        if (!res.ok) failures.push(url);
                    } catch { failures.push(url); }
                    if (countProgress) {
                        done++;
                        setQcf4State({ done, total, pct: Math.round((done / total) * 100) });
                    }
                }
            }
            await Promise.all(Array.from({ length: CONCURRENCY }, worker));
            return failures;
        }

        // Initial pass, then up to two retry passes for transient GCS hiccups.
        let failures = await downloadBatch(urls, true);
        for (let attempt = 0; attempt < 2 && failures.length; attempt++) {
            failures = await downloadBatch(failures, false);
        }

        clearInterval(rotation);

        if (failures.length === 0) {
            try { localStorage.setItem(QCF4_READY_FLAG, "1"); } catch { }
            setQcf4State({ status: "done", pct: 100, message: QCF4_DL_FINAL_MESSAGE });
            return { ok: true };
        }
        if (!navigator.onLine) {
            setQcf4State({ status: "offline", message: "لا يوجد اتصال بالإنترنت" });
            armQcf4OnlineRetry();
            return { ok: false, offline: true };
        }
        setQcf4State({ status: "error", message: "تعذّر تحميل بعض الملفات" });
        return { ok: false, missing: failures };
    })().finally(() => { QCF4_DL_INFLIGHT = null; });
    return QCF4_DL_INFLIGHT;
}

function armQcf4OnlineRetry() {
    if (_qcf4OnlineArmed) return;
    _qcf4OnlineArmed = true;
    const onOnline = () => {
        window.removeEventListener("online", onOnline);
        _qcf4OnlineArmed = false;
        downloadQcf4Assets();
    };
    window.addEventListener("online", onOnline);
}

async function fetchPage(pageNo) {
    if (PAGE_CACHE.has(pageNo)) return PAGE_CACHE.get(pageNo);
    if (PAGE_INFLIGHT.has(pageNo)) return PAGE_INFLIGHT.get(pageNo);
    const p = (async () => {
        const name = String(pageNo).padStart(3, "0");
        const res = await qcf4Fetch(`${getQCF4Base()}/data/qcf4/pages/${name}.json`);
        if (!res.ok) throw new Error(`page ${pageNo} fetch failed: ${res.status}`);
        const data = await res.json();
        PAGE_CACHE.set(pageNo, data);
        return data;
    })();
    PAGE_INFLIGHT.set(pageNo, p);
    try { return await p; }
    finally { PAGE_INFLIGHT.delete(pageNo); }
}

/* App-only, one-time: the static @font-face rules for PREDECLARED_FONTS point
 * at same-origin paths that aren't bundled in the app. Drop them from the
 * "already loaded" set so the JS loader fetches them from GCS, and delete the
 * static rules from the CSSOM so the dead same-origin src can't win font
 * matching (it would 404 and, with font-display:block, hide the text). */
let _appFontsUnsealed = false;
function unsealAppFonts() {
    if (_appFontsUnsealed || !isApp()) return;
    _appFontsUnsealed = true;
    for (const f of PREDECLARED_FONTS) LOADED_FONTS.delete(f);
    for (const sheet of document.styleSheets) {
        let rules;
        try { rules = sheet.cssRules; } catch { continue; } // skip cross-origin sheets
        if (!rules) continue;
        for (let i = rules.length - 1; i >= 0; i--) {
            const rule = rules[i];
            if (rule.type !== CSSRule.FONT_FACE_RULE) continue;
            const fam = (rule.style.getPropertyValue("font-family") || "").replace(/["']/g, "").trim();
            if (PREDECLARED_FONTS.includes(fam)) {
                try { sheet.deleteRule(i); } catch { }
            }
        }
    }
}

function ensureFontDeclared(fontFamily) {
    if (LOADED_FONTS.has(fontFamily)) return;
    // In the app, fonts are loaded from the cache as ArrayBuffers and added
    // to document.fonts (see loadFontAndWait) — a CSS @font-face rule would
    // bypass the cache and fail offline, so skip it.
    if (isApp()) return;
    const fileName = fontFamily === "QCF4_QBSML" ? "QCF4_QBSML.woff2" : `${fontFamily}_W.woff2`;
    const css = `@font-face { font-family: "${fontFamily}"; src: url("${getQCF4Base()}/fonts/qcf4/${fileName}") format("woff2"); font-display: block; }`;
    const style = document.createElement("style");
    style.dataset.qcf4Font = fontFamily;
    style.textContent = css;
    document.head.appendChild(style);
    LOADED_FONTS.add(fontFamily);
}

const FONT_LOAD_PROMISES = new Map();

function loadFontAndWait(fontFamily) {
    if (!fontFamily) return Promise.resolve();
    unsealAppFonts();
    if (LOADED_FONTS.has(fontFamily)) return Promise.resolve();
    if (FONT_LOAD_PROMISES.has(fontFamily)) return FONT_LOAD_PROMISES.get(fontFamily);

    ensureFontDeclared(fontFamily);

    if (typeof FontFace === "undefined" || !document.fonts) {
        return Promise.resolve();
    }

    let loaded = false;
    for (const ff of document.fonts) {
        if (ff.family === fontFamily && ff.status === "loaded") {
            loaded = true;
            break;
        }
    }

    if (loaded) {
        LOADED_FONTS.add(fontFamily);
        return Promise.resolve();
    }

    const fileName = fontFamily === "QCF4_QBSML" ? "QCF4_QBSML.woff2" : `${fontFamily}_W.woff2`;
    const url = `${getQCF4Base()}/fonts/qcf4/${fileName}`;

    // App: load the woff2 bytes through the cache, then build the FontFace from
    // the ArrayBuffer. Website: keep the original url()-sourced FontFace.
    const facePromise = isApp()
        ? qcf4Fetch(url).then((r) => r.arrayBuffer()).then((buf) => new FontFace(fontFamily, buf).load())
        : new FontFace(fontFamily, `url("${url}") format("woff2")`).load();

    const p = facePromise.then((f) => {
        try { document.fonts.add(f); } catch { }
        LOADED_FONTS.add(fontFamily);
    }).catch((e) => {
        console.error(`Font load failed for ${fontFamily}:`, e);
    });

    FONT_LOAD_PROMISES.set(fontFamily, p);
    return p;
}

function preloadFont(fontFamily) {
    loadFontAndWait(fontFamily).catch(() => {});
}

/* ============================================================
 * Shell construction (inline panel — NO top bar, NO floating cog)
 * ============================================================ */

function buildShell() {
    if (document.getElementById("mushafRoot")) {
        ROOT_EL = document.getElementById("mushafRoot");
        PAGES_EL = document.getElementById("mushafPages");
        AYAH_MENU_EL = document.getElementById("mushafAyahMenu");
        MUKHTASAR_EL = document.getElementById("mushafMukhtasar");
        MUKHTASAR_BODY_EL = document.getElementById("mushafMukhtasarBody");
        MUKHTASAR_REF_EL = document.getElementById("mushafMukhtasarRef");
        MUKHTASAR_MORE_BTN = document.getElementById("mushafMukhtasarMore");
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
          <div class="mushaf-settings__section" style="margin-top: 4px;">
            <div class="mushaf-settings__label">السرعة</div>
            <div class="mushaf-toolbar__vol-row" style="gap: 8px;">
              <button type="button" class="mushaf-settings__chip" id="mushafSpeedBtn" style="min-width: 3.5rem; padding: 0.25rem 0.5rem; flex-shrink: 0;" aria-label="تغيير السرعة">1x</button>
              <input type="range" id="mushafSpeedSlider" min="0.5" max="2" step="0.05" value="1" class="mushaf-toolbar__slider">
            </div>
          </div>
        </div>
      </div>
      <span class="mushaf-toolbar__msg" id="mushafAudioMsg" aria-live="polite"></span>
    </div>

    <div class="mushaf-stage">
      <div class="mushaf-loader" id="mushafLoader">
        <div class="mushaf-spinner"></div>
      </div>
      <button type="button" class="mushaf-nav mushaf-nav--prev" id="mushafPrev" aria-label="الصفحة السابقة">${ICONS.chevronRight}</button>
      <div class="mushaf-pages" id="mushafPages"></div>
      <button type="button" class="mushaf-nav mushaf-nav--next" id="mushafNext" aria-label="الصفحة التالية">${ICONS.chevronLeft}</button>
    </div>

    <!-- Ayah menu: مختصر التفاسير quick-view -->
    <div class="mushaf-ayah-menu" id="mushafAyahMenu" data-view="main" role="menu" aria-hidden="true">
      <div class="mushaf-ayah-menu__main">
        <button type="button" class="mushaf-ayah-menu__btn mushaf-ayah-menu__btn--mukhtasar" data-act="mukhtasar" aria-label="مختصر التفاسير">${ICONS.sparkles}</button>
      </div>
    </div>

    <!-- مختصر التفاسير quick-view card -->
    <div class="mushaf-mukhtasar" id="mushafMukhtasar" role="dialog" aria-label="مختصر التفاسير" aria-hidden="true">
      <div class="mushaf-mukhtasar__header">
        <span class="mushaf-mukhtasar__title">${ICONS.sparkles}<span>مختصر التفاسير</span></span>
        <button type="button" class="mushaf-mukhtasar__close" id="mushafMukhtasarClose" aria-label="إغلاق">${ICONS.close}</button>
      </div>
      <div class="mushaf-mukhtasar__ref" id="mushafMukhtasarRef"></div>
      <div class="mushaf-mukhtasar__body" id="mushafMukhtasarBody"></div>
      <div class="mushaf-mukhtasar__footer">
        <button type="button" class="mushaf-mukhtasar__more" id="mushafMukhtasarMore">عرض التفسير الكامل</button>
      </div>
    </div>
  `;
    wrapper.appendChild(root);

    ROOT_EL = root;
    PAGES_EL = document.getElementById("mushafPages");
    AYAH_MENU_EL = document.getElementById("mushafAyahMenu");
    MUKHTASAR_EL = document.getElementById("mushafMukhtasar");
    MUKHTASAR_BODY_EL = document.getElementById("mushafMukhtasarBody");
    MUKHTASAR_REF_EL = document.getElementById("mushafMukhtasarRef");
    MUKHTASAR_MORE_BTN = document.getElementById("mushafMukhtasarMore");
    NAV_PREV = document.getElementById("mushafPrev");
    NAV_NEXT = document.getElementById("mushafNext");
    PLAYBACK_BAR_EL = null;
    PLAYBACK_LABEL_EL = null;
    PLAYBACK_PLAY_BTN = document.getElementById("mushafToolbarPlay");
    PLAYBACK_PREV_BTN = null;
    PLAYBACK_NEXT_BTN = null;

    wireNav();
    wireMenu();
    wireMukhtasarCard();
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
    else if (e.key === "Escape") { closeAyahMenu(); closeMukhtasarCard(); }
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

function showMushafLoader() {
    const loader = document.getElementById("mushafLoader");
    if (loader) loader.classList.add("mushaf-loader--visible");
}

function hideMushafLoader() {
    const loader = document.getElementById("mushafLoader");
    if (loader) loader.classList.remove("mushaf-loader--visible");
}

async function goToPage(p, { direction = "none", noScroll = false } = {}) {
    await ensureMetaLoaded();
    if (p === CURRENT_PAGE && ACTIVE_PAGE_EL) {
        applyTargetHighlight({ noScroll });
        return;
    }
    try { localStorage.setItem(STORAGE.LAST_PAGE, String(p)); } catch { }

    try {
        showMushafLoader();
        const data = await fetchPage(p);

        // If there's no explicit target verse, the target surah is the
        // first surah present on the page.
        if (!CURRENT_TARGET_VERSE && data.surahs?.length) {
            TARGET_SURAH = data.surahs[0].id;
        }

        const neededFonts = new Set();
        if (data.font) neededFonts.add(data.font);
        for (const line of data.lines) {
            for (const w of line.words) {
                if (w.font) neededFonts.add(w.font);
            }
        }
        
        const fontPromises = [];
        for (const font of neededFonts) {
            fontPromises.push(loadFontAndWait(font));
        }
        await Promise.all(fontPromises);

        hideMushafLoader();

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

    // The card/menu anchor to ayah elements in the outgoing page — drop them.
    closeMukhtasarCard();

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
    // Desktop: hovering a target-surah ayah opens the floating action menu
    // (مختصر التفاسير + full tafsir). Dimmed (non-target) ayahs get no menu —
    // clicking them triggers a smooth focus switch (Fix 3) instead.
    pageEl.addEventListener("mouseover", (e) => {
        const ayah = e.target.closest(".mushaf-ayah");
        if (!ayah || isAyahDimmed(ayah)) return;
        // Don't reopen the menu while the quick-view card is showing.
        if (MUKHTASAR_EL?.classList.contains("mushaf-mukhtasar--open")) return;
        scheduleMenuShow(ayah);
    });
    pageEl.addEventListener("mouseout", (e) => {
        const ayah = e.target.closest(".mushaf-ayah");
        if (!ayah) return;
        // Staying within the same ayah, or moving onto the menu, must not hide.
        const to = e.relatedTarget;
        if (to && typeof to.closest === "function" &&
            (to.closest(".mushaf-ayah") === ayah || to.closest(".mushaf-ayah-menu"))) return;
        scheduleMenuHide();
    });

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

    // Prevent the native context menu (long-press selection UI) on ayahs so
    // only our custom tafsir menu appears — no blue handles or copy popup.
    pageEl.addEventListener("contextmenu", (e) => {
        if (e.target.closest(".mushaf-ayah")) e.preventDefault();
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
    const menuOpen = AYAH_MENU_EL?.classList.contains("mushaf-ayah-menu--open");
    // Already showing for this ayah — cancel any pending switch-away and stay put.
    if (menuOpen && AYAH_MENU_ANCHOR === ayah) {
        clearTimeout(HOVER_SHOW_TIMER);
        clearTimeout(MENU_SWITCH_TIMER);
        return;
    }
    clearTimeout(HOVER_SHOW_TIMER);
    clearTimeout(MENU_SWITCH_TIMER);
    // Fresh hover opens quickly; moving from one ayah to another holds for a
    // beat (HOVER_SWITCH_MS) so a quick glide-through doesn't yank the menu.
    const delay = menuOpen ? HOVER_SWITCH_MS : HOVER_SHOW_MS;
    HOVER_SHOW_TIMER = setTimeout(() => transitionMenuTo(ayah), delay);
}

/* Move the menu to a new ayah. If a menu is already showing elsewhere, fade
 * it out fully (100%→0%) before repositioning; showMenu then fades it back
 * in (0%→100%) at the new ayah. A fresh open skips straight to the fade-in. */
function transitionMenuTo(ayah) {
    if (!AYAH_MENU_EL || !ayah) return;
    const isOpen = AYAH_MENU_EL.classList.contains("mushaf-ayah-menu--open");
    if (isOpen && AYAH_MENU_ANCHOR !== ayah) {
        AYAH_MENU_EL.classList.remove("mushaf-ayah-menu--open");
        AYAH_MENU_EL.setAttribute("aria-hidden", "true");
        AYAH_MENU_VERSE = null;
        AYAH_MENU_ANCHOR = null;
        clearTimeout(MENU_SWITCH_TIMER);
        MENU_SWITCH_TIMER = setTimeout(() => showMenu(ayah), MENU_FADE_MS);
    } else {
        showMenu(ayah);
    }
}

function scheduleMenuHide() {
    // Pinned: never schedule a hide while the cursor is inside the menu box.
    // It only un-pins on the menu's own `mouseleave` (cursor fully exits the
    // button) — or a switch to another ayah, which reschedules from there.
    if (MENU_HOVERED) return;
    clearTimeout(HOVER_SHOW_TIMER);
    clearTimeout(MENU_SWITCH_TIMER);
    clearTimeout(HOVER_HIDE_TIMER);
    HOVER_HIDE_TIMER = setTimeout(() => {
        // Switch to main view when closing so next open is fresh
        AYAH_MENU_EL?.setAttribute("data-view", "main");
        closeAyahMenu();
    }, HOVER_HIDE_MS);
}

function wireMenu() {
    if (!AYAH_MENU_EL) return;
    // Cursor entered the menu/button box → pin it open, cancel every pending
    // timer (hide, switch-away, show). It stays until `mouseleave` fires.
    AYAH_MENU_EL.addEventListener("mouseenter", () => {
        MENU_HOVERED = true;
        clearTimeout(HOVER_HIDE_TIMER);
        clearTimeout(MENU_SWITCH_TIMER);
        clearTimeout(HOVER_SHOW_TIMER);
    });
    // Cursor fully left the menu box → un-pin and start the hide grace period.
    AYAH_MENU_EL.addEventListener("mouseleave", () => {
        MENU_HOVERED = false;
        scheduleMenuHide();
    });
    AYAH_MENU_EL.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-act]");
        if (!btn || !AYAH_MENU_VERSE) return;
        if (btn.dataset.act === "mukhtasar") {
            const verse = AYAH_MENU_VERSE;
            closeAyahMenu();
            openMukhtasarCard(verse);
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

    // --- Speed slider + button ---
    const speedSlider = document.getElementById("mushafSpeedSlider");
    const speedBtn = document.getElementById("mushafSpeedBtn");
    
    if (speedSlider) {
        speedSlider.value = String(AUDIO_SPEED);
        speedSlider.addEventListener("input", () => applySpeed(Number(speedSlider.value), { persist: true }));
    }
    
    if (speedBtn) {
        speedBtn.textContent = `${AUDIO_SPEED}x`;
        speedBtn.addEventListener("click", () => {
            let nextSpeed = 1;
            if (AUDIO_SPEED < 1.25) nextSpeed = 1.25;
            else if (AUDIO_SPEED < 1.5) nextSpeed = 1.5;
            else if (AUDIO_SPEED < 2) nextSpeed = 2;
            else nextSpeed = 1; // cycle back
            applySpeed(nextSpeed, { persist: true });
        });
    }

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
    surahAudio.setVolume(AUDIO_VOLUME);
    if (persist) {
        try { localStorage.setItem(STORAGE.VOLUME, String(AUDIO_VOLUME)); } catch { }
    }
    updateVolumeIcon();
    // Push to the Tafsir side so its slider + module-level cache stay in sync.
    DEPS?.onVolumeChanged?.(AUDIO_VOLUME);
}

function applySpeed(s, { persist = false } = {}) {
    AUDIO_SPEED = Math.max(0.5, Math.min(2, s));
    if (AUDIO_PLAYER) AUDIO_PLAYER.playbackRate = AUDIO_SPEED;
    surahAudio.setSpeed(AUDIO_SPEED);

    const slider = document.getElementById("mushafSpeedSlider");
    if (slider) slider.value = String(AUDIO_SPEED);
    const btn = document.getElementById("mushafSpeedBtn");
    if (btn) btn.textContent = `${AUDIO_SPEED}x`;

    if (persist) {
        try { localStorage.setItem(STORAGE.SPEED, String(AUDIO_SPEED)); } catch { }
    }
    // Push to the Tafsir side so its slider/button + module-level cache stay in sync.
    DEPS?.onSpeedChanged?.(AUDIO_SPEED);
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
    clearTimeout(MENU_SWITCH_TIMER);
    clearTimeout(HOVER_HIDE_TIMER);
    MENU_HOVERED = false;
    AYAH_MENU_EL?.classList.remove("mushaf-ayah-menu--open");
    AYAH_MENU_EL?.setAttribute("aria-hidden", "true");
    AYAH_MENU_VERSE = null;
    AYAH_MENU_ANCHOR = null;
}

/* ============================================================
 * مختصر التفاسير — quick-view card
 *
 * Opened from the floating ayah menu (sparkles button). Shows a
 * short excerpt of the AI tafsir-comparison ("مختصر التفاسير") for
 * the ayah, pulled from the same `/compare-text` endpoint and
 * localStorage cache the Tafsir tab uses — so opening the card
 * warms the cache and "عرض التفسير الكامل" renders instantly.
 * Stays inside the Mushaf experience (no mode change) until the
 * user explicitly asks for the full tafsir.
 * ============================================================ */

function wireMukhtasarCard() {
    if (!MUKHTASAR_EL) return;

    // Keep the card alive while the cursor is over it (mirrors the menu).
    MUKHTASAR_EL.addEventListener("mouseenter", () => clearTimeout(HOVER_HIDE_TIMER));

    document.getElementById("mushafMukhtasarClose")
        ?.addEventListener("click", () => closeMukhtasarCard());

    wireMukhtasarDrag();

    MUKHTASAR_MORE_BTN?.addEventListener("click", async () => {
        if (!MUKHTASAR_VERSE) return;
        const [s, a] = MUKHTASAR_VERSE.split(":").map(Number);
        LAST_VIEWED_AYAH = { s, a };
        closeMukhtasarCard();
        closeAyahMenu();
        // Switch to the Tafsir tab for this ayah, then open the full
        // "مختصر التفاسير" comparison panel. The cache is shared, so the
        // text we already fetched renders without another round-trip.
        await setAppMode("tafsir");
        DEPS?.triggerCompare?.();
    });

    // Outside-click closes the card (but not clicks on the menu/ayah —
    // those have their own flow).
    document.addEventListener("click", (e) => {
        if (!MUKHTASAR_EL || MUKHTASAR_EL.getAttribute("aria-hidden") === "true") return;
        if (e.target.closest("#mushafMukhtasar")) return;
        if (e.target.closest(".mushaf-ayah-menu")) return;
        if (e.target.closest(".mushaf-ayah")) return;
        closeMukhtasarCard();
    });
}

/* Build the quick-view excerpt: from the first 2 non-empty paragraphs of the
 * compare text, take the first sentence of each (everything up to the first
 * "."), then join them into one block. "عرض التفسير الكامل" opens the rest in
 * the Tafsir tab. Degrades gracefully for ayahs with fewer than 2 paragraphs. */
function mukhtasarExcerpt(text) {
    return String(text || "")
        .split(/\n+/)
        .map((p) => p.trim())
        .filter(Boolean)
        .slice(0, 2)
        .map((p) => {
            const sentence = p.split(".")[0].trim();
            if (!sentence) return "";
            // Re-attach the period the split removed, so each reads as a sentence.
            return p.includes(".") ? `${sentence}.` : sentence;
        })
        .filter(Boolean)
        .join(" ");
}

/* The compare text uses markdown-style **bold**. Render those as <strong>,
 * HTML-escape everything else, and drop any stray unmatched markers. */
function mukhtasarHtml(text) {
    const escaped = String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    return escaped
        .replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>")
        .replace(/\*\*/g, "");
}

async function fetchMukhtasarText(s, a) {
    const key = `${s}:${a}`;
    const cached = DEPS?.getCompareCache?.(key);
    if (cached) return { ok: true, text: cached };

    // App offline path: read the summary from the cached comparisons.json (the
    // same file the Tafsir tab downloads). If the Tafsir set hasn't been
    // downloaded yet, fall through to the API when online, or report offline.
    if (DEPS?.tafsirOfflineReady?.()) {
        const offline = await DEPS.getOfflineComparison?.(s, a);
        if (offline) {
            DEPS?.setCompareCache?.(key, offline);
            return { ok: true, text: offline };
        }
        if (!navigator.onLine) return { ok: false, reason: "offline" };
        // online → fall through to the live /compare-text call below
    }

    const apiRoot = DEPS?.apiRoot;
    if (!apiRoot) return { ok: false, reason: "error" };
    if (!navigator.onLine) return { ok: false, reason: "offline" };

    try {
        const res = await fetch(`${apiRoot}/compare-text`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ surah: s, ayah: a }),
        });
        if (!res.ok) return { ok: false, reason: "error" };
        const data = await res.json();
        if (data.status === "ok" && data.comparison_text) {
            DEPS?.setCompareCache?.(key, data.comparison_text);
            return { ok: true, text: data.comparison_text };
        }
        if (data.status === "not_found") return { ok: false, reason: "not_found" };
        return { ok: false, reason: "error" };
    } catch {
        return { ok: false, reason: navigator.onLine ? "error" : "offline" };
    }
}

async function openMukhtasarCard(verseKey) {
    if (!MUKHTASAR_EL || !verseKey) return;
    const [s, a] = verseKey.split(":").map(Number);
    if (!Number.isFinite(s) || !Number.isFinite(a)) return;

    // Move the card to <body> so it can be dragged anywhere on the page.
    // The mushaf root and the parent #tafsirSection both have .glass /
    // backdrop-filter, which would otherwise become the containing block
    // for position:fixed and trap the card inside them.
    if (MUKHTASAR_EL.parentElement !== document.body) {
        document.body.appendChild(MUKHTASAR_EL);
    }

    MUKHTASAR_VERSE = verseKey;
    const reqId = ++MUKHTASAR_REQ_ID;

    if (MUKHTASAR_REF_EL) {
        MUKHTASAR_REF_EL.textContent = `${chapterArabicName(s)} — الآية ${toArabicDigits(a)}`;
    }
    if (MUKHTASAR_BODY_EL) {
        MUKHTASAR_BODY_EL.innerHTML =
            `<div class="mushaf-mukhtasar__loading"><span class="mushaf-spinner mushaf-spinner--sm"></span></div>`;
    }
    if (MUKHTASAR_MORE_BTN) MUKHTASAR_MORE_BTN.disabled = true;

    MUKHTASAR_EL.setAttribute("aria-hidden", "false");
    MUKHTASAR_EL.classList.add("mushaf-mukhtasar--open");
    positionMukhtasarCard();

    const result = await fetchMukhtasarText(s, a);
    if (reqId !== MUKHTASAR_REQ_ID) return; // a newer open() superseded this one
    if (!MUKHTASAR_BODY_EL) return;

    if (result.ok) {
        MUKHTASAR_BODY_EL.innerHTML = mukhtasarHtml(mukhtasarExcerpt(result.text));
        if (MUKHTASAR_MORE_BTN) MUKHTASAR_MORE_BTN.disabled = false;
    } else {
        const msg = result.reason === "not_found"
            ? "المختصر غير متوفر لهذه الآية بعد."
            : result.reason === "offline"
                ? "لا يوجد اتصال بالإنترنت."
                : "تعذّر تحميل المختصر، حاول مرة أخرى.";
        MUKHTASAR_BODY_EL.innerHTML = `<div class="mushaf-mukhtasar__msg">${msg}</div>`;
        // "View more" still works for not_found — the full panel shows its
        // own richer messaging — but is pointless when we're simply offline.
        if (MUKHTASAR_MORE_BTN) MUKHTASAR_MORE_BTN.disabled = result.reason === "offline";
    }
    positionMukhtasarCard();
}

function positionMukhtasarCard() {
    if (!MUKHTASAR_EL || !MUKHTASAR_VERSE) return;
    const anchor = ACTIVE_PAGE_EL?.querySelector(
        `.mushaf-ayah[data-verse-key="${CSS.escape(MUKHTASAR_VERSE)}"]`);
    if (!anchor) return;

    const rect = anchor.getBoundingClientRect();
    const cardW = MUKHTASAR_EL.offsetWidth;
    const cardH = MUKHTASAR_EL.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Anchor below the ayah, viewport-relative (the card is position:fixed
    // and lives on <body>, so no offset-parent subtraction needed).
    let left = rect.left + rect.width / 2 - cardW / 2;
    let top = rect.bottom + 10;

    if (left < 10) left = 10;
    if (left + cardW > vw - 10) left = Math.max(10, vw - cardW - 10);
    // Flip above the ayah if there isn't room below.
    if (top + cardH > vh - 10) {
        const above = rect.top - cardH - 10;
        top = above > 10 ? above : 10;
    }
    MUKHTASAR_EL.style.left = `${left}px`;
    MUKHTASAR_EL.style.top = `${top}px`;
}

function closeMukhtasarCard() {
    if (!MUKHTASAR_EL) return;
    MUKHTASAR_REQ_ID++; // invalidate any in-flight fetch
    MUKHTASAR_EL.classList.remove("mushaf-mukhtasar--open");
    MUKHTASAR_EL.setAttribute("aria-hidden", "true");
    MUKHTASAR_VERSE = null;
}

/* ============================================================
 * Drag-to-move for the مختصر التفاسير card. Pointer events cover
 * mouse + touch + pen. The header is the drag handle; the close
 * button and the "عرض التفسير الكامل" button are excluded so they
 * still behave as buttons. The card is constrained to ROOT_EL so
 * it can't be dragged off-screen.
 * ============================================================ */
function wireMukhtasarDrag() {
    if (!MUKHTASAR_EL) return;
    const header = MUKHTASAR_EL.querySelector(".mushaf-mukhtasar__header");
    if (!header) return;

    let dragging = false;
    let activePointer = null;
    let startX = 0, startY = 0;
    let startLeft = 0, startTop = 0;

    header.addEventListener("pointerdown", (e) => {
        if (e.target.closest(".mushaf-mukhtasar__close")) return;
        if (e.button !== undefined && e.button !== 0) return;

        dragging = true;
        activePointer = e.pointerId;

        // position:fixed + <body> parent means getBoundingClientRect IS the
        // viewport position. No offset-parent math needed.
        const cardRect = MUKHTASAR_EL.getBoundingClientRect();
        startX = e.clientX;
        startY = e.clientY;
        startLeft = cardRect.left;
        startTop = cardRect.top;

        MUKHTASAR_EL.classList.add("mushaf-mukhtasar--dragging");
        try { header.setPointerCapture(e.pointerId); } catch { }
        e.preventDefault();
    });

    header.addEventListener("pointermove", (e) => {
        if (!dragging || e.pointerId !== activePointer) return;

        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        const cardW = MUKHTASAR_EL.offsetWidth;
        const cardH = MUKHTASAR_EL.offsetHeight;
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        let left = startLeft + dx;
        let top = startTop + dy;

        // Soft viewport constraint: keep at least a strip of the header
        // visible on every edge so the user can always grab it back. The
        // card can drift partly off-screen otherwise — total freedom.
        const edge = 40;
        if (left + cardW < edge) left = edge - cardW;
        if (left > vw - edge) left = vw - edge;
        if (top < 0) top = 0;
        if (top > vh - edge) top = vh - edge;

        MUKHTASAR_EL.style.left = `${left}px`;
        MUKHTASAR_EL.style.top = `${top}px`;
    });

    const endDrag = (e) => {
        if (!dragging) return;
        if (e && e.pointerId !== undefined && e.pointerId !== activePointer) return;
        dragging = false;
        activePointer = null;
        MUKHTASAR_EL.classList.remove("mushaf-mukhtasar--dragging");
        try { if (e?.pointerId !== undefined) header.releasePointerCapture(e.pointerId); } catch { }
    };
    header.addEventListener("pointerup", endDrag);
    header.addEventListener("pointercancel", endDrag);
}

/* ============================================================
 * Audio playback (click on ayah toggles; settings live in menu)
 * ============================================================ */

function toggleAudioForAyah(verseKey) {
    if (!verseKey) return;
    // Sync selected ayah to the URL. Mushaf mode MUST use the mushaf URL
    // shape (/read/ayah/S/A) — writing the bare /S/A form on a Mushaf-mode
    // click meant that refreshing the page parsed the URL as a Tafsir
    // route and dumped the user into the Tafsir tab even though the saved
    // app_mode was "mushaf" (the toggle showed تدبر while the body showed
    // Tafsir). The Tafsir→handoff path in setAppMode rewrites the URL to
    // /S/A when the user explicitly switches to Tafsir.
    const [vs, va] = verseKey.split(":").map(Number);
    if (Number.isFinite(vs) && Number.isFinite(va)) {
        LAST_VIEWED_AYAH = { s: vs, a: va };
        history.replaceState({ mushaf: true, page: CURRENT_PAGE, target: verseKey }, "", `/read/ayah/${vs}/${va}`);
    }

    /* ── Continuous mode → full-surah engine ── */
    if (AUDIO_MODE === "continuous") {
        const reciter = DEPS?.getCurrentReciter?.() || "alijaber";
        const engineLoaded = surahAudio.isActive() && surahAudio.getSurah() === vs && surahAudio.getReciter() === reciter;
        if (engineLoaded && AUDIO_VERSE === verseKey) {
            // Same ayah → pause/resume
            if (surahAudio.isPlaying()) { surahAudio.pause(); }
            else { surahAudio.resume(); }
            return;
        }
        if (engineLoaded) {
            // Different ayah, same surah → fast-path seek
            updateMushafAyahHighlight(verseKey);
            surahAudio.play({ surah: vs, ayah: va, reciter }).catch(() => { });
            return;
        }
        startMushafSurahEngine(vs, va, verseKey, reciter);
        return;
    }

    /* ── Single mode → per-ayah Audio (existing behavior) ── */
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

/**
 * Swap the visible playing-highlight to verseKey. No audio side effects.
 */
function updateMushafAyahHighlight(verseKey) {
    if (AUDIO_VERSE && AUDIO_VERSE !== verseKey) clearHighlight(AUDIO_VERSE);
    AUDIO_VERSE = verseKey;
    document.documentElement.setAttribute("data-audio-active", "1");
    highlightAyah(verseKey, "playing");
}

/**
 * Engine callback bundle for Mushaf mode. Pulled out so setAppMode can
 * re-bind these when handing the live engine from Tafsir → Mushaf
 * without stopping audio.
 */
function mushafEngineCallbacks() {
    return {
        onPlay: () => { setPlaybackPlayingState(true); hideMushafAudioOffline(); },
        onPause: () => setPlaybackPlayingState(false),
        onAyahChange: async (newAyah, newSurah) => {
            const newKey = `${newSurah}:${newAyah}`;
            if (AUDIO_VERSE && AUDIO_VERSE !== newKey) clearHighlight(AUDIO_VERSE);
            AUDIO_VERSE = newKey;
            LAST_VIEWED_AYAH = { s: newSurah, a: newAyah };
            // Mushaf URL shape — same reason as the click-handler write above.
            // Refreshing mid-playback must land back in Mushaf, not Tafsir.
            history.replaceState({ mushaf: true, page: CURRENT_PAGE, target: newKey }, "", `/read/ayah/${newSurah}/${newAyah}`);
            const nextPage = VERSES_LOOKUP?.[newKey]?.page;
            if (nextPage && nextPage !== CURRENT_PAGE) {
                await goToPage(nextPage, { direction: "none" });
                history.replaceState({ mushaf: true, page: nextPage }, "", `/read/page/${nextPage}`);
            }
            highlightAyah(newKey, "playing");
        },
        onEnded: () => stopMushafAudio(),
        onStop: () => {
            if (AUDIO_VERSE) clearHighlight(AUDIO_VERSE);
            AUDIO_VERSE = null;
            document.documentElement.removeAttribute("data-audio-active");
            setPlaybackPlayingState(false);
        },
        onError: (err) => {
            console.error("Mushaf surah engine error:", err);
            stopMushafAudio();
            showMushafAudioOffline();
        },
    };
}

/**
 * Cold-start the full-surah engine for the requested ayah. Handles per-ayah
 * highlight swaps and automatic page turns when the audio crosses page
 * boundaries.
 */
function startMushafSurahEngine(surahNo, ayahNo, verseKey, reciter) {
    // Tear down the per-ayah player if any
    if (AUDIO_PLAYER) { try { AUDIO_PLAYER.pause(); } catch { } AUDIO_PLAYER = null; }

    updateMushafAyahHighlight(verseKey);
    setPlaybackPlayingState(true);

    surahAudio.play({
        surah: surahNo,
        ayah: ayahNo,
        reciter,
        continuous: AUDIO_MODE === "continuous",
        volume: AUDIO_VOLUME,
        speed: AUDIO_SPEED,
        callbacks: mushafEngineCallbacks(),
    }).catch((err) => {
        console.error("Mushaf surah engine play failed:", err);
        stopMushafAudio();
        showMushafAudioOffline();
    });
}

/**
 * Re-bind the live engine to Mushaf's UI handlers and sync the visual state
 * to the engine's current ayah. Called by setAppMode when handing the
 * engine Tafsir→Mushaf without stopping audio.
 */
async function resumeMushafFromEngine() {
    const s = surahAudio.getSurah();
    const a = surahAudio.getActiveAyah();
    if (!s || !a) return;
    const verseKey = `${s}:${a}`;
    LAST_VIEWED_AYAH = { s, a };

    // Open the panel at the engine's current ayah (skip scroll, skip URL push).
    await ensureMushafAssets();
    const page = VERSES_LOOKUP?.[verseKey]?.page || 1;
    CURRENT_TARGET_VERSE = verseKey;
    TARGET_SURAH = s;
    openPanel();
    await goToPage(page, { direction: "none", noScroll: true });
    updateMushafSeo({ page, verse: verseKey });
    // The previous mode was Tafsir, so the URL is currently /S/A. Replace
    // it with the Mushaf shape so a refresh-in-Mushaf lands back in Mushaf.
    history.replaceState({ mushaf: true, page, target: verseKey }, "", `/read/ayah/${s}/${a}`);

    // Drop any leftover per-ayah Audio that's still around.
    if (AUDIO_PLAYER) { try { AUDIO_PLAYER.pause(); } catch { } AUDIO_PLAYER = null; }

    // Sync Mushaf-side state to whatever the engine is actually playing.
    AUDIO_SPEED = surahAudio.getSpeed();
    AUDIO_VOLUME = surahAudio.getVolume();
    const speedSlider = document.getElementById("mushafSpeedSlider");
    if (speedSlider) speedSlider.value = String(AUDIO_SPEED);
    const speedBtn = document.getElementById("mushafSpeedBtn");
    if (speedBtn) speedBtn.textContent = `${AUDIO_SPEED}x`;
    const volSlider = document.getElementById("mushafVolSlider");
    if (volSlider) volSlider.value = String(Math.round(AUDIO_VOLUME * 100));

    updateMushafAyahHighlight(verseKey);
    setPlaybackPlayingState(surahAudio.isPlaying());
    // Mirror the engine's continuous flag onto the Mushaf chip — covers the
    // case where Tafsir kicked off single-mode engine playback (rare but
    // possible) so Mushaf's chip doesn't lie about what's playing.
    const desiredMode = surahAudio.getContinuous() ? "continuous" : "single";
    if (AUDIO_MODE !== desiredMode) {
        AUDIO_MODE = desiredMode;
        try { localStorage.setItem(STORAGE.AUDIO_MODE, AUDIO_MODE); } catch { }
        syncSettingsUI();
    }
    surahAudio.setCallbacks(mushafEngineCallbacks());
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

    const [s, a] = verseKey.split(":").map(Number);
    const nextAudio = new Audio(buildAyahAudioUrl(s, a));
    nextAudio.volume = AUDIO_VOLUME;
    nextAudio.playbackRate = AUDIO_SPEED;

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

    // Reflect state on each play. EVERY listener and the play().catch is
    // guarded against AUDIO_PLAYER !== nextAudio — if the user clicks a
    // different ayah while this one is still loading, the stale play()
    // promise rejects with AbortError and would otherwise tear down the
    // NEW playback via stopMushafAudio(). Same goes for late "ended" /
    // "error" events on the orphaned element.
    setPlaybackPlayingState(true);
    nextAudio.addEventListener("play", () => {
        if (AUDIO_PLAYER !== nextAudio) return;
        setPlaybackPlayingState(true);
        hideMushafAudioOffline();
    });
    nextAudio.addEventListener("pause", () => {
        if (AUDIO_PLAYER !== nextAudio || nextAudio.ended) return;
        setPlaybackPlayingState(false);
    });
    nextAudio.addEventListener("ended", () => {
        if (AUDIO_PLAYER !== nextAudio) return;
        stopMushafAudio();
    });
    nextAudio.addEventListener("error", () => {
        if (AUDIO_PLAYER !== nextAudio) return;
        stopMushafAudio();
        showMushafAudioOffline();
    });
    nextAudio.play().catch((e) => {
        if (AUDIO_PLAYER !== nextAudio) return; // superseded by another ayah click
        console.error("Mushaf audio play failed", e);
        stopMushafAudio();
        showMushafAudioOffline();
    });
}

function stopMushafAudio() {
    if (AUDIO_PLAYER) {
        try { AUDIO_PLAYER.pause(); } catch { }
        AUDIO_PLAYER = null;
    }
    if (surahAudio.isActive()) surahAudio.stop();
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
        // switchReciter (over in app.js) handles the engine cold-reload itself
        // for the continuous (engine) path, keeping the existing callback
        // bundle so the Mushaf highlight stays bound. We only need to restart
        // per-ayah single-mode playback locally.
        DEPS?.setCurrentReciter?.(val);
        if (AUDIO_MODE !== "continuous" && AUDIO_VERSE && AUDIO_PLAYER && !AUDIO_PLAYER.paused) {
            const v = AUDIO_VERSE;
            stopMushafAudio();
            playMushafAyah(v);
        }
    } else if (group === "audio-mode") {
        const newMode = val === "continuous" ? "continuous" : "single";
        const prevMode = AUDIO_MODE;
        AUDIO_MODE = newMode;
        try { localStorage.setItem(STORAGE.AUDIO_MODE, AUDIO_MODE); } catch { }

        // single → continuous mid-play: hand off to the full-surah engine.
        if (prevMode !== "continuous" && newMode === "continuous" && AUDIO_VERSE) {
            const v = AUDIO_VERSE;
            const [s, a] = v.split(":").map(Number);
            const reciter = DEPS?.getCurrentReciter?.() || "alijaber";
            // Pause any per-ayah Audio but keep the highlight while we swap.
            if (AUDIO_PLAYER) { try { AUDIO_PLAYER.pause(); } catch { } AUDIO_PLAYER = null; }
            startMushafSurahEngine(s, a, v, reciter);
        }
        // continuous → single mid-play: let the engine finish the current
        // ayah naturally, then stop. The engine's tick honours _continuous=false.
        if (prevMode === "continuous" && newMode === "single" && surahAudio.isActive()) {
            surahAudio.setContinuous(false);
        }
        // Push to Tafsir so its listening-mode flag + chip stay in sync.
        DEPS?.onAudioModeChanged?.(AUDIO_MODE);
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
