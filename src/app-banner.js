/*
 * App-download banner — WEBSITE ONLY.
 *
 * A slim, dismissible bottom banner that invites mobile web visitors to install
 * the published native app from the correct store (iOS App Store / Google Play).
 * It must NEVER appear inside the Capacitor app — an app user has no use for a
 * download prompt. Three independent guards enforce that:
 *   1. app.js only dynamic-imports this module in the `else` of `if (isApp())`,
 *      so the app's init path never even loads it.
 *   2. initAppBanner() bails when isApp() OR when <html> carries the `is-app`
 *      class. That class is set synchronously by the inline head script (before
 *      first paint) for BOTH apps — iOS via the capacitor:// scheme, Android via
 *      localhost — so it is reliable even during the iOS cold-start window where
 *      window.Capacitor (hence isApp(), see app.js syncNativeStatusBar) is not
 *      ready yet and the UA still says "iPhone". This is the race-free guard.
 *   3. As a final net, reveal is deferred ~900ms and re-checks isApp() before
 *      showing; the delay also doubles as a calm, intentional entrance.
 *
 * Desktop / unknown platforms get no banner. Dismissal is remembered for
 * BANNER_SUPPRESS_DAYS via localStorage (web-only; every access is guarded so a
 * shared-code app context can never throw).
 */

"use strict";

import { isApp } from "./app.js";

const STORAGE_KEY = "m7_app_banner_dismissed";
const BANNER_SUPPRESS_DAYS = 30;
const REVEAL_DELAY_MS = 900; // also the iOS-app race-guard window (see header)

const IOS = {
  os: "ios",
  url: "https://apps.apple.com/app/id6779788235",
};
const ANDROID = {
  os: "android",
  url: "https://play.google.com/store/apps/details?id=com.m7mdiyat.quran",
};

/* Which store (if any) this visitor should be sent to. Returns null on
 * desktop / unknown platforms — no banner there. */
function detectStore() {
  const ua = navigator.userAgent || "";
  // Android first — its UA never contains iPhone/iPad.
  if (/android/i.test(ua)) return ANDROID;
  // Classic iOS UAs across Safari / Chrome / Firefox.
  if (/iphone|ipad|ipod/i.test(ua)) return IOS;
  // iPadOS 13+ masquerades as desktop Safari ("Macintosh"); the tell is a
  // touch-capable "Mac" — real Macs report maxTouchPoints 0.
  if (/macintosh/i.test(ua) && (navigator.maxTouchPoints || 0) > 1) return IOS;
  return null;
}

function isDismissed() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const ts = Number(raw);
    if (!Number.isFinite(ts)) return false;
    return (Date.now() - ts) < BANNER_SUPPRESS_DAYS * 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

function rememberDismissal() {
  try { localStorage.setItem(STORAGE_KEY, String(Date.now())); } catch { }
}

let BANNER_EL = null;

// Store-specific glyph for the CTA (single-colour, follows currentColor white).
function storeGlyph(os) {
  if (os === "ios") {
    return `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16.365 1.43c0 1.14-.42 2.2-1.12 3-.78.9-2.06 1.6-3.1 1.52-.13-1.1.43-2.27 1.1-3.02.78-.88 2.13-1.53 3.12-1.5zM20.9 17.1c-.5 1.16-.74 1.68-1.39 2.7-.9 1.43-2.18 3.2-3.76 3.22-1.4.02-1.76-.92-3.66-.9-1.9.01-2.3.92-3.7.9-1.58-.02-2.79-1.62-3.7-3.04-2.53-3.98-2.8-8.65-1.24-11.13 1.11-1.76 2.86-2.79 4.5-2.79 1.68 0 2.73.92 4.12.92 1.35 0 2.17-.92 4.11-.92 1.47 0 3.02.8 4.13 2.18-3.63 1.99-3.04 7.17.29 8.86z"/></svg>`;
  }
  // Google Play triangle.
  return `<svg viewBox="0 0 512 512" fill="currentColor" aria-hidden="true"><path d="M325.3 234.3 104.6 13l280.8 161.2-60.1 60.1zM47 0C34 6.8 25.3 19.2 25.3 35.3v441.3c0 16.1 8.7 28.5 21.7 35.3l256.6-256L47 0zm425.2 225.6-58.9-34.1-65.7 64.5 65.7 64.5 60.1-34.1c18-14.3 18-46.5-1.2-60.8zM104.6 499l280.8-161.2-60.1-60.1L104.6 499z"/></svg>`;
}

function buildBanner(store) {
  const wrap = document.createElement("div");
  wrap.className = "m7-app-banner";
  wrap.setAttribute("role", "region");
  wrap.setAttribute("aria-label", "تحميل التطبيق");
  wrap.innerHTML = `
    <div class="m7-app-banner__inner">
      <span class="m7-app-banner__icon" aria-hidden="true">
        <img src="/favicon.svg" alt="" width="40" height="40" />
      </span>
      <span class="m7-app-banner__text">
        <span class="m7-app-banner__title">حمّل تطبيق محمديات</span>
        <span class="m7-app-banner__sub">أسرع، ويعمل بدون إنترنت</span>
      </span>
      <a class="m7-app-banner__cta" href="${store.url}" target="_blank" rel="noopener">
        ${storeGlyph(store.os)}<span>تحميل</span>
      </a>
      <button type="button" class="m7-app-banner__close" aria-label="إغلاق">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
      </button>
    </div>`;

  wrap.querySelector(".m7-app-banner__close").addEventListener("click", () => dismiss());
  // Engaging with the CTA also stops future prompts — they've acted on it.
  wrap.querySelector(".m7-app-banner__cta").addEventListener("click", () => rememberDismissal());
  return wrap;
}

function dismiss() {
  rememberDismissal();
  if (!BANNER_EL) return;
  const el = BANNER_EL;
  BANNER_EL = null;
  el.classList.remove("m7-app-banner--in");
  // Remove once the slide-out finishes; setTimeout is a fallback in case
  // transitionend never fires (reduced-motion has no transition).
  const done = () => el.remove();
  el.addEventListener("transitionend", done, { once: true });
  setTimeout(done, 600);
}

export function initAppBanner() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (isApp()) return;                 // never in the app (guard #2)
  // Race-free: the inline head script adds `is-app` synchronously for both apps
  // (iOS capacitor:// / Android localhost) even before window.Capacitor exists.
  if (document.documentElement.classList.contains("is-app")) return;
  const store = detectStore();
  if (!store) return;                  // desktop / unknown → no banner
  if (isDismissed()) return;

  const el = buildBanner(store);
  document.body.appendChild(el);

  // Deferred reveal: closes the iOS cold-start race (guard #3) — by now the
  // native bridge has had time to inject window.Capacitor — and gives a calm
  // entrance. If we now turn out to be the app, drop it and never show.
  setTimeout(() => {
    if (isApp()) { el.remove(); return; }
    BANNER_EL = el;
    void el.offsetHeight; // force reflow so the transition runs from off-screen
    el.classList.add("m7-app-banner--in");
  }, REVEAL_DELAY_MS);
}
