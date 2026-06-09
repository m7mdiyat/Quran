/* ============================================================
 * Pulse-outside breathing driver for the مختصر التفاسير beam
 * (#compareTafsirsBtn, wrapper [data-beam="mukhtasar"] — static
 * layers in index.html).
 *
 * Port of https://github.com/Jakubantalik/border-beam (MIT License,
 * Copyright (c) 2026 Jakub Antalik): pulseDriver.ts (the shared
 * ~30fps rAF loop driving CSS custom properties) plus styles.ts
 * pulseParams / pulseOscillatorDefs / getPulseDriverConfig,
 * specialised to this single instance: size="pulse-outside",
 * duration 4.6s (2× the component default — calmer motion),
 * continuous 360° hue rotation over 28s (likewise 2× slower),
 * strength 0.5 (CSS --beam-strength).
 *
 * Each oscillator ping-pongs one CSS var between `a` and `b` with a
 * cosine ease over `period` seconds, offset by `delay` — identical
 * math to the source. Driving from JS at ~30fps instead of CSS
 * @property keyframes halves/quarters the repaint frequency on
 * 60/120Hz displays (the motion is 1.6–6.4s slow).
 *
 * Site lifecycle (replaces the React component's props/effects):
 *   - data-active follows the button's `disabled` attribute (enabled
 *     ⇒ an ayah is open ⇒ glow on), with the component's 0.6s
 *     fade-in / 0.5s fade-out cycle.
 *   - first CLICK fades the glow out permanently for the session —
 *     it's a discovery affordance, done once the user has tried it.
 *   - --pulse-glow-sx/sy rescale the fixed-pixel glow geometry from
 *     the 350×140 reference card to the real button box (0.35–4).
 *   - IntersectionObserver pauses everything offscreen (data-paused
 *     freezes the CSS fades; the loop stops writing vars).
 *   - Breathing params are theme-tuned (dark/light differ); a class
 *     observer retunes them when the site theme flips.
 *   - prefers-reduced-motion: never activates (the CSS @media also
 *     disables the fades, so no glow shows either way).
 * ============================================================ */

const ID = "mukhtasar";
// 2× the component's 2.3s pulse default — equivalent to duration={4.6}.
// Site preference for calmer motion; durScale below stretches every
// breathing period accordingly.
const DURATION = 4.6;
// ~30 fps. Subtract a small slack so a frame that lands a hair early still runs.
const FRAME_INTERVAL = 1000 / 30 - 2;
const TWO_PI = Math.PI * 2;
// Continuous full-circle hue drift (staticColors=false). The component pins
// this at 14s regardless of duration; slowed 2× to match the calmer breathing.
const HUE_RANGE = 360;
const HUE_PERIOD = 28;

/* pulseParams('pulse-outside', theme, 2.3) — theme-tuned breathing
 * parameters, verbatim from styles.ts (durScale = 1 at 2.3s). */
function pulseParams(isDark) {
  const durScale = DURATION / 2.3;
  return {
    sp: isDark ? 0.28 : 0.36,
    dr: isDark ? 14 : 19,
    op: isDark ? 0.46 : 0,
    gh: isDark ? 0.16 : 0.58,
    bs: (isDark ? 2.3 : 3.7) * durScale,
    ss: (isDark ? 6.4 : 4.6) * durScale,
    ghs: (isDark ? 2.4 : 3.8) * durScale,
  };
}

/* pulseOscillatorDefs(id, params) — verbatim oscillator table. */
function oscillatorDefs({ sp, dr, op, gh, bs, ss, ghs }) {
  return [
    { prop: `--bw1-${ID}`, a: 1 - sp, b: 1 + sp * 1.1, period: ss * 0.9, delay: 0, unit: "" },
    { prop: `--bh1-${ID}`, a: 1 + sp * 0.9, b: 1 - sp * 0.85, period: ss * 1.26, delay: 0, unit: "" },
    { prop: `--bx1-${ID}`, a: -dr, b: dr * 0.9, period: bs * 1.6, delay: 0, unit: "px" },
    { prop: `--by1-${ID}`, a: dr * 0.55, b: -dr * 0.7, period: bs * 1.6, delay: 0, unit: "px" },
    { prop: `--bw2-${ID}`, a: 1 + sp, b: 1 - sp * 0.85, period: ss * 1.1, delay: 0, unit: "" },
    { prop: `--bh2-${ID}`, a: 1 - sp * 0.8, b: 1 + sp * 1.05, period: ss * 0.81, delay: 0, unit: "" },
    { prop: `--bx2-${ID}`, a: dr * 0.8, b: -dr * 0.9, period: bs * 1.88, delay: 0, unit: "px" },
    { prop: `--by2-${ID}`, a: -dr, b: dr * 0.65, period: bs * 1.88, delay: 0, unit: "px" },
    { prop: `--bw3-${ID}`, a: 1 - sp * 0.6, b: 1 + sp * 1.15, period: ss * 0.98, delay: 0, unit: "" },
    { prop: `--bh3-${ID}`, a: 1 + sp * 0.75, b: 1 - sp, period: ss * 1.4, delay: 0, unit: "" },
    { prop: `--bx3-${ID}`, a: -dr * 0.6, b: dr, period: bs * 1.45, delay: 0, unit: "px" },
    { prop: `--by3-${ID}`, a: -dr * 0.85, b: dr * 0.45, period: bs * 1.45, delay: 0, unit: "px" },
    { prop: `--bgh-${ID}`, a: 1 - gh, b: 1 + gh, period: ghs, delay: 0, unit: "" },
    { prop: `--bop-tl-${ID}`, a: 1 - op, b: 1, period: bs, delay: 0, unit: "" },
    { prop: `--bop-tr-${ID}`, a: 1 - op, b: 1, period: bs * 1.32, delay: bs * 0.28, unit: "" },
    { prop: `--bop-bl-${ID}`, a: 1 - op, b: 1, period: bs * 0.84, delay: bs * 0.55, unit: "" },
    { prop: `--bop-br-${ID}`, a: 1 - op, b: 1, period: bs * 1.58, delay: bs * 0.83, unit: "" },
  ];
}

/** Cosine ease-in-out factor in [0, 1]: 0 at phase 0/1, 1 at phase 0.5. */
function pingPong(phase) {
  return (1 - Math.cos(TWO_PI * phase)) / 2;
}

export function initMukhtasarPulse() {
  const wrap = document.querySelector(`[data-beam="${ID}"]`);
  const btn = document.getElementById("compareTafsirsBtn");
  if (!wrap || !btn) return;

  try {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  } catch { }

  const isDark = () =>
    document.body.classList.contains("dark")
    || document.documentElement.classList.contains("dark");
  let oscillators = oscillatorDefs(pulseParams(isDark()));

  // Glow geometry scale: 350×140 reference → real button box, clamped so
  // small buttons shrink the halo and large cards grow it (never degenerate).
  const setGlowScale = () => {
    const rect = btn.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const clamp = (v) => Math.max(0.35, Math.min(4, v));
    wrap.style.setProperty("--pulse-glow-sx", clamp(rect.width / 350).toFixed(3));
    wrap.style.setProperty("--pulse-glow-sy", clamp(rect.height / 140).toFixed(3));
  };
  setGlowScale();
  if (window.ResizeObserver) new ResizeObserver(setGlowScale).observe(btn);

  let running = false; // glow logically on (active or mid-fade)
  let visible = true;  // wrapper on/near screen
  let rafId = null;
  let lastFrame = 0;

  const frame = (ts) => {
    rafId = requestAnimationFrame(frame);
    if (ts - lastFrame < FRAME_INTERVAL) return;
    lastFrame = ts;
    const tSec = ts / 1000;
    for (const osc of oscillators) {
      // Match CSS animation-delay semantics: a positive delay starts later.
      const phase = (tSec - osc.delay) / osc.period;
      const value = osc.a + (osc.b - osc.a) * pingPong(phase);
      wrap.style.setProperty(
        osc.prop,
        osc.unit === "px" ? `${value.toFixed(2)}px` : value.toFixed(4)
      );
    }
    const hue = ((tSec / HUE_PERIOD) % 1) * HUE_RANGE;
    wrap.style.setProperty(`--beam-hue-${ID}`, `${hue.toFixed(2)}deg`);
  };

  const syncLoop = () => {
    const want = running && visible;
    if (want && rafId == null) {
      lastFrame = 0;
      rafId = requestAnimationFrame(frame);
    } else if (!want && rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  };

  const activate = () => {
    wrap.removeAttribute("data-fading");
    wrap.setAttribute("data-active", "");
    running = true;
    syncLoop();
  };

  const deactivate = () => {
    if (!wrap.hasAttribute("data-active")) return;
    wrap.removeAttribute("data-active");
    wrap.setAttribute("data-fading", "");
    // `running` stays true through the 0.5s fade so the breathing keeps
    // moving while the layers fade out (matches the component).
  };

  wrap.addEventListener("animationend", (e) => {
    if (!String(e.animationName).includes("fade-out")) return;
    wrap.removeAttribute("data-fading");
    running = false;
    syncLoop();
  });

  // Once pressed, the glow has done its job (it's a "try this" affordance) —
  // fade out and stay off for the rest of the session, like the search
  // pill's beam after an ayah is chosen.
  let pressedOff = false;
  btn.addEventListener("click", () => {
    if (pressedOff) return;
    pressedOff = true;
    deactivate();
  });

  // The glow follows the button's enabled state: enabled means an ayah is
  // open and a comparison can run — until the first press kills it for good.
  const syncFromDisabled = () => {
    if (btn.disabled || pressedOff) deactivate();
    else activate();
  };
  new MutationObserver(syncFromDisabled)
    .observe(btn, { attributes: true, attributeFilter: ["disabled"] });
  syncFromDisabled();

  // Pause offscreen: data-paused freezes the CSS fade animations, and the
  // driver stops writing vars (zero per-frame paint while scrolled away).
  if (typeof IntersectionObserver !== "undefined") {
    new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          visible = entry.isIntersecting;
          if (visible) wrap.removeAttribute("data-paused");
          else wrap.setAttribute("data-paused", "");
        }
        syncLoop();
      },
      // Start animating slightly before the element scrolls into view.
      { rootMargin: "256px" }
    ).observe(wrap);
  }

  // Theme flips retune the breathing (dark/light params differ).
  const retune = () => {
    oscillators = oscillatorDefs(pulseParams(isDark()));
  };
  new MutationObserver(retune)
    .observe(document.body, { attributes: true, attributeFilter: ["class"] });
  new MutationObserver(retune)
    .observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
}
