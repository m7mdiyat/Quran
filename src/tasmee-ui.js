/* ============================================================
 * tasmee-ui.js — Gate 4/5 DOM layer for وضع التسميع (TASMEE-PLAN §4).
 *
 * PIECE 1 (this file's current scope): hide/reveal on the real
 * rendered QCF4 page, driven by reference-index events. No audio,
 * no worker, no engine yet — a scripted dev harness (window.__tasmee)
 * feeds events so the whole DOM path — hide → in-order reveal →
 * mistake colours → ZERO layout shift — is testable in the browser
 * with no microphone. Later pieces replace the scripted feed with
 * the engine's onEvent (Piece 2) and the live worker (Piece 4);
 * this module's applyEvent() is the seam that never changes.
 *
 * The reveal contract matches src/tasmee-engine.js EXACTLY: the
 * reference index `idx` enumerates page words (type==="word",
 * text[0]!=="#", page order) — the same filter the engine uses in
 * §2.1 — so an engine reveal{idx} maps straight to refSpans[idx]
 * with no translation. (vk,pos) ride along for the summary and the
 * Piece-5 tap routing.
 *
 * Span mapping copies gharib's dom-index counting verbatim
 * (src/gharib.js:400): the 199 quarter (۞) markers and the 15 sajda
 * glyphs render as .mushaf-word spans but are NOT recited words, so
 * a naive word-index==span-index assumption desyncs every reveal in
 * an affected ayah. Counting every non-"end" verse_key entry as a
 * DOM slot — while advancing the reference index only on real words
 * — keeps engine idx and DOM span in lockstep by construction.
 * ============================================================ */

"use strict";

import { createTasmeeSession } from "./tasmee-engine.js";
import { tasmeeNorm } from "./tasmee-norm.js";
import { checkTashkeel } from "./tasmee-tashkeel.js";
import { createMic } from "./tasmee-audio.js";
import { TASMEE_LIVE } from "./tasmee-live-config.js";
import { cue, haptic, setMicLive, sfxEnabled } from "./tasmee-sfx.js";
import { resampleTo16k } from "./tasmee-pipeline.js";

let S = null; // active session, or null when the mode is off

export function isActive() { return !!S; }

/* Match-form dataset (public/tasmee-words.json): { verses: { "s:a": [form,…] } },
 * one tasmeeNorm-normalized form per QCF4 position (Gate 1). Loaded once,
 * cached — the engine matches incoming tokens against these forms. */
let _dataset = null, _datasetP = null;
function loadDataset() {
    if (_dataset) return Promise.resolve(_dataset);
    if (!_datasetP) {
        _datasetP = fetch("/tasmee-words.json")
            .then((r) => (r.ok ? r.json() : null))
            .then((j) => (_dataset = j || { verses: {} }))
            .catch(() => (_dataset = { verses: {} }));
    }
    return _datasetP;
}

/* Build the unified reference for a rendered page: ref[idx] =
 * { vk, pos, span, form }. ONE ordered list drives BOTH the DOM (span) and
 * the engine (form), so an engine reveal{idx} maps 1:1 to ref[idx].span with
 * no translation. The order is the engine's own §2.1 filter (type==="word",
 * text[0]!=="#", page order); span mapping copies gharib's dom-index count so
 * the 199 ۞ + 15 sajda span-slots never desync. `form` is the tasmee-words
 * dataset entry (fallback: tasmeeNorm of the QCF4 text) — an entry with no
 * matchable form is dropped from BOTH lists, keeping them aligned. */
async function buildRef(pageEl, pageData) {
    const DATASET = await loadDataset();
    const spanCache = new Map();
    const spansFor = (vk) => {
        let n = spanCache.get(vk);
        if (!n) spanCache.set(vk, n = pageEl.querySelectorAll(
            `.mushaf-ayah[data-verse-key="${CSS.escape(vk)}"] .mushaf-word:not(.mushaf-end)`));
        return n;
    };
    const domCount = new Map();
    const ref = [];
    for (const line of pageData.lines || []) {
        for (const w of line.words || []) {
            if (!w.verse_key || w.type === "end") continue;   // end markers: neither span-in-set nor word
            const dom = domCount.get(w.verse_key) || 0;
            domCount.set(w.verse_key, dom + 1);               // every non-end vk entry occupies a span slot
            if (w.type !== "word") continue;                  // quarter ۞ marker: span slot, not a word
            if (String(w.text || "")[0] === "#") continue;    // sajda glyph: span slot, not recited
            const form = DATASET?.verses?.[w.verse_key]?.[(w.position || 0) - 1] || tasmeeNorm(w.text || "");
            if (!form) continue;                              // no matchable form → drop from BOTH lists
            // `vocal` = the mushaf's own diacritised text for this word — the
            // canonical side of the M3 harakat check. No new fetch: it is already
            // in the page data we render from.
            ref.push({ vk: w.verse_key, pos: w.position || 0, span: spansFor(w.verse_key)[dom] || null, form, vocal: String(w.text || "") });
        }
    }
    return ref;
}

/* Enter tasmee mode on a rendered page: add the mode classes (the hide rule
 * lives in mushaf.css) and spin up the REAL alignment engine wired straight
 * to the DOM. Async — awaits the match-form dataset (cached after first
 * entry). Idempotent: re-entering rebuilds cleanly. */
export async function enter(pageEl, pageData) {
    if (S) exit();
    if (!pageEl || !pageData) return false;
    const ref = await buildRef(pageEl, pageData);
    // `offered` dedups auto-offers (offer a word once, never nag). `clock` is
    // the simulated recitation time for feedToken/tick during script-recite.
    S = { pageEl, pageData, ref, offered: new Set(), session: null, clock: 0 };
    document.body.classList.add("tasmee-on");
    pageEl.classList.add("mushaf-page--tasmee");
    // The Gate-2 engine. Its reference is the SAME ordered list, so
    // reveal{idx} → ref[idx].span; onEvent routes every classification to the
    // DOM in real time (reveals, insertion dots, hesitation/stuck offers).
    S.session = createTasmeeSession({
        words: ref.map((r) => ({ vk: r.vk, pos: r.pos, form: r.form })),
        onEvent: applyEvent,
    });
    ensureMeter();   // Piece 3: show the idle mic panel ("tap to listen")
    /* Also warms cuelume's AudioContext, on a user gesture and while the
     * mic is definitively closed — the one moment WKWebView will build it
     * without renegotiating a capture session. */
    cue("enter");
    return true;
}

/* Help visuals are real child elements — NOT ::pseudos (gharib owns those)
 * and NOT word animations (gharib's @property transitions freeze them). */
const _measCtx = (typeof document !== "undefined") ? document.createElement("canvas").getContext("2d") : null;

/* THE HELP CLOUD — a soft GENERIC gold radial-gradient blob (a child <i>;
 * gharib-freeze-safe — no time-based CSS on the word itself, all animation
 * on this child). One element, several states: it breathes as an OFFER over
 * a hidden word, then resolves — `bloom` (hint taken → gold), `part`
 * (recited correctly → correct ink, earned), or `out` (dismissed). Reused
 * across states so the visual is continuous.
 *
 * NOT a glyph duplicate: the word-shaped version cost five ن-clip sightings
 * and a canvas rewrite (WebKit clips CSS-filtered DOM layers to the
 * border-box), and the blob reads better anyway (Mohammed's ruling
 * 2026-07-13, A2-override withdrawn). The blob's soft radial gradient fades
 * to transparent well inside its box, so WebKit's border-box filter clip
 * cuts only already-transparent pixels — no visible clip (verified). */
function makeCloud(span) {
    let c = span.querySelector(":scope > .ts-cloud");
    if (c) return c;
    c = document.createElement("i");
    c.className = "ts-cloud";
    c.setAttribute("aria-hidden", "true");
    // Size + CENTER the blob on the WORD's own box (measured, not the glyph):
    // a wide word gets a wide cloud, a short word a compact one. A touch wider
    // than the box and a bit shorter, centered — a soft glow that fits the word
    // instead of a big off-centre lamp.
    const rect = span.getBoundingClientRect();
    const W = Math.max(1, rect.width), H = Math.max(1, rect.height);
    const bw = W * 1.12, bh = H * 0.78;
    c.style.cssText =
        `width:${bw.toFixed(1)}px;height:${bh.toFixed(1)}px;` +
        `left:${((W - bw) / 2).toFixed(1)}px;top:${((H - bh) / 2).toFixed(1)}px;`;
    span.appendChild(c);
    return c;
}
function cloudOf(span) { return span && span.querySelector(":scope > .ts-cloud"); }
function resolveCloud(cloud, state, ms) {
    if (!cloud) return;
    cloud.classList.remove("ts-cloud--bloom", "ts-cloud--part", "ts-cloud--out");
    cloud.classList.add("ts-cloud--" + state);
    setTimeout(() => { try { cloud.remove(); } catch { } }, ms);
}

/* SKIP underline — a DRAWN SVG dotted line, positioned just below THIS word's
 * real ink (canvas-measured per word) and dotted with round-capped
 * zero-length dashes so every dot is a full, evenly-spaced circle. */
function addSkipLine(span) {
    if (!span || !_measCtx || span.querySelector(":scope > .ts-skip-line")) return;
    const cs = getComputedStyle(span);
    const px = parseFloat(cs.fontSize) || 24;
    _measCtx.font = `${px}px ${span.style.fontFamily || cs.fontFamily}`;
    const mt = _measCtx.measureText(span.textContent);
    const box = span.getBoundingClientRect();
    // STATIC position — the SAME height for every word (Mohammed's call: the
    // per-word stepping looked worse than a clean constant line). Drop the
    // line a FIXED 0.6em below the baseline, which clears the deepest QCF4
    // descender (~0.53em). fontBoundingBox* + box.height are uniform across a
    // page's words, so `y` is constant page-wide — a calm, level line.
    const baseline = (box.height - mt.fontBoundingBoxAscent - mt.fontBoundingBoxDescent) / 2 + mt.fontBoundingBoxAscent;
    const y = baseline + px * 0.6;
    const dot = Math.max(2, Math.round(px * 0.07));
    const spacing = Math.max(8, Math.round(px * 0.44));   // sparse, calm dots — fewer, evenly spaced
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "ts-skip-line");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.style.cssText = `left:0;width:100%;height:${dot}px;top:${y}px;`;
    const line = document.createElementNS(NS, "line");
    line.setAttribute("x1", dot / 2);
    line.setAttribute("y1", dot / 2);
    line.setAttribute("x2", "100%");
    line.setAttribute("y2", dot / 2);
    line.setAttribute("stroke-width", dot);
    line.setAttribute("stroke-linecap", "round");
    line.setAttribute("stroke-dasharray", `0.01 ${spacing}`);
    svg.appendChild(line);
    span.appendChild(svg);
}

const ALL_CLASSES = ["ts-r", "ts-correct", "ts-sub", "ts-skip", "ts-hint", "ts-unverified", "ts-tash-bad", "ts-tash-ok", "ts-cur", "ts-rep", "ts-prov", "ts-ins", "ts-offer"];

/* Strip every reveal artifact from a word: verdict classes AND the
 * insertion dot child. The dot is a real element (not a ::after) so
 * it never collides with gharib's glow pseudos, which also live on
 * ::before/::after of the same word (gharib glow is suppressed in
 * session, but the dot must survive on any word regardless). */
function clearWord(span) {
    if (!span) return;
    span.classList.remove(...ALL_CLASSES);
    span.querySelectorAll(":scope > .ts-ins-dot, :scope > .ts-cloud, :scope > .ts-skip-line, :scope > .ts-cur-box")
        .forEach((n) => n.remove());
}

/* Leave tasmee mode: strip every reveal and the mode classes,
 * restoring the page to its normal rendered state. */
export function exit() {
    _curIdx = -1;
    for (const t of _repTimers.values()) clearTimeout(t);
    _repTimers.clear();
    if (!S) return;
    stopMic();                       // release the mic + tear down the meter
    setMicLive(false);               // mode torn down — cues are free again
    if (_deep) { try { _deep.dispose(); } catch { } }
    _killWorker();                   // drop the worker so re-entering re-arms on the new page's ref
    flushDeferred(false);            // discard held flag timers — the mode is torn down
    for (const r of S.ref) clearWord(r.span);
    S.pageEl.classList.remove("mushaf-page--tasmee");
    document.body.classList.remove("tasmee-on");
    S = null;
}

/* ---------- PIECE 3: mic capture + live level/VAD meter ----------
 * getUserMedia → tasmee-audio.js worklet (16 kHz mono PCM) → a floating
 * meter so recitation registers VISIBLY. No model yet: the 16 kHz chunks
 * are captured (and counted) but not transcribed until Piece 4 wires the
 * worker. The meter is a plain child panel — not a gharib word — so the
 * freeze rule doesn't apply to its animation. */
let _mic = null, _meter = null, _chunkCount = 0;

const MIC_ICON =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>' +
    '<path d="M5 10v1a7 7 0 0 0 14 0v-1"/><line x1="12" y1="19" x2="12" y2="22"/></svg>';

/* Build the meter panel once, appended to <body> so it floats over the mushaf.
 * Structure: mic toggle button · level track (with a fill + a peak tick) ·
 * a state line. All visual state rides on classes / the --lvl custom prop. */
function ensureMeter() {
    if (_meter) return _meter;
    const el = document.createElement("div");
    el.className = "ts-mic";
    el.setAttribute("dir", "rtl");
    el.innerHTML =
        '<button type="button" class="ts-mic-btn" aria-label="الميكروفون">' + MIC_ICON + "</button>" +
        '<div class="ts-mic-body">' +
        '  <div class="ts-mic-track"><i class="ts-mic-fill"></i><i class="ts-mic-peak"></i></div>' +
        '  <div class="ts-mic-state">اضغط للاستماع</div>' +
        '  <div class="ts-heard" dir="rtl" aria-live="polite" title="ما سمعه النموذج (النص الخام قبل المطابقة)"></div>' +
        '  <label class="ts-opt"><input type="checkbox" class="ts-opt-tashkeel">' +
        '    <span>تدقيق الحركات</span></label>' +
        '  <label class="ts-opt"><input type="checkbox" class="ts-opt-sfx">' +
        '    <span>أصوات التنبيه</span></label>' +
        "</div>";
    el.querySelector(".ts-mic-btn").addEventListener("click", () => {
        const st = _mic && _mic.getState();
        if (st === "listening" || st === "requesting") stopListening();
        else startListening();
    });
    /* M3 harakat check — a REAL control, not a console incantation. Off by
     * default and persisted; the label says what it does and the title says
     * what it deliberately does NOT do, because a checker that stays silent
     * half the time must not be mistaken for one that verified everything. */
    const box = el.querySelector(".ts-opt-tashkeel");
    box.checked = tashkeelCheck();
    el.querySelector(".ts-opt").title =
        "يُقارن الحركات التي ينطق بها القارئ بحركات المصحف. يصمت عندما لا يسمعها بوضوح — الصمت ليس تزكية.";
    box.addEventListener("change", () => { tashkeelCheck(box.checked); cue("toggle"); });
    /* Cue switch. The title states the guarantee rather than a preference:
     * cues never sound DURING recitation (the open mic would record them),
     * so what this controls is the transitions around it, plus haptics. */
    const sbox = el.querySelector(".ts-opt-sfx");
    sbox.checked = sfxEnabled();
    sbox.parentElement.title =
        "نغمات قصيرة عند بدء الاستماع وانتهائه. لا تصدر أثناء التلاوة إطلاقًا حتى لا يلتقطها الميكروفون.";
    sbox.addEventListener("change", () => { sfxEnabled(sbox.checked); cue("toggle"); });
    document.body.appendChild(el);
    return (_meter = el);
}

const MIC_STATE_TEXT = {
    idle: "اضغط للاستماع",
    loading: "تحميل نموذج التسميع…",
    requesting: "طلب إذن الميكروفون…",
    listening: "أستمع… ابدأ التلاوة",
    error: "تعذّر تشغيل الميكروفون",
};
const MIC_ERROR_TEXT = {
    NotAllowedError: "الإذن مرفوض — فعّله من إعدادات المتصفّح",
    NotFoundError: "لا يوجد ميكروفون",
    NotReadableError: "الميكروفون مشغول بتطبيق آخر",
};

function paintMeterState(state, detail) {
    if (!_meter) return;
    _meter.classList.toggle("ts-mic--on", state === "listening");
    _meter.classList.toggle("ts-mic--busy", state === "requesting" || state === "loading");
    _meter.classList.toggle("ts-mic--error", state === "error");
    const line = _meter.querySelector(".ts-mic-state");
    if (state === "error") line.textContent = MIC_ERROR_TEXT[detail] || MIC_STATE_TEXT.error;
    else line.textContent = MIC_STATE_TEXT[state] || "";
    if (state !== "listening") {           // reset the bar when not live
        _meter.style.setProperty("--lvl", "0");
        _meter.style.setProperty("--peak", "0");
        _meter.classList.remove("ts-mic--voice");
    }
}

/* Map the smoothed 16 kHz RMS to a 0–1 bar. Speech (AGC on) lands ~0.02–0.1,
 * so a ~9× gain fills the bar on normal recitation without pinning. */
const meterScale = (v) => Math.max(0, Math.min(1, v * 9));

export async function startMic() {
    ensureMeter();
    if (_mic && (_mic.getState() === "listening" || _mic.getState() === "requesting")) return;
    _chunkCount = 0;
    _mic = createMic({
        onState: paintMeterState,
        onLevel: ({ level, peak, vad }) => {
            if (!_meter) return;
            _meter.style.setProperty("--lvl", meterScale(level).toFixed(3));
            _meter.style.setProperty("--peak", meterScale(peak).toFixed(3));
            _meter.classList.toggle("ts-mic--voice", !!vad);
        },
        onChunk: () => { _chunkCount++; },     // Piece 4: forward pcm to the worker here
    });
    await _mic.start();
}

export function stopMic() {
    if (_mic) { _mic.stop(); _mic = null; }
    setMicLive(false);          // every path that closes the stream must reopen the interlock
    if (_meter) { _meter.remove(); _meter = null; }
}

/* Dev probe: how many 16 kHz chunks have arrived (proves the pipeline is live). */
export function _micChunks() { return _chunkCount; }
export function micState() { return _mic ? _mic.getState() : "idle"; }

/* ---------- PIECE 4: acoustic worker (onnxruntime-web + model) ----------
 * Spawned on the mic-tap path (PINNED: never at page load — iOS suspends
 * load-time module workers). Loads the ONNX model + vocab, warms up, then
 * (full wiring) consumes live audio and posts engine events back. */
/* Model artifacts (dev-served from public/models/tasmee/, git-ignored).
 * PRIMARY = q8pc-head, the record artifact (adopted 2026-07-11: short-word
 * truncation class fixed, best measured grid). The OLD q8 export stays as
 * FALLBACK only — it has the known wasm short-word truncation instability
 * (إله→إل class), so if the console reports a fallback load, treat the
 * session's accuracy as suspect. */
const MODEL_URL = "/models/tasmee/fastconformer_ar_ctc_q8pc-head.onnx";
const MODEL_URL_FALLBACK = "/models/tasmee/fastconformer_ar_ctc_q8.onnx";
const VOCAB_URL = "/models/tasmee/vocab.json";
let _worker = null, _workerReady = null;
// Diagnostics: the raw ASR transcript (what the model heard) + a raw-48k
// recording of the live session, for offline-bench comparison.
let _heard = [], _recorded = [], _recording = false;

/* One committed token arrived from the model (BEFORE the engine matched it).
 * Show it live + log it, so mishearing is visible separately from the matcher. */
function onHeard(token, tMs) {
    _heard.push({ token, tMs });
    if (typeof console !== "undefined") console.log(`%c[tasmee ASR] ${token}`, "color:#2bb58a", `@${(tMs / 1000).toFixed(1)}s`);
    const line = _meter && _meter.querySelector(".ts-heard");
    if (line) {
        line.textContent = _heard.slice(-14).map((h) => h.token).join(" ");
        line.scrollLeft = 0;
    }
}

/* Encode Float32 mono → 16-bit PCM WAV (for the offline bench). */
function encodeWav(float32, rate) {
    const n = float32.length, buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf);
    const wr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    wr(0, "RIFF"); dv.setUint32(4, 36 + n * 2, true); wr(8, "WAVE"); wr(12, "fmt ");
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true);
    dv.setUint16(34, 16, true); wr(36, "data"); dv.setUint32(40, n * 2, true);
    let o = 44; for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, float32[i])); dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
    return new Blob([buf], { type: "audio/wav" });
}

/* Download the just-recorded live session as a 48 kHz WAV — run it through
 * `node scripts/tasmee-bench.mjs <file> --page N` to see if the OFFLINE model
 * hears it correctly (→ live-pipeline bug) or also mishears (→ mic/room/voice). */
export function _downloadRecording(name = "tasmee-live.wav") {
    const total = _recorded.reduce((a, c) => a + c.length, 0);
    if (!total) { console.warn("[tasmee] no recording — start listening first"); return null; }
    const all = new Float32Array(total);
    let o = 0; for (const c of _recorded) { all.set(c, o); o += c.length; }
    const url = URL.createObjectURL(encodeWav(all, 48000));
    const a = document.createElement("a"); a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 8000);
    return { seconds: +(total / 48000).toFixed(1), samples: total };
}
/* The full raw transcript of the last session (array of {token,tMs}). */
export function _transcript() { return _heard.map((h) => h.token).join(" "); }

export function spawnWorker(ref) {
    if (_workerReady) return _workerReady;
    ref = ref || (S && S.ref) || null;   // default: the current page's reference
    _worker = new Worker(new URL("./tasmee-worker.js", import.meta.url), { type: "module" });
    // Persistent router: the worker's engine posts events → applyEvent → DOM.
    _worker.addEventListener("message", (e) => {
        const m = e.data || {};
        if (m.type === "event" && m.event) applyEvent(m.event);
        else if (m.type === "transcript") onHeard(m.token, m.tMs);      // raw ASR word
        else if (m.type === "decoded") window.__tasmeeLastDecode = m;
        else if (m.type === "stopped") { window.__tasmeeStopped = m; onSessionStopped(); }
    });
    const initOnce = (modelUrl) => new Promise((resolve, reject) => {
        const to = setTimeout(() => { cleanup(); reject(new Error("worker init timeout (60s)")); }, 60000);
        const onReady = (e) => {
            const m = e.data || {};
            if (m.type === "ready") { cleanup(); m.modelUrl = modelUrl; window.__tasmeeWorker = m; resolve(m); }
            else if (m.type === "error" && m.where === "init") { cleanup(); reject(new Error(m.message)); }
        };
        const onErr = (err) => { cleanup(); reject(new Error(err.message || "worker error")); };
        const cleanup = () => { clearTimeout(to); _worker.removeEventListener("message", onReady); _worker.removeEventListener("error", onErr); };
        _worker.addEventListener("message", onReady);
        _worker.addEventListener("error", onErr);
        // strip the DOM span (not structured-cloneable) — the worker only needs vk/pos/form.
        const refWords = ref ? ref.map((r) => ({ vk: r.vk, pos: r.pos, form: r.form })) : null;
        _worker.postMessage({ type: "init", modelUrl, vocabUrl: VOCAB_URL, ref: refWords });
    });
    _workerReady = initOnce(MODEL_URL)
        .catch((e) => {
            // Primary artifact failed to load — fall back to the old q8 (the
            // worker survives a failed init; re-init reloads cleanly).
            console.warn(`[tasmee] PRIMARY model failed (${e.message}) — falling back to old q8`);
            return initOnce(MODEL_URL_FALLBACK);
        })
        .then((m) => {
            console.log(`[tasmee] model loaded: ${m.modelUrl} · vocab ${m.vocabSize} · threads ${m.numThreads} · xoi ${m.crossOriginIsolated}`);
            return m;
        });
    return _workerReady;
}

/* Feed one raw 48 kHz block to the worker's live pipeline (the mic path). */
function feedWorkerAudio(pcm48k) {
    if (_worker) _worker.postMessage({ type: "audio", pcm: pcm48k }, [pcm48k.buffer]);
}

/* Dev/test: stream a golden WAV through the LIVE worker path → resolves the
 * 'stopped' summary (committed count + text) once the whole clip is processed. */
export function _streamWav(buf) {
    return new Promise((resolve, reject) => {
        if (!_worker) return reject(new Error("no worker"));
        const h = (e) => { if (e.data && e.data.type === "stopped") { _worker.removeEventListener("message", h); resolve(e.data); } };
        _worker.addEventListener("message", h);
        _worker.postMessage({ type: "streamWav", buf }, [buf]);
    });
}

/* Dev: decode a supplied 16 kHz Float32 slice (proves model→mel→CTC in-browser). */
export function _workerDecode(pcm, startS = 0) {
    if (_worker) _worker.postMessage({ type: "decode", pcm, startS }, [pcm.buffer]);
}
/* Dev/parity: decode WAV bytes in the worker (readWavMono→resample→decode, the
 * bench's flow) → resolves the decoded words. For browser-vs-node parity checks. */
export function _workerDecodeWav(buf) {
    return new Promise((resolve, reject) => {
        if (!_worker) return reject(new Error("no worker"));
        const h = (e) => {
            if (e.data && e.data.type === "decoded") { _worker.removeEventListener("message", h); resolve(e.data); }
            else if (e.data && e.data.type === "error") { _worker.removeEventListener("message", h); reject(new Error(e.data.message)); }
        };
        _worker.addEventListener("message", h);
        _worker.postMessage({ type: "decodeWav", buf }, [buf]);
    });
}
export function _killWorker() { if (_worker) { _worker.terminate(); _worker = null; _workerReady = null; } }

/* ---------- PIECE 4: live listening (mic → worker → reveals) — the real thing.
 * Spawn the worker (load model + arm the engine on THIS page's ref), then start
 * the mic and feed it raw 48 kHz blocks. The worker's incremental controller
 * drives the engine; its reveal events flow back to applyEvent → the words
 * appear as you recite. */
export async function startListening() {
    ensureMeter();
    if (_mic && (_mic.getState() === "listening" || _mic.getState() === "requesting")) return;
    /* SOUND ORDER IS LOAD-BEARING. The `armed` cue plays HERE — before
     * capture is requested — for two reasons: with echoCancellation off
     * a cue during capture would be recorded and decoded as speech, and
     * cuelume builds its AudioContext on first play, which on WKWebView
     * must not happen while a capture session is negotiating. After this
     * line the interlock is closed until the stream is fully released. */
    cue("armed");
    setMicLive(true);
    paintMeterState("loading");
    try { await spawnWorker(); }                     // model load + setupLive(S.ref)
    catch (e) { setMicLive(false); paintMeterState("error", "model"); return; }
    _chunkCount = 0; _heard = []; _recorded = []; _recording = true;
    if (_deep) { _deep.clearMarks(); _deep.setAvailable(false); }
    const line = _meter && _meter.querySelector(".ts-heard"); if (line) line.textContent = "";
    _mic = createMic({
        onState: paintMeterState,
        onLevel: ({ level, peak, vad }) => {
            if (!_meter) return;
            _meter.style.setProperty("--lvl", meterScale(level).toFixed(3));
            _meter.style.setProperty("--peak", meterScale(peak).toFixed(3));
            _meter.classList.toggle("ts-mic--voice", !!vad);
        },
        onChunk: (pcm48k) => {
            _chunkCount++;
            if (_recording) _recorded.push(pcm48k.slice(0));   // copy for the WAV BEFORE it's transferred
            feedWorkerAudio(pcm48k);                            // → worker → reveals
        },
    });
    await _mic.start();
}

export function stopListening() {
    _recording = false;
    if (_mic) { _mic.stop(); _mic = null; }
    setMicLive(false);          // stream released — cues may speak again
    if (_worker) _worker.postMessage({ type: "stop" });   // finalize → summary (Piece 5 sheet)
    console.log(`[tasmee] heard ${_heard.length} words · recorded ${(_recorded.reduce((a, c) => a + c.length, 0) / 48000).toFixed(1)}s — __tasmee._downloadRecording() to save the WAV`);
}

/* ============================================================
 * LAYER 2 (التدقيق العميق) — lazily loaded, never on the critical path.
 *
 * Dynamic-imported so the website bundle does not carry a 570 MB
 * feature's UI unless a reciter opens it, and so a failure to load it
 * cannot affect Layer 1 at all: tasmee must keep working exactly as
 * before if this never arrives.
 * ============================================================ */
let _deep = null, _deepP = null;
function loadDeep() {
    if (_deep) return Promise.resolve(_deep);
    if (!_deepP) {
        _deepP = import("./tasmee-deep-ui.js")
            .then((m) => (_deep = m))
            .catch((e) => { console.warn("[tasmee] deep check unavailable", e); _deepP = null; return null; });
    }
    return _deepP;
}

/* The recorded audio at the model's rate. Kept as a function rather than
 * state so nothing holds a second copy of a 90 s recording alive. */
function recordedPcm16k() {
    const total = _recorded.reduce((a, c) => a + c.length, 0);
    if (!total) return null;
    const all = new Float32Array(total);
    let o = 0;
    for (const c of _recorded) { all.set(c, o); o += c.length; }
    return resampleTo16k(all, 48000);
}

/* The verse range this page covers, for the phoneme reference. */
function pageRange() {
    if (!S || !S.ref.length) return null;
    const nums = S.ref.map((r) => r.vk.split(":").map(Number));
    const surah = nums[0][0];
    const same = nums.filter((n) => n[0] === surah).map((n) => n[1]);
    return { surah, from: Math.min(...same), to: Math.max(...same) };
}

const spanAt = (vk, pos) => {
    const r = S && S.ref.find((x) => x.vk === vk && x.pos === pos);
    return (r && r.span) || null;
};

async function mountDeep() {
    const m = await loadDeep();
    if (!m || !_meter) return null;
    const body = _meter.querySelector(".ts-mic-body");
    if (!body) return null;
    m.mount(body, { getPcm16k: recordedPcm16k, getRange: pageRange, spanAt });
    return m;
}

/* Session finalized (the worker's `stopped` arrived): no further
 * amendments can come — paint anything still held.
 *
 * The closing cue is chosen AFTER the flush, because only then is the
 * verdict set final. `perfect` when nothing was flagged; otherwise the
 * neutral `stopped`. There is deliberately no failure sound: a reciter
 * who slipped does not need a buzzer, and the page already says it in
 * colour. */
function onSessionStopped() {
    flushDeferred(true);
    setMicLive(false);          // idempotent — covers stops we did not initiate
    const flagged = S && S.ref
        ? S.ref.some((r) => r.span && (r.span.classList.contains("ts-sub") || r.span.classList.contains("ts-skip")))
        : false;
    cue(flagged ? "stopped" : "perfect");
    /* Layer 2 becomes available only now — offering a deep check before
     * there is any audio is a dead end the reciter has to discover. */
    const secs = _recorded.reduce((a, c) => a + c.length, 0) / 48000;
    if (secs >= 2) mountDeep().then((m) => m && m.setAvailable(true, secs));
}

const VERDICT_CLASS = {
    correct: "ts-correct", substituted: "ts-sub", skipped: "ts-skip", hinted: "ts-hint",
    // M1b: the model could not settle this span — say so, never imply a verdict
    unverified: "ts-unverified",
};

/* ---------- deferred negative-verdict painting (amendment channel,
 * 2026-07-16). Policy: "flag when sure, wait while unsure" —
 * correct/hinted reveals paint INSTANTLY (unchanged); negative
 * verdicts (wrong flags, skip underlines, insertion dots) are HELD so
 * an amendment arriving inside the hold window cancels them before
 * anything was ever painted (no visible flag→unflag by construction
 * within the cap). EARLY-FLAG path: a substitution whose token sim ≤
 * blatantSimMax is a gross mismatch (measured boundary artifacts sit
 * at sim 0.60–0.70; genuinely wrong words score below 0.5) → paints
 * after only earlyDelayS. Skips and insertions always wait capS —
 * skips are precisely the amendable class. */
const _defer = TASMEE_LIVE.flagDefer;
let _pendingNeg = new Map();   // idx → {verdict, extra, timer}
let _pendingIns = new Map();   // idx → {heardNorm, timer}

function paintReveal(idx, verdict, extra = {}) {
    const r = S && S.ref[idx];
    if (!r || !r.span) return;
    const span = r.span, cloud = cloudOf(span);   // a cloud here ⇒ word was offered
    span.classList.remove("ts-offer", "ts-prov");
    // amendment repaint: drop a previous verdict class first
    for (const c of ["ts-correct", "ts-sub", "ts-skip", "ts-hint", "ts-unverified"]) span.classList.remove(c);
    span.querySelector(":scope > .ts-skip-line")?.remove();
    span.classList.add("ts-r", VERDICT_CLASS[verdict] || "ts-correct");
    /* LIVE FEEDBACK, silently. A cue here would be recorded by the open
     * mic and decoded as a phantom word (echoCancellation is off by
     * design — see tasmee-sfx.js). A vibration cannot be heard, so the
     * flag still registers in the body without touching the audio. */
    if (verdict === "substituted" || verdict === "skipped") haptic("light");
    // M4: a skip is now carried by RED ink alone. The drawn dotted underline
    // is gone — with skip red and substitution orange the two classes are
    // already distinct, and dropping the child SVG removes the only reveal
    // artifact that had to be measured and positioned per glyph.
    if (verdict === "hinted") {
        resolveCloud(cloud || makeCloud(span), "bloom", 1350);
    } else if (verdict === "correct" && cloud) {
        resolveCloud(cloud, "part", 1400);
    } else if (cloud) {
        resolveCloud(cloud, "out", 460);
    }
    // Negative verdicts paint on a DELAY (flagDefer), so the frontier can
    // have been sitting on this word while it was still unpainted. Re-derive
    // the "you are here" wash once the paint lands, or it strands on a word
    // that has just been resolved.
    setCurrent(nextExpectedIdx());
}

/* PROVISIONAL INK (latency, 2026-07-20). The word appears the moment the
 * decoder hears it — muted, no verdict colour — and firms up when the real
 * gate delivers a verdict. Visibility is MONOTONE: a provisional word is
 * never un-shown, it only gains colour, which is the same contract deferred
 * negative painting already follows. Opacity is set INSTANTLY (no
 * transition): a registered custom property on a gharib word freezes
 * transitions, so nothing time-based may touch a word element. */
function paintPreview(idx) {
    const r = S && S.ref[idx];
    if (!r || !r.span) return;
    if (r.span.classList.contains("ts-r")) return;   // already judged — leave it
    r.span.classList.add("ts-prov");
}

function paintInsertion(idx) {
    const r = S && S.ref[idx];
    if (r && r.span && !r.span.querySelector(":scope > .ts-ins-dot")) {
        r.span.classList.add("ts-ins");
        const dot = document.createElement("i");
        dot.className = "ts-ins-dot";
        dot.setAttribute("aria-hidden", "true");
        r.span.appendChild(dot);
    }
}

const _isPainted = (idx, neg) => {
    const span = S?.ref[idx]?.span;
    return !!span && (neg ? (span.classList.contains("ts-sub") || span.classList.contains("ts-skip"))
                          : span.classList.contains("ts-r"));
};

function deferNegative(idx, verdict, extra) {
    const prev = _pendingNeg.get(idx);
    if (prev) clearTimeout(prev.timer);
    /* The cap exists to wait for an AMENDMENT that might cancel the flag.
     * An acoustically-flagged word is frozen against amendment by design
     * (the shadow re-verdict replays text, and text is the evidence that
     * missed the mistake) — so there is nothing to wait for, and holding it
     * the full 2 s would just make a settled verdict feel slow. */
    const blatant = verdict === "substituted" &&
        (extra.acoustic != null || (typeof extra.sim === "number" && extra.sim <= _defer.blatantSimMax));
    const delayMs = (blatant ? _defer.earlyDelayS : _defer.capS) * 1000;
    const timer = setTimeout(() => { _pendingNeg.delete(idx); paintReveal(idx, verdict, extra); }, delayMs);
    _pendingNeg.set(idx, { verdict, extra, timer });
}

/* Session end (stop/summary): nothing further can amend — paint what's
 * still held. exit() instead DISCARDS timers (the mode is torn down). */
export function flushDeferred(paint = true) {
    for (const [idx, p] of _pendingNeg) { clearTimeout(p.timer); if (paint) paintReveal(idx, p.verdict, p.extra); }
    for (const [idx, p] of _pendingIns) { clearTimeout(p.timer); if (paint) paintInsertion(idx); }
    _pendingNeg.clear(); _pendingIns.clear();
}

/* ---------- M4: current-word + re-recitation highlights ----------
 * Both are BACKGROUND washes on a child <i>, never ink on the word: an
 * unrevealed word is transparent by the hide rule, and colouring its glyph
 * would leak the text (A2). The child also keeps every time-based style off
 * the word element itself, which the gharib freeze rule requires. */
function curBox(span) {
    let b = span.querySelector(":scope > .ts-cur-box");
    if (!b) {
        b = document.createElement("i");
        b.className = "ts-cur-box";
        b.setAttribute("aria-hidden", "true");
        span.appendChild(b);
    }
    return b;
}
let _curIdx = -1;
function setCurrent(idx) {
    if (!S || idx === _curIdx) return;
    const prev = S.ref[_curIdx];
    if (prev && prev.span) {
        prev.span.classList.remove("ts-cur");
        if (!prev.span.classList.contains("ts-rep")) prev.span.querySelector(":scope > .ts-cur-box")?.remove();
    }
    _curIdx = idx;
    const r = S.ref[idx];
    if (r && r.span) { r.span.classList.add("ts-cur"); curBox(r.span); }
}
/* Re-recitation is NOT a mistake (the engine's core invariant): the earlier
 * occurrence flashes green and nothing is ever flagged. */
const _repTimers = new Map();
function flashRepeat(idx) {
    if (!S) return;
    const r = S.ref[idx];
    if (!r || !r.span) return;
    clearTimeout(_repTimers.get(idx));
    r.span.classList.add("ts-rep");
    const box = curBox(r.span);
    box.style.animation = "none";
    void box.offsetWidth;               // restart the child's animation
    box.style.animation = "";
    _repTimers.set(idx, setTimeout(() => {
        _repTimers.delete(idx);
        r.span.classList.remove("ts-rep");
        if (!r.span.classList.contains("ts-cur")) r.span.querySelector(":scope > .ts-cur-box")?.remove();
    }, 1700));
}

/* ---------- M3: the honest harakat check (OFF by default) ----------
 * Reads ONLY what the model volunteered (see tasmee-tashkeel.js for the
 * measured rationale and for the acoustic verifier that was built,
 * measured and rejected). Three states, and it speaks in the same
 * vocabulary as M1b: verified / mistake / couldn't-verify.
 *
 * Off by default because it is a strictness OPTION, not a correctness
 * fix: with it off nothing about reveals changes at all. */
const TASHKEEL_KEY = "m7_tasmee_tashkeel";
let _tashkeelOn = (() => {
    try { return localStorage.getItem(TASHKEEL_KEY) === "on"; } catch { return false; }
})();
export function tashkeelCheck(on) {
    if (on === undefined) return _tashkeelOn;
    _tashkeelOn = !!on;
    try { localStorage.setItem(TASHKEEL_KEY, _tashkeelOn ? "on" : "off"); } catch { }
    if (!_tashkeelOn && S) {
        for (const r of S.ref) r.span && r.span.classList.remove("ts-tash-bad", "ts-tash-ok");
    }
    return _tashkeelOn;
}

/* Applied only to words whose LETTERS already matched — this checks
 * vowels, never spelling. A mismatch is additive: the word keeps its
 * correct reveal and gains a harakat marker, so turning the option on
 * can never change whether a word counts as recited. */
function applyTashkeel(idx, e) {
    if (!_tashkeelOn || !S) return;
    const r = S.ref[idx];
    if (!r || !r.span || !r.vocal || !e.heardRaw) return;
    const res = checkTashkeel(r.vocal, e.heardRaw);
    r.span.classList.remove("ts-tash-bad", "ts-tash-ok");
    if (res.state === "mismatch") {
        r.span.classList.add("ts-tash-bad");
        r.span.setAttribute("title", `الحركة: المتوقع ${res.expected} — المسموع ${res.got}`);
    } else if (res.state === "match") {
        r.span.classList.add("ts-tash-ok");
    }
    // "abstain" paints NOTHING: the model stayed silent, so we do too.
}

/* The seam every later piece drives. Consumes an engine event
 * (Piece 2+) or a scripted one (Piece 1). */
export function applyEvent(e) {
    if (!S || !e) return;
    if (e.type === "reveal") {
        const verdict = e.verdict || "correct";
        if (verdict === "substituted" || verdict === "skipped") deferNegative(e.idx, verdict, e);
        else {
            const p = _pendingNeg.get(e.idx);
            if (p) { clearTimeout(p.timer); _pendingNeg.delete(e.idx); }
            paintReveal(e.idx, verdict, e);
            if (verdict === "correct") applyTashkeel(e.idx, e);
        }
    } else if (e.type === "amend") {
        const p = _pendingNeg.get(e.idx);
        // `unverified` is a DE-ESCALATION (a flag withdrawn for want of
        // evidence), so it cancels any held negative and paints at once —
        // the same treatment `correct` gets, never the negative guard.
        if (e.to === "correct" || e.to === "unverified") {
            if (p) { clearTimeout(p.timer); _pendingNeg.delete(e.idx); }
            if (_isPainted(e.idx, true)) {
                // outside-cap improve — allowed but expected NEVER on test
                // clips (cap covers the measured amendment lag); observable.
                console.warn(`[tasmee] late amend past flag cap (idx ${e.idx}) — visible unflag`);
            }
            paintReveal(e.idx, e.to, e);
        } else if (e.to === "substituted" || e.to === "skipped") {
            // went through amendment stability already → short guard only
            if (p) { clearTimeout(p.timer); _pendingNeg.delete(e.idx); }
            const timer = setTimeout(() => { _pendingNeg.delete(e.idx); paintReveal(e.idx, e.to, e); }, _defer.earlyDelayS * 1000);
            _pendingNeg.set(e.idx, { verdict: e.to, extra: e, timer });
        }
    } else if (e.type === "insertion") {
        const prev = _pendingIns.get(e.idx);
        if (prev) clearTimeout(prev.timer);
        const timer = setTimeout(() => { _pendingIns.delete(e.idx); paintInsertion(e.idx); }, _defer.capS * 1000);
        _pendingIns.set(e.idx, { heardNorm: e.heard ? tasmeeNorm(e.heard) : "", timer });
    } else if (e.type === "amend_insertions") {
        // reconcile HELD dots against the amended transcript's insertions
        const now = new Set((e.insertions || []).map((i) => `${i.idx}|${i.heard ? tasmeeNorm(i.heard) : ""}`));
        for (const [idx, p] of _pendingIns) {
            if (!now.has(`${idx}|${p.heardNorm}`)) { clearTimeout(p.timer); _pendingIns.delete(idx); }
        }
    } else if (e.type === "preview") {
        paintPreview(e.idx);
    } else if (e.type === "repetition") {
        flashRepeat(e.idx);
    } else if (e.type === "hesitation" || e.type === "hint_offer") {
        // Both engine offer signals (long pause / repeated stuck attempts)
        // OFFER a hint — a gentle pulse, never a forced reveal (§4).
        offerHint(e.idx);
    }
    // M4: the green "you are here" wash follows the frontier after ANY event
    // that can move it. Cheap and idempotent — setCurrent() no-ops when the
    // index has not changed, so this never repaints on unrelated events.
    setCurrent(nextExpectedIdx());
}

/* Index of the next word still hidden (the current expected position in
 * Piece 1's no-engine approximation; in Piece 2 the engine owns the
 * pointer and hint() routes through session.hint()). */
function nextExpectedIdx() {
    if (!S) return -1;
    for (let i = 0; i < S.ref.length; i++) {
        const s = S.ref[i].span;
        if (s && !s.classList.contains("ts-r")) return i;
    }
    return -1;
}

/* Auto-offer: a gentle pulse on the stuck word. Offers ONCE per word
 * (never re-offers, whether accepted or ignored) and never on an
 * already-revealed word. */
export function offerHint(idx) {
    if (!S || idx == null || idx < 0 || idx >= S.ref.length) return;
    if (S.offered.has(idx)) return;
    const r = S.ref[idx];
    if (!r || !r.span || r.span.classList.contains("ts-r")) return;
    S.offered.add(idx);
    r.span.classList.add("ts-offer");   // position:relative anchor for the cloud child
    makeCloud(r.span);                  // breathing, word-shaped invitation to tap
}

/* Take a hint on a word (default: the current expected word). Reveals it gold
 * with the cloud blooming. When the word IS the engine's pointer (the real
 * case — offers fire at the pointer), route through session.hint() so the
 * engine reveals R[p] AND advances in lockstep with the DOM; otherwise reveal
 * in the DOM only (e.g. a dev offerHint() placed ahead of the pointer). */
export function hint(idx) {
    if (!S) return -1;
    const p = S.session ? S.session.getState().pointer : -1;
    const i = (idx == null) ? (p >= 0 && p < S.ref.length ? p : nextExpectedIdx()) : idx;
    if (i < 0 || i >= S.ref.length) return -1;
    if (S.session && i === p) {
        S.clock += 1;
        S.session.hint(S.clock);          // engine reveals R[p] hinted + advances → onEvent → applyEvent
    } else {
        applyEvent({ type: "reveal", idx: i, verdict: "hinted" });
    }
    return i;
}

/* Tap routing entry (called by mushaf.js while tasmee is active). If a hint is
 * being OFFERED, the tap resolves THAT offered word (its whole purpose is
 * "tap to take this word") — wherever the tap landed, and without stacking a
 * second cloud or advancing the pointer to some other word. Otherwise the tap
 * reveals the next expected word. Returns true when it consumed the tap, so
 * the audio toggle / ayah menu never fires underneath. */
export function handleTap(target) {
    if (!S || !target) return false;
    // a tap on a Layer 2 mark opens its card and goes no further; the
    // hint path below must not also fire for the same tap
    if (_deep && _deep.handleTap(target)) return true;
    if (!S.pageEl.contains(target)) return false;
    const offeredIdx = S.ref.findIndex((r) => r.span &&
        !r.span.classList.contains("ts-r") && r.span.querySelector(":scope > .ts-cloud"));
    hint(offeredIdx >= 0 ? offeredIdx : undefined);
    return true;
}

/* ============================================================
 * Script-recite (Piece 2): feed TOKEN STRINGS to the REAL engine and
 * watch it classify → drive the reveals, with no audio. This is the
 * exact path the mic will use in Piece 4 — the worker will call
 * S.session.feedToken(...) instead of these helpers — so what you see
 * here IS the engine's behaviour, not a mock.
 * ============================================================ */

function summarize() {
    const st = S.session.getState();
    const sm = S.session.summary();
    return {
        pointer: st.pointer + "/" + S.ref.length,
        counts: sm.counts,          // correct / substituted / skipped / hinted / insertions / repetitions
        accuracy: (sm.accuracy * 100).toFixed(1) + "%",
        deferred: st.deferred,      // true while the engine is holding a token to disambiguate
    };
}

/* Feed whitespace-separated tokens to the engine, paced so reveals land one
 * at a time. Tokens are matched after tasmeeNorm — type plain Arabic, with or
 * without diacritics. Returns the live summary. */
export async function recite(text, opts = {}) {
    if (!S || !S.session) return "not in tasmee mode — tap the mic button first";
    const toks = String(text).trim().split(/\s+/).filter(Boolean);
    const gap = opts.gap ?? 400;    // simulated ms between spoken words (feeds the clock)
    const step = opts.step ?? 300;  // wall delay between reveals so you can watch it live
    for (const tok of toks) {
        S.clock += gap;
        S.session.feedToken(tok, S.clock);
        if (step) await new Promise((r) => setTimeout(r, step));
    }
    return summarize();
}

/* Recite dataset ayah(s) PERFECTLY, `times` each — the repetition
 * differentiator: reciteAyah("1:2", 3) must produce ZERO mistakes. */
export async function reciteAyah(vk, times = 1, opts = {}) {
    if (!S || !S.session) return "not in tasmee mode";
    const forms = (await loadDataset())?.verses?.[vk];
    if (!forms) return "no dataset entry for " + vk;
    const line = forms.filter(Boolean).join(" ");
    for (let i = 0; i < times; i++) await recite(line, opts);
    return summarize();
}

/* Recite the whole page perfectly (every reference word, in order). */
export function recitePage(opts = {}) {
    if (!S || !S.session) return Promise.resolve("not in tasmee mode");
    return recite(S.ref.map((r) => r.form).join(" "), opts);
}

/* Simulate a silence gap: advances the clock and ticks the engine, which
 * past the waqf-aware threshold OFFERS a hint (a breathing glow). */
export function pause(seconds = 5) {
    if (!S || !S.session) return "not in tasmee mode";
    S.clock += Math.round(seconds * 1000);
    S.session.tick(S.clock);
    return "paused " + seconds + "s — engine ticked at " + S.clock + "ms";
}

/* End the session: flush any deferred reveals and return the final summary. */
export function finish() {
    if (!S || !S.session) return "not in tasmee mode";
    return S.session.stop(S.clock + 1);
}

/* ---------- dev harness (Piece 1 style checks; window.__tasmee) ---------- */

/* Full reset: clear every reveal AND spin up a fresh engine so a re-recite
 * starts from pointer 0 (stays in the mode). */
export function _reset() {
    if (!S) return;
    _curIdx = -1;
    for (const r of S.ref) clearWord(r.span);
    S.offered.clear();
    S.clock = 0;
    S.session = createTasmeeSession({
        words: S.ref.map((r) => ({ vk: r.vk, pos: r.pos, form: r.form })),
        onEvent: applyEvent,
    });
}

/* Snapshot every reference word's bounding rect — the raw material
 * for the zero-layout-shift check (Gate 5 acceptance: word rects
 * identical across hide/reveal). */
export function _rects() {
    if (!S) return [];
    return S.ref.map((r, i) => {
        const b = r.span && r.span.getBoundingClientRect();
        return b ? { i, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }
                 : { i, missing: true };
    });
}

/* Play a scripted reveal sequence over the first N words, planting
 * one of every mistake class so all four colours + the insertion dot
 * show. Returns a self-checked layout-shift verdict (measures word
 * rects before hiding vs after revealing). No engine, no audio. */
export async function _demo(opts = {}) {
    if (!S) return "not in tasmee mode — tap the mic button (or call __tasmee.enter(el,data)) first";
    _reset();
    const step = opts.step || 300;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const n = Math.min(S.ref.length, opts.count || 16);
    const before = _rects();
    for (let i = 0; i < n; i++) {
        if (i === 3) applyEvent({ type: "reveal", idx: i, verdict: "substituted" });   // red
        else if (i === 6 || i === 7) applyEvent({ type: "reveal", idx: i, verdict: "skipped" }); // red + strike
        else if (i === 10) {
            // the OFFER → accept flow: pulse the stuck word, then reveal it
            // gold with the soft glow-in (a moment of help, not a buzzer).
            offerHint(i);
            await wait(1500);
            applyEvent({ type: "reveal", idx: i, verdict: "hinted" });
        } else applyEvent({ type: "reveal", idx: i, verdict: "correct" });
        if (i === 12) applyEvent({ type: "insertion", idx: i });
        await wait(step);
    }
    const after = _rects();
    const moved = before.filter((b, i) => {
        const a = after[i];
        return a && !b.missing && !a.missing && (b.x !== a.x || b.y !== a.y || b.w !== a.w || b.h !== a.h);
    });
    return `demo done — sub@3 (red), skip@6-7 (red+strikethrough), offer→hint@10 (gold glow-in), insertion@12. `
        + `layout-shift: ${moved.length}/${before.length} word rects moved `
        + (moved.length ? "— SHIFTED: " + JSON.stringify(moved.slice(0, 5)) : "— ✓ zero shift");
}

/* Reference length, for quick console sanity (word count on the page). */
export function _refLength() { return S ? S.ref.length : 0; }
