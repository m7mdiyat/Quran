/*
 * Shared micro-animation helpers — Transitions.dev ports.
 *
 * Used by app.js (input dissolve-clear, panel reveal), mushaf.js (mode
 * switch, مختصر التفاسير modal, success-check toast) and the app-only
 * offline panel (text swaps). The matching CSS lives in index.html's
 * inline <style> under "Transitions.dev animation pack" — all timing
 * values are CSS variables on :root and are read here at call time via
 * getComputedStyle so they stay tweakable from one place.
 *
 * Every helper respects prefers-reduced-motion: the CSS side disables the
 * transitions/animations, and the JS side short-circuits per-frame work.
 */

"use strict";

export function prefersReducedMotion() {
    try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
    catch { return false; }
}

/* Read a duration CSS var (e.g. "--panel-close-dur") in ms, with fallback. */
export function cssMs(name, fallback) {
    try {
        const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        if (raw.endsWith("ms")) return parseFloat(raw) || fallback;
        if (raw.endsWith("s")) return parseFloat(raw) * 1000 || fallback;
    } catch { }
    return fallback;
}

/* Read a unitless/px CSS var as a number, optionally from a specific element
 * (so theme-scoped overrides like body.dark are honoured). */
function cssNum(name, fallback, el) {
    try {
        const raw = getComputedStyle(el || document.documentElement).getPropertyValue(name).trim();
        const n = parseFloat(raw);
        if (Number.isFinite(n)) return n;
    } catch { }
    return fallback;
}

/* cubic-bezier(x1,y1,x2,y2) evaluator (Newton iteration), so per-frame JS
 * animations use the exact same easing curves as the CSS snippets. */
export function cubicBezier(p1x, p1y, p2x, p2y) {
    const cx = 3 * p1x, bx = 3 * (p2x - p1x) - cx, ax = 1 - cx - bx;
    const cy = 3 * p1y, by = 3 * (p2y - p1y) - cy, ay = 1 - cy - by;
    const sampleX = (t) => ((ax * t + bx) * t + cx) * t;
    const sampleY = (t) => ((ay * t + by) * t + cy) * t;
    const sampleDX = (t) => (3 * ax * t + 2 * bx) * t + cx;
    return (x) => {
        if (x <= 0) return 0;
        if (x >= 1) return 1;
        let t = x;
        for (let i = 0; i < 6; i++) {
            const dx = sampleX(t) - x;
            if (Math.abs(dx) < 1e-5) break;
            const d = sampleDX(t);
            if (Math.abs(d) < 1e-6) break;
            t -= dx / d;
        }
        return sampleY(Math.min(1, Math.max(0, t)));
    };
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/* ============================================================
 * Panel reveal (.t-panel-slide) — Tasks 3 + 7
 * State is the data-open attribute; CSS owns the motion. These helpers
 * manage staging (so a freshly-unhidden panel animates from the closed
 * state instead of popping) and the per-panel --panel-translate-y
 * (~50% of the panel's real height, capped so very tall panels don't
 * fly in from off-screen).
 * ============================================================ */

const PANEL_TRANSLATE_CAP_PX = 160;

export function panelPrepare(el) {
    if (!el) return;
    el.classList.add("t-panel-slide");
    if (el.dataset.open !== "true") el.dataset.open = "false";
}

/* Force the closed state with NO transition — for staging a panel that is
 * about to be revealed. Needed because data-open survives display:none
 * round-trips (a panel hidden while open would otherwise pop back fully
 * open instead of animating in). */
export function panelStageClosed(el) {
    if (!el) return;
    el.classList.add("t-panel-slide");
    if (el.dataset.open === "false") return;
    const prev = el.style.transition;
    el.style.transition = "none";
    el.dataset.open = "false";
    void el.offsetWidth;
    el.style.transition = prev;
}

export function panelMeasure(el) {
    if (!el) return;
    const h = el.offsetHeight;
    if (h > 0) {
        el.style.setProperty("--panel-translate-y",
            `${Math.min(Math.round(h / 2), PANEL_TRANSLATE_CAP_PX)}px`);
    }
}

/* Open with the reveal transition. Call AFTER the element is displayed
 * (hidden class removed) — the offsetHeight read doubles as the reflow
 * that commits the closed state before data-open flips. */
export function panelOpen(el) {
    if (!el) return;
    panelPrepare(el);
    panelMeasure(el);
    void el.offsetWidth;
    el.dataset.open = "true";
}

/* Open with NO transition (mode toggles mid-choreography, restores). */
export function panelOpenInstant(el) {
    if (!el) return;
    panelPrepare(el);
    if (el.dataset.open === "true") return;
    const prev = el.style.transition;
    el.style.transition = "none";
    el.dataset.open = "true";
    void el.offsetWidth;
    el.style.transition = prev;
}

export function panelClose(el) {
    if (!el) return;
    panelPrepare(el);
    panelMeasure(el);
    el.dataset.open = "false";
}

export function panelCloseMs() { return cssMs("--panel-close-dur", 350); }

/* Mode-switch sequencing (Task 7): start the outgoing panel's close and
 * resolve once it has visually faded enough to be swapped out — NOT the
 * full close duration, so the two-phase choreography stays snappy. With
 * the snippet's fast-start ease the panel is ~85% faded at this cut. */
export const PANEL_SWAP_CUT_MS = 180;

export function panelModeClose(el) {
    if (!el) return Promise.resolve();
    if (prefersReducedMotion()) { panelClose(el); return Promise.resolve(); }
    panelClose(el);
    return new Promise((r) => setTimeout(r, PANEL_SWAP_CUT_MS));
}

/* ============================================================
 * Modal open/close (.t-modal) — Task 4 + Bug 3
 * ============================================================ */

const MODAL_TIMERS = new WeakMap();

export function modalOpen(el) {
    if (!el) return;
    el.classList.add("t-modal");
    const t = MODAL_TIMERS.get(el);
    if (t) { clearTimeout(t); MODAL_TIMERS.delete(el); }
    el.classList.remove("is-closing");
    void el.offsetWidth;
    el.classList.add("is-open");
}

/* Close: .is-open → .is-closing, then drop .is-closing on transitionend
 * with a timeout fallback. onDone fires exactly once unless the modal was
 * re-opened mid-close. */
export function modalClose(el, onDone) {
    if (!el) { if (onDone) onDone(); return; }
    el.classList.add("t-modal");
    if (!el.classList.contains("is-open") && !el.classList.contains("is-closing")) {
        if (onDone) onDone();
        return;
    }
    el.classList.remove("is-open");
    el.classList.add("is-closing");
    let finished = false;
    const finish = () => {
        if (finished) return;
        finished = true;
        el.removeEventListener("transitionend", onEnd);
        const t = MODAL_TIMERS.get(el);
        if (t) { clearTimeout(t); MODAL_TIMERS.delete(el); }
        // Re-opened mid-close (modalOpen stripped .is-closing) → skip onDone.
        if (el.classList.contains("is-closing")) {
            el.classList.remove("is-closing");
            if (onDone) onDone();
        }
    };
    const onEnd = (e) => {
        if (e.target === el && e.propertyName === "opacity") finish();
    };
    el.addEventListener("transitionend", onEnd);
    MODAL_TIMERS.set(el, setTimeout(finish, cssMs("--modal-close-dur", 150) + 80));
    if (prefersReducedMotion()) finish();
}

/* ============================================================
 * Text states swap (.t-text-swap) — Task 5
 * Three phases: exit (up+blur+fade) → swap content → enter from below.
 * Rapid updates COALESCE: while a swap is animating, newer values just
 * replace the pending target; each cycle lands on the latest value, so
 * fast progress ticks never stack animations.
 * ============================================================ */

const SWAP_STATE = new WeakMap();

function runSwapCycle(el, applyContent) {
    const dur = cssMs("--text-swap-dur", 150);
    el.classList.add("is-exit");
    setTimeout(() => {
        const st = SWAP_STATE.get(el);
        applyContent(st);
        el.classList.add("is-enter-start");
        el.classList.remove("is-exit");
        void el.offsetWidth;
        el.classList.remove("is-enter-start");
        setTimeout(() => {
            const cur = SWAP_STATE.get(el);
            if (cur && cur.pendingText !== undefined && cur.pendingText !== el.textContent) {
                runSwapCycle(el, applyContent);   // a newer value arrived mid-flight
            } else if (cur && cur.pendingApply) {
                runSwapCycle(el, applyContent);
            } else {
                SWAP_STATE.delete(el);
            }
        }, dur);
    }, dur);
}

/* Animated textContent swap. No-op when the text is unchanged. */
export function swapText(el, newText) {
    if (!el) return;
    const text = String(newText ?? "");
    const st = SWAP_STATE.get(el);
    const target = st ? st.pendingText : el.textContent;
    if (target === text) return;
    if (prefersReducedMotion()) {
        el.textContent = text;
        return;
    }
    el.classList.add("t-text-swap");
    if (st) { st.pendingText = text; return; }
    SWAP_STATE.set(el, { pendingText: text });
    runSwapCycle(el, (state) => { el.textContent = state.pendingText; });
}

/* Animated block swap: same three-phase motion applied to a container whose
 * content is replaced by `applyFn` (innerHTML re-render). First fill of an
 * empty container is instant — there is nothing to exit. */
export function swapBlock(el, applyFn) {
    if (!el) return;
    if (prefersReducedMotion() || !el.firstChild) { applyFn(); return; }
    el.classList.add("t-text-swap", "t-text-swap--block");
    const st = SWAP_STATE.get(el);
    if (st) { st.pendingApply = applyFn; return; }
    SWAP_STATE.set(el, { pendingApply: applyFn });
    runSwapCycle(el, (state) => {
        const fn = state.pendingApply;
        state.pendingApply = null;
        if (fn) fn();
    });
}

/* ============================================================
 * Success check (.t-success-check) — Task 6
 * ============================================================ */

export function buildSuccessCheck() {
    const wrap = document.createElement("span");
    wrap.className = "t-success-check";
    wrap.dataset.state = "out";
    wrap.setAttribute("aria-hidden", "true");
    wrap.innerHTML =
        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" `
        + `stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;
    return wrap;
}

/* Arm the stroke-draw from the real path length (the hardcoded 20 in the
 * snippet is wrong for this path) and fire the entrance. Must be called
 * with the element rendered (getTotalLength needs layout). */
export function playSuccessCheck(wrap) {
    if (!wrap) return;
    const path = wrap.querySelector("path");
    if (path) {
        try {
            const len = path.getTotalLength();
            if (len > 0) {
                path.style.strokeDasharray = String(len);
                path.style.strokeDashoffset = String(len);
            }
        } catch { }
    }
    void wrap.offsetWidth;
    wrap.dataset.state = "in";
}

/* ============================================================
 * Input clear with dissolve — Task 1
 *
 * Per-frame routine (cannot be a static keyframe: every word gets its own
 * glow streak with a rise/peak/fall envelope positioned from its REAL
 * rendered rect — RTL-safe by construction).
 *
 * Timeline (all values read from the :root CSS vars at clear time):
 *   t=0……………… words fly up/blur/fade, staggered by --glow-delay, each
 *               over --clear-out-dur with --clear-out-ease.
 *   per word…… a radial-gradient streak on .t-clear-glow rises to
 *               --glow-opacity (peak at --glow-peak-at of its window),
 *               then falls; light theme multiplies, dark theme screens.
 *   text gone… onTextGone() fires (the caller starts the existing
 *               reset-to-home staging behind the glow tail).
 *   tail……… the fake placeholder flies in from below over
 *               --clear-in-dur ending at --clear-dur; onFinished() fires.
 * ============================================================ */

/* Shared var reader for the clear/materialize pair. */
function readClearVars(glow) {
    const rootCs = getComputedStyle(document.documentElement);
    const ms = (name, fb) => {
        const raw = rootCs.getPropertyValue(name).trim();
        if (raw.endsWith("ms")) return parseFloat(raw) || fb;
        if (raw.endsWith("s")) return parseFloat(raw) * 1000 || fb;
        return fb;
    };
    return {
        clearDur: ms("--clear-dur", 1000),
        outDur: ms("--clear-out-dur", 400),
        inDur: ms("--clear-in-dur", 400),
        glowDelay: ms("--glow-delay", 50),
        outFly: cssNum("--clear-out-fly", 12),
        inFly: cssNum("--clear-in-fly", 12),
        blurMax: cssNum("--clear-blur", 2),
        peakAt: cssNum("--glow-peak-at", 0.15),
        glowOpacity: cssNum("--glow-opacity", 0.85),
        glowSpread: cssNum("--glow-spread", 1.5),
        // Shimmer color flips with the theme (body.dark override) — the
        // gallery uses plain ink: black on light, white on dark. Read off
        // the glow element so the cascade decides.
        glowRgb: (glow ? getComputedStyle(glow).getPropertyValue("--clear-glow-rgb") : "")
            .trim() || "0, 0, 0",
        ease: cubicBezier(0.22, 1, 0.36, 1),
    };
}

/* ── Canonical glow (faithful port of the gallery's p13-clear.js) ────────
 * The glow is BUILT ONCE as a static stack of small radial-gradient
 * ellipses and never repainted or moved: per frame only the LAYER's
 * opacity breathes through a single rise/peak/fall envelope. Each word
 * contributes four bottom-anchored ellipses — [dx (×halfWidth), width
 * mult, height px, alpha] — that overlap into one soft baseline shimmer
 * (heights of 5–8px and alphas of 0.14–0.22 are what keep it from ever
 * reading as bubbles). */
const GLOW_LAYERS = [
    [0, 0.8, 7, 0.22],
    [0.45, 0.55, 8, 0.18],
    [-0.4, 0.65, 6, 0.16],
    [0.15, 0.9, 5, 0.14],
];

/* Build the glow background from the mirror's word rects (the gallery
 * measures via canvas; real rects are RTL/shaping-safe). Only OBSERVABLE
 * words contribute: anything past the cluster fade (or clipped by the
 * pill box) is skipped, and words inside the fade ramp carry the ramp's
 * alpha — the shimmer dies out exactly where the text does. */
function buildGlowBackground(wrapper, mirror, v) {
    const wrapRect = wrapper.getBoundingClientRect();
    // Same geometry as the .t-clear-mirror mask: alpha 0 at the cluster
    // edge (--search-actions-w + 6), 0.45 at +60px, 1 from +130px — all
    // measured from the pill's LEFT edge (RTL: the fade end).
    const fadeEnd = cssNum("--search-actions-w", 60, wrapper) + 6;
    const maskAlpha = (x) => {
        if (x <= fadeEnd) return 0;
        if (x >= fadeEnd + 130) return 1;
        if (x <= fadeEnd + 60) return 0.45 * ((x - fadeEnd) / 60);
        return 0.45 + 0.55 * ((x - fadeEnd - 60) / 70);
    };
    const layers = [];
    for (const el of mirror.querySelectorAll(".t-clear-word")) {
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2 - wrapRect.left;
        const vis = (cx < 0 || cx > wrapRect.width) ? 0 : maskAlpha(cx);
        if (vis < 0.05) continue;       // invisible text gets no shimmer
        // Bottom-anchored at the word's own bottom edge (the gallery
        // anchors at the layer's 100% because its input is one text line
        // tall; the word rect is the same intent, robust to pill height).
        const bottom = r.bottom - wrapRect.top;
        const hw = Math.max(r.width * 0.45, 8) * v.glowSpread;
        for (const [dxm, rwm, rh, a] of GLOW_LAYERS) {
            layers.push(
                `radial-gradient(ellipse ${Math.max(hw * rwm, 2).toFixed(1)}px ${rh}px at `
                + `${(cx + dxm * hw).toFixed(1)}px ${bottom.toFixed(1)}px, `
                + `rgba(${v.glowRgb},${(a * vis).toFixed(3)}), transparent)`
            );
        }
    }
    return layers.join(", ");
}

/* The single whole-layer envelope: 0 until --glow-delay, rises to
 * --glow-opacity at --glow-peak-at of the remaining window, falls to 0
 * by --clear-dur. */
function glowEnvelope(t, v) {
    if (t <= v.glowDelay) return 0;
    const gp = Math.min(1, (t - v.glowDelay) / Math.max(1, v.clearDur - v.glowDelay));
    const env = gp < v.peakAt ? gp / v.peakAt : 1 - (gp - v.peakAt) / (1 - v.peakAt);
    return clamp01(env) * v.glowOpacity;
}

/* ── Input clear with dissolve (faithful p13-clear.js port) ──────────────
 * The MIRROR animates as ONE unit — it DROPS by --clear-out-fly while
 * fading and blurring over --clear-out-dur; the fake placeholder is
 * present from frame 0 (raised, blurred, 90%) and settles down over
 * --clear-in-dur; the static glow shimmer breathes once through the whole
 * --clear-dur window. */
export function dissolveSearchClear({ wrapper, input, mirror, placeholder, glow, onTextGone, onFinished }) {
    if (!wrapper || !mirror) {
        if (onTextGone) onTextGone();
        if (onFinished) onFinished();
        return;
    }
    if (prefersReducedMotion()) {
        if (onTextGone) onTextGone();
        if (onFinished) onFinished();
        return;
    }
    const v = readClearVars(glow);

    if (placeholder && input) placeholder.textContent = input.getAttribute("placeholder") || "";
    wrapper.classList.add("is-clearing");
    if (glow) {
        glow.style.background = buildGlowBackground(wrapper, mirror, v); // built ONCE
        glow.style.opacity = "0";
    }
    if (placeholder) {
        placeholder.style.transform = `translateY(${-v.inFly}px)`;
        placeholder.style.opacity = "0.9";
        placeholder.style.filter = `blur(${v.blurMax}px)`;
    }

    let goneFired = false;
    let raf = 0;
    const start = performance.now();

    const finish = () => {
        cancelAnimationFrame(raf);
        if (!goneFired) { goneFired = true; if (onTextGone) onTextGone(); }
        wrapper.classList.remove("is-clearing");
        if (glow) { glow.style.opacity = ""; glow.style.background = ""; }
        if (placeholder) {
            placeholder.style.opacity = "";
            placeholder.style.transform = "";
            placeholder.style.filter = "";
        }
        mirror.style.transform = "";
        mirror.style.opacity = "";
        mirror.style.filter = "";
        if (onFinished) onFinished();
    };

    const frame = (now) => {
        const t = now - start;

        // The text drops away — down, fading, blurring (gallery direction).
        const eo = v.ease(clamp01(t / v.outDur));
        mirror.style.transform = `translateY(${(v.outFly * eo).toFixed(1)}px)`;
        mirror.style.opacity = (1 - eo).toFixed(3);
        mirror.style.filter = `blur(${(v.blurMax * eo).toFixed(1)}px)`;

        // The hint settles in from above, un-blurring, from frame 0.
        if (placeholder) {
            const ei = v.ease(clamp01(t / v.inDur));
            placeholder.style.transform = `translateY(${(-v.inFly * (1 - ei)).toFixed(1)}px)`;
            placeholder.style.opacity = (0.9 + ei * 0.1).toFixed(3);
            placeholder.style.filter = `blur(${(v.blurMax * (1 - ei)).toFixed(1)}px)`;
        }

        // One whole-layer breath — the shimmer itself never moves.
        if (glow) glow.style.opacity = glowEnvelope(t, v).toFixed(3);

        if (!goneFired && t >= v.outDur) {
            goneFired = true;
            if (onTextGone) onTextGone();
        }

        if (t >= v.clearDur) {
            finish();
            return;
        }
        raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return finish; // cancel hook (also completes immediately)
}

/* ── Pick auto-complete: the ayah REVEALS word by word ───────────────────
 * Texts-reveal port (gallery #18) — deliberately DIFFERENT from the clear.
 * The removal is the whole line dropping away under a baseline shimmer;
 * the pick is each WORD rising into view (translateY + unblur + fade) in
 * reading order (RTL: the first span IS the rightmost word), no glow.
 * CSS owns the motion — .is-revealing stages the words hidden,
 * .is-shown flips them to rest, per-word inline transition-delay carries
 * the stagger (capped so long ayahs still land inside ~1s; the capped
 * tail rises as one). Caller must have locked the bar (has-value + mirror
 * built) immediately before. `glow` is accepted but unused — the shimmer
 * belongs to the clear alone. */
const REVEAL_STAGGER_CAP_MS = 480;

export function materializeSearchText({ wrapper, mirror, glow, onFinished }) {
    void glow;
    if (!wrapper || !mirror) {
        if (onFinished) onFinished();
        return;
    }
    if (prefersReducedMotion()) {
        if (onFinished) onFinished();
        return;
    }
    const words = Array.from(mirror.querySelectorAll(".t-clear-word"));
    if (!words.length) {
        if (onFinished) onFinished();
        return;
    }

    const dur = cssMs("--stagger-dur", 500);
    const stagger = cssMs("--stagger-stagger", 40);
    let maxDelay = 0;
    words.forEach((w, i) => {
        const d = Math.min(Math.round(i * stagger), REVEAL_STAGGER_CAP_MS);
        maxDelay = Math.max(maxDelay, d);
        w.style.transitionDelay = `${d}ms`;
    });

    wrapper.classList.add("is-materializing");
    // Stage hidden with transitions OFF (pre-existing spans would otherwise
    // start a visible→hidden transition and the reveal would no-op), commit
    // with a reflow, then flip to shown — the staggered rise begins.
    mirror.classList.add("is-revealing", "is-staging");
    void mirror.offsetWidth;
    mirror.classList.remove("is-staging");
    mirror.classList.add("is-shown");

    let timer = 0;
    const finish = () => {
        clearTimeout(timer);
        wrapper.classList.remove("is-materializing");
        mirror.classList.remove("is-revealing", "is-shown", "is-staging");
        for (const w of words) {
            if (w.isConnected) w.style.transitionDelay = "";
        }
        if (onFinished) onFinished();
    };
    timer = setTimeout(finish, maxDelay + dur + 60);
    return finish;
}
