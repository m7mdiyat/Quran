# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Vite dev server (hot reload)
npm run build        # Full production build: vite build + prerender + sitemap
npm run build:vite   # Vite bundle only (no prerender/sitemap)
npm run prerender    # Generate per-ayah HTML pages for SEO (requires dist/)
npm run sitemap      # Generate sitemap.xml (requires dist/)
npm run preview      # Preview the dist/ build locally
```

Backend (Python Flask, deployed to Google Cloud Run):
```bash
# Deploy backend
gcloud run deploy tafsir-api-sqlite --source m7mdiyat-backend/ --region me-central1 --allow-unauthenticated

# Health check
curl -i "https://tafsir-api-sqlite-317751773286.me-central1.run.app/health"
```

**Deploy gotcha — `MANIFEST_UNKNOWN: Failed to fetch "3.12.x"`:** Cloud Run persists `--set-build-env-vars` flags as a `run.googleapis.com/build-environment-variables` annotation on the service, and every later `--source` deploy reuses them. A prior deploy pinned `GOOGLE_RUNTIME_VERSION=3.12.7`; when Google rotated that patch out of the buildpack registry, every subsequent build failed even though `runtime.txt` said `python-3.12`. Fix: add `--clear-build-env-vars` to the next deploy (one-time). `runtime.txt` (`python-3.12`, minor-only) is the source of truth — do NOT re-pin an exact patch. Diagnose with: `gcloud run services describe tafsir-api-sqlite --region me-central1 --format="value(metadata.annotations['run.googleapis.com/build-environment-variables'])"`.

## Architecture

This is a Quran study SPA (محمديات / m7mdiyat.com) with **no frontend framework** — pure vanilla JS + Vite.

### Frontend

**`index.html`** — Single HTML file for the entire app. Contains:
- Inline JS that runs before `<body>` to set dark mode and parse URL (avoids flash)
- URL routing logic: clean URLs `/surah/ayah` → resolves at load time before the app JS initialises
- SEO meta tag injection (canonical, OG, Twitter)
- A `sessionStorage`-based 404 redirect trick for GitHub Pages (which can't do server-side routing)

**`src/app.js`** (~4000 lines) — Monolithic app module. All state is module-level globals. Key sections:
- **State** (lines ~130–200): `SURAH_META`, `QURAN`, `INDEX`, `CURRENT`, tafsir/compare/audio state
- **`init()`** (line 3692): Loads `quran.json` + `surahs.json`, builds search index, attaches all event listeners
- **`searchText()`** (line 1686): Arabic text search with diacritics-aware normalisation
- **`setPrimaryAyah()`** (line 3046): Central function — updates URL, SEO, context panel, tafsir, audio state
- **`updateTafsirUI()`** (line 2253): Fetches tafsir from API on demand, falls back to local JSON cache
- **`handleCompareTafsirs()`** (line 2805): Streams AI tafsir comparison via SSE
- **`handleAiAsk()`** (line 3327): AI Q&A — calls `/ai` endpoint, renders results with typewriter animation
- **Audio** (lines ~419–800): GCS-hosted MP3s, multiple reciters, speed control (1x/1.25x/1.5x/2x), listening mode (auto-advance through surah), fade-out on tafsir open

**`src/mushaf.js`** — Mushaf reading mode: QCF4 page rendering, surah/ayah selector (iOS-style wheel picker), the Tafsir↔Mushaf toggle, and the full per-page audio engine used in Mushaf mode. Owns the QCF4 asset download/cache path for the Android app.

**`src/surahAudio.js`** — Full-surah timed playback engine (single MP3 per surah with per-ayah timing offsets, all reciters). Replaced the older per-ayah file-per-ayah system; used by both Mushaf and Tafsir modes.

**`src/gharib.js`** — غريب القرآن learning feature (Mushaf mode, web + app): gharib words carry an edgeless glyph-attached glow (duplicate-glyph pseudos: layered gold text-shadow halo + background-clip:text molten-ink sheen, opacity-only keyframes with all words breathing in the same phase — no boxes/pills/outlines, em-sized so zoom needs no re-measure; in the app the halo is filter: blur()+drop-shadow() on a full-alpha gold glyph copy because WKWebView won't paint text-shadow on the duplicated layer), a compact meaning tooltip that grows out of the tapped word, persisted learned-set (`localStorage["m7_gharib"]`, keyed by normalized word — learned once = settled everywhere), and the toolbar lantern button (count badge + per-page segmented ring with an 80° badge-dock notch; the lantern also toggles the whole feature on/off with a transitioned `--gh-on` fade, persisted as `off` in the same store, and joins the fullscreen floating cluster via CSS re-anchoring). Data: `public/gharib.json` (~680 KB, lazy-loaded on first Mushaf page). Words are located by matching normalized gharib text against the QCF4 page data's per-word vocalized `text` fields — three normalization tiers; run `node scripts/audit-gharib.mjs` after ANY normalizer change (expected: 6,106/6,107 located). Wired via the `mushaf:page-rendered` event + small `gharibTapTarget()` checks in mushaf.js's tap handlers.

**`src/offline-panel.js`** (app only) — Header cloud-arrow button + sheet for Mushaf/Tafsir offline downloads. Dynamic-imported behind `isApp()`; never loaded on the website.

**`src/feedback-panel.js`** (app only) — Header chat-bubble button + sheet that POSTs to `/feedback`. Dynamic-imported behind `isApp()`; never loaded on the website.

**`src/styles.css`** — Dev styles. **`public/styles.css`** — Production styles served directly (these diverge; keep in sync when changing layout).

### Data Files (in `public/`)

Large JSON files served as static assets:
- `quran.json` — Full Quran text (indexed at startup into `INDEX[]`)
- `surahs.json` — Surah names and ayah counts (metadata only)
- `en.sahih.json` — English translation. **Filename is legacy** — the contents are now Mustafa Khattab's "The Noble Quran" translation (swapped in earlier; all user-facing copy says "Mustafa Khattab"). Filename kept to avoid touching every import path.
- `tafseer_*.json` — 7 classical tafseer books (ibn_kathir, ibn_ashur, muyassar, saadi, tabari, qurtubi, baghawi). **These are also served from the backend GCS bucket on-demand** — local files are a fallback.
- `Bukhari.json`, `Muslim.json` — Hadith collections (used for AI retrieval)

### Backend (`m7mdiyat-backend/`)

Flask app on Google Cloud Run (`me-central1`). Key endpoints:
- `POST /ai` — AI Q&A: retrieves relevant ayaat, tafseer, hadith, then calls Gemini to answer
- `GET /ai/stream` — Same but SSE streaming
- `POST /compare` — Streams AI comparison of 7 classical tafseer books for a given ayah
- `POST /tafsir` — Direct tafsir lookup by surah/ayah from the SQLite cache
- `POST /compare-text` — Returns the pre-generated مختصر التفاسير summary for a given surah/ayah
- `POST /feedback` — Accepts user feedback from the Android app; writes one JSON per submission to `gs://m7mdiyat-tafsir-data/messages/`. Honeypot + per-IP rate limit; optional email; CORS whitelist includes Capacitor WebView origins (`https://localhost`, `http://localhost`, `capacitor://localhost`).
- `GET /health` — Health check

Data loaded from GCS bucket `m7mdiyat-tafsir-data`. SQLite (in `/tmp/`) used for caching tafsir lookups and pre-generated comparisons.

AI model: `gemini-2.5-flash` (configurable via `GEMINI_MODEL` env var).

### Build Pipeline

`npm run build` runs three steps:
1. `vite build` → `dist/` (bundles `src/app.js`, copies `public/` assets)
2. `scripts/prerender.js` → generates `dist/1/1/index.html` … `dist/114/N/index.html` — one HTML per ayah with SEO content injected (for Google indexing of a SPA)
3. `scripts/generate-sitemap.js` → `dist/sitemap.xml`

Frontend is deployed to GitHub Pages. `public/CNAME` sets the domain to `m7mdiyat.com`. The `public/404.html` captures unknown paths and stores surah/ayah in `sessionStorage` before redirecting to `/`, where `index.html` reads them back.

For the **Android app**, use `node scripts/build-app.js` instead — it runs the full `npm run build`, copies `dist/` to `dist-app/`, then prunes the SEO/prerender content (the per-ayah HTML pages, Mushaf page pre-renders, Bukhari/Muslim JSON, sitemap, etc.) and gzips the large tafsir JSONs. Final `dist-app/` bundle is ~30 MB (vs ~1 GB for the website build). See the Capacitor Android app section below.

### Capacitor Android app

The same codebase also ships as an Android app via a Capacitor wrapper. The wrapper project lives **outside this repo** at `~/Desktop/M7MDIYAT/Quran-Android`. Build + sync flow:

```bash
cd ~/Projects/m7mdiyat-vite && node scripts/build-app.js            # produces dist-app/
cd ~/Desktop/M7MDIYAT/Quran-Android && npx cap sync android          # copies dist-app/ → android/app/src/main/assets/public
```

Then open the Android Studio project at `~/Desktop/M7MDIYAT/Quran-Android` and hit ▶ to build the APK and install on the device/emulator. `cap sync` only updates the source files inside the Android project — it does NOT push a running APK; the device keeps the old APK until you rebuild + install.

Large assets that don't ship inside the APK (full QCF4 Mushaf font/data, all 7 tafseer JSONs, etc.) are mirrored to the GCS bucket `m7mdiyat-tafsir-data` and downloaded on first use into the WebView's Cache API. Users can manage these via the in-app offline panel (`src/offline-panel.js`).

### App-only UI conventions

Several features (offline downloads, feedback form, QCF4 caching) only exist in the Android app — the website never sees them. The pattern, applied consistently:

1. **`isApp()` detection MUST be call-time, not module-load-time.** `window.Capacitor` is injected by the native bridge AFTER scripts evaluate; a `const IS_APP = window.Capacitor !== undefined` captured at module load is `false` even inside the app. Always evaluate `isApp()` inside a function call. The canonical helper lives in `src/app.js` (exported).
2. **Header buttons** for app-only features start `display:none` in `index.html`. The owning module reveals them in its `init…Panel()` only after `isApp()` returns true. The cluster wrapper `.header-app-actions` is empty on the website.
3. **Dynamic imports gated by `isApp()`.** Each app-only feature is its own module (`src/offline-panel.js`, `src/feedback-panel.js`) and is dynamic-imported from `src/app.js init()` behind `if (isApp())`. The website bundle never even contains the module code (separate Vite chunks).

When adding any new app-only feature, follow this same recipe.

### iOS WKWebView gotchas (read before touching panels, overlays, or scroll)

The app ships in a WKWebView (Capacitor iOS, deployment target **15.0**) where the chrome is `position:fixed` (`header.site-header`) and the root is `html{height:100%}`. That combination makes several "standard" web techniques actively break. These cost hours to diagnose — follow the patterns, don't re-derive them.

**Scroll-locking a sheet/modal/coachmark — behavioral only, NEVER layout.** The background-scroll lock for every header sheet (`offline-sheet-open`) and first-use coachmark (`mushaf-coach-open`) lives in `src/sheet-scroll-lock.js` and MUST stay purely behavioral (`preventDefault` on `touchmove`), mutating NO layout. Two layout-based locks were tried and both break WKWebView:
- `position:fixed` on `<body>` → re-anchors the body's `position:fixed` header/chrome, flashing/jumping the layout on open AND close.
- `overflow:hidden` on the root → the root is `height:100%`, so it CLIPS the taller page (detached/cut-off bottom) and shifts the coordinate context, mis-placing every fixed overlay.
The behavioral guard reflows nothing, so the fixed chrome stays put and overlay coordinates stay exact. Any new panel/sheet/modal reuses this lock — add its body-class to `shouldLock()`; do not invent a CSS lock.

**Scroll-chaining is the hidden culprit — contain the _inner_ scroller, guard its edges in JS.** A scrollable element inside a panel chains its scroll to the page at its top/bottom edges; that page movement _under the fixed dim overlay_ is what visibly breaks the layout. The real scroller is usually an INNER element (the list), not the card. So apply `overscroll-behavior:contain` to the actual inner scroller (not just the card) AND guard the chain at its edges in JS (`findScroller` + `preventDefault` when at-top-pulling-down / at-bottom-pulling-up). `overscroll-behavior:contain` alone is unreliable on WKWebView — the JS guard is the real guarantee.

**`position:fixed` floating UI anchors to the SCROLLED DOCUMENT, not the viewport.** When the page is scrolled, a naive `position:fixed` element lands at the wrong place on WKWebView — this bit the gharib tooltip, the splash, and the onboarding guides. Don't use naive `position:fixed` for floating UI. Use the proven root-hosted / live-position pattern the gharib word-meaning tooltip uses: host at the root and position from the target's live `getBoundingClientRect()`.

**Positioning an overlay on a target — poll the rect until steady, NEVER a fixed rAF count.** Place + reveal an overlay (coachmark/guide/tooltip) only once the target's `getBoundingClientRect()` has held steady for ~2 frames (keep it invisible until then; cap the poll so it can't hang). Do NOT reveal after a fixed number of rAFs ("after 2 frames"). Lazily-created or sibling-shifted targets (the lantern is created lazily; inserting the notes lamp shifts it via the flex spacer) are not settled in a fixed frame count on fast entry — that is exactly what mis-placed the guide. See `revealWhenSettled` in `src/gharib.js`.

**`:has()` needs iOS 15.4+** — the deployment target is 15.0, so it silently no-ops on 15.0–15.3. Don't rely on `:has()` for anything load-bearing.

### Font loading (FOUT on first install)

Custom fonts MUST be bundled locally and force-loaded at boot — never fetched remotely at runtime — or the first sheet that uses a not-yet-downloaded weight on a FRESH install flashes the fallback then swaps (FOUT). Don't assume a font is "already cached from elsewhere."

IBM Plex Sans Arabic (the panels + mushaf-footer font; Arabic subset; weights **400/500/600/700**) ships in `public/fonts/ibm-plex-arabic-*.woff2` with a local `@font-face` in `index.html` inside `<style id="offlinePanelFont">`. That id is deliberate: every panel's old `ensurePanelFont()` checks `getElementById("offlinePanelFont")` and skips when it exists, so they no longer inject the remote Google-Fonts `<link>` (which, loading later, would override the bundled face and bring the flash back — later same-family `@font-face` wins the cascade). `@font-face` fonts load lazily (only when text first uses them), so `src/app.js init()` force-loads each weight at boot via `document.fonts.load()`. To add a weight/style: drop the woff2 in `public/fonts/`, add its `@font-face` to that `<style>`, and force-load it. `scripts/build-app.js` prunes only `fonts/qcf4`, so `public/fonts/*.woff2` ship in the app bundle.

### Environment

`VITE_API_BASE` in `.env.local` overrides the backend URL (default falls back to the hardcoded Cloud Run URL in `src/app.js:21`).

Audio served from GCS: `https://storage.googleapis.com/recitations-bucket-data/audio/`

URL pattern: `https://www.m7mdiyat.com/{surahNo}/{ayahNo}`
