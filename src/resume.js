/*
 * Resume reading position — APP ONLY.
 *
 * Continuously records the user's current reading position (mode + surah +
 * ayah + page + scroll offset) as they read, and silently restores it when
 * the app is reopened. The website never loads this module (the importer in
 * app.js gates the dynamic import behind isApp()).
 *
 * Two recording entry points:
 *   1. Direct calls from setPrimaryAyah (Tafsir mode) and the Mushaf
 *      navigation funnels — these capture every ayah/page change.
 *   2. A debounced scroll listener that updates scrollY without rewriting
 *      the rest of the record. Scroll fires often, so the listener is
 *      throttled to roughly one save per ~400 ms (idle).
 *
 * The save is best-effort: any error (quota, security, …) is swallowed so a
 * broken resume key can never crash the app. A corrupt JSON blob on read is
 * wiped silently — the user just doesn't restore once.
 */

"use strict";

const STORAGE_KEY = "m7_resume";
const SAVE_DEBOUNCE_MS = 400;

let _state = null;     // last known good state in memory
let _saveTimer = null;
let _scrollSourceEl = null; // optional element to read scrollTop from; null = window

function readStored() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== "object") return null;
        const mode = obj.mode === "mushaf" ? "mushaf" : "tafsir";
        const surah = Number(obj.surah);
        const ayah = Number(obj.ayah);
        const page = Number.isFinite(Number(obj.page)) ? Number(obj.page) : null;
        const scrollY = Number(obj.scrollY) || 0;
        if (!Number.isFinite(surah) || !Number.isFinite(ayah) || surah < 1 || ayah < 1) return null;
        return { mode, surah, ayah, page, scrollY };
    } catch {
        try { localStorage.removeItem(STORAGE_KEY); } catch { }
        return null;
    }
}

function flush() {
    if (!_state) return;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            ..._state,
            ts: Date.now(),
        }));
    } catch { /* quota / security — ignore */ }
}

function scheduleFlush() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
        _saveTimer = null;
        flush();
    }, SAVE_DEBOUNCE_MS);
}

/* Public: record a new resume point. Mutates the in-memory record and
 * debounces a write. Pass `{ mode, surah, ayah, page? }`; scrollY is
 * captured live from the active scroll source. */
export function recordResume(patch) {
    if (!patch) return;
    const next = { ..._state, ...patch };
    if (!Number.isFinite(next.surah) || !Number.isFinite(next.ayah)) return;
    next.scrollY = currentScrollY();
    _state = next;
    scheduleFlush();
}

function currentScrollY() {
    try {
        if (_scrollSourceEl && typeof _scrollSourceEl.scrollTop === "number") {
            return _scrollSourceEl.scrollTop;
        }
    } catch { }
    return window.scrollY || window.pageYOffset || 0;
}

/* Attach the scroll listener. Idempotent — calling twice replaces the
 * source. Pass `null` to fall back to window scroll. */
export function watchScroll(el) {
    if (_scrollSourceEl) {
        try { _scrollSourceEl.removeEventListener("scroll", onScroll); } catch { }
    }
    _scrollSourceEl = el;
    if (el) el.addEventListener("scroll", onScroll, { passive: true });
}

function onScroll() {
    if (!_state) return;
    // Only update scrollY; keep mode/surah/ayah/page unchanged.
    _state = { ..._state, scrollY: currentScrollY() };
    scheduleFlush();
}

/* Public: read the stored resume point without restoring. The caller (init
 * in app.js) decides whether to honour or ignore it depending on the URL. */
export function loadStoredResume() {
    return readStored();
}

/* Public: clear the stored resume point. Used by mode toggles that the user
 * explicitly chose differently (currently unused — kept for completeness). */
export function clearResume() {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    _state = null;
    try { localStorage.removeItem(STORAGE_KEY); } catch { }
}

/* On a page lifecycle hook ('pagehide' / 'visibilitychange' → hidden), flush
 * synchronously so a freshly-recorded position survives even if the app
 * process is killed before the debounce fires. */
export function initResumeAutoflush() {
    const flushNow = () => {
        if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
        flush();
    };
    window.addEventListener("pagehide", flushNow);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flushNow();
    });
    // Default scroll source: window. Overridable via watchScroll(el).
    window.addEventListener("scroll", onScroll, { passive: true });
}
