/*
 * Mushaf fullscreen mode — APP ONLY.
 *
 * Architecture: NO clone, NO separate DOM. We just add the
 * `mushaf-root--fullscreen` CSS class to the real Mushaf root and the
 * existing layout fills the viewport. Result: page swipe, page-change
 * animation, ayah tap-to-play and the long-press menu (مختصر / نسخ /
 * ملاحظة) all work natively because they're the same DOM, same handlers.
 *
 * This module only owns four overlay controls while fullscreen is open:
 *
 *   - close (✕)         top-right
 *   - font-size (+)     top-left — cycles 3 levels by multiplying
 *                                  --font-size on the active page
 *   - settings (⚙)      next to font-size — opens a small panel with
 *                                  reciter / audio-mode / repeat (the
 *                                  same chip groups the toolbar already
 *                                  has, minus the play / font-size /
 *                                  surah-selector parts)
 *   - page number       bottom-center
 *
 * The settings panel uses the same `data-settings-group` attributes as
 * the in-toolbar dropdown, so mushaf.js's `syncSettingsUI()` (now
 * document-wide) and `handleSettingsChip()` drive both panels from a
 * single source of truth — no duplicate state, no drift.
 */

"use strict";

import { isApp } from "./app.js";

// Two-state + button. Cycle: 0 (default = normal Madinah Mushaf autoFit)
// → 1 (a little bigger) → 0. Saved between sessions.
const FS_ZOOM_STEPS = 2;
const FS_ZOOM_KEY = "m7_mushaf_fs_zoom";

let _open = false;
let _deps = null;
let _rootEl = null;
let _closeBtn = null;
let _fontBtn = null;
let _settingsBtn = null;
let _settingsPanel = null;
let _settingsOpen = false;
let _navWrap = null;
let _fontLevel = 0;

/* ============================================================ Public ==== */

export function openFullscreen(deps) {
    if (!isApp()) return;
    if (_open) return;
    _deps = deps;
    _rootEl = deps?.rootEl;
    if (!_rootEl) return;

    _open = true;
    _fontLevel = readSavedLevel();
    _rootEl.classList.add("mushaf-root--fullscreen");
    document.body.classList.add("mushaf-fs-open");
    injectControls();
    applyFontLevel();
    updatePageNum();

    document.addEventListener("mushaf:page-rendered", onPageRendered);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("click", onDocumentClick, true);
    window.addEventListener("resize", updatePageNum);
}

export function closeFullscreen() {
    if (!_open) return;
    _open = false;
    document.removeEventListener("mushaf:page-rendered", onPageRendered);
    document.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("click", onDocumentClick, true);
    window.removeEventListener("resize", updatePageNum);

    closeSettingsPanel();
    resetFontOnActivePage();

    _rootEl?.classList.remove("mushaf-root--fullscreen");
    document.body.classList.remove("mushaf-fs-open");
    removeControls();
}

/* ============================================================ Events ==== */

function onPageRendered() {
    updatePageNum();
    updateNavButtons();
}

function onKeyDown(e) {
    if (!_open) return;
    if (e.key === "Escape") {
        e.preventDefault();
        if (_settingsOpen) closeSettingsPanel();
        else closeFullscreen();
    }
}

function onDocumentClick(e) {
    if (!_open || !_settingsOpen) return;
    if (e.target.closest(".mushaf-fs__settings-panel")) return;
    if (e.target.closest(".mushaf-fs__settings-btn")) return;
    closeSettingsPanel();
}

/* ============================================================ Controls = */

function injectControls() {
    if (!_rootEl || _closeBtn) return;

    _closeBtn = document.createElement("button");
    _closeBtn.type = "button";
    _closeBtn.className = "mushaf-fs__close";
    _closeBtn.setAttribute("aria-label", "إغلاق");
    _closeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;
    _closeBtn.addEventListener("click", (e) => { e.stopPropagation(); closeFullscreen(); });

    // Font-size cycle button at top-right. Tap cycles 0 → 1 → 2 → 0.
    // Level 0 = the normal Madinah Mushaf size (autoFit), levels 1 and 2
    // are progressively bigger. The actual sizing lives in CSS keyed off
    // the `data-fs-zoom` attribute on the fullscreen root.
    _fontBtn = document.createElement("button");
    _fontBtn.type = "button";
    _fontBtn.className = "mushaf-fs__font-btn";
    _fontBtn.setAttribute("aria-label", "تكبير حجم الخط");
    _fontBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
    _fontBtn.addEventListener("click", (e) => { e.stopPropagation(); cycleFontLevel(); });

    _settingsBtn = document.createElement("button");
    _settingsBtn.type = "button";
    _settingsBtn.className = "mushaf-fs__settings-btn";
    _settingsBtn.setAttribute("aria-label", "الإعدادات");
    _settingsBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9 1.65 1.65 0 0 0 4.27 7.18l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
    _settingsBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleSettingsPanel(); });

    // Bottom-center page navigation arrows + page number, in a single
    // row. The arrows flank the number so there's no overlap and the
    // whole control sits comfortably near the bottom edge.
    _navWrap = document.createElement("div");
    _navWrap.className = "mushaf-fs__nav";
    _navWrap.innerHTML = `
      <button type="button" class="mushaf-fs__nav-btn mushaf-fs__nav-btn--prev" aria-label="الصفحة السابقة">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
      </button>
      <div class="mushaf-fs__nav-page" data-fs-nav-page></div>
      <button type="button" class="mushaf-fs__nav-btn mushaf-fs__nav-btn--next" aria-label="الصفحة التالية">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
      </button>`;
    // RTL convention: the LEFT chevron advances FORWARD (next page,
    // because Arabic reading flows right-to-left, so the next page sits
    // on the left). The RIGHT chevron goes BACK to the previous page.
    // Note: the visual classes (--prev / --next) are kept as-is just so
    // the chevron SVGs don't need to change; only the click action is
    // flipped here.
    _navWrap.addEventListener("click", (e) => {
        e.stopPropagation();
        if (e.target.closest(".mushaf-fs__nav-btn--prev")) {
            // left chevron → forward / next page
            try { _deps?.goNext?.(); } catch { }
        } else if (e.target.closest(".mushaf-fs__nav-btn--next")) {
            // right chevron → backward / previous page
            try { _deps?.goPrev?.(); } catch { }
        }
    });

    _rootEl.appendChild(_closeBtn);
    _rootEl.appendChild(_fontBtn);
    _rootEl.appendChild(_settingsBtn);
    _rootEl.appendChild(_navWrap);
    updateNavButtons();
}

function removeControls() {
    _closeBtn?.remove(); _closeBtn = null;
    _fontBtn?.remove(); _fontBtn = null;
    _settingsBtn?.remove(); _settingsBtn = null;
    _navWrap?.remove(); _navWrap = null;
    _settingsPanel?.remove(); _settingsPanel = null;
}

function updateNavButtons() {
    if (!_navWrap) return;
    const cur = _deps?.getCurrentPageNum?.() || 0;
    const total = _deps?.totalPages || 604;
    // Mapping is flipped: --prev button = forward (next page),
    // --next button = backward (previous page).
    const leftBtn = _navWrap.querySelector(".mushaf-fs__nav-btn--prev");
    const rightBtn = _navWrap.querySelector(".mushaf-fs__nav-btn--next");
    if (leftBtn) leftBtn.disabled = cur >= total;   // can't go forward past last page
    if (rightBtn) rightBtn.disabled = cur <= 1;     // can't go back before page 1
}

/* ============================================================ Font size = */

/* Apply the current font-zoom level by setting `data-fs-zoom` on the
 * fullscreen root. The actual font-size override is in CSS rules with
 * !important (see mushaf.css `.mushaf-root--fullscreen[data-fs-zoom=...]`),
 * so the override beats autoFit's inline setProperty calls and survives
 * any resize/render. */
function applyFontLevel() {
    if (!_rootEl) return;
    if (_fontLevel <= 0) {
        // Level 0 = default = exactly the normal Madinah Mushaf autoFit
        // size. Remove the attribute so no CSS override kicks in.
        _rootEl.removeAttribute("data-fs-zoom");
    } else {
        _rootEl.setAttribute("data-fs-zoom", String(_fontLevel));
    }
}

function cycleFontLevel() {
    _fontLevel = (_fontLevel + 1) % FS_ZOOM_STEPS;
    saveLevel(_fontLevel);
    applyFontLevel();
    // Quick pop animation so the tap is acknowledged.
    if (_fontBtn) {
        _fontBtn.classList.remove("mushaf-fs__font-btn--pop");
        void _fontBtn.offsetWidth;
        _fontBtn.classList.add("mushaf-fs__font-btn--pop");
    }
}

function resetFontOnActivePage() {
    if (!_rootEl) return;
    _rootEl.removeAttribute("data-fs-zoom");
}

/* ----------------------------- localStorage ----------------------------- */

function readSavedLevel() {
    try {
        const v = localStorage.getItem(FS_ZOOM_KEY);
        const n = parseInt(v, 10);
        if (Number.isFinite(n) && n >= 0 && n < FS_ZOOM_STEPS) return n;
    } catch { }
    return 0;
}

function saveLevel(n) {
    try { localStorage.setItem(FS_ZOOM_KEY, String(n)); } catch { }
}

/* ============================================================ Page num == */

function updatePageNum() {
    if (!_navWrap) return;
    const slot = _navWrap.querySelector("[data-fs-nav-page]");
    if (!slot) return;
    const cur = _deps?.getCurrentPageNum?.() || 0;
    slot.textContent = cur ? toArabicDigits(cur) : "";
}

function toArabicDigits(n) {
    const map = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"];
    return String(n).replace(/\d/g, (d) => map[Number(d)]);
}

/* ============================================================ Settings = */

function toggleSettingsPanel() {
    if (_settingsOpen) closeSettingsPanel();
    else openSettingsPanel();
}

function openSettingsPanel() {
    if (!_rootEl) return;
    if (!_settingsPanel) buildSettingsPanel();
    if (!_settingsPanel) return;
    _settingsOpen = true;
    _settingsPanel.classList.add("mushaf-fs__settings-panel--open");
    _settingsPanel.setAttribute("aria-hidden", "false");
    // Push the panel state through the shared sync so chip checkmarks +
    // disabled-reciter state + repeat-row visibility all reflect reality.
    try { _deps?.syncSettingsUI?.(); } catch { }
}

function closeSettingsPanel() {
    _settingsOpen = false;
    _settingsPanel?.classList.remove("mushaf-fs__settings-panel--open");
    _settingsPanel?.setAttribute("aria-hidden", "true");
}

function buildSettingsPanel() {
    if (!_rootEl || _settingsPanel) return;

    const reciters = _deps?.reciters || {};
    const reciterOrder = _deps?.reciterOrder || [];
    const reciterChipsHtml = reciterOrder.map((key) => {
        const r = reciters[key] || {};
        const name = r.name || key;
        return `<button type="button" class="mushaf-settings__chip" data-val="${key}">${name}</button>`;
    }).join("");

    const panel = document.createElement("div");
    panel.className = "mushaf-fs__settings-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "إعدادات وضع التدبر");
    panel.setAttribute("aria-hidden", "true");
    panel.innerHTML = `
      <div class="mushaf-settings__section">
        <div class="mushaf-settings__label">القارئ</div>
        <div class="mushaf-settings__row mushaf-settings__row--pills" data-settings-group="reciter">${reciterChipsHtml}</div>
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
      </div>`;
    // Delegate chip clicks to mushaf's shared handler. The handler updates
    // state and calls syncSettingsUI document-wide, which keeps both this
    // panel and the toolbar dropdown in sync.
    panel.addEventListener("click", (e) => {
        const chip = e.target.closest(".mushaf-settings__chip");
        if (!chip) return;
        try { _deps?.handleSettingsChip?.(chip); } catch { }
    });

    _rootEl.appendChild(panel);
    _settingsPanel = panel;
}
