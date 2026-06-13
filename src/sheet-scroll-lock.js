/*
 * Background scroll lock for the header sheets (offline / feedback / notes /
 * غريب القرآن). APP-ONLY in practice — those sheets exist only in the app.
 *
 * Every sheet already toggles `body.offline-sheet-open` on its parent <body>.
 * This watches that one class and pins the page with the position:fixed lock
 * iOS WKWebView actually honours (the CSS lives beside the sheet styles in
 * index.html), restoring the exact scroll position on close so nothing jumps.
 * One MutationObserver covers every sheet — no per-panel wiring, and any sheet
 * added later gets the lock for free just by toggling the same class.
 *
 * Why this and not overflow:hidden: WKWebView keeps letting the page behind a
 * fixed overlay pan/rubber-band under overflow:hidden alone; position:fixed on
 * <body> is the lock it respects (same technique as page-fullscreen.js). The
 * observer fires as a microtask before paint, so pinning `top` here is
 * jump-free even though the panels add the class first.
 */

"use strict";

let _locked = false;
let _savedY = 0;

function applyLock(on) {
    if (on === _locked) return;
    if (on) {
        _savedY = window.scrollY || window.pageYOffset || 0;
        // The class drives position:fixed (CSS); pin the offset so the page
        // doesn't snap to the top behind the backdrop.
        document.body.style.top = `-${_savedY}px`;
        _locked = true;
    } else {
        _locked = false;
        document.body.style.top = "";
        window.scrollTo(0, _savedY);
    }
}

export function initSheetScrollLock() {
    const sync = () => applyLock(document.body.classList.contains("offline-sheet-open"));
    new MutationObserver(sync).observe(document.body, {
        attributes: true,
        attributeFilter: ["class"],
    });
    sync(); // belt-and-suspenders, in case a sheet is already open at init
}
