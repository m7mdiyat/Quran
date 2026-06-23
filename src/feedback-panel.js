/*
 * Feedback panel — APP ONLY.
 *
 * Opened from the Settings hub (openFeedbackPanel) as a centered glass sheet
 * containing the feedback form (category, message, optional email, honeypot).
 * Submits POST {API_ROOT}/feedback.
 *
 * Reuses the `.offline-sheet*` CSS classes from index.html for the backdrop +
 * card visuals so the panels stay visually consistent. Pulled in (statically)
 * by settings-panel.js, itself dynamic-imported behind `if (isApp())`, so the
 * web bundle never pulls it.
 */

"use strict";

import { API_ROOT, isApp } from "./app.js";

const FEEDBACK_MAX_MSG = 5000;
const FEEDBACK_CATEGORIES = [
    { value: "suggestion", label: "اقتراح" },
    { value: "bug", label: "خطأ / مشكلة" },
    { value: "other", label: "أخرى" },
];

let SHEET_EL = null;
let SHEET_OPEN = false;
let SUBMITTING = false;
let _onBack = null;        // when set (opened from Settings), dismiss returns there

// App-only: pull IBM Plex Sans Arabic from Google Fonts for the panel.
// Idempotent across panels — both modules reference the same element ID.
function ensurePanelFont() {
    if (document.getElementById("offlinePanelFont")) return;
    const link = document.createElement("link");
    link.id = "offlinePanelFont";
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap";
    document.head.appendChild(link);
}

function buildFormHtml() {
    const opts = FEEDBACK_CATEGORIES
        .map((c, i) => `<option value="${c.value}"${i === 0 ? " selected" : ""}>${c.label}</option>`)
        .join("");
    return `
      <form class="feedback-form" novalidate>
        <label class="feedback-field">
          <span class="feedback-label">نوع الملاحظة</span>
          <select class="feedback-input" name="category">${opts}</select>
        </label>
        <label class="feedback-field">
          <span class="feedback-label">رسالتك</span>
          <textarea class="feedback-input feedback-textarea" name="message" rows="4" maxlength="${FEEDBACK_MAX_MSG}" placeholder="اكتب ملاحظتك هنا..." required></textarea>
          <span class="feedback-counter" aria-live="polite">0 / ${FEEDBACK_MAX_MSG}</span>
        </label>
        <label class="feedback-field">
          <span class="feedback-label">البريد الإلكتروني <span class="feedback-optional">(اختياري)</span></span>
          <input class="feedback-input" type="email" name="email" autocomplete="email" placeholder="ضع ايميلك هنا..." />
        </label>
        <div class="feedback-honeypot" aria-hidden="true">
          <label>Website</label>
          <input type="text" name="website" tabindex="-1" autocomplete="off" />
        </div>
        <button type="submit" class="offline-btn offline-btn--primary feedback-submit">إرسال</button>
        <div class="feedback-status" role="status" aria-live="polite"></div>
      </form>`;
}

function setStatus(form, kind, message) {
    const slot = form.querySelector(".feedback-status");
    if (!slot) return;
    if (!kind) {
        slot.className = "feedback-status";
        slot.textContent = "";
        return;
    }
    slot.className = `feedback-status feedback-status--${kind}`;
    slot.textContent = message || "";
}

function wireForm(root) {
    const form = root.querySelector(".feedback-form");
    if (!form) return;
    const textarea = form.querySelector("textarea[name=message]");
    const counter = form.querySelector(".feedback-counter");
    if (textarea && counter) {
        const updateCounter = () => {
            counter.textContent = `${textarea.value.length} / ${FEEDBACK_MAX_MSG}`;
        };
        textarea.addEventListener("input", updateCounter);
        updateCounter();
    }
    form.addEventListener("submit", (e) => {
        e.preventDefault();
        onSubmit(form);
    });
}

async function onSubmit(form) {
    if (SUBMITTING) return;
    if (!isApp()) return; // belt-and-suspenders: only the app should reach here

    const category = form.querySelector("select[name=category]")?.value || "other";
    const message = (form.querySelector("textarea[name=message]")?.value || "").trim();
    const email = (form.querySelector("input[name=email]")?.value || "").trim();
    const hp = form.querySelector("input[name=website]")?.value || "";

    if (!message) {
        setStatus(form, "err", "اكتب رسالتك أولًا");
        form.querySelector("textarea[name=message]")?.focus();
        return;
    }

    const submitBtn = form.querySelector(".feedback-submit");
    SUBMITTING = true;
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.dataset.originalText = submitBtn.dataset.originalText || submitBtn.textContent;
        submitBtn.textContent = "جارٍ الإرسال...";
    }
    setStatus(form, "info", "جارٍ الإرسال...");

    try {
        const res = await fetch(`${API_ROOT}/feedback`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                category,
                message,
                email,
                source: "app",
                hp,
            }),
        });
        let data = null;
        try { data = await res.json(); } catch { data = null; }
        if (res.ok && data && data.ok === true) {
            form.reset();
            const c = form.querySelector(".feedback-counter");
            if (c) c.textContent = `0 / ${FEEDBACK_MAX_MSG}`;
            setStatus(form, "ok", "تم إرسال رسالتك، شكرًا لك");
        } else if (res.status === 429) {
            setStatus(form, "err", "حاول مرة أخرى بعد قليل");
        } else {
            setStatus(form, "err", "تعذّر الإرسال، حاول مرة أخرى");
        }
    } catch {
        setStatus(form, "err", "تعذّر الإرسال، حاول مرة أخرى");
    } finally {
        SUBMITTING = false;
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = submitBtn.dataset.originalText || "إرسال";
        }
    }
}

function buildSheet() {
    if (SHEET_EL) return SHEET_EL;
    ensurePanelFont();
    const wrap = document.createElement("div");
    wrap.id = "feedbackSheet";
    // Reuses .offline-sheet* styling verbatim — same visual treatment as the
    // offline panel, just different contents inside the card.
    wrap.className = "offline-sheet offline-sheet--smooth";
    wrap.setAttribute("aria-hidden", "true");
    wrap.innerHTML = `
      <div class="offline-sheet__backdrop" data-feedback-close></div>
      <div class="offline-sheet__card" role="dialog" aria-modal="true" aria-labelledby="feedbackSheetTitle">
        <button type="button" class="offline-sheet__close" data-feedback-close aria-label="إغلاق">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
        <div class="offline-sheet__head">
          <div class="offline-sheet__icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z"/></svg>
          </div>
          <h2 id="feedbackSheetTitle" class="offline-sheet__title">إرسال ملاحظة</h2>
          <p class="offline-sheet__desc">رأيك أو بلاغك يصلني مباشرة.</p>
        </div>
        ${buildFormHtml()}
      </div>`;
    document.body.appendChild(wrap);
    SHEET_EL = wrap;

    wrap.addEventListener("click", (e) => {
        if (e.target.closest("[data-feedback-close]")) closeSheet();
    });
    wireForm(wrap);
    return wrap;
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
    // Clear any stale status (e.g. "تم إرسال" from a previous open) but leave
    // the form contents alone so an unsent draft survives a reopen.
    const form = SHEET_EL.querySelector(".feedback-form");
    if (form) setStatus(form, null);
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

/* Opened from the Settings hub (settings-panel.js). Feedback is app-only.
   opts.onBack — when given — returns to Settings on dismiss instead of the page. */
export function openFeedbackPanel(opts) {
    if (!isApp()) return; // defensive — only the app should reach here
    _onBack = opts?.onBack || null;
    openSheet();
    applyDismissAffordance();
}
