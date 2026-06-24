/*
 * Background scroll lock — shared by the header sheets (offline / feedback /
 * notes / غريب collection / settings; class `offline-sheet-open`) AND the
 * first-use spotlight coachmarks (`mushaf-coach-open`). APP-ONLY in practice.
 * One MutationObserver locks whenever EITHER class is on <body>.
 *
 * HOW IT LOCKS — and why it changes NO layout:
 *  - NOT position:fixed on the body: on iOS WKWebView that re-anchors the body's
 *    position:fixed header/chrome and flashed the layout on open AND close.
 *  - NOT overflow:hidden on the root: the root is height:100%, so overflow:hidden
 *    CLIPS the taller page (a detached/cut-off bottom) and shifts the scroll/
 *    coordinate context (mis-placing the spotlight guides).
 * Instead we preventDefault touchmove. The page never reflows/clips/re-anchors,
 * so the fixed chrome stays put and the guide coordinates stay exact.
 *
 * Scroll-CHAINING: the open panel's card has an inner scroller (the word/notes
 * list). We let THAT scroll but block the chain to the page behind it — both
 * when the finger is outside any panel scroller AND at the scroller's own edges
 * (pull-down at the top / pull-up at the bottom would otherwise move the page,
 * dragging it under the fixed dim → the broken bottom). overscroll-behavior:
 * contain is meant to do this but is unreliable on WKWebView, so this is the
 * real guarantee.
 *
 * Fullscreen (page-fullscreen.js, `mushaf-fs-open`) keeps its own lock; defer.
 */

"use strict";

let _locked = false;
let _scroller = null;   // panel scroller under the active touch, or null (= page/dim)
let _lastTouchY = 0;

function fsActive() {
    return document.body.classList.contains("mushaf-fs-open");
}
function shouldLock() {
    const c = document.body.classList;
    return c.contains("offline-sheet-open") || c.contains("mushaf-coach-open");
}

// The first actually-scrollable element between the touched node and the panel
// card (else the card itself); null if the touch isn't inside a panel card.
function findScroller(target) {
    const card = target?.closest?.(".offline-sheet__card");
    if (!card) return null;
    let node = target;
    while (node && node !== card) {
        if (node.nodeType === 1 && node.scrollHeight > node.clientHeight) {
            const oy = getComputedStyle(node).overflowY;
            if (oy === "auto" || oy === "scroll") return node;
        }
        node = node.parentElement;
    }
    return card;
}

function onTouchStart(e) {
    const t = e.touches && e.touches[0];
    _lastTouchY = t ? t.clientY : 0;
    _scroller = findScroller(e.target);
}

function onTouchMove(e) {
    // Not inside a panel scroller (the dim / page behind it) → never let it move.
    if (!_scroller) {
        if (e.cancelable) e.preventDefault();
        return;
    }
    const t = e.touches && e.touches[0];
    const y = t ? t.clientY : _lastTouchY;
    const dy = y - _lastTouchY;          // > 0 → finger down → content scrolls toward its top
    _lastTouchY = y;
    const s = _scroller;
    const canScroll = s.scrollHeight > s.clientHeight + 1;
    const atTop = s.scrollTop <= 0;
    const atBottom = s.scrollTop + s.clientHeight >= s.scrollHeight - 1;
    // Block the chain to the page: nothing to scroll here, or pulling past an edge.
    if (!canScroll || (atTop && dy > 0) || (atBottom && dy < 0)) {
        if (e.cancelable) e.preventDefault();
    }
    // else: let the inner scroller move on its own.
}

function applyLock(on) {
    if (on === _locked) return;
    _locked = on;
    if (fsActive()) return; // fullscreen owns the lock while it's up
    if (on) {
        document.addEventListener("touchstart", onTouchStart, { passive: true });
        document.addEventListener("touchmove", onTouchMove, { passive: false });
    } else {
        document.removeEventListener("touchstart", onTouchStart);
        document.removeEventListener("touchmove", onTouchMove);
        _scroller = null;
    }
}

export function initSheetScrollLock() {
    const sync = () => applyLock(shouldLock());
    new MutationObserver(sync).observe(document.body, {
        attributes: true,
        attributeFilter: ["class"],
    });
    sync(); // belt-and-suspenders, in case a sheet is already open at init
}
