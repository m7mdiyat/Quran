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
import { buildReciterPickerHtml } from "./reciter-picker.js";
import * as mediaSession from "./mediaSession.js";
import { gharibTapTarget, gharibHoverTarget } from "./gharib.js";
import { startLoopFor as repeatStart, consumeOne as repeatConsume, resetLoop as repeatReset, subscribeRepeat } from "./repeat.js";
import {
    panelPrepare, panelStageClosed, panelOpen, panelModeClose,
    modalOpen, modalClose,
    buildSuccessCheck, playSuccessCheck,
} from "./transitions.js";

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

/* ── Capacitor Haptics (app only) ───────────────────────────────────
 * Reached through the runtime bridge (window.Capacitor.Plugins.Haptics),
 * the same pattern StatusBar uses — no web-bundle import, so the website
 * never pulls it in. navigator.vibrate is a no-op inside iOS WKWebView, so
 * this is the ONLY haptic path that fires on iPhone. selectionChanged() is
 * the subtle iOS picker "tick"; impact LIGHT is a single confirm tap. Both
 * are debounced so a fast flick/tap can't flood the Taptic engine. Resolves
 * to null (silent no-op) until `@capacitor/haptics` is installed in the
 * native project, so it's safe to ship before then. */
let _hapticTickTs = 0;
function _haptics() {
    return isApp() ? (window.Capacitor?.Plugins?.Haptics || null) : null;
}
function hapticSelectionStart() {
    const h = _haptics();
    if (h) { try { h.selectionStart(); } catch { } }
}
function hapticSelectionEnd() {
    const h = _haptics();
    if (h) { try { h.selectionEnd(); } catch { } }
}
/* Debounced wheel tick: Capacitor selection haptic in-app, navigator.vibrate
 * on the web. Fired on each integer the wheel crosses. */
function wheelTick() {
    if (isApp()) {
        const h = _haptics();
        if (!h) return;
        const now = performance.now();
        if (now - _hapticTickTs < 28) return;
        _hapticTickTs = now;
        try { h.selectionChanged(); } catch { }
    } else if (typeof navigator !== "undefined" && navigator.vibrate) {
        try { navigator.vibrate(2); } catch { }
    }
}
/* Debounced light impact (app only): a discrete "ayah chosen" confirm tap. */
function hapticLight() {
    const h = _haptics();
    if (!h) return;
    const now = performance.now();
    if (now - _hapticTickTs < 28) return;
    _hapticTickTs = now;
    try { h.impact({ style: "LIGHT" }); } catch { }
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
    chevronDown: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`,
    search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>`,
    volumeMute: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4z"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>`,
    volumeLow: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`,
    volumeHigh: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`,
    sparkles: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0L14.06 8.5A2 2 0 0 0 15.5 9.94l6.14 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/></svg>`,
    close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
    copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`,
    check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
    maximize: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M21 16v3a2 2 0 0 1-2 2h-3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/></svg>`,
    notePencil: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
};

/* Data caches */
const PAGE_CACHE = new Map();
const PAGE_INFLIGHT = new Map();
// These two have a static @font-face in mushaf.css (same-origin src), so on the
// website their CSS *declaration* already exists. But a declared @font-face is
// fetched LAZILY by the browser, so "declared" is NOT "loaded" — conflating the
// two is exactly what painted PUA glyphs against the serif fallback (tofu) on a
// fast page-turn. So we track them separately:
//   DECLARED_FONTS — an @font-face rule exists (web only; static or injected).
//   LOADED_FONTS   — the bytes are genuinely in and the face is paint-ready.
// LOADED_FONTS starts EMPTY and is filled only on a real load success
// (loadFontAndWait). In the app the static src isn't bundled, so unsealAppFonts()
// drops the declarations and every font is built from GCS/cache bytes instead.
const PREDECLARED_FONTS = ["QCF4_QBSML", "QCF4_Hafs_01"];
const DECLARED_FONTS = new Set(PREDECLARED_FONTS); // web: @font-face rule present
const LOADED_FONTS = new Set();                    // genuinely loaded & paint-ready
let VERSES_LOOKUP = null;
let FONT_MAP = null;
let CHAPTERS = null;
let META_READY = null;

/* Runtime state */
let DEPS = null;
let MUSHAF_MODE = false;
let PANEL_OPEN = false;
let CURRENT_PAGE = 0;
// Page-flip sequencing (fixes the fullscreen page-number drift under rapid
// front/back flipping). goToPage() is async (awaits page fetch + font bytes),
// but CURRENT_PAGE is only written at the very END (commitPageState). Two
// globals keep rapid navigations honest:
//   NAV_TARGET — the page the user is HEADING to, set synchronously at the top
//                of goToPage (before any await). goPrev/goNext chain from this,
//                not from the async-lagged CURRENT_PAGE, so a fast back→fwd→back
//                computes each target from real intent instead of a stale base.
//   NAV_GEN    — bumped per goToPage; a navigation whose generation has been
//                superseded by a newer one ABORTS before render/commit, so
//                overlapping fetch/font promises can never render out of order.
// Invariant once everything settles: CURRENT_PAGE === NAV_TARGET.
let NAV_TARGET = 0;
let NAV_GEN = 0;
let CURRENT_TARGET_VERSE = null;  // "s:a" — initial highlight on next render
let TARGET_SURAH = null;          // surah id whose ayahs render at full opacity
let CURRENT_PAGE_DATA = null;     // live page data of the active page (for the fullscreen title)
let LAST_VIEWED_AYAH = null;      // {s, a} — drives toggle restore in both directions

let ROOT_EL = null;
let PAGES_EL = null;
let PAGES_ANIM_TIMER = 0;        // clears .mushaf-pages--animating after a page cross-fade
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
let MUKHTASAR_ANCHOR_EL = null;   // the EXACT pressed .mushaf-ayah line fragment (Bug 3)
let MUKHTASAR_POINT = null;       // {x,y} long-press viewport coords, when known
let MUKHTASAR_SIDE = null;        // "below" | "above" — decided once per open
let MUKHTASAR_DRAGGED = false;    // user moved the card → stop auto-repositioning
let MENU_PRESS_POINT = null;      // press point captured when the ayah menu opened
let PLAYBACK_PLAY_BTN = null;

/* Audio state */
let AUDIO_PLAYER = null;
let AUDIO_VERSE = null;
let AUDIO_MODE = "single";
let AUDIO_VOLUME = 0.8;          // 0..1
let AUDIO_SPEED = 1;             // 0.5..2
let MUTED_PREV_VOLUME = 0.8;     // volume to restore when un-muting

/* Hover/long-press timers */
let HOVER_SHOW_TIMER = null;
let HOVER_HIDE_TIMER = null;
let MENU_SWITCH_TIMER = null; // the fade-out → reposition gap during an ayah→ayah switch
let MENU_HOVERED = false;     // cursor is currently inside the menu box → pin it open
let LONG_PRESS_TIMER = null;
let LONG_PRESS_FIRED = false;
let TOUCH_START = null; // {x, y, target}
let TOUCH_MOVED = false;

/* App-only: known set of "S:A" keys with notes (mirrors notes.js state) and
 * subscription cleanup. Used to paint the has-note dot on rendered ayahs. */
let _notesKeysSet = null;
let _notesSubUnsub = null;

/* ============================================================
 * Public API
 * ============================================================ */

export function initMushaf(deps) {
    DEPS = deps;

    try {
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
    // DEPS existed, in which case the reciter row and surah list would be
    // empty. Repopulate them now that we have DEPS, and re-sync the active
    // highlighting / surah label.
    buildReciterChips();
    buildSurahSelectList();
    wireSurahSelect();
    syncSettingsUI();
    syncSurahSelectLabel();

    // Boot mode is determined by URL, not localStorage. URL is canonical —
    // /read/* opens the Mushaf panel, /S/A and / show Tafsir. localStorage
    // is only consulted when the URL is ambiguous (root), and is overwritten
    // here so a refresh on a /read/ URL with stale "tafsir" preference doesn't
    // leave the toggle showing Tafsir while the user is staring at the
    // Mushaf panel (and vice versa).
    let saved = "tafsir";
    try {
        const v = localStorage.getItem(STORAGE.MODE);
        if (v === "mushaf" || v === "tafsir") saved = v;
    } catch { }
    const bootIntoMushaf = !!window._mushafInit; // set by the early routing script in index.html
    const bootMode = bootIntoMushaf ? "mushaf" : "tafsir";
    MUSHAF_MODE = bootMode === "mushaf";
    document.documentElement.setAttribute("data-app-mode", bootMode);
    if (bootMode !== saved) {
        try { localStorage.setItem(STORAGE.MODE, bootMode); } catch { }
    }

    document.querySelectorAll("[data-mode-toggle]").forEach((btn) => {
        btn.addEventListener("click", () => {
            setAppMode(MUSHAF_MODE ? "tafsir" : "mushaf");
        });
    });

    document.addEventListener("keydown", onKeyDown);

    // Cross-mode repeat-pref sync: when Tafsir's chip changes the pref,
    // refresh the Mushaf chip row + ∞ badge too.
    subscribeRepeat(() => { try { syncSettingsUI(); } catch { } });

    // App-only buttons in the Mushaf shell. Both default to display:none
    // and are revealed only when we're actually inside the Capacitor app.
    if (isApp()) {
        const noteBtn = document.querySelector('.mushaf-ayah-menu__btn--note');
        if (noteBtn) noteBtn.style.display = "";
        const fsBtn = document.getElementById("mushafFullscreenBtn");
        if (fsBtn) fsBtn.style.display = "";
        wireFullscreenButton(fsBtn);
        // Subscribe to notes changes so the has-note dot updates on save/delete.
        import("./notes.js")
            .then((m) => {
                _notesKeysSet = m.getNoteKeysSet();
                _notesSubUnsub = m.subscribeNotes(() => {
                    _notesKeysSet = m.getNoteKeysSet();
                    // Re-tag the currently visible page if any.
                    refreshNoteDots();
                });
                refreshNoteDots();
            })
            .catch(() => { });
    }

    return {
        setAppMode, openMushafAtAyah, openMushafAtPage,
        openMushafAtSurah, isMushafMode, closeMushafPanel,
    };
}

export function getMushafTargetSurah() {
    return TARGET_SURAH || LAST_VIEWED_AYAH?.s || null;
}

export function isMushafMode() {
    return MUSHAF_MODE;
}

/**
 * Single source of truth for the mode flag. Updates MUSHAF_MODE, the
 * <html data-app-mode> attribute the toggle CSS reads, and localStorage,
 * all in lockstep. Callers MUST use this whenever the displayed mode
 * changes so the toggle never disagrees with what's visible. Idempotent.
 */
function commitMode(mode) {
    const wanted = mode === "mushaf" ? "mushaf" : "tafsir";
    if (MUSHAF_MODE === (wanted === "mushaf")
        && document.documentElement.getAttribute("data-app-mode") === wanted) return;
    MUSHAF_MODE = wanted === "mushaf";
    document.documentElement.setAttribute("data-app-mode", wanted);
    try { localStorage.setItem(STORAGE.MODE, wanted); } catch { }
    // The windowed-reading reclaim CSS keys off data-app-mode → the chrome heights
    // just changed. Re-fit the box + font so the page sizes to the (now larger)
    // reading box right away, not on the next flip.
    if (MUSHAF_MODE && ACTIVE_PAGE_EL) {
        try { const box = fitMushafPageBox(); autoFitFontSize(box); scheduleBoxSettle(); } catch { }
    }
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
    // Force-close any open Tafsir toolbar dropdowns (settings cog + volume)
    // before the switch so a stuck-open panel doesn't bleed into the Mushaf
    // view (or back into Tafsir on the return trip).
    document.querySelectorAll(
        '[data-tafsir-settings-dropdown].mushaf-toolbar__dropdown--open,'
        + ' #tafsirVolDropdown.mushaf-toolbar__dropdown--open'
    ).forEach((dd) => dd.classList.remove("mushaf-toolbar__dropdown--open"));
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

    if (wanted === "tafsir") {
        if (PANEL_OPEN) {
            const target = engineLive
                ? { s: surahAudio.getSurah(), a: surahAudio.getActiveAyah() }
                : (LAST_VIEWED_AYAH || DEPS?.getCurrentAyah?.());
            // Task 7: outgoing Mushaf group CLOSES with the shared panel
            // reveal; the incoming Tafsir group is staged in its closed
            // state BEFORE it becomes visible so there is never a frame
            // showing both panels (or the new one fully-popped).
            await panelModeClose(ROOT_EL);
            const tafsirEl = DEPS?.tafsirSectionEl;
            panelStageClosed(tafsirEl);
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
                DEPS.openTafsirForAyah(target.s, target.a, { panelReveal: "defer" });
                history.replaceState({ s: target.s, a: target.a }, "", `/${target.s}/${target.a}`);
            } else if (DEPS?.openTafsirForAyah) {
                // No anchor ayah — default to Al-Fatiha 1:1 so the toggle
                // lands somewhere predictable instead of dropping the user
                // onto a blank homepage with a stale /read/page/N URL.
                DEPS.openTafsirForAyah(1, 1, { panelReveal: "defer" });
                history.replaceState({ s: 1, a: 1 }, "", `/1/1`);
            } else {
                history.replaceState(null, "", "/");
            }
            // Incoming Tafsir group opens (slide-up reveal).
            panelOpen(tafsirEl);
        }
        // Tafsir mode is always a safe fall-back even with no current ayah
        // (the homepage/search state is shown), so commit unconditionally.
        commitMode("tafsir");
        return;
    }

    // wanted === "mushaf" — open the panel at the currently selected ayah.
    // ALWAYS prefer the tafsir's current ayah so switching modes shows the same ayah.
    // When engine is live, follow IT instead so we land on the actively-playing ayah.
    const target = engineLive
        ? { s: surahAudio.getSurah(), a: surahAudio.getActiveAyah() }
        : (DEPS?.getCurrentAyah?.() || LAST_VIEWED_AYAH || null);
    const tafsirEl = DEPS?.tafsirSectionEl;
    if (tafsirEl && !tafsirEl.classList.contains("hidden")) {
        // Task 7: outgoing Tafsir group closes; openPanel() (inside the
        // openMushafAtAyah path below) stages + reveals the Mushaf group.
        await panelModeClose(tafsirEl);
    }
    // noScroll: the mode toggle must not move the viewport (Fix 3).
    if (engineLive) {
        await resumeMushafFromEngine();
    } else if (target) {
        await openMushafAtAyah(target.s, target.a, { noScroll: true });
    } else {
        // No ayah anchor (no current selection, no search). Default to
        // Al-Fatiha 1:1 so the toggle lands somewhere predictable instead
        // of restoring whatever page the user last browsed.
        await openMushafAtAyah(1, 1, { noScroll: true });
    }
    commitMode("mushaf");
    } finally {
        MODE_TRANSITIONING = false;
    }
}

export function closeMushafPanel() {
    if (PANEL_OPEN) closePanel();
    // popstate-driven close (browser back from /read/* to /S/A) must also
    // sync the mode flag — otherwise the toggle keeps showing Mushaf while
    // the user is on the Tafsir view.
    commitMode("tafsir");
}

/**
 * Full "back to the homepage" reset, used by the مسح button. Beyond
 * closeMushafPanel() it also drops the remembered anchor ayah — without
 * that, the next toggle into Mushaf would reopen the ayah the user just
 * cleared (setAppMode falls back to LAST_VIEWED_AYAH) instead of the
 * default Al-Fatiha 1:1.
 */
export function resetMushafHomeState() {
    if (PANEL_OPEN) closePanel();
    LAST_VIEWED_AYAH = null;
    TARGET_SURAH = null;
    CURRENT_TARGET_VERSE = null;
    syncSurahSelectLabel();
    commitMode("tafsir");
}

/**
 * Called by app.js setPrimaryAyah for every Tafsir-mode ayah change, so
 * the surah selector in the search pill (visible in both modes) tracks
 * the surah being read. Also keeps LAST_VIEWED_AYAH fresh — it is the
 * anchor a later toggle into Mushaf falls back to, and "last viewed"
 * is true regardless of which mode did the viewing.
 */
export function noteTafsirViewedAyah(s, a) {
    LAST_VIEWED_AYAH = { s: Number(s), a: Number(a) };
    TARGET_SURAH = Number(s);
    syncSurahSelectLabel();
}

/* Mushaf → search-bar sync: every path that makes an ayah CURRENT on the
 * Mushaf side (tap-to-play, engine auto-advance, selector اذهب, /read
 * deep links) reports it here, so the always-visible search bar tracks
 * the reading position exactly like Tafsir mode's setPrimaryAyah does.
 * app.js owns the no-go guards (selector wheel open, مسح mid-dissolve,
 * a user draft in the input). */
function reflectBarAyah(s, a) {
    const sn = Number(s), an = Number(a);
    if (sn >= 1 && an >= 1) DEPS?.reflectAyahInBar?.(sn, an);
}

export async function openMushafAtAyah(s, a, opts = {}) {
    await ensureMushafAssets();
    const key = `${s}:${a}`;
    const entry = VERSES_LOOKUP?.[key];
    const page = entry?.page || 1;
    CURRENT_TARGET_VERSE = key;
    TARGET_SURAH = Number(s);
    LAST_VIEWED_AYAH = { s: Number(s), a: Number(a) };
    reflectBarAyah(s, a);
    openPanel();
    await goToPage(page, { direction: "none", noScroll: !!opts.noScroll });
    if (opts.updateUrl !== false) {
        history.pushState({ mushaf: true, page, target: key }, "", `/read/ayah/${s}/${a}`);
    }
    updateMushafSeo({ page, verse: key });
    syncSurahSelectLabel();
    // Any path that opens the Mushaf panel — boot via _mushafInit, browser
    // back/forward, deep links — must keep the mode flag in sync so the
    // toggle reflects what's visible.
    commitMode("mushaf");
}

export async function openMushafAtPage(p, opts = {}) {
    await ensureMushafAssets();
    p = Math.max(1, Math.min(TOTAL_PAGES, Number(p) || 1));
    CURRENT_TARGET_VERSE = null;
    // Target surah will be set to first surah on page after render.
    TARGET_SURAH = null;
    openPanel();
    await goToPage(p, { direction: "none", noScroll: !!opts.noScroll });
    if (opts.updateUrl !== false) {
        history.pushState({ mushaf: true, page: p }, "", `/read/page/${p}`);
    }
    updateMushafSeo({ page: p });
    syncSurahSelectLabel();
    commitMode("mushaf");
}

export async function openMushafAtSurah(s, opts = {}) {
    await ensureMushafAssets();
    const ch = CHAPTERS?.find((c) => c.id === Number(s));
    const page = ch?.pages?.[0] || 1;
    CURRENT_TARGET_VERSE = `${s}:1`;
    TARGET_SURAH = Number(s);
    LAST_VIEWED_AYAH = { s: Number(s), a: 1 };
    reflectBarAyah(s, 1);
    openPanel();
    await goToPage(page, { direction: "none", noScroll: !!opts.noScroll });
    if (opts.updateUrl !== false) {
        history.pushState({ mushaf: true, page, surah: Number(s) }, "", `/read/surah/${s}`);
    }
    updateMushafSeo({ page, surah: Number(s) });
    syncSurahSelectLabel();
    commitMode("mushaf");
}

/* ============================================================
 * Panel open/close + mutual exclusion with Tafsir view
 * ============================================================ */

function openPanel() {
    if (!ROOT_EL) buildShell();
    if (PANEL_OPEN) return;
    PANEL_OPEN = true;
    // Stage the closed panel-reveal state BEFORE display flips on, then
    // open — every Mushaf entry (mode toggle, search pick, deep link,
    // popstate) animates in with the shared reveal instead of popping
    // (Tasks 3 + 7). Double rAF: frame 1 paints the staged closed state
    // (a just-displayed element can't transition), and deferring the open
    // to frame 2 also keeps panelOpen's layout reads clear of the display
    // flip's same-frame ResizeObserver delivery (PAGES_EL's autoFit
    // observer trips Chrome's RO loop limit otherwise).
    panelStageClosed(ROOT_EL);
    ROOT_EL.classList.add("is-open");
    const wrapper = ROOT_EL.parentElement;
    if (wrapper) wrapper.classList.add("has-mushaf");
    if (DEPS?.tafsirSectionEl) DEPS.tafsirSectionEl.classList.add("hidden");
    // Also hide the AI "قريباً" teaser (a sibling <section> outside
    // #tafsirSection) so it can't bleed through the fixed, translucent مختصر
    // quick-view card on a cold load. Inline display — not the .hidden class —
    // so we don't clobber the class state renderSurahView manages; closePanel
    // clears it back to that state.
    if (DEPS?.aiSectionEl) DEPS.aiSectionEl.style.display = "none";
    requestAnimationFrame(() => requestAnimationFrame(() => {
        if (PANEL_OPEN) panelOpen(ROOT_EL);
    }));
    // Opening the Mushaf counts as "an ayah is chosen" — fade the search
    // pill's border beam, same as picking a search result in Tafsir mode.
    DEPS?.deactivateSearchBeam?.();
}

function closePanel({ keepAudio = false } = {}) {
    if (!PANEL_OPEN) return;
    PANEL_OPEN = false;
    // Bug 1: any path that closes the Mushaf panel while the fullscreen
    // overlay is active (مختصر → "عرض التفسير الكامل", browser back, مسح)
    // MUST also tear the fullscreen scroll-lock down — page-fullscreen.js
    // listens for this while open and runs its own symmetric unlock.
    // Dispatched unconditionally; it's a no-op when fullscreen isn't open.
    try { document.dispatchEvent(new CustomEvent("m7:mushaf-panel-closed")); } catch { }
    // Reset the reveal state so the next open stages from closed again.
    if (ROOT_EL) ROOT_EL.dataset.open = "false";
    // The surah dropdown lives in the always-visible search pill (not
    // inside ROOT_EL), so an open panel would otherwise survive the
    // close and pop back already-open on the next Mushaf entry.
    closeSurahDropdown();
    ROOT_EL?.classList.remove("is-open");
    const wrapper = ROOT_EL?.parentElement;
    if (wrapper) wrapper.classList.remove("has-mushaf");
    // Always unhide the tafsir section on close — its empty/home state is
    // the right thing to show when no ayah is loaded yet. Gating this on
    // hasCurrentAyah() used to leave the tafsir section hidden after a
    // /read/* → toggle-to-Tafsir from a cold start (CURRENT was still null
    // at close time), so the user ended up staring at a blank page.
    // Stage it CLOSED first: data-open survives the display:none round-trip,
    // and an unhidden panel still flagged open would pop in fully-painted
    // instead of running the reveal that every follow-up path expects.
    if (DEPS?.tafsirSectionEl) {
        panelStageClosed(DEPS.tafsirSectionEl);
        DEPS.tafsirSectionEl.classList.remove("hidden");
    }
    // Restore the AI teaser to its class-driven visibility (shown on the
    // landing/Tafsir view; stays hidden if renderSurahView had hidden it).
    if (DEPS?.aiSectionEl) DEPS.aiSectionEl.style.display = "";
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

/* Distinguish a real connectivity failure from a spurious abort. A play()
 * promise rejects with AbortError when a pause or a newer ayah interrupts it,
 * and with NotAllowedError under the autoplay policy — neither means "offline",
 * yet both used to flash the "no internet" banner while fully online (the bug
 * users hit when pausing or rapidly switching ayahs). MediaError codes from the
 * element's "error" event: ABORTED(1)/DECODE(3) aren't connectivity issues;
 * NETWORK(2) and SRC_NOT_SUPPORTED(4) — what a failed fetch surfaces when truly
 * offline — are. navigator.onLine is unreliable in the WebView, so we read the
 * error, never the flag. */
function isOfflineAudioError(err) {
    const name = err && err.name;
    if (name === "AbortError" || name === "NotAllowedError") return false;
    // A fetch that got an HTTP RESPONSE (e.g. a missing timings file → 404, or
    // a 5xx) proves the network is up — a data/server problem, NOT offline. So
    // never flash "no internet" for it.
    if (err && typeof err.httpStatus === "number") return false;
    if (err && typeof err.code === "number") return err.code === 2 || err.code === 4;
    return true; // generic play() rejection / fetch TypeError — treat as offline
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
    for (const f of PREDECLARED_FONTS) DECLARED_FONTS.delete(f);
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
    if (DECLARED_FONTS.has(fontFamily)) return;
    // In the app, fonts are loaded from the cache as ArrayBuffers and added
    // to document.fonts (see loadFontAndWait) — a CSS @font-face rule would
    // bypass the cache and fail offline, so skip it.
    if (isApp()) return;
    // Mark declared up front, but do NOT touch LOADED_FONTS: the rule exists,
    // the bytes don't yet. loadFontAndWait() is what waits for the bytes.
    DECLARED_FONTS.add(fontFamily);
    const fileName = fontFamily === "QCF4_QBSML" ? "QCF4_QBSML.woff2" : `${fontFamily}_W.woff2`;
    const css = `@font-face { font-family: "${fontFamily}"; src: url("${getQCF4Base()}/fonts/qcf4/${fileName}") format("woff2"); font-display: block; }`;
    const style = document.createElement("style");
    style.dataset.qcf4Font = fontFamily;
    style.textContent = css;
    document.head.appendChild(style);
}

const FONT_LOAD_PROMISES = new Map();

/* Resolve ONLY when `fontFamily` is genuinely painted-ready. This is the gate
 * goToPage() awaits before renderPage(); resolving early paints the page's PUA
 * glyphs against the serif fallback → tofu boxes. The old code trusted a
 * "declared" flag and special-cased a single font (Hafs_01) to actually wait —
 * the other 46 verse fonts could resolve before their bytes arrived on a fast
 * page-turn. Now ALL fonts wait the same way:
 *
 *   Web — ensure the @font-face exists, then wait for the BYTES via the Font
 *         Loading API. document.fonts.load() forces the lazy fetch and resolves
 *         only when the face is usable (instant once truly loaded).
 *   App — there is no @font-face; fetch the woff2 (cache-first) and build a
 *         FontFace from the bytes. A non-ok response or decode error REJECTS.
 *
 * A failed/partial load is never memoised as success: its in-flight promise is
 * dropped from FONT_LOAD_PROMISES and the rejection propagates, so the caller
 * keeps the loader up and retries on the next attempt instead of rendering
 * fallback glyphs that stick until a full reload (the app's tofu mode). */
function loadFontAndWait(fontFamily) {
    if (!fontFamily) return Promise.resolve();
    unsealAppFonts();
    // The QCF4 surah-header glyph (QBSML) is never painted — renderPage skips
    // surah_header lines — so it must never trigger its ~600 KB fetch/build.
    if (fontFamily === "QCF4_QBSML") return Promise.resolve();
    if (LOADED_FONTS.has(fontFamily)) return Promise.resolve();
    if (FONT_LOAD_PROMISES.has(fontFamily)) return FONT_LOAD_PROMISES.get(fontFamily);

    if (typeof FontFace === "undefined" || !document.fonts) {
        // No Font Loading API (very old engines): best-effort declare and assume
        // the browser paints it. Legacy fallback only.
        ensureFontDeclared(fontFamily);
        LOADED_FONTS.add(fontFamily);
        return Promise.resolve();
    }

    let work;
    if (isApp()) {
        const url = `${getQCF4Base()}/fonts/qcf4/${fontFamily}_W.woff2`;
        work = qcf4Fetch(url)
            .then((r) => { if (!r.ok) throw new Error(`woff2 HTTP ${r.status}`); return r.arrayBuffer(); })
            .then((buf) => new FontFace(fontFamily, buf).load())
            .then((face) => { document.fonts.add(face); LOADED_FONTS.add(fontFamily); });
    } else {
        ensureFontDeclared(fontFamily);
        work = document.fonts.load(`1em "${fontFamily}"`).then((faces) => {
            // load() resolves with [] if nothing matched (declaration raced) —
            // treat that as a failure so it retries rather than painting tofu.
            if (!faces || faces.length === 0) throw new Error(`no @font-face matched ${fontFamily}`);
            LOADED_FONTS.add(fontFamily);
        });
    }

    const p = work.catch((e) => {
        FONT_LOAD_PROMISES.delete(fontFamily); // forget the failure → next turn retries
        console.error(`Font load failed for ${fontFamily}:`, e);
        throw e;                               // don't let goToPage's gate proceed to renderPage
    });
    FONT_LOAD_PROMISES.set(fontFamily, p);
    return p;
}

/* Await every font a page needs, retrying transient failures with backoff while
 * the loader stays up (the app streams woff2 from GCS — a blip must never fall
 * through to a tofu paint). Already-loaded fonts resolve instantly, so the
 * common cached case is not slowed. Returns true once all are genuinely loaded,
 * false if they still can't be after `attempts` tries. */
async function loadPageFontsWithRetry(fonts, attempts = 3) {
    if (!fonts.length) return true;
    for (let i = 0; i < attempts; i++) {
        try {
            await Promise.all(fonts.map(loadFontAndWait));
            return true;
        } catch {
            if (i < attempts - 1) await new Promise((r) => setTimeout(r, 350 * (i + 1)));
        }
    }
    return false;
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
        PLAYBACK_PLAY_BTN = document.getElementById("mushafToolbarPlay");
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
    <!-- Toolbar: Settings + Play/Stop on the left | Surah selector on the right -->
    <div class="mushaf-toolbar" id="mushafToolbar">
      <div class="mushaf-toolbar__btn-wrap" id="mushafSettingsWrap">
        <button type="button" class="mushaf-toolbar__btn mushaf-toolbar__btn--settings" id="mushafToolbarSettings" aria-label="إعدادات الصوت">${ICONS.gear}</button>
        <div class="mushaf-toolbar__dropdown mushaf-toolbar__dropdown--settings" id="mushafSettingsDropdown">
          <div class="mushaf-settings__section">
            <div class="mushaf-settings__label">القارئ</div>
            <div class="mushaf-settings__row mushaf-settings__row--pills" data-settings-group="reciter"></div>
          </div>
          <div class="mushaf-settings__section">
            <div class="mushaf-settings__label">طريقة التشغيل</div>
            <div class="mushaf-settings__row" data-settings-group="audio-mode">
              <button type="button" class="mushaf-settings__chip" data-val="single">آية واحدة</button>
              <button type="button" class="mushaf-settings__chip" data-val="continuous">تشغيل متواصل</button>
            </div>
          </div>
          <div class="mushaf-settings__section" data-repeat-section>
            <div class="mushaf-settings__label">تكرار الآية</div>
            <div class="mushaf-settings__row" data-settings-group="repeat">
              <button type="button" class="mushaf-settings__chip" data-val="1">بدون تكرار</button>
              <button type="button" class="mushaf-settings__chip" data-val="inf">تكرار</button>
            </div>
          </div>
        </div>
      </div>
      <button type="button" class="mushaf-toolbar__btn mushaf-toolbar__btn--fullscreen" id="mushafFullscreenBtn" aria-label="عرض الصفحة بملء الشاشة" style="display:none;">${ICONS.maximize}</button>
      <div class="mushaf-toolbar__btn-wrap" id="mushafPlayWrap">
        <button type="button" class="mushaf-toolbar__btn mushaf-toolbar__btn--play" id="mushafToolbarPlay" aria-label="تشغيل/إيقاف" data-playing="false">${ICONS.play}</button>
        <div class="mushaf-toolbar__dropdown mushaf-toolbar__dropdown--volume" id="mushafVolDropdown">
          <div class="mushaf-settings__section" data-volume-section>
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
      <div class="mushaf-toolbar__spacer"></div>
      <div class="mushaf-toolbar__btn-wrap mushaf-toolbar__btn-wrap--surah" id="mushafSurahWrap">
        <button type="button" class="mushaf-surah-select" id="mushafSurahSelectBtn" aria-haspopup="listbox" aria-expanded="false" aria-label="اختر السورة">
          <span class="mushaf-surah-select__name" id="mushafSurahSelectName">الفاتحة</span>
          <span class="mushaf-surah-select__chev">${ICONS.chevronDown}</span>
        </button>
        <div class="mushaf-toolbar__dropdown mushaf-surah-dropdown" id="mushafSurahDropdown" role="dialog" aria-label="قائمة السور">
          <!-- Panel 1: search + list of all 114 surahs -->
          <div class="mushaf-surah-dropdown__panel mushaf-surah-dropdown__panel--list" id="mushafSurahListPanel">
            <div class="mushaf-surah-search__wrap">
              <span class="mushaf-surah-search__icon">${ICONS.search}</span>
              <input type="search" class="mushaf-surah-search" id="mushafSurahSearch" placeholder="ابحث عن سورة..." autocomplete="off" inputmode="search" aria-label="بحث عن سورة">
            </div>
            <ul class="mushaf-surah-list" id="mushafSurahList" role="listbox" aria-label="السور"></ul>
            <div class="mushaf-surah-empty" id="mushafSurahEmpty" hidden>لا توجد نتائج</div>
          </div>
          <!-- Panel 2: ayah picker for the selected surah -->
          <div class="mushaf-surah-dropdown__panel mushaf-surah-dropdown__panel--detail" id="mushafSurahDetailPanel" hidden>
            <div class="mushaf-surah-detail__header">
              <button type="button" class="mushaf-surah-detail__back" id="mushafSurahDetailBack" aria-label="رجوع">${ICONS.chevronRight}</button>
              <div class="mushaf-surah-detail__title">
                <span class="mushaf-surah-detail__num" id="mushafSurahDetailNum">1</span>
                <span class="mushaf-surah-detail__name" id="mushafSurahDetailName">الفاتحة</span>
              </div>
            </div>
            <form class="mushaf-surah-detail__form" id="mushafSurahDetailForm" novalidate>
              <label class="mushaf-surah-detail__label" id="mushafAyahWheelLabel">رقم الآية</label>
              <div class="mushaf-wheel" id="mushafAyahWheel" tabindex="0" role="spinbutton" aria-valuenow="1" aria-valuemin="1" aria-valuemax="1" aria-labelledby="mushafAyahWheelLabel">
                <ul class="mushaf-wheel__list" id="mushafAyahWheelList" role="listbox" aria-label="رقم الآية"></ul>
                <div class="mushaf-wheel__band" aria-hidden="true"></div>
                <input class="mushaf-wheel__input" id="mushafAyahWheelInput" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" maxlength="3" aria-label="أدخل رقم الآية" hidden>
              </div>
              <button type="submit" class="mushaf-surah-detail__go mushaf-surah-detail__go--full" id="mushafSurahDetailGo">اذهب</button>
            </form>
          </div>
        </div>
      </div>
    </div>

    <div class="mushaf-stage">
      <div class="mushaf-loader" id="mushafLoader">
        <div class="mushaf-spinner"></div>
      </div>
      <!-- Side page-nav pills — wide WEB screens only (hidden on phones + the
           app via CSS, which use the bottom ‹ N › row instead). Same
           data-mushaf-nav hooks as the bottom buttons → one handler set. -->
      <button type="button" class="mushaf-nav mushaf-nav--prev" data-mushaf-nav="prev" aria-label="الصفحة السابقة">${ICONS.chevronRight}</button>
      <div class="mushaf-pages" id="mushafPages"></div>
      <button type="button" class="mushaf-nav mushaf-nav--next" data-mushaf-nav="next" aria-label="الصفحة التالية">${ICONS.chevronLeft}</button>
    </div>

    <!-- Bottom page nav: ‹ N › — forward (‹, next) left, back (›, prev) right.
         Phones + app use this; wide web screens use the side pills instead.
         data-mushaf-nav drives both layouts via one handler set (wireNav). -->
    <div class="mushaf-bottom-nav" dir="ltr">
      <button type="button" class="mushaf-bottom-nav__btn mushaf-bottom-nav__btn--next" id="mushafNext" data-mushaf-nav="next" aria-label="الصفحة التالية">${ICONS.chevronLeft}</button>
      <span class="mushaf-bottom-nav__page" id="mushafPageLabel"></span>
      <button type="button" class="mushaf-bottom-nav__btn mushaf-bottom-nav__btn--prev" id="mushafPrev" data-mushaf-nav="prev" aria-label="الصفحة السابقة">${ICONS.chevronRight}</button>
    </div>

    <!-- Ayah menu: مختصر التفاسير quick-view -->
    <div class="mushaf-ayah-menu" id="mushafAyahMenu" data-view="main" role="menu" aria-hidden="true">
      <div class="mushaf-ayah-menu__main">
        <button type="button" class="mushaf-ayah-menu__btn mushaf-ayah-menu__btn--mukhtasar" data-act="mukhtasar" aria-label="مختصر التفاسير"><span class="beam-bloom" aria-hidden="true"></span>${ICONS.sparkles}</button>
        <button type="button" class="mushaf-ayah-menu__btn mushaf-ayah-menu__btn--copy" data-act="copy" aria-label="نسخ الآية">
          <span class="mushaf-ayah-menu__btn-icon">${ICONS.copy}</span>
          <span class="mushaf-ayah-menu__btn-label">نسخ</span>
        </button>
        <button type="button" class="mushaf-ayah-menu__btn mushaf-ayah-menu__btn--note" data-act="note" aria-label="إضافة ملاحظة للآية" style="display:none;">
          <span class="mushaf-ayah-menu__btn-icon">${ICONS.notePencil}</span>
          <span class="mushaf-ayah-menu__btn-label">ملاحظة</span>
        </button>
      </div>
    </div>

    <!-- مختصر التفاسير quick-view card. Ships with .t-modal so it is opacity:0
         (hidden) from the moment buildShell creates it — WITHOUT it the card has
         no hiding rule at all (its .mushaf-mukhtasar CSS only sets position/size;
         visibility is owned by .t-modal, which modalOpen/modalClose add only on
         first open). That gap left the card painted at the bottom of the panel
         all through a cold load's page fetch, smearing over the loading content. -->
    <div class="mushaf-mukhtasar t-modal" id="mushafMukhtasar" role="dialog" aria-label="مختصر التفاسير" aria-hidden="true">
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

    // The surah selector lives in the hero search pill (the pill's only
    // action — مسح sits on the selected-ayah chip), not in the Mushaf
    // toolbar. It is still rendered by the template above (keeps all
    // selector markup in one place), then relocated; listeners are wired
    // by id afterwards so the move is transparent.
    // Visible in BOTH modes — submitSurahDetail routes the pick to the
    // active mode (Tafsir panel vs Mushaf navigation).
    const pillActions = document.getElementById("searchPillActions");
    const surahWrap = root.querySelector("#mushafSurahWrap");
    // APPEND (not prepend): the pill مسح button ships in the markup as the
    // cluster's first child = visually RIGHTMOST in the RTL flex row, so
    // the selector lands on its left — مسح sits on the selector's right.
    if (pillActions && surahWrap) pillActions.appendChild(surahWrap);

    ROOT_EL = root;
    PAGES_EL = document.getElementById("mushafPages");
    AYAH_MENU_EL = document.getElementById("mushafAyahMenu");
    MUKHTASAR_EL = document.getElementById("mushafMukhtasar");
    MUKHTASAR_BODY_EL = document.getElementById("mushafMukhtasarBody");
    MUKHTASAR_REF_EL = document.getElementById("mushafMukhtasarRef");
    MUKHTASAR_MORE_BTN = document.getElementById("mushafMukhtasarMore");
    PLAYBACK_PLAY_BTN = document.getElementById("mushafToolbarPlay");

    wireNav();
    wireMenu();
    wireMukhtasarCard();
    wirePageSwipe();
    wireCopy();
    wireToolbar();
    wireSurahSelect();
    buildReciterChips();
    buildSurahSelectList();
    syncSettingsUI();
    syncSurahSelectLabel();

    if (window.ResizeObserver) {
        new ResizeObserver(() => {
            // FS_FONT_LOCK is set by the fullscreen module after it applies
            // a font-size multiplier. Without this guard, every fullscreen
            // layout reflow (entering, rotating, font-button clicks, page
            // swaps) would trigger autoFit and immediately overwrite the
            // multiplied --font-size — making the + button look broken.
            if (PANEL_OPEN && !FS_FONT_LOCK) { autoFitFontSize(); fitMushafPageBox(); }
        }).observe(PAGES_EL);
    }

    // Re-fit the page box when the chrome ABOVE the stage can shift — rotation,
    // viewport resize, late font load. Those move the stage's top WITHOUT resizing
    // PAGES_EL, so the ResizeObserver above wouldn't catch them. (No-op off-app /
    // in fullscreen — fitMushafPageBox guards both.)
    window.addEventListener("resize", scheduleBoxSettle, { passive: true });
    window.addEventListener("orientationchange", () => setTimeout(scheduleBoxSettle, 60), { passive: true });
    try { document.fonts?.ready?.then(scheduleBoxSettle); } catch { }
}

/* Fullscreen-only flag — when true, the ResizeObserver above does NOT
 * re-fit, so the user's font multiplier is preserved across layout reflows.
 * Set via the deps wiring exposed to page-fullscreen.js. */
let FS_FONT_LOCK = false;

/* ============================================================
 * Page navigation (these DO update the URL)
 * ============================================================ */

function wireNav() {
    // Both layouts (side pills on wide web, bottom ‹ N › row on phones/app)
    // carry data-mushaf-nav, so one handler set drives whichever is visible.
    document.querySelectorAll('[data-mushaf-nav="prev"]').forEach((b) => b.addEventListener("click", () => goPrev()));
    document.querySelectorAll('[data-mushaf-nav="next"]').forEach((b) => b.addEventListener("click", () => goNext()));
}

function goPrev() {
    // Base off NAV_TARGET (live intent), not CURRENT_PAGE — under rapid flips
    // CURRENT_PAGE lags behind the async commit, so basing on it would compute
    // the wrong page (or the same page twice). Fall back to CURRENT_PAGE before
    // the first navigation has set an intent.
    const base = NAV_TARGET || CURRENT_PAGE;
    if (base <= 1) return;
    CURRENT_TARGET_VERSE = null;
    const target = base - 1;
    goToPage(target, { direction: "right" });
    history.pushState({ mushaf: true, page: target }, "", `/read/page/${target}`);
    updateMushafSeo({ page: target });
}

function goNext() {
    const base = NAV_TARGET || CURRENT_PAGE;
    if (base >= TOTAL_PAGES) return;
    CURRENT_TARGET_VERSE = null;
    const target = base + 1;
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

/* Swipe to flip — clean INSTANT SLIDE (the transform-only @keyframe in
 * renderPage). On touchend, a clearly-horizontal gesture past the distance
 * threshold OR a fast flick fires goNext/goPrev → the soft slide. RTL: finger
 * right → next, left → prev. Axis-locked so vertical reading-scroll is never
 * hijacked; preventDefault on horizontal moves stops native scroll mid-swipe.
 * JS-driven, so it coexists with the app-wide `touch-action: pan-y` drift fix.
 *
 * NOTE: we deliberately do NOT finger-track the page. Real-time dragging of full
 * Quran pages (heavy QCF4 text + gharib gold decoration) couldn't stay
 * glitch-free / 60fps in the WebView and caused cut-off/snap, basmala and lag
 * regressions. The instant slide is rock-solid and standard for a reading app. */
function wirePageSwipe() {
    if (!PAGES_EL) return;
    const AXIS_DECIDE_PX = 8;       // commit to an axis after this much movement
    const FLICK_VELOCITY = 0.45;    // px/ms — a fast flick flips even if short of the threshold
    let startX = 0, startY = 0, lastX = 0, lastT = 0, vx = 0, tracking = false, axis = null;

    const onMove = (e) => {
        if (!tracking || e.touches.length !== 1) return;
        const x = e.touches[0].clientX, y = e.touches[0].clientY;
        const dx = x - startX, dy = y - startY;
        if (axis === null && (Math.abs(dx) > AXIS_DECIDE_PX || Math.abs(dy) > AXIS_DECIDE_PX)) {
            axis = Math.abs(dx) > Math.abs(dy) ? "h" : "v";
        }
        if (axis === "h") {
            if (e.cancelable) e.preventDefault();          // stop native scroll during a horizontal swipe
            const now = e.timeStamp || performance.now();
            if (now > lastT) vx = (x - lastX) / (now - lastT);
            lastX = x; lastT = now;
        }
    };

    const endTouch = () => { tracking = false; axis = null; PAGES_EL.removeEventListener("touchmove", onMove); };

    PAGES_EL.addEventListener("touchstart", (e) => {
        if (e.touches.length !== 1) return;
        tracking = true; axis = null;
        startX = e.touches[0].clientX; startY = e.touches[0].clientY;
        lastX = startX; lastT = e.timeStamp || performance.now(); vx = 0;
        PAGES_EL.addEventListener("touchmove", onMove, { passive: false });
    }, { passive: true });

    PAGES_EL.addEventListener("touchend", (e) => {
        if (!tracking) { endTouch(); return; }
        const t = e.changedTouches[0];
        const dx = t.clientX - startX, dy = t.clientY - startY;
        endTouch();
        if (Math.abs(dx) < Math.abs(dy)) return;            // vertical → reading scroll, not a flip
        const flick = Math.abs(vx) > FLICK_VELOCITY;         // a fast short swipe still flips
        if (Math.abs(dx) < SWIPE_THRESHOLD && !flick) return;
        if (dx > 0) goNext(); else goPrev();                 // RTL: finger right → next, left → prev
    }, { passive: true });

    PAGES_EL.addEventListener("touchcancel", endTouch, { passive: true });
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
    // Stamp intent + generation SYNCHRONOUSLY, before the first await, so a
    // swipe fired while this one is still loading already sees the new target
    // and supersedes this generation.
    NAV_TARGET = p;
    const myGen = ++NAV_GEN;
    await ensureMetaLoaded();
    if (p === CURRENT_PAGE && ACTIVE_PAGE_EL) {
        applyTargetHighlight({ noScroll });
        return;
    }

    try {
        showMushafLoader();
        const data = await fetchPage(p);

        // Superseded while fetching — bail before mutating any shared global
        // (TARGET_SURAH below) or loading fonts for a page we'll never show.
        // Hide the loader defensively in case the surviving navigation took the
        // "already here" early-return path and never manages it.
        if (myGen !== NAV_GEN) { hideMushafLoader(); return; }

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
        
        // Genuinely wait for every page font's BYTES before painting. Transient
        // failures retry with backoff (loader stays up); a persistent failure
        // leaves the current page in place rather than rendering tofu boxes.
        const fontsReady = await loadPageFontsWithRetry([...neededFonts]);
        if (!fontsReady) {
            hideMushafLoader();
            // Couldn't reach p — drop intent back to reality (only if no newer
            // navigation has taken over) so the next flip chains from where we
            // actually are, not the page we failed to load.
            if (myGen === NAV_GEN) NAV_TARGET = CURRENT_PAGE;
            console.error(`Mushaf: fonts for page ${p} failed to load; skipping render to avoid tofu.`);
            return;
        }

        hideMushafLoader();

        // A newer navigation superseded this one while it was loading — abort so
        // overlapping fetch/font promises can never render or commit out of
        // order (the stale page would scramble CURRENT_PAGE + the page number).
        if (myGen !== NAV_GEN) return;

        renderPage(data, direction);
        commitPageState(p, data, { noScroll, direction });
    } catch (e) {
        console.error("Mushaf goToPage error:", e);
    }
}

/* Post-render page bookkeeping: current page #, nav disabled-state, prefetch,
 * target highlight, resume position. Shared by goToPage (instant/animated swap)
 * and the flip-drag's commit, so a finger-completed flip updates exactly the
 * same state as a button/swipe flip. */
function commitPageState(p, data, { noScroll = false, direction = "none" } = {}) {
    CURRENT_PAGE = p;
    try { localStorage.setItem(STORAGE.LAST_PAGE, String(p)); } catch { }
    updateNavDisabledState();
    prefetchAdjacent(p);
    applyTargetHighlight({ noScroll });
    // A page FLIP (swipe / ‹ › buttons → a slide direction) must NEVER move the document
    // scroll: the reader stays exactly where their finger left them and only the page
    // content swaps. goPrev/goNext CLEAR CURRENT_TARGET_VERSE, so applyTargetHighlight
    // above early-returns on a flip — no scroll — and the constant per-page box keeps the
    // size identical, so the page just stays put.
    //
    // The remaining in-app scroll on a non-flip (direction "none", not noScroll) splits by
    // whether a specific ayah is targeted:
    //   • target verse set (search-bar pick / surah selector / deep link) → applyTargetHighlight
    //     smooth-scrolls to THAT ayah (only if off-screen). So the instant hero-tuck must NOT
    //     also fire here, or they fight — an instant jump, then a glide.
    //   • no target (openMushafAtPage) → tuck the hero away once under the header.
    // Mode toggles + session-restore pass noScroll → they honor setAppMode's "Fix 3: the
    // toggle must not move the viewport".
    const mayTuck = direction === "none" && !noScroll && !CURRENT_TARGET_VERSE;
    if (mayTuck) lockReadingScrollTop();
    requestAnimationFrame(() => { if (mayTuck) lockReadingScrollTop(); fitMushafPageBox(); });
    if (CURRENT_TARGET_VERSE) {
        const [s, a] = CURRENT_TARGET_VERSE.split(":").map(Number);
        LAST_VIEWED_AYAH = { s, a };
    } else {
        // Last viewed = first verse of the target surah on this page, falling
        // back to the first verse on the page.
        const fv = findFirstVerseKeyForSurah(data, TARGET_SURAH) || findFirstVerseKey(data);
        if (fv) { const [s, a] = fv.split(":").map(Number); LAST_VIEWED_AYAH = { s, a }; }
    }
    syncSurahSelectLabel();
    if (LAST_VIEWED_AYAH) {
        try {
            DEPS?.recordResume?.({ mode: "mushaf", surah: LAST_VIEWED_AYAH.s, ayah: LAST_VIEWED_AYAH.a, page: CURRENT_PAGE });
        } catch { }
    }
}

function updateNavDisabledState() {
    // Toggle BOTH layouts' buttons (side pills + bottom row) via the shared hook.
    const prevDisabled = CURRENT_PAGE <= 1, nextDisabled = CURRENT_PAGE >= TOTAL_PAGES;
    document.querySelectorAll('[data-mushaf-nav="prev"]').forEach((b) => { b.disabled = prevDisabled; });
    document.querySelectorAll('[data-mushaf-nav="next"]').forEach((b) => { b.disabled = nextDisabled; });
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

/* Build a page's DOM only — surah headers, bismillah, verse lines, per-page
 * footer. Pure: no append, no wiring, no animation, no page-state. `targetSurah`
 * decides which surah is "active" (others dim); it defaults to the global so
 * renderPage is unchanged, but the flip-drag passes the NEIGHBOUR's own target
 * so the dragged-in page looks right before it's committed. (It temporarily
 * swaps the global TARGET_SURAH for the synchronous build so the existing
 * buildLineElement/buildSurahHeader dimming reads the right target.) */
function buildPageElement(data, targetSurah = TARGET_SURAH) {
    const prevTarget = TARGET_SURAH;
    TARGET_SURAH = targetSurah;
    try {
        ensureFontDeclared(data.font);
        for (const line of data.lines) {
            for (const w of line.words) {
                if (w.font && !DECLARED_FONTS.has(w.font)) ensureFontDeclared(w.font);
            }
        }

        const newPage = document.createElement("div");
        newPage.className = "mushaf-page";
        newPage.dataset.page = String(data.page);
        if (TARGET_SURAH) newPage.dataset.targetSurah = String(TARGET_SURAH);

        // Pre-scan: the *first verse key* of each surah on this page → where the
        // clean surah header is injected.
        const firstVerseKeyPerSurah = new Map();
        for (const line of data.lines) {
            for (const w of line.words) {
                if (!w.verse_key) continue;
                const sId = Number(w.verse_key.split(":")[0]);
                if (!firstVerseKeyPerSurah.has(sId)) firstVerseKeyPerSurah.set(sId, w.verse_key);
            }
        }

        const renderedSurahHeaderFor = new Set();
        let pendingBismillah = null; // bismillah-line waiting for the next surah header

        for (let li = 0; li < data.lines.length; li++) {
            const line = data.lines[li];
            const first = line.words?.[0];
            if (first?.type === "surah_header") continue;          // skip QCF4 ornamental header lines
            if (first?.type === "bismillah") { pendingBismillah = line; continue; } // emit AFTER the header

            const firstVerseInLine = line.words.find((w) => w.verse_key)?.verse_key;
            if (firstVerseInLine) {
                const sId = Number(firstVerseInLine.split(":")[0]);
                const isFirstVerseOfSurahOnPage = firstVerseKeyPerSurah.get(sId) === firstVerseInLine;
                const isContinuationFirstSurah = renderedSurahHeaderFor.size === 0;
                if (!renderedSurahHeaderFor.has(sId) && (isFirstVerseOfSurahOnPage || isContinuationFirstSurah)) {
                    const headerEl = buildSurahHeader(sId);
                    // CONTINUATION when the surah's first verse on this page isn't
                    // ayah 1 — fullscreen CSS suppresses this "out-of-nowhere" name.
                    const firstVerseOnPage = firstVerseKeyPerSurah.get(sId);
                    if (!firstVerseOnPage || !firstVerseOnPage.endsWith(":1")) {
                        headerEl.classList.add("mushaf-surah-header--continuation");
                    }
                    newPage.appendChild(headerEl);
                    renderedSurahHeaderFor.add(sId);
                    if (pendingBismillah) {
                        newPage.appendChild(buildLineElement(pendingBismillah, sId));
                        pendingBismillah = null;
                    }
                }
            }

            const lineSurahId = firstVerseInLine ? Number(firstVerseInLine.split(":")[0]) : null;
            newPage.appendChild(buildLineElement(line, lineSurahId));
        }

        // Per-page footer "صفحة N" (wide web only; CSS hides it on phones/app).
        const footer = document.createElement("div");
        footer.className = "mushaf-page-footer";
        footer.textContent = `صفحة ${Number(data.page).toLocaleString("ar-EG")}`;
        newPage.appendChild(footer);

        return newPage;
    } finally {
        TARGET_SURAH = prevTarget;
    }
}

/* Wire interactions + size + announce a freshly-placed page as the active one.
 * Used by renderPage (instant/animated swap) AND the flip-drag (on commit), so
 * a dragged-in page gets the exact same wiring as a normally-rendered one. */
function activatePage(newPage, data) {
    ACTIVE_PAGE_EL = newPage;
    CURRENT_PAGE_DATA = data;   // set before the page-rendered event so the title reads it
    // Bottom-nav ‹ N › label (the per-page footer is built into the DOM above).
    const pageLabel = document.getElementById("mushafPageLabel");
    if (pageLabel) pageLabel.textContent = Number(data.page).toLocaleString("ar-EG");
    wireAyahInteractions(newPage);
    if (AUDIO_VERSE) highlightAyah(AUDIO_VERSE, "playing");
    // Width-fit the font to one consistent size, then announce so fullscreen/gharib
    // read the final --font-size. (The old per-page "fixed box" height-fit was removed;
    // the page now renders at natural height and the document scrolls.)
    const box = fitMushafPageBox();   // no-op box reset (clears any stale inline height)
    autoFitFontSize(box);
    scheduleBoxSettle();  // re-fit the font once the chrome above the stage settles
    try {
        PAGES_EL?.dispatchEvent(new CustomEvent("mushaf:page-rendered", {
            bubbles: true,
            detail: { page: data.page, el: newPage, data },
        }));
    } catch { }
}

let _renderGen = 0;   // bumped per render; a held fs-zoom reveal aborts if superseded
function renderPage(data, direction = "none") {
    if (!PAGES_EL) return;
    const gen = ++_renderGen;
    closeMukhtasarCard(); // card/menu anchor to ayahs in the outgoing page — drop them
    const newPage = buildPageElement(data);
    const old = ACTIVE_PAGE_EL;
    PAGES_EL.appendChild(newPage);

    // Force a synchronous layout NOW, before the slide animation reveals the page.
    // The page's fonts are already loaded (goToPage awaits loadPageFontsWithRetry),
    // but the page is freshly appended — in fullscreen-zoom the lines flip from the
    // base nowrap to white-space:normal (wrap) under the [data-fs-zoom] rules, and
    // if the slide starts painting before that recalc+shape lands you see the text
    // cut off at the edge for a frame, then "fill in". Reading offsetHeight forces
    // style-recalc + layout + text-shaping with the loaded font up front, so the
    // page is in its FINAL wrapped/shaped geometry before it's ever shown.
    void newPage.offsetHeight;

    const runSwap = () => {
        if (direction !== "none" && old) {
            // Soft horizontal slide (transform-only). RTL: NEXT (goNext → "left") →
            // new enters from the LEFT, old exits to the RIGHT; PREV → the opposite.
            const next = direction === "left";
            const enterCls = next ? "mushaf-page--enter-from-left" : "mushaf-page--enter-from-right";
            const exitCls = next ? "mushaf-page--exit-to-right" : "mushaf-page--exit-to-left";
            // Rapid taps: drop any pages still sliding from an earlier swap.
            PAGES_EL.querySelectorAll(".mushaf-page").forEach((p) => { if (p !== old && p !== newPage) p.remove(); });
            PAGES_EL.classList.add("mushaf-pages--animating");
            clearTimeout(PAGES_ANIM_TIMER);
            PAGES_ANIM_TIMER = setTimeout(() => PAGES_EL?.classList.remove("mushaf-pages--animating"), 480);
            newPage.classList.add(enterCls);
            newPage.addEventListener("animationend", () => newPage.classList.remove(enterCls), { once: true });
            old.classList.add(exitCls);
            old.addEventListener("animationend", () => old.remove(), { once: true });
            setTimeout(() => { if (old.parentNode) old.remove(); }, 480);
        } else {
            clearTimeout(PAGES_ANIM_TIMER);
            PAGES_EL.classList.remove("mushaf-pages--animating");
            if (old) old.remove();
        }
        activatePage(newPage, data);
    };

    const root = PAGES_EL.closest(".mushaf-root");
    const fsZoom = !!root && root.classList.contains("mushaf-root--fullscreen") && root.getAttribute("data-fs-zoom") === "1";
    if (fsZoom) {
        // Zoom (+) flip: reset the STAGE scroller (not the root) to the top so the incoming
        // page slides in at its top, then fall through to the SAME slide as the non-zoom
        // flip. The chrome now lives in the non-scrolling root (the stage is the scroller),
        // so the slide can't drag it and the scroll-reset can't glitch it.
        const stage = PAGES_EL.closest(".mushaf-stage");
        if (stage) { stage.scrollTop = 0; stage.scrollLeft = 0; }
    }
    runSwap();
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
            if (_notesKeysSet?.has(vk)) {
                currentAyahEl.classList.add("mushaf-ayah--has-note");
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

/* Re-paint has-note dots on every visible ayah using the latest notes keys.
 * Cheap (only touches DOM if state changed): pages render with the dot when
 * built; this fires only when a note is saved/deleted while a page is on
 * screen, so the indicator pops/disappears without a re-render. */
function refreshNoteDots() {
    if (!ACTIVE_PAGE_EL) return;
    const keys = _notesKeysSet || new Set();
    ACTIVE_PAGE_EL.querySelectorAll(".mushaf-ayah").forEach((el) => {
        const vk = el.dataset.verseKey;
        if (!vk) return;
        el.classList.toggle("mushaf-ayah--has-note", keys.has(vk));
    });
}

/* Fullscreen now runs IN-PLACE on the real Mushaf (just a CSS class on
 * ROOT_EL + overlay close/font/settings/page-num controls). Swipe
 * direction, page animation, ayah long-press menu, tap-to-play and the
 * Tafsir/Mushaf reciter chain all come for free because it's the same
 * DOM and the same handlers. The fullscreen module only owns the overlay
 * chrome + font-size cycling + the floating settings panel (whose chips
 * share the toolbar dropdown's data-settings-group attributes so the
 * shared sync function keeps them aligned). */
function wireFullscreenButton(btn) {
    if (!btn || btn.__fsWired) return;
    btn.__fsWired = true;
    btn.addEventListener("click", async () => {
        try {
            const m = await import("./page-fullscreen.js");
            m.openFullscreen({
                rootEl: ROOT_EL,
                getActivePageEl: () => ACTIVE_PAGE_EL,
                getCurrentPageNum: () => CURRENT_PAGE,
                totalPages: TOTAL_PAGES,
                // Box-aware re-fit. closeFullscreen() calls this AFTER dropping the
                // --fullscreen class, so the page is re-sized for the NORMAL box
                // synchronously, before paint — no big-but-cut-then-shrink-on-flip.
                refitFont: () => { const box = fitMushafPageBox(); autoFitFontSize(box); scheduleBoxSettle(); },
                setFontLock: (b) => { FS_FONT_LOCK = !!b; },
                goPrev: () => goPrev(),
                goNext: () => goNext(),
                reciters: DEPS?.reciters || {},
                reciterOrder: DEPS?.reciterOrder || [],
                getCurrentReciter: () => DEPS?.getCurrentReciter?.(),
                handleSettingsChip: (chip) => handleSettingsChip(chip),
                syncSettingsUI: () => syncSettingsUI(),
                // Name for the floating fullscreen title: the LAST surah on the page — i.e.
                // the NEW one when a page ends one surah and starts the next, so the title
                // shows the surah you're moving INTO (e.g. الكهف, not الإسراء). Single-surah
                // pages → that surah. Falls back to TARGET_SURAH if page data isn't ready.
                getCurrentSurahName: () => {
                    const surahs = CURRENT_PAGE_DATA?.surahs;
                    const id = surahs?.length ? surahs[surahs.length - 1].id : TARGET_SURAH;
                    return id ? chapterArabicName(id) : "";
                },
            });
        } catch (e) {
            console.error("page-fullscreen load failed", e);
        }
    });
}

function applyTargetHighlight({ noScroll = false } = {}) {
    if (!ACTIVE_PAGE_EL || !CURRENT_TARGET_VERSE) return;
    const els = ACTIVE_PAGE_EL.querySelectorAll(`.mushaf-ayah[data-verse-key="${CSS.escape(CURRENT_TARGET_VERSE)}"]`);
    if (!els.length) return;
    els.forEach((el) => el.classList.add("mushaf-ayah--target"));
    // A DELIBERATE jump to a specific ayah (search-bar pick / surah selector /
    // deep link) scrolls to THAT ayah. A page FLIP clears CURRENT_TARGET_VERSE
    // (goPrev/goNext), so this can never fire on a flip — the reader's scroll
    // position stays put. Web + fullscreen keep the centered scrollIntoView;
    // in-app reading is a DOCUMENT scroll, so it glides the window to the ayah
    // under the fixed header, and only when the ayah isn't already fully visible
    // (a visible ayah must not jump). See scrollTargetAyahIntoView.
    if (!noScroll) {
        const fullscreen = !!ROOT_EL?.classList.contains("mushaf-root--fullscreen");
        if (isApp() && !fullscreen) {
            scrollTargetAyahIntoView(els[0]);
        } else {
            els[0].scrollIntoView({ behavior: "smooth", block: "center" });
        }
    }
    setTimeout(() => els.forEach((el) => el.classList.remove("mushaf-ayah--target")), 4000);
}

// App reading is a document-scroll layout: the constant-19px page is taller than the
// viewport, so it scrolls. On a FRESH ENTRY (cold load / deep link at the very top) this
// tucks the hero away once — scrolls DOWN so the page top sits just under the fixed
// header. It is NOT called on a page flip (commitPageState calls it only for a non-flip
// arrival), so a swipe never moves the reader's scroll position. It also only ever
// scrolls DOWN, never up, so it can't pull a reader who has scrolled into the page.
function lockReadingScrollTop() {
    if (!isApp() || !ROOT_EL) return;
    if (ROOT_EL.classList.contains("mushaf-root--fullscreen")) return;
    const header = document.querySelector("header.site-header");
    const headerBottom = header ? Math.round(header.getBoundingClientRect().bottom) : 0;
    const docTop = Math.round(ROOT_EL.getBoundingClientRect().top + window.scrollY);
    const target = Math.max(0, docTop - headerBottom);
    // Only ever scroll DOWN to the lock point (tuck the hero away on entry) — NEVER pull
    // the page UP. If the user has scrolled down to read, a flip keeps their position put.
    if (window.scrollY < target - 2) window.scrollTo(0, target);
}

/* A DELIBERATE in-app jump to a specific ayah (search-bar pick / surah selector /
 * deep link) GLIDES that ayah into the reading area under the fixed header — and
 * only when it isn't already fully visible, so a visible ayah never jumps (the
 * requested behaviour: smooth when the ayah is off-screen below, no movement when
 * it's already up in view). In-app reading is a DOCUMENT scroll, so it scrolls the
 * window. A page FLIP clears CURRENT_TARGET_VERSE, so applyTargetHighlight — the
 * only caller — never reaches here on a flip; the reader's scroll stays put.
 *
 * Poll-until-steady (NOT a fixed frame count — the iOS overlay lesson): the panel
 * reveal (.t-panel-slide) animates translateY up to 160px over 400ms, so the
 * ayah's getBoundingClientRect() is offset until the reveal settles; scrolling
 * early would land at the wrong place. Wait for the rect to hold still (capped so
 * it can't hang), then scroll from the settled position. */
function scrollTargetAyahIntoView(el) {
    if (!el || !CURRENT_TARGET_VERSE) return;
    const myKey = CURRENT_TARGET_VERSE;
    let reduce = false;
    try { reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { }
    let lastTop = null, steady = 0, frames = 0;
    const tick = () => {
        // A newer jump superseded this one, or the page swapped out — abandon so
        // we can never scroll to a stale target.
        if (CURRENT_TARGET_VERSE !== myKey || !el.isConnected) return;
        const top = Math.round(el.getBoundingClientRect().top);
        if (lastTop !== null && Math.abs(top - lastTop) <= 1) steady++; else steady = 0;
        lastTop = top;
        if (steady < 2 && frames++ < 48) { requestAnimationFrame(tick); return; }
        const header = document.querySelector("header.site-header");
        const headerBottom = header ? Math.round(header.getBoundingClientRect().bottom) : 0;
        const margin = 14;
        const usableTop = headerBottom + margin;
        const usableBottom = window.innerHeight - margin;
        const r = el.getBoundingClientRect();
        // Already fully visible below the header → leave the scroll exactly put.
        if (r.top >= usableTop && r.bottom <= usableBottom) return;
        // Otherwise glide it to just under the header (a natural reading start).
        const target = Math.max(0, Math.round(window.scrollY + r.top - usableTop));
        try { window.scrollTo({ top: target, behavior: reduce ? "auto" : "smooth" }); }
        catch { window.scrollTo(0, target); }
    };
    requestAnimationFrame(tick);
}

/* ============================================================
 * Per-page sizing (autoFit) — WIDTH fit only.
 *
 * Every page is sized to ONE width-fit size: size = (container − gutter) ÷ ρ_global,
 * where ρ_global is the widest line's width-per-1px-of-font-size across the WHOLE
 * Mushaf (page 576 is densest; scripts/measure-mushaf-density.mjs) — the comfortable
 * printed-Mushaf MAXIMUM, also the cap (FIT_MAX_PX). There is NO per-page height
 * shrink anymore: a page taller than the viewport simply lets the DOCUMENT scroll.
 *
 * Madani layout is untouched: which words sit on which line is fixed by the page
 * data (+ .mushaf-line nowrap), so font-size can't reflow a line.
 * ============================================================ */
const FIT_SAFETY = 0.98;    // 2% margin for anti-aliasing / sub-pixel rounding
const FIT_MAX_PX = 38;      // cap so it can't get gigantic on wide desktop monitors
// ρ_global, measured across all 604 pages (max is page 576 @ 18.85). Rounded UP
// to 18.9 for safety; FIT_SAFETY adds a further 2%, so no page can overflow.
// Regenerate with `node scripts/measure-mushaf-density.mjs` if fonts/data change.
const MUSHAF_DENSEST_RATIO = 18.9;

// boxHeight is vestigial — kept only for the call signature. There is no height-fit
// anymore; sizing is width-fit only (see header) and the document scrolls when tall.
function autoFitFontSize(boxHeight) {
    if (!ACTIVE_PAGE_EL || !PAGES_EL) return;
    // The fullscreen wrap-zoom ([data-fs-zoom]) owns its own size via CSS
    // !important overrides (lines wrap there) — leave the page alone.
    if (ACTIVE_PAGE_EL.closest('[data-fs-zoom]')) return;
    // Side gutter the widest line must stay inside. Normal view keeps 16px (the
    // page reserves ~8px×2). Fullscreen reclaims to 2px (immersive, padding-less).
    const gutter = ACTIVE_PAGE_EL.closest('.mushaf-root--fullscreen') ? 2 : 16;
    const containerWidth = PAGES_EL.clientWidth - gutter;
    if (containerWidth <= 0) return;
    // WIDTH fit = the comfortable MAXIMUM (printed-Mushaf look): the widest line
    // just fits the container. This is the target size for a normal/sparse page,
    // and the cap — a page is never sized LARGER than this.
    let newSize = (containerWidth / MUSHAF_DENSEST_RATIO) * FIT_SAFETY;
    if (newSize > FIT_MAX_PX) newSize = FIT_MAX_PX;
    newSize = Math.round(newSize * 2) / 2;   // stable 0.5px step
    ACTIVE_PAGE_EL.style.setProperty('--font-size', `${newSize}px`);
    // Natural width-fit (~19px) — NO height shrink. The page keeps its big, printed-Mushaf
    // size. If it's taller than the area below the chrome the DOCUMENT scrolls; a flip keeps
    // the reader's current scroll position (it never resets), so reading isn't interrupted.
    // boxHeight is unused in normal view (kept for the signature / fullscreen).
    void boxHeight;
}

/* ============================================================
 * Per-page box reset (APP, normal view). The old pinned-box "Tarteel" model — which
 * sized .mushaf-stage to a constant per-device box and distributed the page's rows to
 * fill it — was replaced by natural-height reading: the page renders at its width-fit
 * size and the DOCUMENT scrolls. So this just clears any leftover inline height (and
 * the legacy scroll class) and returns null; autoFitFontSize() owns the real sizing.
 * Kept as the shared post-render / settle hook. Website + fullscreen own their layouts.
 * ============================================================ */

function fitMushafPageBox() {
    if (!isApp() || !PAGES_EL) return null;
    const root = PAGES_EL.closest(".mushaf-root");
    if (!root) return null;
    const stage = PAGES_EL.closest(".mushaf-stage");
    if (!stage) return null;

    // ── FULLSCREEN ──────────────────────────────────────────────────────────
    // Stage = full viewport (flex column; the page is centered via margin:auto on
    // .mushaf-pages). At zoom-1 the page is intentionally enlarged + scrollable —
    // do NOT pin it. At zoom-0, give .mushaf-pages a CONSTANT height (viewport
    // minus the stage's own top/bottom padding) so the centered page is the same
    // height on every page and never jumps on flip. The page fills + distributes
    // its lines via the fullscreen app-fit CSS.
    if (root.classList.contains("mushaf-root--fullscreen")) {
        // Fullscreen renders each page at its NATURAL width-fit (max) size and
        // CENTERS it via margin:auto on .mushaf-pages — NO fixed box, no height
        // shrink. There's room for any page at the max size, so every page is the
        // same large size and flipping never shrinks it (returning null → autoFit
        // gets no boxHeight → no per-page shrink). Un-pin any height we set.
        PAGES_EL.style.removeProperty("height");
        return null;
    }

    // ── WINDOWED reading: NATURAL big size (~19px), document scrolls ─────────
    // Do NOT pin the stage or shrink the font — the page renders at its full width-fit
    // (~19px, printed-Mushaf) size. It's taller than the area below the chrome, so the
    // DOCUMENT scrolls; a flip keeps the reader's current scroll position (it is never
    // reset), and the reading background is seamless (no card chrome) so no gap shows at
    // any scroll position.
    stage.style.removeProperty("height");
    PAGES_EL.classList.remove("mushaf-pages--scroll");
    return null;
}

/* Re-fit each frame until the box stops changing — the chrome ABOVE the stage
 * (toolbar, fonts, safe-area) can still be laying out on a cold/resumed load, so
 * the stage's top isn't final on frame 0. A warm flip settles on frame 1-2; a
 * cold start converges as the layout lands (capped so it can't spin). This is
 * what makes the box identical on EVERY page regardless of how it was reached. */
let _boxSettleRAF = 0;
function scheduleBoxSettle() {
    if (!isApp()) return;
    cancelAnimationFrame(_boxSettleRAF);
    let last = NaN, stable = 0, n = 0;
    const tick = () => {
        const b = fitMushafPageBox();
        autoFitFontSize(b);    // re-fit the font from the (possibly updated) box
        n++;
        if (b === last) stable++; else { stable = 0; last = b; }
        if (b == null || stable >= 2 || n > 24) return;   // settled, off-app, or capped (~400ms)
        _boxSettleRAF = requestAnimationFrame(tick);
    };
    _boxSettleRAF = requestAnimationFrame(tick);
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
        // Glowing gharib words own their own interaction — the hover
        // menu must never pop (or stay) over one.
        if (gharibHoverTarget(e.target)) { scheduleMenuHide(); return; }
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
            // Gharib word tap → meaning tooltip instead of audio toggle
            // (desktop path; the touch path is in touchend below). Pass the
            // click point so the tooltip anchors to the pressed glyph.
            if (gharibTapTarget(e.target, { x: e.clientX, y: e.clientY })) return;
            toggleAudioForAyah(ayah.dataset.verseKey);
            return;
        }
        if (header && header.classList.contains("mushaf-surah-header--dimmed")) {
            const sId = Number(header.dataset.surah);
            if (sId) transitionToTargetSurah(sId);
        }
    });

    // Prevent the native context menu + selectstart on the Mushaf page so
    // only our custom tafsir menu appears — no blue handles or Copy popup.
    // selectstart fires on touchstart of a long-press BEFORE contextmenu,
    // and on Android the OS commits to a selection at selectstart; killing
    // only contextmenu is too late. CSS (.mushaf-root/.mushaf-page/.mushaf-ayah
    // user-select:none + touch-callout:none) is the primary guard; these
    // listeners are belt-and-braces for any descendant that re-enables
    // selection (e.g. the QCF4 word spans) or if the WebView's user-select
    // honor is patchy. touchstart can't preventDefault here — it's passive
    // for tap performance — so the OS gesture has to be blocked via these
    // selection-specific events.
    pageEl.addEventListener("contextmenu", (e) => {
        if (e.target.closest(".mushaf-ayah")) e.preventDefault();
    });
    pageEl.addEventListener("selectstart", (e) => {
        e.preventDefault();
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
        const pressX = e.touches[0].clientX;
        const pressY = e.touches[0].clientY;
        TOUCH_START = { x: pressX, y: pressY, target: ayah };
        TOUCH_MOVED = false;
        LONG_PRESS_FIRED = false;
        clearTimeout(LONG_PRESS_TIMER);
        LONG_PRESS_TIMER = setTimeout(() => {
            if (!TOUCH_MOVED) {
                LONG_PRESS_FIRED = true;
                // Bug 3: remember WHERE the finger pressed so the مختصر
                // card can anchor (and scale out of) that exact spot.
                showMenu(ayah, { point: { x: pressX, y: pressY } });
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
        hapticLight();   // light tic when a target ayah is tapped
        // Gharib word tap → meaning tooltip instead of audio toggle. Checked
        // HERE (not in a capture listener) so the long-press bookkeeping
        // above stays intact: a long-press on a gharib word still opens
        // the ayah menu and never reaches this line. The press point anchors
        // the tooltip to the exact pressed glyph.
        if (gharibTapTarget(e.target, { x: start.x, y: start.y })) return;
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
    syncSurahSelectLabel();
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
            // Capture the anchor BEFORE closeAyahMenu wipes it: the exact
            // pressed line fragment + (touch) the press coordinates.
            const anchorEl = AYAH_MENU_ANCHOR;
            const point = MENU_PRESS_POINT;
            closeAyahMenu();
            openMukhtasarCard(verse, { anchorEl, point });
        } else if (btn.dataset.act === "copy") {
            const verse = AYAH_MENU_VERSE;
            const [s, a] = verse.split(":").map(Number);
            const text = DEPS?.getAyahPlainText?.(s, a) || "";
            if (text) copyAyahText(text);
            closeAyahMenu();
        } else if (btn.dataset.act === "note") {
            // App-only: open the notes editor for this ayah. Lazy-imported
            // so the website bundle never pulls the module.
            const verse = AYAH_MENU_VERSE;
            const [s, a] = verse.split(":").map(Number);
            closeAyahMenu();
            if (isApp()) {
                import("./notes.js")
                    .then((m) => m.openNoteEditor(s, a))
                    .catch((e) => console.error("notes editor load failed", e));
            }
        }
    });
    document.addEventListener("click", (e) => {
        if (!PANEL_OPEN) return;
        if (e.target.closest(".mushaf-ayah") || e.target.closest(".mushaf-ayah-menu")) return;
        closeAyahMenu();
    });
}

/* ============================================================
 * Surah selector (toolbar pill + searchable dropdown)
 *
 * The pill shows "{num} {name_ar}" of the currently-focused surah and opens
 * a searchable list of all 114 surahs. Selecting one calls the existing
 * openMushafAtSurah() so navigation/URL/SEO follow the same path as any
 * other jump. The label re-syncs whenever TARGET_SURAH changes (jump,
 * page flip, or dimmed-ayah switch).
 * ============================================================ */

// Accept Arabic-Indic ٠-٩ and Eastern Arabic-Indic ۰-۹ as western digits.
function normalizeDigits(s) {
    return String(s)
        .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
        .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)));
}
// Diacritic-aware Arabic match: strip tashkeel/tatweel, fold alef/ya/ta-marbuta.
function normalizeArabicForSearch(s) {
    return String(s)
        .normalize("NFC")
        .replace(/[ً-ٰٟ]/g, "")
        .replace(/ـ/g, "")
        .replace(/[إأآٱ]/g, "ا")
        .replace(/ى/g, "ي")
        .replace(/ؤ/g, "و")
        .replace(/ئ/g, "ي")
        .replace(/ة/g, "ه")
        .toLowerCase()
        .trim();
}

let _SURAH_LIST_BUILT = false;
let _SURAH_SELECT_WIRED = false;

/* Auto-focusing the dropdown's search field is a desktop convenience —
 * on touch devices it pops the soft keyboard the moment the selector
 * opens (and iOS then scrolls the page to "reveal" the focused field,
 * fighting the user's gesture). Focus only when the primary input is a
 * fine pointer that can hover; phone users tap the field themselves. */
function canAutofocusSurahSearch() {
    try { return window.matchMedia("(hover: hover) and (pointer: fine)").matches; } catch { return false; }
}

function buildSurahSelectList() {
    const list = document.getElementById("mushafSurahList");
    if (!list) return;
    const meta = DEPS?.surahMeta;
    if (!Array.isArray(meta) || meta.length === 0) return;

    const rows = [];
    for (const s of meta) {
        const num = Number(s.number);
        if (!num) continue;
        const name = s.name_ar || `سورة ${num}`;
        const nameNorm = normalizeArabicForSearch(name);
        rows.push(
            `<li class="mushaf-surah-item" role="option" data-num="${num}" ` +
            `data-name-norm="${nameNorm}" data-num-str="${num}" data-ayahs="${Number(s.ayahs) || 0}" tabindex="-1" ` +
            `aria-selected="false">${name}</li>`
        );
    }
    list.innerHTML = rows.join("");
    _SURAH_LIST_BUILT = true;
    syncSurahSelectLabel();
}

function syncSurahSelectLabel() {
    const nameEl = document.getElementById("mushafSurahSelectName");
    if (!nameEl) return;

    const s = TARGET_SURAH
        || LAST_VIEWED_AYAH?.s
        || (CURRENT_TARGET_VERSE ? Number(String(CURRENT_TARGET_VERSE).split(":")[0]) : null)
        || 1;

    const meta = DEPS?.surahMeta?.find((x) => x.number === s);
    const ch = CHAPTERS?.find((c) => c.id === s);
    const name = meta?.name_ar || ch?.name_arabic || `سورة ${s}`;

    nameEl.textContent = name;

    // Re-evaluate per-surah reciter restrictions for the new target surah
    // (auto-fallback off blocked reciters + refresh chip disabled states).
    DEPS?.enforceReciterForSurah?.(s);
    syncSettingsUI();

    // Mark the current row in the open list.
    const list = document.getElementById("mushafSurahList");
    if (list) {
        list.querySelectorAll(".mushaf-surah-item--current").forEach((el) => {
            el.classList.remove("mushaf-surah-item--current");
            el.setAttribute("aria-selected", "false");
        });
        const row = list.querySelector(`.mushaf-surah-item[data-num="${s}"]`);
        if (row) {
            row.classList.add("mushaf-surah-item--current");
            row.setAttribute("aria-selected", "true");
        }
    }
}

function openSurahDropdown() {
    const dd = document.getElementById("mushafSurahDropdown");
    const btn = document.getElementById("mushafSurahSelectBtn");
    const search = document.getElementById("mushafSurahSearch");
    if (!dd || !btn) return;
    if (!_SURAH_LIST_BUILT) buildSurahSelectList();
    showSurahListPanel();
    _selectorDirty = false;
    _selectorCommitted = false;
    dd.classList.add("mushaf-toolbar__dropdown--open");
    btn.setAttribute("aria-expanded", "true");
    // Round 2, Fix 4d: while open, lift the whole search panel above the
    // frozen header (z-40) and the tafsir chrome so the dropdown can never
    // sink under another layer. Removed on close.
    document.getElementById("searchPanel")?.classList.add("surah-dd-raised");
    installDdScrollGuards();
    if (search) {
        search.value = "";
        filterSurahList("");
    }
    // iOS WebKit: after the Mushaf fullscreen exits (a body overflow +
    // fixed-ancestor toggle), the list's composited scroll region can go
    // stale — touch scrolls then fall through to the page. Forcing a
    // reflow with overflow toggled rebuilds the region on every open.
    const listEl = document.getElementById("mushafSurahList");
    if (listEl) {
        listEl.style.overflowY = "hidden";
        void listEl.offsetHeight;
        listEl.style.overflowY = "";
    }
    // Scroll current row into view, then (desktop only) focus the search.
    requestAnimationFrame(() => {
        const list = document.getElementById("mushafSurahList");
        const cur = list?.querySelector(".mushaf-surah-item--current");
        if (cur && list) {
            const lTop = list.getBoundingClientRect().top;
            const cTop = cur.getBoundingClientRect().top;
            const offset = cTop - lTop - (list.clientHeight / 2) + (cur.offsetHeight / 2);
            list.scrollTop += offset;
        }
        if (canAutofocusSurahSearch()) search?.focus({ preventScroll: true });
    });
}

function closeSurahDropdown() {
    const dd = document.getElementById("mushafSurahDropdown");
    const btn = document.getElementById("mushafSurahSelectBtn");
    if (!dd || !btn) return;
    removeDdScrollGuards();
    dd.classList.remove("mushaf-toolbar__dropdown--open");
    btn.setAttribute("aria-expanded", "false");
    document.getElementById("searchPanel")?.classList.remove("surah-dd-raised");
    // Closed WITHOUT اذهب → put the search bar back to whatever it showed
    // before the picker started reflecting into it (Fix 4a/4c).
    if (_selectorDirty && !_selectorCommitted) DEPS?.onSelectorAbandon?.();
    _selectorDirty = false;
    _selectorCommitted = false;
    // Reset to list view so the next open starts fresh.
    showSurahListPanel();
}

function showSurahListPanel() {
    const listPanel = document.getElementById("mushafSurahListPanel");
    const detailPanel = document.getElementById("mushafSurahDetailPanel");
    if (!listPanel || !detailPanel) return;
    listPanel.hidden = false;
    detailPanel.hidden = true;
}

function showSurahDetailPanel(surahNum) {
    const meta = DEPS?.surahMeta?.find((x) => x.number === surahNum);
    if (!meta) return;
    const listPanel = document.getElementById("mushafSurahListPanel");
    const detailPanel = document.getElementById("mushafSurahDetailPanel");
    const numEl = document.getElementById("mushafSurahDetailNum");
    const nameEl = document.getElementById("mushafSurahDetailName");
    const detailForm = document.getElementById("mushafSurahDetailForm");
    if (!listPanel || !detailPanel || !numEl || !nameEl || !detailForm) return;

    const count = Number(meta.ayahs) || 1;
    numEl.textContent = String(surahNum);
    nameEl.textContent = meta.name_ar || `سورة ${surahNum}`;
    detailForm.dataset.surah = String(surahNum);
    detailForm.dataset.max = String(count);

    listPanel.hidden = true;
    detailPanel.hidden = false;
    // The wheel needs the panel laid out before we measure scroll positions,
    // so build it on the next frame (panel just transitioned out of hidden).
    requestAnimationFrame(() => buildAyahWheel(1, count, 1));
}

function submitSurahDetail() {
    const form = document.getElementById("mushafSurahDetailForm");
    if (!form) return;
    const s = Number(form.dataset.surah);
    const max = Number(form.dataset.max) || 1;
    if (!s) return;

    // Commit any in-progress manual edit so the wheel value is current.
    commitWheelEdit({ silent: true });
    let v = getAyahWheelValue();
    if (!Number.isFinite(v) || v < 1) v = 1;
    if (v > max) v = max;

    hapticLight();   // confirm tic — the ayah is now chosen
    // Fix 4: the pick is final — the reflected bar text persists (commit),
    // and closeSurahDropdown must not run its abandon-restore.
    _selectorCommitted = true;
    closeSurahDropdown();
    DEPS?.onSelectorCommit?.();
    // The search-pill selector always opens the pick in the Mushaf (surah
    // view when the wheel is at 1), regardless of the active mode — a pick
    // here is a "go read this" action, so it lands in the Mushaf reader.
    // Already in Mushaf? Don't move the viewport (the target flash is enough
    // — Task 2); coming from the homepage, let the freshly-opened panel
    // scroll into view.
    const noScroll = MUSHAF_MODE;
    if (v === 1) openMushafAtSurah(s, { noScroll });
    else openMushafAtAyah(s, v, { noScroll });
}

/* ============================================================
 * Ayah wheel picker — transform-driven, no native scroll
 *
 * Drift-free by design: we control the list's translateY directly.
 * - Drag (touch/mouse): finger movement maps 1:1 to wheel position, with
 *   a soft rubber-band past the ends. On release we snap to the nearest
 *   integer with a brief inertia projection from release velocity.
 * - Wheel: each wheel step = ±1 with a snappy CSS transition.
 * - Tap on center band → manual entry input (clamped to range, empty
 *   commit returns to the previous value unchanged).
 * - Tap on top/bottom thirds → ±1 step.
 * - Keyboard: Arrow / PageUp/Down / Home / End / Enter (open edit).
 * - Vibrate(2) ticks on each integer crossing on mobile.
 * ============================================================ */

let _wMin = 1;
let _wMax = 1;
let _wValue = 1;
let _wEditing = false;
let _wWired = false;
let _wDragging = false;
let _wDragStartY = 0;
let _wDragOffsetPx = 0;
let _wValueAtDragStart = 1;
let _wLastMoveY = 0;
let _wLastMoveTs = 0;
let _wVelocity = 0; // px/ms; positive = finger moving down
let _wAnimTimer = null;

const _W_ANIM_MS = 220;

function getWheelItemHeight() {
    const wheel = document.getElementById("mushafAyahWheel");
    if (!wheel) return 32;
    const raw = getComputedStyle(wheel).getPropertyValue("--aw-h").trim();
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : 32;
}

function buildAyahWheel(min, max, initial = 1) {
    const list = document.getElementById("mushafAyahWheelList");
    const wheel = document.getElementById("mushafAyahWheel");
    if (!list || !wheel) return;
    _wMin = min;
    _wMax = max;
    _wValue = Math.max(min, Math.min(max, Math.round(initial) || min));
    _wDragOffsetPx = 0;
    _wDragging = false;
    cancelWheelEdit();
    const rows = [];
    for (let v = min; v <= max; v++) {
        rows.push(`<li class="mushaf-wheel__item" role="option" data-val="${v}">${v}</li>`);
    }
    list.innerHTML = rows.join("");
    wheel.setAttribute("aria-valuemin", String(min));
    wheel.setAttribute("aria-valuemax", String(max));
    if (!_wWired) wireAyahWheel();
    applyWheelTransform({ animated: false });
    updateWheelAria();
}

function setAyahWheelValue(v, { animated = true } = {}) {
    v = Math.max(_wMin, Math.min(_wMax, Math.round(v)));
    if (v === _wValue && _wDragOffsetPx === 0 && !_wDragging) return;
    _wValue = v;
    _wDragOffsetPx = 0;
    applyWheelTransform({ animated });
    updateWheelAria();
    if (animated) wheelTick();
}

function getAyahWheelValue() { return _wValue; }

function applyWheelTransform({ animated = true }) {
    const list = document.getElementById("mushafAyahWheelList");
    const wheel = document.getElementById("mushafAyahWheel");
    if (!list || !wheel) return;
    const h = getWheelItemHeight();
    // The list is padded by H rows top/bottom; translating by -(value-min)*H
    // centers the row for `value` in the viewport. During an active drag,
    // _wDragOffsetPx already holds the FULL finger delta from the drag-start
    // value, so anchor on _wValueAtDragStart — folding the live-updated
    // _wValue in here too would double-count the finger travel (the wheel
    // races at ~2x and the committed _wValue lands at ~half the highlighted
    // ayah, so the اذهب button opens the wrong ayah).
    const base = _wDragging ? _wValueAtDragStart : _wValue;
    const ty = -(base - _wMin) * h + _wDragOffsetPx;
    if (animated) wheel.classList.add("mushaf-wheel--animating");
    else wheel.classList.remove("mushaf-wheel--animating");
    list.style.transform = `translate3d(0, ${ty}px, 0)`;
    applyWheelDistAttrs();
    if (animated) {
        clearTimeout(_wAnimTimer);
        _wAnimTimer = setTimeout(() => {
            wheel.classList.remove("mushaf-wheel--animating");
        }, _W_ANIM_MS + 30);
    }
}

function applyWheelDistAttrs() {
    const list = document.getElementById("mushafAyahWheelList");
    if (!list) return;
    const h = getWheelItemHeight();
    if (h <= 0) return;
    // Center index reflects current effective position (value ± drag). Anchor
    // on the drag-start value while dragging (see applyWheelTransform) so the
    // bold data-dist="0" item tracks the same row the transform centers.
    const base = _wDragging ? _wValueAtDragStart : _wValue;
    const fractionalIdx = (base - _wMin) - (_wDragOffsetPx / h);
    const centerIdx = Math.round(fractionalIdx);
    const items = list.children;
    for (let i = 0; i < items.length; i++) {
        const d = Math.abs(i - centerIdx);
        const v = d <= 3 ? String(d) : "x";
        if (items[i].dataset.dist !== v) items[i].dataset.dist = v;
    }
}

function updateWheelAria() {
    const wheel = document.getElementById("mushafAyahWheel");
    if (wheel) wheel.setAttribute("aria-valuenow", String(_wValue));
    reflectWheelToSearchBar();
}

/* Round 2, Fix 4: every wheel value (initial build, taps, drags, edits)
 * is mirrored into the search bar while the ayah picker is open — the
 * number animates there via the shared swapText. updateWheelAria is the
 * single chokepoint all wheel paths already funnel through. */
let _selectorDirty = false;     // a reflection happened since the dropdown opened
let _selectorCommitted = false; // اذهب was pressed (skip the abandon-restore)

function reflectWheelToSearchBar() {
    const detailPanel = document.getElementById("mushafSurahDetailPanel");
    const form = document.getElementById("mushafSurahDetailForm");
    if (!detailPanel || detailPanel.hidden || !form) return;
    const s = Number(form.dataset.surah);
    if (!s) return;
    _selectorDirty = true;
    DEPS?.onSelectorReflect?.(s, _wValue);
}

function wireAyahWheel() {
    if (_wWired) return;
    const wheel = document.getElementById("mushafAyahWheel");
    const list = document.getElementById("mushafAyahWheelList");
    const input = document.getElementById("mushafAyahWheelInput");
    if (!wheel || !list || !input) return;
    _wWired = true;

    // --- Pointer drag (touch + mouse). touch-action:none on the wheel
    // ensures the browser hands us touch events instead of scrolling.
    wheel.addEventListener("pointerdown", (e) => {
        if (_wEditing) return;
        if (e.button !== undefined && e.button !== 0) return;
        _wDragging = true;
        _wDragStartY = e.clientY;
        _wDragOffsetPx = 0;
        _wValueAtDragStart = _wValue;
        _wLastMoveY = e.clientY;
        _wLastMoveTs = performance.now();
        _wVelocity = 0;
        wheel.classList.add("mushaf-wheel--dragging");
        wheel.classList.remove("mushaf-wheel--animating");
        hapticSelectionStart();
        try { wheel.setPointerCapture(e.pointerId); } catch { }
        e.preventDefault();
    });

    wheel.addEventListener("pointermove", (e) => {
        if (!_wDragging) return;
        const h = getWheelItemHeight();
        const dy = e.clientY - _wDragStartY;
        // Live position in float-step space.
        const stepsRaw = -dy / h;
        const proposed = _wValueAtDragStart + stepsRaw;
        // Rubber-band beyond the ends.
        let effectiveDy = dy;
        if (proposed < _wMin) effectiveDy = dy - (proposed - _wMin) * h * 0.6;
        else if (proposed > _wMax) effectiveDy = dy - (proposed - _wMax) * h * 0.6;
        _wDragOffsetPx = effectiveDy;
        // Live value = nearest integer clamped to range.
        const eff = _wValueAtDragStart + (-effectiveDy / h);
        const live = Math.max(_wMin, Math.min(_wMax, Math.round(eff)));
        if (live !== _wValue) {
            _wValue = live;
            updateWheelAria();
            wheelTick();
        }
        applyWheelTransform({ animated: false });
        // Track velocity for inertia.
        const now = performance.now();
        const dt = now - _wLastMoveTs;
        if (dt > 0) _wVelocity = (e.clientY - _wLastMoveY) / dt;
        _wLastMoveY = e.clientY;
        _wLastMoveTs = now;
    });

    const endDrag = (e) => {
        if (!_wDragging) return;
        _wDragging = false;
        wheel.classList.remove("mushaf-wheel--dragging");
        hapticSelectionEnd();
        try { wheel.releasePointerCapture(e.pointerId); } catch { }

        const h = getWheelItemHeight();
        const dy = _wDragOffsetPx;
        const isTap = Math.abs(dy) < 4 && Math.abs(_wVelocity) < 0.05;

        if (isTap) {
            // Identify the tap zone (top third / center / bottom third).
            const rect = wheel.getBoundingClientRect();
            const tapY = e.clientY - rect.top;
            const third = rect.height / 3;
            if (tapY > third && tapY < third * 2) {
                // Center — open manual edit.
                _wDragOffsetPx = 0;
                applyWheelTransform({ animated: false });
                enterWheelEdit();
                return;
            }
            const step = tapY < third ? -1 : 1;
            _wDragOffsetPx = 0;
            setAyahWheelValue(_wValue + step, { animated: true });
            return;
        }

        // Inertia: project release velocity for ~140ms with light friction.
        const projection = _wVelocity * 140;
        const effectiveDy = dy + projection;
        const targetSteps = -effectiveDy / h;
        let finalValue = Math.round(_wValueAtDragStart + targetSteps);
        finalValue = Math.max(_wMin, Math.min(_wMax, finalValue));
        _wDragOffsetPx = 0;
        // Force the transform even if the rounded value didn't change
        // (we still need to animate from the rubber-banded position back).
        _wValue = finalValue;
        applyWheelTransform({ animated: true });
        updateWheelAria();
    };
    wheel.addEventListener("pointerup", endDrag);
    wheel.addEventListener("pointercancel", endDrag);

    // --- Mouse wheel (desktop, trackpad). Each step = 1 value.
    let wheelAcc = 0;
    wheel.addEventListener("wheel", (e) => {
        if (_wEditing) return;
        e.preventDefault();
        wheelAcc += e.deltaY;
        const threshold = 24;
        while (wheelAcc >= threshold) { setAyahWheelValue(_wValue + 1); wheelAcc -= threshold; }
        while (wheelAcc <= -threshold) { setAyahWheelValue(_wValue - 1); wheelAcc += threshold; }
    }, { passive: false });

    // --- Keyboard.
    wheel.addEventListener("keydown", (e) => {
        if (_wEditing) return;
        if (e.key === "ArrowUp") { e.preventDefault(); setAyahWheelValue(_wValue - 1); }
        else if (e.key === "ArrowDown") { e.preventDefault(); setAyahWheelValue(_wValue + 1); }
        else if (e.key === "Home") { e.preventDefault(); setAyahWheelValue(_wMin); }
        else if (e.key === "End") { e.preventDefault(); setAyahWheelValue(_wMax); }
        else if (e.key === "PageUp") { e.preventDefault(); setAyahWheelValue(_wValue - 5); }
        else if (e.key === "PageDown") { e.preventDefault(); setAyahWheelValue(_wValue + 5); }
        else if (e.key === "Enter") { e.preventDefault(); enterWheelEdit(); }
    });

    // --- Edit input commit handlers. stopPropagation so Enter/Escape don't
    // bubble to the wheel's own keydown listener.
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault(); e.stopPropagation();
            commitWheelEdit();
        } else if (e.key === "Escape") {
            e.preventDefault(); e.stopPropagation();
            cancelWheelEdit();
        }
    });
    input.addEventListener("blur", () => commitWheelEdit());
}

function enterWheelEdit() {
    const wheel = document.getElementById("mushafAyahWheel");
    const input = document.getElementById("mushafAyahWheelInput");
    if (!wheel || !input) return;
    _wEditing = true;
    input.value = String(_wValue);
    input.hidden = false;
    wheel.classList.add("mushaf-wheel--editing");
    requestAnimationFrame(() => {
        input.focus();
        try { input.select(); } catch { }
    });
}

function commitWheelEdit({ silent = false } = {}) {
    const wheel = document.getElementById("mushafAyahWheel");
    const input = document.getElementById("mushafAyahWheelInput");
    if (!wheel || !input || !_wEditing) return;
    _wEditing = false;
    const raw = normalizeDigits(input.value).replace(/\D/g, "");
    let v;
    if (raw === "") {
        // Empty input → return to wheel at current value unchanged.
        v = _wValue;
    } else {
        v = Number(raw);
        if (!Number.isFinite(v) || v < _wMin) v = _wMin;
        if (v > _wMax) v = _wMax;
    }
    input.hidden = true;
    wheel.classList.remove("mushaf-wheel--editing");
    // Force animate even if value unchanged so the user sees the wheel
    // re-engage; silent mode (submit path) skips animation.
    if (v === _wValue) applyWheelTransform({ animated: !silent });
    else setAyahWheelValue(v, { animated: !silent });
}

function cancelWheelEdit() {
    const wheel = document.getElementById("mushafAyahWheel");
    const input = document.getElementById("mushafAyahWheelInput");
    if (!wheel || !input) return;
    _wEditing = false;
    input.hidden = true;
    wheel.classList.remove("mushaf-wheel--editing");
}

function filterSurahList(rawQuery) {
    const list = document.getElementById("mushafSurahList");
    const empty = document.getElementById("mushafSurahEmpty");
    if (!list) return;
    const items = list.querySelectorAll(".mushaf-surah-item");
    const q = String(rawQuery || "").trim();
    let visible = 0;

    if (!q) {
        items.forEach((el) => el.classList.remove("mushaf-surah-item--hidden"));
        if (empty) empty.hidden = true;
        return;
    }

    const qDigits = normalizeDigits(q).replace(/\D/g, "");
    const qName = normalizeArabicForSearch(q);
    const numericOnly = qDigits === normalizeDigits(q).trim() && qDigits.length > 0;

    items.forEach((el) => {
        const numStr = el.dataset.numStr || "";
        const nameNorm = el.dataset.nameNorm || "";
        const matchNum = qDigits ? numStr.startsWith(qDigits) || numStr === qDigits : false;
        const matchName = qName ? nameNorm.includes(qName) : false;
        const show = numericOnly ? matchNum : (matchNum || matchName);
        el.classList.toggle("mushaf-surah-item--hidden", !show);
        if (show) visible++;
    });

    if (empty) empty.hidden = visible !== 0;
}

function wireSurahSelect() {
    if (_SURAH_SELECT_WIRED) return;
    const wrap = document.getElementById("mushafSurahWrap");
    const btn = document.getElementById("mushafSurahSelectBtn");
    const dd = document.getElementById("mushafSurahDropdown");
    const list = document.getElementById("mushafSurahList");
    const search = document.getElementById("mushafSurahSearch");
    const detailBack = document.getElementById("mushafSurahDetailBack");
    const detailForm = document.getElementById("mushafSurahDetailForm");
    if (!wrap || !btn || !dd || !list || !search || !detailBack || !detailForm) return;
    _SURAH_SELECT_WIRED = true;

    btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const isOpen = dd.classList.contains("mushaf-toolbar__dropdown--open");
        if (isOpen) closeSurahDropdown();
        else openSurahDropdown();
    });

    search.addEventListener("input", () => filterSurahList(search.value));

    // Prevent the dropdown's interior clicks from closing it.
    dd.addEventListener("click", (e) => e.stopPropagation());

    // Clicking a surah row swaps to the detail view (ayah picker).
    list.addEventListener("click", (e) => {
        const row = e.target.closest(".mushaf-surah-item");
        if (!row) return;
        const num = Number(row.dataset.num);
        if (!num) return;
        showSurahDetailPanel(num);
    });

    // Back button returns to the list view; focus restore is desktop-only
    // (on touch it would pop the soft keyboard — see canAutofocusSurahSearch).
    detailBack.addEventListener("click", (e) => {
        e.preventDefault();
        showSurahListPanel();
        if (canAutofocusSurahSearch()) {
            requestAnimationFrame(() => search.focus({ preventScroll: true }));
        }
    });

    // Submit ayah picker — Enter on wheel (via its own handler), or click the اذهب button.
    detailForm.addEventListener("submit", (e) => {
        e.preventDefault();
        submitSurahDetail();
    });

    // Keyboard nav inside the search box → moves through visible list rows.
    search.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            e.preventDefault();
            closeSurahDropdown();
            btn.focus();
            return;
        }
        if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter") {
            const visible = Array.from(list.querySelectorAll(".mushaf-surah-item:not(.mushaf-surah-item--hidden)"));
            if (!visible.length) return;
            const activeIdx = visible.findIndex((el) => el.classList.contains("mushaf-surah-item--focus"));
            if (e.key === "Enter") {
                e.preventDefault();
                const row = activeIdx >= 0 ? visible[activeIdx] : visible[0];
                if (!row) return;
                const num = Number(row.dataset.num);
                if (!num) return;
                showSurahDetailPanel(num);
                return;
            }
            e.preventDefault();
            const dir = e.key === "ArrowDown" ? 1 : -1;
            const nextIdx = activeIdx < 0
                ? (dir > 0 ? 0 : visible.length - 1)
                : (activeIdx + dir + visible.length) % visible.length;
            visible.forEach((el) => el.classList.remove("mushaf-surah-item--focus"));
            const next = visible[nextIdx];
            next.classList.add("mushaf-surah-item--focus");
            next.scrollIntoView({ block: "nearest" });
        }
    });

    // Outside-click closes (separate from the existing toolbar handler).
    document.addEventListener("click", (e) => {
        if (!wrap.contains(e.target)) closeSurahDropdown();
    });

}

/* ── Scroll containment while the surah dropdown is open ─────────────────
 * Guarantees touch/wheel scrolling NEVER leaks to the page behind:
 *   • gestures outside the surah list are cancelled outright;
 *   • gestures ON the list are clamped at its scroll boundaries, so iOS
 *     can't chain the leftover delta to the page (CSS overscroll-behavior
 *     alone isn't honoured when WebKit's stale hit-testing routes the
 *     gesture to the root scroller — the post-fullscreen-exit scroll trap).
 * The ayah wheel is transform-driven via pointer events (touch-action:
 * none), so cancelling its touchmove is a no-op for it.
 *
 * The non-passive listeners exist ONLY while the dropdown is open
 * (installed/removed by open/closeSurahDropdown) — a permanent non-passive
 * document touchmove/wheel listener would force every scroll in the app
 * onto the slow path. */
let _ddTouchY = 0;

function ddGuardTouchStart(e) {
    _ddTouchY = e.touches[0]?.clientY ?? 0;
}

function ddGuardTouchMove(e) {
    if (!e.cancelable) return; // a native scroll already committed
    const t = e.target instanceof Element ? e.target : null;
    const list = document.getElementById("mushafSurahList");
    if (!t || !list || !t.closest("#mushafSurahList")) {
        e.preventDefault();
        return;
    }
    const dy = (e.touches[0]?.clientY ?? 0) - _ddTouchY;
    const atTop = list.scrollTop <= 0;
    const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 1;
    if ((atTop && dy > 0) || (atBottom && dy < 0)) e.preventDefault();
}

function ddGuardWheel(e) {
    const t = e.target instanceof Element ? e.target : null;
    // List wheel-scroll is contained by overscroll-behavior; anything else
    // must not move the page while the selector is open.
    if (!t || !t.closest("#mushafSurahList")) e.preventDefault();
}

function installDdScrollGuards() {
    document.addEventListener("touchstart", ddGuardTouchStart, { passive: true });
    document.addEventListener("touchmove", ddGuardTouchMove, { passive: false });
    document.addEventListener("wheel", ddGuardWheel, { passive: false });
}

function removeDdScrollGuards() {
    document.removeEventListener("touchstart", ddGuardTouchStart);
    document.removeEventListener("touchmove", ddGuardTouchMove);
    document.removeEventListener("wheel", ddGuardWheel);
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

    // --- Settings dropdown: hover (mouse only) + click toggle ---
    // Hover must be FILTERED to mouse pointers: a touch tap synthesizes
    // mouseenter (opened the panel) and then fires click (toggled it shut)
    // — net effect, the gear never opened from a single tap on phones.
    if (settingsWrap && settingsDD) {
        let hideT = null;
        settingsWrap.addEventListener("pointerenter", (e) => {
            if (e.pointerType !== "mouse") return;
            clearTimeout(hideT);
            settingsDD.classList.add("mushaf-toolbar__dropdown--open");
            syncSettingsUI();
        });
        settingsWrap.addEventListener("pointerleave", (e) => {
            if (e.pointerType !== "mouse") return;
            clearTimeout(hideT);
            hideT = setTimeout(() => settingsDD.classList.remove("mushaf-toolbar__dropdown--open"), 350);
        });
        settingsBtn?.addEventListener("click", (e) => { e.stopPropagation(); settingsDD.classList.toggle("mushaf-toolbar__dropdown--open"); syncSettingsUI(); });
        // Touch has no mouseleave — a tap anywhere outside closes the panel.
        document.addEventListener("click", (e) => {
            if (!settingsDD.classList.contains("mushaf-toolbar__dropdown--open")) return;
            if (settingsWrap.contains(e.target)) return;
            settingsDD.classList.remove("mushaf-toolbar__dropdown--open");
        });
    }

    // --- Volume dropdown: shows on mouse hover while audio is playing ---
    // Filter to mouse pointers so a touch release (which synthesizes a
    // mouseleave) cannot close the dropdown that the long-press just opened.
    // Dispatching `m7:vol-dropdown-open` lets the fullscreen overlay
    // (page-fullscreen.js) close its own settings panel for mutual exclusion.
    if (playWrap && volDD) {
        let volHideT = null;
        playWrap.addEventListener("pointerenter", (e) => {
            if (e.pointerType !== "mouse") return;
            if (!AUDIO_VERSE) return; // only show when audio is active
            clearTimeout(volHideT);
            volDD.classList.add("mushaf-toolbar__dropdown--open");
            document.dispatchEvent(new CustomEvent("m7:vol-dropdown-open"));
        });
        playWrap.addEventListener("pointerleave", (e) => {
            if (e.pointerType !== "mouse") return;
            clearTimeout(volHideT);
            volHideT = setTimeout(() => volDD.classList.remove("mushaf-toolbar__dropdown--open"), 350);
        });
    }

    // --- Play button click ---
    playBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        if (AUDIO_VERSE) toggleAudioForAyah(AUDIO_VERSE);
        else if (LAST_VIEWED_AYAH) toggleAudioForAyah(`${LAST_VIEWED_AYAH.s}:${LAST_VIEWED_AYAH.a}`);
    });

    // --- Touch-only long-press to open the volume/speed dropdown ---
    // Mobile has no hover, so the dropdown is otherwise unreachable until
    // audio starts playing. The synthetic click that fires when the user
    // releases is swallowed (capture phase) so the long-press doesn't also
    // toggle playback. Mouse pointers ignored — desktop already has hover.
    if (playBtn && volDD) {
        const LONG_PRESS_MS = 500;
        const MOVE_THRESHOLD_PX = 14;
        let lpTimer = null;
        let lpFired = false;
        let lpStartX = 0, lpStartY = 0;
        let lpPointerId = null;
        const lpCancel = () => {
            if (lpTimer != null) { clearTimeout(lpTimer); lpTimer = null; }
            lpPointerId = null;
        };
        playBtn.addEventListener("pointerdown", (e) => {
            if (e.pointerType === "mouse") return;
            lpFired = false;
            lpStartX = e.clientX; lpStartY = e.clientY;
            lpCancel();
            lpPointerId = e.pointerId;
            lpTimer = setTimeout(() => {
                lpTimer = null;
                if (lpPointerId !== e.pointerId) return;
                lpFired = true;
                // Toggle: a second hold on an already-open panel closes it.
                const opened = volDD.classList.toggle("mushaf-toolbar__dropdown--open");
                // Same mutual-exclusion signal as the hover path — only fire on
                // the open→true transition so a toggle-CLOSE doesn't trigger it.
                if (opened) document.dispatchEvent(new CustomEvent("m7:vol-dropdown-open"));
                if (navigator.vibrate) { try { navigator.vibrate(15); } catch { } }
            }, LONG_PRESS_MS);
        });
        playBtn.addEventListener("pointermove", (e) => {
            if (lpTimer == null || e.pointerId !== lpPointerId) return;
            const dx = e.clientX - lpStartX, dy = e.clientY - lpStartY;
            if (dx * dx + dy * dy > MOVE_THRESHOLD_PX * MOVE_THRESHOLD_PX) lpCancel();
        });
        playBtn.addEventListener("pointerup", lpCancel);
        playBtn.addEventListener("pointercancel", lpCancel);
        // Note: deliberately NOT cancelling on pointerleave — some WebViews
        // synthesize pointerleave mid-touch when the finger drifts slightly
        // off the button, which would kill the long-press just before fire.
        playBtn.addEventListener("click", (e) => {
            if (!lpFired) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            lpFired = false;
        }, true);
    }

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
    // Canonical Mushaf play/pause point — fires for both the full-surah engine
    // and the per-ayah <audio>, so mirror it to the OS now-playing card here.
    mediaSession.setPlaybackState(playing ? "playing" : "paused");
    if (playing) pushMushafNowPlaying();
    if (!PLAYBACK_PLAY_BTN) return;
    PLAYBACK_PLAY_BTN.innerHTML = playing ? ICONS.pause : ICONS.play;
    PLAYBACK_PLAY_BTN.setAttribute("aria-label", playing ? "إيقاف" : "تشغيل");
    PLAYBACK_PLAY_BTN.setAttribute("data-playing", playing ? "true" : "false");
}

/** Feed the lock-screen card the current Mushaf surah + reciter. */
function pushMushafNowPlaying() {
    const s = surahAudio.isActive()
        ? surahAudio.getSurah()
        : Number(String(AUDIO_VERSE || "").split(":")[0]);
    if (!s) return;
    const reciter = DEPS?.getCurrentReciter?.();
    mediaSession.setNowPlaying({
        surahName: DEPS?.surahMeta?.find((x) => x.number === s)?.name_ar,
        reciterName: DEPS?.reciters?.[reciter]?.name,
    });
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

function showMenu(ayahEl, { reposition = false, point = null } = {}) {
    if (!AYAH_MENU_EL || !ayahEl) return;
    if (!reposition) {
        AYAH_MENU_VERSE = ayahEl.dataset.verseKey;
        AYAH_MENU_ANCHOR = ayahEl;
        // Long-press passes the touch point; desktop hover passes none and
        // the مختصر card anchors to the hovered line fragment's rect.
        MENU_PRESS_POINT = point;
        AYAH_MENU_EL.setAttribute("data-view", "main");
        AYAH_MENU_EL.classList.add("mushaf-ayah-menu--open");
        AYAH_MENU_EL.setAttribute("aria-hidden", "false");
        setSelectedAyah(ayahEl);
    }
    // Position. The menu is position: absolute inside ROOT_EL, so its
    // left/top are in ROOT_EL's CONTENT coordinate system. The ayah's
    // boundingClientRect is in viewport coordinates. The diff gives the
    // visible offset — plus ROOT_EL.scrollTop/Left to convert to content
    // coordinates (important in fullscreen where ROOT_EL is scrollable).
    const rect = ayahEl.getBoundingClientRect();
    const rootRect = ROOT_EL.getBoundingClientRect();
    const scrollLeft = ROOT_EL.scrollLeft || 0;
    const scrollTop = ROOT_EL.scrollTop || 0;
    const menuW = AYAH_MENU_EL.offsetWidth;
    const menuH = AYAH_MENU_EL.offsetHeight;
    let left = rect.left + rect.width / 2 - menuW / 2 - rootRect.left + scrollLeft;
    let top = rect.bottom + 8 - rootRect.top + scrollTop;
    const maxLeft = rootRect.width - menuW - 8 + scrollLeft;
    const minLeft = 8 + scrollLeft;
    if (left < minLeft) left = minLeft;
    if (left > maxLeft) left = maxLeft;
    if ((top - scrollTop) + menuH > rootRect.height - 8) {
        top = rect.top - menuH - 8 - rootRect.top + scrollTop;
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
    clearSelectedAyah();
}

/* Soft on-brand highlight on the currently-actioned ayah. Only one at a
 * time; previous highlight is cleared automatically. */
let SELECTED_AYAH_EL = null;
function setSelectedAyah(ayahEl) {
    if (SELECTED_AYAH_EL && SELECTED_AYAH_EL !== ayahEl) {
        SELECTED_AYAH_EL.classList.remove("mushaf-ayah--selected");
    }
    SELECTED_AYAH_EL = ayahEl || null;
    ayahEl?.classList.add("mushaf-ayah--selected");
}
function clearSelectedAyah() {
    if (SELECTED_AYAH_EL) {
        SELECTED_AYAH_EL.classList.remove("mushaf-ayah--selected");
        SELECTED_AYAH_EL = null;
    }
}

/* Copy ayah Arabic text to the clipboard and surface a brief confirmation
 * toast. Uses navigator.clipboard with a textarea fallback for older
 * WebViews / non-secure contexts. */
async function copyAyahText(text) {
    if (!text) return;
    let ok = false;
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            ok = true;
        }
    } catch { /* fall through */ }
    if (!ok) {
        try {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.setAttribute("readonly", "");
            ta.style.position = "fixed";
            ta.style.top = "-1000px";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            ok = document.execCommand("copy");
            document.body.removeChild(ta);
        } catch { ok = false; }
    }
    if (ok) {
        if (navigator.vibrate) { try { navigator.vibrate(10); } catch { } }
        showCopyToast("تم النسخ", { success: true });
    } else {
        showCopyToast("تعذّر النسخ");
    }
}

/* Lightweight one-off toast (bottom-center). Single shared element.
 *
 * Task 6: the success variant leads with the animated check (stroke-draw +
 * fade + rotate + blur + bob — Transitions.dev success check) and keeps a
 * small "تم النسخ" label beside it. The check strokes with currentColor and
 * the toast's color is var(--text) (see .copy-toast in mushaf.css), so the
 * mark is dark-on-light in the light theme and light-on-dark in the dark
 * theme. Hold ≈900ms after the entrance, then the toast fades out.
 * Failure messages keep the plain text-only toast. */
let _copyToastEl = null;
let _copyToastTimer = null;
function showCopyToast(msg, { success = false } = {}) {
    if (!_copyToastEl) {
        _copyToastEl = document.createElement("div");
        _copyToastEl.className = "copy-toast";
        _copyToastEl.setAttribute("role", "status");
        _copyToastEl.setAttribute("aria-live", "polite");
        document.body.appendChild(_copyToastEl);
    }
    let check = null;
    if (success) {
        _copyToastEl.textContent = "";
        check = buildSuccessCheck();
        _copyToastEl.appendChild(check);
        const label = document.createElement("span");
        label.className = "copy-toast__label";
        label.textContent = msg;
        _copyToastEl.appendChild(label);
    } else {
        _copyToastEl.textContent = msg;
    }
    // Force reflow so the transition runs on each call.
    _copyToastEl.classList.remove("copy-toast--show");
    void _copyToastEl.offsetWidth;
    _copyToastEl.classList.add("copy-toast--show");
    if (check) playSuccessCheck(check); // dasharray from getTotalLength at runtime
    clearTimeout(_copyToastTimer);
    // Success: check entrance (~500ms) + ~900ms hold, then fade. Errors
    // keep the previous 1800ms.
    _copyToastTimer = setTimeout(() => {
        _copyToastEl?.classList.remove("copy-toast--show");
    }, success ? 1400 : 1800);
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

async function openMukhtasarCard(verseKey, { anchorEl = null, point = null } = {}) {
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
    // Bug 3: anchor at the exact pressed line fragment (+ press point when
    // the menu came from a long-press). The side decision is made once per
    // open in positionMukhtasarCard so the card never jumps after loading.
    MUKHTASAR_ANCHOR_EL = (anchorEl && anchorEl.isConnected) ? anchorEl : null;
    MUKHTASAR_POINT = point || null;
    MUKHTASAR_SIDE = null;
    MUKHTASAR_DRAGGED = false;
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
    // Scale+fade open from center — the Transitions.dev modal snippet
    // verbatim (.t-modal CSS in index.html).
    modalOpen(MUKHTASAR_EL);

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
    // Re-clamp for the grown content — same side, never a flip — unless the
    // user already dragged the card somewhere on purpose.
    if (!MUKHTASAR_DRAGGED) positionMukhtasarCard();
}

/* Card height estimate for the side decision: header + ref + body at its
 * 220px max-height + footer + paddings. Using the grown size up front keeps
 * the below/above choice stable across the loading → loaded transition. */
const MUKHTASAR_EST_H = 350;

function positionMukhtasarCard() {
    if (!MUKHTASAR_EL || !MUKHTASAR_VERSE) return;
    // Bug 3: prefer the captured pressed fragment — an ayah wrapped across
    // lines has SEVERAL .mushaf-ayah spans with the same verse-key, and
    // querySelector's first match may sit a line above the actual press
    // (that mismatch is what made the card spawn above/below seemingly at
    // random). Fall back to the first fragment if the anchor left the DOM.
    let anchor = MUKHTASAR_ANCHOR_EL;
    if (!anchor || !anchor.isConnected) {
        anchor = ACTIVE_PAGE_EL?.querySelector(
            `.mushaf-ayah[data-verse-key="${CSS.escape(MUKHTASAR_VERSE)}"]`);
    }
    if (!anchor) return;

    const rect = anchor.getBoundingClientRect();
    const cardW = MUKHTASAR_EL.offsetWidth;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const anchorX = MUKHTASAR_POINT ? MUKHTASAR_POINT.x : rect.left + rect.width / 2;

    let left = anchorX - cardW / 2;
    if (left < 10) left = 10;
    if (left + cardW > vw - 10) left = Math.max(10, vw - cardW - 10);

    // Decide below/above ONCE per open, by available space. The card must
    // ALWAYS hug the pressed ayah: when the loaded card outgrows the
    // chosen side, the scrollable body is CAPPED to fit — never slide the
    // card away from the ayah. (The old viewport clamp did exactly that:
    // on phones, an ayah mid-screen picked "above", the loaded card
    // overflowed, and the clamp parked it at the top of the screen.)
    const spaceBelow = vh - rect.bottom - 20;
    const spaceAbove = rect.top - 20;
    if (!MUKHTASAR_SIDE) {
        MUKHTASAR_SIDE = spaceBelow >= MUKHTASAR_EST_H ? "below"
            : spaceAbove >= MUKHTASAR_EST_H ? "above"
                : spaceBelow >= spaceAbove ? "below" : "above";
    }
    const space = MUKHTASAR_SIDE === "below" ? spaceBelow : spaceAbove;
    let cardH = MUKHTASAR_EL.offsetHeight;
    if (MUKHTASAR_BODY_EL) {
        MUKHTASAR_BODY_EL.style.maxHeight = ""; // re-measure at natural size
        cardH = MUKHTASAR_EL.offsetHeight;
        if (cardH > space) {
            const chrome = cardH - MUKHTASAR_BODY_EL.offsetHeight;
            MUKHTASAR_BODY_EL.style.maxHeight =
                `${Math.max(80, space - chrome)}px`;
            cardH = MUKHTASAR_EL.offsetHeight;
        }
    }
    const top = MUKHTASAR_SIDE === "below"
        ? rect.bottom + 10
        : Math.max(10, rect.top - cardH - 10);
    MUKHTASAR_EL.style.left = `${left}px`;
    MUKHTASAR_EL.style.top = `${top}px`;
    // The open/close scale runs from the .t-modal default transform-origin
    // (center) — the exact Transitions.dev modal snippet. The old
    // grow-out-of-the-press-point origin read as a lopsided pop.
}

function closeMukhtasarCard() {
    if (!MUKHTASAR_EL) return;
    MUKHTASAR_REQ_ID++; // invalidate any in-flight fetch
    MUKHTASAR_EL.classList.remove("mushaf-mukhtasar--open");
    MUKHTASAR_EL.setAttribute("aria-hidden", "true");
    MUKHTASAR_VERSE = null;
    MUKHTASAR_ANCHOR_EL = null;
    // Task 4: scale+fade close (is-closing dropped on transitionend, with
    // the timeout fallback inside modalClose).
    modalClose(MUKHTASAR_EL);
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
    let startX = 0, startY = 0;       // pointer at grab
    let lastMoveX = 0, lastMoveY = 0; // freshest pointer position
    let baseLeft = 0, baseTop = 0;    // the card's left/top VALUES at grab
    let curLeft = 0, curTop = 0;      // last clamped position (committed on release)
    let moved = false;
    let raf = 0;
    let cachedW = 0, cachedVW = 0, cachedVH = 0; // card + viewport, read once at grab

    header.addEventListener("pointerdown", (e) => {
        if (e.target.closest(".mushaf-mukhtasar__close")) return;
        if (e.button !== undefined && e.button !== 0) return;

        dragging = true;
        // The user is taking over placement — the post-load reposition in
        // openMukhtasarCard must not snap the card back to the ayah.
        MUKHTASAR_DRAGGED = true;
        activePointer = e.pointerId;

        startX = e.clientX;
        startY = e.clientY;
        lastMoveX = startX;
        lastMoveY = startY;
        // Read left/top from computed style — the SAME coordinate space the
        // positioner writes into. getBoundingClientRect is viewport space,
        // which silently diverges from left/top space the moment ANY
        // ancestor gains a transform/filter containing block (the app's
        // fullscreen scroll-lock and WebView quirks) — seeding the drag
        // from the rect made the card teleport by exactly that divergence
        // on the first grab.
        const cs = getComputedStyle(MUKHTASAR_EL);
        baseLeft = parseFloat(cs.left) || 0;
        baseTop = parseFloat(cs.top) || 0;
        curLeft = baseLeft;
        curTop = baseTop;
        moved = false;
        // Cache the card + viewport size ONCE here — neither changes during a
        // drag, so applyDrag stays layout-read-free (compositor-only) per frame.
        cachedW = MUKHTASAR_EL.offsetWidth;
        cachedVW = window.innerWidth;
        cachedVH = window.innerHeight;

        MUKHTASAR_EL.classList.add("mushaf-mukhtasar--dragging");
        try { header.setPointerCapture(e.pointerId); } catch { }
        e.preventDefault();
    });

    // Moves ride a compositor translate (left/top stay frozen at their grab
    // values) and are batched to one write per frame — layout-free, so the
    // card tracks the finger smoothly even on the WebView.
    const applyDrag = () => {
        raf = 0;
        if (!dragging) return;

        const cardW = cachedW, vw = cachedVW, vh = cachedVH; // cached at grab

        let left = baseLeft + (lastMoveX - startX);
        let top = baseTop + (lastMoveY - startY);

        // Soft viewport constraint: keep at least a strip of the header
        // visible on every edge so the user can always grab it back. The
        // card can drift partly off-screen otherwise — total freedom.
        const edge = 40;
        if (left + cardW < edge) left = edge - cardW;
        if (left > vw - edge) left = vw - edge;
        if (top < 0) top = 0;
        if (top > vh - edge) top = vh - edge;

        curLeft = left;
        curTop = top;
        moved = true;
        MUKHTASAR_EL.style.transform =
            `translate3d(${left - baseLeft}px, ${top - baseTop}px, 0)`;
    };

    header.addEventListener("pointermove", (e) => {
        if (!dragging || e.pointerId !== activePointer) return;
        lastMoveX = e.clientX;
        lastMoveY = e.clientY;
        if (!raf) raf = requestAnimationFrame(applyDrag);
    });

    const endDrag = (e) => {
        if (!dragging) return;
        if (e && e.pointerId !== undefined && e.pointerId !== activePointer) return;
        dragging = false;
        activePointer = null;
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        // Commit the travelled delta into left/top and hand the transform
        // back to the .t-modal scale — all while --dragging still holds
        // transitions off, with a forced style flush before the class drops.
        // Without that flush, re-enabled transitions would see the inline
        // translate3d → scale(1) change and glide the card backwards.
        if (moved) {
            MUKHTASAR_EL.style.left = `${curLeft}px`;
            MUKHTASAR_EL.style.top = `${curTop}px`;
        }
        MUKHTASAR_EL.style.transform = "";
        void MUKHTASAR_EL.offsetWidth;
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

    /* Per-surah availability gate: if the active reciter has no recording
     * for the tapped surah, fall back to an allowed reciter BEFORE
     * resolving any URLs.
     * Without this, tapping an ayah on a page outside the reciter's
     * coverage cold-loads a 404 and surfaces the offline-error card.
     * Surah-selector navigation already enforces this (see goToSurah);
     * this covers direct page taps. Stop first so enforce's switchReciter
     * does a clean swap instead of mid-play resume of the OLD surah. */
    if (DEPS?.isReciterAllowedForSurah &&
        !DEPS.isReciterAllowedForSurah(DEPS?.getCurrentReciter?.(), vs)) {
        stopMushafAudio();
        DEPS?.enforceReciterForSurah?.(vs);
    }

    /* ── Continuous mode → full-surah engine ──
     * engineOnly reciters (e.g. dosari) have no per-ayah files, so single
     * mode also routes through the engine — startMushafSurahEngine passes
     * continuous: AUDIO_MODE === "continuous", which the engine honours.
     * Downloaded reciters likewise route through the engine so single-mode
     * Mushaf taps play from the offline cache. */
    const reciter = DEPS?.getCurrentReciter?.() || "alijaber";
    const reciterEngineOnly = !!DEPS?.reciters?.[reciter]?.engineOnly;
    const reciterOffline = !!DEPS?.isReciterOfflineReady?.(reciter);
    if (AUDIO_MODE === "continuous" || reciterEngineOnly || reciterOffline) {
        const engineLoaded = surahAudio.isActive() && surahAudio.getSurah() === vs && surahAudio.getReciter() === reciter;
        if (engineLoaded && AUDIO_VERSE === verseKey) {
            // Same ayah → pause/resume
            if (surahAudio.isPlaying()) { surahAudio.pause(); }
            else { surahAudio.resume(); }
            return;
        }
        if (engineLoaded) {
            // Different ayah, same surah → fast-path seek. Defensive kill of
            // any stale Tafsir-side per-ayah <audio> (engine is the sole
            // active source after this seek).
            DEPS?.stopTafsirPerAyahAudio?.();
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
    const [hs, ha] = verseKey.split(":");
    reflectBarAyah(hs, ha);
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
            reflectBarAyah(newSurah, newAyah);
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
            if (!isOfflineAudioError(err)) return; // pause/switch abort, not offline
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
    // RIGID: kill BOTH per-ayah <audio> elements before the engine starts.
    // The engine itself is cold-reloaded by surahAudio.play() below.
    if (AUDIO_PLAYER) { try { AUDIO_PLAYER.pause(); } catch { } AUDIO_PLAYER = null; }
    DEPS?.stopTafsirPerAyahAudio?.();

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
        if (!isOfflineAudioError(err)) return; // superseded / pause abort, not offline
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

    // RIGID: about to spawn a NEW Mushaf-side <audio>. Kill the engine
    // (if it was on a previous source) and the Tafsir-side per-ayah
    // <audio>. Without this, switching modes mid-play and then clicking
    // an ayah here would layer streams.
    if (surahAudio.isActive()) surahAudio.stop();
    DEPS?.stopTafsirPerAyahAudio?.();

    const [s, a] = verseKey.split(":").map(Number);
    const nextAudio = new Audio(buildAyahAudioUrl(s, a));
    nextAudio.volume = AUDIO_VOLUME;
    nextAudio.playbackRate = AUDIO_SPEED;
    // Seed the repeat counter for this ayah. 1× = no replays; 3×/5×/∞ = loop.
    repeatStart(verseKey);

    // Swap highlight FIRST — visual feedback should not wait on the network.
    if (AUDIO_VERSE && AUDIO_VERSE !== verseKey) clearHighlight(AUDIO_VERSE);
    const prevPlayer = AUDIO_PLAYER;
    AUDIO_PLAYER = nextAudio;
    AUDIO_VERSE = verseKey;
    document.documentElement.setAttribute("data-audio-active", "1");
    highlightAyah(verseKey, "playing");
    reflectBarAyah(s, a);
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
        // Repeat hook: replay in place if the loop still has plays left.
        if (repeatConsume(verseKey)) {
            try {
                nextAudio.currentTime = 0;
                const p = nextAudio.play();
                if (p && typeof p.catch === "function") p.catch(() => { });
            } catch { }
            return;
        }
        stopMushafAudio();
    });
    nextAudio.addEventListener("error", () => {
        if (AUDIO_PLAYER !== nextAudio) return;
        stopMushafAudio();
        if (isOfflineAudioError(nextAudio.error)) showMushafAudioOffline();
    });
    nextAudio.play().catch((e) => {
        if (AUDIO_PLAYER !== nextAudio) return; // superseded by another ayah click
        if (!isOfflineAudioError(e)) return;    // pause/abort while online — not offline
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
    // Drop any active repeat loop so the next ayah starts fresh.
    repeatReset();
}

/**
 * Tear down ONLY the mushaf-side per-ayah <audio> element. Called by app.js
 * `switchReciter` when the user changes reciter while a Mushaf-started
 * single-mode ayah is still playing in the background (e.g. user started in
 * Mushaf, switched to Tafsir, then swapped reciter). Without this, the old
 * reciter's stream keeps playing and a fresh play() in Tafsir layers a
 * second stream on top. Leaves the surahAudio engine alone (app.js handles
 * that separately).
 */
export function stopMushafPerAyahAudio() {
    if (!AUDIO_PLAYER) return false;
    const wasPlaying = !AUDIO_PLAYER.paused;
    try { AUDIO_PLAYER.pause(); } catch { }
    AUDIO_PLAYER = null;
    if (AUDIO_VERSE) clearHighlight(AUDIO_VERSE);
    AUDIO_VERSE = null;
    document.documentElement.removeAttribute("data-audio-active");
    setPlaybackPlayingState(false);
    return wasPlaying;
}

/**
 * Snapshot the Mushaf-side per-ayah <audio>'s position, or null if none.
 * Used by app.js's switchReciter to capture playback location BEFORE the
 * swap so it can resume at the same ayah with the new reciter.
 */
export function getMushafPerAyahPosition() {
    if (!AUDIO_PLAYER || !AUDIO_VERSE) return null;
    const parts = AUDIO_VERSE.split(":");
    const s = Number(parts[0]);
    const a = Number(parts[1]);
    if (!Number.isFinite(s) || !Number.isFinite(a)) return null;
    return { surah: s, ayah: a, playing: !AUDIO_PLAYER.paused };
}

/**
 * Public play entry-point for the Mushaf module. Routes via the engine
 * if listening-mode is on, else per-ayah. Called by app.js's
 * resumePerAyahAtPosition when restarting playback after a reciter swap
 * while the user is viewing Mushaf mode.
 */
export function playMushafAyahAtKey(s, a) {
    if (!Number.isFinite(Number(s)) || !Number.isFinite(Number(a))) return;
    const verseKey = `${s}:${a}`;
    const reciter = DEPS?.getCurrentReciter?.() || "alijaber";
    // engineOnly reciters have no per-ayah files, so always use the engine.
    if (AUDIO_MODE === "continuous" || DEPS?.reciters?.[reciter]?.engineOnly) {
        startMushafSurahEngine(Number(s), Number(a), verseKey, reciter);
    } else {
        playMushafAyah(verseKey);
    }
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
    // 4 default chips + a "+ المزيد" chip that reveals the rest as more chips.
    row.innerHTML = buildReciterPickerHtml(DEPS.reciterOrder || Object.keys(DEPS.reciters), DEPS.reciters, DEPS.getCurrentReciter?.());
}

function handleSettingsChip(chip) {
    const group = chip.closest("[data-settings-group]")?.dataset.settingsGroup;
    const val = chip.dataset.val;
    if (group === "reciter") {
        // switchReciter (over in app.js) is the single chokepoint for
        // reciter swaps: it snapshots the currently-playing position,
        // kills ALL foreign audio sources (engine + both per-ayah
        // <audio>s), then restarts at the captured ayah via the current
        // mode's path (calls playMushafAyahAtKey here when in Mushaf).
        // No local replay needed — doing it here would double-start.
        DEPS?.setCurrentReciter?.(val);
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
    } else if (group === "repeat") {
        DEPS?.setRepeatPref?.(val === "inf" ? Infinity : Number(val));
    }
    syncSettingsUI();
}

function syncSettingsUI() {
    const reciter = DEPS?.getCurrentReciter?.();
    const targetSurah = TARGET_SURAH || LAST_VIEWED_AYAH?.s;
    // Iterate DOCUMENT-WIDE so the fullscreen settings panel (a sibling
    // chip group with the same data-settings-group attributes) stays in
    // sync with the toolbar dropdown. Single source of truth wins.
    document.querySelectorAll('[data-settings-group="reciter"] .mushaf-settings__chip').forEach((c) => {
        c.setAttribute("aria-checked", c.dataset.val === reciter ? "true" : "false");
        const allowed = DEPS?.isReciterAllowedForSurah
            ? DEPS.isReciterAllowedForSurah(c.dataset.val, targetSurah)
            : true;
        c.disabled = !allowed;
        c.classList.toggle("mushaf-settings__chip--disabled", !allowed);
        if (!allowed) c.title = "غير متوفر لهذه السورة";
        else c.removeAttribute("title");
    });
    document.querySelectorAll('[data-settings-group="audio-mode"] .mushaf-settings__chip').forEach((c) => {
        c.setAttribute("aria-checked", c.dataset.val === AUDIO_MODE ? "true" : "false");
    });
    // Repeat row: reflect the saved preference. Also hide the entire
    // section whenever audio-mode is "continuous" — the repeat-ayah toggle
    // only makes sense when playing a single ayah.
    const pref = DEPS?.getRepeatPref?.() ?? 1;
    const prefVal = pref === Infinity ? "inf" : String(pref);
    document.querySelectorAll('[data-settings-group="repeat"] .mushaf-settings__chip').forEach((c) => {
        c.setAttribute("aria-checked", c.dataset.val === prefVal ? "true" : "false");
    });
    document.querySelectorAll("[data-repeat-section]").forEach((s) => {
        s.style.display = AUDIO_MODE === "continuous" ? "none" : "";
    });
    // ∞ badge on the play button — only meaningful when both:
    //   (1) repeat preference is ∞, AND
    //   (2) audio-mode is single (repeat doesn't apply in continuous).
    // Without the second check, the badge would stay on after the user
    // switches to "تشغيل متواصل" even though no loop will ever happen.
    const showInfBadge = pref === Infinity && AUDIO_MODE === "single";
    const playBtn = document.getElementById("mushafToolbarPlay");
    if (playBtn) playBtn.classList.toggle("mushaf-toolbar__btn--repeat-inf", showInfBadge);
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
