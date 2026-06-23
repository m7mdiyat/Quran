/*
 * Settings hub — APP ONLY.
 *
 * One header gear button (#settingsMenuBtn) opens a glass sheet that collects
 * what used to be separate top-bar buttons:
 *   - التحميل للاستخدام بدون إنترنت → opens the existing offline sheet
 *   - إرسال ملاحظة                  → opens the existing feedback sheet
 *   - إظهار غريب القرآن             → the gharib glow on/off (moved off the lamp,
 *                                     whose tap now opens the learned-words list)
 *   - الوضع الليلي                  → mirrors the top-bar dark-mode toggle
 *
 * Reuses the `.offline-sheet*` shell for visual parity. The two link rows just
 * hand off to the existing panels (nothing about their behaviour changed).
 * Dynamic-imported from app.js init() behind isApp(); the website never loads it.
 */

"use strict";

import { isApp } from "./app.js";
import { openOfflinePanel, initOfflinePanel } from "./offline-panel.js";
import { openFeedbackPanel } from "./feedback-panel.js";

let SHEET_EL = null;
let BTN_EL = null;
let SHEET_OPEN = false;
let _deps = null;

const ICONS = {
    cloud: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.25 15a4.5 4.5 0 004.5 4.5H18a3.75 3.75 0 001.332-7.257 3 3 0 00-3.758-3.848 5.25 5.25 0 00-10.233 2.33A4.502 4.502 0 002.25 15z"/><path d="M12 10.5v6m0 0l-2.25-2.25M12 16.5l2.25-2.25"/></svg>`,
    chat: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z"/></svg>`,
    moon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`,
    gear: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9 1.65 1.65 0 0 0 4.27 7.18l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
    chevron: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>`,
    close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>`,
};

// App-only: pull IBM Plex Sans Arabic for the panel UI (idempotent across
// panels — all reference the same element ID).
function ensurePanelFont() {
    if (document.getElementById("offlinePanelFont")) return;
    const link = document.createElement("link");
    link.id = "offlinePanelFont";
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap";
    document.head.appendChild(link);
}

function linkRow(act, icon, title, desc, iconMod = "") {
    return `
      <button type="button" class="settings-row settings-row--link" data-settings-act="${act}">
        <span class="settings-row__icon${iconMod}">${icon}</span>
        <span class="settings-row__text">
          <span class="settings-row__title">${title}</span>
          <span class="settings-row__desc">${desc}</span>
        </span>
        <span class="settings-row__chevron">${ICONS.chevron}</span>
      </button>`;
}

function toggleRow(key, icon, title, desc, iconMod = "") {
    return `
      <button type="button" class="settings-row settings-row--toggle" role="switch" aria-checked="false" data-settings-toggle="${key}">
        <span class="settings-row__icon${iconMod}">${icon}</span>
        <span class="settings-row__text">
          <span class="settings-row__title">${title}</span>
          <span class="settings-row__desc">${desc}</span>
        </span>
        <span class="settings-switch" aria-hidden="true"><span class="settings-switch__thumb"></span></span>
      </button>`;
}

function buildSheet() {
    if (SHEET_EL) return SHEET_EL;
    ensurePanelFont();
    const wrap = document.createElement("div");
    wrap.id = "settingsSheet";
    wrap.className = "offline-sheet";
    wrap.setAttribute("aria-hidden", "true");
    wrap.innerHTML = `
      <div class="offline-sheet__backdrop" data-settings-close></div>
      <div class="offline-sheet__card" role="dialog" aria-modal="true" aria-labelledby="settingsSheetTitle">
        <button type="button" class="offline-sheet__close" data-settings-close aria-label="إغلاق">${ICONS.close}</button>
        <div class="offline-sheet__head">
          <div class="offline-sheet__icon" aria-hidden="true">${ICONS.gear}</div>
          <h2 id="settingsSheetTitle" class="offline-sheet__title">الإعدادات</h2>
          <p class="offline-sheet__desc">التحميل بدون إنترنت، ملاحظاتك، وخيارات العرض.</p>
        </div>
        <div class="settings-list">
          ${linkRow("offline", ICONS.cloud, "التحميل للاستخدام بدون إنترنت", "المصحف والتفاسير على جهازك.")}
          ${linkRow("feedback", ICONS.chat, "إرسال ملاحظة", "رأيك أو بلاغك يصلني مباشرة.")}
          ${toggleRow("dark", ICONS.moon, "الوضع الليلي", "مظهر داكن مريح للقراءة ليلًا.")}
        </div>
      </div>`;
    document.body.appendChild(wrap);
    SHEET_EL = wrap;
    wrap.addEventListener("click", onSheetClick);
    return wrap;
}

function syncToggles() {
    if (!SHEET_EL) return;
    const d = SHEET_EL.querySelector('[data-settings-toggle="dark"]');
    if (d) d.setAttribute("aria-checked", String(!!_deps?.isDark?.()));
}

function onSheetClick(e) {
    if (e.target.closest("[data-settings-close]")) { closeSheet(); return; }

    const link = e.target.closest("[data-settings-act]");
    if (link) {
        const act = link.dataset.settingsAct;
        // Close this sheet, then open the target. Both share body.offline-sheet-open,
        // so the lock nets to a no-op (no scroll jump); see sheet-scroll-lock.js.
        closeSheet();
        if (act === "offline") openOfflinePanel();
        else if (act === "feedback") openFeedbackPanel();
        return;
    }

    const toggle = e.target.closest("[data-settings-toggle]");
    if (toggle && toggle.dataset.settingsToggle === "dark") {
        _deps?.toggleDark?.();
        toggle.setAttribute("aria-checked", String(!!_deps?.isDark?.()));
    }
}

function onKeyDown(e) {
    if (e.key === "Escape" && SHEET_OPEN) closeSheet();
}

function openSheet() {
    buildSheet();
    SHEET_OPEN = true;
    syncToggles(); // reflect live state every open (dark mode may change elsewhere)
    SHEET_EL.classList.add("offline-sheet--open");
    SHEET_EL.setAttribute("aria-hidden", "false");
    document.body.classList.add("offline-sheet-open");
    document.addEventListener("keydown", onKeyDown);
}

function closeSheet() {
    SHEET_OPEN = false;
    if (SHEET_EL) {
        SHEET_EL.classList.remove("offline-sheet--open");
        SHEET_EL.setAttribute("aria-hidden", "true");
    }
    document.body.classList.remove("offline-sheet-open");
    document.removeEventListener("keydown", onKeyDown);
}

export function initSettingsPanel(deps) {
    if (!isApp()) return; // defensive — the import is already gated in app.js
    _deps = deps || {};
    BTN_EL = document.getElementById("settingsMenuBtn");
    if (!BTN_EL) return;
    BTN_EL.style.display = ""; // reveal (was display:none by default)
    BTN_EL.addEventListener("click", () => {
        if (SHEET_OPEN) closeSheet(); else openSheet();
    });
    // The offline first-launch coachmark now points at this Settings button.
    initOfflinePanel();
}
