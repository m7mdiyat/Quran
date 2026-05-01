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

**`src/styles.css`** — Dev styles. **`public/styles.css`** — Production styles served directly (these diverge; keep in sync when changing layout).

### Data Files (in `public/`)

Large JSON files served as static assets:
- `quran.json` — Full Quran text (indexed at startup into `INDEX[]`)
- `surahs.json` — Surah names and ayah counts (metadata only)
- `en.sahih.json` — English Saheeh International translation
- `tafseer_*.json` — 7 classical tafseer books (ibn_kathir, ibn_ashur, muyassar, saadi, tabari, qurtubi, baghawi). **These are also served from the backend GCS bucket on-demand** — local files are a fallback.
- `Bukhari.json`, `Muslim.json` — Hadith collections (used for AI retrieval)

### Backend (`m7mdiyat-backend/`)

Flask app on Google Cloud Run (`me-central1`). Key endpoints:
- `POST /ai` — AI Q&A: retrieves relevant ayaat, tafseer, hadith, then calls Gemini to answer
- `GET /ai/stream` — Same but SSE streaming
- `POST /compare` — Streams AI comparison of 7 classical tafseer books for a given ayah
- `GET /health` — Health check

Data loaded from GCS bucket `m7mdiyat-tafsir-data`. SQLite (in `/tmp/`) used for caching tafsir lookups and pre-generated comparisons.

AI model: `gemini-2.5-flash` (configurable via `GEMINI_MODEL` env var).

### Build Pipeline

`npm run build` runs three steps:
1. `vite build` → `dist/` (bundles `src/app.js`, copies `public/` assets)
2. `scripts/prerender.js` → generates `dist/1/1/index.html` … `dist/114/N/index.html` — one HTML per ayah with SEO content injected (for Google indexing of a SPA)
3. `scripts/generate-sitemap.js` → `dist/sitemap.xml`

Frontend is deployed to GitHub Pages. `public/CNAME` sets the domain to `m7mdiyat.com`. The `public/404.html` captures unknown paths and stores surah/ayah in `sessionStorage` before redirecting to `/`, where `index.html` reads them back.

### Environment

`VITE_API_BASE` in `.env.local` overrides the backend URL (default falls back to the hardcoded Cloud Run URL in `src/app.js:21`).

Audio served from GCS: `https://storage.googleapis.com/recitations-bucket-data/audio/`

URL pattern: `https://www.m7mdiyat.com/{surahNo}/{ayahNo}`
