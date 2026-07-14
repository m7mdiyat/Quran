"use strict";

import { startLoopFor, consumeOne, resetLoop } from "./repeat.js";

/* ============================================================
 * Continuous full-surah audio engine.
 *
 * One MP3 per surah per reciter, plus a timings JSON that marks
 * where each ayah begins/ends inside that file. A 100ms tick maps
 * audio.currentTime → active ayah and fires onAyahChange so the
 * Mushaf and Tafsir views can highlight in sync — with no audible
 * gap between ayahs (it's literally the same audio stream).
 *
 * Five reciters (qasim, alijaber, shuraim, ayoub, dosari) are
 * no-preamble: ayah 1 starts at 0:00. Luhaidan's files open with a
 * basmala BEFORE ayah 1 (every surah except 1 and 9; surah 2 adds an
 * istiadhah first) — his timings carry real start offsets, so the
 * engine's seek-to-start handles it.
 * ============================================================ */

const AUDIO_BASE = "https://storage.googleapis.com/m7mdiyat-tafsir-data/audio/surah";
const TIMINGS_BASE = "https://storage.googleapis.com/m7mdiyat-tafsir-data/timings";
const TICK_INTERVAL_MS = 100;

/* App detection — call-time, private copy: mirrors isApp() in src/app.js and
 * src/mushaf.js (keep the three in lockstep). Needed here because the app's
 * server origin ships COEP require-corp (thread isolation), which blocks the
 * default no-cors media load of GCS audio; CORS-approved loads pass, so the
 * engine's element opts in via crossOrigin (bucket CORS allows *). The
 * website keeps its no-cors loads untouched. */
function isApp() {
  if (typeof window === "undefined") return false;
  if (window.Capacitor !== undefined) return true;
  if (window.location.hostname === "localhost"
    && window.location.port === "17843") return true;
  return window.location.hostname === "localhost"
    && window.location.port === ""
    && navigator.userAgent.includes("Android");
}

const SURAH_RECITERS = new Set(["qasim", "alijaber", "shuraim", "ayoub", "dosari", "luhaidan", "abdulbasit", "husary", "minshawi", "maher"]);
export function isSurahAudioReciter(reciter) {
  return SURAH_RECITERS.has(reciter);
}

/* ------------------------------------------------------------ State */
const _timingsCache = new Map(); // `${reciter}:${surah}` → normalized timings

let _audio = null;
let _surah = null;
let _reciter = null;
let _continuous = false;
let _timings = null;            // [{ayah, start, end}, ...] in ms
let _activeAyah = null;
let _callbacks = null;
let _tickTimer = null;
let _loadGen = 0;               // bumped on every cold play() so stale fetches no-op
let _volume = 0.8;
let _speed = 1;
let _pendingSeekAyah = null;    // ayah # to seek to once timings finish loading

/* ------------------------------------------------------------ Offline hooks
 * The app (not the website) can make the engine play DOWNLOADED reciters from
 * the Cache API. surahAudio stays Cache/isApp-agnostic: src/reciter-offline.js
 * injects these hooks. All optional — when unset, every path below is exactly
 * the old network behavior, so the website + non-downloaded reciters are
 * untouched (incl. the synchronous play()-inside-gesture cold start).
 *   isDownloaded(reciter)        → boolean (SYNC). Gates whether the cold path
 *                                  takes the async cached-blob branch at all.
 *   resolveAudioUrl(reciter,s)   → Promise<string|null>: a `blob:` URL for the
 *                                  cached MP3, or null to fall back to network.
 *   revokeAudioUrl(url)          → release a blob: URL when the element is torn down.
 *   fetchTimings(url)            → Promise<Response|null>: a cached timings
 *                                  Response, or null to fall back to network. */
let _offlineHooks = null;
let _currentBlobUrl = null;     // the live element's blob: src, revoked on teardown
export function setOfflineHooks(h) { _offlineHooks = h || null; }

/* ------------------------------------------------------------ URLs
 * Exported so the offline-download module (src/reciter-offline.js) caches each
 * asset under the EXACT URL the engine later fetches — otherwise cache.match
 * would miss (note the asymmetry: MP3 surah is 3-digit padded, timings is not). */
export function audioUrl(reciter, surah) {
  return `${AUDIO_BASE}/${reciter}/${String(surah).padStart(3, "0")}.mp3`;
}
export function timingsUrl(reciter, surah) {
  return `${TIMINGS_BASE}/${reciter}/${surah}.json`;
}

/* ------------------------------------------------------------ Timings */
// Two upstream formats:
//   qasim → { surah, ayahs: [{ayah, start, end}, ...] }  (ms)
//   others → [endMs0, endMs1, ...]                       (cumulative end-of-ayah ms)
// Normalize to: [{ayah, start, end}, ...] with start of ayah 1 = 0.
function normalizeTimings(raw) {
  if (raw && Array.isArray(raw.ayahs)) {
    return raw.ayahs.map((a) => ({
      ayah: Number(a.ayah),
      start: Number(a.start) || 0,
      end: Number(a.end) || 0,
    }));
  }
  if (Array.isArray(raw)) {
    return raw.map((end, i) => ({
      ayah: i + 1,
      start: i === 0 ? 0 : Number(raw[i - 1]) || 0,
      end: Number(end) || 0,
    }));
  }
  throw new Error("surahAudio: unknown timings format");
}

async function loadTimings(reciter, surah) {
  const key = `${reciter}:${surah}`;
  if (_timingsCache.has(key)) return _timingsCache.get(key);
  const url = timingsUrl(reciter, surah);
  // Cache-first for downloaded reciters (app only); null → network fallback.
  let res = null;
  if (_offlineHooks?.fetchTimings) {
    try { res = await _offlineHooks.fetchTimings(url); } catch { res = null; }
  }
  if (!res) res = await fetch(url);
  if (!res.ok) {
    // A real HTTP response (e.g. 404 for a missing timings file) means the
    // server WAS reachable — tag the status so the UI doesn't misreport a
    // missing/broken file as "no internet".
    const e = new Error(`surahAudio: timings HTTP ${res.status}`);
    e.httpStatus = res.status;
    throw e;
  }
  const raw = await res.json();
  const normalized = normalizeTimings(raw);
  _timingsCache.set(key, normalized);
  return normalized;
}

// Largest start <= ms.
function ayahEntryAtMs(timings, ms) {
  if (!timings || !timings.length) return null;
  let lo = 0, hi = timings.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (timings[mid].start <= ms) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return timings[ans];
}

function ayahEntryFor(timings, ayahNo) {
  if (!timings) return null;
  return timings.find((t) => t.ayah === ayahNo) || null;
}

/* ------------------------------------------------------------ Tick */
function startTick() {
  stopTick();
  _tickTimer = setInterval(tick, TICK_INTERVAL_MS);
}
function stopTick() {
  if (_tickTimer != null) {
    clearInterval(_tickTimer);
    _tickTimer = null;
  }
}
function tick() {
  if (!_audio || _audio.paused || !_timings) return;
  const ms = _audio.currentTime * 1000;

  // Single-mode end-of-ayah check FIRST, against the currently-active
  // ayah's end. If we let the entry lookup advance _activeAyah past the
  // boundary before checking, the stop never triggers — the new entry's
  // end is always further out than ms. (This was the "continuous→single
  // glitch": when the user switched the chip mid-play, the engine rolled
  // into the next ayah instead of stopping at the current one.)
  if (!_continuous && _activeAyah) {
    const active = ayahEntryFor(_timings, _activeAyah);
    if (active && ms >= active.end) {
      // Repeat hook: if the user picked 3×/5×/∞ for this ayah, replay it
      // in-place instead of stopping. The counter is seeded by startLoopFor
      // in play() / on each ayah change, so this stays bound to ONE ayah.
      if (consumeOne(`${_surah}:${_activeAyah}`)) {
        try { _audio.currentTime = active.start / 1000; } catch { }
        // Keep audio running — don't pause, don't fire onEnded.
        return;
      }
      try { _audio.pause(); } catch { }
      fire("onEnded");
      return;
    }
  }

  const entry = ayahEntryAtMs(_timings, ms);
  if (!entry) return;
  if (entry.ayah !== _activeAyah) {
    _activeAyah = entry.ayah;
    // Crossing into a new ayah resets the repeat counter so the next ayah
    // gets a fresh loop budget instead of inheriting the previous ayah's.
    startLoopFor(`${_surah}:${_activeAyah}`);
    fire("onAyahChange", _activeAyah, _surah);
  }
}

/* ------------------------------------------------------------ Audio el */
function destroyAudio() {
  // Release the previous element's cached blob: URL (if any) so object URLs
  // don't leak across reciter/surah swaps.
  if (_currentBlobUrl) {
    try { _offlineHooks?.revokeAudioUrl?.(_currentBlobUrl); } catch { }
    _currentBlobUrl = null;
  }
  if (!_audio) return;
  try { _audio.pause(); } catch { }
  try {
    _audio.removeAttribute("src");
    _audio.load();
  } catch { }
  _audio = null;
}

function bindAudioEvents(audio) {
  audio.addEventListener("play", () => {
    if (_audio !== audio) return;
    if (audio.playbackRate !== _speed) audio.playbackRate = _speed;
    if (!audio.muted && audio.volume !== _volume) audio.volume = _volume;
    fire("onPlay");
  });
  // The "playing" event fires when playback can actually be heard — after
  // metadata load, decode, and any browser-internal property resets that
  // happen during the cold load. Re-apply rate here so a 2x speed survives
  // a reciter swap (where the new <audio>'s playbackRate set BEFORE src can
  // be silently reset to 1 by the load pipeline in some browsers).
  audio.addEventListener("playing", () => {
    if (_audio !== audio) return;
    if (audio.playbackRate !== _speed) audio.playbackRate = _speed;
    if (!audio.muted && audio.volume !== _volume) audio.volume = _volume;
  });
  // Safety net: if the browser auto-mutates the rate (some implementations
  // reset on media load), snap it back. Guard against infinite recursion by
  // only re-setting when it actually drifted.
  audio.addEventListener("ratechange", () => {
    if (_audio !== audio) return;
    if (audio.playbackRate !== _speed) audio.playbackRate = _speed;
  });
  audio.addEventListener("pause", () => {
    if (_audio !== audio) return;
    if (audio.ended) return; // ended fires its own callback
    fire("onPause");
  });
  audio.addEventListener("ended", () => {
    if (_audio !== audio) return;
    stopTick();
    fire("onEnded");
  });
  audio.addEventListener("error", () => {
    if (_audio !== audio) return;
    stopTick();
    fire("onError", audio.error || new Error("audio error"));
  });
}

function fire(name, ...args) {
  try { _callbacks?.[name]?.(...args); } catch (e) { console.error(`surahAudio.${name}:`, e); }
}

/* ============================================================
 * Public API
 * ============================================================ */

/**
 * Begin or update playback.
 *
 * Fast path: same surah + reciter already loaded → just seek to
 *   `ayah`'s start and resume. No re-fetch.
 *
 * Cold path: tear down any existing audio, create a fresh element,
 *   start play() muted INSIDE the caller's user-gesture frame (so
 *   mobile browsers accept it), fetch timings in parallel, then seek
 *   to `ayah` and unmute.
 */
export async function play({ surah, ayah, reciter, continuous, volume, speed, callbacks } = {}) {
  surah = Number(surah);
  ayah = Number(ayah) || 1;
  if (!surah || !reciter) throw new Error("surahAudio.play: surah + reciter required");

  if (typeof continuous === "boolean") _continuous = continuous;
  if (typeof volume === "number") _volume = volume;
  if (typeof speed === "number") _speed = speed;
  if (callbacks) _callbacks = callbacks;

  /* ---------- Fast path ---------- */
  if (_audio && _surah === surah && _reciter === reciter) {
    _audio.volume = _volume;
    _audio.playbackRate = _speed;
    if (_timings) {
      const entry = ayahEntryFor(_timings, ayah);
      if (entry) {
        try { _audio.currentTime = entry.start / 1000; } catch { }
        if (_activeAyah !== entry.ayah) {
          _activeAyah = entry.ayah;
          startLoopFor(`${_surah}:${_activeAyah}`);
          fire("onAyahChange", _activeAyah, _surah);
        } else {
          // Same ayah replay (user pressed play again) → fresh loop budget.
          startLoopFor(`${_surah}:${_activeAyah}`);
        }
      }
    } else {
      _pendingSeekAyah = ayah;
    }
    if (_audio.paused) {
      try { await _audio.play(); }
      catch (e) { fire("onError", e); throw e; }
    }
    startTick();
    return;
  }

  /* ---------- Cold path ---------- */
  const gen = ++_loadGen;
  destroyAudio();
  stopTick();
  _timings = null;
  _activeAyah = null;
  _surah = surah;
  _reciter = reciter;
  _pendingSeekAyah = ayah;

  // Cache-first source for DOWNLOADED reciters (app only). Only this branch
  // awaits before play(); non-downloaded reciters (and the whole website) skip
  // it entirely, preserving the synchronous play()-inside-gesture cold start.
  // Inside the app the WebView permits programmatic (muted) playback, so the
  // extra await here is safe. A cache miss returns null → network URL, so a
  // stale ready-flag or partial download just falls back to streaming.
  let srcUrl = audioUrl(reciter, surah);
  if (_offlineHooks?.isDownloaded?.(reciter)) {
    let blobUrl = null;
    try { blobUrl = await _offlineHooks.resolveAudioUrl(reciter, surah); } catch { }
    if (gen !== _loadGen) {                 // superseded while resolving
      if (blobUrl) { try { _offlineHooks.revokeAudioUrl?.(blobUrl); } catch { } }
      return;
    }
    if (blobUrl) { srcUrl = blobUrl; _currentBlobUrl = blobUrl; }
  }

  const audio = new Audio();
  audio.preload = "auto";
  audio.muted = true;                 // gesture-lock: unmute after seek lands
  audio.volume = _volume;
  audio.defaultPlaybackRate = _speed;
  audio.playbackRate = _speed;
  // COEP opt-in (see isApp above) — set BEFORE src or the first request goes
  // out no-cors. Harmless on blob: sources (same-origin, attribute ignored).
  if (isApp()) audio.crossOrigin = "anonymous";
  audio.src = srcUrl;
  _audio = audio;
  bindAudioEvents(audio);

  // Sync play() inside the caller's gesture — required by mobile.
  const playPromise = audio.play();
  if (playPromise && typeof playPromise.catch === "function") {
    playPromise.catch((e) => {
      if (gen === _loadGen) fire("onError", e);
    });
  }

  let timings;
  try {
    timings = await loadTimings(reciter, surah);
  } catch (e) {
    if (gen === _loadGen) {
      fire("onError", e);
      destroyAudio();
    }
    throw e;
  }
  if (gen !== _loadGen) return; // a newer play() superseded us

  _timings = timings;
  const target = _pendingSeekAyah || 1;
  _pendingSeekAyah = null;
  const entry = ayahEntryFor(timings, target) || timings[0];
  try { audio.currentTime = (entry?.start ?? 0) / 1000; } catch { }
  _activeAyah = entry ? entry.ayah : 1;
  audio.muted = false;
  // Defensive re-apply: some browsers reset playbackRate during the
  // load/decode that happens between play() and the seek above.
  audio.playbackRate = _speed;
  audio.volume = _volume;
  startLoopFor(`${_surah}:${_activeAyah}`);
  startTick();
  fire("onAyahChange", _activeAyah, _surah);
}

export function pause() {
  if (_audio && !_audio.paused) {
    try { _audio.pause(); } catch { }
  }
}

export function resume() {
  if (!_audio || !_audio.paused) return;
  const p = _audio.play();
  if (p && typeof p.catch === "function") p.catch((e) => fire("onError", e));
  startTick();
}

/**
 * Jump to the adjacent ayah in the current surah and keep playing.
 * Powers the lock-screen prev/next buttons (and any in-app skip). Clamped:
 * stepping past the first/last ayah is a no-op. Fires onAyahChange so
 * whichever view owns the engine re-highlights in sync.
 */
export function seekAyah(delta) {
  if (!_audio || !_timings || !_activeAyah) return;
  const entry = ayahEntryFor(_timings, _activeAyah + Number(delta));
  if (!entry) return;
  try { _audio.currentTime = entry.start / 1000; } catch { }
  _activeAyah = entry.ayah;
  startLoopFor(`${_surah}:${_activeAyah}`);
  fire("onAyahChange", _activeAyah, _surah);
  if (_audio.paused) resume();
  else startTick();
}

export function stop() {
  _loadGen++; // invalidate any in-flight cold-load
  stopTick();
  destroyAudio();
  _timings = null;
  _activeAyah = null;
  _surah = null;
  _reciter = null;
  _pendingSeekAyah = null;
  resetLoop();
  fire("onStop");
  _callbacks = null;
}

export function setVolume(v) {
  _volume = Math.max(0, Math.min(1, Number(v) || 0));
  if (_audio && !_audio.muted) _audio.volume = _volume;
}

export function setSpeed(s) {
  _speed = Math.max(0.5, Math.min(2, Number(s) || 1));
  if (_audio) {
    _audio.defaultPlaybackRate = _speed;
    _audio.playbackRate = _speed;
  }
}

export function setContinuous(b) {
  _continuous = !!b;
}

/**
 * Swap the callback bundle without disturbing audio playback.
 * Used when handing the live engine from one mode to another
 * (e.g. Tafsir → Mushaf) so the destination mode receives the
 * next onAyahChange / onPlay / onPause / onEnded events.
 */
export function setCallbacks(cb) {
  _callbacks = cb || null;
}

export function isActive() { return !!_audio; }
export function isPlaying() { return !!(_audio && !_audio.paused); }
export function getSurah() { return _surah; }
export function getReciter() { return _reciter; }
export function getActiveAyah() { return _activeAyah; }
export function getAudio() { return _audio; }
export function getSpeed() { return _speed; }
export function getVolume() { return _volume; }
export function getContinuous() { return _continuous; }

export const surahAudio = {
  play, pause, resume, stop, seekAyah,
  setVolume, setSpeed, setContinuous, setCallbacks,
  setOfflineHooks,
  isActive, isPlaying,
  getSurah, getReciter, getActiveAyah, getAudio,
  getSpeed, getVolume, getContinuous,
};
