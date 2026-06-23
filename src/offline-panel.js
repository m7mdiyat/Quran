/*
 * Offline downloads panel — APP ONLY.
 *
 * Opened from the Settings hub (openOfflinePanel) as a centered glass sheet
 * with two rows (Mushaf, Tafsir). Each row shows one of:
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
 * Pulled in (statically) by settings-panel.js, itself dynamic-imported behind
 * `if (isApp())`, so the web bundle never pulls this code. The first-launch
 * coachmark now points at the Settings button (#settingsMenuBtn).
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
import { swapText, swapBlock } from "./transitions.js";

let SHEET_EL = null;
let BTN_EL = null;
let UNSUB_QCF4 = null;
let UNSUB_TAFSIR = null;
let SHEET_OPEN = false;
// Per-row pending-confirm state: "delete" or null.
const PENDING_CONFIRM = { mushaf: null, tafsir: null };

const ROW_DEFS = {
    mushaf: {
        title: "وضع التدبّر",
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
        // The rotating message is a .t-text-swap node: while the row stays
        // in "downloading", renderRow updates it IN PLACE through swapText.
        // The PERCENTAGE deliberately is NOT animated (round 2, Fix 3): a
        // counter ticking through exit/enter motion read as flicker — it
        // updates via plain textContent. The bar fill stays direct too.
        return `
          <div class="offline-row__progress">
            <div class="mushaf-download__bar"><div class="mushaf-download__fill" style="width:${pct}%"></div></div>
            <div class="offline-row__progress-row">
              <span class="offline-row__progress-msg t-text-swap">${message}</span>
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
            <span class="t-text-swap">${state.message || "تعذّر التحميل"}</span>
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
    if (!slot) return;

    // Task 5 (+ round 2, Fix 3): animate status-text changes instead of
    // hard innerHTML swaps on each progress event.
    //   • Same status shape → the rotating message swaps via swapText; the
    //     percentage and the bar fill update DIRECTLY (no motion — a
    //     ticking counter through exit/enter motion read as flicker).
    //   • Status shape changed (idle→downloading→done, confirm prompts…) →
    //     swap the whole block with the three-phase motion.
    const status = state?.status || "idle";
    const sig = `${status}|${PENDING_CONFIRM[rowKey] || ""}`;
    if (slot.dataset.sig === sig) {
        if (status === "downloading") {
            const pct = Math.max(0, Math.min(100, Number(state.pct) || 0));
            const fill = slot.querySelector(".mushaf-download__fill");
            if (fill) fill.style.width = `${pct}%`;
            swapText(slot.querySelector(".offline-row__progress-msg"), state.message || "");
            const pctEl = slot.querySelector(".offline-row__progress-pct");
            if (pctEl) pctEl.textContent = `${pct}%`;
        } else if (status === "error") {
            swapText(slot.querySelector(".offline-row__pill--err .t-text-swap"),
                state.message || "تعذّر التحميل");
        }
        return;
    }
    slot.dataset.sig = sig;
    swapBlock(slot, () => { slot.innerHTML = statusHtml(rowKey, state); });
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

/* Opened from the Settings hub (settings-panel.js). */
export function openOfflinePanel() { openSheet(); }

export function initOfflinePanel() {
    // The panel now opens from the Settings hub (openOfflinePanel); there is no
    // dedicated header button anymore. We keep the first-launch coachmark, but
    // re-point it at the Settings button it now lives behind.
    BTN_EL = document.getElementById("settingsMenuBtn");
    if (!BTN_EL) return;
    // First-launch only: gently point at Settings so users discover offline
    // mode. Persisted dismissal via m7_offline_tooltip_seen.
    try {
        if (!localStorage.getItem(TOOLTIP_SEEN_KEY)) scheduleOfflineTooltip();
    } catch { }
}

/* ============================================================
 * First-launch tooltip pointing at the offline button (app only).
 * ============================================================ */

const TOOLTIP_SEEN_KEY = "m7_offline_tooltip_seen";
const TOOLTIP_AUTO_DISMISS_MS = 10_000;
const TOOLTIP_EDGE_PAD = 8;
let TIP_EL = null;
let TIP_TIMER = null;
let TIP_AUTO_TIMER = null;

function scheduleOfflineTooltip() {
    // Wait ~700ms after init so the app has finished painting and the user
    // has had a moment to orient. Any earlier and the tooltip can land before
    // the button has its final position.
    TIP_TIMER = setTimeout(() => {
        TIP_TIMER = null;
        showOfflineTooltip();
    }, 700);
}

function showOfflineTooltip() {
    if (!BTN_EL) return;
    if (document.getElementById("m7OfflineTip")) return;

    const tip = document.createElement("div");
    tip.id = "m7OfflineTip";
    tip.className = "m7-tip";
    tip.setAttribute("role", "status");
    tip.setAttribute("aria-live", "polite");
    tip.innerHTML = `
      <div class="m7-tip__arrow"></div>
      <div class="m7-tip__text">للاستخدام بدون إنترنت</div>
      <button type="button" class="m7-tip__close" aria-label="إغلاق">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      </button>`;
    document.body.appendChild(tip);
    TIP_EL = tip;
    // Wait one frame so the browser has laid out the tooltip — without this
    // offsetWidth can read 0 on the very first frame and the arrow lands at
    // the wrong place. Then a second rAF triggers the entrance transition.
    requestAnimationFrame(() => {
        positionOfflineTooltip();
        requestAnimationFrame(() => {
            tip.classList.add("m7-tip--show");
        });
    });

    tip.querySelector(".m7-tip__close")?.addEventListener("click", (e) => {
        e.stopPropagation();
        dismissOfflineTooltip();
    });
    // Any outside interaction dismisses the tooltip — one-shot, capture phase
    // so we see the event before the rest of the app does.
    document.addEventListener("pointerdown", onOutsideDismiss, { capture: true, once: true });
    window.addEventListener("resize", positionOfflineTooltip);
    window.addEventListener("scroll", positionOfflineTooltip, { passive: true });

    // Auto-dismiss after 10s if the user never interacts. The interaction
    // paths cancel this timer so they don't double-fire.
    TIP_AUTO_TIMER = setTimeout(() => {
        TIP_AUTO_TIMER = null;
        dismissOfflineTooltip();
    }, TOOLTIP_AUTO_DISMISS_MS);
}

function positionOfflineTooltip() {
    if (!TIP_EL || !BTN_EL) return;
    const btn = BTN_EL.getBoundingClientRect();
    const btnCenterX = btn.left + btn.width / 2;
    // Width is read from offsetWidth (unaffected by transform). The CSS has
    // translateX(-50%) baked in, so "left" sets the bubble's CENTER.
    const tipW = TIP_EL.offsetWidth || 220;
    const half = tipW / 2;
    const vw = window.innerWidth || document.documentElement.clientWidth || 360;
    // Clamp the center so the bubble's edges stay TOOLTIP_EDGE_PAD inside
    // the viewport on narrow phones. Without this the bubble overflows the
    // right edge when the offline button sits in the top-right corner.
    const minCenter = TOOLTIP_EDGE_PAD + half;
    const maxCenter = vw - TOOLTIP_EDGE_PAD - half;
    const center = Math.max(minCenter, Math.min(maxCenter, btnCenterX));

    TIP_EL.style.top = `${btn.bottom + 12}px`;
    TIP_EL.style.left = `${center}px`;

    // Re-anchor the arrow so it visually points at the button even when the
    // bubble was clamped away from the edge. Arrow's "left: 50%" in CSS is
    // the default; here we override with the button-center offset measured
    // from the (now-clamped) bubble's left edge.
    const arrow = TIP_EL.querySelector(".m7-tip__arrow");
    if (arrow) {
        const bubbleLeft = center - half;
        let arrowX = btnCenterX - bubbleLeft;
        // Keep the arrow itself inside the bubble too (cosmetic min/max).
        arrowX = Math.max(14, Math.min(tipW - 14, arrowX));
        arrow.style.left = `${arrowX}px`;
    }
}

function dismissOfflineTooltip() {
    if (TIP_TIMER) { clearTimeout(TIP_TIMER); TIP_TIMER = null; }
    if (TIP_AUTO_TIMER) { clearTimeout(TIP_AUTO_TIMER); TIP_AUTO_TIMER = null; }
    try { localStorage.setItem(TOOLTIP_SEEN_KEY, "1"); } catch { }
    if (!TIP_EL) return;
    TIP_EL.classList.remove("m7-tip--show");
    const el = TIP_EL;
    TIP_EL = null;
    setTimeout(() => { try { el.remove(); } catch { } }, 240);
    window.removeEventListener("resize", positionOfflineTooltip);
    window.removeEventListener("scroll", positionOfflineTooltip);
}

function onOutsideDismiss(e) {
    if (!TIP_EL) return;
    if (e.target.closest("#m7OfflineTip")) return;
    // The offline button itself has its own click handler that dismisses;
    // any other click also dismisses without opening the panel.
    dismissOfflineTooltip();
}
