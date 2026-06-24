/*
 * First-launch guided tour — APP ONLY.
 *
 * A spotlight coachmark: a ~35% dim overlay with a cutout around the current
 * target (the dim is one element's huge box-shadow spread, so it's free at
 * rest), plus a small glass bubble (التالي / تخطّي) reusing the app's m7-tip
 * look.
 *
 *   - initTour() — the homepage tour (3 steps), once, behind m7_tour_seen. Runs
 *                  AFTER the splash clears; each step auto-advances to the next
 *                  VISIBLE target, ending cleanly even if one is missing.
 *
 * (The lantern's own first-use hint lives in gharib.js, anchored to the lamp via
 * the root-coordinate pattern so it can't drift on scroll — see maybeShowLanternHint.)
 *
 * Dynamic-imported from app.js init() behind isApp(); never on the website.
 * Replaces the old single offline coachmark — Step 3 (Settings) now covers it.
 */

"use strict";

import { isApp } from "./app.js";

const TOUR_SEEN_KEY = "m7_tour_seen";

const TOUR_STEPS = [
    { sel: "#searchPanel", text: "ابحث عن آية بكلماتها، أو اختر السورة لتبدأ." },
    { sel: "[data-mode-toggle]", text: "بدّل بين التفسير ووضع التدبّر (المصحف) من هنا." },
    { sel: "#settingsMenuBtn", text: "الإعدادات: للقراءة دون إنترنت، وغيّر المظهر، وراسِلنا." },
];

function seen(key) { try { return !!localStorage.getItem(key); } catch { return false; } }
function markSeen(key) { try { localStorage.setItem(key, "1"); } catch { } }

function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || +cs.opacity === 0) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;
    return r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
}

/* ----------------- the engine (shared by tour + lantern hint) ----------------- */

let _overlay = null, _spot = null, _bubble = null, _textEl = null, _nextBtn = null;
let _steps = [], _i = 0, _seenKey = null, _active = false, _showSkip = false;

const targetEl = (step) => (step ? document.querySelector(step.sel) : null);

function firstVisibleFrom(i) {
    for (let j = i; j < _steps.length; j++) {
        if (isVisible(targetEl(_steps[j]))) return j;
    }
    return -1;
}
function hasFurtherVisible() { return firstVisibleFrom(_i + 1) !== -1; }

function place() {
    if (!_active) return;
    const el = targetEl(_steps[_i]);
    if (!isVisible(el)) { next(); return; } // target vanished mid-step → move on
    const r = el.getBoundingClientRect();
    const pad = 8;
    const sx = Math.max(r.left - pad, 4);
    const sy = Math.max(r.top - pad, 4);
    const sw = Math.min(r.width + pad * 2, window.innerWidth - 8);
    const sh = r.height + pad * 2;
    _spot.style.left = `${sx}px`;
    _spot.style.top = `${sy}px`;
    _spot.style.width = `${sw}px`;
    _spot.style.height = `${sh}px`;
    const cr = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 10;
    _spot.style.borderRadius = `${Math.min(cr + 6, 28)}px`;

    const bw = _bubble.offsetWidth, bh = _bubble.offsetHeight, gap = 12;
    let top = sy + sh + gap;
    if (top + bh > window.innerHeight - 8) top = Math.max(8, sy - gap - bh);
    let left = r.left + r.width / 2 - bw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - 8 - bw));
    _bubble.style.top = `${top}px`;
    _bubble.style.left = `${left}px`;
}

function render() {
    _textEl.textContent = _steps[_i].text;
    _nextBtn.textContent = hasFurtherVisible() ? "التالي" : "تم";
    place();
}

function next() {
    const j = firstVisibleFrom(_i + 1);
    if (j === -1) { end(); return; }
    _i = j;
    render();
}

function end() {
    if (!_active) return;
    _active = false;
    if (_seenKey) markSeen(_seenKey);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", place);
    window.removeEventListener("scroll", place, true);
    const ov = _overlay;
    _overlay = _spot = _bubble = _textEl = _nextBtn = null;
    if (!ov) return;
    ov.classList.remove("tour--show");
    setTimeout(() => { try { ov.remove(); } catch { } }, 220);
}

function onKey(e) {
    if (e.key === "Escape") { e.stopPropagation(); end(); }
}

function build() {
    _overlay = document.createElement("div");
    _overlay.className = "tour";
    _overlay.setAttribute("role", "dialog");
    _overlay.setAttribute("dir", "rtl");
    _overlay.innerHTML = `
      <div class="tour__spot" aria-hidden="true"></div>
      <div class="tour__bubble" role="status" aria-live="polite">
        <div class="tour__text"></div>
        <div class="tour__actions">
          ${_showSkip ? `<button type="button" class="tour__skip">تخطّي</button>` : `<span></span>`}
          <button type="button" class="tour__next">التالي</button>
        </div>
      </div>`;
    document.body.appendChild(_overlay);
    _spot = _overlay.querySelector(".tour__spot");
    _bubble = _overlay.querySelector(".tour__bubble");
    _textEl = _overlay.querySelector(".tour__text");
    _nextBtn = _overlay.querySelector(".tour__next");
    _nextBtn.addEventListener("click", (e) => { e.stopPropagation(); next(); });
    _overlay.querySelector(".tour__skip")?.addEventListener("click", (e) => { e.stopPropagation(); end(); });
    // Tapping anywhere outside the bubble advances — forgiving; تخطّي always
    // bails, so the user is never trapped.
    _overlay.addEventListener("click", (e) => {
        if (e.target.closest(".tour__bubble")) return;
        next();
    });
}

function runCoach(steps, seenKey) {
    if (_active) return;                 // never stack two coachmarks
    _steps = steps;
    _seenKey = seenKey;
    _showSkip = steps.length > 1;
    const first = firstVisibleFrom(0);
    if (first === -1) { markSeen(seenKey); return; } // nothing visible → settle, don't show
    _i = first;
    build();
    _active = true;
    render();                            // place BEFORE --show so it doesn't fly in from 0,0
    requestAnimationFrame(() => _overlay && _overlay.classList.add("tour--show"));
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, { capture: true, passive: true });
}

/* ----------------- splash gate ----------------- */

function whenSplashGone(cb) {
    const gone = () => {
        const s = document.getElementById("m7-splash");
        return !s || !s.isConnected || s.style.opacity === "0";
    };
    if (gone()) { cb(); return; }
    let done = false;
    const finish = () => { if (done) return; done = true; clearInterval(iv); clearTimeout(cap); cb(); };
    const iv = setInterval(() => { if (gone()) finish(); }, 150);
    const cap = setTimeout(finish, 8000); // never wait forever
}

/* ----------------- public ----------------- */

export function initTour() {
    if (!isApp() || seen(TOUR_SEEN_KEY)) return;
    // Start once the splash has cleared + a short settle so the homepage is
    // painted and the user has oriented.
    whenSplashGone(() => setTimeout(() => runCoach(TOUR_STEPS, TOUR_SEEN_KEY), 450));
}
