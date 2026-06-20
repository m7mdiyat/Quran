# Performance Audit — m7mdiyat (محمديات)

**Scope:** Diagnosis only. No fixes applied. Static code analysis of the whole app, with
particular attention to the Mushaf reading surface where the Gharib (غريب القرآن) feature
shipped. Symptoms under investigation: lag on older Android, thermal throttling on newer
iPhones, "worse after Gharib was added."

**Method:** Full-codebase inventory → pattern census (rAF / intervals / reflow reads /
filters / animations / listeners) → deep read of the suspected hot paths → mechanism-level
reasoning from the actual code. Where a number can only come from a runtime trace, it is
flagged as such.

**Headline finding (one sentence):** The Mushaf page paints a stack of GPU `blur()`+`drop-shadow()`
glyph halos that are **deliberately kept un-composited and animated forever**, so a Mushaf page
that is just sitting on screen being *read* re-rasterises filtered text every single frame — the
exact profile of "fans spin up while nothing is happening," and it only exists in Mushaf mode,
which is why it tracks with the Gharib launch.

---

## Step 1 — App Map

### Shape
Vanilla JS + Vite SPA, **no framework**. Ships as both a website (GitHub Pages) and a
Capacitor app (Android + iOS). One giant `index.html` boots `src/app.js`, which dynamic-imports
the rest.

### Entry / boot sequence
1. **`index.html`** (5,481 lines, **203 KB**) — contains a **~4,700-line inline `<style>`**
   (lines 261–4989), several inline `<script>`s (dark-mode pre-paint, Capacitor detection,
   GA gated to non-app), JSON-LD, then loads `/src/app.js` (module).
2. **`src/app.js` `init()`** — loads `quran.json` (5.7 MB) + `surahs.json`, builds the search
   index via **`buildIndexAsync()`** (chunked, `requestIdleCallback`, app.js:2820/5819),
   wires listeners, and defers Mushaf preload to idle (app.js:6252).
3. App-only modules (`offline-panel`, `feedback-panel`, `gharib-saved-panel`) are
   dynamic-imported behind `isApp()`.

### Modules (line counts)
| Module | Lines | Role |
|---|---|---|
| `src/app.js` | 6,309 | Monolith: state, tafsir, AI Q&A, compare (SSE), search, audio glue |
| `src/mushaf.js` | 4,102 | Mushaf reading mode: QCF4 page render, ayah menu, per-page audio |
| `src/gharib.js` | 1,339 | غريب glow + tooltip + lantern; decorates each rendered page |
| `src/transitions.js` | 561 | Transitions.dev one-shot micro-animations (reduced-motion aware) |
| `src/page-fullscreen.js` | 493 | Mushaf fullscreen cluster |
| `src/notes.js` | 441 | Reflection notes |
| `src/offline-panel.js` | 433 | App-only offline downloads |
| `src/surahAudio.js` | 396 | Full-surah timed playback engine (100 ms tick) |
| `src/gharib-saved-panel.js` | 285 | App-only learned-words panel |
| `src/pulse-beam.js` | 220 | مختصر beam driver (30 fps, observer-paused) |
| `src/splash.js` (+ `splash-v3.json` 44 KB) | 143 | Lottie splash |
| others | — | `app-banner`, `resume`, `repeat`, `sheet-scroll-lock`, `main`/`counter` (dead) |

### Third-party runtime libs
**`lottie-web` (splash only)** and **Capacitor**. That's the entire third-party runtime
surface — the cost is in the app's own code, not dependencies.

### Continuous-animation inventory (what actually runs over time)
| System | When active | Guarded? |
|---|---|---|
| **Gharib breath** (`gw-halo`, `gw-ink`, infinite) | **Always, while any Mushaf page with غريب words is visible** | ❌ **No idle/visibility guard** (only `prefers-reduced-motion` stops it) |
| Pulse-beam (مختصر) | Only when an ayah is open & before first click | ✅ 30 fps, IntersectionObserver-paused, reduced-motion off, self-disables |
| Listening-mode pulse/rotate | Only during listening-mode playback | ✅ scoped to `.active` |
| Mushaf spinner | Only while page is loading | ✅ overlay-only |
| Transitions.dev helpers | One-shot per interaction | ✅ reduced-motion short-circuits |

### Audio
- **`surahAudio.js`**: one `<audio>` + a **100 ms `setInterval`** (surahAudio.js:113–159).
  The tick does a binary search and **fires the DOM highlight only on actual ayah change**,
  not every tick. No per-tick DOM work; element is torn down on stop. **Well-built.**
- `mushaf.js` has a per-page audio engine; `app.js` has fade/rotation intervals (spinner/fade).

### Asset weight
- Fonts: **48 QCF4 `.woff2`** (one per page-group) + 3 legacy TTFs (~0.85 MB). QCF4 loaded on demand.
- `gharib.json` 682 KB — **lazy** (`fetch('/gharib.json')` on first Mushaf page, gharib.js:223).
- `quran.json` **5.7 MB — eager** at startup.
- Tafseer JSONs (7–35 MB each) — fetched from backend/GCS on demand; local copies are fallback.
- Lottie splash 44 KB.

### Event model
~229 `addEventListener` total, but Mushaf tap handling is **delegated** on the root
(`e.target.closest('.mushaf-ayah')`, mushaf.js:1814–1877) — **no per-word listeners**, and
page turns `.remove()` the old page (mushaf.js:1599–1607). DOM does **not** grow unbounded.

---

## Step 2 — Ranked Suspected Causes

Likelihood = probability this is a *significant* contributor to the reported symptoms, ranked
most→least. "Certain" = directly provable from code; "Inferred" = strong mechanism but the
magnitude needs a runtime trace.

| # | Area | Mechanism (why it costs) | Evidence | Likelihood | Confidence |
|---|---|---|---|---|---|
| **1** | **Gharib glow — perpetual filtered repaint** | Each `.gharib-word` paints `::before` (+ `::after` on dark) as a **duplicated glyph**, opacity driven by an **animated registered custom property** so the layer is **intentionally never promoted** (mushaf.css:3178–3187 rationale). Un-promoted + per-frame opacity change ⇒ the glyph re-rasters **into the shared page layer every frame**. On the **app** that re-raster re-runs `filter: blur(0.05em) drop-shadow() drop-shadow()` (mushaf.css:3281–3294). Runs **forever** (`animation … infinite`, mushaf.css:3250, 3340) on the default-on Mushaf — including for **learned words** and (until the fade-out completes) when the lantern is off. ~10–50 غريب words/page × up to 2 layers each. | mushaf.css:3211–3347, 3176–3189; gharib.js:460–470, 860 | **85%** | Continuous animation = **Certain**; per-frame *repaint* (vs cheap composite) = **Inferred (high)** — confirm with paint-flashing |
| **2** | **QCF4 faux-bold `-webkit-text-stroke` (app-only)** | Every non-end Mushaf word gets `-webkit-text-stroke: 0.25px` (mushaf.css:3130). Stroked text rasterises ~2× a normal glyph. Static on its own — but it **amplifies every repaint**: each Gharib-driven dirty rect (halo box is `inset:-1em; padding:1em`, larger than the word, overlapping neighbours) re-rasters the **stroked** real glyphs underneath too, and page-turn/scroll re-raster the whole stroked page. App-only ⇒ matches the **iPhone-thermal** specificity. | mushaf.css:3130–3133 | **55%** | **Inferred** |
| **3** | **Stylesheet bulk → expensive style recalc** | ~**350 KB CSS** (4,700-line inline block + 119 KB `mushaf.css` + 26 KB `styles.css`), **46 `@keyframes`**, **30+ `@property`** registrations (several `inherits:true`, index.html:2853–2871). The app toggles classes constantly (`--dimmed`, `--target`, menu open, mode switch); each invalidation recomputes style against a large rule set. Best fit for **interaction lag on old Android**. | index.html:261–4989, 2853–2871; mushaf.css | **45%** | **Inferred** — needs "Recalculate Style" trace |
| **4** | **`quran.json` eager 5.7 MB parse** | `JSON.parse` of 5.7 MB on cold start (before the chunked index build) is a single main-thread block; on a slow A-core that's ~100–400 ms of jank at launch. Index *build* itself is already chunked (good), so this is the parse, not the loop. | app.js `init()`; public/quran.json (5.7 MB) | **40%** | Parse-is-sync = **Certain**; magnitude **Inferred** |
| **5** | **Decorative animations (aggregate)** | `listeningPulse` animates **box-shadow** (a repaint property, not composited) during playback (index.html:1545); spinner `mushafSpin` infinite while loading (mushaf.css:274). Bounded to specific states, but box-shadow animation repaints each frame while it runs. | index.html:1545–1549; mushaf.css:274 | **25%** | **Certain** they exist; **bounded** |
| **6** | **Layout thrashing (per-interaction)** | `setTafsirBoxContent` reads `offsetHeight` → writes style → sets `innerHTML` → reads `offsetHeight` again (forced sync layout ×2) for the height FLIP; drag math reads rects. **Per-interaction, not per-frame** — real but minor for *thermal*. | app.js ~3758–3775; mushaf drag handlers | **20%** | **Certain** pattern; minor |
| **7** | **Memory leak (unconfirmed)** | **No smoking gun found**: pages removed on turn, handlers delegated, `_timingsCache`/compare/tafsir caches bounded (LRU), audio element torn down. A *slow* leak could still explain "gets laggy the longer a session runs," but nothing in the code points to one. | mushaf.js:1599–1607; surahAudio.js:162–170 | **15%** | **Not found** — needs heap-snapshot-over-time to rule out |
| **8** | **`backdrop-filter` on glass surfaces** | The reading surface `.mushaf-root` carries `.glass` (mushaf.js:1107) = `backdrop-filter: blur(8px)`. A backdrop-filter under an animating child would re-blur every frame — **but** `@media (max-width:768px){ .glass{ backdrop-filter:none !important } }` (index.html:1327–1333) **disables it on every phone.** | mushaf.js:1107; index.html:521–526, 1327–1333 | **10%** | **Largely exonerated on mobile (Certain)** — desktop web only |

### Things I checked and am clearing (so they don't get "fixed" by mistake)
- **Audio highlight loop** — event-driven, 10 Hz, no per-tick DOM. Not a sink. (surahAudio.js:123–159)
- **Pulse-beam** — exemplary: 30 fps, observer-paused, reduced-motion off, dies after first click. (pulse-beam.js:29–34, 124–210)
- **Search-index build** — already chunked via `requestIdleCallback`. (app.js:2820–2868)
- **DOM growth / listener accumulation** — pages removed, handlers delegated. No leak pattern found.
- **`gharib.json` / tafseer JSONs** — lazy / on-demand, not eager.

---

## Recommended fixes + estimated impact

Impact estimates are **rough and pre-trace** — they describe the share of the *steady-state
Mushaf paint/heat* each change removes, on the assumption that cause #1 dominates (which the
code strongly implies but a paint trace must confirm). Every fix below **keeps the feature** —
none disables Gharib, multi-reciter audio, timestamp highlighting, or notes.

### Fix 1 — Stop the Gharib breath from running forever *(addresses cause #1)*
The glow does not need to pulse at 60–120 fps for the entire reading session. Pick one (or
combine), in rough order of impact-to-effort:

- **1a. Settle to static after a few breaths** *(highest ROI, low effort).* Let `gw-halo` /
  `gw-ink` run a bounded `animation-iteration-count` (e.g. ~3–4 cycles ≈ 20–27 s) and end on a
  lit keyframe, *or* add a JS timer that drops a `gharib-settled-static` class after first
  paint. A **static** filtered glyph paints **once** then costs ~0 until something invalidates
  it. This matches the project's own stated philosophy — *"attention glows fade permanently on
  first use"* (memory: calm-animations) — and removes the perpetual repaint while keeping the
  gold glow fully visible. **Est. −50% to −70%** of Mushaf idle GPU/heat.
- **1b. Make the breath compositable instead of un-promoted** *(medium effort, needs device
  test).* The reason it isn't promoted is halo-clipping — but the pseudo already has
  `inset:-1em; padding:1em`, larger than the ~0.85em shadow spread, so a promoted layer
  *should* now contain the halo. If so, animating real `opacity` (or `transform`) with
  `will-change` lets the GPU re-blend a **cached** filtered texture per frame instead of
  re-rasterising the filter. **Est. −40% to −60%.** Verify the gold halo still isn't boxed on a
  real WKWebView device before shipping.
- **1c. Halve the per-word layers** *(low effort).* Drop the dark-theme `::after` molten-ink
  layer (or make it static), so each word animates one layer not two. **Est. −15% to −25%.**
- **1d. Cheapen the app filter** *(low effort).* `blur() + drop-shadow() + drop-shadow()` is
  three GPU passes; collapse to one drop-shadow (or a single pre-blurred shadow). **Est. −10%
  to −20%** on the app specifically.

> Recommended: **1a + 1c** together — biggest heat drop, smallest change, no risk to the look.

### Fix 2 — Neutralise the text-stroke amplifier *(cause #2)*
Once Fix 1 stops the per-frame Mushaf repaint, `-webkit-text-stroke` is paid **once per page
build** instead of every frame, and largely stops mattering. If profiling still shows it hot
during page-turns/scroll: replace the faux-bold with a real `font-weight` (if the QCF4 face has
a heavier instance) or a 1-pass `text-shadow`, which raster cheaper than stroke. **Est. −10% to
−20%** on page-turn/scroll repaints (mostly *subsumed* by Fix 1 at idle).

### Fix 3 — Trim style-recalc cost *(cause #3, do after a trace confirms it)*
- Audit the `inherits:true` `@property` registrations (index.html:2853–2871) — inherited
  animated custom properties widen style-invalidation scope. Make any that needn't inherit
  `inherits:false`.
- Consider extracting the ~4,700-line inline `<style>` into a cacheable stylesheet (parse-once
  across navigations; today it re-parses with every prerendered HTML page).
- **Est. −5% to −15%** on interaction/mode-switch lag on old Android. Low confidence until traced.

### Fix 4 — De-block the 5.7 MB startup parse *(cause #4, optional)*
Parse `quran.json` off the main thread (Web Worker) or stream it; or split it so search can
start with surah metadata and hydrate text lazily. **Est. −100–400 ms** cold-start jank on slow
devices. One-time, not thermal.

---

## Prioritized fix plan (impact ÷ effort)

| Order | Action | Effort | Heat/Lag impact | Risk |
|---|---|---|---|---|
| **1** | **Fix 1a** — bound the Gharib breath to a few cycles, settle static | **Low** | **Very high** (−50–70% Mushaf idle heat) | Low (look preserved) |
| **2** | **Fix 1c** — single animated halo layer per word | Low | High (−15–25%) | Low |
| **3** | **Fix 1d** — one drop-shadow on app | Low | Medium (−10–20% app) | Low |
| **4** | **Fix 2** — only if a trace still shows text-stroke hot post-Fix-1 | Low–Med | Medium (mostly subsumed) | Low |
| **5** | **Fix 1b** — promote + composite opacity (if Fix 1a isn't enough) | Med | High (−40–60%) | Med (re-test halo clip on device) |
| **6** | **Fix 3** — `@property` inherit audit + extract inline CSS | Med | Low–Med | Low |
| **7** | **Fix 4** — worker-parse `quran.json` | Med | Startup only | Low |

**Projected combined outcome:** Steps 1–3 alone target the dominant steady-state cost and
should land in the **50–70%** range for Mushaf lag/heat; adding 4–6 plausibly reaches the
**50–80%** goal — **all while keeping every core feature intact.** These projections rest on
cause #1 being dominant; the traces below either confirm that (and the plan holds) or
re-rank it.

---

## Where you must measure (do not trust the % until you do)

The static read is strong on *mechanism* but cannot measure *magnitude*. Capture these — each
takes a few minutes and turns the inferred numbers into real ones.

### A. Confirm cause #1 is the dominant repaint — **Chrome DevTools, paint flashing** (5 min)
1. Run the **app build** in Chrome (or remote-debug the Android WebView via
   `chrome://inspect`). Open a Mushaf page that has غريب words (gold glow visible).
2. DevTools → **Rendering** panel → enable **"Paint flashing"** and **"Layer borders."**
3. **Touch nothing.** If the غريب words (and the area around them) flash green continuously
   while idle → cause #1 confirmed as a perpetual repaint. If only a tiny composited region
   updates → it's already cheap and #1 drops in the ranking.
4. DevTools → **Layers** panel: check whether `.gharib-word::before` has its own layer
   (it shouldn't, per the code) — confirms the un-promoted re-raster path.

### B. Quantify it — **Performance trace, idle Mushaf** (5 min)
1. Performance panel → **Record ~6 s of a Mushaf page doing nothing.**
2. Read the bottom-up: time in **"Paint"** + **"Composite Layers"** + **"Image Decode."**
   A static reading page should be ~0. If Paint dominates the frame budget at idle → #1/#2.
3. Toggle the lantern **off**, wait for fade, record again. The delta is the Gharib cost.
4. Repeat with **one** غريب word vs a dense page to see if cost scales with word count.

### C. iPhone thermal — **Xcode Instruments** (10 min, the device that actually overheats)
1. Run the iOS Capacitor app on a physical iPhone, attach **Instruments**.
2. Use the **"Animation Hitches"** + **"Core Animation FPS"** + the **GPU** instrument (or
   the Energy/Thermal log). Sit on an idle Mushaf page.
3. Sustained GPU activity / rising thermal state on an idle page = the filtered-halo repaint.
   Toggle Gharib off to confirm the GPU line drops.

### D. Old-Android interaction lag — **Performance trace, mid-interaction** (5 min)
1. On a low-end Android (or 6× CPU throttle in DevTools), record while **turning pages** and
   **switching Tafsir↔Mushaf**.
2. Look for **"Recalculate Style"** and **"Layout"** spikes (cause #3) vs **"Paint"** (cause
   #1/#2). This tells you whether old-Android lag is paint-bound or style-bound, which decides
   whether Fix 3 is worth the effort.

### E. Rule out a leak — **heap snapshots over time** (5 min)
1. Memory panel → snapshot. Turn ~30 Mushaf pages, play/stop audio a few times. Snapshot again.
2. Compare retained size + detached-node count. Flat → no leak (matches the static read).
   Growing → chase the delta (likely candidates: tooltip re-parenting, audio element retention).

---

### Bottom line
One mechanism explains the headline symptom cleanly and matches the timeline: **the Gharib glow
repaints filtered text every frame, forever, on the Mushaf surface.** It is also the cheapest to
fix without touching the feature — bound the animation to a few breaths and settle static. Start
with capture **A/B**; if green keeps flashing on an untouched page, you've found the heat, and
Fix 1a is a few lines of CSS away.
