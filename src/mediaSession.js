"use strict";

/* ============================================================
 * Pure-web now-playing bridge (navigator.mediaSession).
 *
 * Feeds the OS "now playing" surface — iOS lock screen / Dynamic
 * Island, Android notification + lock screen — with the app logo as
 * artwork plus the surah + reciter, and wires its transport buttons
 * (play / pause / next / prev) back to our audio engines.
 *
 * iOS WKWebView (15+, reliably 16.4+) bridges MediaMetadata to
 * MPNowPlayingInfoCenter, so this needs NO native plugin / rebuild.
 * Whether WKWebView actually paints the artwork must be confirmed on
 * a device; if it stays blank we fall back to a native
 * MPNowPlayingInfoCenter plugin (which WOULD need a rebuild).
 *
 * Every entry point is a no-op where the API is absent (older
 * WebViews, SSR/prerender), so callers can fire unconditionally.
 * ============================================================ */

const SUPPORTED = typeof navigator !== "undefined" && "mediaSession" in navigator;

// The blue app-icon (rasterized from /favicon.svg — the same blue mushaf the
// in-app banner uses as the icon). Root-relative, bundled, offline-safe. Two
// sizes so the OS can pick the cheap one for a small tile and the crisp one
// when it wants detail; the 512 is listed first as the common lock-screen size.
const ARTWORK = [
  { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
  { src: "/icon-1024.png", sizes: "1024x1024", type: "image/png" },
];

const ALBUM = "محمديات";

/** Surah + reciter → the now-playing card. Missing names degrade gracefully. */
export function setNowPlaying({ surahName, reciterName } = {}) {
  if (!SUPPORTED) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: surahName ? `سورة ${surahName}` : ALBUM,
      artist: reciterName || "",
      album: ALBUM,
      artwork: ARTWORK,
    });
  } catch { /* MediaMetadata unavailable — ignore */ }
}

/** "playing" | "paused" | "none" — drives the lock-screen play/pause glyph. */
export function setPlaybackState(state) {
  if (!SUPPORTED) return;
  try { navigator.mediaSession.playbackState = state; } catch { }
}

/** Map the OS transport buttons to our engines. Pass null/omit to clear one. */
export function wireActions({ onPlay, onPause, onNext, onPrev } = {}) {
  if (!SUPPORTED) return;
  const set = (action, fn) => {
    try { navigator.mediaSession.setActionHandler(action, fn || null); } catch { }
  };
  set("play", onPlay);
  set("pause", onPause);
  set("nexttrack", onNext);
  set("previoustrack", onPrev);
}

/** Tear the card down (no audio loaded anymore). */
export function clear() {
  if (!SUPPORTED) return;
  try { navigator.mediaSession.metadata = null; } catch { }
  setPlaybackState("none");
}
