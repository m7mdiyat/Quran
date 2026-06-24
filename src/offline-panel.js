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
import {
    getReciterList,
    loadReciterSizes,
    reciterSizeBytes,
    subscribeReciterDl,
    downloadReciters,
    deleteReciter,
    isReciterReady,
    isReciterDownloadBusy,
} from "./reciter-offline.js";
import { swapText, swapBlock } from "./transitions.js";

let SHEET_EL = null;
let UNSUB_QCF4 = null;
let UNSUB_TAFSIR = null;
let UNSUB_RECITERS = null;
let SHEET_OPEN = false;
let _onBack = null;        // when set (opened from Settings), dismiss returns there
// Per-row pending-confirm state: "delete" or null.
const PENDING_CONFIRM = { mushaf: null, tafsir: null };
// Reciter section: which (not-yet-downloaded) reciters are checked, per-reciter
// delete confirm, and the last rendered shape-signature per reciter row.
const RECITER_SELECTED = new Set();
const RECITER_CONFIRM = {};   // id -> "delete" | undefined
const RECITER_SIG = {};       // id -> last status|confirm|selected signature

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

/* ============================================================ Reciter section
 * A multi-select list (one row per reciter) with a live total + one download
 * button — the only place in the offline panel that isn't all-or-nothing. Rows
 * reuse the existing progress-bar / button tokens; per-reciter state comes from
 * src/reciter-offline.js's pub/sub. */
function fmtBytes(bytes) {
    const b = Number(bytes) || 0;
    if (b <= 0) return "…";
    if (b >= 1004857600 /* ~0.94 GB */) return `${(b / 1073741824).toFixed(1)} جيجابايت`;
    return `${Math.round(b / 1048576)} ميجابايت`;
}

const RECITER_CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>`;

function reciterRowHtml(info, st) {
    const { id, name, bytes } = info;
    const status = st?.status || "idle";

    if (RECITER_CONFIRM[id] === "delete" && status === "done") {
        return `
          <div class="reciter-pick reciter-pick--confirm" data-reciter-id="${id}">
            <span class="reciter-pick__name">حذف تلاوة ${name}؟</span>
            <div class="reciter-pick__actions">
              <button type="button" class="offline-btn offline-btn--danger" data-reciter-act="delete-confirm" data-reciter-id="${id}">حذف</button>
              <button type="button" class="offline-btn offline-btn--ghost" data-reciter-act="delete-cancel" data-reciter-id="${id}">إلغاء</button>
            </div>
          </div>`;
    }

    if (status === "done") {
        return `
          <div class="reciter-pick reciter-pick--done" data-reciter-id="${id}">
            <span class="reciter-pick__check" aria-hidden="true">${RECITER_CHECK}</span>
            <span class="reciter-pick__name">${name}</span>
            <button type="button" class="offline-btn offline-btn--ghost offline-btn--danger-text reciter-pick__del" data-reciter-act="delete" data-reciter-id="${id}">حذف</button>
          </div>`;
    }

    if (status === "downloading") {
        const pct = Math.max(0, Math.min(100, Number(st.pct) || 0));
        return `
          <div class="reciter-pick reciter-pick--busy" data-reciter-id="${id}">
            <div class="reciter-pick__top">
              <span class="reciter-pick__name">${name}</span>
              <span class="reciter-pick__pct">${pct}%</span>
            </div>
            <div class="mushaf-download__bar"><div class="mushaf-download__fill" style="width:${pct}%"></div></div>
            <span class="reciter-pick__msg t-text-swap">${st.message || ""}</span>
          </div>`;
    }

    if (status === "queued") {
        return `
          <div class="reciter-pick reciter-pick--busy" data-reciter-id="${id}">
            <span class="reciter-pick__name">${name}</span>
            <span class="reciter-pick__hint">بالانتظار…</span>
          </div>`;
    }

    if (status === "offline") {
        return `
          <div class="reciter-pick reciter-pick--warn" data-reciter-id="${id}">
            <span class="reciter-pick__name">${name}</span>
            <span class="reciter-pick__hint">بانتظار الاتصال</span>
          </div>`;
    }

    if (status === "error") {
        return `
          <div class="reciter-pick reciter-pick--err" data-reciter-id="${id}">
            <span class="reciter-pick__name">${name}</span>
            <button type="button" class="offline-btn offline-btn--ghost" data-reciter-act="download-one" data-reciter-id="${id}">إعادة المحاولة</button>
          </div>`;
    }

    // idle — selectable checkbox row
    const selected = RECITER_SELECTED.has(id);
    return `
      <button type="button" class="reciter-pick reciter-pick--pick${selected ? " is-checked" : ""}" role="checkbox" aria-checked="${selected}" data-reciter-toggle="${id}">
        <span class="reciter-pick__box" aria-hidden="true">${selected ? RECITER_CHECK : ""}</span>
        <span class="reciter-pick__name">${name}</span>
        <span class="reciter-pick__size">${fmtBytes(bytes)}</span>
      </button>`;
}

function renderReciterRow(info, st) {
    const listEl = SHEET_EL?.querySelector(".offline-reciters__list");
    if (!listEl) return;
    const id = info.id;
    let slot = listEl.querySelector(`[data-reciter-row="${id}"]`);
    const status = st?.status || "idle";
    const sig = `${status}|${RECITER_CONFIRM[id] || ""}|${RECITER_SELECTED.has(id)}`;

    if (slot && RECITER_SIG[id] === sig) {
        if (status === "downloading") {
            const pct = Math.max(0, Math.min(100, Number(st.pct) || 0));
            const fill = slot.querySelector(".mushaf-download__fill");
            if (fill) fill.style.width = `${pct}%`;
            const pctEl = slot.querySelector(".reciter-pick__pct");
            if (pctEl) pctEl.textContent = `${pct}%`;
            swapText(slot.querySelector(".reciter-pick__msg"), st.message || "");
        }
        return;
    }
    RECITER_SIG[id] = sig;
    if (!slot) {
        slot = document.createElement("div");
        slot.className = "reciter-pick-slot";
        slot.setAttribute("data-reciter-row", id);
        listEl.appendChild(slot);
        slot.innerHTML = reciterRowHtml(info, st);
        return;
    }
    swapBlock(slot, () => { slot.innerHTML = reciterRowHtml(info, st); });
}

function renderReciterFoot() {
    const footEl = SHEET_EL?.querySelector(".offline-reciters__foot");
    if (!footEl) return;
    const list = getReciterList();
    const pending = list.filter((r) => !isReciterReady(r.id));
    const busy = isReciterDownloadBusy();

    if (busy || !pending.length) { footEl.innerHTML = ""; return; }

    let selBytes = 0;
    for (const id of RECITER_SELECTED) if (!isReciterReady(id)) selBytes += reciterSizeBytes(id);
    const n = [...RECITER_SELECTED].filter((id) => !isReciterReady(id)).length;
    const label = n ? `تحميل المحدّد (${fmtBytes(selBytes)})` : "اختر قارئًا للتحميل";

    footEl.innerHTML = `
      <div class="offline-reciters__total">
        <span class="offline-reciters__total-cap">المساحة المطلوبة</span>
        <span class="offline-reciters__total-val">${n ? fmtBytes(selBytes) : "—"}</span>
      </div>
      <button type="button" class="offline-btn offline-btn--primary" data-reciter-act="download" ${n ? "" : "disabled"}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"/></svg>
        ${label}
      </button>`;
}

function renderReciterSection(map) {
    if (!SHEET_EL) return;
    const list = getReciterList();
    if (!list.length) return;
    for (const info of list) {
        const st = (map && map[info.id]) || (isReciterReady(info.id) ? { status: "done" } : { status: "idle" });
        renderReciterRow(info, st);
    }
    renderReciterFoot();
}

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
    wrap.className = "offline-sheet offline-sheet--smooth";
    wrap.setAttribute("aria-hidden", "true");
    wrap.innerHTML = `
      <div class="offline-sheet__backdrop" data-offline-close></div>
      <div class="offline-sheet__card" role="dialog" aria-modal="true" aria-labelledby="offlineSheetTitle">
        <div class="offline-sheet__pin">
          <button type="button" class="offline-sheet__close" data-offline-close aria-label="إغلاق">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>
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
          <div class="offline-row offline-row--reciters t-acc" data-offline-reciters data-open="false">
            <button type="button" class="t-acc-head" data-acc-toggle aria-expanded="false">
              <span class="t-acc-head__row">
                <span class="offline-row__title">القرّاء</span>
                <span class="t-acc-chevron" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5L8 10.5L12 6.5"/></svg></span>
              </span>
              <span class="offline-row__desc">تلاوات كاملة للاستماع بدون إنترنت.</span>
            </button>
            <div class="t-acc-cta">
              <div class="t-acc-cta__inner">
                <button type="button" class="offline-btn offline-btn--primary t-acc-cta__btn" data-acc-toggle>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 18v-5a9 9 0 0 1 18 0v5"/><path d="M21 19a2 2 0 0 1-2 2h-1a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3zM3 19a2 2 0 0 0 2 2h1a1 1 0 0 0 1-1v-4a1 1 0 0 0-1-1H3z"/></svg>
                  اضغط لاختيار القرّاء
                </button>
              </div>
            </div>
            <div class="t-acc-panel">
              <div class="t-acc-panel-inner">
                <div class="offline-reciters__list"></div>
                <div class="offline-reciters__foot"></div>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    SHEET_EL = wrap;

    // Delegated handlers — single listener for all row buttons + close.
    wrap.addEventListener("click", onSheetClick);
    return wrap;
}

function rerenderReciter(id) {
    const info = getReciterList().find((r) => r.id === id);
    if (!info) return;
    renderReciterRow(info, isReciterReady(id) ? { status: "done" } : { status: "idle" });
    renderReciterFoot();
}

function onReciterClick(e) {
    const toggleEl = e.target.closest("[data-reciter-toggle]");
    if (toggleEl) {
        const id = toggleEl.dataset.reciterToggle;
        if (isReciterReady(id)) return;
        if (RECITER_SELECTED.has(id)) RECITER_SELECTED.delete(id); else RECITER_SELECTED.add(id);
        rerenderReciter(id);
        return true;
    }
    const actEl = e.target.closest("[data-reciter-act]");
    if (!actEl) return false;
    const act = actEl.dataset.reciterAct;
    const id = actEl.dataset.reciterId;

    if (act === "download") {
        const ids = [...RECITER_SELECTED].filter((x) => !isReciterReady(x));
        if (!ids.length) return true;
        RECITER_SELECTED.clear();
        downloadReciters(ids); // emits queued state → the subscription re-renders
        return true;
    }
    if (act === "download-one") { downloadReciters([id]); return true; }
    if (act === "delete") { RECITER_CONFIRM[id] = "delete"; rerenderReciter(id); return true; }
    if (act === "delete-cancel") { delete RECITER_CONFIRM[id]; rerenderReciter(id); return true; }
    if (act === "delete-confirm") {
        delete RECITER_CONFIRM[id];
        deleteReciter(id).then(() => rerenderReciter(id));
        return true;
    }
    return false;
}

function onSheetClick(e) {
    const closeEl = e.target.closest("[data-offline-close]");
    if (closeEl) { closeSheet(); return; }
    // Accordion (القرّاء) — header OR the CTA button toggles it; CSS animates.
    const accToggle = e.target.closest("[data-acc-toggle]");
    if (accToggle) {
        const acc = accToggle.closest(".t-acc");
        const open = acc?.getAttribute("data-open") === "true";
        acc?.setAttribute("data-open", open ? "false" : "true");
        // keep the head button's aria-expanded authoritative
        acc?.querySelector(".t-acc-head")?.setAttribute("aria-expanded", open ? "false" : "true");
        return;
    }
    if (onReciterClick(e)) return;
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
    void SHEET_EL.offsetWidth; // commit the closed state so the first open transitions
    SHEET_EL.classList.add("offline-sheet--open");
    SHEET_EL.setAttribute("aria-hidden", "false");
    document.body.classList.add("offline-sheet-open");
    renderAllRows();
    // Subscribe to live state — each subscription immediately fires with the current state.
    UNSUB_QCF4 = subscribeQcf4((st) => renderRow("mushaf", st));
    UNSUB_TAFSIR = subscribeTafsirDl((st) => renderRow("tafsir", st));
    // Reciter section: render once with whatever sizes are known, then again
    // when the (bundled) size manifest resolves so totals appear instantly.
    UNSUB_RECITERS = subscribeReciterDl((map) => renderReciterSection(map));
    loadReciterSizes().then(() => {
        if (!SHEET_OPEN) return;
        // Sizes aren't part of the row signature — force a rebuild so the
        // placeholder "…" becomes the real size, and the foot total fills in.
        for (const k in RECITER_SIG) delete RECITER_SIG[k];
        renderReciterSection(null);
    });
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
    UNSUB_RECITERS?.(); UNSUB_RECITERS = null;
    document.removeEventListener("keydown", onKeyDown);
    PENDING_CONFIRM.mushaf = null;
    PENDING_CONFIRM.tafsir = null;
    // Reset reciter selection/confirm/sig so the next open starts clean.
    RECITER_SELECTED.clear();
    for (const k in RECITER_CONFIRM) delete RECITER_CONFIRM[k];
    for (const k in RECITER_SIG) delete RECITER_SIG[k];
    // Returning from a Settings-launched open hands control back to Settings.
    const back = _onBack;
    _onBack = null;
    if (back) back();
}

/* Header dismiss icon: a back chevron (RTL: LEFT-pointing — "back" reads
   leftward here, toward the Settings hub it returns to) when opened from
   Settings, else the plain ✕. */
const DISMISS_BACK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>`;
const DISMISS_CLOSE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>`;

function applyDismissAffordance() {
    const btn = SHEET_EL?.querySelector(".offline-sheet__close");
    if (!btn) return;
    btn.innerHTML = _onBack ? DISMISS_BACK : DISMISS_CLOSE;
    btn.setAttribute("aria-label", _onBack ? "العودة إلى الإعدادات" : "إغلاق");
}

/* Opened from the Settings hub (settings-panel.js). opts.onBack — when given —
   returns to Settings on dismiss instead of closing all the way to the page. */
export function openOfflinePanel(opts) {
    _onBack = opts?.onBack || null;
    openSheet();
    applyDismissAffordance();
}

/* The first-launch coachmark that used to live here is retired — the guided
   tour (src/tour.js) now introduces Settings (incl. offline) on first launch. */
