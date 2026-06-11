/* مُحمديات — Offline Quran Search + Context + Tafsir + AI
   Requires local files in same folder:
   - quran.json
   - surahs.json
   - tafseer_muyassar.json, tafseer_ibn_kathir.json, tafseer_ibn_ashur.json ... (optional)
   - en.sahih.json (optional)
*/

"use strict";

window.addEventListener("error", (e) => {
  // Not an exception: Chrome fires this benign notice when ResizeObserver
  // notifications span a frame boundary (the spec allows deferring them to
  // the next frame). With several observers live (search pill, Mushaf
  // autoFit, pulse-beam) a mode toggle can legitimately produce it —
  // logging it as a JS error is pure noise.
  if (/ResizeObserver loop/.test(e.message || "")) return;
  console.error("JS error:", e.message, e.error);
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("Promise error:", e.reason);
});

const el = (id) => document.getElementById(id);

/** ✅ Your deployed backend endpoint (AI search) */
const API_BASE = import.meta.env.VITE_API_BASE || "https://tafsir-api-317751773286.me-central1.run.app";
const TAFSIR_API_URL = `${API_BASE}/ai`;
export const API_ROOT = API_BASE.replace(/\/$/, "");
const COMPARE_API_URL = `${API_ROOT}/compare`;
const COMPARE_STREAM_URL = `${API_ROOT}/ai/stream`;

/** ✅ GCS Audio Base URL for Quran recitations */
export const AUDIO_BASE = "https://storage.googleapis.com/recitations-bucket-data/audio/";

/* Mushaf reading mode bridge */
import { initMushaf, openMushafAtAyah, openMushafAtPage, openMushafAtSurah, isMushafMode, setAppMode, closeMushafPanel, resetMushafHomeState, noteTafsirViewedAyah, preloadMushafData, syncSpeed as syncMushafSpeed, syncVolume as syncMushafVolume, syncAudioMode as syncMushafAudioMode, stopMushafPerAyahAudio, getMushafPerAyahPosition, playMushafAyahAtKey, getMushafTargetSurah } from "./mushaf.js";

/* Continuous full-surah audio engine (all reciters) */
import { surahAudio } from "./surahAudio.js";

/* Pulse-outside glow driver for the مختصر التفاسير button */
import { initMukhtasarPulse } from "./pulse-beam.js";

/* Transitions.dev animation pack: panel reveal for the ayah panel, the
 * ayah→ayah page slide, the مسح input dissolve, the selector number swap,
 * and reduced-motion plumbing (CSS in index.html). */
import {
  panelPrepare, panelOpen, panelOpenInstant,
  dissolveSearchClear, materializeSearchText, swapBlock, cssMs, prefersReducedMotion,
} from "./transitions.js";

/* Repeat / loop preference + active-loop counter (shared website + app) */
import { startLoopFor as repeatStart, consumeOne as repeatConsume, resetLoop as repeatReset, getRepeatPref, setRepeatPref, subscribeRepeat } from "./repeat.js";

/* Resume reading position — APP ONLY. The website never enters this code
 * path; the import is dynamic + behind isApp(), and these are no-op by
 * default so the website's setPrimaryAyah / Mushaf hooks can call them
 * unconditionally without paying any cost. */
let _recordResume = (_patch) => { };
export function recordResumeCb(patch) { _recordResume(patch); }

/* ---------------- DOM ---------------- */
const textSearch = el("textSearch");
const clearBtn = el("clearBtn");
const indexStatus = el("indexStatus");
const netBadge = el("netBadge");

const resultsShell = el("resultsShell");
const results = el("results");
/* The selected-ayah chip card is GONE (round 5): selection shows as the
 * locked ayah text materializing in the pill, and مسح lives in the pill's
 * action cluster (#clearBtn there), fading in once an ayah is selected. */

/* ── Task 1: searched-ayah lock + مسح dissolve (Transitions.dev) ──────
 * Picking a result LOCKS the typed text in the search pill instead of
 * wiping it: the wrapper gains .has-value, the input's own glyphs go
 * transparent and the .t-clear-mirror renders the value split into
 * per-word spans — which is exactly what the مسح dissolve animates
 * (fly-up + blur + per-word glow streaks, all measured from the real
 * RTL word rects). Editing the input unlocks it again seamlessly. */
const searchClearWrap = textSearch?.closest(".t-clear") || null;
const searchClearMirror = el("searchClearMirror");
const searchClearPlaceholder = el("searchClearPlaceholder");
const searchClearGlow = el("searchClearGlow");

/* Mirror metrics must match the input's text box exactly (the input has a
 * 1px border the inset:0 layers don't, plus the runtime padding-left calc
 * that tracks the surah-selector cluster). Copied as computed px values. */
function syncClearMetrics() {
  if (!textSearch || !searchClearMirror) return;
  const cs = getComputedStyle(textSearch);
  for (const layer of [searchClearMirror, searchClearPlaceholder]) {
    if (!layer) continue;
    layer.style.paddingRight = `${parseFloat(cs.paddingRight) + parseFloat(cs.borderRightWidth)}px`;
    layer.style.paddingLeft = `${parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth)}px`;
    layer.style.fontFamily = cs.fontFamily;
    layer.style.fontSize = cs.fontSize;
    layer.style.fontWeight = cs.fontWeight;
    layer.style.letterSpacing = cs.letterSpacing;
  }
}

/* Fill `container` with word spans + the exact whitespace between them.
 * Whitespace ALSO needs real spans (.t-clear-space, white-space:pre): the
 * mirror is a flex container, and flex drops whitespace-only text nodes
 * outright — bare text-node spaces rendered the words jammed together.
 *
 * Capped at 240 chars: the cluster-anchored mask hides everything past
 * the selector anyway, so rendering ALL of a 400-char ayah would only
 * pile invisible spans into the mirror — and into every step-swap and the
 * مسح dissolve. Arabic with tashkeel measures ≈2.9px/char at this font
 * size (diacritics are zero-advance combining marks), so 240 chars ≈
 * 700px of glyphs — comfortably past the fully-transparent mask point of
 * the widest possible pill (max-w-2xl mirror ≈ 638px − minimum cluster
 * footprint ≈ 66px = 572px), so a truncated render can never end as a
 * visible hard edge inside the fade ramp. The input's value always keeps
 * the FULL text (unlock/search/مسح truth); only the visual mirror
 * truncates. */
const MIRROR_MAX_CHARS = 240;

function buildMirrorWords(container, text) {
  container.textContent = "";
  let used = 0;
  for (const token of String(text || "").split(/(\s+)/)) {
    if (!token) continue;
    if (used >= MIRROR_MAX_CHARS) break;
    used += token.length;
    const span = document.createElement("span");
    span.className = /^\s+$/.test(token) ? "t-clear-space" : "t-clear-word";
    span.textContent = token;
    container.appendChild(span);
  }
}

/* Rebuild the mirror straight from the input's value. The words always sit
 * inside ONE .t-clear-line wrapper — the unit the quiet ayah-tracking and
 * the selector reflection swap via swapBlock, while the dissolve/
 * materialize routines find the word spans through it for their glow. */
function syncClearMirror() {
  if (!searchClearMirror) return;
  searchClearMirror.textContent = "";
  const value = textSearch?.value || "";
  if (!value) return;
  const line = document.createElement("span");
  line.className = "t-clear-line";
  buildMirrorWords(line, value);
  searchClearMirror.appendChild(line);
}

function mirrorLineEl() {
  return searchClearMirror ? searchClearMirror.querySelector(".t-clear-line") : null;
}

function lockSearchInput({ preview = false } = {}) {
  if (!searchClearWrap || !textSearch || !textSearch.value) return;
  syncClearMetrics();
  syncClearMirror();
  // preview: the open selector wheel BROWSING state — mirror + hidden
  // glyphs only. The LOCKED treatment (tint + veil) is reserved for an
  // ayah that was actually chosen (has-value); browsing never locks.
  searchClearWrap.classList.toggle("has-value", !preview);
  searchClearWrap.classList.toggle("is-previewing", preview);
}

/* Round 5 (5.3 entrance): selecting a search result LOCKS the FULL ayah
 * text into the pill with the texts-reveal (gallery #18) — the typed
 * fragment "completes itself": each word of the ayah rises into view with
 * staggered blur, in reading order, while the surface slowly tints to the
 * locked color and the pill مسح fades into existence. Deliberately a
 * DIFFERENT animation from مسح's removal dissolve (whole line dropping
 * away under the baseline shimmer) — appearing ≠ disappearing.
 * MATERIALIZE_CANCEL lets a مسح / unlock-click that lands mid-reveal
 * finish it instantly first, so two routines never fight over the
 * mirror. */
let MATERIALIZE_CANCEL = null;

function lockSearchToAyah(fullText) {
  if (!searchClearWrap || !textSearch || !fullText) return;
  if (MATERIALIZE_CANCEL) MATERIALIZE_CANCEL();
  textSearch.value = fullText;       // the input's value is always the truth
  lockSearchInput();
  MATERIALIZE_CANCEL = materializeSearchText({
    wrapper: searchClearWrap,
    mirror: searchClearMirror,
    glow: searchClearGlow,
    onFinished: () => { MATERIALIZE_CANCEL = null; },
  }) || null;
}

/* ── Pill مسح visibility (round 5) ───────────────────────────────────────
 * Appears only after an ayah is selected, slowly fading into existence;
 * hidden again by the مسح reset. Wired into deactivate/reactivate-
 * SearchBeam — the exact same "an ayah is chosen / homepage restored"
 * semantics, already fired by every selection path in both modes. */
function showPillClear() {
  if (!clearBtn) return;
  if (clearBtn.classList.contains("is-shown")
    && !clearBtn.classList.contains("is-leaving")) return;
  clearBtn.classList.remove("is-leaving", "is-entering");
  clearBtn.classList.add("is-shown");      // display flips on…
  if (prefersReducedMotion()) {
    clearBtn.classList.add("is-visible");
    return;
  }
  // …then, with layout committed (double rAF), arm the rewind stroke to
  // draw from its REAL path lengths and fire the success-check entrance —
  // horizontal cut: in from the LEFT, springing right into place.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!clearBtn.classList.contains("is-shown")) return;
    clearBtn.querySelectorAll("svg path").forEach((p) => {
      try {
        const len = p.getTotalLength();
        if (len > 0) {
          p.style.strokeDasharray = String(len);
          p.style.strokeDashoffset = String(len);
        }
      } catch { }
    });
    clearBtn.classList.add("is-visible", "is-entering");
  }));
}

function hidePillClear() {
  if (!clearBtn) return;
  if (!clearBtn.classList.contains("is-shown")) return;
  if (prefersReducedMotion()) {
    clearBtn.classList.remove("is-shown", "is-visible", "is-entering", "is-leaving");
    return;
  }
  // Exit continues the entrance's journey: off to the RIGHT, fading; the
  // display flip waits for the slide to finish (a re-show cancels it).
  clearBtn.classList.remove("is-entering");
  clearBtn.classList.add("is-leaving");
  setTimeout(() => {
    if (!clearBtn.classList.contains("is-leaving")) return; // re-shown mid-exit
    clearBtn.classList.remove("is-shown", "is-visible", "is-leaving");
  }, 360);
}

/* Drop the lock state. Safe to call at any time (resetToHome runs it on
 * every path); the dissolve keeps painting through .is-clearing, which
 * only the animation's own cleanup removes. */
function clearInputLock() {
  if (!searchClearWrap) return;
  searchClearWrap.classList.remove("has-value", "is-previewing");
  if (!searchClearWrap.classList.contains("is-clearing") && searchClearMirror) {
    searchClearMirror.textContent = "";
  }
}

/* ── Round 2, Fix 4 (round 3 revision): selector → search-bar reflection ──
 * While the selector's ayah picker is open, the bar mirrors the AYAH TEXT
 * ITSELF for the pending pick — through the same lock mechanism the search
 * results use, so it inherits the horizontal fade mask (long ayahs melt
 * away toward the selector cluster) and the مسح dissolve for free. Every
 * wheel step swaps the whole text line through the shared three-phase
 * swap (swapBlock on the inner .t-clear-line; the mask stays on the
 * parent mirror, so the swap's translateY/blur never fights it). Closing
 * the dropdown without اذهب restores whatever the bar held before (unless
 * something else — مسح, a new search — already took the input over). */
let SELECTOR_REFLECT = null; // { snapValue, snapLocked, lineEl, lastText }

function selectorReflect(s, a) {
  if (!textSearch || !searchClearWrap || !searchClearMirror) return;
  if (MATERIALIZE_CANCEL) MATERIALIZE_CANCEL(); // reflection takes the mirror over
  // The real ayah text; plain reference as a fallback for the (boot-time)
  // window where quran.json isn't parsed yet.
  const name = SURAH_META.find((x) => x.number === s)?.name_ar || `سورة ${s}`;
  const text = getAyahTextFromQuran(s, a) || `${name} — الآية ${a}`;
  if (!SELECTOR_REFLECT) {
    SELECTOR_REFLECT = {
      snapValue: textSearch.value,
      snapLocked: searchClearWrap.classList.contains("has-value"),
      lineEl: null,
      lastText: "",
    };
  }
  const st = SELECTOR_REFLECT;
  if (text === st.lastText) return; // aria re-syncs fire without value changes
  st.lastText = text;
  textSearch.value = text; // keep the real input truthful for unlock/مسح
  if (!st.lineEl || !st.lineEl.isConnected) {
    // First reflection: PREVIEW the pill (mirror text, no locked
    // treatment — nothing is chosen while the wheel is still open).
    lockSearchInput({ preview: true });
    st.lineEl = mirrorLineEl();
  } else {
    swapBlock(st.lineEl, () => {
      if (st.lineEl) buildMirrorWords(st.lineEl, st.lastText);
    });
  }
}

function selectorReflectCommit() {
  // اذهب pressed — the reflected text becomes the bar's real state.
  SELECTOR_REFLECT = null;
}

function selectorReflectAbandon() {
  const st = SELECTOR_REFLECT;
  SELECTOR_REFLECT = null;
  if (!st || !textSearch) return;
  // Restore only while the reflection is still what's on screen — a مسح
  // or a fresh search in between owns the input now.
  if (textSearch.value !== st.lastText) return;
  textSearch.value = st.snapValue || "";
  if (st.snapLocked && textSearch.value) lockSearchInput();
  else clearInputLock();
}

/* Round 5: the locked bar IS the selected-ayah display now (the chip card
 * is gone), so it must never go stale while navigating — prev/next,
 * context clicks, deep links and popstate all quietly retarget it. The
 * already-locked bar swaps its line softly (same motion as the selector
 * reflection); an unlocked bar locks silently — EXCEPT while the user is
 * actively typing in it, while the selector reflection owns it, or while
 * a مسح dissolve is mid-flight (it is emptying the bar). */
function reflectAyahInBar(surahNo, ayahNo) {
  if (!textSearch || !searchClearWrap || !searchClearMirror) return;
  if (SELECTOR_REFLECT) return;
  if (searchClearWrap.classList.contains("is-clearing")) return;
  const text = getAyahTextFromQuran(surahNo, ayahNo);
  if (!text) return;
  if (textSearch.value === text) {
    // Same text but only PREVIEWED (the selector wheel just committed):
    // upgrade the browsing preview to the real locked treatment.
    if (searchClearWrap.classList.contains("is-previewing")) lockSearchInput();
    return;
  }
  // Mid-reveal: restart with the newer text — lockSearchToAyah cancels the
  // in-flight reveal (instant cleanup) and starts a fresh one, so a fast
  // pick → next/prev simply reveals the newer ayah instead of going stale.
  if (searchClearWrap.classList.contains("is-materializing")) {
    lockSearchToAyah(text);
    return;
  }
  const locked = searchClearWrap.classList.contains("has-value");
  // Protect only a real in-progress DRAFT: input focused AND holding text.
  // A merely-focused EMPTY bar must not block the lock — on iOS/Safari
  // buttons never steal focus from the input (and the unlock dissolve
  // even re-focuses it), so the old focus-only guard made next/prev /
  // selector / AI choices silently fail to lock ("sometimes no lock").
  if (!locked && document.activeElement === textSearch
    && textSearch.value.trim() !== "") return;
  textSearch.value = text;
  if (!locked) {
    lockSearchInput();
    return;
  }
  const line = mirrorLineEl();
  if (line) swapBlock(line, () => buildMirrorWords(line, text));
  else syncClearMirror();
}

const aiQuestion = el("aiQuestion");
const aiAskBtn = el("aiAskBtn");
const aiClearBtn = el("aiClearBtn");
const aiStatus = el("aiStatus");
const aiResults = el("aiResults");

const ayahContext = el("ayahContext");
const contextHeader = el("contextHeader");
const langSelect = el("langSelect");

const tafsirHeader = el("tafsirHeader");
const tafsirSelect = el("tafsirSelect");
const tafsirTitle = el("tafsirTitle");
const tafsirDesc = el("tafsirDesc");
const tafsirBox = el("tafsirBox");
const tafsirMetaAyah = el("tafsirMetaAyah");
const tafsirMetaInterpreter = el("tafsirMetaInterpreter");
const tafsirAyahTag = el("tafsirAyahTag");
const tafsirBasmala = el("tafsirBasmala");
const tafsirSection = el("tafsirSection");
const compareTafsirsBtn = el("compareTafsirsBtn");
const tafsirComparePanel = el("tafsirComparePanel");
const tafsirCompareContent = el("tafsirCompareContent");
const tafsirCompareStatus = el("tafsirCompareStatus");
const tafsirCompareStatusText = el("tafsirCompareStatusText");
const tafsirCompareSpinner = el("tafsirCompareSpinner");
const tafsirCompareScroll = tafsirComparePanel?.querySelector(".compare-scroll");
const compareCloseBtn = el("compareCloseBtn");
const compareStopBtn = el("compareStopBtn");
const compareWritePauseBtn = el("compareWritePauseBtn");

const TAFSIR_DESCRIPTIONS = {
  muyassar: "شرح مبسط ومختصر",
  saadi: "يركّز على المعنى العام بلا إطالة او تعقيد",
  tabari: "ينقل أقوال السلف بالأسانيد ويرجّح بينها",
  ibn_kathir: "يتميز بتفسير القرآن بالقرآن والحديث، واضح ومناسب لعامة القراء",
  qurtubi: "يهتم بالأحكام الفقهية المستنبطة من الآيات، مع العناية باللغة والقراءات",
  baghawi: "يقدّم اقوال السلف بأسلوب مختصر ومنظّم",
  ibn_ashur: "يبرز الجوانب البلاغية والمقاصد العامة، أسلوبه أدبي عميق",
};

const versePanel = el("versePanel");
const toggleVersesBtn = el("toggleVersesBtn");
const prevAyahBtn = el("prevAyahBtn");
const nextAyahBtn = el("nextAyahBtn");
const playAyahBtn = el("playAyahBtn");

const themeToggle = el("themeToggle");
const themeLabel = el("themeLabel");

/* AI accordion (optional) */
const aiToggleBtn = el("aiToggleBtn");
const aiPanel = el("aiPanel");
const aiChevron = el("aiChevron");

/* AI quick prompts (optional) */
const aiQuickBtns = Array.from(document.querySelectorAll("[data-ai-prompt]"));

/* SEO meta */
const pageTitle = el("pageTitle");
const metaDescription = el("metaDescription");
const canonicalLink = el("canonicalLink");
const ogUrl = el("ogUrl");
const ogTitle = el("ogTitle");
const ogDesc = el("ogDesc");
const twTitle = el("twTitle");
const twDesc = el("twDesc");

const DEFAULT_SEO = {
  title: pageTitle?.textContent || document.title || "",
  desc: metaDescription?.getAttribute("content") || "",
  canonical:
    canonicalLink?.getAttribute("href") ||
    new URL(window.location.href).origin + new URL(window.location.href).pathname,
  ogUrl: ogUrl?.getAttribute("content") || "",
  ogTitle: ogTitle?.getAttribute("content") || "",
  ogDesc: ogDesc?.getAttribute("content") || "",
  twTitle: twTitle?.getAttribute("content") || "",
  twDesc: twDesc?.getAttribute("content") || "",
};

/* ---------------- State ---------------- */
const ASSET_VER = "2025-12-31"; // bump when json changes

let INIT_STARTED = false;
let SURAH_META = [];
let QURAN = null;
let INDEX = [];
let CURRENT = null; // {s,a}
let LAST_RESULTS = [];
let VERSES_OPEN = false;
let AI_TYPE_TIMER = null;
let AI_ABORT = null;
let COMPARE_ABORT = null;
let COMPARE_COLLAPSED = false;
let COMPARE_STOPPED = false; // Track if comparison was stopped (for resume)
const COMPARE_CACHE = new Map();
const COMPARE_CACHE_PREFIX = "compare:full:";
const OFFLINE_MESSAGE = "\u0644\u0627 \u064a\u0648\u062c\u062f \u0627\u062a\u0635\u0627\u0644 \u0628\u0627\u0644\u0625\u0646\u062a\u0631\u0646\u062a";
const OFFLINE_COMPARE_MESSAGE = OFFLINE_MESSAGE;
const COMPARE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const TAFSIRS = {
  muyassar: { label: "التفسير الميسّر", shortLabel: "الميسّر" },
  saadi: { label: "تفسير السعدي", shortLabel: "السعدي" },
  tabari: { label: "تفسير الطبري", shortLabel: "الطبري" },
  ibn_kathir: { label: "تفسير ابن كثير", shortLabel: "ابن كثير" },
  qurtubi: { label: "تفسير القرطبي", shortLabel: "القرطبي" },
  baghawi: { label: "تفسير البغوي", shortLabel: "البغوي" },
  ibn_ashur: { label: "تفسير ابن عاشور", shortLabel: "ابن عاشور" },
};
const PRIMARY_TAFSIR = "muyassar";
const SECONDARY_TAFSIRS = ["saadi", "tabari", "ibn_kathir", "qurtubi", "baghawi", "ibn_ashur"];
const TAFSIR_CACHE = new Map();
const TAFSIR_CACHE_PREFIX = "tafsir:";
const TAFSIR_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
let TAFSIR_REQUEST_ID = 0;
let SECONDARY_TAFSIR_ABORT = null; // AbortController for background phase
let EN_MAP = null; // {"s":{"a":"text"}}
const TAFSIR_ENTRY_CACHE = new WeakMap();
let API_WARMED_UP = false; // Track if API has been warmed up

// Compare writing animation state
let COMPARE_WRITE_PAUSED = false;
let COMPARE_WRITE_RESUME_FN = null;

// Audio playback state
let AUDIO_PLAYER = null;
let AUDIO_PLAYING = false;

// Audio playback speed state
const SPEED_OPTIONS = [1, 1.25, 1.5, 2];
let AUDIO_SPEED = 1;
try {
  const savedSpeed = localStorage.getItem('audioSpeed');
  if (savedSpeed && SPEED_OPTIONS.includes(parseFloat(savedSpeed))) AUDIO_SPEED = parseFloat(savedSpeed);
} catch { }

// Listening mode state - continuous playback through surah
let LISTENING_MODE = false;
try {
  LISTENING_MODE = localStorage.getItem('listeningMode') === '1';
} catch { }

/* context window (stable) */
let CONTEXT_STATE = { surah: null, start: 1, end: 0, lang: "ar" };

let LAST_AI_IS_AR = true;
let LAST_AI_QUESTION = "";
let LAST_AI_RETRIEVAL = null;

/* ---------------- UI helpers ---------------- */
/* ---------------- Dark mode (simple) ---------------- */
function setDarkMode(on) {
  document.body.classList.toggle("dark", !!on);
  document.documentElement.classList.toggle("dark", !!on);
  try { localStorage.setItem("darkMode", on ? "1" : "0"); } catch { }
  if (themeToggle) themeToggle.setAttribute("aria-pressed", on ? "true" : "false");
  // Status-label semantics: the visible text names the CURRENT theme, so
  // the button stays in sync with the page on every tap (light → "فاتح",
  // dark → "داكن"). Was previously action-label ("tap to switch to X")
  // which read as one-tap-behind to users. aria-pressed continues to
  // report dark-mode-active as the canonical toggle state for AT.
  if (themeToggle) themeToggle.textContent = on ? "داكن" : "فاتح";
  if (themeLabel) themeLabel.textContent = on ? "داكن" : "فاتح";
  syncNativeStatusBar(on);
}

/* Match the Android status bar to the current theme so the top strip doesn't
 * stay white when the user switches to dark mode. Uses @capacitor/status-bar
 * (installed in the wrapper), accessed via the bridge-injected global.
 * window.Capacitor is injected after scripts evaluate, so the first call from
 * init() may run before the bridge is ready — retry briefly until it lands. */
function syncNativeStatusBar(dark, _attempt = 0) {
  const sb = window.Capacitor?.Plugins?.StatusBar;
  if (!sb) {
    if (_attempt < 10) setTimeout(() => syncNativeStatusBar(dark, _attempt + 1), 100);
    return;
  }
  try {
    sb.setStyle({ style: dark ? "DARK" : "LIGHT" });
    sb.setBackgroundColor?.({ color: dark ? "#181c22" : "#f7fbff" });
  } catch { }
}

/* Query the OS-reported Android status-bar height and set it as a CSS var so
 * the safe-area inset fallback uses a REAL measured value when env() lies
 * (Android 14 WebView quirk: env(safe-area-inset-top) reports 0 even when
 * the WebView is genuinely edge-to-edge under the status bar, causing the
 * 24px CSS floor to undershoot devices with ~30dp status bars like Pixel 8).
 *
 * Three-layer fallback chain in CSS:
 *   max(env(safe-area-inset-top, 0px), var(--m7-statusbar-height, 24px))
 * 1. env() — correct on Android 15+ and iOS.
 * 2. var(--m7-statusbar-height) — set here from StatusBar.getInfo().height,
 *    also from cache by the inline script in index.html for instant first paint.
 * 3. 24px — last-resort absolute floor for the very first launch ever.
 *
 * Same retry pattern as syncNativeStatusBar — the Capacitor bridge is
 * injected AFTER scripts evaluate, so the plugin may not be ready at init. */
function applyStatusBarHeight(_attempt = 0) {
  const sb = window.Capacitor?.Plugins?.StatusBar;
  if (!sb || typeof sb.getInfo !== "function") {
    if (_attempt < 10) setTimeout(() => applyStatusBarHeight(_attempt + 1), 100);
    return;
  }
  sb.getInfo().then((info) => {
    const h = Number(info?.height);
    if (!Number.isFinite(h) || h <= 0) return;
    document.documentElement.style.setProperty("--m7-statusbar-height", `${h}px`);
    try { localStorage.setItem("m7_statusbar_h", String(h)); } catch { }
  }).catch(() => { });
}
function toggleDarkMode() {
  const on = !document.body.classList.contains("dark");
  // ISSUE 3: suppress the search pill's color transitions for the swap —
  // the locked-tint 700ms background/border transition (and the beam's
  // transition:all) would lerp between palettes and read as a glow on the
  // search box. Two rAFs guarantee the recolored frame paints with
  // transitions off; the timeout covers slow first paints.
  const root = document.documentElement;
  root.classList.add("m7-theme-switching");
  setDarkMode(on);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    setTimeout(() => root.classList.remove("m7-theme-switching"), 60);
  }));
}

/* ---------------- Utils ---------------- */
function escapeHtml(str = "") {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatAiInline(text = "") {
  const escaped = escapeHtml(text);
  return escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function stripTitleSpans(text = "") {
  let t = String(text || "");
  const titles = [];
  t = t.replace(
    /<span\b[^>]*\bdata-type\s*=\s*(['"]?)title\1[^>]*>([\s\S]*?)<\/span>/gi,
    (_m, _q, inner) => {
      const cleaned = String(inner || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (cleaned) titles.push(cleaned);
      return " ";
    }
  );
  t = t.replace(/<\/?span\b[^>]*>/gi, " ");
  if (titles.length) {
    const titleLine = `عنوان: ${titles.join(" / ")}`;
    t = `${titleLine}\n${t}`;
  }
  return t;
}

function extractTitleLine(text = "") {
  const t = String(text || "");
  const lines = t.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return { title: "", body: "" };
  if (!/^عنوان:\s*/.test(lines[0])) return { title: "", body: t };
  const title = lines.shift();
  const body = lines.join("\n").trim();
  return { title, body };
}

function cleanAiText(text = "") {
  let t = stripTitleSpans(String(text || ""));
  t = t.replace(/tafsir_differences_(en|ar)/gi, "");
  t = t.replace(/\btafsir_differences\b/gi, "");
  t = t.replace(/\s*[,;،]?\s*\[\s*SRC:[^\]]+\]/gi, " ");
  t = t.replace(/\s*[,;،]?\s*\(\s*SRC:[^)]+\)/gi, " ");
  t = t.replace(/\s*[,;،]?\s*\bSRC:[^\s\]]+/gi, " ");
  if (/"(arabic_answer|english_answer|key_points_ar|key_points_en|citations|tafsir_differences_(ar|en))"/i.test(t)) {
    t = stripJsonArtifacts(t);
  }
  t = t.replace(/\bjson\b"?/gi, "");
  t = t.replace(/[ \t]{2,}/g, " ").trim();
  return t;
}

function trimForCompare(text, maxChars = Number.POSITIVE_INFINITY) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  if (!Number.isFinite(maxChars) || maxChars <= 0) return raw;
  if (raw.length <= maxChars) return raw;
  return raw.slice(0, maxChars).trimEnd();
}

function getCompareCache(ayahKey) {
  if (!ayahKey) return "";
  const now = Date.now();
  const inMemory = COMPARE_CACHE.get(ayahKey);
  if (inMemory && typeof inMemory === "object") {
    if (now - inMemory.t < COMPARE_CACHE_TTL_MS) return inMemory.v || "";
    COMPARE_CACHE.delete(ayahKey);
  }
  const storageKey = COMPARE_CACHE_PREFIX + ayahKey;
  try {
    const cached = localStorage.getItem(storageKey);
    if (!cached) return "";
    let parsed = null;
    try { parsed = JSON.parse(cached); } catch { }
    if (parsed && typeof parsed === "object" && typeof parsed.v === "string" && Number.isFinite(parsed.t)) {
      if (now - parsed.t < COMPARE_CACHE_TTL_MS) {
        COMPARE_CACHE.set(ayahKey, parsed);
        return parsed.v;
      }
      localStorage.removeItem(storageKey);
      return "";
    }
    const clean = cached.trim();
    if (clean) {
      const entry = { t: now, v: clean };
      COMPARE_CACHE.set(ayahKey, entry);
      try { localStorage.setItem(storageKey, JSON.stringify(entry)); } catch { }
      return clean;
    }
  } catch { }
  return "";
}

function setCompareCache(ayahKey, text) {
  const clean = String(text || "").trim();
  if (!ayahKey || !clean) return;
  const entry = { t: Date.now(), v: clean };
  COMPARE_CACHE.set(ayahKey, entry);
  try { localStorage.setItem(COMPARE_CACHE_PREFIX + ayahKey, JSON.stringify(entry)); } catch { }
}

/* ---------------- Tafsir localStorage Cache ---------------- */
function getTafsirCache(cacheKey) {
  if (!cacheKey) return "";
  // Check in-memory first
  if (TAFSIR_CACHE.has(cacheKey)) {
    return TAFSIR_CACHE.get(cacheKey);
  }
  // Check localStorage
  const storageKey = TAFSIR_CACHE_PREFIX + cacheKey;
  try {
    const cached = localStorage.getItem(storageKey);
    if (!cached) return "";
    let parsed = null;
    try { parsed = JSON.parse(cached); } catch { }
    if (parsed && typeof parsed === "object" && typeof parsed.v === "string" && Number.isFinite(parsed.t)) {
      if (Date.now() - parsed.t < TAFSIR_CACHE_TTL_MS) {
        TAFSIR_CACHE.set(cacheKey, parsed.v); // Hydrate in-memory
        return parsed.v;
      }
      localStorage.removeItem(storageKey);
      return "";
    }
    // Legacy: plain string
    const clean = cached.trim();
    if (clean && clean !== "N/A") {
      TAFSIR_CACHE.set(cacheKey, clean);
      return clean;
    }
  } catch { }
  return "";
}

function setTafsirCache(cacheKey, text) {
  const clean = String(text || "").trim();
  if (!cacheKey || !clean || clean === "N/A") return;
  TAFSIR_CACHE.set(cacheKey, clean);
  const entry = { t: Date.now(), v: clean };
  try { localStorage.setItem(TAFSIR_CACHE_PREFIX + cacheKey, JSON.stringify(entry)); } catch { }
}

/* ===========================================================================
 * Offline Tafsir (Android app only)
 *
 * Mirrors the Mushaf/QCF4 offline pattern (src/mushaf.js): on first launch the
 * app downloads the full tafsir text + مختصر التفاسير summaries from GCS into
 * the Cache API, sets a localStorage ready flag, and thereafter reads
 * cache-first so the Tafsir tab works with no internet. The website
 * (isApp() === false) never touches any of this — it keeps using the live API.
 * =========================================================================== */
const TAFSIR_GCS_BASE = "https://storage.googleapis.com/m7mdiyat-tafsir-data";
const TAFSIR_CACHE_NAME = "tafsir-v1";
const TAFSIR_READY_FLAG = "tafsir_ready_v1";
// 7 tafsir books + the pre-generated مختصر التفاسير summaries. en.sahih.json and
// quran.json are intentionally excluded: both are bundled with the app and
// already parsed into EN_MAP / QURAN at startup, so they work offline already.
const TAFSIR_OFFLINE_FILES = [
  "tafseer_muyassar.json", "tafseer_saadi.json", "tafseer_tabari.json",
  "tafseer_ibn_kathir.json", "tafseer_qurtubi.json", "tafseer_baghawi.json",
  "tafseer_ibn_ashur.json", "comparisons.json",
];

/* True ONLY inside the Capacitor Android app. window.Capacitor is injected by
 * the native bridge after the page loads, so this is evaluated at call time
 * (mirrors isApp() in src/mushaf.js). The fallback only covers the brief window
 * before Capacitor is ready: the app is served from https://localhost with NO
 * port, while the dev/preview server uses an explicit port and the real website
 * uses its own domain — so a web user on a phone never triggers the download. */
export function isApp() {
  if (typeof window === "undefined") return false;
  if (window.Capacitor !== undefined) return true;
  return window.location.hostname === "localhost"
    && window.location.port === ""
    && navigator.userAgent.includes("Android");
}

function tafsirIsReady() {
  if (!isApp()) return false;
  try { return localStorage.getItem(TAFSIR_READY_FLAG) === "1"; } catch { return false; }
}

let _tafsirCachePromise = null;
function tafsirAssetCache() {
  if (!_tafsirCachePromise) _tafsirCachePromise = caches.open(TAFSIR_CACHE_NAME);
  return _tafsirCachePromise;
}

/* Cache-first fetch for tafsir assets — on the website a plain fetch(); in the
 * app it checks the Cache API first, falling back to the network and storing
 * the response for next time. */
async function tafsirAssetFetch(url) {
  if (!isApp() || typeof caches === "undefined") return fetch(url);
  const cache = await tafsirAssetCache();
  const hit = await cache.match(url);
  if (hit) return hit;
  const res = await fetch(url);
  if (res.ok) {
    try { await cache.put(url, res.clone()); } catch { }
  }
  return res;
}

/* Download one file and confirm it is actually stored. Returns true ONLY when
 * the body was successfully written to the cache. The previous version counted
 * a file as done on res.ok alone and swallowed cache.put() errors — so when a
 * large file failed to store (quota/eviction) it was silently skipped while the
 * ready flag was still set, leaving the Tafsir tab hanging offline. */
async function cacheTafsirFile(url) {
  try {
    const cache = await tafsirAssetCache();
    const res = await fetch(url, { cache: "reload" });
    if (!res.ok) return false;
    await cache.put(url, res); // throws on quota failure → caught below
    // Confirm the write actually landed (defends against silent eviction).
    return !!(await cache.match(url));
  } catch {
    return false;
  }
}

/* Belt-and-suspenders: which of these urls are NOT currently retrievable. */
async function missingTafsirFiles(urls) {
  const cache = await tafsirAssetCache();
  const missing = [];
  for (const u of urls) {
    try { if (!(await cache.match(u))) missing.push(u); }
    catch { missing.push(u); }
  }
  return missing;
}

/* Lazy per-book reader with a small LRU. The big books are 35/28/20/15 MB, so
 * we never hold more than TAFSIR_BOOK_MAX parsed objects in memory at once. */
const TAFSIR_BOOK_CACHE = new Map(); // key -> parsed { surah: { ayah: text } }
const TAFSIR_BOOK_MAX = 3;
async function loadTafsirBook(key) {
  if (TAFSIR_BOOK_CACHE.has(key)) {
    const v = TAFSIR_BOOK_CACHE.get(key); // LRU bump
    TAFSIR_BOOK_CACHE.delete(key);
    TAFSIR_BOOK_CACHE.set(key, v);
    return v;
  }
  // Wrap the fetch: offline + cache-miss makes tafsirAssetFetch's network
  // fallback reject, and an unhandled rejection here would freeze the Tafsir
  // tab on "جاري التحميل…". Returning null lets the caller show a clean state.
  let data = null;
  try {
    const res = await tafsirAssetFetch(`${TAFSIR_GCS_BASE}/tafseer_${key}.json`);
    if (!res.ok) return null;
    data = await res.json();
  } catch { return null; }
  if (!data) return null;
  TAFSIR_BOOK_CACHE.set(key, data);
  while (TAFSIR_BOOK_CACHE.size > TAFSIR_BOOK_MAX) {
    TAFSIR_BOOK_CACHE.delete(TAFSIR_BOOK_CACHE.keys().next().value);
  }
  return data;
}

async function getOfflineTafsir(surah, ayah, key) {
  const book = await loadTafsirBook(key);
  return book?.[String(surah)]?.[String(ayah)] || null;
}

/* The مختصر التفاسير summaries: one ~20 MB file keyed by "surah:ayah". Parsed
 * once and held (it's the single source for the quick-view + compare panel). */
let COMPARISONS_DATA = null;
async function loadComparisons() {
  if (COMPARISONS_DATA) return COMPARISONS_DATA;
  try {
    const res = await tafsirAssetFetch(`${TAFSIR_GCS_BASE}/comparisons.json`);
    if (!res.ok) return null;
    COMPARISONS_DATA = await res.json();
  } catch { return null; }
  return COMPARISONS_DATA;
}

async function getOfflineComparison(surah, ayah) {
  const data = await loadComparisons();
  return data?.[`${surah}:${ayah}`] || null;
}

/* ---------------- Tafsir offline download (app only, user-initiated) -------
 * Pub/sub: the offline panel subscribes to receive live progress, then renders
 * its row state. Closing the panel doesn't pause the download — the in-flight
 * promise + flag are managed independently of the UI. */

// Same sparkles icon used on the مختصر التفاسير (compare) button.
const TAFSIR_DL_SPARKLE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style="width:20px;height:20px;display:inline-block;vertical-align:-3px;margin-inline-start:6px;"><path fill-rule="evenodd" d="M9 4.5a.75.75 0 01.721.544l.813 2.846a3.75 3.75 0 002.576 2.576l2.846.813a.75.75 0 010 1.442l-2.846.813a3.75 3.75 0 00-2.576 2.576l-.813 2.846a.75.75 0 01-1.442 0l-.813-2.846a3.75 3.75 0 00-2.576-2.576l-2.846-.813a.75.75 0 010-1.442l2.846-.813A3.75 3.75 0 007.466 7.89l.813-2.846A.75.75 0 019 4.5zM18 1.5a.75.75 0 01.728.568l.258 1.036c.236.94.97 1.674 1.91 1.91l1.036.258a.75.75 0 010 1.456l-1.036.258c-.94.236-1.674.97-1.91 1.91l-.258 1.036a.75.75 0 01-1.456 0l-.258-1.036a2.625 2.625 0 00-1.91-1.91l-1.036-.258a.75.75 0 010-1.456l1.036-.258a2.625 2.625 0 001.91-1.91l.258-1.036A.75.75 0 0118 1.5zM16.5 15a.75.75 0 01.712.513l.394 1.183c.15.447.5.799.948.948l1.183.395a.75.75 0 010 1.422l-1.183.395c-.447.15-.799.5-.948.948l-.395 1.183a.75.75 0 01-1.422 0l-.395-1.183a1.5 1.5 0 00-.948-.948l-1.183-.395a.75.75 0 010-1.422l1.183-.395c.447-.15.799-.5.948-.948l.395-1.183A.75.75 0 0116.5 15z" clip-rule="evenodd" /></svg>`;

const TAFSIR_DL_MESSAGES = [
  "جارٍ تجهيز ميزة التفسير",
  "نُجهّز لك كنوز التفسير",
  "جارٍ جمع أقوال المفسّرين",
  `جارٍ تجهيز ميزة "مختصر التفاسير"${TAFSIR_DL_SPARKLE}`,
];
const TAFSIR_DL_FINAL = "جاهز! فسّر بدون إنترنت";

let TAFSIR_STATE = { status: "idle", pct: 0, done: 0, total: 0, message: "" };
const TAFSIR_LISTENERS = new Set();
let TAFSIR_DL_INFLIGHT = null;
let TAFSIR_ONLINE_ARMED = false;

function setTafsirState(patch) {
  TAFSIR_STATE = { ...TAFSIR_STATE, ...patch };
  for (const fn of TAFSIR_LISTENERS) { try { fn(TAFSIR_STATE); } catch { } }
}

export function getTafsirDlState() {
  if (tafsirIsReady()) return { status: "done" };
  return { ...TAFSIR_STATE };
}

export function subscribeTafsirDl(fn) {
  TAFSIR_LISTENERS.add(fn);
  try { fn(getTafsirDlState()); } catch { }
  return () => TAFSIR_LISTENERS.delete(fn);
}

export function isTafsirReady() { return tafsirIsReady(); }
export const TAFSIR_TOTAL_MB = 134;

/* Wipe the tafsir cache + flag so the panel can offer "delete to free space".
 * Also resets the in-memory book LRU + comparisons cache so subsequent reads
 * go to the network and don't return stale parsed data. */
export async function deleteTafsirCache() {
  try { localStorage.removeItem(TAFSIR_READY_FLAG); } catch { }
  try { await caches.delete(TAFSIR_CACHE_NAME); } catch { }
  _tafsirCachePromise = null;
  COMPARISONS_DATA = null;
  TAFSIR_BOOK_CACHE.clear();
  setTafsirState({ status: "idle", pct: 0, done: 0, total: 0, message: "" });
}

/* Download the 8 tafsir files (7 books + comparisons.json) into the Cache API.
 * A file is counted as done only when its body is actually written AND
 * re-readable (cacheTafsirFile) — so quota/eviction failures can't leave a
 * half-cached set behind a "ready" flag. A final verification pass confirms
 * every file is retrievable before the flag is set. */
export async function downloadTafsirAssets() {
  if (TAFSIR_DL_INFLIGHT) return TAFSIR_DL_INFLIGHT;

  if (!navigator.onLine) {
    setTafsirState({ status: "offline", message: OFFLINE_MESSAGE });
    armTafsirOnlineRetry();
    return { ok: false, offline: true };
  }

  TAFSIR_DL_INFLIGHT = (async () => {
    setTafsirState({ status: "downloading", pct: 0, done: 0, total: TAFSIR_OFFLINE_FILES.length, message: TAFSIR_DL_MESSAGES[0] });

    let msgIdx = 0;
    const rotation = setInterval(() => {
      msgIdx = (msgIdx + 1) % TAFSIR_DL_MESSAGES.length;
      setTafsirState({ message: TAFSIR_DL_MESSAGES[msgIdx] });
    }, 2500);

    // Ask for durable storage so the ~134MB cache isn't evicted under pressure.
    try { await navigator.storage?.persist?.(); } catch { }

    const urls = TAFSIR_OFFLINE_FILES.map((f) => `${TAFSIR_GCS_BASE}/${f}`);
    const total = urls.length;
    let done = 0;
    setTafsirState({ done, total, pct: 0 });

    async function downloadBatch(batch, countProgress) {
      const queue = batch.slice();
      const failures = [];
      const CONCURRENCY = 3; // multi-MB bodies; keep peak memory sane on low-end devices
      async function worker() {
        while (queue.length) {
          const url = queue.shift();
          const stored = await cacheTafsirFile(url);
          if (!stored) failures.push(url);
          if (countProgress) {
            done++;
            setTafsirState({ done, total, pct: Math.round((done / total) * 100) });
          }
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      return failures;
    }

    let failures = await downloadBatch(urls, true);
    for (let attempt = 0; attempt < 2 && failures.length; attempt++) {
      failures = await downloadBatch(failures, false);
    }

    // Final guard: only flag ready when every file is actually retrievable.
    const missing = failures.length ? failures : await missingTafsirFiles(urls);
    clearInterval(rotation);

    if (missing.length === 0) {
      try { localStorage.setItem(TAFSIR_READY_FLAG, "1"); } catch { }
      setTafsirState({ status: "done", pct: 100, message: TAFSIR_DL_FINAL });
      return { ok: true };
    }
    try { localStorage.removeItem(TAFSIR_READY_FLAG); } catch { }
    if (!navigator.onLine) {
      setTafsirState({ status: "offline", message: OFFLINE_MESSAGE });
      armTafsirOnlineRetry();
      return { ok: false, offline: true };
    }
    console.warn("[tafsir-offline] not ready — files missing from cache:", missing);
    setTafsirState({ status: "error", message: "تعذّر تحميل بعض الملفات" });
    return { ok: false, missing };
  })().finally(() => { TAFSIR_DL_INFLIGHT = null; });
  return TAFSIR_DL_INFLIGHT;
}

function armTafsirOnlineRetry() {
  if (TAFSIR_ONLINE_ARMED) return;
  TAFSIR_ONLINE_ARMED = true;
  const onOnline = () => {
    window.removeEventListener("online", onOnline);
    TAFSIR_ONLINE_ARMED = false;
    downloadTafsirAssets();
  };
  window.addEventListener("online", onOnline);
}

/* ---------------- API Warm-up ---------------- */
function warmUpAPI() {
  if (API_WARMED_UP) return;
  API_WARMED_UP = true;
  // Fire a lightweight request to warm up the backend connection
  // Uses a common ayah (Al-Fatiha 1:1) to pre-establish connection
  const url = `${API_ROOT}/tafsir`;
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ surah: 1, ayah: 1, tafsirs: ["muyassar"] }),
    keepalive: true,
  }).then(res => {
    if (res.ok) {
      res.json().then(data => {
        if (data.status === "ok" && data.tafsirs?.muyassar) {
          setTafsirCache("1:1:muyassar", data.tafsirs.muyassar);
        }
      }).catch(() => { });
    }
  }).catch(() => { });
}
/* ---------------- Audio Playback ---------------- */
// Reciter configuration - paths must match GCS folder names exactly (lowercase)
const RECITERS = {
  alijaber: { name: 'علي جابر', path: 'alijaber', color: 'alijaber' },
  shuraim: { name: 'سعود الشريم', path: 'shuraim', color: 'shuraim' },
  ayoub: { name: 'محمد أيوب', path: 'ayoub', color: 'ayoub' },
  qasim: { name: 'عبدالمحسن القاسم', path: 'qasim', color: 'qasim' },
  // engineOnly: this reciter ships only as full-surah MP3s + flat-array
  // timings on GCS — no per-ayah files. Single-mode playback must go
  // through the surah engine (continuous: false) instead of the legacy
  // per-ayah URL, which returns 404 for this folder.
  dosari: { name: 'ياسر الدوسري', path: 'dosari', color: 'dosari', engineOnly: true },
  luhaidan: { name: 'محمد اللحيدان', path: 'luhaidan', color: 'luhaidan', engineOnly: true }
};
const RECITER_ORDER = ['alijaber', 'shuraim', 'ayoub', 'qasim', 'dosari', 'luhaidan'];
let CURRENT_RECITER = 'alijaber';

// Per-reciter surah blocklist — some reciters don't have a recording for a
// given surah. Each entry maps a reciter key to the Set of surah numbers for
// which that reciter is disabled (UI greys the chip and the engine falls
// back to another reciter if needed).
const RECITER_RESTRICTED_SURAHS = {};

function isReciterAllowedForSurah(reciterKey, surahNum) {
  if (!reciterKey || !surahNum) return true;
  const blocked = RECITER_RESTRICTED_SURAHS[reciterKey];
  return !blocked || !blocked.has(Number(surahNum));
}

function fallbackReciterForSurah(surahNum) {
  for (const k of RECITER_ORDER) {
    if (isReciterAllowedForSurah(k, surahNum)) return k;
  }
  return RECITER_ORDER[0];
}

function getActiveSurahForRestriction() {
  // Prefer whatever the audio engine is currently playing — that's the
  // surah the user will actually hear.
  if (surahAudio.isActive()) {
    const s = surahAudio.getSurah();
    if (s) return Number(s);
  }
  // In Mushaf mode, follow the mushaf's focused surah.
  try {
    if (isMushafMode()) {
      const s = getMushafTargetSurah();
      if (s) return Number(s);
    }
  } catch { }
  // Tafsir default: the currently-focused ayah's surah.
  return CURRENT?.s ? Number(CURRENT.s) : null;
}

function enforceReciterForSurah(surahNum) {
  if (!surahNum) return;
  if (!isReciterAllowedForSurah(CURRENT_RECITER, surahNum)) {
    switchReciter(fallbackReciterForSurah(surahNum));
  } else {
    // Same reciter, but the chip's disabled state may need to update if
    // the user just navigated into / out of a restricted surah.
    updateReciterUI();
  }
}

// Initialize reciter from localStorage
try {
  const savedReciter = localStorage.getItem('audioReciter');
  if (savedReciter && RECITERS[savedReciter]) CURRENT_RECITER = savedReciter;
} catch { }

const audioPlayIcon = el("audioPlayIcon");
const audioPauseIcon = el("audioPauseIcon");
const audioVolumeSlider = el("audioVolumeSlider");
const audioVolumeDown = el("audioVolumeDown");
const audioVolumeUp = el("audioVolumeUp");

// Initialize volume from localStorage
let AUDIO_VOLUME = 0.8;
try {
  const savedVolume = localStorage.getItem("audioVolume");
  if (savedVolume) AUDIO_VOLUME = parseFloat(savedVolume);
} catch { }
if (audioVolumeSlider) audioVolumeSlider.value = Math.round(AUDIO_VOLUME * 100);

// Prime the engine's _speed / _volume from the saved values so the very
// first play() doesn't snap to defaults (1x / 0.8) before the user touches
// the controls. Both modes also pick up the same starting values.
try { surahAudio.setSpeed(AUDIO_SPEED); } catch { }
try { surahAudio.setVolume(AUDIO_VOLUME); } catch { }
// Initial play-mode sync: push Tafsir's saved LISTENING_MODE to Mushaf so
// both chips start in agreement.
try { syncMushafAudioMode(LISTENING_MODE ? "continuous" : "single"); } catch { }

/**
 * Get audio URL for a specific ayah using current reciter
 * Format: SSS = 3-digit surah (001-114), AAA = 3-digit ayah number
 * Audio is loaded from Google Cloud Storage (AUDIO_BASE constant)
 */
function getAyahAudioUrl(surahNo, ayahNo) {
  const surah = String(surahNo).padStart(3, '0');
  const ayah = String(ayahNo).padStart(3, '0');
  const reciterPath = RECITERS[CURRENT_RECITER]?.path || 'alijaber';
  return `${AUDIO_BASE}${reciterPath}/${surah}/${surah}${ayah}.mp3`;
}

/**
 * Developer safety check: Build audio URL from reciter and filename
 * Example: buildAudioUrl('ayoub', '002/002001.mp3')
 * Returns: https://storage.googleapis.com/recitations-bucket-data/audio/ayoub/002/002001.mp3
 */
export function buildAudioUrl(reciter, filename) {
  return `${AUDIO_BASE}${reciter}/${filename}`;
}

/**
 * Update play/pause icons (desktop and mobile)
 */
function updateAudioIcons(isPlaying) {
  // Tafsir Mushaf-style toolbar play button
  const tafsirPlayBtn = document.getElementById("tafsirPlayBtn");
  if (tafsirPlayBtn) {
    tafsirPlayBtn.setAttribute("data-playing", isPlaying ? "true" : "false");
    tafsirPlayBtn.setAttribute("aria-label", isPlaying ? "إيقاف" : "تشغيل");
  }
  const tafsirPlayIcon = document.getElementById("tafsirPlayIcon");
  const tafsirPauseIcon = document.getElementById("tafsirPauseIcon");
  if (tafsirPlayIcon) tafsirPlayIcon.classList.toggle("hidden", isPlaying);
  if (tafsirPauseIcon) tafsirPauseIcon.classList.toggle("hidden", !isPlaying);
  // Smooth "now playing" highlight on the ayah text
  tafsirAyahTag?.classList.toggle("is-playing", isPlaying);
}


/**
 * Show/hide audio seek slider row
 */
function updateSeekSliderVisibility(isVisible) {
  const audioSeekRow = document.getElementById("audioSeekRow");
  const mobileSeekRow = document.querySelector(".mobile-seek-row");
  if (audioSeekRow) audioSeekRow.classList.toggle("hidden", !isVisible);
  if (mobileSeekRow) mobileSeekRow.classList.toggle("hidden", !isVisible);
}

/**
 * Update seek slider value (called on audio timeupdate)
 */
function activeAudioEl() {
  return AUDIO_PLAYER || surahAudio.getAudio() || null;
}

function updateSeekSlider() {
  const a = activeAudioEl();
  if (!a || a.duration === 0 || isNaN(a.duration)) return;

  const progress = (a.currentTime / a.duration) * 100;
  const audioSeekSlider = document.getElementById("audioSeekSlider");
  const mobileSeekSlider = document.querySelector(".mobile-seek-slider");

  if (audioSeekSlider) audioSeekSlider.value = progress;
  if (mobileSeekSlider) mobileSeekSlider.value = progress;
}

/**
 * Seek audio to a specific position (0-100%)
 */
function seekAudio(percent) {
  const a = activeAudioEl();
  if (!a) return;
  const time = (percent / 100) * a.duration;
  if (!isNaN(time)) {
    a.currentTime = time;
  }
}

/**
 * Skip audio forward or backward by seconds
 */
function skipAudio(seconds) {
  const a = activeAudioEl();
  if (!a) return;
  a.currentTime = Math.max(0, Math.min(a.duration, a.currentTime + seconds));
  updateSeekSlider();
}


/**
 * Set audio volume
 */
function setAudioVolume(volume) {
  AUDIO_VOLUME = Math.max(0, Math.min(1, volume));
  const tafsirVolSlider = document.getElementById("tafsirVolSlider");
  if (tafsirVolSlider) tafsirVolSlider.value = Math.round(AUDIO_VOLUME * 100);
  if (AUDIO_PLAYER) AUDIO_PLAYER.volume = AUDIO_VOLUME;
  surahAudio.setVolume(AUDIO_VOLUME);
  // Push to Mushaf side so its slider stays in sync.
  syncMushafVolume(AUDIO_VOLUME);
  try { localStorage.setItem("audioVolume", String(AUDIO_VOLUME)); } catch { }
}

/**
 * Set audio playback speed and update UI
 */
function setAudioSpeed(speed) {
  AUDIO_SPEED = speed;
  if (AUDIO_PLAYER) AUDIO_PLAYER.playbackRate = AUDIO_SPEED;
  surahAudio.setSpeed(AUDIO_SPEED);
  // Push to Mushaf side so its slider/button stay in sync.
  syncMushafSpeed(AUDIO_SPEED);
  try { localStorage.setItem('audioSpeed', String(AUDIO_SPEED)); } catch { }
  updateSpeedUI();
}

/**
 * Cycle through playback speed options: 1x → 1.25x → 1.5x → 2x → 1x
 */
function cycleAudioSpeed() {
  const idx = SPEED_OPTIONS.indexOf(AUDIO_SPEED);
  const nextIdx = (idx + 1) % SPEED_OPTIONS.length;
  setAudioSpeed(SPEED_OPTIONS[nextIdx]);
}

/**
 * Update speed button labels across desktop and mobile
 */
function updateSpeedUI() {
  const speedBtn = document.getElementById('tafsirSpeedBtn');
  if (speedBtn) speedBtn.textContent = `${AUDIO_SPEED}x`;
  const speedSlider = document.getElementById('tafsirSpeedSlider');
  if (speedSlider) speedSlider.value = String(AUDIO_SPEED);
}

/**
 * Fade out audio volume over duration (ms), then fully stop
 */
function fadeOutAndStopAudio(duration = 600) {
  if (!AUDIO_PLAYING) return;
  const player = AUDIO_PLAYER || surahAudio.getAudio();
  if (!player) return;
  const startVol = player.volume;
  const steps = 20;
  const stepTime = duration / steps;
  let step = 0;
  const fade = setInterval(() => {
    step++;
    player.volume = Math.max(0, startVol * (1 - step / steps));
    if (step >= steps) {
      clearInterval(fade);
      stopAudio();
      // Restore volume setting for next playback
      if (AUDIO_PLAYER) AUDIO_PLAYER.volume = AUDIO_VOLUME;
    }
  }, stepTime);
}

/**
 * Stop any currently playing audio
 */
function stopAudio() {
  if (AUDIO_PLAYER) {
    AUDIO_PLAYER.pause();
    AUDIO_PLAYER.currentTime = 0;
    AUDIO_PLAYER = null;
  }
  if (surahAudio.isActive()) surahAudio.stop();
  AUDIO_PLAYING = false;
  playAyahBtn?.classList.remove("playing");
  // Also remove playing class from mobile button
  document.querySelector(".mobile-audio-btn")?.classList.remove("playing");
  updateAudioIcons(false);
  updateSeekSliderVisibility(false);
  // Clear any active repeat loop so the next playback starts fresh.
  repeatReset();
}

/**
 * Quietly tear down ONLY the Tafsir-side per-ayah <audio> element. Does
 * NOT touch the surahAudio engine or any UI other than the Tafsir play
 * button state. Exposed to the Mushaf module via DEPS so its play paths
 * can enforce the single-source invariant without clobbering the engine.
 */
function stopTafsirPerAyahAudio() {
  if (!AUDIO_PLAYER) return;
  try { AUDIO_PLAYER.pause(); } catch { }
  AUDIO_PLAYER = null;
  AUDIO_PLAYING = false;
  setAudioActiveUI(false);
}

/**
 * RIGID INVARIANT: at most one audio source ever plays at a time
 * (surahAudio engine, Tafsir per-ayah <audio>, Mushaf per-ayah <audio>).
 *
 * This helper kills both per-ayah <audio> elements without touching the
 * surahAudio engine — callers that want to start the engine let
 * surahAudio.play() do its own internal teardown (which preserves the
 * existing callback bundle bound to whichever view currently owns the
 * engine). Callers that want to wipe everything follow this with an
 * explicit surahAudio.stop().
 */
function silenceForeignPerAyah() {
  if (AUDIO_PLAYER) {
    try { AUDIO_PLAYER.pause(); } catch { }
    AUDIO_PLAYER = null;
  }
  AUDIO_PLAYING = false;
  setAudioActiveUI(false);
  stopMushafPerAyahAudio();
}

/**
 * Snapshot the currently playing audio (source + ayah) BEFORE any state
 * change. Used by switchReciter so we can resume at the same ayah with
 * the new reciter. Returns null if nothing is loaded.
 */
function captureAudioPosition() {
  if (surahAudio.isActive()) {
    return {
      source: "engine",
      surah: surahAudio.getSurah(),
      ayah: surahAudio.getActiveAyah(),
      playing: surahAudio.isPlaying(),
    };
  }
  if (AUDIO_PLAYER && CURRENT) {
    return {
      source: "perAyah",
      surah: CURRENT.s,
      ayah: CURRENT.a,
      playing: !AUDIO_PLAYER.paused,
    };
  }
  const m = getMushafPerAyahPosition();
  if (m) return { source: "perAyah", ...m };
  return null;
}

/**
 * Restart per-ayah playback at the captured ayah, routed through the
 * currently-visible mode's path so UI feedback matches the user's view.
 * Engine resumes are handled inline by switchReciter (cold reload).
 */
function resumePerAyahAtPosition(pos) {
  if (!pos) return;
  if (isMushafMode()) {
    playMushafAyahAtKey(pos.surah, pos.ayah);
    return;
  }
  if (!CURRENT || CURRENT.s !== pos.surah || CURRENT.a !== pos.ayah) {
    setPrimaryAyah(pos.surah, pos.ayah, { scroll: false, animate: false, skipAudioStop: true });
  }
  playCurrentAyah();
}

/**
 * Set listening mode (continuous playback through surah)
 */
function setListeningMode(enabled) {
  const wasEnabled = LISTENING_MODE;
  LISTENING_MODE = enabled;
  try { localStorage.setItem('listeningMode', enabled ? '1' : '0'); } catch { }
  updateListeningModeUI();
  // Push the same mode to Mushaf so both chips stay in sync.
  syncMushafAudioMode(enabled ? "continuous" : "single");

  // Mid-play mode flip: keep the engine running so the current ayah finishes
  // naturally. The engine's tick honours _continuous = false by stopping when
  // currentTime crosses the active ayah's end.
  if (surahAudio.isActive()) {
    surahAudio.setContinuous(enabled);
    return;
  }
  // continuous switched on while a single-ayah Audio element is mid-play →
  // hand off to the engine at the current ayah.
  if (!wasEnabled && enabled && AUDIO_PLAYING && CURRENT) {
    if (AUDIO_PLAYER) { try { AUDIO_PLAYER.pause(); } catch { } AUDIO_PLAYER = null; }
    startSurahEngineForCurrent();
  }
}

/**
 * Update listening mode UI (reflected in the Tafsir settings panel pills)
 */
function updateListeningModeUI() {
  syncTafsirSettingsUI();
}

/**
 * Reflect engine play/pause/stop on the Tafsir-tab audio UI without
 * disturbing the per-ayah Audio path's bookkeeping.
 */
function setAudioActiveUI(active) {
  AUDIO_PLAYING = !!active;
  playAyahBtn?.classList.toggle("playing", AUDIO_PLAYING);
  document.querySelector(".mobile-audio-btn")?.classList.toggle("playing", AUDIO_PLAYING);
  updateAudioIcons(AUDIO_PLAYING);
  updateSeekSliderVisibility(AUDIO_PLAYING);
}

/**
 * Engine callback bundle for the Tafsir tab. Exported so the Mushaf module
 * can re-bind these when handing the live engine BACK from Mushaf→Tafsir
 * without stopping audio.
 */
function tafsirEngineCallbacks() {
  return {
    onPlay: () => {
      setAudioActiveUI(true);
      hideTafsirAudioOffline();
      const a = surahAudio.getAudio();
      if (a && !a._mdTimeBound) {
        a.addEventListener("timeupdate", updateSeekSlider);
        a._mdTimeBound = true;
      }
    },
    onPause: () => setAudioActiveUI(false),
    onAyahChange: (ayah, surah) => {
      if (!CURRENT || CURRENT.s !== surah || CURRENT.a !== ayah) {
        // skipAudioStop:true keeps the engine alive AND routes this through
        // setPrimaryAyah's light path: continuous-playback auto-advance
        // updates the tafsir content with the inner tafsir-swap only —
        // cycling the whole panel (close→reopen) every few seconds while
        // the user follows along with the recitation would be hostile.
        // Manual prev/next clicks get the full Task-3 panel cycle.
        setPrimaryAyah(surah, ayah, { scroll: false, skipAudioStop: true });
      }
    },
    onEnded: () => {
      // End-of-surah (continuous) OR end-of-ayah (single, when LISTENING_MODE
      // was flipped off mid-play). Either way, exit listening mode.
      if (LISTENING_MODE) {
        LISTENING_MODE = false;
        try { localStorage.setItem('listeningMode', '0'); } catch { }
        updateListeningModeUI();
      }
      stopAudio();
    },
    onStop: () => setAudioActiveUI(false),
    onError: (err) => {
      console.error("Surah-audio engine error:", err);
      stopAudio();
      showTafsirAudioOffline();
    },
  };
}

/**
 * Start (or seek within) the continuous-surah engine at CURRENT.
 * Used by listening-mode playback in Tafsir view.
 */
function startSurahEngineForCurrent() {
  if (!CURRENT) return;
  // RIGID: kill any stale per-ayah <audio> from EITHER mode before the
  // engine starts. surahAudio.play() destroys its own previous element.
  if (AUDIO_PLAYER) { try { AUDIO_PLAYER.pause(); } catch { } AUDIO_PLAYER = null; }
  stopMushafPerAyahAudio();
  surahAudio.play({
    surah: CURRENT.s,
    ayah: CURRENT.a,
    reciter: CURRENT_RECITER,
    continuous: LISTENING_MODE,
    volume: AUDIO_VOLUME,
    speed: AUDIO_SPEED,
    callbacks: tafsirEngineCallbacks(),
  }).catch((err) => {
    console.error("Surah-audio engine play failed:", err);
    stopAudio();
    showTafsirAudioOffline();
  });
}

/**
 * Re-bind the live engine to the Tafsir tab's UI handlers and sync the
 * tafsir view to the engine's current state. Called by setAppMode when
 * handing playback Mushaf→Tafsir without stopping audio.
 */
function resumeTafsirFromEngine() {
  const s = surahAudio.getSurah();
  const a = surahAudio.getActiveAyah();
  if (!s || !a) return;
  // Sync Tafsir-side state to whatever the engine is actually playing.
  // The Mushaf side may have adjusted speed / volume / reciter while it
  // owned the engine; the Tafsir UI must reflect that exactly.
  AUDIO_SPEED = surahAudio.getSpeed();
  AUDIO_VOLUME = surahAudio.getVolume();
  const engineReciter = surahAudio.getReciter();
  if (engineReciter && RECITERS[engineReciter] && engineReciter !== CURRENT_RECITER) {
    CURRENT_RECITER = engineReciter;
    try { localStorage.setItem('audioReciter', CURRENT_RECITER); } catch { }
    updateReciterUI();
  }
  updateSpeedUI();
  const tafsirVolSlider = document.getElementById("tafsirVolSlider");
  if (tafsirVolSlider) tafsirVolSlider.value = Math.round(AUDIO_VOLUME * 100);
  if (audioVolumeSlider) audioVolumeSlider.value = Math.round(AUDIO_VOLUME * 100);

  // Sync LISTENING_MODE to whatever the engine is actually doing — usually
  // continuous, but if Mushaf kicked off single-mode engine playback we
  // mirror that.
  const wantListening = !!surahAudio.getContinuous();
  if (LISTENING_MODE !== wantListening) {
    LISTENING_MODE = wantListening;
    try { localStorage.setItem('listeningMode', wantListening ? '1' : '0'); } catch { }
    updateListeningModeUI();
  }
  // Make sure the per-ayah Audio (if any was around) is killed.
  if (AUDIO_PLAYER) { try { AUDIO_PLAYER.pause(); } catch { } AUDIO_PLAYER = null; }
  surahAudio.setCallbacks(tafsirEngineCallbacks());
  // panelReveal:"defer" — this only runs inside setAppMode's Mushaf→Tafsir
  // choreography, which stages the panel closed and plays the reveal itself.
  setPrimaryAyah(s, a, { scroll: false, animate: false, skipAudioStop: true, panelReveal: "defer" });
  setAudioActiveUI(surahAudio.isPlaying());
  hideTafsirAudioOffline();
}

/**
 * Play audio for the current ayah.
 * - Continuous (listening) mode → full-surah engine + timing-driven
 *   ayah advance (no inter-ayah gap).
 * - Single mode → existing per-ayah MP3 (fast first-play).
 */
function playCurrentAyah() {
  if (!CURRENT) return;

  // Engine running → pause/resume (preserve loaded MP3 + position).
  if (surahAudio.isActive() && surahAudio.getSurah() === CURRENT.s && surahAudio.getReciter() === CURRENT_RECITER) {
    if (surahAudio.isPlaying()) { surahAudio.pause(); return; }
    surahAudio.resume();
    return;
  }

  // Per-ayah Audio playing → toggle off (existing single-mode behavior).
  if (AUDIO_PLAYING) {
    stopAudio();
    return;
  }

  // Listening (continuous) mode — full-surah engine.
  // engineOnly reciters (e.g. dosari) have no per-ayah files, so single
  // mode also routes through the engine; the engine honours continuous:
  // false by stopping at end-of-ayah.
  if (LISTENING_MODE || RECITERS[CURRENT_RECITER]?.engineOnly) {
    startSurahEngineForCurrent();
    return;
  }

  // RIGID: about to spawn a NEW tafsir-side <audio>. Kill any background
  // Mushaf-per-ayah stream still alive from before a mode toggle —
  // without this, both reciters play at once.
  stopMushafPerAyahAudio();

  const url = getAyahAudioUrl(CURRENT.s, CURRENT.a);
  const ayahKey = `${CURRENT.s}:${CURRENT.a}`;
  const nextAudio = new Audio(url);
  nextAudio.volume = AUDIO_VOLUME;
  nextAudio.playbackRate = AUDIO_SPEED;
  AUDIO_PLAYER = nextAudio;
  // Seed the repeat counter for this ayah (1× = no replays, 3×/5×/∞ = loop).
  repeatStart(ayahKey);

  // Guard every listener and the play().catch against AUDIO_PLAYER having
  // been swapped to a NEW Audio element while this one was still loading —
  // otherwise the stale element's AbortError, ended, or error events would
  // tear down the live playback.
  nextAudio.addEventListener("play", () => {
    if (AUDIO_PLAYER !== nextAudio) return;
    AUDIO_PLAYING = true;
    playAyahBtn?.classList.add("playing");
    mobileAudioBtn?.classList.add("playing");
    updateAudioIcons(true);
    updateSeekSliderVisibility(true);
    hideTafsirAudioOffline();
  });
  nextAudio.addEventListener("timeupdate", () => {
    if (AUDIO_PLAYER !== nextAudio) return;
    updateSeekSlider();
  });
  nextAudio.addEventListener("ended", () => {
    if (AUDIO_PLAYER !== nextAudio) return;
    // Repeat hook: if the loop still has plays left, restart in place.
    if (repeatConsume(ayahKey)) {
      try {
        nextAudio.currentTime = 0;
        const p = nextAudio.play();
        if (p && typeof p.catch === "function") p.catch(() => { });
      } catch { }
      return;
    }
    stopAudio();
  });
  nextAudio.addEventListener("error", (e) => {
    if (AUDIO_PLAYER !== nextAudio) return;
    console.error("Audio error:", url, e);
    stopAudio();
    showTafsirAudioOffline();
  });
  nextAudio.play().catch((err) => {
    if (AUDIO_PLAYER !== nextAudio) return; // superseded
    console.error("Audio play failed:", err);
    stopAudio();
    showTafsirAudioOffline();
  });
}

// App-only: recitations stream from GCS (never cached), so playback needs a
// connection. Surface "الاستماع غير متاح بدون إنترنت" at the top of the Tafsir
// tab when a play attempt fails (offline). navigator.onLine is unreliable in the
// WebView, so this is driven by the actual playback error.
const OFFLINE_AUDIO_MESSAGE = "الاستماع غير متاح بدون إنترنت";
let _tafsirAudioMsgTimer = null;
function showTafsirAudioOffline() {
  if (!isApp()) return;
  const el = document.getElementById("tafsirAudioMsg");
  if (!el) return;
  el.textContent = OFFLINE_AUDIO_MESSAGE;
  el.hidden = false;
  clearTimeout(_tafsirAudioMsgTimer);
  _tafsirAudioMsgTimer = setTimeout(() => { el.hidden = true; }, 4000);
}
function hideTafsirAudioOffline() {
  const el = document.getElementById("tafsirAudioMsg");
  if (el) el.hidden = true;
  clearTimeout(_tafsirAudioMsgTimer);
}

// Mobile audio button and volume controls
const mobileAudioBtn = document.querySelector(".mobile-audio-btn");
const mobileVolSlider = document.querySelector(".mobile-vol-slider");
const mobileVolDown = document.querySelector(".mobile-vol-down");
const mobileVolUp = document.querySelector(".mobile-vol-up");

// Sync mobile volume slider with saved value
if (mobileVolSlider) mobileVolSlider.value = Math.round(AUDIO_VOLUME * 100);

// Mobile audio button click
mobileAudioBtn?.addEventListener("click", playCurrentAyah);

// Volume control event listeners (Desktop)
audioVolumeSlider?.addEventListener("input", (e) => {
  setAudioVolume(parseInt(e.target.value, 10) / 100);
  if (mobileVolSlider) mobileVolSlider.value = e.target.value;
});

audioVolumeDown?.addEventListener("click", () => {
  setAudioVolume(AUDIO_VOLUME - 0.1);
});

audioVolumeUp?.addEventListener("click", () => {
  setAudioVolume(AUDIO_VOLUME + 0.1);
});

// Volume control event listeners (Mobile)
mobileVolSlider?.addEventListener("input", (e) => {
  setAudioVolume(parseInt(e.target.value, 10) / 100);
  if (audioVolumeSlider) audioVolumeSlider.value = e.target.value;
});

mobileVolDown?.addEventListener("click", () => {
  setAudioVolume(AUDIO_VOLUME - 0.1);
});

mobileVolUp?.addEventListener("click", () => {
  setAudioVolume(AUDIO_VOLUME + 0.1);
});

// Seek slider and skip button event listeners
const audioSeekSlider = document.getElementById("audioSeekSlider");
const mobileSeekSlider = document.querySelector(".mobile-seek-slider");
const audioSeekBack = document.getElementById("audioSeekBack");
const audioSeekForward = document.getElementById("audioSeekForward");
const mobileSeekBack = document.querySelector(".mobile-seek-back");
const mobileSeekForward = document.querySelector(".mobile-seek-forward");

// Seek slider input handlers
audioSeekSlider?.addEventListener("input", (e) => {
  seekAudio(parseInt(e.target.value, 10));
  if (mobileSeekSlider) mobileSeekSlider.value = e.target.value;
});

mobileSeekSlider?.addEventListener("input", (e) => {
  seekAudio(parseInt(e.target.value, 10));
  if (audioSeekSlider) audioSeekSlider.value = e.target.value;
});

// Skip button handlers (5 seconds forward/backward)
audioSeekBack?.addEventListener("click", () => skipAudio(-5));
audioSeekForward?.addEventListener("click", () => skipAudio(5));
mobileSeekBack?.addEventListener("click", () => skipAudio(-5));
mobileSeekForward?.addEventListener("click", () => skipAudio(5));

/* ---------------- Reciter Switching ---------------- */
/**
 * Switch to a specific reciter
 */
function switchReciter(newReciter) {
  if (!RECITERS[newReciter]) return;
  if (newReciter === CURRENT_RECITER) return;
  // Honor per-surah restrictions (reciters with no recording for a surah).
  if (!isReciterAllowedForSurah(newReciter, getActiveSurahForRestriction())) return;

  // Snapshot what's currently playing BEFORE any state changes. The
  // position drives the restart so the user lands at the same ayah with
  // the new reciter, regardless of which mode they're viewing.
  const pos = captureAudioPosition();

  CURRENT_RECITER = newReciter;
  try { localStorage.setItem('audioReciter', CURRENT_RECITER); } catch { }
  updateReciterUI();

  // RIGID: kill both per-ayah <audio> elements. Engine, if alive, is
  // left untouched for the cold-reload below — preserving the engine's
  // callback bundle (bound to whichever view currently owns it). Without
  // killing the per-ayah elements, a Mushaf-started single-mode stream
  // can keep playing in the background after the user swaps views,
  // layering a second reciter on top of any new stream we start.
  silenceForeignPerAyah();

  if (!pos || !pos.playing) {
    // Nothing actively playing. Also drop a paused engine so a stale
    // old-reciter element doesn't hang around.
    if (surahAudio.isActive()) surahAudio.stop();
    return;
  }

  if (pos.source === "engine") {
    // Engine hot swap: cold reload at the captured ayah with the new
    // reciter. surahAudio.play() destroys its old audio internally and
    // keeps _callbacks (we don't pass any), so whichever view currently
    // owns the engine keeps receiving onPlay / onAyahChange / onEnded.
    surahAudio.play({
      surah: pos.surah,
      ayah: pos.ayah,
      reciter: newReciter,
    }).catch((err) => {
      console.error("Reciter swap (engine) failed:", err);
      stopAudio();
      showTafsirAudioOffline();
    });
    return;
  }

  // Per-ayah single mode. Restart at the captured ayah via the
  // currently-visible mode's path — so UI feedback (highlight, play
  // button state, dropdown) matches what the user is looking at.
  resumePerAyahAtPosition(pos);
}


/**
 * Update reciter UI elements (color themes + settings panel pills)
 */
function updateReciterUI() {
  const reciter = RECITERS[CURRENT_RECITER];
  if (!reciter) return;

  // Update color classes on audio wrappers
  document.querySelectorAll('.audio-player-wrapper').forEach(wrapper => {
    RECITER_ORDER.forEach(r => wrapper.classList.remove(`reciter-${r}`));
    wrapper.classList.add(`reciter-${reciter.color}`);
  });

  // Update slider thumb colors
  document.querySelectorAll('.audio-slider').forEach(slider => {
    RECITER_ORDER.forEach(r => slider.classList.remove(`reciter-${r}`));
    slider.classList.add(`reciter-${reciter.color}`);
  });

  syncTafsirSettingsUI();
}

// Dropdown play button event listeners
document.querySelectorAll('.dropdown-play-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    playCurrentAyah();
  });
});

/* ---------------- Tafsir audio settings panel (cog) ---------------- */
/** Populate the reciter pill rows (desktop + mobile) — matches Mushaf order. */
function buildTafsirReciterChips() {
  document.querySelectorAll('[data-tafsir-settings="reciter"]').forEach(row => {
    row.innerHTML = RECITER_ORDER.map(key => {
      const r = RECITERS[key];
      return `<button type="button" class="mushaf-settings__chip" data-val="${key}">${r.name}</button>`;
    }).join('');
  });
}

/** Reflect current reciter + playback mode in the settings panel pills. */
function syncTafsirSettingsUI() {
  const activeSurah = getActiveSurahForRestriction();
  document.querySelectorAll('[data-tafsir-settings="reciter"] .mushaf-settings__chip').forEach(c => {
    c.setAttribute('aria-checked', c.dataset.val === CURRENT_RECITER ? 'true' : 'false');
    const allowed = isReciterAllowedForSurah(c.dataset.val, activeSurah);
    c.disabled = !allowed;
    c.classList.toggle('mushaf-settings__chip--disabled', !allowed);
    if (!allowed) c.title = 'غير متوفر لهذه السورة';
    else c.removeAttribute('title');
  });
  const mode = LISTENING_MODE ? 'continuous' : 'single';
  document.querySelectorAll('[data-tafsir-settings="audio-mode"] .mushaf-settings__chip').forEach(c => {
    c.setAttribute('aria-checked', c.dataset.val === mode ? 'true' : 'false');
  });
  // Repeat row: reflect the saved preference. Also hide the entire
  // section whenever audio-mode is "continuous" — repeat-ayah only makes
  // sense when playing one ayah at a time.
  const pref = getRepeatPref();
  const prefVal = pref === Infinity ? 'inf' : String(pref);
  document.querySelectorAll('[data-tafsir-settings="repeat"] .mushaf-settings__chip').forEach(c => {
    c.setAttribute('aria-checked', c.dataset.val === prefVal ? 'true' : 'false');
  });
  document.querySelectorAll('[data-repeat-section]').forEach((s) => {
    s.style.display = LISTENING_MODE ? 'none' : '';
  });
  updateRepeatBadgeUI();
}

/** Show a subtle ∞ badge on the play button only when BOTH conditions hold:
 *   (1) repeat preference is ∞
 *   (2) audio-mode is single (the repeat-ayah loop doesn't apply in
 *       continuous mode, so the badge is meaningless there).
 * Without the second check, the badge would stay lit after the user flipped
 * to "تشغيل متواصل" — even though no loop will ever fire. */
function updateRepeatBadgeUI() {
  const pref = getRepeatPref();
  const show = pref === Infinity && !LISTENING_MODE;
  const tafsirPlayBtn = document.getElementById('tafsirPlayBtn');
  if (tafsirPlayBtn) tafsirPlayBtn.classList.toggle('mushaf-toolbar__btn--repeat-inf', show);
  const mushafPlayBtn = document.getElementById('mushafToolbarPlay');
  if (mushafPlayBtn) mushafPlayBtn.classList.toggle('mushaf-toolbar__btn--repeat-inf', show);
}

// Chip clicks: reciter + playback mode (both drive the existing audio engine)
document.querySelectorAll('[data-tafsir-settings-dropdown]').forEach(dd => {
  dd.addEventListener('click', (e) => {
    const chip = e.target.closest('.mushaf-settings__chip');
    if (!chip) return;
    const group = chip.closest('[data-tafsir-settings]')?.dataset.tafsirSettings;
    if (group === 'reciter') switchReciter(chip.dataset.val);
    else if (group === 'audio-mode') setListeningMode(chip.dataset.val === 'continuous');
    else if (group === 'repeat') {
      const v = chip.dataset.val;
      setRepeatPref(v === 'inf' ? Infinity : Number(v));
    }
    syncTafsirSettingsUI();
  });
});

// Cross-mode chip sync: when the user changes repeat preference anywhere
// (Mushaf chip row, Tafsir chip row), refresh both UIs so they agree.
subscribeRepeat(() => { syncTafsirSettingsUI(); });

// Cog open/close — mirrors the Tadabbur (Mushaf) settings pattern in
// src/mushaf.js's wireToolbar so behavior is identical across modes AND
// across input types:
//   - desktop mouse: mouseenter opens, mouseleave closes after a 350ms grace
//     period (lets the cursor cross from button to dropdown without flicker)
//   - touch: the synthetic mouseenter on tap + the explicit click toggle keep
//     the same open/close mechanics working without true hover
//   - any input: outside-click closes (handles the case where the cursor
//     never leaves via the wrap because it jumps to another element)
// This fixes the previous Tafsir-only bug where the panel stuck open after a
// click and then visually overlapped the adjacent play button.
// Mutual exclusion between the two Tafsir toolbar dropdowns (settings cog +
// play volume/speed). Whenever one opens it closes the other so they can
// never overlap. Reverse direction is wired in the play-volume open paths
// further below.
function _closeTafsirVolDropdown() {
  document.getElementById('tafsirVolDropdown')
    ?.classList.remove('mushaf-toolbar__dropdown--open');
}
document.querySelectorAll('[data-tafsir-settings-wrap]').forEach(wrap => {
  const btn = wrap.querySelector('[data-tafsir-settings-btn]');
  const dd = wrap.querySelector('[data-tafsir-settings-dropdown]');
  if (!btn || !dd) return;
  let hideT = null;
  wrap.addEventListener('mouseenter', () => {
    clearTimeout(hideT);
    dd.classList.add('mushaf-toolbar__dropdown--open');
    _closeTafsirVolDropdown();
    syncTafsirSettingsUI();
  });
  wrap.addEventListener('mouseleave', () => {
    clearTimeout(hideT);
    hideT = setTimeout(() => dd.classList.remove('mushaf-toolbar__dropdown--open'), 350);
  });
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (dd.classList.toggle('mushaf-toolbar__dropdown--open')) {
      _closeTafsirVolDropdown();
      syncTafsirSettingsUI();
    }
  });
});
document.addEventListener('click', (e) => {
  document.querySelectorAll('[data-tafsir-settings-wrap]').forEach(wrap => {
    if (!wrap.contains(e.target)) {
      wrap.querySelector('[data-tafsir-settings-dropdown]')?.classList.remove('mushaf-toolbar__dropdown--open');
    }
  });
});

/**
 * Touch-only long-press: holding a play button for ~500ms opens the
 * associated volume/speed dropdown. The synthetic click that fires when
 * the user releases is swallowed in capture phase so the long-press
 * doesn't also start/stop playback. Mouse pointers are ignored —
 * desktop already has hover.
 */
function attachLongPressDropdown(btn, dd, onOpen) {
  if (!btn || !dd) return;
  const LONG_PRESS_MS = 500;
  const MOVE_THRESHOLD_PX = 14;
  let timer = null;
  let fired = false;
  let startX = 0, startY = 0;
  let activePointerId = null;

  const cancel = () => {
    if (timer != null) { clearTimeout(timer); timer = null; }
    activePointerId = null;
  };

  btn.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return; // hover covers desktop
    fired = false;
    startX = e.clientX; startY = e.clientY;
    cancel();
    activePointerId = e.pointerId;
    timer = setTimeout(() => {
      timer = null;
      if (activePointerId !== e.pointerId) return;
      fired = true;
      // Toggle: a second hold on an already-open panel closes it. Only the
      // open transition fires the optional onOpen hook (used to close sibling
      // dropdowns for mutual exclusion) — a hold-to-close mustn't trigger it.
      const opened = dd.classList.toggle('mushaf-toolbar__dropdown--open');
      if (opened && typeof onOpen === 'function') { try { onOpen(); } catch { } }
      if (navigator.vibrate) { try { navigator.vibrate(15); } catch { } }
    }, LONG_PRESS_MS);
  });

  btn.addEventListener('pointermove', (e) => {
    if (timer == null || e.pointerId !== activePointerId) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (dx * dx + dy * dy > MOVE_THRESHOLD_PX * MOVE_THRESHOLD_PX) cancel();
  });
  btn.addEventListener('pointerup', cancel);
  btn.addEventListener('pointercancel', cancel);
  // Note: deliberately NOT cancelling on pointerleave — some WebViews
  // synthesize pointerleave mid-touch when the finger drifts slightly off
  // the button's box, which would kill the long-press just before it fires.

  // Capture phase so we beat the bubble-phase play-toggle listener.
  btn.addEventListener('click', (e) => {
    if (!fired) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    fired = false;
  }, true);
}

/* ---------------- Tafsir play button + volume/speed dropdown ---------------- */
(function wireTafsirPlayToolbar() {
  const playWrap = document.getElementById('tafsirPlayWrap');
  const playBtn = document.getElementById('tafsirPlayBtn');
  const volDD = document.getElementById('tafsirVolDropdown');
  const volSlider = document.getElementById('tafsirVolSlider');
  const volDown = document.getElementById('tafsirVolDown');
  const volUp = document.getElementById('tafsirVolUp');
  const speedBtn = document.getElementById('tafsirSpeedBtn');
  const speedSlider = document.getElementById('tafsirSpeedSlider');

  // Play/stop the current ayah
  playBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    playCurrentAyah();
  });

  // Volume/speed dropdown: open on hover ONLY while audio is actually playing
  // (otherwise hovering the play button to start playback would pop the
  // dropdown over the ayah text). Match the Mushaf side's gate.
  //
  // Use pointerenter/pointerleave filtered to mouse pointers so touch never
  // triggers the auto-hide path — otherwise the synthesized mouseleave after
  // a touch release would close the dropdown opened by the long-press.
  // Mutual exclusion the other direction: closing any open Tafsir settings
  // dropdown when the play volume/speed dropdown opens. Both open-paths
  // (mouse hover + touch long-press) call this so the two panels can never
  // overlap, regardless of input type.
  const closeTafsirSettingsDropdown = () => {
    document.querySelectorAll(
      '[data-tafsir-settings-dropdown].mushaf-toolbar__dropdown--open'
    ).forEach(d => d.classList.remove('mushaf-toolbar__dropdown--open'));
  };
  if (playWrap && volDD) {
    let hideT = null;
    playWrap.addEventListener('pointerenter', (e) => {
      if (e.pointerType !== 'mouse') return;
      if (!AUDIO_PLAYING && !surahAudio.isActive()) return;
      clearTimeout(hideT);
      volDD.classList.add('mushaf-toolbar__dropdown--open');
      closeTafsirSettingsDropdown();
    });
    playWrap.addEventListener('pointerleave', (e) => {
      if (e.pointerType !== 'mouse') return;
      clearTimeout(hideT);
      hideT = setTimeout(() => volDD.classList.remove('mushaf-toolbar__dropdown--open'), 350);
    });
    document.addEventListener('click', (e) => { if (!playWrap.contains(e.target)) volDD.classList.remove('mushaf-toolbar__dropdown--open'); });
  }

  // Touch-only long-press: hold the play button for 500ms to open the
  // volume/speed dropdown. Mobile has no hover, so without this the
  // dropdown is unreachable when audio isn't already playing. The
  // following synthetic click is swallowed (capture-phase) so a long
  // press doesn't also toggle playback. The onOpen hook closes the
  // settings dropdown for mutual exclusion on touch.
  attachLongPressDropdown(playBtn, volDD, closeTafsirSettingsDropdown);

  // Volume controls
  if (volSlider) {
    volSlider.value = String(Math.round(AUDIO_VOLUME * 100));
    volSlider.addEventListener('input', () => setAudioVolume(Number(volSlider.value) / 100));
  }
  volDown?.addEventListener('click', () => setAudioVolume(AUDIO_VOLUME - 0.1));
  volUp?.addEventListener('click', () => setAudioVolume(AUDIO_VOLUME + 0.1));

  // Speed controls: slider is continuous, button cycles preset options
  if (speedSlider) {
    speedSlider.value = String(AUDIO_SPEED);
    speedSlider.addEventListener('input', () => setAudioSpeed(Number(speedSlider.value)));
  }
  speedBtn?.addEventListener('click', (e) => { e.stopPropagation(); cycleAudioSpeed(); });
})();

/* ---------------- Tafsir description popover (info button next to the title) ---------------- */
function closeTafsirDescPopover() {
  const btn = document.getElementById('tafsirDescBtn');
  const pop = document.getElementById('tafsirDesc');
  pop?.classList.remove('is-open');
  pop?.setAttribute('aria-hidden', 'true');
  btn?.setAttribute('aria-expanded', 'false');
}
(function wireTafsirDescPopover() {
  const btn = document.getElementById('tafsirDescBtn');
  const pop = document.getElementById('tafsirDesc');
  if (!btn || !pop) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = pop.classList.toggle('is-open');
    pop.setAttribute('aria-hidden', open ? 'false' : 'true');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  // Close on outside click
  document.addEventListener('click', (e) => {
    if (!pop.contains(e.target) && !btn.contains(e.target)) closeTafsirDescPopover();
  });
})();

/* ---------------- Custom tafsir dropdown ----------------
 * The native <select> popup is rendered by the OS (tiny + detached + unstyleable),
 * so we hide it and drive a custom, fully-styled dropdown that opens right under
 * its trigger. The <select> stays the source of truth: picking an option sets
 * its value and dispatches a `change` event, so all existing logic still runs. */
let syncTafsirDropdownLabel = () => { };
(function buildTafsirDropdown() {
  const select = document.getElementById('tafsirSelect');
  if (!select) return;
  const wrap = select.closest('.tafsir-select-wrap') || select.parentElement;
  if (!wrap) return;

  select.classList.add('tafsir-select-native-hidden');

  const dd = document.createElement('div');
  dd.className = 'tafsir-dd';
  dd.innerHTML = `
    <button type="button" class="tafsir-dd__trigger" id="tafsirDDTrigger" aria-haspopup="listbox" aria-expanded="false">
      <span class="tafsir-dd__label" id="tafsirDDLabel"></span>
      <svg class="tafsir-dd__chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19.5 8.25l-7.5 7.5-7.5-7.5"/></svg>
    </button>
    <ul class="tafsir-dd__menu" id="tafsirDDMenu" role="listbox"></ul>`;
  wrap.insertBefore(dd, select);

  const trigger = dd.querySelector('#tafsirDDTrigger');
  const label = dd.querySelector('#tafsirDDLabel');
  const menu = dd.querySelector('#tafsirDDMenu');

  function sync() {
    const sel = select.options[select.selectedIndex];
    if (label) label.textContent = sel ? sel.textContent : '';
    menu.querySelectorAll('.tafsir-dd__option').forEach((li) => {
      li.setAttribute('aria-selected', li.dataset.value === select.value ? 'true' : 'false');
    });
  }
  syncTafsirDropdownLabel = sync;

  function renderOptions() {
    menu.innerHTML = '';
    Array.from(select.options).forEach((opt) => {
      const li = document.createElement('li');
      li.className = 'tafsir-dd__option';
      li.setAttribute('role', 'option');
      li.dataset.value = opt.value;
      li.textContent = opt.textContent;
      li.setAttribute('aria-selected', opt.value === select.value ? 'true' : 'false');
      li.addEventListener('click', () => {
        if (select.value !== opt.value) {
          select.value = opt.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
        sync();
        close();
      });
      menu.appendChild(li);
    });
  }
  function open() { renderOptions(); dd.classList.add('tafsir-dd--open'); trigger.setAttribute('aria-expanded', 'true'); }
  function close() { dd.classList.remove('tafsir-dd--open'); trigger.setAttribute('aria-expanded', 'false'); }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    dd.classList.contains('tafsir-dd--open') ? close() : open();
  });
  document.addEventListener('click', (e) => { if (!dd.contains(e.target)) close(); });
  select.addEventListener('change', sync);
  sync();
})();

buildTafsirReciterChips();

// Initialize reciter UI on page load
document.addEventListener('DOMContentLoaded', updateReciterUI);
// Also run immediately in case DOM is already loaded
if (document.readyState !== 'loading') updateReciterUI();

// Speed control button event listeners
document.querySelectorAll('.audio-speed-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    cycleAudioSpeed();
  });
});

// Initialize speed UI on page load
document.addEventListener('DOMContentLoaded', updateSpeedUI);
if (document.readyState !== 'loading') updateSpeedUI();

// Initialize listening mode UI on page load
document.addEventListener('DOMContentLoaded', updateListeningModeUI);
if (document.readyState !== 'loading') updateListeningModeUI();


function applyCompareFadeIn() {
  if (!tafsirCompareContent) return;
  tafsirCompareContent.classList.remove("show");
  tafsirCompareContent.classList.add("fade-in");
  requestAnimationFrame(() => {
    tafsirCompareContent.classList.add("show");
  });
}

function setIndexStatus(text = "") {
  if (!indexStatus) return;
  indexStatus.textContent = text;
  indexStatus.classList.toggle("hidden", !text);
}

function updateNetworkBadge() {
  const offline = !navigator.onLine;
  if (netBadge) netBadge.classList.toggle("hidden", !offline);
}

function isLikelyArabicLine(line = "") {
  const arabicCount = (line.match(/[\u0600-\u06FF]/g) || []).length;
  const latinCount = (line.match(/[A-Za-z]/g) || []).length;
  return arabicCount >= Math.max(2, latinCount);
}

function isLikelyEnglishLine(line = "") {
  const arabicCount = (line.match(/[\u0600-\u06FF]/g) || []).length;
  const latinCount = (line.match(/[A-Za-z]/g) || []).length;
  return latinCount >= Math.max(2, arabicCount);
}

function filterTextByLanguage(text = "", mode = "any") {
  const t = String(text || "").trim();
  if (!t) return "";
  const lines = t.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return t;
  if (mode === "ar") return lines.filter(isLikelyArabicLine).join("\n");
  if (mode === "en") return lines.filter(isLikelyEnglishLine).join("\n");
  return lines.join("\n");
}

function formatAiParagraphs(text = "", mode = "any") {
  const cleaned = filterTextByLanguage(cleanAiText(text), mode);
  if (!cleaned) return "";
  const parts = cleaned.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  return parts.map((p) => `<p class="ai-paragraph">${formatAiInline(p)}</p>`).join("");
}

function splitAiParagraphs(text = "", mode = "any") {
  const cleaned = filterTextByLanguage(cleanAiText(text), mode);
  if (!cleaned) return [];
  const chunks = cleaned.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  for (const chunk of chunks) {
    const sentences = chunk.match(/[^.!؟?\u06D4]+[.!؟?\u06D4]?/g) || [chunk];
    for (const s of sentences) {
      const trimmed = s.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

function stopAiTyping() {
  if (AI_TYPE_TIMER) {
    clearTimeout(AI_TYPE_TIMER);
    AI_TYPE_TIMER = null;
  }
}

function animateAiAnswer(el, fullText, opts = {}) {
  const text = (fullText || "").trim();
  const {
    forceAnimate = false,
    maxAnimateChars = 280,   // animate only if answer is short
    burst = 18,
    delayMs = 12
  } = opts;

  // ALWAYS paint immediately first (fast appearance)
  el.textContent = text;

  // Only animate if explicitly forced AND short enough
  if (!forceAnimate) return;
  if (text.length > maxAnimateChars) return;

  // Typewriter effect for short answers ONLY (cosmetic)
  el.textContent = "";
  let i = 0;

  function step() {
    el.textContent += text.slice(i, i + burst);
    i += burst;
    if (i < text.length) setTimeout(step, delayMs);
  }
  step();
}

function stripJsonArtifacts(text = "") {
  let t = String(text || "");
  t = t.replace(/"arabic_answer"\s*:\s*"(?:\\.|[^"])*"/g, " ");
  t = t.replace(/"english_answer"\s*:\s*"(?:\\.|[^"])*"/g, " ");
  t = t.replace(/"key_points_(ar|en)"\s*:\s*\[[\s\S]*?\]/g, " ");
  t = t.replace(/"tafsir_differences_(ar|en)"\s*:\s*\[[\s\S]*?\]/g, " ");
  t = t.replace(/"citations"\s*:\s*\[[\s\S]*?\]/g, " ");
  t = t.replace(/[{}\[\]]/g, " ");
  return t;
}

function tryParseJsonFromText(text = "") {
  const raw = String(text || "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  const candidate = raw.slice(start, end + 1);
  try { return JSON.parse(candidate); } catch { }
  return null;
}

async function safeParseJSON(response) {
  const text = await response.text();
  if (!text) return null;
  const contentType = response.headers?.get("content-type") || "";
  const trimmed = text.trim();
  if (contentType.includes("application/json")) {
    try { return JSON.parse(trimmed); } catch { return null; }
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { return JSON.parse(trimmed); } catch { return null; }
  }
  return null;
}

function looksLikeNoise(text = "") {
  const t = String(text || "").trim();
  if (!t) return true;
  if (/^[a-z_]{5,}$/i.test(t) && !/\s/.test(t)) return true;
  return false;
}

function extractTerms(query = "", isArabic = false) {
  if (isArabic) {
    const stop = new Set(["الله", "قال", "الذي", "التي", "هذا", "هذه", "ذلك", "تلك", "على", "في", "من", "عن", "ما", "لم", "لن", "هل", "قد"]);
    return normArabic(query)
      .split(" ")
      .map((t) => t.trim())
      .filter((t) => t.length >= 2 && !stop.has(t));
  }

  const stopEn = new Set(["the", "and", "that", "this", "from", "with", "what", "your", "have", "for", "not", "are", "you", "was", "were", "why", "how", "when", "where", "who", "which", "about", "into", "onto", "also"]);
  return String(query || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !stopEn.has(t));
}

function scoreTextMatch(text = "", question = "", isArabic = false) {
  const terms = extractTerms(question, isArabic);
  if (!terms.length) return 0;
  const t = isArabic ? normArabic(text) : String(text || "").toLowerCase();
  let hits = 0;
  for (const term of terms) if (t.includes(term)) hits++;
  const ratio = hits / terms.length;
  let score = ratio;
  const q = isArabic ? normArabic(question) : String(question || "").toLowerCase();
  if (t.includes(q)) score += 1.5;
  if (isArabic) {
    const noSpaceQ = q.replace(/\s+/g, "");
    const noSpaceT = t.replace(/\s+/g, "");
    if (noSpaceT.includes(noSpaceQ)) score += 1;
  }
  return score;
}

function normalizeAiResults(results, question, isArabic) {
  const input = Array.isArray(results) ? results : [];
  const cleaned = input.map((item) => {
    const text = cleanAiText(item?.text || item?.content || item?.matched_text || item?.snippet || "");
    const langOk = isArabic ? isLikelyArabicLine(text) : isLikelyEnglishLine(text);
    const score = (looksLikeNoise(text) || !langOk) ? 0 : scoreTextMatch(text, question, isArabic);
    return { ...item, _cleanText: text, _score: score, _langOk: langOk };
  });

  const termCount = extractTerms(question, isArabic).length;
  const threshold = isArabic ? (termCount <= 2 ? 0.3 : 0.45) : (termCount <= 2 ? 0.2 : 0.34);
  let filtered = cleaned.filter((x) => x._score >= threshold);
  if (!filtered.length) filtered = cleaned.filter((x) => x._langOk);
  filtered.sort((a, b) => b._score - a._score);

  let bestAyah = null;
  for (const item of filtered) {
    const s = Number(item?.surah || item?.s);
    const a = Number(item?.ayah || item?.a);
    if (Number.isFinite(s) && Number.isFinite(a)) { bestAyah = { surah: s, ayah: a }; break; }
  }

  return { items: filtered, bestAyah };
}

function sanitizeAiData(raw, question, isArabic) {
  const data = { ...(raw || {}) };
  if (data?.ai) {
    let ai = { ...data.ai };
    const probe =
      (typeof ai.arabic_answer === "string" && ai.arabic_answer.includes("\"arabic_answer\"") && ai.arabic_answer) ||
      (typeof ai.english_answer === "string" && ai.english_answer.includes("\"arabic_answer\"") && ai.english_answer) ||
      (typeof ai.raw_text === "string" && ai.raw_text.includes("\"arabic_answer\"") && ai.raw_text) ||
      null;
    const parsed = probe ? tryParseJsonFromText(probe) : null;
    if (parsed) {
      ai = {
        ...ai,
        arabic_answer: parsed.arabic_answer ?? ai.arabic_answer,
        english_answer: parsed.english_answer ?? ai.english_answer,
        key_points_ar: parsed.key_points_ar ?? ai.key_points_ar,
        key_points_en: parsed.key_points_en ?? ai.key_points_en,
        citations: parsed.citations ?? ai.citations,
      };
    }
    const kpAr = Array.isArray(ai.key_points_ar)
      ? ai.key_points_ar.map((x) => filterTextByLanguage(cleanAiText(x), "ar")).filter(Boolean)
      : ai.key_points_ar;
    const kpEn = Array.isArray(ai.key_points_en)
      ? ai.key_points_en.map((x) => filterTextByLanguage(cleanAiText(x), "en")).filter(Boolean)
      : ai.key_points_en;
    const cleanedArabic = filterTextByLanguage(cleanAiText(ai.arabic_answer || ""), "ar");
    const cleanedEnglish = filterTextByLanguage(cleanAiText(ai.english_answer || ""), "en");
    const cleanedRaw = cleanAiText(ai.raw_text || "");

    data.ai = {
      ...ai,
      key_points_ar: kpAr,
      key_points_en: kpEn,
      arabic_answer: cleanedArabic,
      english_answer: cleanedEnglish,
      raw_text: cleanedRaw,
    };
  }
  data.quran_text = filterTextByLanguage(cleanAiText(data.quran_text || ""), isArabic ? "ar" : "en");
  const normalized = normalizeAiResults(data.results, question, isArabic);
  data.results = normalized.items;
  if (normalized.bestAyah) data.best_ayah = normalized.bestAyah;
  return data;
}

function escapeRegex(str = "") {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isArabicText(text = "") {
  return /[\u0600-\u06FF]/.test(String(text || ""));
}

const SOURCE_LABELS_AR = [
  { keys: ["bukhari", "al bukhari", "sahih bukhari"], label: "صحيح البخاري" },
  { keys: ["muslim", "sahih muslim"], label: "صحيح مسلم" },
  { keys: ["ibn kathir", "ibn katheer"], label: "تفسير ابن كثير" },
  { keys: ["qurtubi", "al qurtubi"], label: "تفسير القرطبي" },
  { keys: ["tabari", "al tabari"], label: "تفسير الطبري" },
  { keys: ["saadi", "al saadi", "as saadi"], label: "تفسير السعدي" },
  { keys: ["muyassar", "al muyassar"], label: "تفسير الميسر" },
  { keys: ["baghawi", "al baghawi"], label: "تفسير البغوي" },
  { keys: ["ibn ashur", "ibn ashour", "ibn 'ashur"], label: "تفسير ابن عاشور" },
  { keys: ["quran", "qur'an"], label: "القرآن الكريم" },
  { keys: ["hadith"], label: "الحديث الشريف" },
];

const SOURCE_AR_TITLES = {
  "fath albari": "فتح الباري",
  "fath al bari": "فتح الباري",
  "dar taarud al aql wal naql": "درء تعارض العقل والنقل",
  "dar taarud al aql wa al naql": "درء تعارض العقل والنقل",
  "fatawa noor ala al darb": "فتاوى نور على الدرب",
  "fatawa noor ala aldarb": "فتاوى نور على الدرب",
  "ibn kathir": "تفسير ابن كثير",
  "tafsir ibn kathir": "تفسير ابن كثير",
  "ibn ashur": "تفسير ابن عاشور",
  "ibn ashour": "تفسير ابن عاشور",
  "tafsir ibn ashur": "تفسير ابن عاشور",
  "tafsir ibn ashour": "تفسير ابن عاشور",
  "muyassar": "تفسير الميسر",
  "tafsir muyassar": "تفسير الميسر",
  "sahih bukhari": "صحيح البخاري",
  "bukhari": "صحيح البخاري",
  "sahih muslim": "صحيح مسلم",
  "muslim": "صحيح مسلم",
  "quran": "القرآن الكريم",
  "hadith": "الحديث النبوي"
};

const SOURCE_AR_DISPLAY = {
  "fatawa noor ala al darb": "فتاوى نور على الدرب للعثيمين",
  "fatawa noor ala aldarb": "فتاوى نور على الدرب للعثيمين",
  "fath al bari": "فتح الباري لابن حجر",
  "riyad al salihin": "رياض الصالحين للنووي",
  "al wabil al sayyib": "الوابل الصيب لابن القيم",
  "al wabil al sayyeb": "الوابل الصيب لابن القيم",
  "al daa wal dawaa": "الداء والدواء لابن القيم",
  "al daa wal dawa": "الداء والدواء لابن القيم",
  "al daaa wal dawaa": "الداء والدواء لابن القيم",
  "ahkam ahl al milal wal ridda": "أحكام أهل الملل والردة لابن تيمية",
  "al rawd ibn al qayyim": "الروض لابن القيم",
  "al salat ibn al qayyim": "الصلاة لابن القيم",
  "ibn kathir": "تفسير ابن كثير",
  "tafsir ibn kathir": "تفسير ابن كثير",
  "ibn ashur": "تفسير ابن عاشور",
  "ibn ashour": "تفسير ابن عاشور",
  "tafsir ibn ashur": "تفسير ابن عاشور",
  "tafsir ibn ashour": "تفسير ابن عاشور",
  "muyassar": "تفسير الميسر",
  "tafsir muyassar": "تفسير الميسر",
  "sahih bukhari": "صحيح البخاري",
  "bukhari": "صحيح البخاري",
  "sahih muslim": "صحيح مسلم",
  "muslim": "صحيح مسلم",
  "quran": "القرآن",
  "hadith": "الحديث"
};


function normalizeSourceKey(raw = "") {
  return String(raw || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\.(txt|jsonl?|pdf)\b/gi, "")
    .toLowerCase()
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function mapSourceNameToArabic(raw = "") {
  if (!raw) return raw;
  if (isArabicText(raw)) return raw;
  const key = normalizeSourceKey(raw);
  if (!key) return raw;
  if (SOURCE_AR_TITLES[key]) return SOURCE_AR_TITLES[key];
  for (const [matchKey, value] of Object.entries(SOURCE_AR_TITLES)) {
    if (key.includes(matchKey)) return value;
  }
  if (SOURCE_AR_DISPLAY[key]) return SOURCE_AR_DISPLAY[key];
  for (const [matchKey, value] of Object.entries(SOURCE_AR_DISPLAY)) {
    if (key.includes(matchKey)) return value;
  }
  return raw;
}

function getHadithNumber(item) {
  const direct =
    item?.hadith_number ??
    item?.hadithNo ??
    item?.hadith_id ??
    item?.hadithId ??
    item?.number ??
    item?.id ??
    item?.ref?.number ??
    item?.hadith?.number;
  if (direct == null) return "";
  const str = String(direct);
  const match = str.match(/\d+/);
  return match ? match[0] : "";
}

function cleanBookTitle(labelOrLoc = "") {
  let t = String(labelOrLoc || "");
  t = t.replace(/_/g, " ");
  t = t.replace(/\b(\S+)\.(txt|djvu|pdf|docx?|jsonl?|json)\b/gi, "$1");
  t = t.replace(/\bchunk\s*\d+(?:\/\d+)?\b/gi, " ");
  t = t.replace(/[—–-]+\s*chunk\s*\d+(?:\/\d+)?/gi, " ");
  t = t.replace(/[—–-]+/g, " ");
  t = t.replace(/\s{2,}/g, " ").trim();
  if (!t) return "";
  const lower = t.toLowerCase();
  if (lower === "book" || lower === "books") return "";
  return t;
}

function extractChunkInfo(text = "") {
  const m = String(text || "").match(/chunk\s*([0-9]+(?:\/[0-9]+)?)/i);
  return m ? m[1] : "";
}

function extractChunkFromId(rawId = "") {
  const id = String(rawId || "");
  if (!id.includes("#")) return "";
  const chunk = id.split("#")[1] || "";
  return chunk.replace(/[^\d/]/g, "");
}

function isBookResult(item) {
  const type = String(item?.type || item?.kind || "").toLowerCase();
  if (type === "book_passage") return true;
  const srcId = String(item?.source_id || item?.sourceId || "");
  return srcId.startsWith("BOOK:");
}

function localizeBooksLabel(label, isAr) {
  if (isAr) {
    const trimmed = String(label || "").trim();
    if (!trimmed || trimmed.toLowerCase() === "books") return "الكتب";
    if (trimmed === "الكتب" || trimmed === "كتب") return trimmed;
    if (/^(كتاب|الكتاب)\b/.test(trimmed)) return trimmed;
    return `كتاب: ${trimmed}`;
  }
  return label || "Books";
}

function getBookResultLabel(item) {
  const override = String(item?.label_override || "").trim();
  if (override) return override;
  const sourceTitle = String(item?.source_title || "").trim();
  if (sourceTitle) return sourceTitle;
  const author = String(item?.author || "").trim();
  const bookTitle = String(item?.book_title || "").trim();
  if (author && bookTitle) return `${author} — ${bookTitle}`;
  if (bookTitle) return bookTitle;
  const fileTitle = cleanBookTitle(item?.file || "");
  if (fileTitle) return fileTitle;
  return "Books";
}

function buildResultLookupMap(resultsArr) {
  const map = new Map();
  if (!Array.isArray(resultsArr)) return map;
  for (const r of resultsArr) {
    const id = String(r?.source_id || r?.sourceId || "").trim();
    if (!id) continue;
    if (!map.has(id)) map.set(id, r);
  }
  return map;
}

function buildResultSourceMap(resultsArr) {
  return buildResultLookupMap(resultsArr);
}

function formatCitationSource(rawId, resultsLookup, isAr) {
  const id = String(rawId || "").trim();
  if (!id) return isAr ? "مصدر" : "Source";

  if (resultsLookup instanceof Map) {
    const resultObj = resultsLookup.get(id);
    if (resultObj) {
      if (id.startsWith("BOOK:")) {
        const title = mapSourceNameToArabic(getBookResultLabel(resultObj));
        return localizeBooksLabel(title, isAr);
      }
      const label = String(
        resultObj?.label_override ||
        resultObj?.label ||
        resultObj?.source ||
        resultObj?.name ||
        resultObj?.book ||
        ""
      ).trim();
      const finalLabel = mapSourceNameToArabic(label || "");
      if (finalLabel) return finalLabel;
      if (label) return label;
    }
  }

  if (id.startsWith("BOOK:")) {
    const parts = id.split(":");
    const fileBase = parts.length >= 3 ? parts[2] : "";
    const linePart = parts.find((p) => /^ln\d+/i.test(p)) || "";
    const line = linePart ? String(linePart).replace(/[^\d]/g, "") : "";
    const title = mapSourceNameToArabic(cleanBookTitle(fileBase || "") || "Books");
    const label = localizeBooksLabel(title, isAr);
    if (!line) return label;
    return isAr ? `${label} (سطر ${line})` : `${label} (line ${line})`;
  }

  if (id.startsWith("TAFSIR:")) {
    const parts = id.split(":");
    const name = parts[1] || "Unknown";
    const s = parts[2];
    const a = parts[3];
    const ref = s && a ? ` (${s}:${a})` : "";
    const nameLabel = mapSourceNameToArabic(name);
    const finalName = nameLabel || name;
    if (isAr) {
      const arabicName = finalName && isArabicText(finalName) ? finalName : name;
      return `${arabicName}${ref}`;
    }
    return `Tafsir ${finalName}${ref}`;
  }

  if (id.startsWith("QURAN:")) {
    const parts = id.split(":");
    const s = parts[1];
    const a = parts[2];
    const ref = s && a ? ` (${s}:${a})` : "";
    const base = mapSourceNameToArabic("quran") || (isAr ? "القرآن الكريم" : "Quran");
    return `${base}${ref}`;
  }

  if (id.startsWith("HADITH:")) {
    const rest = id.slice("HADITH:".length);
    const [collection, ...refParts] = rest.split(":");
    const ref = refParts.join(":");
    const refLabel = ref ? ` (${ref})` : "";
    const label = collection ? mapSourceNameToArabic(collection) : (mapSourceNameToArabic("hadith") || (isAr ? "مصدر" : "source"));
    return isAr ? `حديث ${label}${refLabel}` : `Hadith ${label || "source"}${refLabel}`;
  }

  return id;
}

function normArabic(s) {
  return (s || "")
    .replace(/[\u064B-\u065F\u0610-\u061A\u0670\u06D6-\u06ED]/g, "")
    .replace(/[ٱأإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^\u0600-\u06FF0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isExactAyahMatch(textNorm, queryNorm) {
  if (!textNorm || !queryNorm) return false;
  if (textNorm === queryNorm) return true;
  const noSpaceText = textNorm.replace(/\s+/g, "");
  const noSpaceQuery = queryNorm.replace(/\s+/g, "");
  return noSpaceText === noSpaceQuery;
}

const BASMALA_TEXT = "بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ";
const BASMALA_PLAIN = "بسم الله الرحمن الرحيم";
const BASMALA_REGEX = new RegExp(`^[\\s\\uFEFF]*${escapeRegex(BASMALA_TEXT)}\\s*`);
const BASMALA_PLAIN_REGEX = new RegExp(`^[\\s\\uFEFF]*${escapeRegex(BASMALA_PLAIN)}\\s*`);

function stripBasmala(text = "", surahNo, ayahNo) {
  if (ayahNo !== 1) return { text: text || "", basmala: "" };
  // Surah 1, Ayah 1 IS the Basmala — keep it in the ayah text so the
  // tafsir view renders the verse instead of a dash. (The standalone
  // basmala header is suppressed because basmala is returned empty.)
  if (surahNo === 1) return { text: text || "", basmala: "" };
  if (BASMALA_REGEX.test(text)) {
    return { text: text.replace(BASMALA_REGEX, "").trim(), basmala: BASMALA_TEXT };
  }
  if (BASMALA_PLAIN_REGEX.test(text)) {
    return { text: text.replace(BASMALA_PLAIN_REGEX, "").trim(), basmala: BASMALA_TEXT };
  }
  return { text: text || "", basmala: "" };
}

async function loadJson(path) {
  // ✅ On Android/iOS (Capacitor), local assets MUST be fetched without "?v=" query strings
  const isNative =
    !!(window.Capacitor &&
      typeof window.Capacitor.isNativePlatform === "function" &&
      window.Capacitor.isNativePlatform());

  const url = isNative
    ? path // <-- NO querystring on native apps
    : (path.includes("?") ? `${path}&v=${ASSET_VER}` : `${path}?v=${ASSET_VER}`); // web cache-bust only

  const r = await fetch(url, { cache: isNative ? "no-store" : "force-cache" });
  if (!r.ok) throw new Error(`Failed to load ${path}`);
  return r.json();
}

function normalizeQuran(raw) {
  const surahs = raw?.data?.surahs || raw?.surahs || raw;
  return {
    surahs: (surahs || []).map((s) => ({
      number: Number(s.number),
      name_ar: s.name_ar || s.name,
      ayahs: (s.ayahs || []).map((a) => {
        const numberInSurah = Number(a.numberInSurah);
        const rawText = a.text || "";
        const { text, basmala } = stripBasmala(rawText, Number(s.number), numberInSurah);
        return { numberInSurah, text, basmala };
      }),
    })),
  };
}

function buildIndexSync() {
  INDEX = [];
  for (const s of QURAN.surahs) {
    for (const a of s.ayahs) {
      INDEX.push({
        s: s.number,
        a: a.numberInSurah,
        textRaw: a.text,
        textNorm: normArabic(a.text),
      });
    }
  }
}

/**
 * Build the text search index without freezing the UI.
 * Uses requestIdleCallback when available, otherwise falls back to small setTimeout chunks.
 */
function buildIndexAsync() {
  INDEX = [];
  const surahs = (QURAN && QURAN.surahs) ? QURAN.surahs : [];
  let si = 0;
  let ai = 0;

  const pushOne = () => {
    const s = surahs[si];
    if (!s) return false;
    const ayahs = s.ayahs || [];
    const a = ayahs[ai];
    if (!a) {
      si += 1;
      ai = 0;
      return true;
    }
    INDEX.push({
      s: s.number,
      a: a.numberInSurah,
      textRaw: a.text,
      textNorm: normArabic(a.text),
    });
    ai += 1;
    return true;
  };

  const hasIdle = typeof requestIdleCallback === "function";

  return new Promise((resolve) => {
    const CHUNK = 200;
    const MIN_TIME = 2;
    const step = (deadline) => {
      // Do a chunk of work
      let count = 0;
      while (count < CHUNK && pushOne()) {
        count += 1;
        // Stop if we are running out of time in this frame
        if (deadline && deadline.timeRemaining() < MIN_TIME) break;
      }

      if (si >= surahs.length) {
        resolve();
        return;
      }
      if (hasIdle) requestIdleCallback(step, { timeout: 120 });
      else setTimeout(step, 8);
    };

    if (hasIdle) requestIdleCallback(step, { timeout: 120 });
    else setTimeout(step, 8);
  });
}
/* Accepts multiple tafsir shapes; outputs {s:{a:text}} */
function normalizeTafsirText(value) {
  if (value == null) return "";
  if (Array.isArray(value)) {
    const parts = value.map(normalizeTafsirText).filter(Boolean);
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }
  if (typeof value === "object") {
    const inner = value.text ?? value.tafsir ?? value.content ?? value.value ?? value.explain ?? value.meaning ?? value.commentary;
    return normalizeTafsirText(inner);
  }
  const text = String(value || "");
  const noHtml = text.replace(/<[^>]*>/g, " ");
  return noHtml.replace(/\s+/g, " ").trim();
}

function normalizeTafsir(raw) {
  const out = {};
  const keyRegex = /^0*(\d+)\s*[:|/_-]\s*0*(\d+)$/;
  const parseKey = (key) => {
    const str = String(key || "");
    const match = keyRegex.exec(str);
    if (match) return { s: match[1], a: match[2] };
    if (str.includes(":")) {
      const parts = str.split(":");
      if (parts.length >= 2) return { s: parts[0], a: parts[1] };
    }
    return null;
  };

  const put = (s, a, text) => {
    if (s == null || a == null) return;
    const ss = String(s).replace(/^0+/, "") || "0";
    const aa = String(a).replace(/^0+/, "") || "0";
    const tt = normalizeTafsirText(text);
    if (!tt) return;
    out[ss] ??= {};
    out[ss][aa] = tt;
  };

  if (Array.isArray(raw)) {
    for (const row of raw) {
      if (Array.isArray(row) && row.length >= 3) {
        put(row[0], row[1], row[2]);
        continue;
      }
      if (row && typeof row === "object") {
        const s = row.surah ?? row.sura ?? row.chapter ?? row.s ?? row.surahNo ?? row.surah_number;
        const a = row.ayah ?? row.aya ?? row.verse ?? row.a ?? row.ayahNo ?? row.ayah_number;
        const t = row.text ?? row.tafsir ?? row.content ?? row.value ?? row.explain ?? row.meaning ?? row.commentary;
        put(s, a, t);
      }
    }
    return out;
  }

  if (raw && typeof raw === "object") {
    const unwrap = (obj) => obj?.data ?? obj?.tafsir ?? obj?.tafseer ?? obj?.result ?? obj?.results ?? obj;
    const candidate = unwrap(raw);
    if (Array.isArray(candidate)) return normalizeTafsir(candidate);
    const source = candidate && typeof candidate === "object" ? candidate : raw;
    const keys = Object.keys(source);
    if (!keys.length) return out;

    const sampleKey = keys[0];

    // "s:a" => "text"
    if (sampleKey.includes(":") && typeof source[sampleKey] !== "object") {
      for (const k of keys) {
        const parsed = parseKey(k);
        if (!parsed) continue;
        put(parsed.s, parsed.a, source[k]);
      }
      return out;
    }

    // flat mapping with multiple separators
    let matchedFlat = false;
    for (const k of keys) {
      const match = keyRegex.exec(String(k));
      if (!match) continue;
      matchedFlat = true;
      put(match[1], match[2], source[k]);
    }
    if (matchedFlat) return out;

    if (source && typeof source === "object" && !Array.isArray(source)) {
      for (const sKey of Object.keys(source)) {
        const inner = source[sKey];
        if (inner && typeof inner === "object" && !Array.isArray(inner)) {
          for (const aKey of Object.keys(inner)) put(sKey, aKey, inner[aKey]);
        }
      }
      if (Object.keys(out).length) return out;
    }

    // "s:a" => {text:"..."}
    if (sampleKey.includes(":") && typeof source[sampleKey] === "object") {
      for (const k of keys) {
        const parsed = parseKey(k);
        if (!parsed) continue;
        const v = source[k];
        const t = v?.text ?? v?.tafsir ?? v?.content ?? v?.value;
        put(parsed.s, parsed.a, t);
      }
      return out;
    }
  }

  return out;
}

const TAFSIR_ENTRY_KEYS = {
  surah: ["surah", "sura", "chapter", "s", "surahNo", "surah_number"],
  ayah: ["ayah", "aya", "verse", "a", "ayahNo", "ayah_number"],
  text: ["text", "tafsir", "content", "value", "explain", "meaning", "commentary"],
};

function getEntryField(obj, keys) {
  for (const key of keys) {
    if (obj?.[key] != null) return obj[key];
  }
  return null;
}

function getEntryText(entries, surahNo, ayahNo) {
  if (!Array.isArray(entries)) return null;
  const sNum = Number(surahNo);
  const aNum = Number(ayahNo);
  if (!Number.isFinite(sNum) || !Number.isFinite(aNum)) return null;
  const cache = TAFSIR_ENTRY_CACHE.get(entries);
  if (cache) return cache.get(`${sNum}:${aNum}`) || null;

  let looksLikeEntries = false;
  for (let i = 0; i < Math.min(entries.length, 5); i += 1) {
    const item = entries[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const s = getEntryField(item, TAFSIR_ENTRY_KEYS.surah);
    const a = getEntryField(item, TAFSIR_ENTRY_KEYS.ayah);
    if (s != null && a != null) {
      looksLikeEntries = true;
      break;
    }
  }
  if (!looksLikeEntries) return null;

  const map = new Map();
  for (const item of entries) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const s = getEntryField(item, TAFSIR_ENTRY_KEYS.surah);
    const a = getEntryField(item, TAFSIR_ENTRY_KEYS.ayah);
    if (s == null || a == null) continue;
    const sNumItem = Number(s);
    const aNumItem = Number(a);
    if (!Number.isFinite(sNumItem) || !Number.isFinite(aNumItem)) continue;
    const text = getEntryField(item, TAFSIR_ENTRY_KEYS.text);
    const normalized = normalizeTafsirText(text);
    if (!normalized) continue;
    map.set(`${sNumItem}:${aNumItem}`, normalized);
  }
  TAFSIR_ENTRY_CACHE.set(entries, map);
  return map.get(`${sNum}:${aNum}`) || null;
}

// getTafsir and helpers removed
function getTafsir() { return null; }

/* en.sahih.json can be array of strings or array of objects */
function buildEnglishMap(enRaw) {
  const out = {};
  if (!enRaw || !QURAN) return out;

  let arr = [];
  if (Array.isArray(enRaw)) {
    if (enRaw.length && typeof enRaw[0] === "string") arr = enRaw;
    else arr = enRaw.map((x) => (x?.text ?? "").toString());
  } else {
    return out;
  }

  let i = 0;
  for (const s of QURAN.surahs) {
    const sKey = String(s.number);
    out[sKey] ??= {};
    for (const a of s.ayahs) {
      const aKey = String(a.numberInSurah);
      out[sKey][aKey] = (arr[i] ?? "").toString().trim();
      i++;
    }
  }
  return out;
}

/* ---------------- Search ---------------- */
function searchText(q) {
  if (!QURAN) return [];
  const nq = normArabic(q);
  if (nq.length < 2) return [];
  const MAX_RESULTS = 80;

  // Detect "locked" words: pressing space after a word locks it to whole-word matching.
  // normArabic trims whitespace, so check the raw input for trailing space.
  const hasTrailingSpace = /\s$/.test(q);
  const allTerms = nq.split(/\s+/).filter(t => t.length > 0);
  let lockedTerms = [];
  let partialTerm = null;

  if (hasTrailingSpace) {
    lockedTerms = allTerms.filter(t => t.length >= 2);
  } else if (allTerms.length > 1) {
    lockedTerms = allTerms.slice(0, -1).filter(t => t.length >= 2);
    partialTerm = allTerms[allTerms.length - 1] || null;
    if (partialTerm && partialTerm.length < 2) partialTerm = null;
  }

  const hasLocked = lockedTerms.length > 0;
  const lockedRegexes = hasLocked
    ? lockedTerms.map(t => new RegExp('(?:^|\\s)' + escapeRegex(t) + '(?=$|\\s)'))
    : [];

  // --- No locked terms: original behavior ---
  if (!hasLocked) {
    // 2-3 chars: fast
    if (nq.length <= 3) {
      const exactMatches = [];
      const exactSet = new Set();
      const out = [];

      for (const it of INDEX) {
        if (isExactAyahMatch(it.textNorm, nq)) {
          exactMatches.push(it);
          exactSet.add(`${it.s}:${it.a}`);
        }
      }

      for (const it of INDEX) {
        if (it.textNorm.includes(nq)) out.push(it);
        if (out.length >= MAX_RESULTS) break;
      }

      if (!exactMatches.length) return out;
      const limited = out.filter((it) => !exactSet.has(`${it.s}:${it.a}`));
      return [...exactMatches, ...limited].slice(0, MAX_RESULTS);
    }

    // 4+ : scoring
    let terms = nq.split(" ").map((t) => t.trim()).filter((t) => t.length > 1);
    terms = [...new Set(terms)];
    if (!terms.length) return [];

    const anchor = terms.reduce((a, b) => (b.length > a.length ? b : a), terms[0]);
    const scored = [];

    for (const it of INDEX) {
      const text = it.textNorm;

      let hits = 0;
      for (const t of terms) if (text.includes(t)) hits++;
      const ratio = hits / terms.length;

      const hasPhrase = text.includes(nq);
      const noSpaceQ = nq.replace(/\s+/g, "");
      const noSpaceT = text.replace(/\s+/g, "");
      const hasNoSpace = noSpaceT.includes(noSpaceQ);

      // Stricter filtering: require ALL terms to be present, or exact phrase match
      if (!hasPhrase && !hasNoSpace) {
        // Must have all terms present for a match
        if (hits < terms.length) continue;
      }

      let score = ratio;
      if (hasPhrase) score += 2.5;
      if (hasNoSpace) score += 1.5;

      if (text.includes(anchor)) score += 0.3;

      const exact = isExactAyahMatch(text, nq);
      if (exact) score += 5;

      scored.push({ ...it, score, exact });
    }

    scored.sort((a, b) => {
      const exactDiff = Number(b.exact) - Number(a.exact);
      if (exactDiff) return exactDiff;
      return b.score - a.score;
    });

    return scored.slice(0, MAX_RESULTS);
  }

  // --- Locked-term path: whole-word matching for locked words ---
  const scored = [];

  for (const it of INDEX) {
    const text = it.textNorm;

    let allMatch = true;
    for (const re of lockedRegexes) {
      if (!re.test(text)) { allMatch = false; break; }
    }
    if (!allMatch) continue;

    if (partialTerm && !text.includes(partialTerm)) continue;

    let score = lockedTerms.length;
    const hasPhrase = text.includes(nq);
    if (hasPhrase) score += 2.5;
    const exact = isExactAyahMatch(text, nq);
    if (exact) score += 5;

    scored.push({ ...it, score, exact });
  }

  scored.sort((a, b) => {
    const exactDiff = Number(b.exact) - Number(a.exact);
    if (exactDiff) return exactDiff;
    return b.score - a.score;
  });

  return scored.slice(0, MAX_RESULTS);
}

/* ---------------- Results UI ---------------- */
// Border beam on the search pill: once an ayah is chosen the beam has done
// its job — swap [data-active] → [data-fading] (the ported component's 0.5s
// beam-fade-out), then drop the attribute on animationend so every beam
// layer stops existing/painting. Idempotent: no-op after the first run.
// Round 5: "an ayah is chosen" is ALSO the pill مسح's cue to fade in —
// before the idempotence early-return, so repeat selections re-show it.
function deactivateSearchBeam() {
  showPillClear();
  const el = document.querySelector(".border-beam[data-active]");
  if (!el) return;
  el.removeAttribute("data-active");
  el.setAttribute("data-fading", "");
  const done = () => el.removeAttribute("data-fading");
  const onEnd = (e) => {
    if (e.animationName !== "beam-fade-out") return;
    el.removeEventListener("animationend", onEnd);
    done();
  };
  el.addEventListener("animationend", onEnd);
  // Fallback in case the animation never fires (no @property support,
  // reduced-motion overrides): the fade itself is 0.5s.
  setTimeout(done, 700);
}

// Inverse of deactivateSearchBeam, used by the مسح full-reset: the beam is
// part of the homepage's default look, so restoring the default state brings
// it back. Re-adding [data-active] replays beam-fade-in + the spin loop.
// Safe mid-fade: a pending deactivate timeout only removes [data-fading].
function reactivateSearchBeam() {
  hidePillClear(); // homepage default = no selection = no مسح
  const el = document.querySelector(".border-beam");
  if (!el || el.hasAttribute("data-active")) return;
  el.removeAttribute("data-fading");
  el.setAttribute("data-active", "");
}

function collapseResultsToChip(it) {
  if (!resultsShell || !results) return;
  deactivateSearchBeam();
  results.classList.add("collapsed");
  resultsShell.classList.add("collapsed");
  results.style.maxHeight = "";
  // Round 5: the typed fragment auto-completes into the FULL ayah text,
  // materializing in the pill (reverse of the مسح dissolve). Clicking the
  // locked pill later dissolves it for a fresh search.
  lockSearchToAyah(it?.textRaw || textSearch?.value || "");
}

function expandResultsList() {
  if (!resultsShell || !results) return;

  // If already expanded, just ensure max-height is set correctly without animation
  const wasCollapsed = resultsShell.classList.contains("collapsed");

  resultsShell.classList.remove("collapsed");
  results.classList.remove("collapsed");

  // Always ensure the container has proper max-height for scrolling
  if (wasCollapsed) {
    // Animate in from collapsed state
    const targetMax = Math.min(results.scrollHeight || 0, 480);
    if (targetMax > 0) {
      results.style.maxHeight = `${targetMax}px`;
      const cleanup = () => {
        results.style.maxHeight = "480px";
        results.removeEventListener("transitionend", cleanup);
      };
      results.addEventListener("transitionend", cleanup);
    } else {
      results.style.maxHeight = "480px";
    }
  } else {
    // Already expanded - just ensure max-height is stable (no animation flicker)
    results.style.maxHeight = "480px";
  }
}

function toggleResultsList() {
  if (!resultsShell || !results) return;
  if (VERSES_OPEN) setVersePanelOpen(false);
  if (resultsShell.classList.contains("collapsed")) {
    expandResultsList();
  } else {
    results.classList.add("collapsed");
    resultsShell.classList.add("collapsed");
    results.style.maxHeight = "0";
  }
}

// Build a regex pattern that matches Arabic text with optional diacritics between letters
// Also handles letter variations (أ/إ/آ/ا, ى/ي, ة/ه, ؤ/و, ئ/ي)
function buildDiacriticsAwarePattern(term) {
  // Arabic diacritics (tashkeel) pattern
  const diacritics = '[\\u064B-\\u065F\\u0610-\\u061A\\u0670\\u06D6-\\u06ED]*';

  // Letter variation groups
  const letterVariations = {
    'ا': '[اأإآٱ]',
    'أ': '[اأإآٱ]',
    'إ': '[اأإآٱ]',
    'آ': '[اأإآٱ]',
    'ٱ': '[اأإآٱ]',
    'ي': '[يى]',
    'ى': '[يى]',
    'ة': '[ةه]',
    'ه': '[ةه]',
    'ؤ': '[ؤو]',
    'و': '[ؤو]',
    'ئ': '[ئي]',
  };

  // Split term into characters and build pattern
  const chars = term.split('');
  const pattern = chars.map(c => {
    // Check if this character has variations
    const variation = letterVariations[c];
    if (variation) {
      return variation + diacritics;
    }
    return escapeRegex(c) + diacritics;
  }).join('');

  return pattern;
}

function highlightText(rawText, query) {
  const nq = normArabic(query);
  if (nq.length < 2) return escapeHtml(rawText);

  const terms = [...new Set(nq.split(" ").map((t) => t.trim()).filter((t) => t.length >= 2))];
  if (!terms.length) return escapeHtml(rawText);

  let html = rawText; // Work with raw text first to match diacritics
  terms.sort((a, b) => b.length - a.length);

  for (const t of terms) {
    // Build a pattern that matches the term with any diacritics in between letters
    const pattern = buildDiacriticsAwarePattern(t);
    const re = new RegExp(pattern, "g");
    // Replace matches with highlighted version
    html = html.replace(re, (match) => `\x00MARK_START\x00${match}\x00MARK_END\x00`);
  }

  // Now escape HTML and convert markers to actual tags
  html = escapeHtml(html);
  html = html.replace(/\x00MARK_START\x00/g, '<mark class="mark-ayah">');
  html = html.replace(/\x00MARK_END\x00/g, '</mark>');
  return html;
}

function renderResults(items, query) {
  LAST_RESULTS = items;
  results.classList.remove("is-empty");
  resultsShell?.classList.remove("is-empty");

  // Preserve scroll position if we're updating results
  const scrollTop = results.scrollTop;
  results.innerHTML = "";

  if (!items.length) {
    results.classList.add("is-empty");
    resultsShell?.classList.add("is-empty");
    results.innerHTML = `
      <div class="p-6 text-center">
        <div class="text-sm font-extrabold text-slate-700">لا توجد نتائج</div>
        <div class="mt-1 text-xs font-semibold text-slate-600">جرّب كلمة أخرى أو اكتب جزءًا أطول من الآية.</div>
      </div>
    `;
    return;
  }

  // Use DocumentFragment for better performance
  const fragment = document.createDocumentFragment();

  items.forEach((it, index) => {
    const surahNameAr = SURAH_META.find((s) => s.number === it.s)?.name_ar || `سورة ${it.s}`;
    const metaSurah = escapeHtml(surahNameAr);
    const metaAyah = `آية ${it.a}`;
    const ayahHtml = wrapTashkeelWords(highlightText(it.textRaw, query));

    const card = document.createElement("button");
    card.type = "button";
    card.className =
      "result-card w-full text-right rounded-2xl hover:bg-white/90 " +
      "transition-all shadow-sm hover:shadow-md px-4 py-3 flex flex-col gap-2 " +
      "focus:outline-none focus:ring-4 focus:ring-sky-400/20";

    card.innerHTML = `
      <div class="result-meta">
        <span class="result-meta-pill">سورة</span>
        <span class="result-meta-text">${metaSurah}</span>
        <span class="result-meta-divider">•</span>
        <span class="result-meta-ayah">${metaAyah}</span>
      </div>

      <div class="mt-1 h-px bg-black/5"></div>

      <div class="result-ayah quran-font text-[20px] sm:text-[22px] leading-[2.05] text-slate-900 text-center">
        ${ayahHtml}
      </div>
    `;

    card.onclick = () => {
      if (isMushafMode()) {
        // Task 2: picking an ayah while in Mushaf mode must not move the
        // viewport — suppress the target scrollIntoView.
        openMushafAtAyah(it.s, it.a, { noScroll: true });
        collapseResultsToChip(it);
        return;
      }
      setPrimaryAyah(it.s, it.a, { scroll: false });
      collapseResultsToChip(it);
    };

    fragment.appendChild(card);
  });

  results.appendChild(fragment);

  // Restore scroll position for smoother updates
  if (scrollTop > 0) {
    results.scrollTop = Math.min(scrollTop, results.scrollHeight - results.clientHeight);
  }
}

/* ---------------- Ayah panels ---------------- */
function computeContextWindow(surah, ayahNo) {
  const len = surah.ayahs.length;
  const before = 5;
  const after = 5;

  let start = Math.max(1, ayahNo - before);
  let end = Math.min(len, ayahNo + after);
  return { start, end };
}

function showAyahContext(surahNo, ayahNo) {
  const surah = QURAN.surahs.find((s) => s.number === surahNo);
  if (!surah) return;

  const surahName = SURAH_META.find((x) => x.number === surahNo)?.name_ar || surah.name_ar;

  // 1. Initialize State if missing or switching Surahs
  // If we are in the same Surah, we keep the existing window boundaries
  // so we can detect if the user clicked the edge.
  if (!CONTEXT_STATE || CONTEXT_STATE.surah !== surahNo) {
    const w = computeContextWindow(surah, ayahNo);
    CONTEXT_STATE = { surah: surahNo, start: w.start, end: w.end };
  }

  // 2. Detect Expansion (Edge Clicking)
  let didExpand = false;
  let oldScrollHeight = 0;
  let oldScrollTop = 0;

  // Capture scroll metrics before changing anything
  if (versePanel) {
    oldScrollHeight = versePanel.scrollHeight;
    oldScrollTop = versePanel.scrollTop;
  }

  // Check: Did user click the very TOP ayah? -> Expand Up
  if (ayahNo == CONTEXT_STATE.start && CONTEXT_STATE.start > 1) {
    CONTEXT_STATE.start = Math.max(1, CONTEXT_STATE.start - 5);
    didExpand = true;
  }
  // Check: Did user click the very BOTTOM ayah? -> Expand Down
  else if (ayahNo == CONTEXT_STATE.end && CONTEXT_STATE.end < surah.ayahs.length) {
    CONTEXT_STATE.end = Math.min(surah.ayahs.length, CONTEXT_STATE.end + 5);
    didExpand = true;
  }

  // Safety: If we jumped to a verse completely outside the current view (e.g. using Next button), reset window.
  if (ayahNo < CONTEXT_STATE.start || ayahNo > CONTEXT_STATE.end) {
    const w = computeContextWindow(surah, ayahNo);
    CONTEXT_STATE.start = w.start;
    CONTEXT_STATE.end = w.end;
    didExpand = true;
  }

  const { start, end } = CONTEXT_STATE;
  const mode = langSelect?.value || "en";

  // Track language change
  const langChanged = CONTEXT_STATE.lang !== mode;
  if (langChanged) {
    CONTEXT_STATE.lang = mode;
  }

  // 3. Render Decision
  // We only re-render if we expanded OR if the DOM is empty/wrong OR if language changed.
  const needsRender =
    didExpand ||
    langChanged ||
    ayahContext.childElementCount === 0 ||
    ayahContext.children[0]?.dataset.surah !== String(surahNo);

  if (needsRender) {
    // --- Full Render with smooth transition ---
    // Fade out for language changes
    if (langChanged && ayahContext.childElementCount > 0) {
      ayahContext.style.opacity = "0";
      ayahContext.style.transform = "translateY(4px)";
    }

    contextHeader.innerHTML = `<span class="quran-font font-bold">${escapeHtml(surahName)}</span> <span class="text-slate-400 mx-1">—</span> الآيات ${start} إلى ${end}`;
    ayahContext.innerHTML = "";

    for (let i = start; i <= end; i++) {
      const a = surah.ayahs.find((x) => x.numberInSurah === i);
      if (!a) continue;

      const numHtml = `<span class="num" dir="ltr">(${i})</span>`;
      const div = document.createElement("div");
      div.dataset.id = i;
      div.dataset.surah = surahNo;
      div.className = "ayah-line transition-colors duration-200";

      // Explicit Selection
      if (i === ayahNo) div.classList.add("active");

      div.title = "اضغط لجعل هذه الآية هي الرئيسية";

      const enText = EN_MAP?.[String(surahNo)]?.[String(i)] || "";

      if (mode === "en") {
        div.innerHTML = `${numHtml} ${escapeHtml(enText || "—")}`;
        div.style.direction = "ltr";
        div.style.textAlign = "left";
      } else {
        const arText = wrapTashkeelWords(escapeHtml(a.text));
        div.innerHTML = `${numHtml} ${arText}<span class="en">${escapeHtml(enText || "—")}</span>`;
        div.style.direction = "rtl";
        div.style.textAlign = "right";
      }

      // Click Handler
      div.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Update primary ayah WITHOUT scrolling page
        // This triggers this function again to handle expansion logic
        setPrimaryAyah(surahNo, i, { scroll: false });
      };

      ayahContext.appendChild(div);
    }

    // Animation reset
    ayahContext.classList.remove("context-animate");
    requestAnimationFrame(() => {
      ayahContext.classList.add("context-animate");
      // Fade back in after rendering
      ayahContext.style.opacity = "1";
      ayahContext.style.transform = "translateY(0)";
    });

    // 4. Smooth scroll to show newly revealed ayahs above
    // When user clicks first ayah, smoothly reveal the 5 ayahs above
    if (didExpand && versePanel) {
      // Find the clicked ayah element
      const clickedAyah = ayahContext.querySelector(`[data-id="${ayahNo}"]`);
      if (clickedAyah) {
        // Wait for DOM to update, then smoothly scroll to center the clicked ayah
        requestAnimationFrame(() => {
          const top = clickedAyah.offsetTop - versePanel.clientHeight / 2 + clickedAyah.clientHeight / 2;
          versePanel.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
        });
      }
    }
  } else {
    // --- Smart Update (No Render, Just Select) ---
    // This happens when you click a middle ayah. Zero movement.
    const allRows = Array.from(ayahContext.children);
    allRows.forEach((div) => {
      if (parseInt(div.dataset.id, 10) === ayahNo) {
        div.classList.add("active");
        // Ensure strictly visible inside panel
        if (versePanel) {
          const top = div.offsetTop;
          const bot = top + div.offsetHeight;
          const pTop = versePanel.scrollTop;
          const pBot = pTop + versePanel.clientHeight;
          // Only gently scroll IF out of view
          if (top < pTop) versePanel.scrollTo({ top, behavior: "smooth" });
          else if (bot > pBot) {
            versePanel.scrollTo({ top: bot - versePanel.clientHeight, behavior: "smooth" });
          }
        }
      } else {
        div.classList.remove("active");
      }
    });
  }
}

function getAyahTextFromQuran(surahNo, ayahNo) {
  const surah = QURAN?.surahs?.find((s) => s.number === surahNo);
  const ayah = surah?.ayahs?.find((a) => a.numberInSurah === ayahNo);
  return ayah?.text || "";
}

function getAyahBasmalaFromQuran(surahNo, ayahNo) {
  if (ayahNo !== 1) return "";
  const surah = QURAN?.surahs?.find((s) => s.number === surahNo);
  const ayah = surah?.ayahs?.find((a) => a.numberInSurah === ayahNo);
  return ayah?.basmala || "";
}

function isFullyVoweledWord(word = "") {
  const letters = [];
  let diacritics = 0;
  const alifForms = new Set(["ا", "ٱ", "آ", "أ", "إ"]);
  const lam = "ل";
  const prefixLetters = new Set(["و", "ف", "ب", "ك", "ل", "ت", "أ"]);
  const bareOk = new Set(["ا", "و", "ي", "ى", "آ", "ٱ", "إ", "أ"]);

  for (const ch of word) {
    if (/[\u064B-\u065F\u0670]/.test(ch)) {
      if (letters.length) letters[letters.length - 1].hasDiacritic = true;
      diacritics++;
    } else if (/[\u0621-\u064A\u066E-\u06D3]/.test(ch)) {
      letters.push({ ch, hasDiacritic: false });
    }
  }

  if (!letters.length || diacritics === 0) return false;

  let alStart = -1;
  let alLamIndex = -1;
  const maxPrefix = 2;

  for (let p = 0; p <= maxPrefix && p + 1 < letters.length; p++) {
    let ok = true;
    for (let i = 0; i < p; i++) {
      if (!prefixLetters.has(letters[i].ch)) {
        ok = false;
        break;
      }
    }
    if (!ok) break;
    if (alifForms.has(letters[p].ch) && letters[p + 1].ch === lam) {
      alStart = p;
      break;
    }
  }

  if (alStart === -1) {
    for (let p = 0; p <= maxPrefix && p + 1 < letters.length; p++) {
      let ok = true;
      for (let i = 0; i < p; i++) {
        if (!prefixLetters.has(letters[i].ch)) {
          ok = false;
          break;
        }
      }
      if (!ok) break;
      if (letters[p].ch === lam && letters[p + 1].ch === lam) {
        alLamIndex = p + 1;
        break;
      }
    }
  }

  for (let i = 0; i < letters.length; i++) {
    const letter = letters[i];
    if (bareOk.has(letter.ch)) continue;
    if (alStart !== -1 && (i === alStart || i === alStart + 1) && !letter.hasDiacritic) continue;
    if (alLamIndex !== -1 && i === alLamIndex && !letter.hasDiacritic) continue;
    if (!letter.hasDiacritic) return false;
  }
  return true;
}

function wrapTashkeelWords(input = "") {
  const wordRe = /[\u0621-\u064A\u066E-\u06D3][\u064B-\u065F\u0670\u0640]*(?:[\u0621-\u064A\u066E-\u06D3][\u064B-\u065F\u0670\u0640]*)*/g;
  return input.replace(wordRe, (word) => (isFullyVoweledWord(word) ? `<span class="quran-word">${word}</span>` : word));
}

function formatTafsirText(text, surahNo, ayahNo) {
  if (!text) return "";
  const ayahText = getAyahTextFromQuran(surahNo, ayahNo);

  let html = escapeHtml(text);

  // highlight braces/parens lightly (your CSS handles)
  html = html.replace(/\{([^{}]+)\}/g, `<span class="tafsir-brace quran-font">{$1}</span>`);
  html = html.replace(/\(([^()]+)\)/g, `<span class="tafsir-paren">($1)</span>`);

  // highlight ayah quote if present
  if (ayahText) {
    const escapedAyah = escapeHtml(ayahText);
    const re = new RegExp(escapeRegex(escapedAyah), "g");
    html = html.replace(re, `<span class="ayah-quote">${escapedAyah}</span>`);
  }

  html = wrapTashkeelWords(html);

  // paragraphing: split on long newlines OR sentence-ish
  const normalized = html.replace(/\n{2,}/g, "\n").trim();
  const parts = normalized.split("\n").map((p) => p.trim()).filter(Boolean);

  if (parts.length > 1) {
    return parts.map((p) => `<p class="tafsir-paragraph">${p}</p>`).join("");
  }

  // fallback: split by dot-ish (best effort)
  const sentences = normalized.match(/[^.]+(?:\.)?/g)?.map((s) => s.trim()).filter(Boolean) || [normalized];
  return sentences.map((s) => `<p class="tafsir-paragraph">${s}</p>`).join("");
}

function updateBasmalaUI(surahNo, ayahNo) {
  if (!tafsirBasmala) return;
  const basmala = getAyahBasmalaFromQuran(surahNo, ayahNo);
  if (ayahNo === 1 && basmala) {
    tafsirBasmala.innerHTML = wrapTashkeelWords(escapeHtml(basmala));
    tafsirBasmala.classList.add("is-visible");
    tafsirBasmala.setAttribute("aria-hidden", "false");
  } else {
    tafsirBasmala.innerHTML = "";
    tafsirBasmala.classList.remove("is-visible");
    tafsirBasmala.setAttribute("aria-hidden", "true");
  }
}

/* ── ISSUE 2: ONE quiet treatment for every tafsir-box content change ────
 * The box's content lands in two moments (loading row right away, the
 * fetched tafsir ~100-300ms later) — previously the second moment SNAPPED
 * the panel height mid page-crossfade (+95px measured) and, on slow
 * fetches, replayed the 450ms .tafsir-swap as a second competing motion.
 * Now every change goes through this helper: the box's height EASES from
 * its current value to the new content's height while the content fades
 * in — identical every time, no snap, no double animation. One small
 * element, one-shot CSS transition (the round-3 jank was per-frame JS
 * height work on the whole panel — this is neither). */
let TAFSIR_BOX_ANIM_TIMER = null;

function setTafsirBoxContent(html) {
  if (!tafsirBox) return;
  if (TAFSIR_BOX_ANIM_TIMER) { clearTimeout(TAFSIR_BOX_ANIM_TIMER); TAFSIR_BOX_ANIM_TIMER = null; }
  if (prefersReducedMotion()) {
    tafsirBox.style.transition = "";
    tafsirBox.style.height = "";
    tafsirBox.style.opacity = "";
    tafsirBox.style.overflow = "auto"; // in case a cancelled run left it shut
    tafsirBox.innerHTML = html;
    return;
  }
  const oldH = tafsirBox.offsetHeight; // mid-animation value if retargeting
  tafsirBox.style.transition = "none";
  tafsirBox.style.height = "";         // natural height for the measure
  tafsirBox.innerHTML = html;
  tafsirBox.style.opacity = "0";
  const newH = tafsirBox.offsetHeight; // capped by the box's max-height
  const animateH = Math.abs(newH - oldH) > 2;
  if (animateH) {
    tafsirBox.style.height = `${oldH}px`;
    // While the height eases, the content transiently overflows the
    // animating box — overflow:auto would flash a scrollbar (with a
    // visibly changing thumb) on every page switch. Hold it shut for the
    // 220ms and restore the markup's auto after.
    tafsirBox.style.overflow = "hidden";
  }
  void tafsirBox.offsetWidth;          // commit the start state
  tafsirBox.style.transition =
    "height 220ms cubic-bezier(0.22, 1, 0.36, 1), opacity 180ms ease";
  if (animateH) tafsirBox.style.height = `${newH}px`;
  tafsirBox.style.opacity = "1";
  TAFSIR_BOX_ANIM_TIMER = setTimeout(() => {
    TAFSIR_BOX_ANIM_TIMER = null;
    tafsirBox.style.transition = "";
    tafsirBox.style.height = "";       // back to auto (content may rewrap)
    tafsirBox.style.opacity = "";
    tafsirBox.style.overflow = "auto"; // the markup's inline value
  }, 260);
}

async function updateTafsirUI(surahNo, ayahNo) {
  const reqId = ++TAFSIR_REQUEST_ID; // increment request ID

  // Cancel any in-flight background request
  if (SECONDARY_TAFSIR_ABORT) {
    SECONDARY_TAFSIR_ABORT.abort();
    SECONDARY_TAFSIR_ABORT = null;
  }

  const surahName = SURAH_META.find((x) => x.number === surahNo)?.name_ar || `سورة ${surahNo}`;
  tafsirHeader.textContent = `${surahName} — الآية ${ayahNo}`;

  const tafKey = tafsirSelect?.value || "muyassar";
  const pack = TAFSIRS[tafKey];

  tafsirTitle.textContent = pack?.label || "—";
  if (tafsirDesc) {
    tafsirDesc.textContent = TAFSIR_DESCRIPTIONS[tafKey] || "—";
  }
  // Close the description popover when the tafsir/ayah changes
  closeTafsirDescPopover();
  // Keep the custom dropdown label in sync (covers programmatic value changes)
  syncTafsirDropdownLabel();
  if (tafsirMetaInterpreter) {
    tafsirMetaInterpreter.innerHTML = `<span class="dot"></span> ${escapeHtml(pack?.shortLabel || pack?.label || "نص التفسير")}`;
  }

  const ayahText = getAyahTextFromQuran(surahNo, ayahNo);
  if (tafsirAyahTag) {
    tafsirAyahTag.innerHTML = ayahText ? wrapTashkeelWords(escapeHtml(ayahText)) : "—";
    tafsirAyahTag.classList.toggle("is-hidden", !ayahText);
    // Re-fire the tafsir-swap animation NOW (sync with the innerHTML change)
    // so the ayah text fades in smoothly. Previously the swap was applied
    // only after the async loadPrimaryTafsir below — which made the text
    // snap to the new ayah and then fade in late, feeling jerky during
    // continuous-mode auto-advance. The tafsirBox swap stays after the
    // async load because its content updates then.
    // Suppressed while the page-slide carries the change — two competing
    // motions (sideways page + inner fade-up) read as jank.
    tafsirAyahTag.classList.remove("tafsir-swap");
    if (!TAFSIR_SLIDE_ACTIVE) {
      requestAnimationFrame(() => tafsirAyahTag.classList.add("tafsir-swap"));
    }
  }

  updateBasmalaUI(surahNo, ayahNo);

  // =====================================================
  // PHASE A: Load SELECTED tafsir immediately
  // =====================================================
  const selectedKey = tafKey; // The tafsir user selected from dropdown
  const cacheKey = `${surahNo}:${ayahNo}:${selectedKey}`;
  const isCached = !!getTafsirCache(cacheKey);

  if (!isCached) {
    setTafsirBoxContent('<div class="tafsir-loading" style="padding:2rem;text-align:center;color:#888;">جاري التحميل...</div>');
  }

  // Await selected tafsir (fast, blocking)
  const selectedText = await loadPrimaryTafsir(surahNo, ayahNo, selectedKey);

  // Race condition guard
  if (reqId !== TAFSIR_REQUEST_ID) return;

  // Render selected tafsir immediately
  if (!selectedText) {
    // Distinguish "no connection" from "this ayah has no tafsir" using whether
    // the lookup actually failed to reach a source (reliable in the WebView,
    // unlike navigator.onLine). Only show the offline message when detected.
    const emptyMsg = TAFSIR_FETCH_NETWORK_ERROR
      ? OFFLINE_MESSAGE
      : "لا يوجد تفسير لهذا المفسّر لهذه الآية.";
    setTafsirBoxContent(`<div class="tafsir-empty">${emptyMsg}</div>`);
  } else {
    setTafsirBoxContent(formatTafsirText(selectedText, surahNo, ayahNo));
  }

  if (tafsirMetaAyah) tafsirMetaAyah.textContent = `${surahNo}:${ayahNo}`;

  // ISSUE 2: the box's own .tafsir-swap replay is retired — the height-
  // eased fade inside setTafsirBoxContent IS the box's animation now,
  // identical on every path (loading, cached, fetched, empty, offline).
  // Only the residue class is cleared so old runs can't re-trigger.
  tafsirBox?.classList.remove("tafsir-swap");

  // =====================================================
  // PHASE B: Load secondary tafsirs in background
  // =====================================================
  loadSecondaryTafsirs(surahNo, ayahNo, reqId);
}

/**
 * Phase A: Load primary tafsir (muyassar) - blocking
 */
async function loadPrimaryTafsir(surah, ayah, key = PRIMARY_TAFSIR) {
  return await fetchTafsirFromAPI(surah, ayah, key);
}

/**
 * Phase B: Load secondary tafsirs in background - non-blocking
 * Uses AbortController to cancel if ayah changes
 */
async function loadSecondaryTafsirs(surah, ayah, requestId) {
  // App offline: skip the eager batch prefetch. Pulling all 6 secondary books
  // would parse ~100 MB of JSON into memory at once; instead each book is read
  // lazily (and LRU-cached) the first time the user switches to it in the
  // dropdown — see getOfflineTafsir in fetchTafsirFromAPI.
  if (tafsirIsReady()) return;

  // Create AbortController for this request
  SECONDARY_TAFSIR_ABORT = new AbortController();
  const signal = SECONDARY_TAFSIR_ABORT.signal;

  // Don't block - fire and forget
  try {
    const url = `${API_ROOT}/tafsir`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ surah: Number(surah), ayah: Number(ayah), tafsirs: SECONDARY_TAFSIRS }),
      signal
    });

    // Check if request was aborted or ayah changed
    if (signal.aborted || requestId !== TAFSIR_REQUEST_ID) return;

    if (!res.ok) {
      console.warn("Secondary tafsirs fetch failed", res.status);
      return;
    }

    const data = await res.json();

    // Check again after JSON parsing
    if (signal.aborted || requestId !== TAFSIR_REQUEST_ID) return;

    if (data.status === "ok" && data.tafsirs) {
      // Cache all secondary tafsirs (localStorage + in-memory)
      for (const [k, txt] of Object.entries(data.tafsirs)) {
        if (txt && txt !== "N/A") {
          setTafsirCache(`${surah}:${ayah}:${k}`, txt);
        }
      }
    }
  } catch (e) {
    if (e.name === "AbortError") {
      // Expected when ayah changes - silently ignore
      return;
    }
    console.error("Secondary tafsirs fetch error:", e);
  } finally {
    // Clear controller if this was the active one
    if (SECONDARY_TAFSIR_ABORT?.signal === signal) {
      SECONDARY_TAFSIR_ABORT = null;
    }
  }
}

function updateNavButtons(surahNo, ayahNo) {
  const disabled = !Number.isFinite(surahNo) || !Number.isFinite(ayahNo);
  prevAyahBtn.disabled = disabled;
  nextAyahBtn.disabled = disabled;
  updateCompareButtonState();
}

function updateCompareButtonState() {
  if (!compareTafsirsBtn) return;
  const hasAyah = !!CURRENT && Number.isFinite(CURRENT.s) && Number.isFinite(CURRENT.a);
  compareTafsirsBtn.disabled = !hasAyah || !!COMPARE_ABORT;
}

function setVersePanelOpen(open) {
  VERSES_OPEN = !!open;
  versePanel?.classList.toggle("is-open", VERSES_OPEN);
  versePanel?.setAttribute("aria-hidden", VERSES_OPEN ? "false" : "true");
  toggleVersesBtn?.setAttribute("aria-expanded", VERSES_OPEN ? "true" : "false");
}

function stepAyah(delta) {
  if (!CURRENT) return;
  const surah = QURAN?.surahs?.find((s) => s.number === CURRENT.s);
  if (!surah) return;

  const next = CURRENT.a + delta;
  if (next < 1 || next > surah.ayahs.length) return;

  setPrimaryAyah(CURRENT.s, next, { scroll: false });
}

/* ---------------- Tafsir compare ---------------- */
function setComparePanelVisible(visible) {
  if (!tafsirComparePanel) return;
  tafsirComparePanel.classList.toggle("hidden", !visible);
  tafsirComparePanel.setAttribute("aria-hidden", visible ? "false" : "true");
}

function setCompareExpanded(_expanded) {
  tafsirComparePanel?.classList.add("is-expanded");
}

function setCompareStopVisible(visible, isResumeMode = false) {
  if (!compareStopBtn) return;

  if (isResumeMode) {
    // Show as resume button
    compareStopBtn.classList.remove("hidden");
    compareStopBtn.textContent = "إستئناف";
    COMPARE_STOPPED = true;
  } else if (visible) {
    // Show as stop button
    compareStopBtn.classList.remove("hidden");
    compareStopBtn.textContent = "إيقاف";
    COMPARE_STOPPED = false;
  } else {
    // Hide button
    compareStopBtn.classList.add("hidden");
    COMPARE_STOPPED = false;
  }
}

function setCompareCollapsed(collapsed) {
  COMPARE_COLLAPSED = !!collapsed;
  if (tafsirCompareScroll) {
    tafsirCompareScroll.style.display = COMPARE_COLLAPSED ? "none" : "";
  }
  if (tafsirCompareStatus) {
    tafsirCompareStatus.style.display = COMPARE_COLLAPSED ? "none" : "";
  }
  // Rotate the toggle icon to indicate collapsed/expanded state
  const toggleIcon = document.getElementById("compareToggleIcon");
  if (toggleIcon) {
    toggleIcon.style.transform = COMPARE_COLLAPSED ? "rotate(180deg)" : "rotate(0deg)";
  }
}

function setCompareStatus(text = "", type = "", { loading = false } = {}) {
  if (!tafsirCompareStatus || !tafsirCompareStatusText) return;
  tafsirCompareStatusText.textContent = text;
  tafsirCompareStatus.classList.remove("text-slate-500", "text-rose-600", "text-emerald-600");
  if (!text && !loading) {
    tafsirCompareStatus.classList.add("hidden");
    tafsirCompareStatus.style.display = "none";
    if (tafsirCompareScroll) tafsirCompareScroll.style.marginTop = "10px";
  } else {
    tafsirCompareStatus.classList.remove("hidden");
    tafsirCompareStatus.style.display = "";
    if (tafsirCompareScroll) tafsirCompareScroll.style.marginTop = "";
  }
  if (type === "error") {
    tafsirCompareStatus.classList.add("text-rose-600");
  } else if (type === "ok") {
    tafsirCompareStatus.classList.add("text-emerald-600");
  } else {
    tafsirCompareStatus.classList.add("text-slate-500");
  }
  if (COMPARE_COLLAPSED) {
    tafsirCompareStatus.style.display = "none";
    if (tafsirCompareScroll) tafsirCompareScroll.style.display = "none";
  }
  if (tafsirCompareSpinner) tafsirCompareSpinner.classList.toggle("hidden", !loading);
}

function setCompareMessage(message, tone = "muted") {
  if (!tafsirCompareContent) return;
  const toneClass = tone === "error" ? "text-rose-600" : "text-slate-600";
  tafsirCompareContent.innerHTML = `<p class="text-sm font-semibold ${toneClass}">${escapeHtml(message)}</p>`;
}

function formatCompareTextToHtml(text = "") {
  const cleaned = cleanAiText(String(text || ""));
  if (!cleaned) return "";
  const lines = cleaned.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return "";

  const htmlParts = [];
  let listItems = [];

  const flushList = () => {
    if (!listItems.length) return;
    htmlParts.push(`<ul class="mt-2 space-y-2">${listItems
      .map((item) => `<li class="flex items-start gap-2 text-sm leading-6"><span class="mt-1 ai-bullet">&bull;</span><span>${formatAiInline(item)}</span></li>`)
      .join("")}</ul>`);
    listItems = [];
  };

  const addHeading = (textLine) => {
    const heading = formatAiInline(textLine);
    htmlParts.push(`<h4 class="${htmlParts.length ? "mt-4 " : ""}text-sm font-extrabold text-slate-700">${heading}</h4>`);
  };

  const addParagraph = (textLine) => {
    htmlParts.push(`<p class="mt-2 text-sm leading-7">${formatAiInline(textLine)}</p>`);
  };

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,3})\s*(.+)$/);
    if (headingMatch) {
      flushList();
      addHeading(headingMatch[2]);
      continue;
    }

    const bulletMatch = line.match(/^[-*•]\s+(.+)/);
    if (bulletMatch) {
      listItems.push(bulletMatch[1]);
      continue;
    }

    const numberedMatch = line.match(/^\d+[.)]\s+(.+)/);
    if (numberedMatch) {
      listItems.push(numberedMatch[1]);
      continue;
    }

    const colonHeading = line.match(/^(.+?)([:：؛])$/);
    if (colonHeading && line.length <= 80) {
      flushList();
      addHeading(colonHeading[1]);
      continue;
    }

    flushList();
    addParagraph(line);
  }

  flushList();
  return htmlParts.join("");
}

function renderCompareText(text = "", { streaming = false, typewriter = true } = {}) {
  if (!tafsirCompareContent) return;

  const cleaned = cleanAiText(String(text || ""));

  // 1. Format Bold text (**text**) and newlines
  let formattedHtml = formatAiInline(cleaned).replace(/\n/g, "<br>");

  // 2. Format curly braces {} with blue coloring
  formattedHtml = formattedHtml.replace(/\{([^{}]+)\}/g, `<span class="tafsir-brace quran-font">{$1}</span>`);

  // 2. Create container with formatting already applied
  const container = document.createElement("div");
  container.className = "fade-in text-[15px] leading-8 text-slate-800 font-normal show";
  container.setAttribute("dir", "auto");
  container.style.fontFamily = "'Outfit', sans-serif";
  container.style.whiteSpace = "pre-wrap";

  tafsirCompareContent.innerHTML = "";
  tafsirCompareContent.appendChild(container);
  if (tafsirCompareScroll) tafsirCompareScroll.style.marginTop = "10px";

  // 3. Word-by-word animation - words added progressively (no per-word fade)
  if (typewriter && !streaming) {
    // Parse HTML into tokens (words, whitespace, elements)
    const temp = document.createElement("div");
    temp.innerHTML = formattedHtml;

    const tokens = [];

    const extractTokens = (node, parentTags = []) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent || "";
        const parts = text.split(/(\s+)/);
        for (const part of parts) {
          if (part) {
            tokens.push({ type: "text", content: part, tags: [...parentTags] });
          }
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tagName = node.tagName.toLowerCase();
        if (tagName === "br") {
          tokens.push({ type: "br" });
        } else {
          const newTags = [...parentTags, { tag: tagName, attrs: node.attributes }];
          for (const child of Array.from(node.childNodes)) {
            extractTokens(child, newTags);
          }
        }
      }
    };

    for (const child of Array.from(temp.childNodes)) {
      extractTokens(child);
    }

    // Build DOM progressively
    let tokenIndex = 0;
    const totalTokens = tokens.length;
    // Speed: ~30-50ms per token for smooth word-by-word
    const msPerToken = Math.max(30, Math.min(50, 3000 / Math.max(totalTokens, 1)));

    // Helper to wrap text in parent tags
    const wrapInTags = (text, tags) => {
      let node = document.createTextNode(text);
      for (let i = tags.length - 1; i >= 0; i--) {
        const wrapper = document.createElement(tags[i].tag);
        if (tags[i].attrs) {
          for (const attr of tags[i].attrs) {
            wrapper.setAttribute(attr.name, attr.value);
          }
        }
        wrapper.appendChild(node);
        node = wrapper;
      }
      return node;
    };

    const addNextToken = () => {
      // Check if paused
      if (COMPARE_WRITE_PAUSED) {
        // Store resume function and return
        COMPARE_WRITE_RESUME_FN = addNextToken;
        return;
      }

      if (tokenIndex >= totalTokens) {
        // Animation complete - hide pause button
        if (compareWritePauseBtn) compareWritePauseBtn.classList.add("hidden");
        COMPARE_WRITE_RESUME_FN = null;
        return;
      }

      const token = tokens[tokenIndex];

      if (token.type === "br") {
        container.appendChild(document.createElement("br"));
      } else if (token.type === "text") {
        const node = wrapInTags(token.content, token.tags);
        // Just add - no fade animation
        container.appendChild(node);
      }

      tokenIndex++;

      if (tokenIndex < totalTokens) {
        setTimeout(addNextToken, msPerToken);
      } else {
        // Animation complete - hide pause button
        if (compareWritePauseBtn) compareWritePauseBtn.classList.add("hidden");
        COMPARE_WRITE_RESUME_FN = null;
      }
    };

    // Reset pause state and show button
    COMPARE_WRITE_PAUSED = false;
    COMPARE_WRITE_RESUME_FN = null;
    if (compareWritePauseBtn) {
      compareWritePauseBtn.classList.remove("hidden");
      compareWritePauseBtn.textContent = "إيقاف";
    }

    // Start animation
    setTimeout(addNextToken, 50);
  } else {
    // No typewriter - show immediately
    container.innerHTML = formattedHtml;
  }

  if (!streaming) {
    applyCompareFadeIn();
  }
}

function extractCompareText(obj) {
  const seen = new WeakSet();
  const walk = (node) => {
    if (!node) return "";
    if (typeof node === "string") return node;
    if (typeof node !== "object") return "";
    if (seen.has(node)) return "";
    seen.add(node);

    const directKeys = [
      "arabic_answer",
      "english_answer",
      "raw_text",
      "comparison_text",
      "comparison",
      "text",
      "answer",
      "result",
      "response",
    ];
    for (const key of directKeys) {
      const value = node[key];
      if (typeof value === "string" && value.trim()) return value;
    }

    const nestedKeys = ["data", "payload", "output", "response", "message"];
    for (const key of nestedKeys) {
      const value = node[key];
      if (!value) continue;
      const nested = walk(value);
      if (nested) return nested;
    }
    return "";
  };
  return walk(obj);
}

async function buildComparePayload(surahNo, ayahNo) {
  const keys = Object.keys(TAFSIRS || {});

  // Batch fetch any missing tafsirs
  await fetchTafsirsBatch(surahNo, ayahNo, keys);

  const tafsirs = [];
  for (const key of keys) {
    const pack = TAFSIRS[key];
    // Now look up in cache (synchronous - checks localStorage too)
    const rawText = getTafsirCache(`${surahNo}:${ayahNo}:${key}`) || "";

    const norm = typeof normalizeTafsirText === "function" ? normalizeTafsirText(rawText) : (rawText || "");
    const text = trimForCompare(norm);
    if (!text) continue;

    tafsirs.push({
      key,
      label: pack?.label || pack?.shortLabel || key,
      text,
    });
  }
  return {
    response_style: "concise",
    verse: {
      surah: surahNo,
      ayah: ayahNo,
      text: getAyahTextFromQuran(surahNo, ayahNo) || "",
    },
    ayahKey: `${surahNo}:${ayahNo}`,
    tafsirs,
  };
}

async function runCompare(payload, abortController) {
  let response;
  try {
    response = await fetch(COMPARE_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(payload),
      keepalive: false,
      signal: abortController.signal,
    });
  } catch (err) {
    if (String(err).includes("AbortError")) throw err;
    const offline = !navigator.onLine || err?.name === "TypeError";
    return { ok: false, offline };
  }

  if (!response.ok) {
    let bodyText = "";
    try { bodyText = await response.text(); } catch (err) {
      if (String(err).includes("AbortError")) throw err;
    }
    console.error("Compare failed:", response.status, bodyText);
    const offline = !navigator.onLine || response.status === 0 || response.type === "opaque";
    return { ok: false, offline };
  }

  let data = null;
  try {
    data = await response.json();
  } catch (err) {
    console.error("Compare failed to parse JSON:", err);
    return { ok: false, offline: false };
  }
  if (data && data.ok === false) {
    console.error("Compare error:", data);
    return { ok: false, offline: false };
  }

  const text = extractCompareText(data);
  if (!text) return { ok: false, offline: false };
  setCompareCache(payload.ayahKey, text);
  renderCompareText(text);
  setCompareStatus("", "", { loading: false });
  return { ok: true, offline: false };
}
/* Show the مختصر التفاسير loading spinner briefly, then render — so instant
 * (cached / offline) results still get the same loading feedback as the live
 * web fetch instead of popping in abruptly. Bails if the ayah changed meanwhile. */
async function renderCompareWithSpinner(text, ayahKey) {
  setComparePanelVisible(true);
  setCompareExpanded(false);
  setCompareCollapsed(false);
  setCompareStopVisible(false);
  setCompareStatus("جاري إنشاء المقارنة...", "", { loading: true });
  if (tafsirCompareContent) tafsirCompareContent.textContent = "";
  updateCompareButtonState();

  await new Promise((r) => setTimeout(r, 700));
  // If the user navigated to another ayah during the delay, don't render stale text.
  if (!CURRENT || `${CURRENT.s}:${CURRENT.a}` !== ayahKey) return;

  setCompareStatus("", "");
  renderCompareText(text);
  updateCompareButtonState();
}

async function handleCompareTafsirs() {
  // Fade out audio smoothly when opening tafsir summary
  if (AUDIO_PLAYING) fadeOutAndStopAudio(600);

  // Offline website (or app not yet downloaded): nothing to show.
  if (!navigator.onLine && !tafsirIsReady()) {
    if (COMPARE_ABORT) {
      COMPARE_ABORT.abort();
      COMPARE_ABORT = null;
    }
    setComparePanelVisible(true);
    setCompareExpanded(false);
    setCompareCollapsed(false);
    setCompareStopVisible(false);
    setCompareStatus(OFFLINE_COMPARE_MESSAGE, "error");
    setCompareMessage(OFFLINE_COMPARE_MESSAGE, "error");
    updateCompareButtonState();
    return;
  }
  if (!CURRENT) return;
  const surahNo = CURRENT.s;
  const ayahNo = CURRENT.a;

  // ✅ CHECK CACHE FIRST - Skip API call if already cached
  const ayahKey = `${surahNo}:${ayahNo}`;
  const cached = getCompareCache(ayahKey);
  if (cached) {
    await renderCompareWithSpinner(cached, ayahKey);
    return;
  }

  // App offline path: read the pre-generated summary from the cached
  // comparisons.json instead of calling /compare-text.
  if (tafsirIsReady()) {
    const summary = await getOfflineComparison(surahNo, ayahNo);
    if (summary) {
      setCompareCache(ayahKey, summary);
      await renderCompareWithSpinner(summary, ayahKey);
      return;
    }
    // No summary cached for this ayah. When offline, stop here; when online,
    // fall through to the live /compare-text call below.
    if (!navigator.onLine) {
      setComparePanelVisible(true);
      setCompareExpanded(false);
      setCompareCollapsed(false);
      setCompareStopVisible(false);
      setCompareStatus(OFFLINE_MESSAGE, "error");
      updateCompareButtonState();
      return;
    }
  }

  if (typeof window.gtag === "function") {
    window.gtag("event", "compare_tafsirs_click", {
      ayah: `${surahNo}:${ayahNo}`,
    });
  }

  setComparePanelVisible(true);
  setCompareExpanded(false);
  setCompareCollapsed(false);
  setCompareStatus("جاري إنشاء المقارنة...", "", { loading: true });
  setCompareStopVisible(false);
  if (tafsirCompareContent) tafsirCompareContent.textContent = "";

  // Cancel any previous request
  if (COMPARE_ABORT) {
    COMPARE_ABORT.abort();
    COMPARE_ABORT = null;
  }
  const abortController = new AbortController();
  COMPARE_ABORT = abortController;
  updateCompareButtonState();

  try {
    // Try fetching pre-computed comparison from /compare-text
    const url = `${API_ROOT}/compare-text`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ surah: surahNo, ayah: ayahNo }),
      signal: abortController.signal
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();

    if (data.status === "ok" && data.comparison_text) {
      // Add smooth artificial delay for realistic feel (random 1-1.5 seconds)
      const randomDelay = 1000 + Math.random() * 500;
      await new Promise(resolve => setTimeout(resolve, randomDelay));

      // Check if request was aborted during delay
      if (abortController.signal.aborted) return;

      // Fade out the status text smoothly
      const statusEl = document.getElementById("tafsirCompareStatus");
      if (statusEl) {
        statusEl.style.transition = "opacity 0.3s ease";
        statusEl.style.opacity = "0";
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      // Check abort again after fade
      if (abortController.signal.aborted) return;

      // Pre-computed comparison found - render it
      setCompareStatus("", "");
      if (statusEl) statusEl.style.opacity = "1"; // Reset for future use
      renderCompareText(data.comparison_text);
      updateCompareButtonState();
      return;
    } else if (data.status === "not_found") {
      // No pre-computed comparison available
      setCompareStatus("المقارنة غير متوفرة لهذه الآية بعد", "warning");
      updateCompareButtonState();
      return;
    } else {
      // Unexpected response
      setCompareStatus("تعذر تحميل المقارنة", "error");
    }
  } catch (err) {
    if (String(err).includes("AbortError")) {
      setCompareStatus("تم إيقاف المقارنة.", "error");
      return;
    }
    console.error("Compare-text fetch error:", err);
    // A thrown fetch (TypeError / "Failed to fetch") means no connection —
    // navigator.onLine is unreliable in the WebView, so detect it from the error.
    const noConnection = !navigator.onLine
      || err instanceof TypeError
      || /Failed to fetch|NetworkError|Load failed/i.test(String(err));
    if (noConnection) {
      setCompareStatus(OFFLINE_COMPARE_MESSAGE, "error");
    } else {
      setCompareStatus("تعذر إجراء المقارنة الآن، حاول مرة أخرى.", "error");
    }
  } finally {
    COMPARE_ABORT = null;
    updateCompareButtonState();
  }
}

function resetComparePanel({ hide = true, silent = false } = {}) {
  if (COMPARE_ABORT) {
    COMPARE_ABORT.abort();
    COMPARE_ABORT = null;
  }
  if (tafsirCompareContent) tafsirCompareContent.innerHTML = "";
  if (!silent) setCompareStatus("", "");
  setCompareStopVisible(false);
  setCompareCollapsed(false);
  setCompareExpanded(false);
  if (hide) setComparePanelVisible(false);
  updateCompareButtonState();
}

/* ---------------- URL + SEO ---------------- */
function getAyahParamFromUrl() {
  const u = new URL(window.location.href);

  // Pattern 1: New clean URL format /surah/ayah
  const pathMatch = u.pathname.match(/^\/([0-9]+)\/([0-9]+)\/?$/);
  if (pathMatch) {
    const s = Number(pathMatch[1]), a = Number(pathMatch[2]);
    if (Number.isFinite(s) && Number.isFinite(a) && s >= 1 && a >= 1) {
      return { s, a };
    }
  }

  // Pattern 2: Old query format ?v=surah-ayah (for backward compatibility)
  const raw = (u.searchParams.get("v") || u.searchParams.get("ayah") || "").trim();
  if (raw) {
    const m = raw.match(/^(\d{1,3})\s*[:\-\/]\s*(\d{1,3})$/);
    if (m) {
      const s = Number(m[1]), a = Number(m[2]);
      if (Number.isFinite(s) && Number.isFinite(a) && s >= 1 && a >= 1) {
        return { s, a };
      }
    }
  }

  // Pattern 3: Check for redirect from 404 page
  if (window._redirectedAyah) {
    const { surah, ayah } = window._redirectedAyah;
    const s = Number(surah), a = Number(ayah);
    if (Number.isFinite(s) && Number.isFinite(a) && s >= 1 && a >= 1) {
      window._redirectedAyah = null;
      return { s, a };
    }
  }

  return null;
}

function updateSeoMetaForAyah(surahNo, ayahNo) {
  const base = "https://www.m7mdiyat.com";
  const ayahUrl = `${base}/${surahNo}/${ayahNo}`;
  canonicalLink?.setAttribute("href", ayahUrl);
  ogUrl?.setAttribute("content", ayahUrl);

  // Always try to get Surah name first
  const surahName =
    SURAH_META.find((x) => x.number === surahNo)?.name_ar ||
    (QURAN && QURAN.surahs?.find((s) => s.number === surahNo)?.name_ar) ||
    `سورة ${surahNo}`;

  // Use Surah NAME (not number) in title - single "محمديات" at end
  const title = `تفسير سورة ${surahName} آية ${ayahNo} | محمديات`;

  // Build description with Ayah snippet if available
  let desc = `شرح وتفسير سورة ${surahName} آية ${ayahNo}.`;
  if (QURAN) {
    const ayahText = (getAyahTextFromQuran(surahNo, ayahNo) || "").replace(/\s+/g, " ").trim();
    const snippet = ayahText.length > 140 ? ayahText.slice(0, 140) + "…" : ayahText;
    if (snippet) {
      desc = `شرح وتفسير سورة ${surahName} آية ${ayahNo}. نص الآية: ${snippet}`;
    }
  }

  pageTitle && (pageTitle.textContent = title);
  metaDescription?.setAttribute("content", desc);
  ogTitle?.setAttribute("content", title);
  ogDesc?.setAttribute("content", desc);
  twTitle?.setAttribute("content", title);
  twDesc?.setAttribute("content", desc);
}

function setUrlForAyah(surahNo, ayahNo, { replace = false } = {}) {
  // Use clean URL format /surah/ayah
  const url = `/${surahNo}/${ayahNo}`;
  if (replace) history.replaceState({ s: surahNo, a: ayahNo }, "", url);
  else history.pushState({ s: surahNo, a: ayahNo }, "", url);
  updateSeoMetaForAyah(surahNo, ayahNo);
}

function resetSeoMetaToHome({ removeAyahParam = false } = {}) {
  let cleanUrl = null;
  if (removeAyahParam) {
    const u = new URL(window.location.href);
    u.searchParams.delete("v");
    u.searchParams.delete("ayah");
    cleanUrl = u.origin + u.pathname;
    history.replaceState({}, "", cleanUrl);
  }

  const canonical = cleanUrl || DEFAULT_SEO.canonical;
  const ogBase = cleanUrl || DEFAULT_SEO.ogUrl || canonical;

  pageTitle && (pageTitle.textContent = DEFAULT_SEO.title);
  metaDescription?.setAttribute("content", DEFAULT_SEO.desc);
  canonicalLink?.setAttribute("href", canonical);
  ogUrl?.setAttribute("content", ogBase);
  ogTitle?.setAttribute("content", DEFAULT_SEO.ogTitle || DEFAULT_SEO.title);
  ogDesc?.setAttribute("content", DEFAULT_SEO.ogDesc || DEFAULT_SEO.desc);
  twTitle?.setAttribute("content", DEFAULT_SEO.twTitle || DEFAULT_SEO.title);
  twDesc?.setAttribute("content", DEFAULT_SEO.twDesc || DEFAULT_SEO.desc);
}

/* ---------------- Primary select ---------------- */
/* Everything inside the ayah panel that must repaint for a new ayah. Split
 * out of setPrimaryAyah so the page-slide can snapshot the outgoing state
 * BEFORE the content swaps. */
function applyAyahPanelContent(surahNo, ayahNo) {
  showAyahContext(surahNo, ayahNo);
  updateTafsirUI(surahNo, ayahNo);
  updateNavButtons(surahNo, ayahNo);
  resetComparePanel({ hide: true, silent: true });
}

/* ── Round 5.2: Tafsir ayah→ayah PURE CROSSFADE ──────────────────────────
 * The outgoing page is snapshotted (cloneNode) and overlaid FIRST, the
 * heavy apply runs hidden behind that pixel-identical snapshot (the
 * screen never blanks — this is what killed the old "lag in the middle"),
 * then the snapshot simply fades away while the new page fades in.
 * Opacity ONLY: no translate, no blur, no height choreography — chrome
 * that is identical between ayahs overlaps pixel-exactly, so the eye sees
 * just the changed text dissolve. The clone keeps its descendant ids: it
 * sits AFTER the live page in tree order, so getElementById / el(...)
 * still resolve to the live elements, while CSS #id rules style the
 * snapshot identically. Rapid steps retarget the live (entering) page;
 * resets cancel cleanly. First reveal and the mode switch keep the
 * .t-panel-slide choreography — untouched. */
let TAFSIR_SWAP_TIMER = null;
let TAFSIR_SWAP_GHOST = null;
/* True for the whole swap lifecycle — updateTafsirUI reads it to suppress
 * the inner .tafsir-swap text animations (a second competing motion). */
let TAFSIR_SLIDE_ACTIVE = false;

function cancelTafsirSwap() {
  if (TAFSIR_SWAP_TIMER) { clearTimeout(TAFSIR_SWAP_TIMER); TAFSIR_SWAP_TIMER = null; }
  if (TAFSIR_SWAP_GHOST) { TAFSIR_SWAP_GHOST.remove(); TAFSIR_SWAP_GHOST = null; }
  TAFSIR_SLIDE_ACTIVE = false;
  el("tafsirPages")?.classList.remove("is-swapping");
  const cur = el("tafsirPageCurrent");
  if (cur) {
    // Snap to rest with no transition (cancel = instant, mid-flight or not).
    const prev = cur.style.transition;
    cur.style.transition = "none";
    cur.classList.remove("t-page-enter");
    void cur.offsetWidth;
    cur.style.transition = prev;
  }
}

function softSwapTafsir(applyContent) {
  const cur = el("tafsirPageCurrent");
  const pages = el("tafsirPages");
  if (!cur || !pages || prefersReducedMotion()) { applyContent(); return; }
  if (TAFSIR_SLIDE_ACTIVE) {
    // Mid-swap: retarget — the entering page simply becomes the newest
    // ayah (it keeps its in-flight fade; the snapshot keeps its exit).
    applyContent();
    return;
  }
  TAFSIR_SLIDE_ACTIVE = true;

  // 1. Pixel-identical snapshot of the outgoing page, overlaid on top.
  const ghost = cur.cloneNode(true);
  ghost.removeAttribute("id");
  ghost.className = "t-page-ghost";
  ghost.setAttribute("aria-hidden", "true");
  // cloneNode copies attributes, not live state — sync what a user can
  // actually see in the snapshot: the chosen selects (tafsir book,
  // translation language) and the tafsir box's scroll offset.
  const liveSelects = cur.querySelectorAll("select");
  ghost.querySelectorAll("select").forEach((s, i) => {
    if (liveSelects[i]) s.value = liveSelects[i].value;
  });
  pages.classList.add("is-swapping");
  pages.appendChild(ghost);
  TAFSIR_SWAP_GHOST = ghost;
  const liveBox = cur.querySelector("#tafsirBox");
  const ghostBox = ghost.querySelector("#tafsirBox");
  if (liveBox && ghostBox && liveBox.scrollTop) ghostBox.scrollTop = liveBox.scrollTop;

  // 2. The heavy apply runs NOW, hidden behind the snapshot — the screen
  //    keeps painting the identical clone, so there is no blank middle.
  cur.classList.add("t-page-enter"); // opacity 0, transition:none
  applyContent();

  // 3. Next frame: pure crossfade — the snapshot fades away while the new
  //    page fades in beneath it; the fade curves cross high, so combined
  //    visibility never dips and there is no perceivable hand-off.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (TAFSIR_SWAP_GHOST !== ghost) return; // cancelled / restarted
    ghost.classList.add("is-out");
    cur.classList.remove("t-page-enter");
  }));

  const total = Math.max(
    cssMs("--page-swap-out-dur", 320),
    cssMs("--page-swap-in-dur", 320)) + 80;
  TAFSIR_SWAP_TIMER = setTimeout(() => {
    TAFSIR_SWAP_TIMER = null;
    if (TAFSIR_SWAP_GHOST === ghost) { ghost.remove(); TAFSIR_SWAP_GHOST = null; }
    pages.classList.remove("is-swapping");
    TAFSIR_SLIDE_ACTIVE = false;
  }, total);
}

function setPrimaryAyah(surahNo, ayahNo, { replaceUrl = false, track = true, scroll = true, animate = true, skipAudioStop = false, panelReveal = "auto" } = {}) {
  // Engine playing the same surah → seek to the clicked ayah instead of
  // tearing down. Cross-surah clicks (or non-engine playback) fall through
  // to the existing stop-on-switch behavior.
  if (!skipAudioStop && surahAudio.isActive() &&
      surahAudio.getSurah() === surahNo &&
      surahAudio.getReciter() === CURRENT_RECITER) {
    surahAudio.play({ surah: surahNo, ayah: ayahNo, reciter: CURRENT_RECITER }).catch(() => { });
  } else if (!skipAudioStop) {
    stopAudio();
  }
  const prevAyah = CURRENT;
  CURRENT = { s: surahNo, a: ayahNo };
  // Round 5: the locked bar replaced the chip card as the selected-ayah
  // display — keep it tracking EVERY path that sets an ayah (search pick,
  // deep link, next/prev, popstate) so it never goes stale.
  reflectAyahInBar(surahNo, ayahNo);
  // Bug 2 hygiene: a stale results list whose only content is the
  // "لا توجد نتائج" empty-state block (left by a no-match search) must
  // never linger around — wipe it; real result cards stay.
  if (results && !results.querySelector(".result-card") && results.innerHTML !== "") {
    results.innerHTML = "";
    results.classList.add("is-empty", "collapsed");
    results.style.maxHeight = "0";
  }
  // Keep the search-pill surah selector's label (visible in both modes)
  // tracking the surah being read, and LAST_VIEWED_AYAH fresh for a later
  // toggle into Mushaf.
  noteTafsirViewedAyah(surahNo, ayahNo);
  // An ayah is now chosen → fade the search-pill border beam away (no-op
  // after the first time).
  deactivateSearchBeam();
  // Re-evaluate reciter restrictions for the new surah (auto-fallback off
  // a restricted reciter, refresh chip disabled states either way).
  enforceReciterForSurah(surahNo);
  setUrlForAyah(surahNo, ayahNo, { replace: replaceUrl });
  // Resume hook (app only — no-op on the website): every Tafsir-mode ayah
  // change captures the new position. Page is null in Tafsir mode.
  _recordResume({ mode: "tafsir", surah: surahNo, ayah: ayahNo, page: null });

  /* Ayah panel choreography:
   *   • first reveal → content applies, panel slides up/open (Task 3
   *     .t-panel-slide — UNCHANGED, as is the Task-7 mode switch);
   *   • ayah → ayah change while the panel is open → soft swap (round 5):
   *     gentle fade-out, swap while invisible, gentle fade-in;
   *   • panelReveal:"defer" → setAppMode's mode-switch choreography stages
   *     and opens the panel itself (Task 7);
   *   • animate:false / engine auto-advance (skipAudioStop) / same-ayah
   *     refresh → instant content update, panel stays put (the listening
   *     mode keeps its light inner tafsir-swap instead of pulsing the
   *     panel every few seconds).
   */
  const wasVisible = !!tafsirSection
    && !tafsirSection.classList.contains("hidden")
    && tafsirSection.dataset.open === "true";
  const ayahChanged = !prevAyah || prevAyah.s !== surahNo || prevAyah.a !== ayahNo;

  if (tafsirSection) {
    tafsirSection.classList.remove("is-hidden");
    tafsirSection.classList.remove("hidden");
  }

  if (!tafsirSection) {
    applyAyahPanelContent(surahNo, ayahNo);
  } else if (panelReveal === "defer") {
    cancelTafsirSwap();
    applyAyahPanelContent(surahNo, ayahNo);
    panelPrepare(tafsirSection);
  } else if (!wasVisible) {
    cancelTafsirSwap();
    applyAyahPanelContent(surahNo, ayahNo);
    if (animate && !prefersReducedMotion()) panelOpen(tafsirSection);
    else panelOpenInstant(tafsirSection);
  } else if (!animate || skipAudioStop || !ayahChanged || prefersReducedMotion()) {
    if (TAFSIR_SLIDE_ACTIVE) {
      // Mid-swap: route through the retarget path so a pending (older)
      // apply can't overwrite this newer content at exit-end.
      softSwapTafsir(() => applyAyahPanelContent(surahNo, ayahNo));
    } else {
      applyAyahPanelContent(surahNo, ayahNo);
    }
    panelOpenInstant(tafsirSection);
  } else {
    softSwapTafsir(() => applyAyahPanelContent(surahNo, ayahNo));
  }

  if (scroll) {
    try { tafsirSection?.scrollIntoView({ behavior: "smooth", block: "start" }); } catch { }
  }
}

function setSelected(surahNo, ayahNo) {
  // helper used by AI "open ayah"
  setPrimaryAyah(surahNo, ayahNo);
  // Bug 2: only re-open the results list when it holds REAL result cards —
  // expanding a list whose content is the stale "لا توجد نتائج" empty-state
  // would paint that block right under the chip/مسح area.
  if (results?.querySelector(".result-card")) expandResultsList();
}

/* ---------------- AI UI ---------------- */
function setAiStatus(text = "", type = "") {
  if (!aiStatus) return;
  aiStatus.textContent = text;
  aiStatus.className = "ai-status";
  if (type) aiStatus.classList.add(type);
}

function clearAiResults() {
  if (aiResults) aiResults.innerHTML = "";
}

function renderAiResults(data, opts = {}) {
  if (!aiResults) return;
  clearAiResults();
  stopAiTyping();
  const { streaming = false, streamText = "", sourcesLoading = false } = opts;

  const preferred = data?.best_ayah || null;
  const surah = Number(preferred?.surah ?? data?.surah);
  const ayah = Number(preferred?.ayah ?? data?.ayah);
  const hasAyah = Number.isFinite(surah) && Number.isFinite(ayah);

  const isAr = !!LAST_AI_IS_AR;
  const resultsArr = Array.isArray(data?.results) ? data.results : [];
  const ai = data?.ai || null;
  const resultBySourceId = buildResultSourceMap(resultsArr);
  const resultLookup = buildResultLookupMap(resultsArr);

  const mainAnswer = ai ? String(isAr ? (ai.arabic_answer || "") : (ai.english_answer || "")) : "";
  const keyPointsRaw = ai ? ai.key_points_ar : null;
  const diffsRaw = ai ? ai.tafsir_differences_ar : null;
  const answerScore = scoreTextMatch(String(mainAnswer || ""), LAST_AI_QUESTION, isAr);
  const termCount = extractTerms(LAST_AI_QUESTION, isAr).length;
  const relevanceThreshold = isAr ? (termCount <= 2 ? 0.3 : 0.45) : (termCount <= 2 ? 0.2 : 0.34);
  const isResultRelevant = (r) => Number(r?._score || 0) >= relevanceThreshold;
  const mode = isAr ? "ar" : "en";
  const answerIsRelevant = answerScore >= (isAr ? 0.2 : 0.1);
  const hasRelevantResult = resultsArr.some(isResultRelevant);
  const ayahText = hasAyah ? getAyahTextFromQuran(surah, ayah) : "";
  const basmala = ayahText ? getAyahBasmalaFromQuran(surah, ayah) : "";
  const verseTextRaw = ayahText ? (basmala ? `${basmala} ${ayahText}` : ayahText) : (data?.quran_text || "");
  const quranText = escapeHtml(filterTextByLanguage(cleanAiText(verseTextRaw), isAr ? "ar" : "en"));
  const quranTextHtml = quranText ? wrapTashkeelWords(quranText) : "";
  const showVerseCard = hasAyah && answerIsRelevant && hasRelevantResult && !!quranTextHtml;
  const answerText = streaming
    ? String(streamText || "")
    : (() => {
      const cleaned = cleanAiText(String(mainAnswer || ""));
      const filtered = filterTextByLanguage(cleaned, mode);
      return filtered || cleaned || "";
    })();
  const showEmptyAnswer = !streaming && !answerText;
  const emptyAnswer = isAr
    ? "تعذر استخراج إجابة دقيقة من المصادر المتاحة."
    : "Unable to extract a precise answer from the available sources.";

  const headerText = isAr ? "نتيجة الذكاء الاصطناعي" : "AI Result";
  const questionLabel = isAr ? "سؤالك" : "Your question";
  const answerLabel = isAr ? "الجواب" : "Answer";
  const pointsLabel = isAr ? "نقاط سريعة" : "Key points";
  const diffsLabel = isAr ? "فروق التفسير" : "Tafsir differences";
  const versesLabel = isAr ? "آيات ذات صلة" : "Relevant verses";
  const sourcesLabel = isAr ? "المصادر" : "Sources";

  const normalizeList = (items) => {
    if (Array.isArray(items)) return items;
    const str = String(items || "").trim();
    return str ? [str] : [];
  };

  const keyListHtml = (items) => {
    const list = normalizeList(items);
    if (!list.length) return "";
    return `<ul class="mt-3 space-y-2">${list
      .map((x) => {
        const filtered = filterTextByLanguage(cleanAiText(String(x)), isAr ? "ar" : "en");
        if (!filtered) return "";
        return `<li class="flex items-start gap-2 text-sm leading-6"><span class="mt-1 ai-bullet">&bull;</span><span>${formatAiInline(filtered)}</span></li>`;
      })
      .filter(Boolean)
      .join("")}</ul>`;
  };

  const keyPoints = normalizeList(keyPointsRaw);
  const differences = normalizeList(diffsRaw);


  const buildSourceLabel = (item) => {
    const raw = String(item?.source || item?.name || item?.tafsir || item?.book || "");
    const finalLabel = mapSourceNameToArabic(raw);
    const base = finalLabel || raw || (isAr ? "مصدر" : "Source");
    const key = normalizeSourceKey(raw);
    const isHadith = item?.kind === "hadith" || key.includes("bukhari") || key.includes("muslim");
    const num = isHadith ? getHadithNumber(item) : "";
    if (isBookResult(item)) {
      const title = mapSourceNameToArabic(getBookResultLabel(item));
      return localizeBooksLabel(title, isAr);
    }
    return num ? `${base} ${isAr ? "رقم" : "No."} ${num}` : base;
  };

  const seenBookTitles = new Set();
  const sourcesArr = resultsArr
    .map((r) => {
      const rawText = r?._cleanText || r?.text || r?.content || r?.matched_text || r?.snippet || "";
      const cleanedRaw = cleanAiText(String(rawText || ""));
      const { title, body } = extractTitleLine(cleanedRaw);
      const cleanedText = filterTextByLanguage(body, isAr ? "ar" : "en");
      const bookTitle = isBookResult(r) ? mapSourceNameToArabic(getBookResultLabel(r)) : "";
      return { ...r, _cleanText: cleanedText, _titleLine: title, _bookTitle: bookTitle };
    })
    .filter((r) => {
      if (!r._cleanText && !r._titleLine) return false;
      if (!isResultRelevant(r)) return false;
      if (!isBookResult(r)) return true;
      if (!r._bookTitle || r._bookTitle.length < 4) return false;
      const key = r._bookTitle.toLowerCase();
      if (seenBookTitles.has(key)) return false;
      seenBookTitles.add(key);
      return true;
    })
    .slice(0, 12);

  // Sources: show inside one expandable list
  const sourcesItems = sourcesArr
    .map((r) => {
      const sourceLabel = buildSourceLabel(r);
      const source = escapeHtml(sourceLabel);
      const cleanedText = r?._cleanText || "";
      const titleLine = r?._titleLine || "";
      const titleHtml = titleLine ? `<div class="text-xs font-bold text-slate-500 mb-2">${escapeHtml(titleLine)}</div>` : "";
      const text = looksLikeNoise(cleanedText) ? "" : formatAiInline(cleanedText).replace(/\n/g, "<br>");
      const bodyHtml = text || "<span class='text-slate-600'>—</span>";
      const sur = Number(r?.surah || r?.s);
      const ay = Number(r?.ayah || r?.a);
      const ref = Number.isFinite(sur) && Number.isFinite(ay) ? ` • ${sur}:${ay}` : "";
      return `
        <details class="rounded-2xl border border-black/10 bg-white/75 px-4 py-3">
          <summary class="cursor-pointer list-none flex items-center justify-between gap-3">
            <span class="text-sm font-extrabold text-slate-800">${source}<span class="text-xs font-bold text-slate-400">${ref}</span></span>
            <span class="text-slate-400">⌄</span>
          </summary>
          <div class="mt-3 text-sm leading-7 text-slate-700 ${r?.kind === "hadith" ? "hadith-font" : "quran-font"}">${titleHtml}${bodyHtml}</div>
        </details>
      `;
    })
    .join("");

  const citationsRaw = Array.isArray(ai?.citations) ? ai.citations : [];
  const citations = [];
  const seenCitationIds = new Set();
  for (const c of citationsRaw) {
    const rawId = String(c?.source_id || c?.source || "").trim();
    if (!rawId || seenCitationIds.has(rawId)) continue;
    const hit = resultLookup.get(rawId);
    if (!hit || !isResultRelevant(hit)) continue;
    seenCitationIds.add(rawId);
    citations.push(c);
  }
  const citationsHtml = citations.length
    ? `<details class="rounded-2xl border border-black/10 bg-white/75 px-4 py-3">
         <summary class="cursor-pointer list-none flex items-center justify-between gap-3">
           <span class="text-sm font-extrabold text-slate-800">${isAr ? "مراجع الملخص" : "Summary references"}</span>
           <span class="text-slate-400">⌄</span>
         </summary>
         <div class="mt-3 space-y-2">
           ${citations
      .map((c) => {
        const rawId = String(c?.source_id || c?.source || "");
        const src = formatCitationSource(rawId, resultBySourceId, isAr);
        const noteRaw = filterTextByLanguage(cleanAiText(String(c?.note || "")), isAr ? "ar" : "en");
        const note = noteRaw ? formatAiInline(noteRaw) : "";
        return `<div class="text-sm text-slate-700"><b>${escapeHtml(src || "مصدر")}</b>${note ? ` — <span class="text-slate-600">${note}</span>` : ""}</div>`;
      })
      .join("")}
         </div>
       </details>`
    : "";

  aiResults.innerHTML = `
    <div class="mx-auto max-w-4xl text-right">
      <div class="glass ai-card rounded-3xl p-6">
        <div class="ai-top">
          <div class="ai-title text-xs font-extrabold text-slate-600">${headerText}</div>
          ${hasAyah ? `<div class="ai-pill" dir="ltr">${surah}:${ayah}</div>` : ""}
        </div>

        <div class="ai-section ai-first">
          <div class="ai-label text-[11px] font-extrabold tracking-wide text-slate-400 uppercase">${questionLabel}</div>
          <div class="ai-body mt-2 text-xl font-extrabold text-slate-900">${escapeHtml(LAST_AI_QUESTION)}</div>
        </div>

        <div class="ai-section ai-answer-block">
          <div class="ai-label text-[11px] font-extrabold tracking-wide text-slate-400 uppercase">${answerLabel}</div>
          <div class="ai-body mt-2 ai-answer text-slate-800 leading-7 text-base">
            <div class="ai-answer-text">${showEmptyAnswer ? `<span class='text-slate-600'>${emptyAnswer}</span>` : ""}</div>
          </div>
        </div>
        ${keyPoints.length ? `
          <div class="ai-section">
            <div class="ai-label text-[11px] font-extrabold tracking-wide text-slate-400 uppercase">${pointsLabel}</div>
            ${keyListHtml(keyPoints)}
          </div>
        ` : ""}

        ${differences.length ? `
          <div class="ai-section">
            <div class="ai-label text-[11px] font-extrabold tracking-wide text-slate-400 uppercase">${diffsLabel}</div>
            ${keyListHtml(differences)}
          </div>
        ` : ""}

        ${showVerseCard ? `
          <div class="ai-section ai-verse-card rounded-3xl border border-black/10 bg-white/75 p-5">
            <div class="ai-label text-[11px] font-extrabold tracking-wide text-slate-400 uppercase">${versesLabel}</div>
            <div class="quran-font mt-3 text-2xl leading-[2.2] text-slate-900">${quranTextHtml}</div>
          </div>
        ` : ""}

        <div class="ai-section">
          <details class="rounded-3xl border border-black/10 bg-white/75 p-4">
            <summary class="cursor-pointer list-none flex items-center justify-between gap-3">
              <span class="text-sm font-extrabold text-slate-800">${sourcesLabel}</span>
              <span class="text-slate-400">⌄</span>
            </summary>

            <div class="mt-4 space-y-3">
              ${citationsHtml ? `<div>${citationsHtml}</div>` : ""}
              ${sourcesItems || `<div class="text-sm font-semibold text-slate-600">${sourcesLoading ? "Loading sources..." : (isAr ? "لا توجد مصادر." : "No sources.")}</div>`}
            </div>
          </details>
        </div>
      </div>
    </div>
  `;

  const answerEl = aiResults.querySelector(".ai-answer-text");
  if (answerEl) {
    if (streaming) {
      answerEl.textContent = answerText;
    } else if (answerText) {
      animateAiAnswer(answerEl, answerText, { forceAnimate: answerText.length < 220 });
    }
  }

  // no "open in tafsir" button
}


async function handleAiAsk() {
  const question = (aiQuestion?.value || "").trim();
  LAST_AI_QUESTION = question;
  LAST_AI_IS_AR = /[\u0600-\u06FF]/.test(question);
  if (!question) {
    setAiStatus("اكتب سؤالك أولاً", "error");
    clearAiResults();
    return;
  }
  if (AI_ABORT) AI_ABORT.abort();
  const abortController = new AbortController();
  AI_ABORT = abortController;
  LAST_AI_RETRIEVAL = null;

  aiAskBtn && (aiAskBtn.disabled = true);
  setAiStatus("Searching sources...", "loading");
  if (aiResults) {
    aiResults.innerHTML = `
      <div class="card">
        <div class="muted">AI Answer</div>
        <div style="margin-top:10px">
          <div class="skeleton-line"></div>
          <div class="skeleton-line"></div>
          <div class="skeleton-line short"></div>
        </div>
      </div>
    `;
  }

  let RAW_STREAM_TEXT = "";
  let streamAnswerEl = null;
  let streamRenderTimer = null;
  let lastRenderAt = 0;
  let hasShell = false;
  let streamingActive = true;

  const renderStreamShell = (dataForSources, sourcesLoading) => {
    if (streamRenderTimer) {
      clearTimeout(streamRenderTimer);
      streamRenderTimer = null;
    }
    renderAiResults(dataForSources || {}, { streaming: true, streamText: RAW_STREAM_TEXT, sourcesLoading });
    streamAnswerEl = aiResults?.querySelector(".ai-answer-text") || null;
    lastRenderAt = 0;
    hasShell = true;
  };

  const flushStreamText = () => {
    if (!streamingActive || !streamAnswerEl) return;
    streamAnswerEl.textContent = RAW_STREAM_TEXT;
    lastRenderAt = Date.now();
  };

  const scheduleStreamRender = () => {
    if (!streamingActive || !streamAnswerEl) return;
    const now = Date.now();
    const elapsed = now - lastRenderAt;
    if (elapsed >= 60) {
      flushStreamText();
      return;
    }
    if (!streamRenderTimer) {
      const delay = Math.max(0, 60 - elapsed);
      streamRenderTimer = setTimeout(() => {
        streamRenderTimer = null;
        flushStreamText();
      }, delay);
    }
  };

  try {
    const response = await fetch(`${TAFSIR_API_URL}?stream=1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
      body: JSON.stringify({ message: question, question }),
      keepalive: false,
      signal: abortController.signal,
    });

    if (!response.ok) {
      setAiStatus("Service unavailable, please try again.", "error");
      clearAiResults();
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      setAiStatus("Service unavailable, please try again.", "error");
      clearAiResults();
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let stopStream = false;

    const handleFrame = (frame) => {
      const lines = frame.split("\n");
      let eventType = "";
      const dataLines = [];
      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trim());
        }
      }
      if (!eventType) eventType = "chunk";
      const dataStr = dataLines.join("\n");
      let payload = null;
      if (dataStr) {
        try { payload = JSON.parse(dataStr); } catch { payload = { text: dataStr }; }
      }

      if (eventType === "meta") {
        if (payload?.stage === "retrieval" && payload?.retrieval) {
          LAST_AI_RETRIEVAL = sanitizeAiData(payload.retrieval, question, LAST_AI_IS_AR);
          renderStreamShell(LAST_AI_RETRIEVAL, false);
          setAiStatus("Generating answer...", "loading");
        }
        return;
      }

      if (eventType === "chunk") {
        const text = payload?.text || "";
        if (text) {
          RAW_STREAM_TEXT += text;
          if (!hasShell) {
            renderStreamShell(LAST_AI_RETRIEVAL || {}, !LAST_AI_RETRIEVAL);
          }
          scheduleStreamRender();
        }
        return;
      }
      if (eventType === "done") {
        const payloadObj = payload && typeof payload === "object" ? payload : {};
        const merged = { ...(LAST_AI_RETRIEVAL || {}), ...payloadObj };
        const data = sanitizeAiData(merged, question, LAST_AI_IS_AR);
        if (!data?.ai || typeof data.ai !== "object" || Array.isArray(data.ai)) {
          streamingActive = false;
          if (streamRenderTimer) {
            clearTimeout(streamRenderTimer);
            streamRenderTimer = null;
          }
          setAiStatus("AI response unavailable.", "error");
          clearAiResults();
          stopStream = true;
          return;
        }
        const resultsArr = Array.isArray(data?.results) ? data.results : [];
        if (data?.status === "not_found" || (resultsArr.length === 0 && !data?.quran_text)) {
          streamingActive = false;
          if (streamRenderTimer) {
            clearTimeout(streamRenderTimer);
            streamRenderTimer = null;
          }
          setAiStatus("\u0644\u0645 \u064a\u062a\u0645 \u0627\u0644\u0639\u062b\u0648\u0631 \u0639\u0644\u0649 \u062a\u0637\u0627\u0628\u0642", "error");
          clearAiResults();
          stopStream = true;
          return;
        }
        streamingActive = false;
        if (streamRenderTimer) {
          clearTimeout(streamRenderTimer);
          streamRenderTimer = null;
        }
        setAiStatus("\u062a\u0645 \u0627\u0644\u0639\u062b\u0648\u0631 \u0639\u0644\u0649 \u0646\u062a\u0627\u0626\u062c", "ok");
        renderAiResults(data);
        stopStream = true;
        return;
      }

      if (eventType === "error") {
        streamingActive = false;
        if (streamRenderTimer) {
          clearTimeout(streamRenderTimer);
          streamRenderTimer = null;
        }
        setAiStatus("Service unavailable, please try again.", "error");
        clearAiResults();
        stopStream = true;
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 2);
        if (!frame) continue;
        handleFrame(frame);
        if (stopStream) break;
      }
      if (stopStream) break;
    }

    if (stopStream) {
      try { await reader.cancel(); } catch { }
    }

    buffer = buffer.trim();
    if (buffer && !stopStream) {
      handleFrame(buffer);
    }
  } catch (err) {
    if (String(err).includes("AbortError")) {
      if (AI_ABORT === abortController) {
        setAiStatus("\u062a\u0645 \u0627\u0644\u0625\u064a\u0642\u0627\u0641", "error");
      }
      return;
    }
    console.error(err);
    setAiStatus("\u062d\u062f\u062b \u062e\u0637\u0623 \u0623\u062b\u0646\u0627\u0621 \u0627\u0644\u0627\u062a\u0635\u0627\u0644 \u0628\u0627\u0644\u062e\u062f\u0645\u0629", "error");
    clearAiResults();
  } finally {
    if (streamRenderTimer) {
      clearTimeout(streamRenderTimer);
      streamRenderTimer = null;
    }
    if (AI_ABORT === abortController) {
      AI_ABORT = null;
      aiAskBtn && (aiAskBtn.disabled = false);
    }
  }
}

function handleAiClear() {
  if (aiQuestion) aiQuestion.value = "";
  setAiStatus("");
  clearAiResults();
  aiQuestion?.focus();
}

/* ---------------- Debounce ---------------- */
function debounce(fn, ms = 140) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* ---------------- Init loaders ---------------- */
/* ---------------- API Loaders ---------------- */
/* Set by fetchTafsirFromAPI: true when the last lookup failed to reach any
 * source (offline cache-miss + the network fetch threw / wasn't ok). Lets the
 * UI tell "no connection" apart from "this ayah genuinely has no tafsir".
 * navigator.onLine is unreliable in the WebView, so we trust the fetch result. */
let TAFSIR_FETCH_NETWORK_ERROR = false;

async function fetchTafsirFromAPI(surah, ayah, key) {
  if (!surah || !ayah || !key) return null;
  TAFSIR_FETCH_NETWORK_ERROR = false;
  const cacheKey = `${surah}:${ayah}:${key}`;

  // Check localStorage-backed cache first
  const cached = getTafsirCache(cacheKey);
  if (cached) return cached;

  // App offline path: read the tafsir text from the cached GCS JSON.
  if (tafsirIsReady()) {
    const offline = await getOfflineTafsir(surah, ayah, key);
    if (offline) { setTafsirCache(cacheKey, offline); return offline; }
    // Offline read missed (this book/ayah isn't in the cache). We can only
    // recover over the network — tentatively flag a connectivity problem; a
    // successful fetch below clears it.
    TAFSIR_FETCH_NETWORK_ERROR = true;
  }

  try {
    // Determine endpoint: /tafsir is separate from /ai
    // Current API_ROOT = https://.../
    // We added /tafsir in backend main.py
    const url = `${API_ROOT}/tafsir`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ surah: Number(surah), ayah: Number(ayah), tafsirs: [key] })
    });

    if (!res.ok) {
      console.warn("Tafsir fetch failed", res.status);
      TAFSIR_FETCH_NETWORK_ERROR = true;
      return null;
    }

    const data = await res.json();
    // Got a real response → not a connectivity problem, even if empty.
    TAFSIR_FETCH_NETWORK_ERROR = false;
    // Expected: { status: "ok", tafsirs: { key: "text" } }
    const text = data?.tafsirs?.[key] || null;

    // Cache if valid (localStorage + in-memory)
    if (text) setTafsirCache(cacheKey, text);
    return text;
  } catch (e) {
    // fetch threw → no connection (or DNS/TLS failure).
    TAFSIR_FETCH_NETWORK_ERROR = true;
    console.error("Tafsir fetch error:", e);
    return null;
  }
}

async function fetchTafsirsBatch(surah, ayah, keys) {
  if (!surah || !ayah || !keys || !keys.length) return;

  // Filter out keys that are already cached (including localStorage)
  const missing = keys.filter(k => !getTafsirCache(`${surah}:${ayah}:${k}`));
  if (missing.length === 0) return;

  try {
    const url = `${API_ROOT}/tafsir`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ surah: Number(surah), ayah: Number(ayah), tafsirs: missing })
    });

    if (!res.ok) return;

    const data = await res.json();
    if (data.status === "ok" && data.tafsirs) {
      for (const [k, txt] of Object.entries(data.tafsirs)) {
        if (txt) setTafsirCache(`${surah}:${ayah}:${k}`, txt);
      }
    }
  } catch (e) {
    console.error("Batch tafsir fetch error:", e);
  }
}

async function loadOne(key, file, label, shortLabel) {
  // Deprecated for tafsir, kept if needed for other JSONs but effectively unused for tafsir now
  return false;
}

function renderSurahView(surah) {
  // Hide main search UI
  const searchSection = textSearch?.closest('section');
  if (searchSection) searchSection.style.display = 'none';

  // Hide AI section
  if (aiPanel) aiPanel.closest('section').classList.add('hidden');

  // Build Grid Items - themed borders via CSS
  let gridItems = '';
  for (let i = 1; i <= surah.ayahs; i++) {
    gridItems += `
        <a href="/${surah.number}/${i}" class="ayah-grid-btn group flex items-center justify-center px-3 py-3 rounded-xl bg-white shadow-sm hover:shadow-lg hover:bg-blue-50 transition-all duration-200 text-center" style="border: 1px solid #93c5fd;">
            <span class="text-base font-bold text-slate-700 group-hover:text-blue-600 transition-colors">${i}</span>
        </a>`;
  }

  const content = `
    <div class="mt-6 mb-12 animate-fade-in-up">
        <!-- Compact Header Bar -->
        <div class="glass rounded-2xl px-4 py-3 mx-auto relative" style="margin-bottom: 50px; max-width: 320px;">
            <div class="text-center">
                <span class="quran-font text-xl text-slate-900">سورة ${surah.name_ar}</span>
            </div>
            <span class="text-slate-500 font-medium absolute" style="left: 16px; bottom: 6px; font-size: 10px;">عدد الآيات: ${surah.ayahs}</span>
        </div>

        <!-- Ayah Grid -->
        <div class="grid grid-cols-5 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 gap-2 max-w-4xl mx-auto px-4">
            ${gridItems}
        </div>
    </div>
  `;

  // Inject into Main
  const main = document.querySelector('main');
  if (main) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = content;
    main.appendChild(wrapper);
  }

  // Update Title
  document.title = `سورة ${surah.name_ar} مكتوبة كاملة | محمديات`;
}

async function init() {
  if (INIT_STARTED) return;
  INIT_STARTED = true;
  themeToggle?.addEventListener("click", () => {
    toggleDarkMode();
    // On touch devices the :hover / :focus state sticks on the button
    // after tap (no mouseout fires), leaving a residual highlight until
    // the user taps elsewhere. Blurring immediately releases focus and
    // visual state right after the toggle.
    try { themeToggle.blur(); } catch { }
  });
  updateCompareButtonState();
  // Dark mode preference
  try { setDarkMode(localStorage.getItem('darkMode') === '1'); } catch { }

  // Round 2, Fix 5: the top bar is position:fixed; body padding-top
  // re-reserves its flow space via --m7-header-h. Measure the REAL height
  // (web ~63px; app adds the safe-area inset) and keep it fresh across
  // resizes / status-bar var changes. rAF defer keeps the layout read out
  // of the ResizeObserver delivery (Chrome RO loop-limit).
  const headerEl = document.querySelector("header.site-header");
  if (headerEl) {
    const syncHeaderHeight = () => {
      const h = headerEl.offsetHeight;
      if (h > 0) document.documentElement.style.setProperty("--m7-header-h", `${h}px`);
    };
    if (window.ResizeObserver) {
      new ResizeObserver(() => requestAnimationFrame(syncHeaderHeight)).observe(headerEl);
    }
    window.addEventListener("resize", () => requestAnimationFrame(syncHeaderHeight));
    syncHeaderHeight();

    // ISSUE 5 (app only): when the iOS keyboard opens, WKWebView scrolls
    // the LAYOUT viewport to reveal the focused input — position:fixed
    // elements ride along, so the top bar slid up into the status-bar/
    // notch area. Pin the bar to the VISUAL viewport instead: translate
    // it down by the visual viewport's offset inside the layout viewport
    // (0 when the keyboard is closed and on the website, so resting
    // behavior is byte-identical; the header's own safe-area padding then
    // keeps its buttons below the notch). rAF-throttled; scroll+resize
    // cover open/close/scroll-while-typing, focus events cover WKWebView's
    // occasional missing geometry events, and the focusout retry catches
    // the late restore after the keyboard fully dismisses.
    if (isApp() && window.visualViewport) {
      const vv = window.visualViewport;
      let vvRaf = 0;
      const pinHeaderToVisualViewport = () => {
        if (vvRaf) return;
        vvRaf = requestAnimationFrame(() => {
          vvRaf = 0;
          const y = Math.max(0, vv.offsetTop);
          headerEl.style.transform = y > 0.5 ? `translateY(${y}px)` : "";
        });
      };
      vv.addEventListener("resize", pinHeaderToVisualViewport);
      vv.addEventListener("scroll", pinHeaderToVisualViewport);
      window.addEventListener("focusin", pinHeaderToVisualViewport);
      window.addEventListener("focusout", () => {
        pinHeaderToVisualViewport();
        setTimeout(pinHeaderToVisualViewport, 300); // post-dismiss settle
      });
    }
  }

  // Capacitor app only: measure the real Android status-bar height and
  // expose it as a CSS var. Fixes Pixel 8 / Android 14 where env() lies
  // and our 24px floor undershoots the actual ~30dp inset. No-op on web.
  if (isApp()) applyStatusBarHeight();

  // App-only: lazy-load the offline-downloads panel and the feedback panel so
  // the web bundle stays clean. Each panel reveals its own header icon on init;
  // web users never see either button or load either module.
  // Resolved once the initial reading position is painted (app only); the splash
  // overlay awaits it before fading. No-op on the website.
  let _markAppReady = () => {};
  if (isApp()) {
    // Opening splash: build the overlay + play the Lottie immediately (before the
    // big quran.json load) so it covers the cold-start window. The native splash
    // (launchAutoHide:false) stays up until splash.js calls SplashScreen.hide()
    // on the Lottie's first frame; the overlay then fades out on the LATER of
    // animation-complete or app-ready (_markAppReady, signalled below).
    const _appReady = new Promise((res) => { _markAppReady = res; });
    import("./splash.js")
      .then((m) => m.initSplash({
        appReady: _appReady,
        isDark: () => document.documentElement.classList.contains("dark"),
      }))
      .catch((e) => console.error("splash init failed", e));
    import("./offline-panel.js")
      .then((m) => m.initOfflinePanel())
      .catch((e) => console.error("offline-panel init failed", e));
    import("./feedback-panel.js")
      .then((m) => m.initFeedbackPanel())
      .catch((e) => console.error("feedback-panel init failed", e));
    // Resume (silent restore on next launch) + auto-flush on hide.
    import("./resume.js")
      .then((m) => {
        m.initResumeAutoflush();
        _recordResume = m.recordResume;
      })
      .catch((e) => console.error("resume init failed", e));
    // Personal notes panel + "ملاحظاتي" header button.
    import("./notes.js")
      .then((m) => m.initNotesPanel({
        // Jump to an ayah in whichever mode is currently displayed. The
        // notes list calls this on row tap.
        jumpToAyah: (s, a) => {
          if (isMushafMode()) openMushafAtAyah(s, a);
          else setPrimaryAyah(s, a, { scroll: true, animate: true });
        },
        getAyahPlainText: (s, a) => getAyahTextFromQuran(s, a) || "",
      }))
      .catch((e) => console.error("notes init failed", e));
  }

  // Lock search until core files load
  if (textSearch) {
    textSearch.disabled = true;
    textSearch.placeholder = "اكتب حرفين فأكثر من آية...";
  }

  // early SEO if URL has ayah
  const urlAyah = getAyahParamFromUrl();
  if (urlAyah) updateSeoMetaForAyah(urlAyah.s, urlAyah.a);

  SURAH_META = await loadJson("/surahs.json");
  QURAN = normalizeQuran(await loadJson("/quran.json"));

  // Boot the Mushaf reading mode. The module renders into a sibling of
  // #tafsirSection. Toggle is bidirectional — toggling into Mushaf at
  // any time re-opens the panel for the currently selected ayah.
  initMushaf({
    surahMeta: SURAH_META,
    quran: QURAN,
    audioBase: AUDIO_BASE,
    reciters: RECITERS,
    reciterOrder: RECITER_ORDER,
    getCurrentReciter: () => CURRENT_RECITER,
    setCurrentReciter: (r) => switchReciter(r),
    isReciterAllowedForSurah: (r, s) => isReciterAllowedForSurah(r, s),
    enforceReciterForSurah: (s) => enforceReciterForSurah(s),
    stopAudio: () => stopAudio(),
    // Quiet teardown of the Tafsir-side per-ayah <audio> only — does NOT
    // touch the engine. Used by Mushaf play paths to enforce the
    // single-source invariant without clobbering the engine.
    stopTafsirPerAyahAudio: () => stopTafsirPerAyahAudio(),
    tafsirSectionEl: tafsirSection,
    hasCurrentAyah: () => CURRENT != null,
    getCurrentAyah: () => CURRENT ? { s: CURRENT.s, a: CURRENT.a } : null,
    getAyahPlainText: (s, a) => getAyahTextFromQuran(s, a) || "",
    openTafsirForAyah: (s, a, opts) => {
      // Mode switch: skip the panel's own entrance (setAppMode choreographs
      // the Task-7 reveal itself via panelReveal:"defer") and skip
      // scrollIntoView (jarring during a toggle). The surah-selector submit
      // overrides both (a user pick SHOULD animate + scroll, like a
      // search-result click).
      setPrimaryAyah(s, a, { scroll: false, animate: false, ...opts });
    },
    // Opening the Mushaf panel counts as choosing an ayah → fade the
    // search pill's border beam (idempotent).
    deactivateSearchBeam: () => deactivateSearchBeam(),
    // Mushaf calls this during a Mushaf→Tafsir toggle WHEN the surah engine
    // is mid-playback, instead of openTafsirForAyah, so audio keeps going.
    resumeTafsirFromEngine: () => resumeTafsirFromEngine(),
    // Cross-mode sync: when the Mushaf side adjusts speed/volume, update
    // the Tafsir-side module cache + UI so they don't drift apart.
    onSpeedChanged: (s) => {
      AUDIO_SPEED = s;
      if (AUDIO_PLAYER) AUDIO_PLAYER.playbackRate = AUDIO_SPEED;
      updateSpeedUI();
      try { localStorage.setItem('audioSpeed', String(AUDIO_SPEED)); } catch { }
    },
    onVolumeChanged: (v) => {
      AUDIO_VOLUME = v;
      if (AUDIO_PLAYER) AUDIO_PLAYER.volume = AUDIO_VOLUME;
      const tafsirVolSlider = document.getElementById("tafsirVolSlider");
      if (tafsirVolSlider) tafsirVolSlider.value = Math.round(AUDIO_VOLUME * 100);
      if (audioVolumeSlider) audioVolumeSlider.value = Math.round(AUDIO_VOLUME * 100);
      try { localStorage.setItem("audioVolume", String(AUDIO_VOLUME)); } catch { }
    },
    // Mushaf flipped the audio-mode chip → mirror it onto Tafsir's
    // LISTENING_MODE + chip so the two stay in sync. No audio side effect
    // here — Mushaf's handler already drove the engine.
    onAudioModeChanged: (mode) => {
      const enabled = mode === "continuous";
      if (LISTENING_MODE === enabled) return;
      LISTENING_MODE = enabled;
      try { localStorage.setItem('listeningMode', enabled ? '1' : '0'); } catch { }
      updateListeningModeUI();
    },
    // Mushaf asks during a mode toggle "is Tafsir holding a per-ayah Audio
    // element right now?" so setAppMode can preserve it across the switch
    // instead of calling DEPS.stopAudio.
    hasPerAyahAudio: () => !!AUDIO_PLAYER,
    // مختصر التفاسير quick-view (Mushaf mode) reuses the compare pipeline:
    // same endpoint, same localStorage cache, so the card and the full
    // Tafsir-tab panel never double-fetch.
    apiRoot: API_ROOT,
    getCompareCache: (key) => getCompareCache(key),
    setCompareCache: (key, text) => setCompareCache(key, text),
    triggerCompare: () => handleCompareTafsirs(),
    // Offline (app): lets the Mushaf long-press مختصر التفاسير read the same
    // cached comparisons.json the Tafsir tab downloaded.
    tafsirOfflineReady: () => tafsirIsReady(),
    getOfflineComparison: (s, a) => getOfflineComparison(s, a),
    // Repeat / loop preference — shared across modes (one source of truth).
    getRepeatPref: () => getRepeatPref(),
    setRepeatPref: (n) => setRepeatPref(n),
    // Resume hook — app-only on the receiving side; called by Mushaf for
    // every page / ayah / surah navigation. Pass the no-op-by-default
    // shim so mushaf.js can call it unconditionally.
    recordResume: (patch) => _recordResume(patch),
    // Round 2, Fix 4: surah-selector → search-bar reflection. Reflect fires
    // for the wheel's every value (open + steps), commit on اذهب, abandon
    // when the dropdown closes without a pick.
    onSelectorReflect: (s, a) => selectorReflect(s, a),
    onSelectorCommit: () => selectorReflectCommit(),
    onSelectorAbandon: () => selectorReflectAbandon(),
  });

  // If the URL was /read/* the early-routing script set window._mushafInit;
  // resolve it now that meta is available. The mushaf panel opens INLINE
  // (the rest of the homepage stays visible above it).
  if (window._mushafInit) {
    const m = window._mushafInit;
    window._mushafInit = null;
    if (m.surah && m.ayah) openMushafAtAyah(m.surah, m.ayah, { updateUrl: false });
    else if (m.surah) openMushafAtSurah(m.surah, { updateUrl: false });
    else if (m.page) openMushafAtPage(m.page, { updateUrl: false });
  }

  // Check for Surah Landing Page Route (e.g. /2)
  const surahMatch = window.location.pathname.match(/^\/(\d+)\/?$/);
  if (surahMatch) {
    const surahId = Number(surahMatch[1]);
    const surah = SURAH_META.find(s => s.number === surahId);
    if (surah) {
      // Check if content is already prerendered (to avoid duplication)
      const existingGrid = document.querySelector('.ayah-grid-btn');
      if (!existingGrid) {
        renderSurahView(surah);
      }
      // We don't return here because we still might want other init logic (like theme),
      // but we should avoid loading the default search view if possible.
    }
  }

  // Resume reading position — APP ONLY. Honours URL deep-links / Mushaf
  // routes / Surah landing page: only fires when the user landed on the
  // bare "/" and nothing else is already taking them somewhere specific.
  if (isApp()
    && !window._mushafInit
    && !urlAyah
    && !surahMatch
    && window.location.pathname === "/") {
    try {
      const m = await import("./resume.js");
      // Make sure the recorder is wired in case the early fire-and-forget
      // import is still resolving. Module instance is shared either way.
      _recordResume = m.recordResume;
      const stored = m.loadStoredResume();
      if (stored) {
        if (stored.mode === "mushaf" && Number.isFinite(stored.page)) {
          // Open the page first (right page, right SEO), then drop the ayah
          // anchor on top so the target-surah highlight is correct.
          openMushafAtPage(stored.page, { updateUrl: true, noScroll: true });
          if (stored.surah && stored.ayah) {
            openMushafAtAyah(stored.surah, stored.ayah, { updateUrl: false, noScroll: true });
          }
        } else if (stored.mode === "tafsir" && stored.surah && stored.ayah) {
          setPrimaryAyah(stored.surah, stored.ayah, { scroll: false, animate: false });
          // Apply the saved scroll offset on the next microtask, after the
          // tafsir DOM updates settle (setPrimaryAyah re-renders).
          if (stored.scrollY > 0) {
            requestAnimationFrame(() => {
              try { window.scrollTo({ top: stored.scrollY, behavior: "instant" }); }
              catch { window.scrollTo(0, stored.scrollY); }
            });
          }
        }
      }
    } catch { /* resume failure must never block init */ }
  }

  // Splash (app only): core data is loaded and the initial reading position
  // (URL deep-link / Mushaf route / resume) is resolved & painted — let the
  // splash overlay fade once its animation also completes. No-op on the website.
  _markAppReady();

  // Build search index without freezing the UI
  if (textSearch) {
    textSearch.disabled = true;
    textSearch.placeholder = "اكتب حرفين فأكثر من آية...";
  }
  setIndexStatus("");
  await buildIndexAsync();
  setIndexStatus("");

  if (textSearch) {
    textSearch.disabled = false;
    textSearch.placeholder = "اكتب حرفين فأكثر من آية...";
  }

  // search input
  const runSearch = () => {
    const q = textSearch.value || "";
    const found = searchText(q);
    renderResults(found, q);
    expandResultsList();
  };
  textSearch.oninput = debounce(() => { runSearch(); }, 180);

  // Warm up API on first keystroke to reduce latency when ayah is selected
  textSearch.addEventListener("input", () => {
    warmUpAPI();
  }, { once: true });

  // مسح = full return to the homepage default state, not just an input
  // wipe: clear the search, retract the opened ayah in WHICHEVER mode it
  // lives (Tafsir panel or Mushaf panel), stop playback, and put the URL,
  // SEO tags, mode toggle and search beam back to how a fresh load of "/"
  // looks. pushState (not replace) so Back still returns to the ayah.
  const resetToHome = () => {
    if (MATERIALIZE_CANCEL) MATERIALIZE_CANCEL(); // settle any in-flight materialize
    textSearch.value = "";
    clearInputLock();         // drop the lock (mirror cleanup waits for the dissolve)
    results.innerHTML = "";
    results.classList.add("is-empty");
    resultsShell?.classList.add("is-empty");
    results.classList.add("collapsed");
    resultsShell?.classList.add("collapsed");
    results.style.maxHeight = "0";

    stopAudio();              // Tafsir per-ayah <audio> + surahAudio engine
    resetMushafHomeState();   // close Mushaf panel, drop its anchor ayah, toggle → تفسير
    CURRENT = null;
    // A soft swap mid-flight from a just-clicked ayah change must not
    // apply stale content / leave exit classes on the retracted panel.
    cancelTafsirSwap();
    if (tafsirSection) {
      tafsirSection.classList.add("hidden");
      tafsirSection.dataset.open = "false";   // next reveal stages from closed
    }
    resetComparePanel({ hide: true, silent: true });
    updateCompareButtonState();

    if (window.location.pathname !== "/") {
      history.pushState(null, "", "/");
    }
    resetSeoMetaToHome({ removeAyahParam: true });
    reactivateSearchBeam();
  };

  // The teardown is STAGED so مسح feels composed instead of abrupt:
  //   0. (Task 1) when an ayah text is LOCKED in the search pill, it first
  //      dissolves out — the rest of the teardown starts the moment the
  //      text has fully dissolved, so the glow tail and the page fade read
  //      as one motion; the fake placeholder flies in during the reset.
  //   1. the open content (results, Tafsir panel / Mushaf panel) fades out
  //      over 280ms (.m7-clear-fade, index.html);
  //   2. behind that blank moment the actual reset runs, and the page
  //      scrolls home SMOOTHLY if it was scrolled at all.
  // The old stage 3 — replaying an .m7-home-enter entrance on the whole
  // search panel — is REMOVED: it dimmed the visible, already-settled card
  // to 55% and slid it 6px (plus an instant scroll jump), which read as a
  // page refresh right after the smooth fade. The panel never leaves the
  // screen during مسح, so it must simply stay put.
  // Reduced-motion users (and the nothing-was-open case) get the instant path.
  let clearing = false;
  clearBtn?.addEventListener("click", () => {
    if (clearing) return;
    const fadeTargets = [
      resultsShell,
      tafsirSection,
      document.getElementById("mushafRoot"),
    ].filter((n) => n && !n.classList.contains("hidden") && n.offsetParent !== null);
    const reduceMotion = prefersReducedMotion();
    const lockedText = !!textSearch?.value
      && !!searchClearWrap?.classList.contains("has-value");
    if (reduceMotion || (fadeTargets.length === 0 && !lockedText)) {
      resetToHome();
      try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch { }
      return;
    }
    clearing = true;
    // The rewind pill leaves WITH the text: its slide-off-right starts the
    // same moment the dissolve (or the panel fade) begins — not at the end
    // of the staged reset (reactivateSearchBeam's later call no-ops).
    hidePillClear();
    const runStagedReset = () => {
      fadeTargets.forEach((n) => n.classList.add("m7-clear-fade"));
      // Scroll home NOW, in parallel with the fade — the fading panels
      // keep their layout space (opacity only), so the glide happens over
      // an unchanged page height. Collapsing first did it backwards: the
      // height collapse clamped the scroll position in a single frame
      // (the residual "placement jump") before the smooth scroll even ran.
      try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch { }
      const t0 = performance.now();
      const finishReset = () => {
        // Wait until we've arrived at the top (hard 900ms cap so an
        // interrupted glide can never wedge the reset) — at the top, the
        // collapse has nothing to clamp.
        if (window.scrollY > 4 && performance.now() - t0 < 900) {
          setTimeout(finishReset, 60);
          return;
        }
        // The faded panels still hold their layout space — display:none
        // would snap everything below them upward in one frame. Ease the
        // (already invisible) boxes to zero first; .m7-clear-fade's
        // !important transition carries height/padding/margin, so the
        // content below GLIDES up. Then reset for real, off-screen-quiet.
        const collapsing = fadeTargets.filter(
          (n) => n.offsetParent !== null && n.offsetHeight > 0);
        collapsing.forEach((n) => {
          n.style.height = `${n.offsetHeight}px`;
          n.style.overflow = "hidden";
        });
        void document.body.offsetWidth; // commit the start heights
        collapsing.forEach((n) => {
          n.style.height = "0px";
          n.style.paddingTop = "0px";
          n.style.paddingBottom = "0px";
          n.style.marginTop = "0px";
          n.style.marginBottom = "0px";
          n.style.borderTopWidth = "0px";
          n.style.borderBottomWidth = "0px";
        });
        setTimeout(() => {
          resetToHome();
          collapsing.forEach((n) => {
            n.style.height = "";
            n.style.overflow = "";
            n.style.paddingTop = "";
            n.style.paddingBottom = "";
            n.style.marginTop = "";
            n.style.marginBottom = "";
            n.style.borderTopWidth = "";
            n.style.borderBottomWidth = "";
          });
          fadeTargets.forEach((n) => n.classList.remove("m7-clear-fade"));
          clearing = false;
        }, collapsing.length ? 260 : 0);
      };
      setTimeout(finishReset, 300);
    };
    if (lockedText) {
      if (MATERIALIZE_CANCEL) MATERIALIZE_CANCEL(); // never two routines on the mirror
      syncClearMetrics(); // layout may have shifted since the lock
      dissolveSearchClear({
        wrapper: searchClearWrap,
        input: textSearch,
        mirror: searchClearMirror,
        placeholder: searchClearPlaceholder,
        glow: searchClearGlow,
        onTextGone: runStagedReset,
        onFinished: () => { if (searchClearMirror) searchClearMirror.textContent = ""; },
      });
    } else {
      runStagedReset();
    }
  });

  // Editing the search text releases the lock (keyboard/tab flows): the
  // input's own glyphs come back and the user keeps typing. Ignored
  // mid-dissolve — resetToHome owns the value then.
  textSearch?.addEventListener("input", () => {
    if (searchClearWrap?.classList.contains("is-clearing")) return;
    clearInputLock();
  });

  // Clicking the LOCKED pill slowly unlocks it — the veil lifts the
  // moment the click lands (the .is-clearing CSS rule) and the tint eases
  // back over the same slow transition while the text DISSOLVES away —
  // leaving a focused, empty bar to write a brand-new search from zero.
  let unlockingPill = false;
  textSearch?.addEventListener("click", () => {
    if (!searchClearWrap?.classList.contains("has-value")) return;
    if (searchClearWrap.classList.contains("is-clearing")
      || searchClearWrap.classList.contains("is-materializing")) return;
    if (SELECTOR_REFLECT) return; // the open selector owns the bar right now
    if (unlockingPill) return;
    unlockingPill = true;
    if (MATERIALIZE_CANCEL) MATERIALIZE_CANCEL();
    dissolveSearchClear({
      wrapper: searchClearWrap,
      input: textSearch,
      mirror: searchClearMirror,
      placeholder: searchClearPlaceholder,
      glow: searchClearGlow,
      onTextGone: () => {
        textSearch.value = "";
        clearInputLock(); // has-value off → the surface un-tints slowly
      },
      onFinished: () => {
        unlockingPill = false;
        if (searchClearMirror) searchClearMirror.textContent = "";
        try { textSearch.focus({ preventScroll: true }); } catch { }
      },
    });
  });

  // The search input's left padding must clear the surah-selector cluster,
  // whose width changes at runtime (the selector is injected by mushaf.js
  // and grows with the surah name).
  // Mirror the cluster's footprint into the CSS var the #textSearch
  // padding-left calc() reads (see index.html styles).
  const pillActionsEl = el("searchPillActions");
  const beamPillEl = pillActionsEl?.closest(".border-beam");
  if (pillActionsEl && beamPillEl) {
    const syncActionsWidth = () => {
      const w = pillActionsEl.offsetLeft + pillActionsEl.offsetWidth;
      beamPillEl.style.setProperty("--search-actions-w", `${w}px`);
      // The lock mirror copies the input's resolved padding — keep it in
      // step whenever the cluster (and thus the padding calc) changes.
      // Deferred one frame: it reads getComputedStyle, and a forced layout
      // inside the ResizeObserver callback trips Chrome's "loop completed
      // with undelivered notifications" error.
      requestAnimationFrame(syncClearMetrics);
    };
    if (window.ResizeObserver) {
      new ResizeObserver(syncActionsWidth).observe(pillActionsEl);
    }
    syncActionsWidth();
  }
  window.addEventListener("resize", syncClearMetrics);

  // Click anywhere outside the search panel → drop a stale autofill
  // visual on the input. Only fires when the value actually came from
  // Chrome's autofill (a saved-search pick) — typed text is preserved
  // so casual outside clicks don't wipe an in-progress search. Clearing
  // the value is the cheapest way to make the :-webkit-autofill
  // pseudo-class go away; the box-shadow inset overlay disappears with it.
  const searchPanelEl = textSearch.closest('.glass');
  if (searchPanelEl) {
    const isInputAutofilled = () => {
      try { if (textSearch.matches(':-webkit-autofill')) return true; } catch { }
      try { if (textSearch.matches(':autofill')) return true; } catch { }
      return false;
    };
    document.addEventListener('click', (e) => {
      if (!textSearch.value) return;
      if (searchPanelEl.contains(e.target)) return;
      if (!isInputAutofilled()) return;
      textSearch.value = "";
    });
  }

  // (Round 5) The selected-ayah chip card and its re-open/change handlers
  // are gone — the locked pill text is the selection display, the surah
  // selector is the change-ayah control, and clicking the locked pill
  // dissolves it for a fresh search (wired below with the lock listeners).

  // AI quick prompts (chips)
  for (const b of aiQuickBtns) {
    b.addEventListener("click", () => {
      const v = b.getAttribute("data-ai-prompt") || "";
      if (aiQuestion) aiQuestion.value = v;
      // optional: auto-run
      handleAiAsk();
    });
  }

  // tafsir change
  tafsirSelect?.addEventListener("change", () => {
    if (CURRENT) updateTafsirUI(CURRENT.s, CURRENT.a);
  });

  // context language change
  langSelect?.addEventListener("change", () => {
    if (CURRENT) showAyahContext(CURRENT.s, CURRENT.a);
  });

  // verse panel toggle (Smart Scroll Fix)
  toggleVersesBtn?.addEventListener("click", () => {
    // 1. If closing, just close immediately
    if (VERSES_OPEN) {
      setVersePanelOpen(false);
      return;
    }

    // 2. If opening:
    // First, populate the text (while VERSES_OPEN is still false, so it won't scroll yet)
    if (CURRENT) showAyahContext(CURRENT.s, CURRENT.a);

    // Pre-position scroll to active ayah BEFORE opening (instant, no animation)
    const panel = document.getElementById("versePanel");
    const active = document.querySelector(".ayah-line.active");
    if (active && panel) {
      // Calculate position to center the active ayah
      // Use a rough estimate since panel isn't expanded yet
      const estimatedPanelHeight = 400; // Approximate expanded height
      const top = active.offsetTop - estimatedPanelHeight / 2 + active.clientHeight / 2;
      panel.scrollTop = Math.max(0, top);
    }

    // Now open the panel - it will animate open with scroll already positioned
    setVersePanelOpen(true);
  });

  prevAyahBtn?.addEventListener("click", () => stepAyah(-1));
  nextAyahBtn?.addEventListener("click", () => stepAyah(1));
  playAyahBtn?.addEventListener("click", playCurrentAyah);

  // Phone (web + app): tap the ayah text to play its recitation; tap again to stop.
  // Enabled in the app and on touch devices, so a desktop mouse-click (e.g.
  // selecting text) isn't hijacked. (pointer:coarse can report false in the
  // Android WebView, so we also accept isApp()/maxTouchPoints.)
  tafsirAyahTag?.addEventListener("click", () => {
    const touchOrApp = isApp()
      || (navigator.maxTouchPoints || 0) > 0
      || (window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
    if (!touchOrApp) return;
    playCurrentAyah();
  });

  // Web: ← / → arrow keys move between ayahs while the Tafsir view is on screen.
  // RTL convention (matches the Mushaf): ArrowLeft = next, ArrowRight = previous.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (!CURRENT) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    // only when the Tafsir section is actually visible (not in Mushaf mode / pre-selection)
    if (!tafsirSection || tafsirSection.offsetParent === null) return;
    e.preventDefault();
    stepAyah(e.key === "ArrowLeft" ? 1 : -1);
  });
  compareTafsirsBtn?.addEventListener("click", handleCompareTafsirs);
  // Pulse-outside glow around مختصر التفاسير — breathing driver + lifecycle
  // (activates whenever the button is enabled). See src/pulse-beam.js.
  initMukhtasarPulse();
  compareCloseBtn?.addEventListener("click", () => resetComparePanel({ hide: true }));
  compareStopBtn?.addEventListener("click", () => {
    if (COMPARE_STOPPED) {
      // Resume - restart comparison
      COMPARE_STOPPED = false;
      handleCompareTafsirs();
    } else if (COMPARE_ABORT) {
      // Stop
      COMPARE_ABORT.abort();
    }
  });

  // Pause/Resume writing animation button
  compareWritePauseBtn?.addEventListener("click", () => {
    if (COMPARE_WRITE_PAUSED) {
      // Resume writing
      COMPARE_WRITE_PAUSED = false;
      compareWritePauseBtn.textContent = "إيقاف";
      // Call the stored resume function
      if (COMPARE_WRITE_RESUME_FN) {
        COMPARE_WRITE_RESUME_FN();
      }
    } else {
      // Pause writing
      COMPARE_WRITE_PAUSED = true;
      compareWritePauseBtn.textContent = "إستئناف";
    }
  });

  tafsirComparePanel?.addEventListener("click", (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    // Don't collapse when clicking buttons
    if (target.closest("#compareCloseBtn")) return;
    if (target.closest("#compareStopBtn")) return;
    if (target.closest("#compareWritePauseBtn")) return;
    if (target.closest("button, a, input, select, textarea")) return;
    // Only collapse when clicking the header row (top area with title)
    const headerRow = tafsirComparePanel.querySelector(".compare-header-row");
    if (headerRow && (target === headerRow || headerRow.contains(target))) {
      setCompareCollapsed(!COMPARE_COLLAPSED);
    }
  });
  window.addEventListener("online", () => {
    if (!tafsirComparePanel || tafsirComparePanel.classList.contains("hidden")) return;
    const contentText = (tafsirCompareContent?.textContent || "").trim();
    if (contentText.includes(OFFLINE_COMPARE_MESSAGE)) {
      if (tafsirCompareContent) tafsirCompareContent.innerHTML = "";
      setCompareStatus("", "");
      return;
    }
    if ((tafsirCompareStatusText?.textContent || "").trim() === OFFLINE_COMPARE_MESSAGE) {
      setCompareStatus("", "");
    }
  });
  window.addEventListener("offline", () => {
    if (!tafsirComparePanel || tafsirComparePanel.classList.contains("hidden")) return;
    setCompareStatus(OFFLINE_COMPARE_MESSAGE, "error");
  });
  window.addEventListener("online", updateNetworkBadge);
  window.addEventListener("offline", updateNetworkBadge);
  updateNetworkBadge();

  // AI events
  aiAskBtn?.addEventListener("click", handleAiAsk);
  aiClearBtn?.addEventListener("click", handleAiClear);
  aiQuestion?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleAiAsk(); }
  });

  // Background loads: English + tafsir files (won't break UI if missing)
  (async () => {
    try {
      const enRaw = await loadJson("/en.sahih.json");
      EN_MAP = buildEnglishMap(enRaw);
    } catch {
      EN_MAP = null;
    }

    /* Tafsir files are now fetched on-demand from API */
    // await loadOne("muyassar", "tafseer_muyassar.json", "التفسير الميسّر", "الميسّر");
    // ... all static loads removed

    // If current tafsir selection isn't loaded, fall back to first available
    const selectedKey = tafsirSelect?.value || "muyassar";
    if (!TAFSIRS[selectedKey]) {
      const firstKey = Object.keys(TAFSIRS)[0];
      if (firstKey && tafsirSelect) tafsirSelect.value = firstKey;
    }

    // If URL contains an ayah, open it once tafsir/EN are ready enough
    if (urlAyah) setPrimaryAyah(urlAyah.s, urlAyah.a, { replaceUrl: true, track: false });
  })();

  // Preload Mushaf data in the background if not currently in Mushaf mode
  if (!window._mushafInit && !isMushafMode()) {
    if (window.requestIdleCallback) {
      requestIdleCallback(() => preloadMushafData(), { timeout: 2000 });
    } else {
      setTimeout(preloadMushafData, 1000);
    }
  }

  // Back/forward navigation
  window.addEventListener("popstate", () => {
    // /read/* — open the Mushaf panel inline (mode toggle stays whatever
    // the user set it to; the panel's visibility is driven by the URL).
    const path = window.location.pathname;
    const mPage = path.match(/^\/read\/page\/([0-9]+)\/?$/);
    const mSurah = path.match(/^\/read\/surah\/([0-9]+)\/?$/);
    const mAyah = path.match(/^\/read\/ayah\/([0-9]+)\/([0-9]+)\/?$/);
    if (mAyah) { openMushafAtAyah(Number(mAyah[1]), Number(mAyah[2]), { updateUrl: false }); return; }
    if (mSurah) { openMushafAtSurah(Number(mSurah[1]), { updateUrl: false }); return; }
    if (mPage) { openMushafAtPage(Number(mPage[1]), { updateUrl: false }); return; }

    // Non-Mushaf URL: close the panel (if open) and fall through to the
    // standard Tafsir restore for the URL's ayah.
    closeMushafPanel();

    const p = getAyahParamFromUrl();
    if (!p) {
      CURRENT = null;
      // "/" renders the homepage default — retract the tafsir panel too,
      // matching what the مسح reset (which pushState'd this entry) shows.
      cancelTafsirSwap();
      if (tafsirSection) {
        tafsirSection.classList.add("hidden");
        tafsirSection.dataset.open = "false";
      }
      resetSeoMetaToHome();
      resetComparePanel({ hide: true, silent: true });
      updateCompareButtonState();
      return;
    }
    setPrimaryAyah(p.s, p.a, { replaceUrl: true, track: false });
  });
}

/* Start */
window.addEventListener("DOMContentLoaded", () => {
  init().catch((e) => {
    console.error(e);
    // If init fails, at least show a clear error in UI
    if (textSearch) {
      textSearch.disabled = true;
      textSearch.placeholder = "حدث خطأ، حاول مرة أخرى...";
    }
  });
});





