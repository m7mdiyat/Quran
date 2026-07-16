# وضع التسميع (Tasmee' / Memorization Test Mode) — Implementation Plan

**Status: APPROVED (Option A, 2026-07-10). Amendments A1–A4 folded in; §9 is a decisions
log. GATE 1 PASSED + GATE 2 PASSED 2026-07-10 (results inline below). Truth schema v1
finalized (`tests/tasmee/golden/TRUTH-SCHEMA.md`). Next: golden clips land → GATE 3.**

Feature: a mic button in Mushaf mode. All words on the page hide; the user recites from
memory; each correctly recited word reveals in place, in order. Word-level mistakes are
flagged: substitution, omission, insertion, hesitation (→ hint). Target: exceed Tarteel's
MMD on **repetition tolerance, offline capability, and being free**.

Scope constraints (hard): m7mdiyat only (`handy-digit-482820-m6`); never touch hakam-501212.
App stays free/ad-free — recurring cost is a design input, not an afterthought. No audio
retention server-side without explicit opt-in (moot under the recommended architecture:
audio never leaves the device).

---

## §0 Audit findings

### 0.1 Mushaf rendering — per-word spans ALREADY exist; zero refactor for stable-layout hide

- `renderPage` → `buildLineElement` (`src/mushaf.js:1787–1836`) creates one
  `<span class="mushaf-word">` **per word entry**, wrapped in per-ayah
  `<span class="mushaf-ayah" data-verse-key="s:a">`. Each span's `textContent` is a single
  QCF4 PUA glyph (one glyph = one whole word) with a per-word `fontFamily`. Ayah-end
  markers are `.mushaf-word.mushaf-end`.
- `.mushaf-word { display:inline-block }` (`public/mushaf.css:646`). **Hiding =
  `color: transparent`** — the glyph keeps its exact advance width, so layout/metrics are
  untouched by construction (no reflow, no re-fit). The app-only faux-bold
  `-webkit-text-stroke: … currentColor` (`mushaf.css:3628`) follows `currentColor`, so it
  hides with the same rule. Gharib's glow pseudos re-render the glyph independently of
  `color` and must be suppressed during a session (toggle exists: `applyGharibOff`,
  `src/gharib.js:572`).
- Post-render decoration hook exists: `mushaf:page-rendered` event with
  `{page, el, data}` (`src/mushaf.js:1707`) — exactly how gharib decorates words.
- **Word↔span mapping is a solved problem** — copy gharib's pattern verbatim
  (`src/gharib.js:400–434`): count every `verse_key`-carrying non-`end` entry as a DOM
  index (`dom`), because the 199 quarter (۞) markers also render as `.mushaf-word` spans
  inside ayah containers and desync naive indices. `spansFor(vk)` =
  `.mushaf-ayah[data-verse-key] .mushaf-word:not(.mushaf-end)`.
- Tap routing: page `click`/`touchend` handlers consult `gharibTapTarget()` **before** the
  audio toggle (`src/mushaf.js:2136, 2221`) — tasmee inserts a `tasmeeTapTarget()` check at
  the same two points. Long-press opens the ayah copy/note menu (`:2181`) — must be
  suppressed in-session (copy would leak the hidden text).
- Fullscreen runs in-place on the same DOM (`src/mushaf.js:1852–1897`) — tasmee works there
  for free; the mic button joins the fullscreen floating cluster via the same CSS
  re-anchoring the lantern uses.

### 0.2 Word-level text data — per-word Uthmani sequence is client-side TODAY

- `public/data/qcf4/pages/{001..604}.json` (21 MB total, bundled on website, GCS-fetched in
  app): per line → per word: `{code, char, font, text, type, verse_key, position}`.
  Types across the corpus: **word 77,448 · end 6,236 · bismillah 112 · surah_header 114 ·
  quarter 199**. Pages hold 29–161 words (avg 128).
- `text` is QCF-derived hybrid spelling (e.g. `الصَّلَواة`, `الم` plain) — neither clean
  Uthmani nor Imlaei. **Sajda marks are `type:"word"` with `text:"#NNNN"`** (e.g. 7:206
  position 12 = `#1969`) — filter `text[0] === '#'` to get recited words.
- `verses.json` maps every `s:a` → page + line word-ranges; `index.json` has chapter meta.
- **Alignment experiment (ran during this audit)** — quran.json space-split vs QCF4
  positions over all 6,236 ayahs: naive = 2,933 mismatches; after two mechanical rules
  (strip standalone waqf-mark tokens + strip the basmala embedded in every surah's first
  ayah) + `#`-filter ≈ **35 residual**, in recognizable classes: `يَا`/`وَيَا` vocative fusions
  (QCF one word, Imlaei two), `هَا أنتم`-type fusions, and `بعدما`-type splits (Imlaei one
  word, QCF two). A small rule set + an explicit ≤~40-entry exception table, driven to
  **6,236/6,236 by a build-time audit script** (pattern: `scripts/audit-gharib.mjs`), is
  cheap and verifiable. quran.json (`public/quran.json`, alquran.cloud format, BOM-prefixed)
  is the Imlaei-leaning ASR-facing source.
- `words_of()` (WhisperX pipeline): **source lives on the Windows aligner box (`D:\test\`),
  not this Mac** — only output JSONs are local (`~/Downloads/Code/timestamps/`). Its exact
  behavior was reconstructed from outputs: strip all marks **including dagger alef
  (dropped, not expanded)**, fold `ٱأإآ→ا`, **keep** `ة ى ء ؤ ئ`. A sibling normalizer
  exists at `~/Downloads/Code/gharib-pipeline/normalize.py` with different folds. Neither
  is ASR-facing enough alone; the in-repo, audited `gharibNorm1/2` tiers
  (`src/gharib.js:98–146`) already bridge QCF hybrid spellings (`الصلاة↔الصلواة`,
  `سنة↔سنت`, `بسطة↔بصطة`) and are the best starting point for the matching normalizer.
- Aligner timing files (`timings/{reciter}/{surah}.json`, per-ayah `{start,end}` ms) exist
  for all reciters — irrelevant to v1, useful later for audio hints.

### 0.3 Page → ayah mapping — yes

`CURRENT_PAGE_DATA` holds the full page JSON (`surahs` array with `verse_start/verse_end`
per surah, plus every word's `verse_key`). The reference word sequence for the current page
is derivable locally with zero new data requests.

### 0.4 Mic capture in the Capacitor WebView — greenfield; wrappers unverified (TCC)

- Web repo has **zero** audio-capture code (no `getUserMedia`/`AudioContext`/
  `AudioWorklet`/`MediaRecorder` anywhere in `src/`). Capacitor 8 (`@capacitor/ios ^8.4.0`
  in `package.json`). Plugins used via runtime bridge only: Haptics, StatusBar,
  SplashScreen (`hapticLight` at `src/mushaf.js:104`; SUCCESS notification at
  `src/gharib.js:967`).
- Origins are secure contexts on both platforms (Android `https://localhost`, iOS
  `capacitor://localhost`) → `getUserMedia` is not scheme-blocked. AudioWorklet: iOS
  Safari ≥14.5, Android WebView — both fine at our floors (iOS 15.0 / modern WebView).
- **`~/Desktop/M7MDIYAT/` wrappers are TCC-blocked from this session** (EPERM even
  unsandboxed). Could not verify AndroidManifest / Info.plist. Since no mic feature exists,
  assume: Android `RECORD_AUDIO` **absent** (must add + Capacitor's bridge handles the
  WebView `onPermissionRequest` → runtime prompt), iOS `NSMicrophoneUsageDescription`
  **absent** (must add). Verification is the first acceptance item of GATE 6/7. If you can,
  grant Full Disk Access or run the wrapper edits in your own terminal.
- Known WKWebView facts to design around: hardware capture is 48 kHz (resample to 16 kHz
  in our worklet — don't request a 16 kHz AudioContext); AVAudioSession switches to
  play-and-record while capturing; backgrounding suspends the AudioContext (handle
  `statechange` + `visibilitychange` → auto-pause).

### 0.5 Offline download infra — directly reusable for a one-time ~140 MB model download

- Three existing channels (QCF4 / Tafsir / Reciters), all: Cache API + localStorage
  ready-flag + fixed-concurrency fetch loop + 2 retry passes + re-arm on `online`. No
  service worker anywhere.
- **The verified-put pattern to copy** (memory lesson): `fetch {cache:"reload"}` →
  `res.ok` → `cache.put` → **`cache.match` re-read to confirm** → final whole-set
  missing-files guard before setting the ready flag (`cacheTafsirFile` `src/app.js:825–847`,
  `cacheOne` `src/reciter-offline.js:161–178`). QCF4's own path is the weaker legacy
  variant — don't copy it.
- **Single ~131 MB file is precedented**: reciter channel stores single 100 MB+ MP3s as one
  Cache API entry (`src/reciter-offline.js:44`). No Range/resume support exists — a model
  download is all-or-nothing per file (acceptable; retry loop covers flaky networks).
- GCS bucket `m7mdiyat-tafsir-data` already serves working CORS to the WebView origins and
  the website — model assets placed there inherit it.
- Gaps to add for a 131 MB file: `navigator.storage.estimate()` quota preflight and a
  cellular warning (no `navigator.connection` checks exist today).

### 0.6 Backend — Cloud Run cannot do WebSockets as deployed; any server ASR is greenfield

- `m7mdiyat-backend/` = one Flask file (`main.py`, 2,691 lines) + 4-line
  `requirements.txt` (functions-framework, google-cloud-storage, google-genai,
  flask-cors). **No Dockerfile** — buildpacks → gunicorn **sync** workers → **no WS**
  without a stack change (async worker or new service). SSE exists only on `/ai/stream`
  (`main.py:2609–2650`); `/compare` is a synchronous blob. No CPU/memory/concurrency
  tuning anywhere (Cloud Run defaults). Zero audio/ML deps.
- A server ASR path would require: new Dockerfile service (faster-whisper + tarteel ct2
  model, VAD), chunked-POST or SSE transport (not WS), session affinity, concurrency ≈1–2
  per instance, min-instances to dodge 10 s+ cold model loads. All new surface area.

---

## §1 Architecture decision

### Options

| | A · On-device ONNX | B · Server streaming | C · Staged hybrid (B→A) |
|---|---|---|---|
| Model | FastConformer-hybrid-large ar CTC, int8 ONNX, 131 MB (CC-BY-4.0) via onnxruntime-web WASM in a Worker | tarteel whisper-base-ar-quran (ct2 141 MB fp16) on Cloud Run CPU | B first, A later |
| Marginal cost | **$0 per minute** (one-time ~$0.02–0.03 egress per device download) | ~$0.002–0.004 per recitation-minute (see §8) — scales with success | B's costs while it lives |
| Offline | **Yes** (differentiator #2) | No | Not until stage 2 |
| Privacy | Audio never leaves device | Voice uploaded (opt-in policy needed) | Mixed |
| Latency to reveal | ~0.5–1.5 s (local decode) | chunk (3–5 s) + upload + infer ≈ 2–6 s | worse then better |
| Infra | None (GCS static hosting only) | New Docker service, transport, affinity, cold starts | Both |
| Risks | WASM perf on old devices; memory (~400–600 MB peak); 131 MB download friction | Recurring cost; internet required; ops | Pays for B to throw it away |

### Recommendation: **Option A** — on-device ONNX. ✅ APPROVED 2026-07-10

Why A wins on our stated goals: all three differentiators (free / offline / repetition-
tolerant) survive only under A. B's recurring cost is open-ended for a free app (§8: a
modest 1,000 users × 10 min/day ≈ **$0.7–1.7k/month forever**), requires internet in the
exact use-case (private memorization review, often in a mosque with bad connectivity), and
its chunked transport gives a *worse* reveal latency than local streaming decode.

Why C is rejected: its only benefit is "validate matching UX before betting on WASM," but
the matching UX is validated **without any server**: the alignment engine is pure JS tested
by scripted transcripts (GATE 2, no audio at all), and the ONNX path has a working
reference implementation (offline-tarteel) that runs on desktop web in days (GATE 3–4).
Building B's greenfield service to de-risk A costs more than the risk it retires.

**B is retained as the documented fallback** if GATE 3/6 hard-fails (WER or device RTF):
the ASR sits behind a small interface (`src/tasmee-asr.js` — init/pushAudio/onTokens), so a
pivot swaps one module + adds one backend service; engine and UX are untouched. Fallback
sketch: client VAD → 3–5 s WAV chunks → POST to a new `tasmee-asr` Cloud Run service
(Dockerfile, faster-whisper int8, concurrency 2, min-instances 0) → SSE/JSON tokens.

Model choice within A: FastConformer CTC (a) over whisper-base (b) because (b) is not
natively streaming (1–2 s chunk re-decode, worse latency, encoder-decoder = heavier in
WASM) and (a) has the proven in-browser reference with streaming + stability gating.
License: CC-BY-4.0 → attribution line in the app's about panel (GATE 8). The
offline-tarteel **code** license must be checked before porting anything verbatim; if
unlicensed, re-implement (mel + CTC greedy decode are textbook; their repo is used as a
reference for constants and the stability-gate concept).

---

## §2 The alignment engine (client-side, transport-agnostic)

New module `src/tasmee-engine.js` — **pure**: no DOM, no audio, no timers, no `Date.now()`.
Consumes timestamped events; emits classified events. This is what makes GATE 2 testable
with fixtures before any audio exists.

### 2.1 Reference sequence (per session)

Built from `CURRENT_PAGE_DATA`: all `type==="word"` entries with `text[0]!=="#"`, page
order, each `{vk, position, domIndex, matchForms}`. The engine also exposes
`extendReference(words)` — near page end (`p ≥ n−K`) the UI layer appends the next
page's opening words so auto-advance (§4) crosses the boundary without a session break;
covered by a Gate 2 fixture. `matchForms` come from the build-time
dataset (§2.6): primary Imlaei skeleton + variants. Optional prefix block: if the page
starts a surah (≠9) or begins with a `bismillah` line, the basmala's 4 tokens are an
**optional prefix** — matched if recited, silently skipped if not, never an omission.
Bismillah/surah-header lines stay visible (they are not part of the test).

### 2.2 State

- `p` — pointer to next expected word (index into reference).
- `K` — lookahead window, default 4 (configurable).
- Back-window `B` — last `max(30, current+previous ayah)` revealed words.
- `shadow` — re-recitation run tracker (start index + cursor), null when inactive.
- `pending` — one held token for split-token pairing (flushed after next token or 700 ms).
- Per-word result array + event log.

### 2.3 Token classification (ordered; first rule that fires wins)

For each **stable** token `t` (§2.5), with `sim()` = normalized Levenshtein over
match-forms (best across variants), thresholds: exact for normalized length ≤2, θ_match
0.75, θ_sub 0.45 (initial values; tuned at GATE 2/3):

1. **MATCH** — `sim(t, R[p]) ≥ θ_match` → reveal `p` correct; `p++`; clear `shadow`.
   Ties with behind-matches resolve here by construction (identical-word runs: فبأي آلاء…
   advance rather than loop).
2. **MERGED MATCH** — `sim(t, R[p]+R[p+1]) ≥ θ_match` (ASR fused two words, common under
   idgham/liaison) → reveal both correct; `p += 2`. (Mirror of gharib's `findMerged`,
   `src/gharib.js:167`.)
3. **SPLIT BUFFER** — `t` is a proper prefix-ish fragment (`sim(t+next, R[p])` may win) →
   hold in `pending` one round; if the pair matches, reveal; else fall through with `t`.
4. **OMISSION** — best `j ∈ [1,K]` with `sim(t, R[p+j]) ≥ θ_match`; **corroboration is
   required for ALL j ≥ 1** (the *following* token must match `R[p+j+1]`) before
   committing → mark `p..p+j-1` **skipped** (revealed, amber), reveal `p+j` correct,
   `p = p+j+1`. *(Amended at Gate 2: the original j=1-commits-immediately rule falsely
   skipped a word when an inserted phrase's tail echoed a nearby expected word — e.g.
   استغفر الله right before an expected …الله…. Cost: omission reveals lag one token.)*
5. **REPETITION (never a mistake — headline differentiator)** — best match in back-window
   `≥ θ_match` → no error, no pointer move. Sequential behind-matches advance `shadow`;
   when the shadow run reaches `p`, it merges back into normal advancement (user re-recited
   from an earlier point and caught up — e.g. restarting an ayah after a stumble). Log
   `repetition` events for the summary only.
   **Refrain safety (dual-cursor deferral, added at Gate 2)**: a token matching both
   behind AND ahead (فبأي آلاء… exists in both directions) is undecidable from text
   alone — repeating the previous refrain reads identically to skipping to the next one.
   The engine runs both cursors silently, buffering tokens (cap 8), and commits only when
   a token matches exactly one continuation: behind-only → repetition (buffered tokens
   emitted as repetitions), ahead-only → corroborated omission (skips + reveals emitted
   then). Neither/cap/stop → repetition, the non-destructive default. Nothing is emitted
   while ambiguous — reveals never retract, and the pointer never silently jumps between
   refrain instances.
6. **SUBSTITUTION** — `sim(t, R[p]) ≥ θ_sub` → reveal `p` in red, store `heard=t`, `p++`.
7. **INSERTION** — otherwise → insertion counter at gap `p`, store `heard`, no advance.

**ECHO-SUBSTITUTION (Gate 2 addendum #2)** — a real mistake that echoes an earlier
recited word must not hide behind repetition tolerance (يؤمنون said where يوقنون is
expected, with يؤمنون sitting behind — the worked truth example's own planted sub).
Contract: (a) EXACT equality at the pointer always wins — immune; (b) a FUZZY pointer
match (θ_match ≤ sim < 1) whose token exactly equals a word in the back-window defers
ONE token: if the next token continues the behind run → repetition (legit re-recitation,
e.g. الكافرون); otherwise → **substituted at p** (flagged); (c) same one-token deferral
when sim(t, R[p]) is in the substitution band and any behind-match exists; (d) at
`stop()`, an unresolved echo commits as substitution — silent repetition of a real
mistake is the defined failure. Documented side effects: catches dropped-waw mistakes
(علي for وعلي، الذين for والذين) for free; a stutter-repeat of the previous word when it
near-misses the current one can flag a substitution (accepted trade); when the echo's
continuation matches BOTH readings (والذين/الذين with يؤمنون following both) the
non-destructive behind path runs first and the mistake surfaces as corroborated skips —
flagged either way. All 13 refrain fixtures stay green under these rules.

**STALL-RESYNC (Gate 2 addendum #1 outcome)** — found by the 20-seed sweep: a
drop-cluster that puts the live stream further ahead than the lookahead window can see
wedges the pointer forever (every token an insertion). Recovery: `stall` counts
consecutive UNPLACEABLE tokens only — insertions, never repetitions, so long legitimate
re-recitation runs (refrain riffs) can never arm a forward jump. At `stall ≥ 6`, resync
requires TWO consecutive tokens matching forward within 60 words (≥ θ_match each, at
least one exact — the same corroboration bar omissions have); jumped words are marked
skipped (honest: unconfirmable) and a `resync` event is logged.

**HESITATION** — the audio layer posts `silence(ms)` accumulations; at `H` s (default 4,
range 2–8) with `p < n`, emit `hesitation` → UI pulses the hint affordance. `hint()`
reveals `R[p]` as *hinted* (gold), `p++`. Optional auto-hint after `H_auto` (off by
default).

**Muqatta'at** — expected words from the 29 opening set (الم، الر، المر، المص، كهيعص، طه،
طسم، طس، يس، ص، حم، عسق، ق، ن) carry extra match-forms: the letter-name expansion
(`الم → الف لام ميم`, matched as a multi-token sequence) AND the literal string (ASR output
varies). A small static table in the engine.

**Waqf/pausal forms** — normalization (§2.6) folds `ة→ه`; tanwin/harakat are stripped, so
pausal recitation matches automatically.

### 2.4 Loop mode (v1 engine, v2 UI unless you say otherwise)

`setLoop({from, to, passes})`: at `p > to`, pointer resets to `from`, pass counter++,
`loop_pass_completed` emitted; reveals reset to "dimmed-revealed" between passes; mistakes
aggregate per pass. This rides on the repetition machinery — nothing loops-specific in
classification.

### 2.5 Confidence gating (anti-flicker)

The ASR worker re-decodes a sliding window every chunk. A token is **committed** to the
engine only when it appears at the same position in ≥2 consecutive decodes AND ends ≥300 ms
before the audio edge (decode-stability gate, per the offline-tarteel reference). The
engine only ever sees committed tokens — reveals never retract.

### 2.6 Matching data + normalizer (build-time, audited)

- `scripts/build-tasmee-words.mjs` → `public/tasmee-words.json` (~800 KB raw / ~300 KB gz,
  bundled web + app): `{ "s:a": ["form1|alt", …] }`, index-aligned to QCF4 `position`
  (sajda `#` entries excluded). Sources: quran.json (Imlaei) + QCF4 pages, aligned by the
  §0.2 rules (waqf-token strip, basmala strip, `يا/ويا` merge, exception table) — **audit
  asserts 6,236/6,236 ayahs and exact per-ayah counts** (`scripts/audit-tasmee-words.mjs`,
  modeled on audit-gharib).
- Runtime normalizer (shared by build + engine, one exported JS function): strip
  marks/tatweel/BOM (reuse `MARKS_RE`, `src/gharib.js:77`), fold `ٱأإآ→ا`, `ؤ→و`, `ئ→ي`,
  `ء` dropped, `ة→ه`, `ى→ي`, collapse elongations. Applied identically to dataset words and
  ASR tokens (symmetry is the correctness property; the gharib tiers prove these folds on
  this exact corpus).

### 2.7 Events, summary, persistence (local-first)

- Event log: `{t, type, wordIdx?, vk?, heard?, sim?}` for
  `reveal(correct|substituted|skipped|hinted) · insertion · repetition · hesitation ·
  ayah_completed · page_completed · loop_pass_completed`.
- Summary per session: totals + per-ayah rollup + accuracy % = correct / recited-expected.
- Storage (localStorage, `m7_` convention): `m7_tasmee_settings`,
  `m7_tasmee_sessions` (cap 50, ~2 KB each), `m7_tasmee_mistakes` keyed `"s:a:pos"`
  (counts by kind + lastTs — fuel for a future "historical mistakes" drill view). IndexedDB
  only if sessions outgrow localStorage (not v1).

---

## §3 ASR runtime (Option A specifics)

- `src/tasmee-audio.js` — `getUserMedia({audio:{echoCancellation:true,noiseSuppression:true}})`;
  AudioWorklet node (bundled worklet file) captures at the context's **hardware rate —
  typically 48 kHz; never request a 16 kHz AudioContext** — then an **explicit resampler
  to 16 kHz mono Float32 runs BEFORE the mel stage** (carried over from the reference
  repo's implementation, not assumed; exercised by the Gate 3 harness, which feeds
  48 kHz WAVs through the full path). RMS-gated VAD (drives `silence()` events + skips
  ASR on silence for battery), 300 ms chunks via transferables to the worker. (A4) On session start call
  `stopMushafAudio()` (`src/mushaf.js:4144`). Handle `visibilitychange` +
  AudioContext `statechange` → auto-pause, resume on user gesture.
- `src/tasmee-worker.js` (Web Worker) — onnxruntime-web WASM EP, `numThreads:1` (no
  COOP/COEP dependency), SIMD when available (Android WebView yes; iOS ≥16.4; iOS 15.x
  falls back non-SIMD ≈2–4× slower — capability-probed, see GATE 6). **Mel frontend is
  OURS** (the artifact-of-record takes `audio_signal [1,80,T]`): independent
  implementation of the NeMo preprocessor parameters (preemph 0.97 · n_fft 512 / hop
  160 / hann 400, center-reflect · |X|² · 80 slaney mels 0–8 kHz · log + 2⁻²⁴ ·
  per-feature normalization) — validated by a correct first-run transcript on real
  recitation in the Gate 3 bench, whose implementation the worker ports. Greedy CTC
  decode + word-identity stability gate. Streaming design validated by the Gate 3
  bench on real recitation:
  0.3 s chunks; 12 s PINNED window whose anchor jumps in large steps **snapped to
  VAD-silent slots** (a per-chunk sliding edge jitters frame timing and re-commits
  duplicate words; a mid-word window start truncates the boundary word); 0.3 s edge
  holdback; stability compared at tasmeeNorm word identity (surface tashkeel flaps with
  right-context); madd-aware bookkeeping (a stretched vowel extends a word's CTC end,
  then backdates on settle — the extended end is used for phantom-dup rejection and
  latency anchoring only, never to advance the commit pointer). Adaptive stride
  300→900 ms when RTF > 0.8 (graceful degradation: reveals arrive in small batches
  instead of falling behind).
- Assets (GCS `m7mdiyat-tafsir-data/tasmee/v1/<sha256-prefix-12>/` — immutable,
  hash-versioned per the Gate 3 provenance rule): `fastconformer_ar_ctc_q8.onnx`
  (**131.7 MB**, uint8 — the ARTIFACT-OF-RECORD, sha256 `7e7f9aac…` per
  `models/tasmee/checksums.txt`; the 88 MB "v0.2.0" candidate is quarantined — see
  the Gate 3 provenance block), `vocab.json` (21 KB, 1025 tokens, `<blank>`=1024),
  pinned `ort-wasm[-simd].wasm` (~10 MB; served locally on website builds — the
  zero-remote-fonts rule generalizes: no CDN at runtime). The app config carries each
  asset's sha256: full-hash verify at download time, byte-length re-verify at session
  start. Total on-device ≈ **145 MB**.
- **Model durability (A3a) — eviction is observed fact in this app, not theory** (the
  tafsir channel shipped a real bug where large `cache.put`s silently failed under
  quota/eviction, and its once-per-session integrity re-check exists because files go
  missing: `src/app.js:823–836,954`, memory `project_offline_tafsir`). Therefore:
  **App builds: Capacitor Filesystem** (`Directory.Data` — OS-durable app storage,
  outside WebKit's evictable storage classes): `Filesystem.downloadFile` with progress →
  main thread loads bytes → zero-copy transfer to the worker (avoids
  custom-scheme fetches inside a Worker entirely; plugin added to wrappers at GATE 6).
  **Website: Cache API `tasmee-v1`** + `navigator.storage.persist()` + verified-put +
  missing-files guard (§0.5) + `storage.estimate()` preflight + cellular warning.
  **Every session start re-verifies integrity (byte length vs manifest); a missing model
  → explicit Arabic re-download prompt. A silent 131 MB re-download is forbidden.**
- Memory budget: weights + ORT arena + activations ≈ 400–600 MB peak → measured on the
  oldest target iPhone at GATE 7 (jetsam risk is a top-3 risk, §7). Session teardown fully
  releases the worker.

---

## §4 UX spec (all user-facing text Arabic)

- **Entry**: mic button `وضع التسميع` in the Mushaf toolbar cluster (btn-wrap pattern,
  `src/mushaf.js:1141ff`), joining the fullscreen floating cluster like the lantern.
  First tap: coachmark (existing coach pattern + `sheet-scroll-lock` registration), then
  model-download sheet: «تنزيل حزمة التعرّف على التلاوة (١٤٥ م.ب) — مرة واحدة ويعمل دون
  إنترنت بعدها» with progress %, wifi note, and errors via the `mushafAudioMsg` toast
  pattern. Then OS mic permission (denial → «يحتاج وضع التسميع إذن الميكروفون» + settings
  hint).
- **Session start**: reciter audio stops; page words fade to hidden over ~450 ms (calm,
  per the calm-animations rule); ayah-end markers stay visible as position anchors;
  bismillah/surah headers stay visible; gharib glow + tooltips suppressed
  (`body.tasmee-on`); long-press menu and tap-to-play suppressed; page swipe pauses and
  ends the session with a summary (session is page-scoped).
- **Mic states**: idle → downloading (progress ring) → listening (slow ~2 s breathing
  pulse) → paused. Tap toggles pause/resume; long-press (or ✕ in the strip) ends with
  summary.
- **Reveals** (CSS in `public/mushaf.css`, opacity-only, 300–400 ms, no movement):
  correct = ink fade-in; substitution = red ink + persists (session summary lists
  «قلت: X»); omission = amber ink when jumped past; hint = gold ink; insertion = small
  absolutely-positioned dot (::after) on the following word — no layout impact, details in
  summary. Hide rule:
  `.mushaf-page--tasmee .mushaf-word:not(.mushaf-end):not(.ts-r){color:transparent}`.
- **Hints**: hesitation ≥ H s → hint button pulses; tapping it — or tapping anywhere on the
  hidden text — reveals the next word as hinted. Auto-hint toggle (default off).
- **Completion & page boundaries (decided 2026-07-10): auto-advance.** Memorizers cross
  page boundaries mid-breath — near page end the engine's lookahead is extended with the
  next page's opening words (`extendReference`, §2.1); when recitation flows past the
  boundary, the page turns (incoming page pre-built with the tasmee hide class — no
  flash) and reveals continue. Ayah completed → `hapticLight()`; the **summary sheet
  shows only when the user taps stop** (RTL, IBM Plex Arabic): accuracy %, per-ayah
  mistake list, «إعادة التسميع» / «متابعة». Escape hatch: if Gate 4 shows the seam is
  materially expensive, v1 ships stop-with-summary at page end and auto-advance becomes
  v1.1 — decide at GATE 4 with evidence. Settings (gear in sheet): مهلة التلميح (2–8 ث)،
  التلميح التلقائي.
- **RTL**: reveals follow reading order natively (DOM order = recitation order); summary
  numerals via `toLocaleString("ar-EG")` (existing convention, `src/mushaf.js:1697`).
- **Hide levels (A1)**: v1 = full-hide (`color: transparent`). The easier difficulty tier
  is **blur-peek** (`filter: blur(~0.35em)` on the glyph — em-scaled so zoom needs no
  re-measure), planned v1.x. **First-letter-visible and tashkeel-only are permanently
  dropped** — a QCF4 glyph is one whole word; partial glyph reveal is impossible with
  this font. The hint action always reveals the whole word.
- **Hidden-word side-channels (A2)**: hidden words are real DOM text behind
  `color: transparent`, so Gate 4 explicitly verifies nothing paints or exposes the
  glyph: `text-shadow: none` + gharib glow pseudos dead + `-webkit-text-stroke`
  transparent (it tracks `currentColor`, §0.1) + `::selection` styled invisible; and
  selection/long-press are disabled on hidden words for the whole session
  (`user-select:none` + the existing `selectstart` preventDefault at
  `src/mushaf.js:2160`, plus the ayah-menu suppression) so a selection highlight can
  never flash the answer.
- Explicitly **not** in v1: blur-peek tier (v1.x), tajweed feedback, word audio hints,
  history drill screen, cloud sync.

---

## §5 Build plan — numbered gates (Hakam pattern: each gate = testable acceptance)

**GATE 0 — Plan approved.** §1 decision confirmed; §9 answers received.

**GATE 1 — Word dataset.** Deliverables: `src/tasmee-norm.js` (the ONE shared normalizer,
imported by build, audit, and later the engine — the audit-gharib precedent of node
scripts importing src modules), `scripts/build-tasmee-words.mjs`,
`scripts/audit-tasmee-words.mjs`, `public/tasmee-words.json` (per-vk arrays aligned to
QCF4 1-based `position`; sajda `#` positions = null).
Accept: audit prints 6,236/6,236 ayahs aligned (exception table ≤ ~40 entries, committed
with comments); word totals reconcile (77,448 incl. the 15 sajda placeholders → 77,433
recited); a **similarity cross-check** (normalized Imlaei form vs normalized QCF text per
position) reports zero unexplained pairs below threshold — this catches wrong-pair merges
that count-matching alone cannot; dataset ≤ 400 KB gz; spot-check list passes (الصلاة،
الزكاة، الحياة، الربا، رحمت، امرأت، يأيها، هأنتم، ويكأن، بعدما، الم، كهيعص);
`build-app.js` ships the file.

> **✅ GATE 1 RESULT (2026-07-10): PASSED.** 6,236/6,236 ayahs aligned. Generic rules
> (mark-token drop, basmala strip, يا/ويا vocative fusion, ها+أنتم fusion) left only
> **5 residuals**, all fixed by the committed EXCEPTIONS table (3× بعدما split at
> 2:181/8:6/13:37, يَبْنَؤُمَّ merge at 20:94, وَأَلَّوِ merge at 72:16) — far under the ≤40
> budget. Totals: 77,433 recited forms + 15 sajda nulls. Similarity cross-check: mean
> 0.996, zero unexplained pairs < 0.5 (one hand-reviewed whitelist entry: 20:94 يبنؤم).
> Size: 929 KB raw / **209 KB gz** (≤ 400). All spot checks pass. `build-app.js` prune
> list untouched → the file ships in web + app bundles (plain .json, iOS-safe).
> Artifacts: `src/tasmee-norm.js`, `scripts/build-tasmee-words.mjs`,
> `scripts/audit-tasmee-words.mjs`, `public/tasmee-words.json`.

**GATE 2 — Engine green with zero audio.** `src/tasmee-engine.js` + `node --test
tests/tasmee/*.test.mjs`. Fixture matrix: perfect page · substitution · single/multi
omission (with corroboration guard) · insertion · repetition word/phrase/full-ayah ×3
(**zero flags — the Tarteel complaint case**) · shadow-run merge-back · loop mode ·
hesitation timing · muqatta'at page · basmala recited/skipped · merged + split tokens ·
identical-run page (الرحمن) · `extendReference` mid-session (cross-page auto-advance) ·
synthetic noise at 5/10/15% WER with classification-quality thresholds. Accept: all
green; engine imports nothing from DOM/audio modules. Basmala default: optional-accept
(§9 D4). Fixture additions (2026-07-10): refrain stress (الرحمن ×refrains, المرسلات,
الكافرون, adjacent repeats 94:5–6 / 23:36 / 75:34–35 — each with correct/skip-one/
repeat-one, pointer must never silently jump between instances), behind-pointer merge
after a stumble, insertion stability (استغفر الله with الله expected nearby).

> **✅ GATE 2 RESULT (2026-07-10, incl. both acceptance addenda): PASSED — 47/47
> fixtures green** (`node --test tests/tasmee/`). Artifacts: `src/tasmee-engine.js`
> (pure — imports only tasmee-norm.js), `tests/tasmee/{helpers,core.test,
> refrains.test,recovery.test,echo.test,noise.test}.mjs`,
> `tests/tasmee/golden/TRUTH-SCHEMA.md` (tasmee-truth-v1, finalized pre-recording).
> Spec amendments folded into §2.3: omission corroboration for ALL j (the استغفر الله
> trap) · refrain-safe dual-cursor deferral · **echo-substitution contract** (7 new
> fixtures: same-ayah/prior-ayah/sub-band echoes, last-word stop-commit, both-readings
> corner, exact-at-pointer immunity, dropped-waw وعلي/علي — all refrains still green) ·
> **stall-resync** (the 20-seed sweep caught a real wedge at 15% WER seed 1379: pointer
> 79/127, unrecoverable by design before the fix). Seed sweep (20 seeds × 3 WER levels,
> 2:6–16, 127 words): 5% → mean .980 / min .937 · 10% → mean .957 / min .898 · 15% →
> mean .936 / min .866; **zero derails in all 60 runs**; floors re-pinned on the sweep
> MINs (0.937/0.897/0.866). One classification nuance pinned by test: an inserted token
> echoing just-recited text may classify as repetition instead of insertion — both are
> non-destructive, neither moves the pointer.

**GATE 3 — ASR worker on desktop web.** Dev harness page (dev-only route) feeding golden
WAVs + live mic. The golden set is the 6-clip protocol of §6.5 (planted-error clips ship
with ground-truth scripts, so precision/recall is measured, not vibed).

*Scoring (defined 2026-07-10, before building) — two levels:*
- **DETECTION (binding)**: position-level P/R vs truth. A flag at the right position is
  a detection TP regardless of class (truth "sub" caught as "skip" = detection TP,
  classification miss). Position matching: subs exact (vk,pos); span skips — any flag
  within the span (span counts once); insertions ±1 word around (vk, afterPos);
  hesitations ±1 word, scored only on clips that plant them.
- **CLASSIFICATION (reported + tracked, non-binding at Gate 3)**: confusion matrix over
  detected events (sub/skip/insert/repeat/hesitate); v1 aspiration ≥ 0.70 diagonal.

*Binding thresholds (adjusted 2026-07-10):*
- Planted clips (04/05): detection recall ≥ 0.90, detection precision ≥ 0.80.
- WER ≤ 15% is BINDING on clips 01/03/04/05; on 02 (whisper) and 06 (noise) WER is
  REPORTED-only — binding there instead: full-page pointer traversal + false-flag
  budget.
- False-flag budgets: clips 01/03 ≤ 2 per clip; clips 02/06 (acoustically-hard tier)
  ≤ 4 per clip.
- Planted repetitions in clip 05: ZERO mistake flags (the differentiator, binding).
- Hesitation scoring: planted-only applies to RECALL; spurious hesitation events
  ANYWHERE count as false positives in detection precision (bench scorer states this).
- Stable-token latency p50 ≤ 1.5 s = gate CEILING (< 1 s recorded as the UX
  aspiration; Gate 4 re-measures on devices and the ship gate may tighten latency and
  the clean-clip budget); first-event latency ≤ 2.5 s; desktop RTF ≤ 0.3; model load
  from storage cold ≤ 8 s / warm ≤ 3 s.
- **48 kHz→16 kHz resample path exercised by every harness run (clips stored 48 kHz)**.
- **iPhone Safari smoke test of the same harness page is mandatory** (same WebKit as the
  iOS WebView — de-risks GATE 7 early; §9 D2).

*Bench requirement (gate evidence IS this command — no hand-assembled results):*
`node scripts/tasmee-bench.mjs tests/tasmee/golden/<clip>.wav` runs the FULL pipeline
(WAV → 48→16 k resample → mel → CTC → stability gate → normalizer → engine), emits the
event log, diffs against the `.truth.json`, and prints detection P/R, the classification
matrix, RTF, and first-event latency. (Browser-side harness reuses the same worker code;
the Node bench pins onnxruntime-node vs onnxruntime-web parity by checksumming decoder
output on one clip.)

*Model provenance (required):* reproduce the FastConformer → CTC ONNX → uint8 export
from the NVIDIA checkpoint (`nvidia/stt_ar_fastconformer_hybrid_large_pcd_v1.0`),
pinning the export environment in this plan when run (python, nemo_toolkit, onnx,
onnxruntime, quantizer versions + the export script committed to `scripts/`).
offline-tarteel's export code is reference, not a source of binaries; their artifact is
the fallback if reproduction is blocked. **Record sha256 either way.** *Timebox
(2026-07-10): reproduction on macOS arm64 is capped at half a day; the fallback
artifact is pre-approved — record sha256, note "reproduction deferred", move on. The
pipeline behind the model is what Gate 3 actually tests.*

> **📌 GATE 3 ACCEPTANCE SURFACES (pinned 2026-07-10 — no wobble at
> acceptance time):**
> - **Detection P/R, WER, latency (p50/first-event), clean-clip false-flag
>   budgets: BINDING on node-native golden runs** — window mode now;
>   incremental once it is the reference.
> - **RTF ≤ 0.3 + realtime-feed backlog stability: BINDING on desktop-browser
>   WASM**, evaluated POST-incremental (not on window mode's known-failing
>   RTF).
> - **iPhone numbers are DATA at Gate 3.** They become the operational target
>   at GATE 6 — not before. (The ruled iPhone-class backlog-stability target
>   stands as the Gate 6 bar.)
>
> **🔶 GATE 3 KICKOFF STATUS (2026-07-10; provenance incident RESOLVED same day).**
> **PROVENANCE INCIDENT — final record.** The 88.3 MB "v0.2.0" artifact was adopted,
> then challenged, quarantined, and — after a third-vantage probe confirmed the repo
> rename (`github.com/yazinsai/offline-tarteel` → HTTP/2 301 →
> `github.com/yazinsai/tilawa`; README opens "Formerly called offline-tarteel") —
> reclassified CANDIDATE. Both agents failed, symmetrically, and both failures are
> recorded:
> - **Failure A (Claude)**: sha256 "verification" was CIRCULAR (metadata from the
>   same release as the binary); the MIT claim was made from a search-API field
>   before checking the LICENSE file; the lineage repo
>   (`Cyberistic/offline-quran-validation`) was cited without an existence check.
> - **Failure B (Mohammed, self-retracted)**: asserted a detailed "independent
>   verification" (no rename / one release / no LICENSE) that his fetch record did
>   not support, and ordered actions on it.
> **PLAN RULE (binding, BOTH directions)**: any assertion about external state —
> whether from Claude or from Mohammed's messages — enters this plan only with raw
> output + retrieval date. Claude is explicitly authorized to push back on
> unevidenced claims from Mohammed, exactly as Mohammed does to Claude.
> **Evidence of record (Mohammed's 2026-07-10 API probes rate-limited 403, so these
> stand on Claude's raw fetches of 2026-07-10)**: repo id 1166560642 `full_name:
> yazinsai/tilawa`; LICENSE file present (path `LICENSE`, 1,065 B, MIT, blob
> `6b99152f…`); releases: v0.1.0 published 2026-03-01 (fastconformer_ar_ctc_q8.onnx,
> 131,652,337 B), v0.2.0 published 2026-06-30 (fastconformer_full_mixed.onnx,
> 88,307,366 B). `Cyberistic/offline-quran-validation`: still CANNOT EVIDENCE
> (never fetched) — lineage remains open.
> **ARTIFACT DECISIONS (2026-07-10, post-resolution):**
> **⛔ SUPERSEDED 2026-07-11**: the artifact-of-record is now **q8pc-head** — our own
> re-export from the NVIDIA checkpoint (adoption ruling + execution recorded in the
> Gate 3 status below; fully self-produced chain, every sha recorded). v0.1.0 stays
> on disk as the FALLBACK. The block below is the historical record of the v0.1.0
> decision:
> **v0.1.0 REMAINS artifact-of-record** — strongest verified chain: README-documented
> export recipe from the NVIDIA checkpoint, local hash, published browser benchmarks
> ran on it, our smoke passed on it. `fastconformer_ar_ctc_q8.onnx` (131,652,337 B,
> uint8) from `…/releases/download/v0.1.0/…` — sha256
> `7e7f9aaccbf0f7d12104ebfee9a99625195454a359821139a777f389ec928b50`; vocab from the
> repo at main (`lab/data/vocab.json`, 1025 tokens, `<blank>`=1024) — sha256
> `c55877f3bff8bc3aaefc160e8c2fb88cb349088d092513d40210ccfe535e671b`
> (`models/tasmee/checksums.txt`).
> **v0.2.0 = CANDIDATE** (`models/candidate/` + CANDIDATE-NOTE), evaluated only
> AFTER Gate 3 acceptance on v0.1.0 (no artifact churn mid-gate). Promotion needs:
> (a) full golden-clip A/B with detection R/P ≥ v0.1.0 within seed noise on all six
> clips; (b) export reproduction with logit-parity (Windows box) OR a confirmed
> lineage chain at minimum; (c) licensing recorded (repo MIT per dated fetch above;
> weights CC-BY-4.0). Payoff if promoted: ~30% smaller, faster (smoke p50 0.86 s vs
> 1.20 s).
> **Licensing stance**: model weights **CC-BY-4.0** (NVIDIA) — attribution at GATE 7
> unchanged. **R7: PARTIALLY CLOSED** — repo license evidenced (MIT, dated fetch);
> weights license unchanged; lineage still open. Our worker and bench remain
> independent implementations; we vendor NOTHING.
> **Reproduction**: recipe committed as `scripts/tasmee-export-model.py`; attempt
> BLOCKED at the env gate on this Mac (Python 3.9.6 only; NeMo needs ≥3.10) —
> deferred per the timebox pre-approval; runnable later on the Windows aligner box as
> a parity check (hash-equality confirms; inequality requires logit-parity instead).
> **→ ENV GATE CLEARED 2026-07-11 on this Mac** (re-export lever approved primary,
> which changed the timebox calculus): brew python@3.12 → 3.12.13 venv at
> `models/reexport/nemo-export/` with nemo_toolkit 2.7.3 · torch 2.13.0 · onnx
> 1.22.0 · onnxruntime 1.27.0 — all imports verified. Stage-1 fp32 export runs
> locally (`models/reexport/export_fp32.py`); the Windows box is no longer needed
> for this path.
> **Bench**: `scripts/tasmee-bench.mjs` (onnxruntime-node 1.27.0 devDep) — full
> pipeline: WAV → explicit 48→16 kHz FIR resample (A4) → OUR mel frontend (NeMo
> preprocessor parameters, independent implementation) → CTC greedy → word-identity
> stability → engine → truth scorer with the adjusted binding rules; `--page`/`-pNNN`
> and `--range` modes; per-clip prints include p50+p95 latency, final-word check
> (binding, #6 — end-of-clip silence flush implemented), and spurious-repetition
> count (#7, report-only at Gate 3, budgeted Gate 4).
> **Smoke on the artifact-of-record (surah 114, real qasim recitation — NOT gate
> evidence)**: 19/20 correct + 1 substitution flag on a genuine q8 mis-recognition
> (الخناس→الخس, sim 0.67), completed; WER 10% (that word + 1 phantom repetition);
> RTF 0.233; stable-token p50 1.20 s / p95 3.06 s; first-event 0.90 s; final-word
> check PASS; spurious repetitions 1. Our mel frontend produced a correct transcript
> on FIRST run (validates the independent implementation). The 114 smoke is the
> pinned regression for the final-word check.
> **Adaptive stride (#9, pre-authorized)**: only if every stride change re-runs ALL
> golden clips within thresholds (accuracy measured, not assumed) and the
> stability-gate contract is untouched; desktop WASM RTF > 0.3 → checkpoint to
> Mohammed — never silently relax a threshold.
> **WASM latency (2026-07-10)**: native p50 1.20 s / p95 3.06 s means the browser
> WASM run is the REAL test of the 1.5 s ceiling. When the dev harness lands,
> publish the IDENTICAL bench block from browser WASM, and PROFILE whether p50 is
> model-bound (forward-pass time) or stability-window-bound (chunk cadence +
> two-decode confirmation) BEFORE reaching for adaptive stride.
> **Hesitation wiring COMPLETED (2026-07-10, authorized)**: ticks fire only during
> VAD-silence, timestamped on the ACTIVITY CLOCK (lastCommittedAudioEnd +
> silenceRun) so commit-lag cancels out of the engine's gap arithmetic entirely —
> plain silence-gated ticking still false-fired through a 0.5 s breath gap while
> stalled. Engine untouched. Pinned by 4 wiring fixtures (commit-lag/true-silence/
> boundary-2×/lag+breath-gap) driving a real engine session per the contract;
> 114 smoke now hes 0; suite 54/54. The dev-harness worker ships this policy and
> keeps the per-hesitation print byte-identical (stall telemetry for profiling).
> **Shared pipeline (2026-07-10)**: DSP extracted to `src/tasmee-pipeline.js`
> (WAV/resample/mel/greedy, browser-safe) — bench, parity script, and the harness
> worker run the same bytes; bench re-run confirmed zero drift.
> **WASM parity (2026-07-10, `scripts/tasmee-parity.mjs` on the 114 smoke)**:
> **PASS (word-level)** — node and WASM transcripts byte-identical (and flawless:
> full-context decode has NO الخس error → that smoke error is windowing-induced,
> not model error); frame-level argmax jitter 3/281 at blank boundaries (expected
> cross-backend float noise). WASM (numThreads 1) single-pass: load 604 ms,
> forward RTF **0.066** vs node 0.009.
> **⛔ CHECKPOINT (2026-07-10) — RULED**: projection said streaming WASM RTF ≈ 1.6
> (vs node-native 0.25). Ruling: **(1) measure first** — harness bench blocks from a
> real desktop browser AND iPhone Safari (RTF folded into the Safari smoke);
> projection ≠ verdict. **(2) If real-browser streaming RTF > 0.3, INCREMENTAL
> DECODE REDESIGN IS AUTHORIZED** under: dual-mode from day one
> (`--decode=window|incremental`, full-window stays the reference until incremental
> matches/beats it); every golden clip runs BOTH modes in transition with
> incremental ≥ window on detection metrics; **الخناس is the pinned regression**
> (windowing-induced — the redesign must eliminate the class and prove it); seam
> fixtures (word spanning a chunk boundary; madd crossing the seam; stitch rule +
> overlap length are pinned parameters with tests); engine and stability-gate
> contracts unchanged. **(3) WebGPU**: harness records availability (desktop + iOS)
> as DATA ONLY — cannot be baseline (iOS floor predates WKWebView WebGPU);
> progressive-enhancement candidate post-ship. **(4) Threads/SharedArrayBuffer:
> feasibility note only, NO build** — attacks the ~7× WASM penalty (complementary
> to incremental's ~25× re-decode factor) but needs COOP/COEP cross-origin
> isolation; before it is ever a candidate, assess what isolation breaks for
> GCS-hosted model/audio fetches on m7mdiyat.com AND the capacitor:// scheme
> (GCS sends CORS but not CORP headers; `COEP: credentialless` needs newer WebKit
> than our floor; Capacitor local servers don't set COOP/COEP without native
> changes). **(5) Platform-gated thresholds: REJECTED as primary** — last resort
> with explicit sign-off only. **Sequencing**: recordings are decode-mode-
> independent — golden clips + truth scripts bench through window mode the moment
> they land; nothing waits.
> **MEASURED (2026-07-10, real Chrome 149/macOS via the dev harness — identical
> shared-module pipeline, WASM numThreads 1)**: streaming **RTF 1.491** (wall
> 33.5 s / 22.5 s audio; session load 957 ms) vs node-native 0.24 — the ≈1.6
> projection confirmed; **ruling #2 condition met → INCREMENTAL DECODE REDESIGN
> AUTHORIZED** (next work item, under the ruled conditions). Profiling answer:
> p50 0.96 s in-browser despite ~6× slower compute → **p50 is stability-window-
> bound (chunk cadence + two-decode confirmation); RTF is model-bound** — the
> redesign attacks RTF; latency work is stride/stability tuning, separately.
> Cross-backend note: streaming commits differ marginally from native (frame
> jitter × windowing → 2 extra phantom dups absorbed as repetitions; engine still
> 19/20, zero false mistakes, final-word PASS) — another class the incremental
> redesign should shrink. Harness: `node scripts/tasmee-harness-server.mjs` →
> `?clip=/golden/smoke114-p604.wav&range=114:1-6&autorun=1` (file mode; live mic
> is Gate 4). iPhone Safari smoke: same URL on the LAN address the server prints.
> **RULINGS ON THE MEASUREMENT TURN (2026-07-10)**: (1) SCOPE FENCE — p50-is-
> stability-bound / RTF-is-model-bound ratified; latency tuning (stride,
> confirmation cadence) is a SEPARATE work item AFTER incremental lands; the
> redesign's job is RTF + the two windowing artifact classes (الخناس, phantom
> dups). (2) TEST MATRIX — full window-vs-incremental golden matrix runs
> node-native; browser WASM confirms the smoke + ONE representative golden clip
> per mode; routine all-six browser runs resume once RTF ≤ 0.3 makes them cheap.
> (3) FEED MODE (landed same day) — `--feed=realtime|fast` in bench + harness
> (`?feed=`), backlog line in the shared block (`live-feed backlog max/end`);
> as-fast-as-compute feeding masks live queue growth whenever RTF > 1 (desktop
> 1.49 ⇒ ~40 s behind by page end), so fast-mode p50 is NOT live-representative
> at RTF > 1. Node-native reference: max backlog 0.2 s / end 0.0 s under
> realtime pacing. **Post-redesign acceptance includes one realtime-paced run
> with no sustained backlog growth.** (4) Browser WER 15% vs native 10%
> understood (same substitution + phantom dups as insertions); golden clips
> remain the binding WER surface.
>
> **📱 iPHONE SAFARI SMOKE — EVIDENCE OF RECORD (2026-07-10, iPhone 15 Pro /
> A17 Pro, iOS 18_7, WebKit 605.1.15 Version/27.0; transcribed VERBATIM from
> Mohammed's screenshots):**
> ```
> == tasmee-bench: smoke114-p604.wav ==
> model: fastconformer_ar_ctc_q8.onnx (sha256 7e7f9aaccbf0… | input: mel (ours))
> clip: 22.5s @ 48000 Hz → 16 kHz | speech onset 0.00s | ref 20 words (114:1 → 114:6)
> transcript (22 words): قُلْ أَعُوذُ بِرَبِّ النَّاسِ مَلِكِ النَّاسِ إِلَهِ النَّاس مِنْ شَرِّ
>   الْوَسْوَاسِ الخس الذي يوسوس في في صدور الناس الناس من الجنة والناس
> engine: correct 19/20 · sub 1 · skip 0 · ins 0 · rep 2 · hes 0 · completed true
>   WER                 15.0%
>   RTF (compute/audio) 72.223
>   stable-token latency p50 0.96s · p95 2.24s (ceiling 1.5s p50; aspiration <1s)
>   first-event latency 0.90s (limit 2.5s)
>   final-word check    PASS (114:6:3 revealed as correct)
>   spurious repetitions 2 on this clip — none planted (report-only)
> [wasm] session load 29106ms · streaming wall 1623.7s for 22.5s audio (wall-RTF 72.23)
> ```
> Latency figures NOT live-representative at RTF > 1 (ruling #3); RTF and
> session-load are the data.
> **Derivations**: phone single-pass RTF ≈ 72.223 ÷ 22.6 (the measured desktop
> re-decode factor — identical controller, identical decode calls) ≈ **3.2**
> (estimate; assumes stable throttling across the 27-min run). Phone-vs-desktop
> WASM multiple: 72.223 / 1.491 ≈ **48×**; session load 29.1 s / 0.96 s ≈ 30×.
> Expected A17-Pro-vs-desktop silicon gap is ~2–3× ⇒ **48× is a categorical
> anomaly, not silicon** — ⛔ **RETRACTED 2026-07-11: the "anomaly" does not
> exist.** Measured iPhone single-pass RTF is **2.682** (micro-bench, N=5) —
> inside the silicon-expected band; the 48× decomposes as ≈24× WebKit-vs-V8
> engine gap (measured on identical Mac hardware) × ≈2× silicon. See the
> REAL-BROWSER MEASUREMENTS block below; the text following this line is the
> pre-measurement reasoning, kept for the record. **Suspect order (re-ruled 2026-07-10, cold-start argument): session
> load was 29.1 s (≈30× desktop) at t=0 — before any thermal buildup could
> exist. Thermal throttling is therefore DEMOTED to a streaming-degradation
> contributor; the primary suspects are build-path selection and memory
> pressure, both present from second zero.** Remaining list: Safari WASM
> build-path selection in ort-web, memory pressure (131 MB weights + heap vs
> Safari tab limits), thermal (streaming-phase contributor only), low-power
> state unknown. Investigate BEFORE drawing floor conclusions. →
> **First findings recorded in the ANOMALY INVESTIGATION block below.**
> **OPERATIONAL TARGET (ruled)**: incremental decode must hold **backlog-stable
> under `--feed=realtime` on iPhone-class WASM** — not just desktop RTF ≤ 0.3.
> Honest arithmetic: at the anomalous phone single-pass (~3.2), even incremental
> (≈2.3 s decoded per 0.3 s chunk) is RTF ≈ 24 — the anomaly must fall for the
> target to be reachable; with silicon-expected single-pass (~0.13–0.2),
> incremental lands ≈ 1.0–1.5 and needs overlap tuning and/or model work
> (candidate A/B, WebGPU-as-data) to close the rest.
> **FLOOR IMPLICATION (PROJECTION, labeled — Gates 6/7 input, NO decision now)**:
> iPhone 15 Pro is near top-tier; older A-series (A13–A15, ~2–3× slower CPU)
> project to single-pass ~6–10 under the current WASM path — order(s) of
> magnitude from real-time unless the anomaly resolves AND acceleration or a
> smaller model lands.
> **AUTORUN FINDING (evidence + Gate 6 design input)**: `autorun=1` did NOT start
> the run on iOS Safari (fields populated; processing began only on a real tap).
> Root cause is NOT a gesture-gated API in the pipeline — by construction it uses
> none (no AudioContext/decodeAudioData/getUserMedia; WAV parsed manually;
> fetch/Worker/WASM are gesture-free). Suspected mechanism: iOS Safari
> deferring/suspending a heavy module-worker spawned at script-evaluation time
> during page load; could not be pinned without device debugging. Design
> implication benign and PINNED: the real app's session start is the mic-button
> tap, and getUserMedia is gesture-gated on iOS regardless. Harness fixed: on
> iOS, autorun renders an armed "tap to start" state instead of silently not
> running.
>
> **Parity contract RATIFIED (2026-07-10)**: word-level, not checksum (cross-
> backend float non-determinism makes bit-exactness the wrong contract; word
> sequence is what the engine consumes). Pinned regression bound asserted by
> `tasmee-parity.mjs` on every run: frame-level token mismatch ≤ 2% AND zero
> word-level diffs; re-run on any ORT version bump. Current: 1.07% jitter, words
> identical → PASS.
> **Hesitation false-fire finding (smoke, 2026-07-10 — Gate 5 settings-review
> input, NO engine change)**: the smoke's `hes 1` fired at 114:4:4 (t=14.7 s) where
> the actual audio gap يوسوس→في was only **0.5 s** — the reciter never paused. Root
> cause: `lastActivityTs` advances only on COMMITTED tokens, so a stability stall
> (p95 ~3 s in that region) lets the engine clock run past the 4 s mid-ayah grace
> while speech continues — commit-lag masquerading as silence, NOT madd/breath
> pacing. Gate 5 review options: (a) worker wiring — call `tick()` only during
> VAD-silence, making hesitation measure true user silence, immune to commit lag,
> zero engine change (preferred); (b) raise the mid-ayah default. Slow
> tarteel-style memorizers would hit the current wiring constantly; the per-clip
> hesitation print (position + audio gap) keeps this observable on every bench run.
> **Remaining for acceptance**: six clips + truth scripts → per-clip bench runs,
> onnxruntime-web parity checksum, dev harness page, iPhone Safari smoke.
>
> ---
>
> **📼 GOLDEN CLIPS LANDED (2026-07-10).** Six clips recorded by Mohammed on
> **page 453 (38:1–16, 138 ref words)** — note: supersedes the §6.5 plan of
> clip 01 on page 2; all six share page 453. Converted from Voice Memos m4a via
> `ffmpeg -ac 1 -ar 48000 -sample_fmt s16` → `tests/tasmee/golden/*-p453.wav`
> (01-clean · 02-whisper · 03-fast · 04-subs · 05-skips-repeats · 06-noise).
> Truth scripts for 04/05 written per tasmee-truth-v1; **every `pos` was
> verified against `public/tasmee-words.json` before commit** — the draft
> script's positions were off by one at 5 events (04: عجاب 38:5:7→**8**,
> اختلاق 38:7:9→**10**, الأسباب 38:10:9→**10**; 05: ولات 38:3:7→**8**, بل
> 38:8:5→**6**; repeat span 38:5:4-7→**5-8**); corrections recorded in the
> events' `note` fields.
>
> **WINDOW-MODE BASELINE (node-native, the binding surface — 2026-07-10):**
> ```
> clip        WER    RTF    p50/p95      FE    final  flags(sub+skip)  det P/R      reps
> 01-clean    9.4%  0.284  0.80/1.94   2.40s  PASS   3                —            4
> 02-whisper  5.1%  0.198  0.98/3.14   3.30s  PASS   2 (+1 hes)       —            2
> 03-fast     9.4%  0.303  1.04/2.74   1.00s  PASS   2                —            4
> 04-subs    10.9%  0.304  0.82/1.82   1.30s  PASS   5                0.38/0.60    5
> 05-skips   17.4%  0.312  0.80/1.82   1.10s  PASS   8                0.25/0.75    13
> 06-noise   10.9%  0.289  0.92/2.34   3.20s  FAIL   2                —            9
> ```
> Honest reading: **window mode FAILS the Gate 3 detection bindings** (04/05
> P/R far under 0.80/0.90; 05 WER > 15%; 06 traversal fails; 01 over the ≤2
> false-flag budget). Repetition acceptance PASSES on 05 (zero mistake flags in
> planted repeats — the differentiator holds even at baseline). Two recall
> misses on 04 are the ASR ABSORBING planted substitutions (38:5:8 عجاب and
> 38:15:3 هؤلاء appear as the *reference* word in the transcript — the model's
> implicit prior "corrects" the reciter). That is an acoustic/model class, NOT
> windowing; it caps detection recall at 0.60 on 04 for both decode modes and
> is a candidate-model A/B question, not a controller question.
>
> **🔎 ANOMALY INVESTIGATION — first findings (2026-07-10, desktop-side only):**
> - **No served-artifact evidence exists from the 27-min phone run** — the
>   harness server logged nothing per-request. FIXED: it now logs every request
>   (`[req] time addr uaTag method url`), so the next phone session produces
>   the evidence class this investigation was missing.
> - **Non-SIMD-fallback hypothesis REFUTED by construction** — raw evidence
>   per the binding evidence rule (local fetches/reads of 2026-07-11, this
>   repo's installed package):
>   ```
>   $ python3 …package-lock.json…  → node_modules/onnxruntime-web → 1.27.0
>       resolved: https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-1.27.0.tgz
>   $ ls node_modules/onnxruntime-web/dist/*.wasm
>       ort-wasm-simd-threaded.asyncify.wasm   24,254,953 B
>       ort-wasm-simd-threaded.jsep.wasm       26,827,543 B
>       ort-wasm-simd-threaded.jspi.wasm       15,046,878 B
>       ort-wasm-simd-threaded.wasm            13,479,978 B
>       (no other .wasm — no plain ort-wasm.wasm, no non-SIMD build exists)
>   $ grep -o 'ort-wasm[a-zA-Z.-]*\.\(wasm\|mjs\)' <bundle> | sort | uniq -c
>       ort.all.min.mjs  → 1× ort-wasm-simd-threaded.jsep.mjs   (only ref)
>       ort.wasm.min.mjs → 1× ort-wasm-simd-threaded.mjs        (only ref)
>       ort.min.mjs      → 1× ort-wasm-simd-threaded.jsep.mjs   (only ref)
>   loader source (ort.all.min.mjs, hardcoded filename, no capability branch):
>       … let i="ort-wasm-simd-threaded.jsep.mjs",a=r??D1(i,e) …
>   loader chain: ort-wasm-simd-threaded.jsep.mjs contains
>       "ort-wasm-simd-threaded.jsep.wasm"; ort-wasm-simd-threaded.mjs
>       contains "ort-wasm-simd-threaded.wasm".
>   ```
>   Therefore file selection is deterministic per bundle: the worker imported
>   `ort.all.min.mjs`, so phone and desktop both pulled
>   `ort-wasm-simd-threaded.jsep.wasm`. SIMD is compiled in unconditionally;
>   a silent non-SIMD fallback is impossible with this dist (an incapable
>   engine would throw at instantiation, not degrade).
> - **Build-path finding — SUSPECTED primary cause, HYPOTHESIS pending the
>   phone `?ort=wasm` vs `?ort=all` micro-bench A/B; do NOT treat as "the
>   cause" until that test returns.** The harness was loading the JSEP
>   (WebGPU-enabled) build — 26.8 MB of wasm to parse/compile — while using
>   only the wasm EP; the wasm-only bundle (`ort.wasm.min.mjs` →
>   `ort-wasm-simd-threaded.wasm`, 13.5 MB) is the ship path. Safari compiles
>   wasm differently than Chrome (BBQ/OMG tiering); a 27 MB module is a
>   plausible contributor to the 29.1 s cold session load and possibly to the
>   run-time gap — plausible ≠ confirmed. Harness now takes `?ort=wasm|all`
>   (default `wasm`); the phone evidence-of-record ran on the `all`/jsep
>   build — the micro-bench A/B settles the difference measurably.
> - **Instrumentation SHIPPED (evidence lines, not vibes)**: every bench/harness
>   block header now prints `env:` lines — backend + bundle, the EXACT fetched
>   .wasm (worker-scope resource timing; falls back to "expected" honestly),
>   ort.env.wasm flags (numThreads/simd/proxy), WebGPU availability
>   (DATA-ONLY per ruling #3), deviceMemory/jsHeap (n/a where unexposed —
>   Safari), UA, and the decode mode + its pinned parameters. Renderer is
>   shared (`buildEnvLines`, src/tasmee-report.js) so bench and harness stay
>   byte-identical.
> - **Micro-bench mode SHIPPED (`?mode=micro`)**: N=5 fixed-window (6 s)
>   single-pass decodes + cold session load, hard cap 3 min wall, per-pass
>   progress line, PARTIAL block on cap; prints median/min/max single-pass RTF
>   — replaces the ÷22.6 phone estimate with a measurement. Operator protocol
>   printed on the page: cool phone · Low Power Mode OFF · screen on.
>   **PHONE RE-TEST PROTOCOL (Mohammed-cheap)**: two micro runs,
>   `?mode=micro&ort=wasm` vs `?mode=micro&ort=all`, ≤3 min each. NO full
>   streaming runs on the phone until incremental is validated in a desktop
>   browser. *(2026-07-11 update: the `ort=wasm` run happened — single-pass
>   RTF 2.682, load 17.8 s; the `ort=all` A/B is CLOSED as moot per the
>   REAL-BROWSER MEASUREMENTS block; the remaining owed run is
>   `?mode=micro&decode=incremental`.)*
> - **DESIGN RULE PINNED (Gates 4/6, from the autorun finding)**: on iOS,
>   worker spawn AND ORT session init happen ON or AFTER the mic-tap gesture
>   path — never at page/app load. The harness worker now practices this:
>   ORT is dynamic-imported inside the run handler, not at module evaluation.
>
> **⚡ INCREMENTAL DECODE LANDED (2026-07-10, dual-mode per ruling #2 —
> `--decode=window|incremental` in bench, `?decode=` in harness; WINDOW REMAINS
> THE REFERENCE).** Design (src/tasmee-stream.js, mode="incremental"): each
> 0.3 s step decodes a SHORT sliding segment instead of the growing pinned
> window. Segment start = VAD-silence snap searched backward from
> frontier − incContextS (snap AND depth COMPOSE — a snap into the micro-gap
> right before the frontier word starves the decode and long-madd words flap
> between fused/split readings); fallback = frontier − incContextS quantized to
> the chunk grid; frontier = min(committedEnd, first pending start) so the
> window can NEVER open mid-word inside uncommitted speech — the الخناس class
> is eliminated by construction (a stalled pending word extends the segment
> backward). PINNED parameters (seam fixtures assert them):
> `incContextS 1.5 · incEdgeGuardS 0.2 · incDupWinS 0.45 · incMaxContextS 4`.
> Stitch rules: left-edge guard discards words starting inside the guard band
> of a non-zero segment start; the wide dup window applies permanently (every
> step is a mini-jump); TAIL GUARD — the frontier word commits only with a
> successor that itself cleared holdback, or VAD-silence in the bounded ~0.3 s
> after its end (mere successor visibility self-corroborates junk fragment
> pairs: يَو+الحساب, وال+الناسية), and the guard is OFF while anchor = 0 (the
> opening is full-context, byte-equivalent to window mode — guarding it only
> taxed ص through its madd, first-event 4.2 s → 2.4 s). Stability gate
> (2-consecutive word-identity + holdback) and the ENGINE are UNTOUCHED —
> window path re-verified byte-identical on the pinned 114 smoke.
> Tests: 6 seam fixtures (`tests/tasmee/incremental.test.mjs`) — pinned overlap,
> boundary-spanning word, stalled-pending backward extension, edge-guard
> artifact rejection, madd backdate-on-settle (extension never advances the
> pointer), sliding-phase tail guard + anchor-0 exemption. **Suite 60/60.**
>
> **الخناس PINNED REGRESSION: ELIMINATED.** Smoke-114 incremental:
> **20/20 correct · sub 0 · skip 0 · ins 0 · rep 0 · hes 0** · WER 5.0% ·
> RTF 0.145 · final-word PASS-as-correct (window native: 19/20, sub 1 الخس,
> rep 1, WER 10%). BOTH windowing artifact classes gone on the smoke —
> the truncation sub AND the phantom dups.
>
> **FULL MATRIX — window vs incremental (node-native, same clips):**
> ```
> clip        mode  WER    RTF    p50/p95     FE    final  flags  det P/R     reps
> 01-clean    win   9.4%  0.284  0.80/1.94  2.40s  PASS   3      —           4
> 01-clean    inc   5.8%  0.137  1.18/2.82  2.40s  PASS   6      —           2
> 02-whisper  win   5.1%  0.198  0.98/3.14  3.30s  PASS   2      —           2
> 02-whisper  inc   8.7%  0.109  1.24/3.26  3.30s  PASS   8      —           2
> 03-fast     win   9.4%  0.303  1.04/2.74  1.00s  PASS   2      —           4
> 03-fast     inc   4.3%  0.145  1.14/2.04  1.00s  PASS   1      —           0
> 04-subs     win  10.9%  0.304  0.82/1.82  1.30s  PASS   5      0.38/0.60   5
> 04-subs     inc   5.1%  0.147  1.12/1.96  1.30s  PASS   3      0.50/0.60   0
> 05-skips    win  17.4%  0.312  0.80/1.82  1.10s  PASS   8      0.25/0.75   13
> 05-skips    inc  13.8%  0.148  1.20/3.20  1.10s  PASS   6      0.30/0.75   8
> 06-noise    win  10.9%  0.289  0.92/2.34  3.20s  FAIL   2      —           9
> 06-noise    inc   8.7%  0.137  1.14/2.62  3.20s  FAIL   1      —           0
> smoke114    win  10.0%  0.223  1.20/3.06  0.90s  PASS   1      —           1
> smoke114    inc   5.0%  0.145  1.40/4.94  0.90s  PASS   0      —           0
> ```
> **Backend note: every number in this matrix — WER, RTF, latency, backlog —
> is NODE-NATIVE (onnxruntime-node 1.27.0 on the M-series Mac). No browser
> WASM measurement exists yet for incremental mode; that is Mohammed's
> harness run.** Repetition acceptance PASSES on 05 in both modes (0 flags
> inside planted repeats). Realtime acceptance ruling satisfied node-native:
> 01 incremental under `--feed=realtime` → backlog max 0.1 s / end 0.0 s
> (node-native), engine results identical to fast feed.
>
> **TRANSITION ASSESSMENT (vs the ruled bar "incremental ≥ window on detection
> metrics"):** MET on the truth clips — 04 P 0.50 vs 0.38 (R equal), 05 P 0.30
> vs 0.25 (R equal) — and incremental also wins WER on every WER-binding clip,
> phantom dups (0–8 vs 4–13), RTF (0.109–0.148 vs 0.198–0.312, ≈2.2× —
> node-native), p50 ceiling met everywhere (≤1.24 s, node-native). **KNOWN REGRESSION, named**: false-flag
> budgets on the acoustically-hard tier — 02-whisper 8 flags vs window's 2
> (budget ≤4: window passed, incremental FAILS) and 01-clean 6 vs 3 (budget
> ≤2: both fail, incremental worse). Whisper-voice words drop at seams under
> short context. NEXT TUNING ITEM (bounded: incContextS/guard interplay on
> quiet voices); window stays reference until 01/02 budgets recover to
> ≥window.
>
> **🔬 QUIET-VOICE SEAM-DROP DIAGNOSIS (2026-07-11, BEFORE any parameter
> change — per the diagnose-first ruling; tool: `scripts/tasmee-flags.mjs`,
> per-flag commit-timeline + per-chunk anchor/pending traces).** All 14
> incremental-specific failures on 01/02 classified:
> - **(A) ANCHOR PLACEMENT + ANCHOR MOTION — 9/14, the dominant class**
>   (قبلهم 3:4-5, وقالوا 16:1 on 01; حين 3:9, ذكري 8:11, والأرض 10:5,
>   مهزوم 11:4, ينظر 15:2, واحدة 15:6 on 02). Two composing mechanisms:
>   (1) on whisper audio the VAD threshold sits at the noise floor, so the
>   silence-snap fails and the GRID FALLBACK cuts mid-speech; (2) the
>   fallback anchor MOVES WITH EVERY COMMIT, so the two stability sightings
>   decode with DIFFERENT left contexts — a marginal word flaps between
>   readings (قبلهم/قبللِه) or vanishes outright and never agrees twice.
>   Conclusive trace (01, وقالوا): correct reading visible in the anchor-97.5
>   decode; anchor advances to 99.0 after an unrelated commit; the word is
>   gone from every subsequent decode → skip. Window mode's 15 s pinned
>   anchor never has this — consecutive decodes differ only by the right
>   edge.
> - **(B) TAIL-GUARD PAUSE-RELEASE FALSE-FIRE — 3/14** (جن 11:1 on 01; أول
>   13:6, له 10:2 on 02): the bounded pause check `[end+0.1, end+0.4]` can be
>   as short as 2 VAD slots at first commit candidacy, and whisper dips read
>   as silence → a prefix fragment releases and commits before its parent
>   word settles.
> - **(C) DUP NORM MISS — shared with window, NOT incremental-specific**
>   (إلا/إِلاَّا on 01, flagged 38:7:10 in BOTH modes): the elongated surface
>   form normalizes differently, so commit-dedup misses it (window's start
>   jitter 0.1 s > frameS also misses). One of window's own 3 over-budget
>   flags on 01.
> - **RULED OUT by the traces**: dup-window width (all planted repeats land;
>   repetition acceptance PASS both modes), edge guard (zero implicated
>   cases), engine confidence thresholds (every flag originates upstream in
>   the pipeline — the engine classified correctly given what it was fed).
> **Fix direction (follows from A/B, not yet applied at this line — results
> below when measured): (1) ANCHOR HYSTERESIS — re-pin the anchor only when
> frontier − anchor > incMaxContextS instead of recomputing per step; a mini
> pinned window (window mode's proven design at ~1/4 scale), making the two
> stability sightings share identical left context. (2) Pause-release
> requires the FULL 0.6 s lookahead window to be observable and silent
> (whisper dips are 0.1–0.3 s; real waqf pauses are ≥0.5 s) — costs ~+0.3 s
> latency at waqf boundaries only.**
>
> **⚙️ TUNING OUTCOME (2026-07-11, all numbers node-native):**
> - **Applied and KEPT (config of record)**: anchor hysteresis (re-pin only
>   at frontier − anchor > incMaxContextS); tail guard with settled-successor
>   OR bounded-pause release, exempt at anchor 0; dup-dedup trailing-run
>   collapse (إِلاَّا → الا, incremental comparison only — kills the class-C
>   flag). The strict full-0.6 s pause variant was measured and REVERTED:
>   it bought nothing hysteresis hadn't fixed, at +0.1 s p50. An
>   incContextS 2.5 probe was measured and REJECTED (02 WER 5.8→10.1,
>   03 unchanged — deeper fixed context shifts seams, doesn't fix whisper).
> - **MEASURED TRADE (both directions recorded, one variable at a time)**:
>   hysteresis recovered the quiet clips (01: 6→2 flags ✓ BUDGET MET, beats
>   window's 3; 02: 8→5) but cost truth-clip precision vs the per-step-anchor
>   config (04: P 0.50→0.33, FP 3→6; a per-step anchor self-heals a bad cut
>   next step, a pinned bad anchor poisons ~2.5 s of sightings — window mode
>   tolerates pinned anchors only because 15 s of context drowns a bad cut).
>   No controller config dominates; the committed config is the only one that
>   meets any budget window itself misses.
> - **🚨 UPSTREAM ROOT CAUSE FOUND — THE VAD (mode-independent, measured):**
>   `thresh = max(0.006, p10×4)` assumes speech ≥4× the quietest decile.
>   Golden 02 (whisper) has p90/p10 = 3.9× (vs 21× on 01) → threshold
>   0.0086 sits ABOVE median speech RMS 0.0036 → **90% of real whisper
>   speech reads as silence** (false pause-release → fragment commits,
>   skipped decodes, false hesitation ticks — 02-window's baseline `hes 1`
>   explained). Golden 06 (loud noise floor): threshold 0.1005 → 55% reads
>   silent → the closing words drop below it → **06's final-word FAIL in
>   BOTH modes is a VAD artifact, not the recording** (verified: with a
>   strict threshold 06 completes and final-word PASSES in both modes —
>   Mohammed's clip-06 audio check is answered).
> - **VAD policy attempts (each fully measured, then reverted):** uniform
>   strict cap (min(p10×4, 0.75·p50)) → 02-inc 3 flags ✓ (≤4 MET) + 06
>   traversal fixed BOTH modes, but **breaks the pinned 114-smoke window
>   baseline (19/20 → 17/20)** — the smoke has almost no true silence and
>   window anchoring relies on quiet-speech dips being "snappable".
>   Generous-snap/strict-speech split → smoke window restored exactly, but
>   02-inc regresses to 8 (its "dips" are speech; snaps cut into words).
>   **One scalar per consumer cannot serve both clip classes.**
> - **DECISION: reverted to the HISTORICAL single-threshold VAD** —
>   the binding window baseline is the reference and its measurement
>   substrate does not move without a ruling. Kept: the consolidation
>   (`buildVad` in src/tasmee-pipeline.js — was triplicated in bench /
>   harness worker / flags with drift risk; deficiency documented at the
>   definition). **CHECKPOINT → Mohammed: VAD REDESIGN as a named work item**
>   (candidate: nearest-local-minimum dip snapping — relative, threshold-free
>   — for anchor snaps + strict capped threshold for isSpeech consumers).
>   It demonstrably unlocks 02 ≤ 4 and fixes 06 traversal in both modes, but
>   it MOVES the binding window-baseline numbers (02-window 2→~4–6 flags,
>   06-window FAIL→PASS) — adopting it means re-baselining window mode, and
>   that is an acceptance-surface ruling, not a tuning call.
> - **CONFIG-OF-RECORD MATRIX (2026-07-11, node-native, historical VAD;
>   window baseline unchanged — reproduced exactly). ⚠ SUPERSEDED for the
>   incremental rows on the same day: VAD v2 was adopted for the
>   incremental stack (see the VAD v2 FULL MEASUREMENT block below — its
>   v2-inc column is the current incremental config of record). The window
>   rows here remain the standing reference:**
> ```
> clip        mode  WER    RTF    p50    flags  det P/R     budget
> smoke114    win  10.0%  0.234  1.20   1      —           (19/20, الخس sub — pinned)
> smoke114    inc  10.0%  0.178  1.34   0      —           20/20 · الخناس ✓ · zero flags
> 01-clean    win   9.4%  0.284  0.80   3      —           ≤2 ✗
> 01-clean    inc   2.9%  0.162  1.14   2      —           ≤2 ✓ MET (beats window)
> 02-whisper  win   5.1%  0.198  0.98   2      —           ≤4 ✓
> 02-whisper  inc   5.8%  0.142  1.08   5      —           ≤4 ✗ (one over; VAD-blocked)
> 03-fast     win   9.4%  0.303  1.04   2      —           ≤2 ✓
> 03-fast     inc   6.5%  0.172  1.20   4      —           ≤2 ✗ (VAD-blocked class)
> 04-subs     win  10.9%  0.304  0.82   5      0.38/0.60   —
> 04-subs     inc   7.2%  0.176  1.14   5      0.33/0.60   —
> 05-skips    win  17.4%  0.312  0.80   8      0.25/0.75   —
> 05-skips    inc  14.5%  0.173  1.20   8      0.25/0.75   —
> 06-noise    win  10.9%  0.289  0.92   2      —           final-word FAIL (VAD artifact)
> 06-noise    inc   8.7%  0.163  1.14   1      —           final-word FAIL (VAD artifact)
> ```
> (05/06 inc rows from the config-D runs of 2026-07-11 pre-VAD-experiments —
> same code path as the config of record. NOTE vs the earlier transition
> assessment: the "04 P 0.50" figure was the PRE-hysteresis config; the
> committed config trades it to 0.33 for the 01/02 recovery, per the
> measured-trade bullet above. Detection R unchanged everywhere; repetition
> acceptance PASS in both modes on 05; realtime backlog stable — 01-inc
> max 0.1 s / end 0.0 s, 02-inc max 0.3 s / end 0.0 s, node-native.)
>
> ---
>
> **📊 REAL-BROWSER MEASUREMENTS + PERFORMANCE REFRAME (2026-07-11 —
> transcribed from Mohammed's screenshots, UA-verified; this SUPERSEDES the
> pre-measurement anomaly reasoning above):**
> ```
> Mac Safari 27 (WebKit, Version/27.0)   decode=incremental, smoke114:
>   19/20 · WER 5.0% · final-word PASS · hes 0
>   RTF 23.910 · p50 1.34s/p95 3.24s · session load 10946ms
>   streaming wall 537.6s for 22.5s audio · backlog max 514.5s end 514.2s (feed=fast)
> Mac Chrome 149 (V8)                    decode=incremental, smoke114:
>   19/20 · WER 5.0% · final-word PASS · hes 0
>   RTF 0.993 · p50 1.34s/p95 3.24s · session load 494ms
>   streaming wall 22.3s for 22.5s audio · backlog max 1.5s end 1.2s (feed=fast)
> iPhone (iOS 18_7, Mobile Safari)       MICRO mode, ort=wasm (13.5 MB wasm-only
>   binary CONFIRMED in env line) · decode ran as WINDOW (micro ignored &decode= —
>   fixed same day; measurement is decode-mode-independent):
>   session load (cold) 17760ms · passes 15520/15918/16092/16574/17676 ms
>   single-pass RTF median 2.682 · min 2.587 · max 2.946
> ```
> **Reframe (ruled by Mohammed 2026-07-11):**
> 1. **The 48× "anomaly" is RETRACTED — it never existed.** Phone single-pass
>    RTF 2.682 sits in the silicon-expected 2–3× band. Decomposition:
>    48× ≈ 24× WebKit-vs-V8 (measured on identical Mac hardware, same code,
>    same binary) × ≈2× silicon. The A17-class chip is NOT the problem.
> 2. **Bundle-size hypothesis CLOSED — MOOT.** The phone fetched the 13.5 MB
>    wasm-only binary and still measured 2.682; the JSEP/26.8 MB build was
>    never the cause. The `?ort=all` A/B is no longer needed and will not run.
> 3. **THE HEADLINE RISK: WebKit-vs-V8 ≈24× compute gap (RTF 23.9 vs 0.993;
>    session load 10.9 s vs 0.49 s ≈ 22×) — our iOS app ships on WebKit.**
>    ⛔ **SUPERSEDED 2026-07-11 (same day): the C3 TRIANGULATION RESULTS
>    block below overturned this — there is NO WebKit codegen penalty;
>    engines are identical like-for-like. Kept for the record.**
>    Named investigation C3 (critical path, gates iOS shippability; all
>    desktop-side via Mac Safari).
>    **DECOMPOSITION PINNED BEFORE THE RUNS (design corrected by Mohammed
>    2026-07-11 — "identical flags" is NOT proof of identical execution;
>    numThreads=1 printing the same does not prove both engines EXECUTED
>    single-threaded): attribute the 24× across THREE buckets —
>    (a) THREADING actually used at runtime, (b) our JS DSP/mel path,
>    (c) ORT WASM kernels under JSC vs V8. Only bucket (c), if it dominates
>    AFTER threading is normalized, feeds R9.**
>    - **Bucket (a), threading — ANSWERED with evidence (2026-07-11)**: the
>      harness server sends NO COOP/COEP headers at all — its full response
>      header set is `content-type`/`content-length`/`cache-control`
>      (scripts/tasmee-harness-server.mjs writeHead, verified by read +
>      zero grep hits for "cross-origin" in the file). Therefore
>      `crossOriginIsolated` was FALSE in BOTH desktop runs,
>      SharedArrayBuffer was unavailable, and ort-web cannot spawn its
>      threadpool without it → **both engines genuinely executed
>      single-threaded by construction; threading is normalized at 1 and
>      contributes ~0 of the 24×.** Belt-and-braces: the env flags line now
>      prints runtime truth from inside each engine —
>      `xoi=<crossOriginIsolated> sab=<SharedArrayBuffer present>` — so the
>      next Safari/Chrome runs carry the proof in-band.
>      **Implication, also per Mohammed**: the harness caps the threading
>      ceiling artificially — real-app numbers under proper COOP/COEP could
>      differ (upward). That path stays governed by checkpoint ruling #4
>      (threads/SAB = feasibility note only; isolation breaks GCS fetches
>      and the capacitor:// scheme without native changes).
>    - **Bucket (b) vs (c) — TRIANGULATED, not single-sourced (ruled
>      2026-07-11: R9 is the most expensive fork in the project; it does
>      not rest on one number from one self-written tool).** Input #1: the
>      `compute split mel/ort` line (shared renderer; node-native reads
>      mel 20% / ort 80%). Input #2 (independent): `?mode=isolate` — times
>      the mel/DSP path alone (×5) and the ORT inference call alone (×5) on
>      the SAME fixed 6 s buffer, plus a combined-decode sanity set (×2)
>      with an explicit dsp+ort-vs-combined agreement line. Run in Safari
>      AND Chrome; all three numbers must tell the same story per engine —
>      if they disagree, the split line is wrong and we find out why before
>      concluding.
>    - **The threading caveat is LOAD-BEARING and resolves BEFORE R9, not
>      after**: the harness proof (xoi=false) shows threading was zero IN
>      THE HARNESS — it does not show threading is unavailable to the
>      SHIPPED APP under proper isolation. Instruments built (2026-07-11):
>      the harness server takes `--isolate` (serves COOP/COEP; startup line
>      + response headers verified) and the worker takes `?threads=N`
>      (default 1 — the posture every prior measurement used; ort-web
>      falls back to 1 without isolation and the in-band xoi=/sab= fields
>      tell the truth either way). The threaded-Safari test: server with
>      `--isolate`, Safari with `&threads=4` — **if xoi flips true and the
>      isolated-ORT number drops materially, the gap is
>      threading-addressable and R9 recedes.** Separately answer for the
>      shipped app: can the Capacitor iOS WebView be served
>      crossOriginIsolated — what exactly breaks (GCS model fetch,
>      capacitor:// scheme)? (Checkpoint ruling #4's questions, now
>      load-bearing.)
>    - WebGPU availability Safari 27 / iOS 18.7 recorded as DATA (both runs
>      report `webgpu unavailable` in the WORKER scope — window-scope
>      availability may differ).
>    **⛔ R9 TRIGGER — THREE-GATE CONDITION (ruled 2026-07-11, REPLACES
>    "if the split line shows ort%"). R9 becomes the live path ONLY if ALL
>    THREE hold:**
>    **(gate 1)** isolated-ORT confirms kernel-dominance on Safari — the
>    triangulated numbers agree that ORT wasm under JSC, not our DSP, owns
>    the gap; **(gate 2)** threaded Safari (isolation ON, threads > 1) does
>    NOT close the gap materially; **(gate 3)** shipped-app cross-origin
>    isolation is confirmed impossible or insufficient in the Capacitor
>    WebView. Any gate failing → R9 stays a contingency, not a path.
>    **C4 proceeds INDEPENDENTLY regardless** — the winning engine is only
>    RTF 0.993 desktop; stride/overlap tuning + the candidate-model A/B
>    (which now has named recall-floor targets) keep moving whatever C3
>    finds.
>
> **🎯 C3 TRIANGULATION RESULTS (2026-07-11, four isolate runs — Safari 27 /
> Chrome 149 × 1 / 4 threads, server --isolate, transcribed from Mohammed's
> runs; sanity line dsp+ort≈combined AGREED in all four — the split line is
> honest):**
> ```
>                    single-threaded   4 threads      (isolated-ORT, 6.0s buffer)
>   Mac Safari 27        352 ms          125 ms
>   Mac Chrome 149       355 ms          124 ms
>   isolated DSP (mel)    12 ms in all four runs
> ```
> **FINDING 1 — NO WEBKIT CODEGEN PENALTY. The engines are identical at
> this workload, both single-threaded (352≈355) and threaded (125≈124;
> ~2.8× from 4 threads). The "24× WebKit-vs-V8 codegen gap" headline is
> RETRACTED.** DISCIPLINE LOG (per Mohammed): the C3.1 triangulation
> requirement is exactly what prevented misattributing this to WebKit and
> wrongly walking into R9 — the triangulation earned its cost.
> **MECHANISM — amended per the evidence rule (Claude's arithmetic check,
> 2026-07-11; conclusion above unaffected):** "Chrome's earlier streaming
> run was implicitly threaded" does not fit Chrome's own numbers. Scaling
> today's SINGLE-threaded Chrome cost (352 ms / 6 s) to the smoke's ~75
> incremental windows of 2.1–4.2 s projects ≈ 0.65–0.75 RTF plus overhead —
> consistent with the measured 0.993; a 4-threaded Chrome would project
> ≈ 0.25–0.35, which does NOT match. So Chrome's streaming run was
> plausibly single-threaded after all, and the UNEXPLAINED cell is
> **Safari's original non-isolated STREAMING run: ~7.2 s per decode
> (537 s / ~75) vs ~0.35 s per single-threaded decode today — a ~20×
> per-decode gap between two Safari runs whose known differences are
> (i) server isolation OFF vs ON and (ii) long streaming session vs five
> short passes.** Two cheap decisive A/Bs, one variable each: (α) Safari
> `mode=isolate` with the server restarted WITHOUT --isolate — if the
> single-pass cost jumps back toward seconds, isolation state itself is
> the variable (e.g. SAB-backed vs growable wasm memory in WebKit);
> (β) if (α) stays ~350 ms, run Safari STREAMING under --isolate&threads=1
> — if that is fast, the pathology is long-session memory churn/GC, cured
> by isolation-independent means. Until one lands, "threads on vs off" is
> the confirmed lever but NOT the confirmed explanation of the original
> 24×.
> **RULING (Mohammed, 2026-07-11): pushback ACCEPTED — mechanism is OPEN;
> keep the lever-not-explanation wording. α PROMOTED to run alongside the
> top item — it is diagnostic of a live problem, not a stale-number
> closeout, and its outcome FORKS the plan: (branch 1) isolation-state
> alone moves single-pass ~20× → a huge hidden multiplier tied to
> isolation → the Capacitor-isolation prototype (task #11) becomes
> decisive for TWO reasons (threads AND this multiplier) — flag that
> linkage; (branch 2) single-pass stays ~350 ms non-isolated → the 20×
> lives in long-session STREAMING (memory churn / GC / buffer growth over
> ~75 windows) — which is exactly what a real page-length user session is,
> so it becomes its own NAMED PERF ITEM, not a curiosity; run β to confirm
> session-length vs isolation. Server restarted WITHOUT --isolate for α
> (startup line + zero cross-origin headers verified).**
> **DISCIPLINE LOG — third entry against Mohammed (his own ruling,
> 2026-07-11, recorded for symmetry per the binding both-directions rule):
> asserted "Chrome's earlier run was implicitly threaded" as MECHANISM
> while holding only the four-cell CONCLUSION; falsified by the arithmetic
> above. Pattern across all three entries (fabricated repo-verification ·
> mislabeled Safari/Chrome screenshots · this threading mechanism): the
> conclusions were fine — unverified CAUSAL STORIES kept getting attached
> to them. The audit applies to both parties; this section is the proof.**
> **🅰️ α RESULT (Mohammed's run, 2026-07-11 — DECISIVE, branch 2
> CONFIRMED): server without --isolate, Safari mode=isolate, env valid
> in-band (xoi=false sab=false numThreads=1): isolated ORT median 356 ms
> ≈ the isolated-posture single-threaded 352 ms. Isolation state with
> threads=1 has ZERO effect on per-decode cost — branch 1 (isolation-tied
> multiplier) is ELIMINATED. Isolation matters ONLY as the gate to
> threads; no hidden multiplier. Task #11's linkage reverts to SINGLE
> (threads only). DISCIPLINE NOTE (Mohammed): α is a model of the
> method — one variable (isolation; threads pinned), one number (356 vs
> 352), clean elimination of a branch, no causal story attached beyond
> what the number supports. This is the standard.**
> **🔒 MECHANISM CLOSED (same ruling): the original Safari streaming
> ~7.2 s/decode vs today's single-threaded short-pass 356 ms — same
> engine, same threads, same isolation — is confirmed to live in
> LONG-SESSION STREAMING ACCUMULATION: the ~20× builds up over ~75
> sequential windows, not in any per-call cost. Cause = session-length
> degradation; the per-window mechanism inside that session is what β
> now characterizes. → β ANSWERED same day: the "accumulation" is
> window-FILL re-decode cost — nothing accumulates in memory (β TIMELINE
> RESULT below).**
> **🚨 CRITICAL-PATH PERF ITEM (headline, ruled 2026-07-11 — ⛔ CORRECTED
> same day by the β window timeline below: "over-alarmed" per Mohammed's
> own correction; the pathology is window-mode re-decode, and the fix
> already exists = incremental, pending measurement): a real user
> session IS a long continuous streaming session (reciting a full page).
> Every healthy-looking short-pass number — 356 ms, RTF 0.993, the
> four-cell table, the coming WebGPU numbers — is BEST-CASE, measured on
> short buffers. The thing that degrades ~20× is the exact thing users
> do. SHORT-PASS BENCHMARKS CANNOT CERTIFY SHIPPABILITY — long-session
> behavior can. β is PROMOTED from "confirm branch 2" to "characterize
> and FIX the session-length pathology," critical path CO-EQUAL with
> #11 — it gates whether threads+GPU even matter for the real case.**
> **β SCOPE (expanded, ruled): Safari streaming under --isolate&threads=1
> on the smoke, AND per-window instrumentation of WHAT accumulates across
> the ~75 windows — measure the suspects over the session, don't guess
> one and stop: (i) per-window ORT time — flat ~356 ms or climbing?
> (climbing → per-call state growth: context buffers / tensor arena /
> session accumulation); (ii) JS heap + wasm memory.grow events over the
> session (GC pressure, buffer reallocation); (iii) our own controller —
> anything growing unboundedly per window (retained audio, logit history,
> dup-window buffers); (iv) OURS vs ORT's via the split per window — ORT
> flat while combined climbs = our DSP/controller; ORT itself climbs =
> session/tensor arena. REPORT A PER-WINDOW TIMELINE, not an aggregate —
> the shape (flat-then-cliff vs linear climb vs sawtooth) names the
> cause. THEN propose a fix (session reset every N windows / bounded
> buffers / arena reuse) — diagnosis before fix, as always.
> INSTRUMENT BUILT (same day): every streaming harness run now prints a
> β-timeline block — one row per decode (at / span / mel / ort /
> ctl-glue / pending / committed / heapMB [Chrome only] / wasm-grow
> events [both engines — memory.grow hooked at the prototype before the
> ORT import]) plus a shape line (first-10 vs last-10 ort medians, max,
> grow count). Suite 61/61 after the change.**
> **📊 RE-PRIORITIZED STACK (ruled 2026-07-11 — supersedes the
> FINDING-4 SEQUENCING below; ⛔ itself SUPERSEDED same day by the
> CORRECTED stack in the β TIMELINE RESULT block): 1. #11 Capacitor
> isolation prototype
> (threads go/no-go on device) — critical path · 2. β long-session
> pathology characterization — critical path, CO-EQUAL with #11 ·
> 3. WebGPU isolate measurement — still valuable but explicitly
> BEST-CASE until β proves whether GPU also degrades over a session
> (measure GPU long-session too once the short-pass GPU number is in) ·
> 4. incremental + candidate-model A/B — continue; incremental may
> itself be part of the β fix (fewer/bounded re-decodes = less
> accumulation). Server flipped BACK to --isolate (startup line + both
> COOP/COEP headers verified) for the queued runs — WebGPU pair +
> iPhone threading — each to be recorded as SHORT-PASS BEST-CASE
> pending β.**
> **🅱️ β TIMELINE RESULT (Mohammed's runs, 2026-07-11 — decode=window,
> the reference; Safari + Chrome, server --isolate, threads=1 —
> DECISIVE, and it RECLASSIFIES the problem as ALREADY-SOLVED-BY-DESIGN,
> not newly critical). Read the span column against ort:**
> ```
>   row  1   span  0.0–0.3    ort  43 ms
>   row 20   span  0.0–6.0    ort 350 ms
>   row 49   span  0.0–14.7   ort 884 ms   (max)
>   row 50   span 10.0–15.3   ort 319 ms   ← window slides, cost COLLAPSES
> ```
> **ort scales linearly with AUDIO LENGTH PER DECODE, not with session
> position.** It climbs only because window mode re-decodes from t=0
> every step (0.0–0.3, 0.0–0.6, … 0.0–14.7) until the 15 s cap slides
> the window at row 50 — cost instantly drops 5.34× back to baseline.
> wasmGrow flat at 6 all run; heap flat. NOT a leak, NOT GC, NOT arena
> growth. It is the full-window re-decode — the exact thing the
> INCREMENTAL DECODER already exists to fix. Both engines identical
> (Safari 5.34×, Chrome 5.17×) — algorithmic, not engine.
> **MECHANISM FULLY CLOSED: window-mode full-re-decode cost growing
> with window fill. DISPOSITION: incremental decode is the fix, PENDING
> MEASUREMENT on this same metric.**
> **CORRECTION (Mohammed, same ruling, on his own prior ruling):
> promoting "long-session pathology" to co-critical with an undesigned
> fix was over-alarmed — α correctly showed the degradation is
> session-SHAPED; this timeline shows WHY (bounded by window re-decode),
> and the fix is already built.**
> **⚠️ HEADLINE-NUMBERS FLAG (ruled): every prior streaming RTF — the
> 0.99, the 1.4, the original 7.2 s/decode — was WINDOW MODE, inflated
> by re-decode. None represents incremental steady state. The headline
> perf numbers MUST BE RE-TAKEN under incremental before any
> shippability claim.**
> **THE TEST THAT NOW MATTERS — β-incremental acceptance (ruled):**
> 1. ort column FLAT across the session (bounded per-decode audio =
>    bounded per-decode cost) — first-10 vs last-10 median ratio ~1.0,
>    not 5.3×. That is the whole proof.
> 2. Steady-state streaming RTF = flat per-decode cost / 300 ms chunk —
>    THE real shippable number, the one this whole perf investigation
>    has been circling (if ~125 ms threaded → RTF ≈ 0.4, comfortably
>    shippable). The timeline block now prints a steady-state line:
>    ort-only (this ruling's definition) AND full step (mel+ort+ctl).
> 3. Safari AND Chrome, threads=1 AND threads=4 — the threads=4 +
>    incremental cell is the ACTUAL PRODUCTION CONFIGURATION and has
>    never been measured; its flat ort × chunk cadence is the go/no-go.
> 4. Window-mode β stays the documented reference — the 5.3× climb is
>    the baseline incremental must flatten.
> **📊 RE-PRIORITIZED STACK (CORRECTED, ruled 2026-07-11 — the standing
> order): 1. β-incremental (flat-ort proof + steady-state RTF,
> threads=4, both engines) — THE number; likely already-passing given
> the arithmetic; measure it · 2. #11 Capacitor isolation prototype —
> still the on-device threads go/no-go, still critical (steady-state
> RTF only helps if the phone can get threads) · 3. WebGPU — now a
> BONUS lever, not a necessity, IF incremental steady-state clears
> RTF<1 threaded; measure opportunistically · 4. incremental accuracy
> work (VAD v2 adopted; candidate-model A/B) — continue.**
> **🅱️² β-INCREMENTAL RESULTS (Mohammed's four runs, 2026-07-11 —
> decode=incremental, VAD v2, server --isolate; production cell PASSES
> on RTF, with a corrected acceptance reading and a new ledger item):**
> ```
>               1-thread RTF   4-thread RTF   ort-shape-ratio
>   Safari inc     1.09           0.42            2.79× / 2.58×
>   Chrome inc     1.08           0.40            2.77× / 2.23×
> ```
> **ACCEPTANCE-GATE CORRECTION (Mohammed, on his own criterion) + fourth
> DISCIPLINE-LOG entry against him (his own request): the flatness
> criterion (ratio ~1.0) was WRONG — incremental did NOT flatten. It is
> ~2.5×, down from window's 5.3×: the span column still grows to ~8.5 s
> per decode at peak (row 33: span 1.4–9.9) before each slide, then
> sawtooths. Incremental HALVED the re-decode cost but did not bound it
> tightly. Recorded honestly: the production cell is shippable because
> THREADING's 2.8× absorbs the still-imperfect decode — NOT because the
> decoder became efficient. Two independent levers, both load-bearing.
> "I predicted flat; the data said 2.5×. Recording the miss."**
> **🚧 #11 IS NOW HARD-GATING (ruled, stated plainly): at 1 thread,
> incremental is RTF 1.09 — OVER real-time, does NOT ship. The desktop
> pass EXISTS ONLY WITH THREADS. Whether the Capacitor iOS WebView can
> run crossOriginIsolated=true (unlocking threads) is not one option
> among several — it is the single gate the entire browser-path
> shippability now rests on. If the phone can't thread,
> incremental-alone fails and R9 (native) goes live.**
> **📌 STANDING NUMBERS (desktop, threaded, incremental, VAD v2):
> steady-state RTF ~0.40 both engines — THE shippable desktop figure,
> replacing all prior window-mode RTFs. Projected iPhone (×~2.7
> single-thread base, ÷2.8 threads) lands near RTF ~1.0 — TIGHT, not
> comfortable. WebGPU RE-PROMOTED from "bonus" to "probably needed on
> mobile": GPU is likely required for real phone headroom, not
> optional.**
> **⚖️ NEW LEDGER ITEM — BROWSER ACCURACY DELTA (opened by Mohammed's
> harness observation: every incremental browser cell reads 18/20 — 2
> skips, إل truncated from إله — vs window's 19/20; both engines, BOTH
> thread counts). TRUTH-RUN ANSWER (node bench re-run same day, per the
> ruling — fresh receipts):**
> ```
> clip        inc flags  WER    det P/R    final  budget
> smoke114    0          10.0%  —          PASS   20/20 — إله committed IN FULL
> 01-clean    1 (0+1)    2.9%   —          PASS   ≤2 ✓
> 02-whisper  3 (0+3)    7.2%   —          PASS   ≤4 ✓
> 03-fast     1 (0+1)    5.8%   —          PASS   ≤2 ✓
> 04-subs     truth      5.8%   0.60/0.60  PASS   FP 2 · rep-acceptance PASS
> 05-skips    truth      10.9%  0.60/0.75  PASS   FP 2 · rep-acceptance PASS
> 06-noise    1 (0+1)    5.8%   —          PASS   ≤4 ✓
> ```
> **Every number reproduces the adopted v2-inc config-of-record column
> EXACTLY. The 18/20 does NOT reproduce on node-native. So the
> regression is NOT the decoder algorithm, NOT the VAD, NOT the fixed
> feed (all byte-identical across hosts, node uses the same virtual fast
> feed) — the only differing component is the ORT RUNTIME: ort-web wasm
> int8 kernels vs onnxruntime-node native arm64 kernels. Window mode
> AGREES across hosts (19/20 both), so the divergence surfaces only
> under incremental. HYPOTHESIS (labeled as such, pending confirmation):
> wasm-vs-native int8 kernel numerics flip marginal words, and
> incremental's shorter context puts words like إله closer to the
> decision boundary — deterministic (same 18/20 at both thread counts,
> both engines), not threading nondeterminism. ACCEPTANCE-SURFACE GAP
> flagged: the BINDING accuracy surface is node-native, but the ship
> path runs ort-web — the measured 20/20→18/20 smoke delta means the
> binding surface can overstate shipped accuracy. PROPOSED decisive
> instrument (awaiting ruling, not built): run the node bench against
> ort-web's OWN wasm build under node (onnxruntime-web runs in node) —
> same wasm bytes as the browser, full truth scoring, no browser needed;
> if it prints 18/20 the kernel-numerics hypothesis is confirmed and the
> browser path becomes truth-scorable evidence going forward. The
> incContextS/incEdgeGuardS tuning task is NOT triggered — the decoder
> does not regress on the binding surface; do not touch the params on
> this data. Config-of-record adoption stays PENDING this item per
> "diagnosis before adoption."**
> **📊 PRIORITY (corrected, honest — the standing order): 1. #11
> Capacitor threading prototype — HARD GATE, everything rests on it ·
> 2. incremental accuracy truth-run — DONE same day (table above);
> remaining sub-item = the browser-delta diagnosis · 3. WebGPU
> measurement — re-promoted: phone threaded RTF ~1.0 is too tight, GPU
> likely required for real mobile headroom · 4. candidate-model A/B —
> continue (smaller model helps BOTH speed and the recall floor).**
> **⚖️² BROWSER-DELTA RULING + WASM-SURFACE RESULTS (2026-07-11).
> REFRAME (Mohammed, verbatim intent): the truth-run MOVED the problem,
> it did not close it — "the regression doesn't reproduce on the runtime
> users won't use; the one measurement on the runtime they WILL use
> still shows it." The binding accuracy surface is node-native; the SHIP
> PATH is wasm. This blind spot (score accuracy on node, ship wasm) has
> existed the whole project; do NOT let it re-close as "not
> reproduced."**
> **INSTRUMENT BUILT + PERMANENT (approved same ruling): `--ort=web` in
> scripts/tasmee-bench.mjs runs onnxruntime-web's WASM backend UNDER
> node — ort-wasm-simd-threaded.wasm, sha256 d1ab1b94b16a… printed in
> the env line, verified the same dist file the browser fetches (both
> ort.node.min.mjs and the ship-path ort.wasm.min.mjs resolve the same
> loader); numThreads=1 browser-parity, full truth scoring. STANDING
> ACCEPTANCE SURFACE from now on: every future accuracy claim runs on
> BOTH node (fast dev signal) AND wasm (ship-path truth) — the
> "score one runtime, ship another" gap is closed for good.**
> **CONTROL (mandated before trusting the hypothesis — back to back,
> same machine, same day): node-native incremental smoke 20/20 with
> إله committed in full; wasm-in-node incremental smoke 18/20 (2 skips)
> with the EXACT إِل truncation the browser showed. KERNEL HYPOTHESIS
> CONFIRMED — it is the wasm int8 kernels, NOT the browser environment
> (feed, worker scheduling, and decoder bytes identical across hosts).
> Corroboration: wasm-in-node RTF 1.114 single-threaded ≈ the browser's
> 1.08–1.09.**
> **THREE-COLUMN ACCURACY TABLE (all seven clips, incremental VAD v2;
> window reference = historical-VAD baseline; the node→wasm delta is
> the ship-path accuracy cost, quantified for the first time):**
> ```
> clip        node-inc         wasm-inc           window-ref     budget       wasm verdict
> smoke114    20/20 · 0 flags  18/20 · 2 skips    19/20          report-only  إل truncation (kernel)
> 01-clean    1 (0+1)          2 (0+2)            3 (2+1)        ≤2           ✓ at limit
> 02-whisper  3 (0+3)          2 (1+1)            2 (1+1,hes1)   ≤4           ✓ BETTER than node
> 03-fast     1 (0+1)          3 (0+3)            2 (0+2)        ≤2           ❌ BREACH 3 > 2
> 04-subs     P .60/R .60 FP2  P .43/R .60 FP4    P .38/R .60    P≥.8 R≥.9    P regressed .60→.43
> 05-skips    P .60/R .75 FP2  P .60/R .75 FP2    P .25/R .75    P≥.8 R≥.9    = node
> 06-noise    1 (0+1)          1 (0+1)            2 (1+1)        ≤4           ✓ (WER 4.3% < node 5.8%)
> ```
> final-word PASS on every wasm cell (incl. 06 — window's 06 final-word
> FAIL does not appear under incremental). Repetition acceptance PASS on
> 04/05. Note the numerics shift BOTH ways (02 and 06 are better on
> wasm) — not uniformly worse, which constrains any tuning to recover
> 03/04 without breaking 02/06.
> **PRE-RULED DECISION APPLIED — RULE #4 FIRES: wasm-incremental BREAKS
> a binding budget (03-fast 3 > 2; 04 precision also drops .60→.43,
> though 04/05 P/R sit below binding in every configuration). This is a
> real ship-path accuracy regression → incContextS/seam-stitch tuning is
> TRIGGERED on the wasm surface specifically; window mode stays a LIVE
> FALLBACK; incremental is NOT adopted as config of record (rule #3
> does not fire).**
> **TUNING-TASK DIAGNOSIS SEED (transcript diff, 03 node-vs-wasm): most
> deltas are tashkeel-only and normalize identically (harmless — e.g.
> عجاب/عُجاب); the flag-bearing class is SHORT-WORD truncation/mangle:
> مِّن → مِّ (the same final-truncation class as إله → إل), مِّنْهُمْ →
> مهُمْ, هُمْ → ههُمْ. Named wasm-surface targets: إله@114:3:1 (smoke),
> مِن/مِنْهُمْ/هُمْ on 03-fast, 04's FP 2→4. Tuning parameters are
> PINNED constants asserted by the seam fixtures — any candidate change
> will be measured across ALL seven clips on BOTH surfaces and presented
> for adoption ruling (the VAD-v2 conditional-approval flow), not moved
> silently.**
> **✅ RATIFIED + REORDERED (Mohammed, 2026-07-11): two-surface bench
> PERMANENT — headline: adopting incremental on node-native numbers
> would have shipped a runtime that fails 03-fast's own budget; the
> blind-spot instrument caught a real ship-path regression, which
> justifies its permanence. DISCIPLINE LOG: recorded as the blind-spot
> instrument's FIRST CATCH — the "score one runtime, ship another" gap
> was real and load-bearing, not theoretical. FIX STRATEGY REORDERED —
> do NOT tune seam params first: (1) the shift is BIDIRECTIONAL
> (02/06 better on wasm, 03/04 worse) = marginal words on either side
> of a decision boundary, not a systematic offset — seam tuning is a
> balloon-squeeze across a 7-clip × 2-surface "regress nothing"
> constraint that may have NO solution in seam-param space; (2) the
> failing class (short-word truncation under int8) is MODEL PRECISION
> loss on brief low-context acoustic events — seam geometry cannot
> restore acoustic fidelity quantization discarded. RULING:
> candidate-model A/B FIRST through the same 7-clip × 2-surface bench;
> fork — (a) candidate holds ALL binding budgets on wasm-incremental →
> incremental+candidate becomes the config-of-record path (subject to
> the licensing/provenance gate; tilawa-lineage caution applies);
> (b) helps but still breaches → seam tuning triggered on top of the
> better model; (c) regresses elsewhere or fails provenance → fall back
> to seam tuning on the current model. Constraint for whichever fix
> runs: all 7 clips × BOTH surfaces, adoption-ruling flow, seam
> fixtures re-pinned, 05 (bit-stable across runtimes) as the
> didn't-perturb-the-stable-case control. #11 unaffected — still THE
> hard gate, parallel: the model A/B decides WHICH incremental config,
> not WHETHER the browser path is viable.**
> **🧪 CANDIDATE-MODEL A/B RESULTS (2026-07-11, same day — tilawa
> v0.2.0 fastconformer_full_mixed.onnx, sha256 4767182cd929…, mixed
> int4/int8, raw-waveform input, SentencePiece vocab; full 7-clip ×
> 2-surface grid, incremental, VAD v2; record model = v0.1.0 q8):**
> ```
> clip        cand node-inc      cand wasm-inc      record wasm-inc    budget      verdict (cand on wasm)
> smoke114    19/20 · 1 (1+0)    19/20 · 1 (1+0)    18/20 · 2 skips    report-only إله FULL both surfaces; ال split
> 01-clean    1 (1+0) · ins 3    1 (1+0) · ins 3    2 (0+2)            ≤2          ✓
> 02-whisper  6 (3+3) ❌         4 (1+3) · ins 5    2 (1+1)            ≤4          ❌ final-word FAIL (38:16:8
>                                                                                    NOT revealed, completed false)
> 03-fast     1 (0+1) · ins 6    3 (0+3) · ins 8    3 (0+3)            ≤2          ❌ BREACH 3 > 2 (same as record)
> 04-subs     P .50/R .60 FP3    P .75/R .60 FP1    P .43/R .60 FP4    P≥.8 R≥.9   P better; R unchanged
> 05-skips    P .33/R .75 FP6    P .33/R .75 FP6    P .60/R .75 FP2    P≥.8 R≥.9   P COLLAPSED .60→.33
> 06-noise    3 (0+3) · ins 5    2 (0+2) · ins 5    1 (0+1)            ≤4          ✓
> ```
> RTF: candidate node ~0.29–0.31 (vs record ~0.17); candidate wasm
> 1.33–1.63 single-threaded (vs record 1.11) — the candidate is SLOWER
> on the ship path (the CANDIDATE-NOTE's "faster" claim was node-native
> latency; mixed-int4 wasm kernels don't deliver it) → threaded
> projection ~0.5–0.58 vs the record's 0.40.
> **VERDICT — BRANCH (c) FIRES: candidate NOT promoted.** It regresses
> elsewhere: 02-whisper breaches on node (6 > 4) AND hard-fails
> final-word + completion on wasm; 05 precision collapses .60→.33 on
> both surfaces; insertions up on every clip; slower on wasm. The
> recall-floor targets did NOT resolve — R stays .60/.75 (planted
> عجاب/هؤلاء still ASR-absorbed by this candidate too; the binding
> P≥.80/R≥.90 remains unmet by EVERY configuration measured to date —
> a model-class gap beyond this candidate). Provenance gate not
> reached (accuracy failed first).
> **WHAT THE A/B STILL BOUGHT (findings):** (1) the candidate is
> RUNTIME-STABLE — node and wasm transcripts are essentially identical
> (smoke bit-identical incl. the ال split), and إله survives IN FULL on
> both surfaces → the short-word truncation class is a
> QUANTIZATION-INSTABILITY property of the record int8 artifact, not of
> wasm kernels in general. A differently-exported model can be
> runtime-stable. (2) 04-wasm P 0.75 vs record 0.43 — the candidate's
> one standout cell. (3) NEW PROPOSED LEVER (awaiting ruling, not
> started): RE-EXPORT/RE-QUANTIZE the record model targeting stability
> (per-channel calibration / keep sensitive layers higher-precision) —
> the candidate proves the instability is export-borne, and the
> logit-parity infrastructure from the provenance criteria already
> exists. DISPOSITION per branch (c): seam tuning on the CURRENT model
> (#15) is the standing path — with the honest caveat from reason (2)
> above that its odds are low for the truncation class itself; the 03
> gap is one flag, which is the realistic target.**
> **✅ A/B ACCEPTED + RE-EXPORT RULED PRIMARY (Mohammed, 2026-07-11).
> REFRAME RATIFIED as the key diagnostic the A/B bought: candidate
> runtime-stable, record model NOT (إله→إل on wasm only) → short-word
> truncation is NOT a general wasm-int8-kernel property; it is a
> quantization instability of THIS SPECIFIC int8 export. A cleaner
> export of the same architecture can be runtime-stable — the class
> moves from "unfixable without leaving wasm" to "fixable by
> re-exporting."**
> **RE-EXPORT LEVER — APPROVED as the PRIMARY fix for the truncation
> class, ahead of seam tuning (scoped so it can't silently regress):**
> 1. Re-quantize the RECORD model (same weights, same architecture —
>    NOT a new model, no new provenance/lineage question) targeting
>    runtime stability: per-channel calibration and/or
>    truncation-sensitive layers at higher precision (fp16).
>    LOGIT-PARITY GUARD FIRST: verify the re-export matches the
>    reference model's outputs within tolerance BEFORE any accuracy
>    run — the guard that the re-quant didn't corrupt something.
> 2. Full 7-clip × 2-surface grid, incremental. ADOPTION BAR, on the
>    WASM surface specifically: (a) hold every binding budget the
>    record model holds on node-native (01≤2, 02≤4, 03≤2, 06≤4) —
>    i.e. recover 03's wasm breach; (b) NOT regress any currently-
>    passing clip — 02/06 are BETTER on record-wasm than node, must
>    not lose that; 05 is bit-stable and must STAY bit-stable (the
>    control); (c) keep إله and the short-word class intact on wasm
>    (the whole point); (d) no material size/wasm-RTF inflation (stay
>    near 1.11 single-thread / ~0.40 threaded — an fp16-heavy model
>    that pushes RTF up trades the accuracy fix for a speed
>    regression, which FAILS).
> 3. Clears (a)–(d) → becomes the record artifact; #15 reduces to
>    03's residual gap or drops. Standard ruling flow, fixtures
>    re-pinned.
> 4. Helps truncation but breaks (d), OR can't recover 03 → seam
>    tuning ON TOP with the smaller gap (re-export + seam combined).
> 5. Can't be made stable at acceptable size/speed → fall back to
>    seam tuning on the current model (original #15); log the
>    truncation class as a known wasm-surface limitation pending a
>    better base model.
> **⚠️ STANDING OPEN RISK (ruled, → §7 R10): P≥.80/R≥.90 on 04/05 is
> STILL unmet by EVERY config measured (record, candidate, both
> surfaces; R stuck at .60/.75; عجاب/هؤلاء absorbed by every model
> tried). Independent of the truncation work — re-export targets
> truncation (precision), not absorption (recall). If re-export fixes
> truncation and R stays <.90: separate decision (relax threshold with
> rationale / accept known limitation / genuinely different base model
> with full provenance vetting). The truncation fix must NOT obscure
> the failing recall target. #11 remains THE hard gate, parallel —
> re-export decides which artifact ships, not whether the browser path
> ships at all.**
> **RE-EXPORT PIPELINE SCOPE (execution notes, 2026-07-11): the record
> artifact was produced by `quantize_dynamic` (QUInt8, per the committed
> recipe in scripts/tasmee-export-model.py) — DYNAMIC quantization
> computes activation quant params at runtime per-kernel, which is
> precisely the class of export whose numerics legitimately differ
> between runtimes; static/per-channel quantization with calibration is
> the stability move, matching the diagnosis. Two stages: (1) fp32 ONNX
> export from the NVIDIA NeMo checkpoint
> (nvidia/stt_ar_fastconformer_hybrid_large_pcd_v1.0) — needs NeMo on
> Python 3.10–3.12 (this Mac: 3.9.6 system + 3.13.13 — 3.13 likely
> outside NeMo's range per the recipe's own warning; fallback = the
> Windows aligner box per the original deferral); (2) quantization
> iterations + logit-parity + the 7×2 grid — fully local and light
> (onnx + onnxruntime only; calibration audio = the golden clips;
> scripts/tasmee-parity.mjs extends with a --model-b for
> record-vs-re-export token parity). The tilawa releases ship NO fp32
> ONNX (v0.1.0 = q8 only, v0.2.0 = mixed only, per the dated evidence
> above) — stage 1 is unavoidable.**
> **🏭 RE-EXPORT EXECUTED (2026-07-11, same day — stage 1 + three
> stage-2 candidates through the guard, two through the full grid):**
> - **Stage 1 DONE on this Mac** — env gate cleared (brew python@3.12 →
>   3.12.13 venv, nemo 2.7.3 / torch 2.13.0 / onnx 1.22.0 / ort 1.27.0):
>   fp32 export from the NVIDIA checkpoint, 458,160,971 B, sha256
>   e757555bd864… (`models/reexport/`). I/O signature verified identical
>   to the record artifact (audio_signal+length → logprobs).
> - **Guard infrastructure**: `tasmee-parity.mjs --model-b` (A↔B
>   cross-model word-level guard + B's OWN node↔wasm stability +
>   `--window` short-context probe). Note for the record: a one-shot
>   4.0–6.5 s window over إله is frame-EXACT on the record model — the
>   flip needs the specific anchor cuts streaming produces; the bench
>   grid remains the accuracy surface, parity is the corruption guard.
> **THE GRID (incremental, VAD v2; flags = sub+skip; node | wasm):**
> ```
> clip     record        q8pc (per-ch dyn)  q8pc-head (head fp32)  budget
> smoke    20/20 | 18/20❌ 20/20 | 20/20 ✓    20/20 | 20/20 ✓        report-only
> 01       1 | 2          4 | 4 ❌            2 | 4 ❌                ≤2
> 02       3 | 2          0 | 1 ✓✓           0 | 1 ✓✓               ≤4
> 03       1 | 3 ❌        3 | 3 ❌            4 | 3 ❌                ≤2
> 04 P/R   .60 | .43/.60  1.00 | .60/.60     1.00 | 1.00/.60 ✓✓     P≥.8 R≥.9
> 05 P/R   .60 | .60/.75  .33 | .33/.75 ❌    .33 | .33/.75 ❌        P≥.8 R≥.9
> 06       1 | 1          2 | 2 ✓            2 | 2 ✓                ≤4
> RTF-wasm 1.11           0.99–1.04 ✓        0.95–1.03 ✓
> size     131.7 MB       132.4 MB ✓         133.9 MB ✓
> ```
> **q8s (static QDQ per-channel, 191 calibration windows from OUR mel
> frontend): GUARD-REJECTED** — A↔B word-level transcripts differ,
> 37.7% frame mismatch; B's own node↔wasm 2.85% > 2% bound. Static
> int8 ACTIVATIONS degrade the deep conformer badly; the logit-parity
> guard caught it BEFORE any accuracy run — exactly its job.
> **RESULTS vs THE ADOPTION BAR — (c) and (d) PASS, (a) and (b) FAIL
> on both surviving candidates:** truncation FIXED (smoke 20/20 with
> إله in full on BOTH surfaces, both candidates — the lever's goal,
> achieved); RTF/size fine (wasm RTF actually improves ~1.0); 02 goes
> near-perfect (3→0/1); 04 precision hits 1.00 (q8pc-head: BOTH
> surfaces, FP 0 — best cell ever measured). BUT the marginality MOVED:
> 01 breaches (q8pc 4|4; q8pc-head node 2 ✓ / wasm 4 ❌ — still
> runtime-divergent on this clip), 03 stays at 3 (both), and 05
> precision collapses .60→.33 (FP 6; also rep 8|9 across surfaces —
> the bit-stability control is violated). Note: FP 6 on 05 appears in
> EVERY non-record configuration measured (q8pc, q8pc-head, AND the
> tilawa candidate) — the record's FP 2 increasingly looks like the
> locally-lucky outlier, not the norm. R stays .60/.75 in all four new
> columns — R10 reinforced by four more measurement points.
> **STATUS: fork #4 of the ruling is the live branch (helps truncation,
> can't recover 03 — and 01 regressed) → recommended path = RE-EXPORT +
> SEAM COMBINED (q8pc-head as base: best cells, 04 P 1.00 both
> surfaces), with remaining quant-space options (percentile/entropy
> calibration, wider exclusion lists) documented but
> diminishing-returns. NOTHING ADOPTED — awaiting Mohammed's ruling per
> the standard flow.**
>
> ---
>
> **🏛️ TOP-LEVEL FINDING (Mohammed's halt-and-decide ruling, 2026-07-11):
> THE RECALL FLOOR IS ARCHITECTURAL, NOT TUNABLE.** Evidence:
> - R has stayed .60/.75 across SIX independent configurations: record
>   (node+wasm), tilawa candidate (node+wasm), q8pc, q8pc-head.
>   عجاب/هؤلاء absorbed by every one.
> - Interventions swept with ZERO recall movement: quantization
>   (fp32→multiple int8 schemes), base model (record vs candidate),
>   decode mode (window vs incremental), runtime (node vs wasm), thread
>   count.
> - 05 precision .33/FP 6 in EVERY non-record config — the record's FP 2
>   is now most likely a lucky outlier, meaning true model-class 05
>   precision is also below bar.
> **When a target survives that many orthogonal interventions unchanged,
> it is a property of the model, not a knob. Continuing to tune
> quant/export/seam for R≥.90 is very likely motion without progress.**
>
> **✅ ADOPTION (ruled + executed same day): q8pc-head IS the record
> artifact.** It strictly dominates the old record (truncation fixed, 02
> at 0/1, 04 at P 1.00/FP 0 both surfaces, wasm RTF ~1.0, size flat);
> the only regressions are 01 (one-flag seam-targetable class) and the
> 05-precision-outlier (see finding above). Executed: artifact installed
> at `models/tasmee/fastconformer_ar_ctc_q8pc-head.onnx` (sha256
> e2dfe38c8c64…, appended to checksums.txt); defaults flipped in bench /
> parity / flags-tool / harness; old record stays on disk + served as
> the FALLBACK (select via `--model` / harness URL). PROVENANCE NOTE:
> the new artifact is OUR OWN export from the NVIDIA checkpoint — the
> chain is now fully self-produced (checkpoint → our stage-1 fp32 → our
> stage-2 quant, every sha recorded), strictly stronger than the tilawa
> release binary it replaces. RE-PINS: window-mode reference re-pinned
> on the new artifact — node window smoke 19/20 (1 sub, rep 2), SAME
> 19/20 count as the old pinned baseline; incremental config of record =
> the q8pc-head grid above.**
>
> **⏲️ SEAM TUNING (#15) — TIME-BOXED (ruled): target ONLY the one-flag
> budget breaches plausibly seam-geometry (01≤2, 03≤2) on the q8pc-head
> base, wasm surface. Do NOT target 04/05 P/R or recall (not
> seam-solvable per the finding). Bound: N=4 seam-param iterations; each
> checked on 01/03 wasm + no-regression guard on 02/06 wasm + the 05
> bit-stability control; if 01/03 aren't recovered within the bound,
> STOP AND REPORT — no open-ended chase. First step: extend the
> flags-tool to the wasm surface (--ort=web) so the 01/03 flagged words
> are named before any param moves (diagnosis before fix).**
>
> **📋 DECISION MEMO — the 04/05 binding target P≥.80/R≥.90 (ruled: three
> options + recommendation; the decision is Mohammed's):**
> **What 04/05 actually measure (point 4 — the bar may be
> mis-specified)**: scripted WORST-CASE planted errors, weighted toward
> close-phonetic substitutions (the عجاب class) — the hardest detection
> class for any acoustic model at 80 ms frames; the absorbed events are
> exactly those. Natural hifz errors skew to skips / wrong-ayah
> continuations / repeats / hesitations — classes the engine already
> detects well (skips R .75, repetition acceptance PASS everywhere,
> hesitation wired, refrain-resync pinned). Binding recall on
> adversarial clips measures the hardest sliver, not the feature's
> purpose.
> **(A) RELAX to achievable (adversarial R≥.60/P≥.60), documented
> product decision.** Costs nothing in engineering; the bar becomes
> descriptive. The feature loses: silence on ~25–40% of worst-case
> near-homophone subs — a self-tester can believe a wrong-but-close word
> was right. Mitigations that remain: word-by-word reveal anchors the
> reciter; gross errors caught at high rates; «تجريبي» tag + honest copy.
> Risk: cements the bar to this model with nothing forcing a re-raise on
> a future model swap.
> **(B) KEEP the bar, ship as known limitation.** Same shipped behavior
> as (A); the difference is bookkeeping — a permanently-red binding row.
> RECOMMEND AGAINST this mechanism specifically: a binding gate that
> always fails trains us to wave failures through (alarm fatigue) and
> corrodes the discipline that makes the other binding surfaces mean
> something.
> **(C) GENUINELY DIFFERENT BASE MODEL.** Real scope: model search +
> full provenance/licensing vetting (we have measured how expensive that
> discipline is) + tokenizer/frame-rate integration + full 7×2
> re-measurement + the iPhone perf story reopens. Weeks, not days.
> Uncertain payoff: absorption is acoustic similarity at its core —
> a bigger model helps, but nothing guarantees R≥.90 on deliberately
> absorbable planted subs.
> **RECOMMENDATION: (A) + point-4 re-specification, as one package:**
> 1. Record 1–2 NATURAL-ERROR golden clips (recite from memory, truth
>    the real slips — extends the §6.5 recording spec) and move the
>    BINDING recall bar onto them — bind the bar to the feature's actual
>    purpose.
> 2. Reclassify 04/05 recall as adversarial DIAGNOSTIC (report-only),
>    with the achievable floor documented (R .60/.75 observed across six
>    configs).
> 3. KEEP PRECISION BINDING everywhere — false flags are the
>    trust-killer (R2) — and diagnose 05's FP class before accepting it
>    as floor: the 6 skip-FPs cluster around planted-repeat boundaries,
>    which smells ENGINE-level (controller/repeat interplay), not model
>    absorption; if engine-level, it is fixable without touching the
>    model.
> 4. Defer (C) unless the natural-error measurement still fails the
>    purpose test.
> **My read on the product question (as asked — the ruling is
> Mohammed's): yes, 60–75% adversarial catch is acceptable for v1-beta
> self-testing, with honest copy** — because the absorbed class
> (near-homophones) is the class even human listeners flag
> inconsistently, while the classes that matter most for hifz
> self-testing (did I skip? did I jump to the wrong ayah? did I hesitate
> where I should be fluent?) are caught at high rates. The feature's
> core value is the guided reveal + gross-error catching, not
> tajweed-grade substitution detection.
>
> ---
>
> **📢 GROUND-TRUTH CORRECTION (Mohammed's listen-back, 2026-07-11) —
> AND IT REWRITES THE RECALL STORY. The 04/05 "accuracy failures" were
> partly GROUND-TRUTH ERRORS, not model failures:**
> - **Tashkeel-only (correct behavior, ruled leave-as-is)**: the
>   عجاب(38:5:8) and هؤلاء(38:15:3) plants materialized only as vowel
>   variants (عِجاب kasra-for-damma; هؤلاءُ added final damma) — the
>   SAME word. The engine matching them is correct BY DESIGN. Normalizer
>   verified same day: `tasmeeNorm(عُجَابٌ)==="عجاب"===tasmeeNorm(عِجاب)`
>   and `tasmeeNorm(هَٰؤُلَاءِ)==="هولا"===tasmeeNorm(هؤلاءُ)`; the three
>   real subs all differ under norm. Ruled: do NOT make the model
>   stricter here.
> - **Real accidental subs (إمتلاق/إملال/أموال for
>   اختلاق/الأسباب/الأوتاد)**: transcript evidence LOCATES them in CLIP
>   04 — the ASR heard them there (الإملال/الأموال visible in 04's
>   committed transcript) and flagged all three (matrix sub:3 = they
>   were already TPs). Clip 05's transcript holds the REFERENCE forms at
>   those positions and the engine marks them correct — so NO events
>   were added to 05's truth; a PENDING note asks Mohammed to ear-check
>   05's audio at those three words (if he also misspoke there and the
>   ASR absorbed it, they become truth subs and honest FNs).
> - **Truth files corrected**: 04 events reduced to the three real
>   plants with actual utterances in `said`; corrections documented
>   in-file with the evidence.
> **RE-SCORE vs CORRECTED TRUTH (q8pc-head record artifact, incremental,
> both surfaces):**
> ```
>            old (wrong truth)          corrected truth
> 04 node    P 1.00 / R .60  FN2        P 1.00 / R 1.00  TP3 FP0 FN0 ✓✓ BINDING MET
> 04 wasm    P 1.00 / R .60  FN2        P 1.00 / R 1.00  TP3 FP0 FN0 ✓✓ BINDING MET
> 05 node    P .33 / R .75              UNCHANGED (correction did not touch 05)
> 05 wasm    P .33 / R .75              UNCHANGED
> ```
> **HONESTY CHECK — THE "ARCHITECTURAL RECALL FLOOR" FINDING IS
> SUBSTANTIALLY REVISED (per the ruling's own condition):** the
> six-configuration sweep varied quantization, base model, decode mode,
> runtime, and threads — but NOT the ground truth, and the invariant
> error was in the constant. Corrected, **R(04) = 1.00 in EVERY
> configuration** (derivable without re-runs: TP was 3 in every grid —
> every config always caught all three real subs; the "stuck" FN2 was
> the tashkeel pair, which were never errors). What SURVIVES of the
> floor: (i) 05's single FN — ⛔ corrected same day by the flags-level
> diagnosis below: the FN is بل@38:8:6 (ما@38:11:2 was DETECTED);
> window-01's ما→مَّ stays the lone short-word SKIP data point —
> NOT an architectural recall floor; (ii) 05's precision (FP 6
> in every non-record config): the FPs cluster at 38:8:12–14 + inserts
> @38:1:1/38:8:12, immediately after the planted بل skip @38:8:6 —
> the ENGINE-LEVEL post-skip-alignment-wobble hypothesis is
> strengthened (diagnosable, likely fixable without touching the
> model). R10 is downgraded accordingly; the invalidated
> candidate-model recall targets عجاب@38:5:8 / هؤلاء@38:15:3 are
> STRUCK (they were never model misses); ما stays.**
> **METHOD NOTE (both-directions log): truth files are measurements
> too.** The evidence rule was applied to every claim EXCEPT the truth
> files' own content — six orthogonal interventions were swept against
> a constant that was wrong. Neither party caught it until the
> listen-back. Standing lesson: a "floor" conclusion needs the ground
> truth re-verified before it is called architectural.
> **📋 MEMO (#18) AMENDED — premises revised**: with corrected truth,
> q8pc-head MEETS P≥.80/R≥.90 on 04 on BOTH surfaces; the binding
> failure now rests entirely on 05 (P .33 — the FP cluster, see the
> diagnosis below; R .75 — one FN, corrected to بل@38:8:6, possibly a
> failed plant). The relax-the-threshold pressure drops
> sharply: the recommended sequence becomes (1) diagnose 05's FP
> cluster (engine-level), (2) the ما short-word miss (model/seam
> class), (3) natural-error golden clips STILL recommended as the right
> binding surface on its own merits. The A/B/C decision can reasonably
> be DEFERRED until (1) lands.
> **RE-RECORD ANSWER (as asked): the corrected 04 re-score is
> TRUSTWORTHY** — truth, transcript, matrix, and readback all agree;
> the only loss is statistical width (3 plants instead of 5). A clean
> 04 re-record (5 plants that are real word-level subs) is
> nice-to-have, not blocking. 05 needs only the EAR-CHECK of the three
> positions (pending note in its truth file) — if clean, 05 stands;
> its FP/FN numbers are real measurement, not truth artifacts. The
> higher-value NEW recording remains the natural-error clips from the
> memo.
>
> **🔍 05 FP-CLUSTER DIAGNOSIS (2026-07-11, flags-tool + anchor/pending
> trace over 47–56 s; diagnosis-before-fix — root cause only, NO fix
> applied):**
> **First, a correction to the previous turn's attribution (own
> discipline entry — asserted without flag-level evidence): the missed
> planted skip (FN 1) is بل@38:8:6, NOT مَّا@38:11:2 — the flags list
> shows ما@38:11:2 was DETECTED (TP).** The "short-word skip miss"
> claim shrinks accordingly: window-01's ما→مَّ remains the only
> short-word SKIP data point; the truncation family reappears here on
> the FP side instead (below).
> **The FP 6 decomposes into TWO incidents, not six independent
> errors:**
> - **Incident A (5 FPs — skips 38:8:12/13/14 + insertions
>   «لما»+«يذوق»): an IDGHAM MERGER plus a TAIL TRUNCATION breaking the
>   exact-match resync pair.** ⛔ THE MERGER HALF OF THIS STORY WAS
>   WRONG — corrected by the 2026-07-11 ear-check (see the EAR-CHECK
>   RESOLUTION block below): بل@12 was the PLANTED SKIP, mispositioned
>   in the truth file as pos 6; the ASR emitted only لَمَّا because
>   بل was genuinely not recited. The truncation half stands. Original
>   text kept for the record: Trace evidence: the ASR NEVER emitted
>   بَل@12 as a token — the reciter's بَل لَّمَّا is recited with the
>   lams merged (إدغام, correct tajweed), so the acoustic stream
>   genuinely contains «بَلَّمَّا» and the ASR emitted only لَمَّا.
>   Engine at pointer 12 (expecting بل) received لما → stall; the
>   resync pair it then tried was (لما، يذوق) — but the ASR had
>   truncated يَذُوقُوا → «يذوق» (the same FINAL-TRUNCATION family as
>   إله→إل), so the pair failed against reference (لما@13، يذوقوا@14);
>   both words were recorded as insertions, and when عذاب(15) أم(16)
>   arrived the pair (عذاب، أم) matched at 15–16 → positions 12/13/14
>   flagged skipped. ONE incident → 5 FPs. Had يذوقوا not been
>   truncated, the resync would have contained this to a single flag
>   at 12.
> - **Incident B (1 FP): insertion «ل» @idx0, t=0.1 s** — a clip-start
>   decode artifact (onset fragment), unrelated.
> **The post-skip-wobble hypothesis is RETIRED**: the cluster is six
> words downstream of the planted بل@6 and mechanistically unrelated
> to any skip COMMIT — indeed the engine never flagged بل@6 at all
> (the FN): in the trace the ASR stream around 49.2–49.4 s first read
> «بَلْهُمْ» fused, then split it into بَلْ هُمْ — so the engine SAW
> بل@6 as recited and matched 6–11 clean. Either the plant failed
> (Mohammed said بل despite the script) or the ASR stretched
> بيننا/هم residue into بل — **his pending 05 ear-check now has a
> FOURTH position: did بل@38:8:6 actually get skipped in the
> recording?**
> **FIX OPTIONS (all touch pinned contracts — awaiting ruling, none
> applied):**
> 1. **Resync-pair truncation tolerance** (engine): accept a pair when
>    word A is exact and word B is a strict PREFIX of the reference
>    word (CTC tail-truncation-aware) — contains this whole class to
>    single flags. Contract change to the fixture-pinned resync rule.
> 2. **Idgham/assimilation normalization** (domain fix): a small table
>    of tajweed mergers (بَل/هَل + ل-initial next word, etc.) treated
>    as fusion forms in matching — the recitation-correct merger stops
>    producing a phantom missing word. Arguably the RIGHT fix: these
>    mergers are systematic in correct recitation, and 05 will not be
>    the last clip to hit one.
> 3. **Scoring note** (methodology, Mohammed's call): FP counting is
>    per-EVENT — one incident inflated P's denominator by 5. Under
>    incident-level accounting 05 reads TP 3 / FP-incidents 2
>    (P .60). Not self-served — flagged for the ruling only.
> 4. **Clip-start guard** (minor): onset fragment «ل» — a min-length /
>    onset-guard tweak, smallest of the four.
> **NOTE: 05's precision failure is NOT model-floor and NOT post-skip
> engine wobble — it is one tajweed-merger seam incident plus one
> onset artifact, both addressable.**
>
> **🛠️ FIXES IMPLEMENTED (ruled 2 + 1 + 4 approved, 2026-07-11 — same
> day; #2 conservative per the caution, per-event stays binding per
> methodology ruling #3):**
> - **Fix #2 (idghām fusion — engine rule 1c2)**: إدغام المتماثلين
>   الصغير table {بل، هل، قد، إذ} — next word's first letter must equal
>   the particle's final letter (the mushaf marks the merger: لَّمَّا
>   carries shadda), EXACT match on the second word or the exact fused
>   forms only; both words reveal correct with `idgham:true`.
>   Deliberately EXCLUDED: متقاربين mergers (بل ران is read with سكتة
>   in Hafs — a rule we can't cite cleanly for all cases doesn't go
>   in). Over-absorption pinned by fixture: بل before هم (letters
>   differ) still flags a real skip.
> - **Fix #1 (tail-truncation pair tolerance — THREE pair sites)**:
>   `truncPrefix` (strict prefix, ≥3 chars, missing tail ≤3) accepted
>   only when the pair PARTNER matched exactly — (i) omission
>   corroboration (0c), (ii) stall resync, (iii) the pendingSplit
>   flush when an exact successor corroborates a truncated pointer
>   word. A LONE truncated word still flags (pinned by fixture).
> - **Fix #4 (onset fragment) — one same-day iteration, recorded
>   honestly**: the first implementation (controller-side duration
>   guard) was WRONG and reverted within the hour — the CTC assigns
>   single-token words a near-zero span (startS==endS at the spike),
>   so any duration test swallowed the muqatta'at: ص@38:1:1 went from
>   correct to SKIPPED on 05, and the shifted anchor timeline
>   re-rolled ما@38:15:7 into a new FP. LESSON RECORDED: duration
>   tests on CTC word spans are unusable — single-token words have no
>   width. Replaced with an ENGINE-side leading-fragment rule (a
>   single-letter token matching nothing BEFORE the first reveal is
>   ignored) — reference-aware, so expected letter-words (ص ق ن) are
>   safe by construction.
> - **Methodology #3 (ruled: report BOTH, bind per-event)**: the bench
>   truth scorer now prints a per-incident diagnostic line
>   (adjacency-clustered FPs) beside the binding per-event P/R.
> **Suite: 61 → 68 (6 idghām/truncation fixtures + the onset-guard
> fixture, which survived the fix-#4 reimplementation unchanged —
> implementation-agnostic as designed). All 68 green.**
> **RE-RUN + FULL REGRESSION GRID (all 7 clips × both surfaces,
> q8pc-head incremental, corrected truth; flags = sub+skip):**
> ```
> clip     node pre→post        wasm pre→post        budget   verdict
> smoke    20/20 → 20/20        20/20 → 20/20        report   =
> 01       2 → 2 (ins 2→1)      4 → 4 (ins 3→2)      ≤2       = (wasm breach stands — #15)
> 02       0 → 0                1 → 1                ≤4       =
> 03       4 → 4                3 → 3                ≤2       = (breach stands — #15)
> 04       P1.00/R1.00 =        P1.00/R1.00 =        P.8/R.9  MET (both surfaces)
> 05       P.33 → P1.00 FP0 ✓✓  P.33 → P.43 (FP6→4)  P.8/R.9  node P MET · R .75 pending ear-check
> 06       2 → 2 (ins 5→3)      2 → 2 (ins 2→1)      ≤4       =
> ```
> **05-node: EVERY false positive eliminated (P 1.00, incidents 0);
> insertions dropped clip-wide as the truncation-pair sites absorb
> junk flushes. NO regression on any clip, either surface. R .75 both
> surfaces = the single FN بل@38:8:6 — if Mohammed's ear-check finds
> the plant failed, the truth event is removed and 05-node reads
> P 1.00 / R 1.00: the binding target would be MET on node-native for
> BOTH truth clips. 05-wasm residual FPs (38:7:10, 38:8:1, 38:15:5)
> are wasm-numerics marginality reshuffles — the same seam-lottery
> class as 01/03-wasm, i.e. #15's existing orbit, NOT a new
> mechanism.**
>
> **👂 EAR-CHECK RESOLUTION (Mohammed, 2026-07-11 — four findings, each
> verified against dataset + transcript before any change):**
> 1. **Repetitions 38:5 ×2 and 38:6 ×2 — ALREADY RECORDED** in 05's
>    truth (spans 5–8 and 9–12, matching his phrases exactly); the
>    engine's rep events confirm the ASR captured them; repetition
>    acceptance PASS. No change.
> 2. **اختلاق@38:7:10 confirmed CLEAN** — matches the transcript
>    evidence; the pending note in 05's truth is resolved.
> 3. **THE بل POSITION — a TWO-TURN ERROR corrected, plus one dataset
>    pushback**: the planted skip is the SECOND بل of 38:8. Mohammed's
>    readback said "word 10"; verified against tasmee-words.json, pos
>    10 is من — the second بل is **pos 12** (recorded at 12, same
>    correction class as the five step-1 draft fixes). بل@6 was
>    recited, as he confirmed.
> 4. **THE ENGINE HAD IT RIGHT ALL ALONG (his 4b question, answered):
>    the PRE-fix engine flagged 38:8:12 — the truth-position error
>    converted that TP into an FP and manufactured the phantom FN at
>    pos 6.** The بَلْهُمْ-fusion speculation is STRUCK (it explained a
>    word he actually recited; the ASR heard it because it was there).
> **⛔ IDGHĀM RULE NARROWED (the over-match caution materialized): the
> one measured incident behind the "ASR drops the merged particle"
> theory WAS THE PLANTED SKIP — bare لما is exactly what a genuine
> skip of بل sounds like, and the bare-second-word acceptance absorbed
> the plant (the fix ruling's own regression rule: "doesn't turn a
> real planted error into a missed one" — it did). NARROWED same day
> to FUSED-TOKEN FORMS ONLY (بللما/بلما — evidence of the particle's
> acoustics in the token); the bare form is a DOCUMENTED DEAD END
> unless a measured true-merger case appears (zero exist in the
> corpus: narrowing changed NOTHING on 01/02/03/06, either surface).
> Fixtures rewritten to pin the narrowed contract (bare لما → one
> honest skip flag; fused → accepted; suite 68/68).
> DISCIPLINE LOG (symmetric pair): Claude asserted the idghām-merger
> mechanism as "the root cause" on top of an unverified truth
> position; Mohammed's ruling elevated it to "a rule of recitation the
> engine fundamentally lacks." Both built causal stories on the same
> mispositioned constant; the ear-check + dataset receipt corrected
> both. The fused-form rule survives as cite-able tajweed with zero
> measured harm; fix #1 (truncation pair) turned out to be the fix
> that mattered.**
> **✅ FINAL GRID (corrected truth, all fixes, q8pc-head incremental —
> and the CLOSURE):**
> ```
> clip     node                 wasm                 budget
> smoke    20/20 clean          20/20 (1 ins)        report ✓
> 01       2 ✓                  4 ❌ (#15)            ≤2
> 02       0 ✓                  1 ✓                  ≤4
> 03       4 ❌ (#15)            3 ❌ (#15)            ≤2
> 04       P 1.00 / R 1.00 ✓✓   P 1.00 / R 1.00 ✓✓   P≥.8 R≥.9
> 05       P 1.00 / R 1.00 ✓✓   P .50 / R 1.00       P≥.8 R≥.9
> 06       2 ✓                  2 ✓                  ≤4
> ```
> **THE BINDING DETECTION TARGET P≥.80/R≥.90 IS MET ON NODE-NATIVE FOR
> BOTH TRUTH CLIPS — the A/B/C threshold decision DISSOLVES as
> Mohammed reserved (#18 closed: target met, no relaxation needed, no
> new base model needed). Recall on 05 is 1.00 on BOTH surfaces.
> Remaining accuracy work is ONE class: the wasm marginality lottery
> (01-wasm 4>2, 03 both 3–4>2, 05-wasm FP 4 — flags @38:7:10/38:8:1 +
> inserts) — #15's existing time-boxed scope. R10 narrows to: that
> lottery + window-01's ما→مَّ as the lone short-word data point.
> Natural-error golden clips remain recommended (now as v1.1 hygiene,
> not as an escape hatch from a failing bar).**
>
> ---
>
> **🚦 PRIORITY RESET (Mohammed, 2026-07-11): #11 — the Capacitor iOS
> threading prototype — is the single most important task, ahead of
> everything including #15.** Accuracy is at a natural pause (recall
> 1.00 both surfaces both truth clips; residual wasm precision gaps
> contained in time-boxed #15). Every performance and accuracy result
> ASSUMES the browser/wasm path ships on iOS — unproven, and it can
> invalidate the rest: without isolation, incremental is RTF ~1.09
> single-threaded (over real-time). NO accuracy or feature work resumes
> until the prototype result is read.
> **PROTOTYPE BUILT (same day, this session): `proto/tasmee-ios/` +
> `scripts/build-tasmee-proto.mjs` assembles it AS `dist-app/` (143 MB,
> sideload-only) so the existing wrapper flow ships it unchanged
> (`npx cap sync ios` → Xcode ▶). Real app stack: the m7mdiyat wrapper
> + its scheme handler, patched to serve COOP: same-origin +
> COEP: require-corp (patch = 2 header entries in the Capacitor iOS
> WebViewAssetHandler; wrapper is TCC-blocked from this session → the
> patch runs as a Claude Code prompt in Mohammed's terminal, recorded
> in task #11). What it prints, on-screen: page-scope AND worker-scope
> crossOriginIsolated / SharedArrayBuffer / cores; Filesystem 1 MB
> round-trip via getUri→convertFileSrc→fetch (the §3/A3a FS-bytes leg,
> proven without a 134 MB base64); a GCS CORS-under-COEP range probe
> (download-leg evidence, informational); bundled same-origin model
> load (sha-verified against the record artifact e2dfe38c…, zero-copy
> transfer to the worker per A3a); ORT session load + warmup-excluded
> 5-pass isolated-ORT median on the fixed 6.0 s smoke buffer — directly
> comparable to the desktop four-cell table (352–356 ms single /
> 124–125 ms 4-threaded) — plus a projected incremental steady-state
> RTF bracket for 2.1–4.2 s spans. Two buttons: threads=4 (the gate)
> and threads=1 (comparison). ORT init on the tap path (pinned iOS
> gesture rule). Desktop pre-flight server on :8788 serves the same
> bundle with the same headers for a Mac Safari sanity run first.**
> **THE THREE OUTCOMES (stated BEFORE the run, per the ruling — read
> the result against these):**
> 1. **xoi=TRUE + threads work + on-device threaded ORT ~300–400 ms
>    /decode → browser path VIABLE on iOS.** Steady-state RTF projects
>    near/under 1.0 with incremental; WebGPU (queued) becomes the
>    headroom lever. Green light; feature-build (Gates 4–8) proceeds —
>    with one NEW required item: an app-wide CORP/crossorigin audit
>    (COOP/COEP applies to the whole app, and remote media — GCS audio
>    via <audio> — must carry crossorigin/CORP or playback breaks).
> 2. **xoi=TRUE but threaded ORT still too slow (RTF > 1 even
>    threaded) → threads necessary but insufficient; WebGPU becomes
>    REQUIRED** — measure it next on-device; if it also falls short,
>    R9 goes live.
> 3. **xoi=FALSE (WebView can't isolate / can't get threads /
>    FS-load breaks COEP) → the browser path CANNOT ship performantly
>    on iOS as-is; R9 (native inference plugin) becomes the path.**
>    What specifically changes: the native plugin (onnxruntime native /
>    sherpa-onnx / Core ML) sits behind the SAME worker message
>    interface (module boundary already contains it); the engine /
>    controller / truth-scorer / golden-clip stack carries over
>    unchanged (host-agnostic by construction); the q8pc-head ONNX
>    artifact remains usable under native ORT (Core ML would need
>    conversion + full parity-guard + 7-clip re-validation); the
>    wasm-surface bench demotes from ship-path truth to dev signal and
>    #15's wasm targets are re-scoped to the native surface; WebGPU is
>    moot on iOS; timeline cost is the weeks-class R9 fork (the most
>    expensive in the project) plus Android likely STAYS on the wasm
>    path (Chromium honors COOP/COEP) — a two-runtime ship matrix.**
>
> **AMENDMENT (2026-07-11, pre-run — wrapper facts source-verified +
> deploy-flow correction, after Mohammed's context correction):**
> **(a) The prototype already rides the NORMAL deploy flow.**
> `build-tasmee-proto.mjs` writes `dist-app/` in place — the same
> folder `build-app.js` produces and the same folder `npx cap sync ios`
> copies. The ONLY substitution is step 1 (proto builder instead of
> build-app.js); step 2 is unchanged; restore with `build-app.js`.
> There is no separate channel.
> **(b) COOP/COEP on iOS: the node_modules Swift edit is the ONLY
> route — verified against @capacitor/ios 8.4.0 SOURCE** (installed in
> this repo's own node_modules, read directly): zero hits for
> COOP/COEP/cross-origin in the iOS source; capacitor.config has NO
> response-header option on any version to date;
> `CAPBridgeViewController.loadView()` is `public final` and
> instantiates `WebViewAssetHandler` directly (no factory hook;
> `prepareWebView` private) → no app-target subclass/injection route
> exists. Patch site (8.4.0): the `headers` dict at the top of
> `webView(_:start:)` — two added entries flow to BOTH response sites
> (200 + 206 range); media extensions get a headerless URLResponse but
> are same-origin → COEP-clean. Durability: `npm install` in the
> wrapper erases the edit (patch-package once proven; plain edit fine
> for the prototype).
> **(c) Prior art (capacitor#6182 + discussion#5502): NO confirmed
> report of scheme-handler COOP/COEP flipping crossOriginIsolated on
> iOS** — the issue closed "needs reproduction", no option added; the
> one reported iOS success used the OLD GCDWebServer webview
> (cordova-plugin-ionic-webview@2.5.3) with patched headers, i.e. a
> real local HTTP server, not WKURLSchemeHandler. Consequences:
> outcome-3 prior slightly raised (WKWebView may not run the COI gate
> for custom-scheme responses at all — exactly what the readout
> answers), and **outcome 3 gains a NEW intermediate rung BEFORE R9:
> serve the app from an in-app local HTTP server with real response
> headers** (one prior success report; would need its own
> security/offline audit before adoption).
> **(d) TCC unblock (pending Mohammed): moving the wrapper out of
> ~/Desktop permanently removes the block** → future sessions patch and
> verify the wrapper directly; the R8 relay-prompt workaround retires.
> After the move: re-check the wrapper's webDir (a relative path needs
> one fix), reopen Xcode/Android Studio from the new path, update
> CLAUDE.md + session-settings + memory paths in this repo.
>
> **FINDING 2 — R9 GATE 1 FAILS.** Kernel cost is platform-neutral, not a
> WebKit forcing function. **R9 DEMOTED back to documented contingency**,
> triggered ONLY by Finding 3's outcome (shipped-app isolation impossible/
> insufficient = gate 3) — no engine-penalty path to R9 exists.
> **FINDING 3 — THE SINGLE MOST IMPORTANT OPEN ITEM (replaces the WebKit
> investigation): CAN THE CAPACITOR iOS WEBVIEW RUN CROSS-ORIGIN ISOLATED
> with the model available?** Concrete sub-questions:
> - Can the app shell serve `COOP: same-origin` + `COEP: require-corp`?
>   (Capacitor iOS custom-scheme handler / server config — response headers
>   are set in the native wrapper; wrapper is TCC-blocked from agent
>   sessions → Mohammed applies/verifies in Xcode per R8.)
> - Model under COEP: **the APP path is likely already clean by design —
>   PROMISING, marked UNPROVEN (ruled 2026-07-11)** — §3/A3a stores the
>   model via Capacitor Filesystem and loads BYTES (zero-copy transfer to
>   the worker), so there is NO cross-origin model fetch in-session. The
>   WEBSITE path fetches from GCS via fetch() in CORS mode with ACAO
>   already configured — spec-wise that satisfies require-corp
>   (CORS-approved responses pass COEP). **Both are PAPER ARGUMENTS until
>   the on-device prototype prints crossOriginIsolated=true — same
>   evidence bar as everything else; the reasoning only raises the odds of
>   success, the prototype remains the go/no-go.** Fallback options if
>   anything breaks: same-origin the asset, or a CORP proxy.
> - **PROTOTYPE = the go/no-go**: minimal isolated Capacitor page that spins
>   ORT with threads and prints crossOriginIsolated + numThreads actually
>   used. If it cannot isolate → gate 3 met → R9 goes live.
> **FINDING 4 — THREADED IS NECESSARY, LIKELY NOT SUFFICIENT ON iOS (honest
> projection):** threaded desktop ORT = 125 ms/decode; iPhone ran ~2.7×
> desktop single-threaded, so threaded iPhone projects ≈ 340 ms/decode —
> still RTF > 1 against a 300 ms chunk. Levers RE-PRIORITIZED by expected
> payoff: **(a) WEBGPU — now the highest-value UNMEASURED lever**
> (instrument built: `?ep=webgpu` forces the all/jsep bundle, hard error if
> unavailable — no silent wasm fallback; isolate mode gained an explicit
> warmup pass excluded from the median, which also names the Chrome 225 ms
> first-pass outlier as warmup, non-blocking; iOS 18.7 WORKER-scope WebGPU
> availability prints per-run — note the earlier desktop streaming runs
> printed `webgpu unavailable` in worker scope while the isolate runs
> reported available: per-run env lines settle it each time);
> **(b) incremental decode** — fewer re-decoded seconds per chunk, still
> the core RTF lever; **(c) v0.2.0 candidate model** — now
> performance-relevant AND recall-relevant (the recall-floor targets), A/B
> priority PROMOTED. **TARGET (pinned): threaded + at least one of
> (webgpu / incremental / lighter model) must bring PROJECTED iPhone
> streaming RTF comfortably under 1.0.**
> **SEQUENCING (ruled)** ⛔ SUPERSEDED 2026-07-11 by the RE-PRIORITIZED
> STACK above (β co-equal with #11; WebGPU explicitly short-pass
> best-case pending β) — kept for the record: 1. Finding-3 prototype
> (critical path, gates everything) · 2. WebGPU isolate measurement
> (parallel) · 3. incremental + candidate-model A/B · 4. VAD v2 adopted
> and window-01 WONTFIX stand.
> 4. **SEPARATE CONCERN C4: V8 baseline efficiency.** Best-case engine on a
>    fast desktop is RTF 0.993 with ~1.5 s backlog — barely real-time, no
>    headroom (mobile V8 is slower; longer/faster recitation has no margin).
>    Incremental needs raw-efficiency work — the separately-scoped
>    stride/overlap tuning AND possibly the candidate-model A/B — to reach a
>    safe desktop margin (**working target: desktop RTF ≤ 0.5**), independent
>    of the WebKit question.
> 5. **Micro-mode fix shipped**: `?mode=micro` now honors `&decode=` —
>    incremental micro runs TWO pass sets at the sliding window's extremes
>    (2.1 s and 4.2 s) and prints a projected per-chunk streaming RTF for
>    each. → **MEASURED same day (iPhone Safari, micro, incremental,
>    VAD v2, xoi=false sab=false — single-threaded confirmed in-band):**
>    ```
>    session load (cold) 17819ms
>    2.1s window: passes 5797/5778/5879/5833/5945ms · single-pass RTF median 2.778
>                 → projected streaming RTF ≈ 19.44
>    4.2s window: passes 10979/11049/11155/11697/12042ms · single-pass RTF median 2.656
>                 → projected streaming RTF ≈ 37.18
>    ```
>    Single-pass ~2.7 confirmed on-device (matches the ort=wasm window-mode
>    micro — decode-mode-independent, as expected). **Projected incremental
>    streaming on iPhone is ≈19–37× real-time — the BIGGER window is WORSE
>    (per-chunk cost scales with window size; hysteresis's 4.2 s ceiling
>    nearly doubles the per-chunk bill). The WebKit path being far from
>    real-time is now confirmed ON DEVICE, not just projected from Mac
>    Safari.**
> 6. **LATENCY PARADOX, explained for the record**: both desktop runs report
>    p50 1.34 s while Safari's backlog runs to 514 s. Under `feed=fast` the
>    virtual clock feeds chunks as fast as compute allows, so per-token
>    stable-latency (measured against each chunk's virtual arrival) stays
>    healthy no matter how far wall-clock falls behind; queue growth appears
>    ONLY in the backlog line. A healthy p50 does NOT mean a healthy live
>    experience at RTF > 1 — this is exactly why realtime-feed mode and the
>    backlog line were mandated (ruling #3).
> 7. **METHOD NOTE (discipline log, recorded at Mohammed's request)**: the
>    two desktop runs were initially mis-attributed (Safari numbers labeled
>    Chrome and vice-versa) and the 24× claim was nearly asserted before
>    both screenshots were UA-verified; corrected once both were in hand.
>    The both-directions evidence rule (raw output + date before assertion)
>    applies to analysis of measurements too.
> 8. **📱 #11 DEVICE RESULT (2026-07-11, in-app Capacitor WebView, iPhone
>    iOS 18.7, COOP/COEP patched into WebViewAssetHandler.swift):
>    xoi=false · sab=false · numThreads post-init=1 (4 requested) — the
>    #6182 scheme-handler signature confirmed ON DEVICE; NOT a hardware
>    limit. Isolated ORT (6.0 s buffer) median 434 ms vs desktop
>    352–356 ms single-threaded / 124 ms threaded — threading never
>    engaged. The intermediate rung (in-app local HTTP server, FlyingFox,
>    COOP/COEP on real HTTP responses) is now the prototyped go/no-go for
>    web-side isolation; R9 stays gated on that prototype failing.**
> 9. **DISCIPLINE LOG — corrected call (against Mohammed, logged at his
>    own ruling, 2026-07-11): he read the #11 prototype's projected RTF
>    0.51–1.01 (the assumed 2.1/4.2 s span bracket) as "single-threaded
>    is borderline viable — threading is polish, not necessity." The
>    real-span replay (deterministic controller, config-of-record, 7
>    golden clips, 1,929 decodes; method validated — projected desktop
>    streaming RTF 1.06 vs measured 1.08–1.09) shows real spans median
>    4.7 s / p90 6.0 s: 67.5% of decodes exceed the bracket's assumed
>    worst case (its "+lag" priced commit lag at 0.2 s; real commit lag
>    is 1–3 s). Real single-threaded iPhone session RTF ≈ 1.13 aggregate /
>    1.30 worst clip — over real-time on every clip. Same failure class
>    as the prior entries: a viability CONCLUSION attached to unverified
>    INPUTS under a correct formula. Threading reverts to REQUIRED;
>    ship-single-threaded is DEAD under the current span policy.**
> 10. **🚪 #11b GATE RESULT (2026-07-11, LOCAL-SERVER prototype —
>    FlyingFox in-app HTTP server, origin http://localhost:17843,
>    iPhone iOS 18.7): (a) PASSES — crossOriginIsolated=true +
>    SharedArrayBuffer=true in page AND worker scope, numThreads
>    post-init=4. The #6182 local-server route is RE-CONFIRMED on
>    modern iOS (first confirmation since the 2023 GCDWebServer
>    datapoint). (b) PARTIAL — isolated ORT 434→320 ms at 4 threads:
>    threading genuinely engages but scales ~1.35×, far below desktop's
>    2.8× (~155 ms projected). Recorded honestly: threads help on
>    iPhone, scale far worse than desktop; the 2.8×-derived RTF-0.40
>    projection is INVALIDATED. Real-span replay redone at the MEASURED
>    320 ms (same deterministic spans — replay is open-loop, cost
>    cannot alter spans): session RTF aggregate 0.832; every clip
>    under 1.0 (worst smoke114 ≈0.96, others 0.78–0.86), but above the
>    ≤0.8 device bar on 4 of 7 clips; per-decode p90 1.07 = transient
>    backlog on long spans, recoverable. VERDICT: VIABLE, NOT
>    COMFORTABLE — headroom levers: webgpu EP (#11c button added to the
>    prototype, adapter probe + forced EP, hard-fail no-fallback;
>    navigator.gpu printed PRESENT on 18.7, contradicting the public
>    WKWebView record — present-vs-functional undecided) and/or
>    span-policy trim (commit lag 1–3 s is the fat tail).**
> 11. **⚠️ #11c FIRST RUN INVALID — DISCIPLINE LOG (against Claude,
>    2026-07-11): the on-device webgpu verdict "unusable — no available
>    backend / Importing a module script failed" was a BUNDLING ERROR,
>    not a WebKit limit: ort 1.27's ort.webgpu.min.mjs imports the
>    ASYNCIFY artifact (ort-wasm-simd-threaded.asyncify.mjs/.wasm); the
>    jsep pair was shipped instead → in-worker dynamic-import 404.
>    Claude shipped the artifact pair without verifying which file the
>    entry module actually imports — the "unusable, settles the fork"
>    verdict nearly stood on an unverified path assumption; Mohammed's
>    ordered one-check rule-out caught it. Adapter (apple) WAS found:
>    WebGPU on iOS 18.7 WKWebView is OPEN, not dead. Corrected bundle
>    (import chain verified closed: webgpu.mjs → asyncify.mjs →
>    asyncify.wasm) rebuilt + synced; ONE re-run decides.**
> 12. **✂️ SPAN-TRIM STUDY (2026-07-11, real-controller reruns, 7 clips,
>    validated against the baseline replay — 0 span mismatches):
>    decomposition: span = context (frontier−anchor, med 2.88 s, hard
>    ≤4.1 ceiling) + commit lag (chunkEnd−frontier, med 1.78 s, p90
>    2.96, max 6.74 — owns the fat tail: stability flapping + tail-guard
>    holds). Variants @320 ms: A (incMaxContextS 4→3) agg 0.729, worst
>    smoke 0.840, latency-neutral, healthy tracking; B1 (holdbackS
>    0.3→0.15) agg 0.810, −0.14 s median reveal latency, near-zero
>    diffs; D (A+B1) agg 0.721, worst smoke 0.793 (<0.8!), per-decode
>    p90 0.96, median latency −0.10 s vs today; C/D2 (one-sighting
>    stability) REJECTED — fragment storms on every clip (committed
>    counts inflate +6–9; the two-sighting contract is load-bearing).
>    ADOPTION PATH (pending ruling): measure A alone through the full
>    rig first (truth ×2 modes, false-flag budgets, hesitation suite;
>    watch 02-whisper; update incremental.test.mjs seam-pin (vi) which
>    hardcodes incMax=4), then add holdbackS 0.15 → D ≈0.72. Caveat:
>    shallower context slightly fattens the stall tail (lag max 7.84 vs
>    6.74). Below 0.72 needs context floors under 1.5/3.0 or lag-tail
>    surgery — don't spend that risk before D's truth scores.**
> 13. **🎬 #11c RE-RUN RESULT — WEBGPU CLOSED FOR v1 (2026-07-11, iPhone
>    iOS 18.7, corrected asyncify bundle): WebGPU WORKS but LOSES.
>    Adapter (apple) + session created + ran: isolated ORT median
>    847 ms vs 320 ms CPU-4-threaded — 2.6× SLOWER; projects streaming
>    RTF 0.99–1.98, over real-time. Cause is workload shape (small
>    sequential encoder; per-dispatch GPU overhead exceeds the
>    CPU-threading win — expected for this class, not a bug). Tested
>    honestly on-device, genuinely slower, NOT the path; revisit on
>    iOS 26 only if the ort EP matures. FORK RESOLVED (Mohammed's
>    ruling): the path is LOCAL-SERVER (threads) + SPAN-TRIM D, CPU —
>    320 ms threaded · trimmed aggregate RTF 0.72 / worst 0.79 ·
>    ~3-generation device floor. Native R9 NOT needed. Remaining before
>    production commitment: (1) variant-D full accuracy validation
>    (truth ×2 modes, false-flag budgets, hesitation suite, seam-pin
>    update — speed number 0.72 must survive accuracy), then (2) the
>    production ruling on the 4–8 day server tail, then Gate 4.**
> 14. **❌ SPAN-TRIM D REJECTED AT THE ACCURACY GATE (2026-07-11, full
>    rig, both surfaces, baseline reproduced the plan's grid exactly
>    first — 68/68 suite green, nothing adopted, repo unchanged):
>    D (incMax 3.0 + holdback 0.15) hits RTF 0.721/worst 0.793 as
>    projected but BREAKS four binding budgets baseline holds:
>    01-clean 2→4 flags node (4→12 wasm, vs ≤2), 04-subs detection
>    P 1.00→0.20 / R 1.00→0.67, 05-skips P 1.00→0.57 (vs P≥.80/R≥.90).
>    Worst failure class: FUZZY ABSORPTION — under shallow context the
>    04 plant إمتلاق decodes as «ابتلاق» and the engine fuzzy-matches
>    it as correct: a planted substitution silently blessed. Plus
>    short-word truncation commits (ما→مَّ, جند→جن) and junk fragments
>    (وََت, lone و). A alone fails the same truth clips for less speed —
>    NOT a fallback. The 4.0-deep context hysteresis is LOAD-BEARING
>    for accuracy, exactly as the 2026-07-11 whisper diagnosis
>    suspected. CONFIG OF RECORD UNCHANGED: incMax 4.0 / holdback 0.3 /
>    stability 2 → shipping numbers revert to RTF 0.832 agg / 0.960
>    worst (device floor ~1.5 generations). Remaining headroom
>    directions (unscoped): LAG-TAIL surgery (commit lag p90 2.96 s /
>    max 6.74 s — stability flapping + tail-guard holds; parameter
>    flips there are exhausted: holdback-0 noisy, one-sighting storms)
>    and the v0.2.0 CANDIDATE MODEL A/B (cuts the 320 ms itself;
>    already priority-promoted). Salvaged data: A fixes the 03-fast
>    node breach 4→1 (datum for #15); holdback 0.15 makes the
>    06-window final-word FAIL→PASS (datum for the VAD artifact);
>    hesitation suite + final-word + smoke held everywhere under D.**
> 15. **📌 SALVAGE — TWO SEPARATE TRACKED ITEMS (ruled 2026-07-12, NOT
>    adopted, NOT part of any trim): (i) 03-FAST BREACH DATUM — incMax
>    3.0 in isolation fixed the pre-existing 03-fast node breach (4→1
>    flags); investigate what 03-specific mechanism benefits from
>    earlier re-pins WITHOUT cutting global context depth (which item
>    14 proved load-bearing). (ii) 06-WINDOW FINAL-WORD DATUM —
>    holdbackS 0.15 flipped the pre-existing 06-window final-word
>    FAIL→PASS; datum for the VAD-artifact fix, to be considered there
>    on its own merits, not as a speed trim.**
> 16. **🏭 PRODUCTION RULING (Mohammed, 2026-07-12): COMMIT THE SERVER
>    TAIL, iPhone-first. Threads required at any RTF · WebGPU closed ·
>    R9 unneeded → the work is unavoidable. Scope: (a) productionize
>    FlyingFox in the real app; (b) storage migration = SMALL DATA ONLY
>    (localStorage: notes, gharib-learned, resume, ayah-repeat, tour
>    flags, settings) via hidden-WebView export — Cache API content
>    (reciter audio, QCF4, tafsir) NOT migrated, one-time Arabic
>    re-download notice instead; migration tested on real-data fixtures
>    before ship (losing notes = the one unacceptable failure);
>    (c) isApp() fix ships in the SAME update as the origin switch;
>    (d) same-origin Documents-dir route for downloaded content;
>    (e) retire the node_modules COOP/COEP patch — server owns headers;
>    (f) full regression on real iPhone. ANDROID: separate task, Gate 6,
>    completely unmeasured (WebView COI likely absent per #4520) — do
>    NOT design the iPhone server around Android assumptions. Shipping
>    numbers: RTF 0.832 agg / 0.960 worst on A17 Pro (test device =
>    iPhone 15 Pro). Headroom queue: v0.2.0 candidate-model A/B AHEAD
>    of lag-tail surgery, AFTER the tail. Then Gate 4.**
> 17. **🐛 STAGE 4 DEVICE REGRESSION — TWO BUGS, BOTH ROOT-CAUSED + FIXED
>    (2026-07-12). Device confirmed the core objective first: origin
>    http://localhost:17843 + crossOriginIsolated=true on the real
>    iPhone. BUG 1 — AUDIO: "الاستماع غير متاح بدون إنترنت" with internet.
>    Cause: COEP require-corp blocks the app's THREE no-cors media-element
>    loads of GCS audio (app.js per-ayah, mushaf.js per-ayah, surahAudio.js
>    engine stream); GCS cannot send CORP. Compounding:
>    recitations-bucket-data had NO CORS config at all (the prototype's
>    "gcs → BLOCKED" probe was exactly this). FULL SWEEP — everything
>    else verified CLEAN by live header checks: all fetch()-path GCS
>    (tafsir, QCF4 fonts/JSONs, timings; bucket ACAO:*), Cloud Run APIs
>    (reflect the new origin), Google Fonts (sends CORP), offline audio
>    (Cache-API-fetch CORS → blob: same-origin), /_capacitor_file_ +
>    /appdata (same-origin now). ONE resource class was broken. FIX:
>    isApp()-gated crossOrigin="anonymous" set BEFORE src at the 3 sites
>    (CORS-approved loads pass require-corp; website stays byte-identical
>    no-cors) + ONE-COMMAND INFRA STEP (Mohammed): gsutil cors set
>    '[{"maxAgeSeconds":3600,"method":["GET","HEAD","OPTIONS"],
>    "origin":["*"],"responseHeader":["*"]}]' on recitations-bucket-data
>    (mirrors the tafsir bucket's proven config; permission-gated from
>    the session). Evidence: new __audioSurah/__audioAyah probes in the
>    DEBUG dump — simulator shows OK 11s / ERR code=4, the ayah probe
>    flips to OK once the bucket command runs. BUG 2 — MIGRATION IMPORT:
>    export banked 2.5 MB (ALL 1,147 keys — the tafsir:*/compare:full:*
>    localStorage caches, violating item 16b's small-data ruling) →
>    the ~3.4 MB-source import WKUserScript silently never EXECUTED on
>    device (proof: zero keys landed incl. insertion-order-early ones,
>    while the small DEBUG dump script on the SAME launch ran fine =
>    injection pipeline works, size is the differentiator; simulator
>    passed 2 MB at T4 — device ceiling sits below ~3.4 MB source).
>    FIX: 22-key allowlist (m7_notes/m7_gharib/m7_resume/m7_ayah_repeat,
>    4 UX flags, 14 settings) applied at BOTH ends — export page reads
>    only allowlisted keys; importUserScript() scope-filters any
>    already-banked fat payload in Swift AND rewrites the banked copy
>    (Mohammed's device: 2,433,483 → 664 chars, old origin stays the
>    rollback net). Excluded BY DESIGN: tafsir:*/compare:full:*,
>    content-ready flags (tafsir_ready_v2/qcf4_ready_v1/
>    m7_reciter_offline_v2 — stale "ready" without the Cache API bytes
>    would suppress re-download), m7_update_notice_ack. Import errors now
>    surface as localStorage m7MigrationImportError instead of silent
>    catch. BONUS BUG (found by the re-run suite): import script was
>    injected on FALLBACK boots too — a server-bind failure would stamp
>    m7MigrationImportedV1 onto the OLD origin and show the notice there;
>    now gated on bootingOnServerOrigin. __appdata/__capfile 404s on the
>    device dump were BENIGN: the probes fetch a file the synthetic suite
>    plants; nothing planted it on-device — 404 = route handlers alive.
>    Simulator regression (fresh-install seeded 1,145-key/2.4 MB fixture):
>    scoped export 713 chars · import lands all 22 keys byte-exact incl.
>    U+2028 · 0 cache keys migrated · notice visible · old origin 1,146
>    keys intact, unstamped · Debug AND Release builds green. REMAINING
>    FOR SHIP: (1) Mohammed runs the gsutil command, (2) device re-run of
>    the --m7-dump diag (expect __audioAyah OK + his 15 keys landed),
>    (3) publish flow incl. wrapper files per Stage 3 note.**
> 18. **🔒 ORDERING-GATE FIX + FORCE-IMPORT RECOVERY (2026-07-12, answering
>    Mohammed's Gate-4 safety question). QUESTION: is there a window where
>    a user writes to the NEW origin before the import lands? WITHIN a load
>    — no (import is .atDocumentStart, before any page JS/DOM/interaction).
>    ACROSS launches — there WAS: the export is retry-on-failure, and the
>    old code switched to the server origin EVEN when the export hadn't
>    banked yet (first-launch timeout). That session ran on empty new-origin
>    storage; every key the app writes at boot (darkMode) or the user
>    writes (a note) permanently wins over the later-migrated value under
>    never-overwrite — for m7_notes the whole map lost to one new note.
>    FIX (ships in Release, not just DEBUG): `guard isDone else return
>    descriptor` after exportIfNeeded — an un-exported launch stays on the
>    OLD origin (fully functional minus threads) and retries next launch;
>    the new origin is now UNREACHABLE without a banked payload (⟹ import
>    script present). A genuinely fresh install still switches (empty
>    export sets done=true). PROVEN on simulator: (1a) fresh install →
>    server origin, no import; (1b) two-launch — modeled export timeout
>    (--m7-fail-export) stays on capacitor://localhost with data intact +
>    NO stray m7MigrationImportedV1 stamp, then a normal launch migrates
>    all keys. Mohammed's own gharib loss is explained by the OLD broken
>    import (no session ever had a working import) crossed with an
>    accidental new-origin m7_gharib he typed — never-overwrite correctly
>    refused to clobber it. RECOVERY TOOL (DEBUG launch arg
>    --m7-force-import): overwrites every allowlisted key from the banked
>    old-origin snapshot, skipping BOTH the done-flag and never-overwrite
>    guards. Proven: reproduced his exact state (migrate → pollute gharib →
>    a plain --m7-reset-migration boot leaves the WRONG value, proving
>    reset alone can't fix it → --m7-force-import restores عجاب, notes
>    intact). CAVEAT (told to him): force reverts ALL migrated keys
>    (notes/settings/gharib) to the old snapshot — any new-origin change
>    since is replaced; his real data lives in the old snapshot so this is
>    the intended "redo migration" semantics. SIM ARTIFACT logged:
>    `simctl uninstall` does NOT clear NSUserDefaults (sim cfprefsd cache) —
>    the banked payload survived reinstall and re-imported onto a "fresh"
>    origin, invalidating an early run; true reset needs `simctl spawn
>    defaults delete`. Real-device uninstall wipes everything. Debug AND
>    Release both green with the gate + hooks.**
>
> ---
>
> **🧾 ACCOUNTING CHECK (2026-07-11, fresh window-mode runs, historical VAD —
> answered before any VAD work per Mohammed's order): window mode's standing
> vs its own pinned false-flag budgets (sub+skip counts; hes noted):**
> ```
> clip        window flags   budget   status
> 01-clean    3 (2+1)        ≤2       ❌ FAILING — was noted in baseline prose,
>                                        unflagged as a tracked item until now
> 02-whisper  2 (1+1, hes 1) ≤4       ✓
> 03-fast     2 (0+2)        ≤2       ✓ (at limit)
> 04-subs     truth-scored   P/R      (P 0.38 / R 0.60 — below binding)
> 05-skips    truth-scored   P/R      (P 0.25 / R 0.75 — below binding)
> 06-noise    2 (1+1)        ≤4       ✓ flags · ❌ final-word (VAD artifact)
> ```
> **Window-01 breach = separate tracked item, NOT folded into the VAD
> decision** (one of the 3 is the إلا/إِلاَّا dup miss — start jitter 0.1 s >
> frameS outside the post-jump zone).
> **DISCIPLINE-LOG framing (corrected per Mohammed, 2026-07-11): the 3 was
> never hidden — it appeared in the Step-1 baseline report. The miss was
> that the STATED metric was never EVALUATED against its budget: "stated
> metric never evaluated against its budget," not "untracked failure."**
>
> **WINDOW-01 DIAGNOSIS (2026-07-11, diagnosis-before-fix per standing
> practice — all three flags root-caused, evidence: flags-tool timelines +
> generous-context one-shot decodes of both flag regions):**
> 1. **sub 38:7:10 (اختلاق) — DUP-WINDOW MISS**: window mode committed
>    إلا twice (starts 47.6/47.7 — jitter 0.1 s > frameS 0.08, outside the
>    1.2 s post-jump zone where the wide 0.45 s window would have caught
>    it); the echo pair surfaces as a substitution at :10.
> 2. **sub 38:11:1 (جند) — WINDOWING-INDUCED**: streaming window mode read
>    جُنجٌ; a one-shot decode of [64–80 s] (16 s context) reads **جُندٌ
>    correctly** — same class as الخناس, sitting in an anchor-jump zone.
> 3. **skip 38:15:7 (ما) — MODEL-CLASS, irreducible at the controller**:
>    the one-shot decode with 14 s context ALSO outputs the fragment مَّ —
>    the q8 model itself mishears the reduced مَّا. Candidate-model A/B
>    territory, not windowing.
> **✅ RULING (Mohammed, 2026-07-11): CLOSED — WONTFIX-BY-DESIGN.** Window
> stays untouched; its role is reference stability, and the operative
> budget-bearer is incremental+v2, which passes at 1 ≤ 2. The three root
> causes above are the record.
> **PINNED — CANDIDATE-MODEL A/B TARGET (per the same ruling)**: cause #3
> (ما → مَّ, irreducible at 14 s context) is the SECOND data point — with
> 04/05's ASR-absorbed planted substitutions (عجاب, هؤلاء decoded as the
> reference word) — that **the q8 artifact-of-record has a recall floor no
> decode strategy can fix**. Logged as a pattern: the post-Gate-3
> candidate-model A/B (v0.2.0 promotion criteria, Gate 3 provenance block)
> now has named test targets: ما@38:15:7, عجاب@38:5:8, هؤلاء@38:15:3.
> **⛔ AMENDED 2026-07-11 (ground-truth correction, see below): عجاب and
> هؤلاء are STRUCK — the listen-back showed they were recited as
> tashkeel variants of the reference word (never model misses; the
> engine matching them was correct by design). ما stands — window-01's
> ما→مَّ, the lone short-word skip data point (05's مَّا@38:11:2 was
> DETECTED per the flags-level diagnosis; the tail-truncation family
> resurfaces on the FP side instead: يذوقوا→يذوق).**
>
> **🔬 VAD v2 FULL MEASUREMENT (2026-07-11, per the conditional approval —
> candidate: nearest-local-dip anchor snapping + strict-capped speech
> threshold `min(p10×4, 0.75·p50)`; `--vad=v2` in bench, `?vad=v2` in
> harness, policy printed in every env block; historical remains the
> default — NOT adopted, adoption is Mohammed's ruling):**
> ```
> clip        mode    flags  WER    det P/R    final  hes   vs historical same-mode
> smoke114    win-v2  3      25.0%  —          PASS   0     ❌ pinned 19/20 → 17/20
> smoke114    inc-v2  0      10.0%  —          PASS   0     = (20/20, الخناس ✓)
> 01-clean    win-v2  4      7.2%   —          PASS   0     ❌ 3→4
> 01-clean    inc-v2  1      2.9%   —          PASS   0     ✓ 2→1 (budget ≤2 MET)
> 02-whisper  win-v2  4      10.9%  —          PASS   0     ❌ 2→4 (hes 1→0 ✓)
> 02-whisper  inc-v2  3      7.2%   —          PASS*  0     ✓ 5→3 (budget ≤4 MET)
> 03-fast     win-v2  2      9.4%   —          PASS   0     = 2
> 03-fast     inc-v2  1      5.8%   —          PASS   0     ✓ 4→1 (budget ≤2 MET)
> 04-subs     win-v2  6      13.8%  0.27/0.60  PASS   0     ❌ P .38→.27
> 04-subs     inc-v2  3      5.8%   0.60/0.60  PASS   0     ✓✓ P .33→.60, FP 6→2
> 05-skips    win-v2  4      16.7%  0.43/0.75  PASS   0     ✓ P .25→.43
> 05-skips    inc-v2  4      10.9%  0.60/0.75  PASS   0     ✓✓ P .25→.60, FP 9→2
> 06-noise    win-v2  3      9.4%   —          PASS   0     ✓ traversal FIXED
> 06-noise    inc-v2  1      5.8%   —          PASS   0     ✓ traversal FIXED, 4→1
> ```
> (*02-inc-v2 final-word initially FAILED — root-caused and fixed, see the
> end-of-stream contract below; the table row is post-fix. Repetition
> acceptance PASS everywhere it applies.)
> **HESITATION INTERACTION (mandated check): all four wiring fixtures green
> in the suite (61/61 — they pin the contract with scripted VAD); hes = 0 on
> the 114 smoke under v2 in BOTH modes, and on every v2 golden run (see
> table). Bonus: v2 REMOVES 02-window's false hesitation (hes 1 → 0),
> consistent with the 90%-misclassification diagnosis.**
> **VERDICT FROM THE TABLE — v2 splits by decode mode:**
> - **v2-WINDOW: REJECTED** (dead end #3, joining strict-cap-only and
>   generous/strict-split). The pinned smoke breaks 19/20 → 17/20, and the
>   v2-window smoke is IDENTICAL to the strict-cap-only smoke — isolating
>   the damage to the strict SPEECH side changing window mode's
>   decode-gating cadence, NOT the snap policy. Window mode's baseline is
>   cadence-entangled with the historical threshold's accidental
>   decode-skipping; any VAD change under window mode moves its numbers.
> - **v2-INCREMENTAL: meets EVERY false-flag budget (01: 1≤2, 02: 3≤4,
>   03: 1≤2, 06: 1≤4), every final-word/traversal check, doubles detection
>   precision on both truth clips (04/05: P 0.60, FP 2 each — the best
>   measured by any configuration), hes 0 everywhere, RTF 0.16–0.21.**
> - **✅ ADOPTED (Mohammed, 2026-07-11): v2 is the INCREMENTAL stack's VAD —
>   the incremental config of record is now incremental+v2.** Window keeps
>   the historical VAD and its reference role; NO window budget is
>   rebaselined (the A3-style rebaseline machinery was not needed). Wired as
>   the per-mode DEFAULT in bench and harness (`--vad`/`?vad` override;
>   policy prints in every env block; suite 61/61; 02-inc re-verified on the
>   default path). The v2-inc column of the table above IS the incremental
>   config of record. Window remains reference until incremental fully
>   supersedes it on all binding surfaces.
> **END-OF-STREAM CONTRACT FIX (2026-07-11, VAD-independent, found via the
> 02-inc-v2 final-word FAIL)**: a word that passed stability + holdback but
> was held by the tail guard could be LOST at clip end — under a sensitive
> VAD, trailing room tone reads as "speech" forever (pause release never
> fires), no successor exists, and if the final decode flaps EMPTY,
> prevPending is wiped before flush. Fix: the controller remembers the
> guard-held word (`heldTail`) and `flush()` releases it when prevPending is
> empty (a startS re-check makes it a no-op if it committed normally).
> Pinned by seam fixture (vii); suite 61/61; config-of-record re-verified
> unchanged (pinned window smoke exact; historical inc 01/02 identical). Desktop-browser WASM RTF for incremental: Mohammed's harness run
> (`?decode=incremental`), projection ≈0.5–0.75 from the node ratio — the
> ≤0.3 target likely still needs stride work (separately scoped per ruling #1).
> **Mode-independent gaps (both modes, NOT windowing)**: detection P/R on
> 04/05 far below binding thresholds — recall capped by ASR-absorbed planted
> subs (see baseline note), precision by residual decode-error flags; 06
> final-word FAIL (both transcripts end at يوم — verify the recording actually
> contains الحساب audibly; possibly drowned by noise or clipped); first-event
> 3.2–3.3 s on 02/06 (quiet onset, VAD-threshold class).

*Pre-acceptance engine adds (2026-07-10):* (a) resync × refrain fixture — stall forced
inside the الرحمن refrain region; contract pinned: when the re-anchor pair matches
multiple forward instances, anchor at the NEAREST (minimal skip damage; the scan is
ascending by construction); all 13 refrain fixtures stay green. (b) waqf-aware
hesitation — the timer distinguishes position class: at ayah boundaries (pointer on the
first word of a new ayah, i.e. the reciter just closed an ayah) the grace period is
`hesitationBoundaryMs`, default 2× `hesitationMs` and constrained ≥ 2× (both
configurable). Identical pause duration fires a hint mid-ayah and NOTHING at ayah end —
pausing at waqf is correct practice, not hesitation. Protects clip 01 scoring and real
UX. Hosting: GCS
immutable hash-versioned path `tasmee/v1/<sha256-prefix-12>/model.int8.onnx` (+ vocab +
ort-wasm, same scheme); the app config carries the sha256 — full-hash verify at
download, byte-length re-verify each session start (§3/A3a).
**⛔ Fallback checkpoint: if WER or latency fails badly here, trigger the §1 Option-B
pivot discussion before building more.**

**GATE 4 — Integrated desktop demo.** Engine + worker + real rendered Mushaf page.
Accept: recite a known page → in-order reveals; deliberate mistake set produces the right
colors; ayah recited 3× produces zero mistakes; hesitation pulses + hint reveals;
**side-channel audit (A2)**: no style paints a hidden glyph (text-shadow / gharib
pseudos / text-stroke / ::selection all verified dark) and selection + long-press are
dead on hidden words; **page-boundary auto-advance works, or the v1.1 deferral is
invoked here with evidence** (§4).

> **🔧 GATE 4/5 IN PROGRESS (2026-07-12, web-first, built in pieces).**
> Interface reconnaissance settled the architecture from the BUILT code (no
> re-derivation): the engine (`createTasmeeSession({words,onEvent})`) already
> emits per-word `reveal{idx,vk,pos,verdict}` (+ insertion/repetition/
> hesitation/ayah_completed) — that IS the DOM-facing contract. The stream
> controller couples stability-gate + engine session + hesitation ticks and
> pulls audio via a `decode(startS,endS)` callback. **DECISION (deviation from
> §1's "onTokens" sketch, recorded so it isn't re-litigated): for the live app
> the engine + controller run INSIDE the worker (as the harness already does)
> and the worker posts `onEvent` out in real time; the main thread only maps
> events→DOM.** Splitting engine-to-main-thread would fight the built
> controller/session coupling for no benefit at Gate 4. Piece order:
> (1) DOM hide/reveal, scripted events — DONE; (2) real engine, scripted
> tokens; (3) mic capture + VAD meter, no model; (4) production ASR worker →
> live loop; (5) hint tap + A2 audit + suppressions + boundary decision.
>
> **✅ PIECE 1 DONE (2026-07-12): `src/tasmee-ui.js` + mushaf.css tasmee block
> + toolbar mic button (`#mushafTasmeeBtn`, shown app-only OR with ?tasmee=1
> for the web loop; feature dynamic-imported on first tap = stays dark till
> opted in). Reference index enumerates page words with the EXACT engine
> filter (type==="word", text[0]!=="#", page order); (vk,pos)→span uses
> gharib's dom-index counting verbatim so the 199 ۞ + 15 sajda span-slots
> never desync. `applyEvent()` is the seam every later piece drives.
> VERIFIED in Chrome on Al-Fatiha (dark): hide = every word `rgba(0,0,0,0)`,
> end-markers + surah header stay as anchors; scripted demo reveals in order
> with all four verdict colours (correct=ink, sub=red, skip=amber, hint=gold)
> + a 7px insertion dot; **layout-shift self-check 0/29 word rects moved**
> (the Gate 5 bar). TWO fixes found live: (a) insertion marker moved off
> ::after to a real child — gharib glow owns ::before/::after of the same
> word and was rendering a 126px circle over the dot; (b) gharib glow now
> `display:none` for the whole session — this ALSO closed an A2 leak (a
> revealed gharib word re-painted its glyph via the glow). Hidden-word glow
> was already suppressed. Dev harness `window.__tasmee` (_demo/_reset/_rects/
> _refLength) is Piece-1 scaffolding, removed once the worker drives reveals.**
>
> **✅ PIECE 1 REFINEMENTS (2026-07-12, Mohammed's review):**
> - **Skip is now an EQUAL-severity error:** both mistakes red (`--ts-err`);
>   skip adds a red strikethrough to stay distinct from substitution. Gold is
>   reserved for hints ONLY (help ≠ mistake). The amber was wrong, gone.
> - **Hint mechanic.** What existed first: `hint()` (reveal R[p]+advance) and
>   the hesitation auto-detect were built + waqf-aware (`tick()`: 8s grace at
>   an ayah boundary vs 4s mid-ayah, ≥2× enforced, one-per-stall, OFFERS via
>   event, never force-reveals); the "3× wrong at same position" trigger did
>   NOT exist. Now: (a) TAP anywhere reveals the next word (mushaf.js routes
>   taps to `handleTap` at the two gharib points, consuming them); (b)
>   AUTO-OFFER = a gentle breathing gold ring (`ts-offer`), fired by
>   hesitation OR a new engine `hint_offer` signal (onEvent-ONLY, not in
>   events[] → all 68 fixtures green; fires when consecutive unplaceable
>   attempts at a frozen pointer reach `offerThreshold`=3 — a CLOSE wrong word
>   is a substitution that advances, so only far-off attempts count as
>   "stuck"). Offer dedups per word (offer once, never nag). Reveal = whole
>   word, gold, soft glow-in. Hinted stays its own summary category.
> - **A2 SWEEP (computed-style audit, regular AND gharib hidden words):** every
>   PAINT vector already resolves transparent/none on hidden words (color,
>   -webkit-text-fill-color, -webkit-text-stroke, text-shadow, outline,
>   filter, background-clip; both gharib pseudos display:none). Closed the
>   rest: page-wide `user-select:none`, transparent `::selection` on hidden
>   words, `-webkit-touch-callout:none`, and the long-press/hover COPY menu
>   suppressed while `tasmee-on` (Copy would extract hidden text).
> - **TWO gharib-interaction bugs fixed live** (gharib's registered
>   custom-property machinery, invisible until tested on a page with learned
>   words): (1) the `color` transition STICKS mid-fade on gharib words → reveals
>   set colour instantly and fade in via an opacity ANIMATION
>   (`transition:none` on `.ts-r`); (2) gharib's settled fill pin is overridden
>   by fill-follows-colour. Verified by verdict class in Chrome:
>   correct=ink/sub=red/skip=red+strike/hint=gold on gharib words; layout-shift
>   0/29; 68/68 fixtures green; no console errors.**
>
> **✅ PIECE 1 REFINEMENTS ROUND 2 (2026-07-12, Mohammed's visual review):**
> - **"Glyph clipping" on الرحيم = the gharib freeze, THIRD sighting.** The
>   `ts-reveal-in` opacity animation (0.15→1) stuck at `currentTime:0` on
>   gharib words (base opacity correctly 1) — a 15%-opacity red glyph loses its
>   thin calligraphic tail first, reading as a cut-off word. RULE LEARNED:
>   gharib's @property registered-custom-property transitions (--gh-on/--gw-x)
>   FREEZE any time-based CSS (transition AND animation) on their words. Fix:
>   reveals are now INSTANT (no word transition/animation); the only fade is
>   the one-time HIDE. Verified sub opacity 1 on a gharib word.
> - **Strikethrough REJECTED (fights calligraphy). Mohammed's pick: SKIP =
>   'under'** — a red dotted underline dropped clear of the glyph (the other
>   two proposed options, 'bg' red-wash and 'faint' ghosted-red, are removed
>   from shipping code, kept here as record). Descender safety (his flagged
>   risk) VERIFIED by canvas ink-metrics: QCF4 ink descends to ~0.53em below
>   baseline, so the underline sits at **0.62em** (below the ink — a clean
>   solid line, ~3.5px gap at 31.5px font) with **`text-decoration-skip-ink:
>   auto`** as the hard universal guarantee (on any deeper-descender word the
>   browser breaks the line around the ink rather than crossing it — never
>   touches the calligraphy). 0.28em was cutting straight through descenders.
> - **Square hint glow → organic bloom.** The offer was a box-shadow on a
>   `border-radius:6px` box (rounded rect). Replaced BOTH offer and hint with a
>   real CHILD element `.ts-glow` (immune to the gharib freeze, like the
>   insertion dot): soft radial-gradient blobs (negative inset + blur)
>   radiating past the word, gold, inspired by the مختصر beam-bloom. Hint =
>   one-shot bloom (self-removes 1.3s); offer = gentle breathing. Dropped
>   `will-change` — with `filter:blur` it forced a per-frame re-rasterized
>   layer that FROZE the renderer.
> - Re-verified on the real Al-Fatiha (gharib present): layout-shift 0/29,
>   verdict colours correct on gharib words, A2 intact (hidden color +
>   ::selection transparent, gharib pseudos display:none). NOTE: CDP
>   screenshots time out on this QCF4 page (renderer never idles under
>   gharib's animations) — verification is by computed-style/rect JS, and
>   Mohammed views live via `?tasmee=1` + `__tasmee` console helpers.**
>
> **✅ PIECE 2 DONE (2026-07-13): the REAL engine drives the UI, no audio.**
> `tasmee-ui.js` now builds ONE unified reference `{vk,pos,span,form}` (form
> from `public/tasmee-words.json`, fallback tasmeeNorm(QCF4 text)) in the
> engine's §2.1 order, so `createTasmeeSession({words, onEvent: applyEvent})`
> maps `reveal{idx}` 1:1 to `ref[idx].span`. `enter()` is now async (awaits
> the cached dataset); the mic-button handler awaits it. Script-recite API
> (this is the exact path the Piece-4 worker will use — it calls the same
> `session.feedToken`): `recite(text)`, `reciteAyah(vk,times)`,
> `recitePage()`, `pause(sec)` (ticks the hesitation clock → offer),
> `finish()` (stop+flush), `_reset()` (fresh engine). VERIFIED in Chrome on
> Al-Fatiha: perfect recite → 29/29 correct 100%; **reciteAyah('1:1',3) →
> repetitions:8, substituted:0, skipped:0 — the differentiator HOLDS in the
> real UI**; one wrong word → exactly 1 substitution flagged at 1:2, 0 false
> skips; corroborated omission → skip flagged with the dotted underline;
> DOM idx alignment exact; no console errors. TWO correct-by-design behaviours
> confirmed (not bugs): reciting a mid-page ayah from a fresh session skips
> the earlier ayahs; and the engine won't invent a skip it can't corroborate
> (end-of-input) or one that reads as a word-merge (رب+العالمين → merged-match
> accepts) — it errs toward not flagging. Next: Piece 3 (mic capture + VAD),
> then Piece 4 (ASR worker → live loop).**
>
> **✅ PIECE 1 REFINEMENTS ROUND 3 (2026-07-13, Mohammed's visual review;
> verified by ACTUALLY LOOKING — CDP screenshots work again after a fresh
> reload, the earlier timeouts were accumulated blur-layer GPU state; capture
> EARLY before it builds):**
> - **Skip underline redrawn.** text-decoration gave uneven, clipped dots at a
>   fixed em offset. Replaced with a child SVG (`.ts-skip-line`): a horizontal
>   line with `stroke-dasharray:"0.01 <spacing>"` + `stroke-linecap:round` so
>   every dot is a full circle (round cap on a zero-length dash), evenly
>   spaced, never clipped. Positioned per-word from canvas ink metrics —
>   `top = baseline + actualBoundingBoxDescent + gap` — so it hugs each word's
>   real ink instead of floating. Verified on screen: even round dots below
>   بسم الله الرحمن الرحيم.
> - **Hint bloom now echoes the word.** The generic radial blob read as a UI
>   box behind the text. Replaced (for the HINT only) with a blurred, gold
>   duplicate of the word's OWN glyph (`.ts-bloom-hint`: a child <span>, glyph
>   + font-family copied from the word, `-webkit-text-fill-color` gold, blur
>   9px, blooms scale 0.85→1.28→1.42 while fading). The blur abstracts the
>   glyph into a soft cloud that follows the word's silhouette → the word
>   itself appears to glow. Verified on screen behind الرحمن: a soft gold aura
>   shaped like the word. The OFFER glow stays the GENERIC blob (it sits on a
>   still-hidden word — a glyph echo would leak the answer; A2). Both are
>   child elements → immune to the gharib freeze (bloom animation confirmed
>   `advancing:true`, not stuck). Layout-shift still 0/29.**
>
> **✅ PIECE 1 REFINEMENTS ROUND 4 (2026-07-13, Mohammed's visual review +
> two design rulings):**
> - **Skip dots → sparse + STATIC.** Per-word adaptive offset REVERTED — the
>   stepping looked worse than a clean constant line (his call). Now one fixed
>   0.6em-below-baseline height for every word (clears the deepest ~0.53em
>   descender), and spacing widened (px·0.44) for fewer, calmer dots.
>   Confirmed on screen: a single even dotted line under بسم الله الرحمن الرحيم.
> - **A2 OVERRIDE — offer now shows the WORD-SHAPED cloud (ruling, do not
>   re-litigate):** the pulse on a stuck hidden word is no longer a generic
>   blob; it is the blurred gold echo of the actual glyph (word stays
>   transparent underneath). Rationale: the blurred silhouette is too abstract
>   to read the word from, AND a hint is SUPPOSED to give something away — if
>   the shape jogs the memory, the feature worked; if not, they tap for the
>   full reveal. The blur IS the hint's gentleness. So non-offered hidden
>   words still never leak; the offered one intentionally shows a soft hint.
> - **ONE CONTINUOUS "help cloud", four states** (`.ts-cloud`, a child glyph
>   duplicate — gharib-freeze-safe): (offer) breathing over the hidden word →
>   (a) TAP = hint taken → `--bloom`, word reveals GOLD, engine logs *hinted*
>   ("needed help"); (b) RECITED CORRECTLY on their own = **`--part`**: the
>   cloud dissipates OUTWARD uncovering the word in NORMAL CORRECT INK — an
>   earned reveal, engine logs *correct* = FULL CREDIT, NOT a hint; (c) wrong
>   word → `--out` (fade) + red; (d) moved on → fades. The (a)/(b) split is
>   the point: taking a hint vs being nudged and getting it yourself score and
>   feel different. No engine change needed — the verdict (hinted vs correct)
>   already distinguishes them; the UI just animates on it. Verified: offered+
>   correct → correct-ink + `--part`; offered+hinted → gold + `--bloom`.
> - **ن-CLIP FIX — 5th sighting, root-caused from OUR history (gharib), not
>   re-derived.** The glyph-duplicate cloud's filter layer clips to the
>   BORDER-BOX; QCF4's final ـن bowl overflows the advance width ~1.33em, so
>   inset:0 sliced it. Fix = the exact gharib solution (mushaf.css ~3712):
>   `box-sizing:border-box; inset:-2em; padding:2em` grows the box outward and
>   re-aligns the glyph. Applies to EVERY cloud state (shared element).
>   PROVEN two ways: geometrically the cloud box extends **2.54em (80px) past
>   the word's left edge** > the 1.33em overhang → cannot clip; and visually
>   (full screenshot, الرحمن) the ن bowl's gold glow is complete, no hard cut.
>   NOTE: this clip is INTERMITTENT (gharib's own comment: "occasionally,
>   during scroll / layer promotion"), so a static frame can't always
>   reproduce it — the geometric guarantee is the real proof. Saved to memory
>   [[gharib-word-css-animation-freeze]] companion.
> - Cloud tuned to read as a word (blur 7px, breathe opacity 0.48→0.82) so the
>   silhouette can jog memory while staying soft/premium.
> - SCREENSHOT INFRA NOTE: CDP capture degrades over a long session (blur
>   layers) and zoom-region coords broke on a DPR-2.5 tab; full screenshots on
>   a FRESH tab remain reliable. Verified by looking, per Mohammed's standing
>   rule after two premature "fixed" calls on this bug class.**
>
> **✅ PIECE 1 REFINEMENTS ROUND 5 (2026-07-13, two bugs — one platform-critical):**
> - **BUG 1 (offer never appeared): NOT a bug — demo timing.** `pause(6)` after a
>   full ayah leaves the pointer at an ayah BOUNDARY, where the waqf grace is
>   `hesitationBoundaryMs`=8s, so 6s never fired. Verified in WebKit: recite
>   mid-ayah + `pause(5)` (mid grace 4s) DOES fire the offer → cloud appears →
>   reciting the word correctly resolves it to `--part` (correct ink). Direct
>   viewer for judging the offer visual: `__tasmee.offerHint(N)`.
> - **BUG 2 (ن clip is WebKit-only) — THE ONE THAT MATTERED. Root-caused,
>   fixed, verified ON WEBKIT.** iOS ships WKWebView=WebKit; I'd verified only
>   in Chrome. **Pixel-measured in Playwright headless WebKit** (a background
>   session can't `screencapture`, but Playwright `webkit` renders + screenshots
>   fine): reference ن tail reaches x=207; **EVERY CSS-`filter` approach clips
>   to x=1000** — `inset:0`, the inset:-2em/padding:2em box-grow, +overflow,
>   +box-shadow:0 0 0 3em layer-reserve, the FULL gharib translateZ+box-shadow
>   approach, and `-webkit-filter`. So the "gharib fix" is **Blink-only, and
>   gharib's own glow is CLIPPED in Safari — a latent bug in the LIVE app**
>   (its "device-confirmed 0% clip" note is wrong for current WebKit; flagged
>   to Mohammed, not yet fixed — separate scope). Two things DO work in WebKit:
>   SVG `feGaussianBlur` (explicit filter region, x=227) and **CANVAS** (x=227).
>   ADOPTED: the help-cloud is now a `<canvas>` (`makeCloud` draws the glyph at
>   the word's exact pixel position on a ~2.4em-margined bitmap with internal
>   `ctx.shadowBlur` — no DOM filter layer to clip). VERIFIED WebKit: cloud
>   ن-tail x=282 vs true x=276 = **6px (the blur softness), full tail**; breathe
>   animation advances (382ms, not gharib-frozen); got-it→part gives correct
>   ink + parting cloud. VERIFIED Chrome: glyph fully rendered, animation runs.
> - **NEW STANDING WORKFLOW: verify every visual fix in Safari/WebKit, not
>   Chrome.** Playwright `webkit` (installed in the job tmp) is the headless
>   WebKit harness usable from a background session. Chrome is convenience;
>   WebKit is the ship target. Memory [[gharib-word-css-animation-freeze]]
>   corrected — the box-grow "fix" it documented is Chrome-only.**
>
> **✅ PIECE 1 REFINEMENTS ROUND 6 (2026-07-13, Mohammed's ruling): help cloud
> REVERTED to the generic radial blob.** The word-shaped glyph-duplicate is
> dropped entirely (both the CSS-filter and the canvas versions) — it cost 5
> ن-clip sightings + a canvas rewrite, and the blob reads better anyway. The
> **A2-override ruling (offer shows the word shape) is WITHDRAWN — moot**, the
> blob shows no silhouette. `makeCloud` now returns a child `<i>` with a soft
> gold radial-gradient (`--ts-glow-a/b`) + `filter:blur(5px)`; the state
> machine is UNCHANGED (offer breathe · hint-taken `--bloom` gold · got-it
> `--part` correct-ink+full-credit · `--out` dismiss). WebKit filter-clip does
> NOT apply (verified): the gradient is transparent at the box edge, so the
> border-box clip cuts only transparent pixels — the blob renders soft and
> whole. VERIFIED in WebKit (Playwright): blob is a generic `<i>` radial
> gradient (no glyph text), breathe animation advances (382ms, gharib-freeze-
> safe), got-it→`--part`+ink and hint→`--bloom`+gold both fire; screenshot
> shows a soft round glow, no clip. `--ts-bloom` var removed (glyph-echo only).
> The QCF4 glyph-duplicate clip finding stands for gharib (still a latent
> Safari bug in the live app; Mohammed to decide separately).**
>
> **✅ PIECE 1 REFINEMENTS ROUND 7 (2026-07-13, three issues — all WebKit-verified
> via Playwright):**
> - **Blob geometry:** now SIZED + CENTERED on the word's own box (measured in
>   makeCloud: `width=W*1.12, height=H*0.78`, centred), so a wide word gets a
>   wide cloud, a short one a compact cloud, over the word — not a big
>   off-centre lamp. WebKit-measured: word 45×58 → blob 49×44, centre offset
>   (0,0). Breathe slowed to 3.4s, scale 0.98–1.035 (calm, not a pulsing lamp).
> - **Offer-click bug FIXED.** `handleTap → hint()` was revealing
>   `nextExpectedIdx()` (the first hidden word) instead of the OFFERED word, so
>   a dev `offerHint(2)` at pointer 0 revealed word 0 and stacked clouds. Now
>   handleTap finds the active-offer word (has a cloud, not revealed) and
>   resolves THAT word; `hint()` routes through `session.hint()` when the word
>   is the engine pointer so the engine advances in lockstep. WebKit-verified:
>   tap offered word 2 → word 2 gold, word 0 stays hidden, 1 cloud, engine
>   advances (next recite lands at idx 3).
> - **ن clip — RESOLVED BY THE ROUND-6 REVERT, not a new fix.** With the
>   glyph-duplicate gone, NOTHING renders a filtered glyph in tasmee: the blob
>   is a gradient (no glyph), a revealed word is a plain DOM glyph (no filter),
>   gharib pseudos are `display:none`. WebKit: zero clip sources on a revealed
>   word or any ancestor; screenshot shows الرحمن's ن bowl COMPLETE. The clip
>   REQUIRES a filtered glyph duplicate — none remains — so no engine (incl.
>   real Safari) can clip it now; the structural guarantee, not an
>   engine-specific render. **Could NOT drive real Safari from this background
>   session** (`osascript … do JavaScript` → AppleEvent timeout: the automation
>   TCC dialog can't be clicked headlessly; `screencapture` has no display).
>   Playwright `webkit` is the real WebKit engine and is the verification of
>   record; if Mohammed still sees a clipped ن after a hard reload it is NOT
>   tasmee (likely the gharib glow, the separate live-app Safari bug) — needs
>   him to name the exact word. To enable real-Safari automation next time:
>   Safari ▸ Develop ▸ "Allow JavaScript from Apple Events" + grant the
>   automation prompt once.**

> **✅ GHARIB ن-CLIP — REAL ROOT CAUSE FOUND + FIXED, CONFIRMED IN MOHAMMED'S
> SAFARI (2026-07-13).** The round-7 "no filtered glyph remains → structurally
> can't clip" conclusion was CORRECT for tasmee but MISSED the real bug: the
> **gharib glow itself** clips in desktop Safari 26 (Mohammed's screenshot: ن
> tail glow sliced at a hard box edge). Headless AND headed Playwright WebKit
> 26.5, and the iOS 26.5 Simulator (real GPU), all render it CORRECTLY — the
> clip is a Safari.app GPU-compositing behaviour none of my tools reproduce.
> **The bug was a RESERVE-SIZING error, not the mechanism (no canvas/SVG
> needed — SVG measurably regressed the tail glow).** The `::before`/`::after`/
> app-`box-shadow` reserves (`1em`/`2em`) were sized for the halo SPREAD
> (~0.85em); but the QCF4 glyph INK overhangs its box — a word-final ـن tail
> reaches **~1.64em** left (measured `ctx.measureText().actualBoundingBoxLeft`
> on U+F102). When Safari promotes the layer it clips to box+reserve, slicing
> the tail. Fix: **all three reserves → `4em`** (covers 1.64em tail + 0.85em
> glow). Regression-diff (headed WebKit, pre/post) ≈ 0. **Mohammed confirmed
> FIXED in real Safari.** Mohammed's tell — gharib (has reserve) "larger but
> not complete" vs tasmee (no reserve) "much cutted" — proved the clip respects
> the reserve. **GENERALIZED STANDING RULE: any element that glows/filters/
> composites behind or as a word must size its reserve for the glyph's INK
> overhang (measure it), not the effect's spread. Record every such element.**

> **✅ TASMEE REVEALED WORD — SAME CLIP, FIXED (2026-07-13).** Tasmee sets the
> gharib glow pseudos `display:none` (A2) — and those pseudos carried the
> reserve, so a revealed gharib word had NONE → its ن ink clipped hardest
> ("much cutted"). Can't grow an inline word's border-box with padding (shifts
> layout), so reserve on the WORD like the gharib app path:
> `.mushaf-page--tasmee .gharib-word.ts-r { transform: translateZ(0);
> box-shadow: 0 0 0 4em transparent }`. Verified no-regression in WebKit
> (reveal ink + verdict colours intact; box-shadow 126px = 4em applied);
> Mohammed to confirm the clip-fix in Safari.

> **✅ PIECE 3 DONE (2026-07-13): mic capture + live level/VAD meter, no model.**
> - `public/tasmee-audio-worklet.js` — AudioWorkletProcessor `tasmee-capture`:
>   captures mono at the hardware rate (`sampleRate`, ~48k — NEVER a 16k
>   context, §0.4), windowed-sinc (33-tap Blackman, 7.6k cutoff) resample to
>   **16 kHz mono Float32**, RMS+peak, posts `{pcm,rms,peak}` 512-sample
>   (32 ms) chunks. No per-quantum allocation (compacting buffer + copyWithin).
>   *Piece-4 TODO: pin the kernel to the offline-harness FIR for A4 parity.*
> - `src/tasmee-audio.js` — `createMic({onChunk,onLevel,onState})`: getUserMedia
>   (`echoCancellation/noiseSuppression/autoGainControl` on, mono) → hardware-
>   rate AudioContext → worklet; RMS-gated VAD with hysteresis (ON 0.012 / OFF
>   0.006 on smoothed level); graceful error states (NotAllowed/NotFound/etc.).
> - `src/tasmee-ui.js` — floating meter panel (`.ts-mic`): mic toggle + L→R
>   level bar (`--lvl`) + peak tick (`--peak`) + Arabic state line; green + glow
>   on VAD "speaking". Shown on `enter()` (idle "اضغط للاستماع"); torn down in
>   `exit()`. `onChunk` counts chunks now, forwards to the worker in Piece 4.
> - CSS: `.ts-mic*` block in mushaf.css (light+dark, reduced-motion, freeze-safe
>   — plain panel, not a gharib word).
> - **Verified:** Chromium fake-mic → `listening`, **31 chunks/s = 512 @16 kHz**
>   (resampler rate exact), meter reacts, 0 errors. WebKit (ship target): module
>   loads clean, meter appears idle on enter, worklet served 200. Real-voice
>   capture Mohammed CONFIRMED in Safari (bar responds, calm in silence, VAD
>   latch correct, thresholds fine — no tuning).

> **🟡 PIECE 4 MILESTONE (2026-07-13): the ONNX model RUNS IN-BROWSER + decode
> parity proven. Streaming wire is the remaining last mile.**
> - `src/tasmee-worker.js` (new) — Vite ES module worker: `onnxruntime-web/wasm`
>   (WASM-only, numThreads=1 → no SharedArrayBuffer/COEP) + the SHARED
>   `tasmee-pipeline.js` (resampleTo16k / melFrontend / makeGreedyDecoder). Loads
>   `models/tasmee/fastconformer_ar_ctc_q8.onnx` (131 MB, MEL input
>   audio_signal[1,80,T]+length → logprobs[1,T,1025]); auto-probes raw-vs-mel.
> - **ort-web-in-Vite gotcha SOLVED** (memory `onnxruntime-web-vite-worker`):
>   Vite dev rewrites ORT's dynamic `.mjs` glue import with `?import` → fails.
>   Fix: fetch the glue text, hand ORT a **blob: URL** for `mjs` (invisible to
>   Vite) + a static URL for `wasm`. `optimizeDeps.include:["onnxruntime-web/wasm"]`
>   + `worker.format:"es"` in vite.config.js. Dev serving: `public/ort/*` (copied)
>   + `public/models/tasmee/*.onnx` (symlink), both git-ignored (ship = on-device
>   download).
> - **Verified BOTH engines:** model loads Chromium 846 ms / WebKit 619 ms;
>   warmup ~100 ms. **Decode parity browser (ort-web) ≡ node (ort-node)** on
>   golden 01-clean-p453: 139/139 words, identical skeleton, 2–3 diacritics flip
>   (native-vs-WASM numerics) → **0 mismatches after tasmeeNorm** (matching is
>   exact). Reusing the one `tasmee-pipeline.js` in worker+bench IS the parity.
> - **RTF caveat:** the ~0.088 measured is a WHOLE-CLIP single pass, NOT the
>   streaming figure. Live streaming's windowed re-decode → single-thread RTF
>   ~1.13 (#11 go/no-go) over real-time on device; threaded ~0.40. **The
>   streaming wire must use the decided perf path (incremental decode mode /
>   threading rung), not naive window-mode single-thread.**
> - **STILL TODO (Piece 4 last mile):** move engine + `createStreamController`
>   INTO the worker (controller's sync `session.getEvents()` needs co-location),
>   fed by live audio from main (mic `onChunk` → post raw 48 k → worker
>   accumulate → incremental resample + VAD rebuild → `ctl.step()`), worker posts
>   engine events → main `applyEvent` → DOM reveals. Then live recite → reveals.

> **✅ PIECE 4 COMPLETE (2026-07-13): live streaming wired — VOICE → REVEALS.**
> - Worker co-locates the engine + `createStreamController({mode:"incremental",
>   incContextS:1.5, incEdgeGuardS:0.2, chunkS:0.3, holdbackS:0.3})` (config-of-
>   record) fed by live audio; posts engine events → main `applyEvent` → DOM.
> - Audio path rebuilt for parity: `tasmee-audio-worklet.js` now forwards RAW
>   48 kHz (was resampling to 16 k in Piece 3); the WORKER resamples via a new
>   `makeStreamResampler16k()` that shares `fir16kTaps()` with the bench's
>   `resampleTo16k` — ONE kernel → streaming keeps the decode parity. VAD rebuilt
>   (`policy:"v2"`) on the growing pcm each 0.3 s step. `tasmee-audio.js` requests
>   a 48 kHz context. `startListening()` (the mic-meter button) = spawn worker
>   (load model + arm engine on this page's ref) → mic → feed raw 48 k → reveals.
> - **ADAPTIVE threads (never hardcoded):** `numThreads = crossOriginIsolated ?
>   min(4,cores) : 1`. Added `COOP: same-origin` + `COEP: require-corp` to vite
>   dev `server.headers` → **BOTH Chrome AND WebKit crossOriginIsolated → threads=4**
>   (matches the in-app FlyingFox path). ⚠️ MUST be **require-corp, NOT
>   credentialless** — WebKit/Safari (ship target) does not isolate for
>   credentialless (confirms this plan's §"credentialless needs newer WebKit"
>   note); Chrome does, which masked it. QCF4 assets are same-origin on web
>   (`getQCF4Base()===""`) so require-corp doesn't break the mushaf; on the tasmee
>   page ZERO blocked requests (Fatiha, all same-origin) — only lazy cross-origin
>   extras (Google-Fonts panels, tafsir/audio GCS) would block, outside the recite
>   path. Verified WebKit + Chrome: crossOriginIsolated=true, numThreads=4.
> - **VERIFIED vs the offline bench** (`_streamWav` golden 01-clean-p453, page
>   453 ref 38:1→38:16): DOM reveals **136 correct / 2 skip / 0 sub — EXACT match
>   to the bench (WER 3.6%)**, in **BOTH Chromium AND WebKit**. Live mic path
>   (fake-mic) error-free, 31 blocks/s raw-48k → worker. **RTF: 1.02
>   single-thread (Playwright WebKit / non-isolated) → 0.44 threaded (dev COI /
>   the app).** Real-voice on Mac is Mohammed's to try; the app path is the
>   device-verified threaded one.

> **🔴 OPEN — LIVE-MIC ACCURACY (2026-07-13, where a fresh session RESUMES).**
> Mohammed recited into it (Safari, threaded, keeps up) and hit accuracy problems
> that are diagnostically opposite: **(1) false skips** (correct words flagged
> skipped), **(2) missed mistakes** (wrong words pass as correct), **(3) phantom
> insertions** (red dots). All three = ONE cause: **the ASR is MISHEARING LIVE
> VOICE**. Critical gap: ALL accuracy validation was on the RECORDED golden clips;
> **live mic (gain, echo-cancel, noise-suppress, AGC, real-time chunking) was NEVER
> validated.** Rule from Mohammed: **DIAGNOSE BEFORE TUNING — do not touch the
> engine's matching rules until the transcript is confirmed.**
> - **DIAGNOSTIC TOOLING BUILT (this turn, not yet used by Mohammed):**
>   (a) **live raw-ASR transcript** — `src/tasmee-worker.js` wraps `feedToken` →
>   posts `{type:"transcript"}` → `tasmee-ui.js` `onHeard()` logs `[tasmee ASR] …`
>   + shows a `.ts-heard` overlay in the mic meter; `__tasmee._transcript()` = full.
>   (b) **mic processing OFF** — `tasmee-audio.js` `AUDIO_PROCESSING=false`
>   (echoCancellation/noiseSuppression/autoGainControl off) to match the golden
>   clips; flip the const to A/B. (c) **session recording** —
>   `__tasmee._downloadRecording()` saves the exact 48k the model heard → run
>   `node scripts/tasmee-bench.mjs <wav> --page N --decode=incremental`.
> - **RULED OUT:** the live streaming resampler is **byte-identical** to the
>   bench's `resampleTo16k` (0/1.75M samples differ) — resample is NOT the cause.
>   Transcript viewer validated on a recording (An-Nas transcribed correctly).
> - **NEXT (resume here):** Mohammed recites → reads the transcript vs what he said.
>   Garbage transcript → audio/mic/room (record → bench: if bench ALSO mishears the
>   recording, it's the audio; if bench is right, it's a live-path diff = VAD
>   gating word edges / streaming timing). Then fix the RIGHT layer. Ranked
>   hypotheses: (1) call-processing distortion [now off — first retest tests it],
>   (2) mic/room, (3) VAD trimming word starts/ends.
> - **DEFERRED (Mohammed, until accuracy is right):** mistake sounds + animations.

> **▶ RESUME MECHANICS (dev env, 2026-07-13 — all tasmee work is on branch
> `tasmee-wip` @ github.com/m7mdiyat/Quran, pushed).** A fresh clone/pull of
> `tasmee-wip` is missing three GIT-IGNORED things it needs:
> 1. **Model** — `models/tasmee/fastconformer_ar_ctc_q8.onnx` (131 MB, MEL input)
>    + `models/tasmee/vocab.json` + `checksums.txt`. Restore from GCS or re-export
>    (`scripts/tasmee-export-model.py`; provenance pinned in this plan's Gate-3 §).
> 2. **Dev serving of model + ORT wasm** (served from `public/`, git-ignored):
>    `mkdir -p public/ort public/models/tasmee`;
>    `cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.{wasm,mjs} public/ort/`;
>    `ln -sf ../../../models/tasmee/fastconformer_ar_ctc_q8.onnx public/models/tasmee/`;
>    `cp models/tasmee/vocab.json public/models/tasmee/`.
> 3. **Golden WAVs** — `tests/**/*.wav` git-ignored (voice recordings → GCS);
>    restore to run the bench. Truth JSONs + tests are committed.
> Then `npm ci` → `npm run dev` (vite.config.js already has COOP/COEP require-corp
> for threads + optimizeDeps + worker.format es) → `localhost:5173/read/ayah/1/1?tasmee=1`
> → enter tasmee → tap the mic. **Nothing BREAKS on npm install** — the app runs; the
> tasmee worker's model fetch just 404s until steps 1–2, and the bench needs step 3.

> **🟢 AMENDMENT CHANNEL SHIPPED TO tasmee-wip (2026-07-16, commits
> b3de2d1..67300cf — where a fresh session RESUMES).** The live-mic
> false-skip root cause (per-window readings flap → marginal commit →
> later correct re-decodes structurally discarded at the pending filter)
> is fixed by a post-commit AMENDMENT CHANNEL:
> - **Controller (tasmee-stream.js)**: settled re-readings of committed
>   spans vote ACCUMULATIVELY per reading across the anchor horizon
>   (64-record cost backstop); a reading amends at 2 sightings AND
>   outnumbering both the current reading's reconfirmations and every
>   rival; CTC-spike (zero-width) records matched by point-containment;
>   `.amendTexts` aside (dup-suppression byte-identical); once anything
>   amended, EVERY later commit re-reconciles (resync-vs-amend
>   semantics). Reference structurally unreachable where readings form.
> - **Engine**: `reverdict`/`applyReverdict` — shadow replay of the
>   amended transcript through the SAME matcher; hinted frozen; no
>   re-feeds (repetition tolerance intact). **IMPROVE-ONLY default**
>   (measured ruling: symmetric worsening broke binding budgets —
>   02-whisper 0→10 flags from degraded deep-window re-readings that
>   stabilize twice; worsening now emits `amend_evidence`, applied only
>   under `amendApplyWorsen:true` — future strict/repair mode).
> - **UI deferral**: correct reveals instant; flags held (blatant subs
>   sim≤0.5 → 0.5 s, else capS 2.0 s; insertion dots capS); amendments
>   cancel held flags pre-paint; flush at stop. Config:
>   `TASMEE_LIVE.flagDefer` + `controller.amend`.
> - **GATES**: fixtures 79/79 (11 new amend fixtures). Full rig BOTH
>   surfaces: every binding budget holds AND the standing #15 breaches
>   are FIXED (01-wasm 4→1, 03-wasm 3→1, 03-node 4→0); 04/05 P/R
>   1.00/1.00 (= --no-amend baseline; leniency guard intact); 05-wasm P
>   .57 residual (was .50). RTF/p50 within noise; zero extra inference.
>   Live-faithful lab (permanent `scoreLive`, trace-replay promoted;
>   frozen replay = logprob-inspection only): founder-47:4 منا false
>   skip RESOLVED (amend lag 1.8 s); ayoub 47:4 بعد+فضرب resolved; ayoub
>   منا correctly still fails (Class-B honesty); correct-pile flags ≤
>   baseline everywhere; exact-heard (de-fuzz) never decreased.
> - **⚠ OPEN #A1 (next design decision, stop-and-present)**: per-word
>   argmax time-overlap ASSIGNMENT cross-binds neighboring re-readings
>   under CTC time volatility (page traces: الله→سبيل class) — harmless
>   to verdicts under improve-only (all gates hold) but starves marginal
>   amendments per thread-context: **the founder منا amendment lands on
>   the lab surface + wide-ref worker capture but NOT reliably on the
>   live page** (span still ts-skip there). Candidates: (a) monotonic
>   DTW-lite global assignment [recommended], (b) relatedness-gated
>   hybrid (kills junk→correct amendments — probably wrong).
>
> **🔬 MISSED-MISTAKES AUTOPSY (2026-07-16/17, founder live-tested:
> subtle planted mistakes pass as correct — bench and reality tested
> DIFFERENT CLASSES, no fidelity gap):** golden 04/05 ingested to the
> live-faithful surface → all 7 historic plants caught there too. The
> smoking gun: plant إمتلاق↔اختلاق simIfFaithful **0.833 → would have
> PASSED**; it was caught only because the ASR mangled it to «الاق»
> (0.667). VERIFIED BY CONSTRUCTION: harakat-only changes are INVISIBLE
> (tasmeeNorm strips diacritics → sim 1.0 always); single-letter changes
> PASS at ≥4 skeleton letters (sim=1−1/L ≥ θ 0.75). θ SWEEP (551
> correct-word hearings vs 7 plants): 96.7% of correct words heard
> skeleton-EXACT (amendment channel raised this) → θ 0.80 costs 3 FF
> (0.5%), 0.85 → 13 (2.4%), even 1.00 → 18 (3.3%) on this corpus (quiet
> founder mic will be worse — unpriced). TASHKEEL: 94/139 words (68%)
> decode with MULTIPLE diacritizations across windows on CORRECT
> recitation → text-level harakat strictness DEAD; harakat mode = the
> acoustic verifier (Stage-B fingerprint; logprob ring + machinery
> already in place). FIX ORDER (proposed, awaiting ruling): (1)
> length-tiered θ tightening ≈0.85 through the full rig, (2) acoustic
> verifier for the non-exact band + harakat, (3) amendApplyWorsen strict
> mode re-gated. **AWAITING: founder mistakes-A.wav (letter swaps) +
> mistakes-B.wav (harakat + skips) + written manifests — the autopsy
> driver is ready (scratchpad run-autopsy.mjs pattern; goldens 04/05
> live in the lab corpus as labeled mistake clips). NOTE: the lab's
> IndexedDB corpus lives in an EPHEMERAL Playwright profile under the
> session scratchpad — clips re-ingest automatically from committed
> WAV sources; founder WAVs are in ~/Downloads (NOT committed).**

**GATE 5 — Mushaf UI integration.** Mode lifecycle, hide/reveal CSS, summary sheet,
settings, suppressions (gharib/menu/audio/swipe). Accept: zero layout shift on
hide/reveal (word rects identical — you verify in dev console; no automated browser run
per the no-auto-verification rule); dark mode + fullscreen correct; build-check passes.

**GATE 6 — Android app.** Manifest `RECORD_AUDIO`; download via tasmee channel (+ row in
offline panel `src/offline-panel.js`); capability probe + adaptive stride. Accept (on your
device): permission prompt flows; download survives kill/retry with verified puts; RTF
≤ 0.8 sustained 5 min; reveal p50 ≤ 2.5 s; backgrounding auto-pauses and resumes cleanly;
battery drain over a 10-min session measured and judged acceptable by you.
**PINNED (2026-07-10, from the iOS autorun finding — applies to Gate 4 integration and
both app gates): worker spawn AND ORT session init happen ON or AFTER the mic-tap
gesture path, never at page/app load.** iOS Safari defers/suspends heavy module workers
spawned at script-evaluation time; load-time init is a hazard regardless of its exact
mechanism.

**GATE 7 — iOS app.** `NSMicrophoneUsageDescription`; verify getUserMedia prompt in
WKWebView (Capacitor 8 auto-grant path); AVAudioSession sanity with reciter playback
before/after; memory: full-page session on your iPhone with no jetsam (Xcode gauge);
non-SIMD fallback measured on iOS 15.x if such a device exists, else gate SIMD-only.
**CC-BY-4.0 attribution line for the FastConformer model added to the app credits (A3b —
checklist item here, not GATE 8).** TestFlight build (remember: TestFlight = committed
code only).

**GATE 8 — Polish + beta ship.** History store, coachmark, Arabic copy review, «تجريبي»
tag on the button, README/CLAUDE.md notes. Ship order per §9 D2: web validation flag →
Android public beta → iOS last.

Rollback at any gate = feature stays dark (dynamic-imported module behind the button; no
load-bearing changes to existing paths).

---

## §6 Test plan (engine first, audio last)

1. **Unit (CI-able, no mic)**: GATE 2 fixture matrix as `node --test`; fixtures are plain
   arrays of `(token, tMs)` + expected event logs. This is the contract that makes the
   engine debuggable forever (any field bug → reproduce as a fixture).
2. **Dataset audit (build-time)**: GATE 1 script; re-run on any normalizer change
   (mirrors the audit-gharib 6,106/6,107 discipline).
3. **Replay harness (manual, dev page)**: WAV → worker → engine with the golden-clip set;
   reports WER + classification diff vs expected. Grows a regression library from every
   real-world miss (§7 R5 mitigation).
4. **Device protocol (you, per gate)**: scripted 10-minute checklist per GATE 6/7 —
   permission, download, recite-with-planted-mistakes card, repetition case, background/
   interruption (phone call), battery/memory readings. No automated browser verification
   (per standing instruction); build-check only on my side.

### 6.5 Golden-clip recording spec (approved 2026-07-10; record before Gate 3)

- **Deliver**: mono WAV, **48,000 Hz** (mirrors WebView capture; exercises our
  resampler), 16-bit PCM. Record with anything (iPhone Voice Memos `.m4a` is fine) and
  either convert with `ffmpeg -i in.m4a -ac 1 -ar 48000 -sample_fmt s16 out.wav` or drop
  the raw `.m4a` next to it and I convert.
- **Location**: `tests/tasmee/golden/` (committed — this is the permanent regression set).
- **Files** (page assignment resolved 2026-07-10):
  `01-clean-p002.wav` (page 2, fixed — covers الم) ·
  `02-whisper-pNNN.wav` · `03-fast-pNNN.wav` · `04-subs-pNNN.wav` ·
  `05-skips-repeats-pNNN.wav` (NNN = ONE page of your choice that you know cold —
  same page for all four; tell me the number when you record) ·
  `06-noise-pNNN.wav` (any page, real background noise: TV, street, fan).
- **Content**: one page each (~1–2 min). Begin every clip with ~1 s of silence; normal
  distance from the phone (~30–40 cm); don't clip the meter; quiet room except 06.
- **Truth scripts** for 04 and 05: same basename + `.truth.json`, written BEFORE
  recording and recited from the script. **Schema: `tasmee-truth-v1`, finalized in
  `tests/tasmee/golden/TRUTH-SCHEMA.md`** (multi-word/whole-ayah/multi-ayah skips,
  whole-ayah/phrase/cross-ayah ranged repeats, inserts, hesitations — with a complete
  worked example). Gate 3 measures precision/recall against these.

---

## §7 Risk register (top first)

| # | Risk | Impact | Mitigation / early signal |
|---|---|---|---|
| R1 | WASM RTF > 1 on older phones (esp. iOS 15.x non-SIMD) | Reveals lag → feature feels broken | Adaptive stride; capability probe at download (1 s benchmark → warn/deny gracefully); GATE 3 desktop + GATE 6 device numbers before UI polish; Option-B pivot documented |
| R2 | WER on non-professional voices (kids, fast/quiet reciters) | False mistakes destroy trust | Constrained matching absorbs moderate WER (known reference + window); measured at GATE 3 with family voices; θ tuning via fixtures; noise-injection tests quantify absorbable WER at GATE 2 |
| R3 | iOS memory pressure (131 MB weights + heap in WKWebView) | Jetsam kill mid-session | GATE 7 Xcode gauge acceptance; full teardown on exit; no simultaneous heavy features (tafsir JSONs not loaded in Mushaf) |
| R4 | WebView audio lifecycle (interruptions, backgrounding, BT mics) | Silent data loss mid-session | Auto-pause on visibility/statechange; resume-on-gesture; session state survives pause; GATE 6/7 interruption checklist |
| R5 | Uthmani↔Imlaei mismatch tail beyond the 35 known cases | Un-revealable words | GATE 1 audit to 6,236/6,236 by construction; runtime never trusts unaudited data; replay-harness misses become table entries |
| R6 | 131 MB download friction / quota failures | Users never reach the feature | Verified-put + retry channel (proven at 189 MB QCF4 scale); quota preflight; clear one-time Arabic copy; wifi warning |
| R7 | offline-tarteel code license unclear | Can't port verbatim | Check before GATE 3; else clean-room reimplement (mel/CTC are textbook); model itself is CC-BY-4.0 (attribution at GATE 8) |
| R8 | Wrapper edits blocked (TCC) from agent sessions | GATE 6/7 stall | Manifest/plist edits are 2 lines each — you apply them in your terminal per the existing rebuild flow |
| R9 | iOS WASM stays insufficient after anomaly fix + incremental + overlap tuning + candidate-model A/B | Feature unusable on iPhone (Gate 6/7 fail) | **CONTINGENCY (documented 2026-07-10, NOT authorized work — no build, no research time)**: native inference plugin (Core ML or sherpa-onnx native) behind the SAME worker message interface — the module boundary already contains it, same containment as the Option-B pivot. Trigger: only after every WASM-path lever above is measured and exhausted |
| R10 | **Recall floor — DOWNGRADED 2026-07-11 (ground-truth correction), then FURTHER NARROWED same day (FP diagnosis)**: the "R stuck at .60/.75 across six configs" evidence was substantially a TRUTH-FILE error — corrected, R(04)=1.00 in every configuration and q8pc-head MEETS P≥.80/R≥.90 on 04 on both surfaces. 05's FN is بل@38:8:6 (possibly a failed plant — ear-check pending; ما@38:11:2 WAS detected); 05's FP 6 = two incidents (idgham-merger seam + onset fragment), both addressable — see the diagnosis block | 05 still fails its binding P/R on paper; tail-truncation class (يذوقوا→يذوق, إله→إل) can break the resync pair | Fix ruling pending (resync truncation tolerance / idgham fusion table / onset guard / per-incident FP accounting); window-01's ما→مَّ = the lone short-word skip data point — watch, don't over-invest (ruled); natural-error golden clips remain the recommended binding surface (memo #18). METHOD LESSON: truth files are measurements too |

---

## §8 Cost estimate

- **Option A (recommended)**: GCS storage ~150 MB ≈ $0.004/mo. Egress ~$0.12–0.23/GB →
  ~$0.02–0.03 per device first-download (≈ $17–33 per 1,000 new devices, one-time; same
  cost class as the existing 189 MB QCF4 download). **Recurring serving cost: zero.**
  No backend work at all in v1.
- **Option B (rejected / fallback)**: Cloud Run me-central1 (Tier-2 ≈ $0.0000288 vCPU-s +
  $0.0000032 GiB-s, verify current sheet if pivoting): 1–2 vCPU busy for the session
  duration ≈ **$0.13–0.23 per active hour** → $0.002–0.004/recitation-minute. 200 users ×
  10 min/day ≈ $130–230/mo; 1,000 × 15 min ≈ $0.9–1.7k/mo; plus min-instance idle to hide
  ~10 s cold starts. This is the number that kills B for a free app.

---

## §9 Decisions log (2026-07-10) + deferred items

**Decided by you:**
- **D1 — Architecture**: Option A approved. Amendments A1 (blur-peek replaces
  first-letter; hint = whole word), A2 (hidden-word side-channel acceptance in Gate 4),
  A3 (durable model storage — Filesystem on app, persist() on web; no silent re-download;
  CC-BY attribution at Gate 7), A4 (explicit 48→16 kHz resample before mel) folded in.
- **D2 — Ship order**: validate on **web behind a feature flag** first (nothing public);
  **iPhone Safari testing mandatory during the web phase** (same WebKit as the iOS
  WebView → de-risks Gate 7 early); first public beta **Android**; **iOS last**.
- **D3 — Page completion**: **auto-advance** while recitation continues (extendReference
  lookahead across the boundary); summary only on user stop. Escape hatch: if Gate 4
  shows a materially expensive seam → v1 stop-with-summary, v1.1 auto-advance.
- **D7 — Golden clips**: approved; 6-clip protocol + truth scripts per §6.5.

**Decided by me now (blocks Gates 1–3):**
- **D4 — Basmala: optional-accept** at surah starts (engine optional-prefix block, §2.1;
  Gate 2 fixtures cover recited and skipped). Needed now because Gate 2 fixtures encode
  it. A "required" strictness toggle remains possible later without engine changes.

**Deferred to their owning gate (nothing in Gates 1–3 depends on them):**
- Tap-to-hint on hidden text → GATE 5 (UI wiring day; recommendation stands: yes).
- Loop-mode UI («تسميع نطاق ×٣») → GATE 5/8 (engine support lands at Gate 2 regardless).
- Historical-mistakes drill screen → GATE 8 (v1 stores counts either way).
- iOS 15.x floor (SIMD-only vs degrade) → GATE 6/7 with measured device data.
