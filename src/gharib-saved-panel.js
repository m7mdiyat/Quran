/*
 * غريب القرآن — learned-words collection. WEB + APP.
 *
 * Opened by a TAP on the in-Mushaf lantern (#gharibLamp), which dispatches the
 * "gharib:open-saved" event (src/gharib.js). The glass sheet lists every gharib
 * word the user has revealed in the Mushaf — the learned set — each with its
 * meaning and a remove action.
 *
 * The saved collection IS the learned set (one source of truth): removing a
 * word calls gharibForget(), which un-reveals it everywhere (the in-Mushaf
 * glow returns to gold, the lantern count drops). Fully reversible — tapping
 * the word again in the Mushaf re-adds it. The learned store keeps only
 * normalized keys, so gharibSavedWords() reverse-maps each key back to its
 * vocalized word + meaning + location from the gharib dataset.
 *
 * Reuses the .offline-sheet* shell (visual parity with the settings / offline /
 * feedback / notes panels) over a lantern-gold .gharib-saved* row treatment.
 * Dynamic-imported from app.js init() on BOTH web and app — the learned set in
 * localStorage m7_gharib exists on the website too.
 */

"use strict";

import {
    ensureGharibData,
    gharibSavedWords,
    gharibForget,
    gharibForgetAll,
    gharibLearnedCount,
    gharibTipText,
} from "./gharib.js";

let SHEET_EL = null;
let SHEET_OPEN = false;
let _inited = false;
let _confirmingReset = false; // reset-all two-step confirm state
let _pressStartedOnBackdrop = false; // backdrop dismiss only if the press began on it
let _scrollRAF = 0; // rAF handle throttling the scroll-rail update

const REDUCED_MOTION = () => {
    try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
    catch { return false; }
};

/* The lantern (فانوس) — same mark as the in-Mushaf toolbar widget and the
 * header button, so the feature reads as one identity throughout. The flame
 * carries .gharib-saved-btn__flame so the CSS keeps it warmly gold. */
const LAMP_SVG = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M10.7 3.2a1.55 1.55 0 0 1 2.6 0"/>
    <path d="M9.1 6.6c.3-1.7 1.4-2.6 2.9-2.6s2.6.9 2.9 2.6"/>
    <path d="M8.3 6.6h7.4"/>
    <path d="M9.2 6.6l-.5 7.2a1.3 1.3 0 0 0 1.3 1.4h4a1.3 1.3 0 0 0 1.3-1.4l-.5-7.2"/>
    <path class="gharib-saved-btn__flame" d="M12.4 7.4c-1.4 1.7-2.4 2.9-2.4 4.4a2 2 0 0 0 4 0c0-1-.4-1.9-1-2.9.2.7.1 1.2-.2 1.6.5-1.2.3-2.3-.4-3.1z"/>
    <path d="M10.4 15.2l-.6 2.9M13.6 15.2l.6 2.9"/>
    <path d="M9.6 18.1h4.8"/>
  </svg>`;

// The نور — a tiny filled flame for the count chip (the lantern's focal
// point, crisp where a full lantern would muddy at 13px).
const FLAME_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3c2.6 3.1 4.4 5.5 4.4 8.6a4.4 4.4 0 0 1-8.8 0c0-1.2.4-2.3 1.1-3.4.4.6.9 1 1.6 1.1C9.6 7.6 10 5.2 12 3z"/></svg>`;

const TRASH_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7"/><path d="M10 11v6M14 11v6"/></svg>`;

// Grammatically-correct Arabic word count (singular / dual / plural).
function wordsLabel(n) {
    const ar = Number(n).toLocaleString("ar-EG");
    if (n === 1) return "كلمة واحدة";
    if (n === 2) return "كلمتان";
    if (n >= 3 && n <= 10) return `${ar} كلمات`;
    return `${ar} كلمة`;
}

// App-only: pull IBM Plex Sans Arabic for the panel UI (idempotent across
// panels — all three reference the same element ID).
function ensurePanelFont() {
    if (document.getElementById("offlinePanelFont")) return;
    const link = document.createElement("link");
    link.id = "offlinePanelFont";
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap";
    document.head.appendChild(link);
}

function escapeHtml(str = "") {
    return String(str).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
}

// Display the vocalized word: keep its tashkeel (it is the headword), just
// fold the source's elision dots into a single ellipsis.
function wordDisplay(w) {
    return String(w).replace(/\.{2,}|…/g, " … ").replace(/\s+/g, " ").trim();
}

/* ------------------------- Scroll-progress rail ------------------------- */

// Size + place the gold thumb from the list's live scroll metrics: thumb
// height = visible/total, thumb top = scroll fraction of the free track. The
// rail hides itself when the list isn't scrollable (everything fits).
function updateScrollRail() {
    if (!SHEET_EL) return;
    const list = SHEET_EL.querySelector("[data-gh-list]");
    const rail = SHEET_EL.querySelector("[data-gh-scroll]");
    if (!list || !rail) return;
    const thumb = rail.querySelector(".gharib-saved-scroll__thumb");
    const sh = list.scrollHeight, ch = list.clientHeight;
    const scrollable = sh - ch;
    const trackH = rail.clientHeight;
    if (scrollable <= 1 || ch <= 0 || trackH <= 0) {
        rail.classList.remove("is-active"); // fits → no rail
        return;
    }
    const thumbH = Math.min(trackH, Math.max(22, Math.round((ch / sh) * trackH)));
    const maxTop = Math.max(0, trackH - thumbH);
    const top = Math.round((list.scrollTop / scrollable) * maxTop);
    if (thumb) {
        thumb.style.height = `${thumbH}px`;
        thumb.style.transform = `translateY(${top}px)`;
    }
    rail.classList.add("is-active");
}

// Scroll handler: coalesce bursts to one update per frame (transform-only, so
// the thumb tracks the finger 1:1 with no jank).
function onListScroll() {
    if (_scrollRAF) return;
    _scrollRAF = requestAnimationFrame(() => { _scrollRAF = 0; updateScrollRail(); });
}

// Re-measure after layout settles (open / render / row removal / resize).
function scheduleRailUpdate() {
    requestAnimationFrame(updateScrollRail);
}

/* ----------------------------- Sheet ----------------------------- */

function buildSheet() {
    if (SHEET_EL) return SHEET_EL;
    ensurePanelFont();
    const wrap = document.createElement("div");
    wrap.id = "gharibSavedSheet";
    wrap.className = "offline-sheet offline-sheet--smooth";
    wrap.setAttribute("aria-hidden", "true");
    wrap.innerHTML = `
      <div class="offline-sheet__backdrop" data-gh-close></div>
      <div class="offline-sheet__card" role="dialog" aria-modal="true" aria-labelledby="gharibSavedTitle">
        <button type="button" class="offline-sheet__close" data-gh-close aria-label="إغلاق">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
        <div class="offline-sheet__head">
          <div class="offline-sheet__icon" aria-hidden="true">${LAMP_SVG}</div>
          <h2 id="gharibSavedTitle" class="offline-sheet__title">غريب القرآن</h2>
          <p class="offline-sheet__desc">هنا تجتمع كلمات القرآن الغريبة التي تعلّمت معناها. كلما <span class="gharib-saved-tadabbur">أضأت</span> كلمةً وفهمتها، أُضيفت إلى حصيلتك في هذه القائمة.</p>
          <div class="gharib-saved-meta" data-gh-meta></div>
        </div>
        <div class="gharib-saved-listwrap">
          <!-- Rail FIRST so it lands on the RIGHT in the panel's RTL flex row;
               the list takes the rest of the width to its left. -->
          <div class="gharib-saved-scroll" data-gh-scroll aria-hidden="true"><div class="gharib-saved-scroll__thumb"></div></div>
          <div class="gharib-saved-list" data-gh-list></div>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    SHEET_EL = wrap;
    wrap.addEventListener("click", onSheetClick);
    // Drive the custom gold scroll-rail from the list's own scroll (rAF-throttled).
    const list = wrap.querySelector("[data-gh-list]");
    if (list) list.addEventListener("scroll", onListScroll, { passive: true });
    // Track where a press BEGINS, so the backdrop only dismisses on a genuine
    // backdrop tap — never on the finger-lift that ends the lantern hold which
    // opened this sheet under the finger (#4).
    wrap.addEventListener("pointerdown", (e) => {
        _pressStartedOnBackdrop = !!e.target.closest(".offline-sheet__backdrop");
    });
    return wrap;
}

// Empty: the head (lantern + title + desc) IS the empty state now — nothing
// renders below it until the first word is revealed.
function emptyHtml() {
    return "";
}

// One revealed word as a single horizontal gloss: «الكلمة ‹ المعنى».
function rowHtml(item) {
    const word = escapeHtml(wordDisplay(item.w));
    const meaning = item.m ? escapeHtml(gharibTipText(item.m)) : "";
    return `
      <div class="gharib-saved-row" data-gh-row data-key="${escapeHtml(item.key)}">
        <div class="gharib-saved-row__gloss">
          <span class="gharib-saved-row__word">${word}</span>
          ${meaning ? `<span class="gharib-saved-row__sep" aria-hidden="true">›</span><span class="gharib-saved-row__meaning">${meaning}</span>` : ""}
        </div>
        <button type="button" class="gharib-saved-row__remove" data-gh-remove aria-label="إزالة الكلمة">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
      </div>`;
}

// The head meta row: count chip + reset-all button, or the two-step
// reset confirmation. Empty when there are no saved words.
function renderMeta(n) {
    const meta = SHEET_EL?.querySelector("[data-gh-meta]");
    if (!meta) return;
    if (n <= 0) { meta.innerHTML = ""; _confirmingReset = false; return; }
    if (_confirmingReset) {
        meta.innerHTML = `
          <div class="gharib-saved-confirm">
            <span class="gharib-saved-confirm__text">مسح كل الكلمات المحفوظة؟</span>
            <div class="gharib-saved-confirm__actions">
              <button type="button" class="offline-btn offline-btn--danger" data-gh-reset-confirm>نعم، امسح الكل</button>
              <button type="button" class="offline-btn offline-btn--ghost" data-gh-reset-cancel>إلغاء</button>
            </div>
          </div>`;
        return;
    }
    meta.innerHTML = `
      <span class="gharib-saved-count">${FLAME_SVG}<span>${wordsLabel(n)}</span></span>
      <button type="button" class="gharib-saved-reset" data-gh-reset aria-label="مسح كل الكلمات">
        ${TRASH_SVG}<span>مسح الكل</span>
      </button>`;
}

async function renderList() {
    if (!SHEET_EL) return;
    const slot = SHEET_EL.querySelector("[data-gh-list]");
    if (!slot) return;

    // No learned words → empty state immediately, and never fetch the dataset
    // (a word can only be learned by tapping it in the Mushaf, which already
    // loads gharib.json — so an empty set means the data was never needed).
    if (gharibLearnedCount() === 0) {
        slot.innerHTML = emptyHtml();
        renderMeta(0);
        scheduleRailUpdate();
        return;
    }

    slot.innerHTML = `<div class="gharib-saved-loading">…جارٍ جمع كلماتك</div>`;
    await ensureGharibData();
    if (!SHEET_OPEN) return; // closed mid-load

    const words = gharibSavedWords();
    renderMeta(words.length);
    slot.innerHTML = words.length ? words.map(rowHtml).join("") : emptyHtml();
    scheduleRailUpdate();
}

function removeRow(rowEl, key) {
    if (!gharibForget(key)) { rowEl.remove(); return; }
    renderMeta(gharibLearnedCount());

    const finish = () => {
        rowEl.remove();
        const slot = SHEET_EL?.querySelector("[data-gh-list]");
        if (slot && !slot.querySelector(".gharib-saved-row")) slot.innerHTML = emptyHtml();
        scheduleRailUpdate(); // content shrank → resize/hide the rail
    };

    if (REDUCED_MOTION()) { finish(); return; }

    // Collapse-out: pin the current height, then transition to 0 (the CSS owns
    // the easing). Guard the listener so a stray transitionend can't double-fire.
    rowEl.style.maxHeight = `${rowEl.scrollHeight}px`;
    void rowEl.offsetHeight; // commit the start height
    rowEl.classList.add("gharib-saved-row--removing");
    let done = false;
    const onEnd = (e) => {
        if (e && e.target !== rowEl) return; // ignore child transitions
        if (done) return;
        done = true;
        rowEl.removeEventListener("transitionend", onEnd);
        finish();
    };
    rowEl.addEventListener("transitionend", onEnd);
    setTimeout(onEnd, 420); // fallback if transitionend never lands
}

function onSheetClick(e) {
    const closeEl = e.target.closest("[data-gh-close]");
    if (closeEl) {
        // The ✕ button always closes. The backdrop closes only if the press
        // STARTED on it — so the finger-lift that ends the lantern hold (which
        // opened this sheet under the finger) can't immediately dismiss it.
        const isBackdrop = closeEl.classList.contains("offline-sheet__backdrop");
        const started = _pressStartedOnBackdrop;
        _pressStartedOnBackdrop = false;
        if (isBackdrop && !started) return;
        closeSheet();
        return;
    }

    // Reset-all (two-step confirm), in the head meta row.
    if (e.target.closest("[data-gh-reset]")) {
        _confirmingReset = true;
        renderMeta(gharibLearnedCount());
        return;
    }
    if (e.target.closest("[data-gh-reset-cancel]")) {
        _confirmingReset = false;
        renderMeta(gharibLearnedCount());
        return;
    }
    if (e.target.closest("[data-gh-reset-confirm]")) {
        gharibForgetAll();
        _confirmingReset = false;
        renderList(); // → empty state + cleared meta
        return;
    }

    const removeBtn = e.target.closest("[data-gh-remove]");
    if (removeBtn) {
        const row = removeBtn.closest("[data-gh-row]");
        if (row) removeRow(row, row.dataset.key);
    }
}

function onKeyDown(e) {
    if (e.key === "Escape" && SHEET_OPEN) closeSheet();
}

function openSheet() {
    buildSheet();
    SHEET_OPEN = true;
    _confirmingReset = false; // never reopen mid-confirm
    _pressStartedOnBackdrop = false; // a hold-open starts with no backdrop press
    void SHEET_EL.offsetWidth; // commit the closed (hidden) state so the first open transitions
    SHEET_EL.classList.add("offline-sheet--open");
    SHEET_EL.setAttribute("aria-hidden", "false");
    document.body.classList.add("offline-sheet-open");
    renderList();
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", scheduleRailUpdate); // re-fit rail on rotate/resize
}

function closeSheet() {
    SHEET_OPEN = false;
    if (SHEET_EL) {
        SHEET_EL.classList.remove("offline-sheet--open");
        SHEET_EL.setAttribute("aria-hidden", "true");
    }
    document.body.classList.remove("offline-sheet-open");
    document.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("resize", scheduleRailUpdate);
    if (_scrollRAF) { cancelAnimationFrame(_scrollRAF); _scrollRAF = 0; }
}

/* ----------------------------- Init ----------------------------- */

export function initGharibSavedPanel() {
    // Web + app: the Mushaf lamp tap (src/gharib.js) dispatches
    // "gharib:open-saved"; the old top-bar #gharibSavedBtn is gone. The
    // learned set (localStorage m7_gharib) exists on the website too, so the
    // collection opens there as well. Idempotent.
    if (_inited) return;
    _inited = true;
    document.addEventListener("gharib:open-saved", () => {
        if (SHEET_OPEN) closeSheet(); else openSheet();
    });
}
