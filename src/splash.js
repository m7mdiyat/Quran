/*
 * Opening splash animation — APP ONLY.
 *
 * Shown only inside the Capacitor app: the importer in src/app.js gates this
 * dynamic import behind isApp(), so the website bundle never includes this
 * module or lottie-web (separate Vite chunk, never fetched on the web).
 *
 * A fixed full-screen overlay, themed to the app background, hosts a play-once
 * Lottie. The native splash (held open via @capacitor/splash-screen
 * launchAutoHide:false) hands off to the Lottie's background-only frame 0 the
 * instant it renders — because the native solid color, the overlay background,
 * and the Lottie's frame 0 are all the same color, the handoff is invisible.
 * The overlay then fades out once BOTH the animation has finished AND the app
 * has restored the user's reading position (see _markAppReady in src/app.js).
 *
 * A safety timeout guarantees the overlay can NEVER trap the user, even if the
 * Lottie or its asset fails to load.
 */

import lottie from "lottie-web/build/player/lottie_light"; // SVG renderer only (small)
import animationData from "./splash-v3.json";

// Single source of truth for the splash background — must match the app body
// background (index.html) and the native launch screen so every handoff is
// invisible. Light = the app's body bg; dark = the dominant mid-stop of the
// dark gradient (#232933 → #1f252e → #1b2129).
const LIGHT_BG = "#eff5ff";
const DARK_BG = "#1f252e";
const FADE_MS = 300;
const SAFETY_MS = 5000; // overlay force-removed after this, no matter what
const NATIVE_HIDE_FALLBACK_MS = 1500; // hide native splash even if the Lottie never renders

/* Hide the native (Capacitor) splash via the runtime bridge — same pattern the
 * app uses for StatusBar (window.Capacitor?.Plugins?.X in src/app.js). The
 * plugin exists only inside the app with @capacitor/splash-screen installed.
 * Idempotent + best-effort. */
function makeNativeHider() {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    try { window.Capacitor?.Plugins?.SplashScreen?.hide(); } catch { /* ignore */ }
  };
}

export function initSplash({ appReady, isDark } = {}) {
  const dark = typeof isDark === "function" ? !!isDark() : false;

  const overlay = document.createElement("div");
  overlay.id = "m7-splash";
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
    background: dark ? DARK_BG : LIGHT_BG,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    opacity: "1",
    transition: `opacity ${FADE_MS}ms ease`,
    touchAction: "none", // block gestures reaching the app while the splash is up
  });

  const host = document.createElement("div");
  // ~70% of the shorter screen dimension, centered.
  const size = Math.round(Math.min(window.innerWidth, window.innerHeight) * 0.7);
  host.style.width = size + "px";
  host.style.height = size + "px";
  overlay.appendChild(host);

  document.body.appendChild(overlay);

  const hideNative = makeNativeHider();

  let torn = false;
  let anim = null;
  function teardown() {
    if (torn) return;
    torn = true;
    hideNative(); // covers tearing down before the Lottie ever rendered
    overlay.style.pointerEvents = "none";
    overlay.style.opacity = "0";
    let removed = false;
    const removeOnce = () => {
      if (removed) return;
      removed = true;
      try { anim && anim.destroy(); } catch { /* ignore */ }
      try { overlay.remove(); } catch { /* ignore */ }
    };
    overlay.addEventListener("transitionend", removeOnce, { once: true });
    setTimeout(removeOnce, FADE_MS + 120); // fallback if transitionend never fires
  }

  // The overlay must NEVER trap the user.
  const safety = setTimeout(teardown, SAFETY_MS);
  // And never sit on the native splash forever if the Lottie can't render.
  setTimeout(hideNative, NATIVE_HIDE_FALLBACK_MS);

  try {
    anim = lottie.loadAnimation({
      container: host,
      renderer: "svg",
      loop: false,
      autoplay: true,
      animationData,
    });
  } catch {
    clearTimeout(safety);
    teardown(); // player failed to start — bail cleanly, the app is fine underneath
    return;
  }

  // Native solid color → Lottie frame 0 (also background-only) = seamless handoff.
  anim.addEventListener("DOMLoaded", hideNative);

  const animDone = new Promise((resolve) => {
    anim.addEventListener("complete", resolve);
  });

  // Fade out on the LATER of: animation finished, app ready.
  Promise.all([animDone, Promise.resolve(appReady)])
    .then(() => {
      clearTimeout(safety);
      teardown();
    })
    .catch(() => { /* safety timeout still covers us */ });
}
