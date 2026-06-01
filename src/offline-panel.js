/*
 * Offline downloads panel — APP ONLY.
 *
 * Surfaces a header cloud-arrow button that opens a centered glass sheet with
 * two rows (Mushaf, Tafsir). Each row shows one of:
 *   - idle:        "تحميل" button + size
 *   - downloading: live progress bar + rotating Arabic message
 *   - offline:     inline "no connection" pill (auto-retries on `online`)
 *   - done:        "متاح بدون إنترنت" badge + re-download + delete
 *   - error:       inline error pill + retry
 *
 * The download functions live in mushaf.js and app.js; this module only
 * subscribes to their pub/sub state and renders. Closing the panel does NOT
 * cancel a running download — the in-flight promise + ready flag are owned by
 * the download modules, not by the panel.
 *
 * Dynamic-imported from app.js init() behind `if (isApp())`, so the web bundle
 * never even pulls this code. Feedback lives in a sibling module
 * (feedback-panel.js) opened by its own header button.
 */

"use strict";

import {
    downloadQcf4Assets,
    subscribeQcf4,
    isQcf4Ready,
    deleteQcf4Cache,
    QCF4_TOTAL_MB,
} from "./mushaf.js";
import {
    downloadTafsirAssets,
    subscribeTafsirDl,
    isTafsirReady,
    deleteTafsirCache,
    TAFSIR_TOTAL_MB,
} from "./app.js";

let SHEET_EL = null;
let BTN_EL = null;
let UNSUB_QCF4 = null;
let UNSUB_TAFSIR = null;
let SHEET_OPEN = false;
// Per-row pending-confirm state: "delete" or null.
const PENDING_CONFIRM = { mushaf: null, tafsir: null };

const ROW_DEFS = {
    mushaf: {
        title: "وضع المصحف",
        desc: "صفحات المصحف الكاملة وخطوطه.",
        sizeMb: QCF4_TOTAL_MB,
        startDownload: () => downloadQcf4Assets(),
        deleteCache: () => deleteQcf4Cache(),
    },
    tafsir: {
        title: "وضع التفسير",
        desc: "سبعة تفاسير كاملة + ملخّص \"مختصر التفاسير\" لكل آية.",
        sizeMb: TAFSIR_TOTAL_MB,
        startDownload: () => downloadTafsirAssets(),
        deleteCache: () => deleteTafsirCache(),
    },
};

// App-only: pull IBM Plex Sans Arabic from Google Fonts for the panel.
// Injected here (not in CSS) so the website never fetches it.
function ensurePanelFont() {
    if (document.getElementById("offlinePanelFont")) return;
    const link = document.createElement("link");
    link.id = "offlinePanelFont";
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap";
    document.head.appendChild(link);
}

function fmtSize(mb) { return `≈ ${mb} ميجابايت`; }

function statusHtml(rowKey, state) {
    const def = ROW_DEFS[rowKey];
    const status = state?.status || "idle";

    // Inline delete-confirm takes precedence over the normal "done" row.
    if (PENDING_CONFIRM[rowKey] === "delete" && (status === "done" || status === "idle")) {
        return `
          <div class="offline-row__confirm">
            <span class="offline-row__confirm-text">هل أنت متأكد؟ سيُحذف ${fmtSize(def.sizeMb)} من جهازك.</span>
            <div class="offline-row__confirm-actions">
              <button type="button" class="offline-btn offline-btn--danger" data-offline-act="delete-confirm" data-offline-row="${rowKey}">حذف</button>
              <button type="button" class="offline-btn offline-btn--ghost" data-offline-act="delete-cancel" data-offline-row="${rowKey}">إلغاء</button>
            </div>
          </div>`;
    }

    if (status === "downloading") {
        const pct = Math.max(0, Math.min(100, Number(state.pct) || 0));
        const message = state.message || "";
        return `
          <div class="offline-row__progress">
            <div class="mushaf-download__bar"><div class="mushaf-download__fill" style="width:${pct}%"></div></div>
            <div class="offline-row__progress-row">
              <span class="offline-row__progress-msg">${message}</span>
              <span class="offline-row__progress-pct">${pct}%</span>
            </div>
          </div>`;
    }

    if (status === "offline") {
        return `
          <div class="offline-row__pill offline-row__pill--warn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M3 3l18 18M8.5 8.5A11 11 0 003 12m4.5-3.5a11 11 0 0113.5 3.5M12 20h.01"/></svg>
            <span>لا يوجد اتصال بالإنترنت — سيستأنف عند عودة الاتصال</span>
          </div>`;
    }

    if (status === "error") {
        return `
          <div class="offline-row__pill offline-row__pill--err">
            <span>${state.message || "تعذّر التحميل"}</span>
            <button type="button" class="offline-btn offline-btn--ghost" data-offline-act="download" data-offline-row="${rowKey}">إعادة المحاولة</button>
          </div>`;
    }

    if (status === "done") {
        return `
          <div class="offline-row__done">
            <span class="offline-row__badge">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
              متاح بدون إنترنت
            </span>
            <div class="offline-row__done-actions">
              <button type="button" class="offline-btn offline-btn--ghost" data-offline-act="download" data-offline-row="${rowKey}">إعادة التحميل</button>
              <button type="button" class="offline-btn offline-btn--ghost offline-btn--danger-text" data-offline-act="delete" data-offline-row="${rowKey}">حذف لتحرير المساحة</button>
            </div>
          </div>`;
    }

    // idle
    return `
      <button type="button" class="offline-btn offline-btn--primary" data-offline-act="download" data-offline-row="${rowKey}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"/></svg>
        تحميل (${fmtSize(def.sizeMb)})
      </button>`;
}

function renderRow(rowKey, state) {
    if (!SHEET_EL) return;
    const slot = SHEET_EL.querySelector(`.offline-row[data-offline-row="${rowKey}"] .offline-row__status`);
    if (slot) slot.innerHTML = statusHtml(rowKey, state);
}

function renderAllRows() {
    if (!SHEET_EL) return;
    // Bootstrap with whatever the modules currently know; subscriptions take over after this.
    if (isQcf4Ready()) renderRow("mushaf", { status: "done" });
    if (isTafsirReady()) renderRow("tafsir", { status: "done" });
}

function buildSheet() {
    if (SHEET_EL) return SHEET_EL;
    ensurePanelFont();
    const wrap = document.createElement("div");
    wrap.id = "offlineSheet";
    wrap.className = "offline-sheet";
    wrap.setAttribute("aria-hidden", "true");
    wrap.innerHTML = `
      <div class="offline-sheet__backdrop" data-offline-close></div>
      <div class="offline-sheet__card" role="dialog" aria-modal="true" aria-labelledby="offlineSheetTitle">
        <button type="button" class="offline-sheet__close" data-offline-close aria-label="إغلاق">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
        <div class="offline-sheet__head">
          <div class="offline-sheet__icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 15a4.5 4.5 0 004.5 4.5H18a3.75 3.75 0 001.332-7.257 3 3 0 00-3.758-3.848 5.25 5.25 0 00-10.233 2.33A4.502 4.502 0 002.25 15z"/><path stroke-linecap="round" stroke-linejoin="round" d="M12 10.5v6m0 0l-2.25-2.25M12 16.5l2.25-2.25"/></svg>
          </div>
          <h2 id="offlineSheetTitle" class="offline-sheet__title">استخدام التطبيق بدون إنترنت</h2>
          <p class="offline-sheet__desc">للتدبر بدون انترنت، حمّل البيانات اللازمة لكل وضع.</p>
        </div>
        <div class="offline-sheet__rows">
          <div class="offline-row" data-offline-row="mushaf">
            <div class="offline-row__head">
              <div class="offline-row__title">${ROW_DEFS.mushaf.title}</div>
            </div>
            <div class="offline-row__desc">${ROW_DEFS.mushaf.desc}</div>
            <div class="offline-row__status"></div>
          </div>
          <div class="offline-row" data-offline-row="tafsir">
            <div class="offline-row__head">
              <div class="offline-row__title">${ROW_DEFS.tafsir.title}</div>
            </div>
            <div class="offline-row__desc">${ROW_DEFS.tafsir.desc}</div>
            <div class="offline-row__status"></div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    SHEET_EL = wrap;

    // Delegated handlers — single listener for all row buttons + close.
    wrap.addEventListener("click", onSheetClick);
    return wrap;
}

function onSheetClick(e) {
    const closeEl = e.target.closest("[data-offline-close]");
    if (closeEl) { closeSheet(); return; }
    const actEl = e.target.closest("[data-offline-act]");
    if (!actEl) return;
    const act = actEl.dataset.offlineAct;
    const rowKey = actEl.dataset.offlineRow;
    if (!rowKey || !ROW_DEFS[rowKey]) return;

    if (act === "download") {
        PENDING_CONFIRM[rowKey] = null;
        ROW_DEFS[rowKey].startDownload();
        return;
    }
    if (act === "delete") {
        PENDING_CONFIRM[rowKey] = "delete";
        renderRow(rowKey, rowKey === "mushaf" ? (isQcf4Ready() ? { status: "done" } : { status: "idle" }) : (isTafsirReady() ? { status: "done" } : { status: "idle" }));
        return;
    }
    if (act === "delete-cancel") {
        PENDING_CONFIRM[rowKey] = null;
        renderRow(rowKey, rowKey === "mushaf" ? (isQcf4Ready() ? { status: "done" } : { status: "idle" }) : (isTafsirReady() ? { status: "done" } : { status: "idle" }));
        return;
    }
    if (act === "delete-confirm") {
        PENDING_CONFIRM[rowKey] = null;
        ROW_DEFS[rowKey].deleteCache().then(() => {
            renderRow(rowKey, { status: "idle" });
        });
        return;
    }
}

function onKeyDown(e) {
    if (e.key === "Escape" && SHEET_OPEN) closeSheet();
}

function openSheet() {
    buildSheet();
    SHEET_OPEN = true;
    SHEET_EL.classList.add("offline-sheet--open");
    SHEET_EL.setAttribute("aria-hidden", "false");
    document.body.classList.add("offline-sheet-open");
    renderAllRows();
    // Subscribe to live state — each subscription immediately fires with the current state.
    UNSUB_QCF4 = subscribeQcf4((st) => renderRow("mushaf", st));
    UNSUB_TAFSIR = subscribeTafsirDl((st) => renderRow("tafsir", st));
    document.addEventListener("keydown", onKeyDown);
}

function closeSheet() {
    SHEET_OPEN = false;
    if (SHEET_EL) {
        SHEET_EL.classList.remove("offline-sheet--open");
        SHEET_EL.setAttribute("aria-hidden", "true");
    }
    document.body.classList.remove("offline-sheet-open");
    UNSUB_QCF4?.(); UNSUB_QCF4 = null;
    UNSUB_TAFSIR?.(); UNSUB_TAFSIR = null;
    document.removeEventListener("keydown", onKeyDown);
    PENDING_CONFIRM.mushaf = null;
    PENDING_CONFIRM.tafsir = null;
}

export function initOfflinePanel() {
    BTN_EL = document.getElementById("offlineMenuBtn");
    if (!BTN_EL) return;
    BTN_EL.style.display = ""; // reveal (was display:none by default)
    BTN_EL.addEventListener("click", () => {
        if (SHEET_OPEN) closeSheet(); else openSheet();
    });
}
