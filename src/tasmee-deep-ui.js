/* ============================================================
 * tasmee-deep-ui.js — التدقيق العميق, the surface for Layer 2.
 *
 * Layer 1 owns the WORD and its colour: did you say the right word, and
 * it answers in 0.3 s. This owns the LETTER: was the ل really a ل, was
 * that fatha really a fatha. It runs after the session, over the audio
 * already recorded, because the model needs 8-second windows to resolve
 * harakat at all.
 *
 * THE TWO LAYERS NEVER COMPETE FOR THE SAME PIXEL. Layer 1 keeps the
 * word's ink colour; this adds a mark UNDER it. A word can be green
 * (right word) and still carry a mark (wrong haraka) — which is exactly
 * the distinction a teacher makes and the one no app currently shows.
 *
 * WHY A CARD AND NOT AN UNDERLINE ON THE LETTER: QCF4 renders each word
 * as a single glyph run, so there is no per-letter box to draw under.
 * Tapping the word grows a card out of it — the same interaction the
 * gharib meaning tooltip already uses, positioned from the target's LIVE
 * getBoundingClientRect because `position:fixed` anchors to the scrolled
 * document in WKWebView (CLAUDE.md, iOS gotchas).
 *
 * Loaded lazily: the website bundle never contains this unless a reciter
 * opens the check.
 * ============================================================ */

import { cue } from "./tasmee-sfx.js";

const KEY_OPTIN = "m7_tasmee_deep";      // "on" once the reciter has accepted the download
const MODEL_MB = 570;

let _worker = null, _ready = null, _mounted = null, _findings = [], _card = null;
let _cardOff = null, _actx = null, _player = null, _pcmCache = null;

const t = (ar) => ar;                     // all copy is Arabic; kept explicit for future i18n

/* ---------- worker plumbing ---------- */
function spawn() {
    if (_worker) return _worker;
    _worker = new Worker(new URL("./tasmee-deep-worker.js", import.meta.url), { type: "module" });
    return _worker;
}

function once(type, onProgress) {
    return new Promise((resolve, reject) => {
        const w = spawn();
        const h = (e) => {
            const m = e.data || {};
            if (m.type === "progress") { onProgress && onProgress(m); return; }
            if (m.type === "warn") { console.warn("[deep]", m.message); return; }
            if (m.type === "error") { w.removeEventListener("message", h); reject(new Error(m.message)); return; }
            if (m.type === type) { w.removeEventListener("message", h); resolve(m); }
        };
        w.addEventListener("message", h);
    });
}

export const optedIn = () => {
    try { return localStorage.getItem(KEY_OPTIN) === "on"; } catch { return false; }
};
const setOptedIn = (v) => { try { localStorage.setItem(KEY_OPTIN, v ? "on" : "off"); } catch { } };

async function ensureReady(onProgress) {
    if (_ready) return _ready;
    _ready = (async () => {
        const p = once("ready", onProgress);
        spawn().postMessage({ type: "init" });
        return p;
    })().catch((e) => { _ready = null; throw e; });
    return _ready;
}

/* ---------- the panel row ---------- */
const ICON = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/><path d="M8.5 11h5"/></svg>';

export function mount(panelBody, ctx) {
    if (!panelBody || _mounted) return _mounted;
    const row = document.createElement("div");
    row.className = "ts-deep";
    row.innerHTML =
        '<button type="button" class="ts-deep-btn" disabled>' + ICON +
        '<span class="ts-deep-label">' + t("تدقيق عميق") + "</span></button>" +
        '<div class="ts-deep-bar" hidden><i></i></div>' +
        '<div class="ts-deep-note" role="status"></div>';
    panelBody.appendChild(row);
    _mounted = {
        row,
        btn: row.querySelector(".ts-deep-btn"),
        label: row.querySelector(".ts-deep-label"),
        bar: row.querySelector(".ts-deep-bar"),
        fill: row.querySelector(".ts-deep-bar > i"),
        note: row.querySelector(".ts-deep-note"),
        ctx,
    };
    _mounted.btn.addEventListener("click", () => run().catch((e) => fail(e)));
    return _mounted;
}

/* The button only wakes once a session has produced audio — offering a
 * check with nothing to check is a dead end the reciter has to discover. */
export function setAvailable(on, seconds) {
    if (!_mounted) return;
    _mounted.btn.disabled = !on;
    _mounted.row.classList.toggle("ts-deep--ready", !!on);
    if (on && seconds) _mounted.note.textContent = t(`${Math.round(seconds)} ثانية جاهزة للتدقيق`);
}

function setProgress(pct, label) {
    if (!_mounted) return;
    _mounted.bar.hidden = false;
    _mounted.fill.style.width = `${Math.max(0, Math.min(100, pct || 0))}%`;
    if (label) _mounted.note.textContent = label;
}
function clearProgress() { if (_mounted) { _mounted.bar.hidden = true; _mounted.fill.style.width = "0%"; } }
function fail(e) {
    clearProgress();
    if (_mounted) {
        _mounted.note.textContent = t("تعذّر التدقيق — ") + (e && e.message ? e.message : "");
        _mounted.btn.disabled = false;
    }
    console.error("[deep]", e);
}

const STAGE_TEXT = {
    runtime: "تهيئة…",
    frontend: "تحضير الصوت…",
    model: "تنزيل النموذج — مرة واحدة فقط",
    session: "تجهيز النموذج…",
    reference: "تحميل المرجع…",
    checking: "أستمع بعناية…",
    ready: "جاهز",
};

/* ---------- the run ---------- */
async function run() {
    const m = _mounted;
    if (!m) return;
    const { getPcm16k, getRange } = m.ctx;
    const pcm = getPcm16k && getPcm16k();
    const range = getRange && getRange();
    _pcmCache = pcm || null;
    if (!pcm || !pcm.length || !range) { m.note.textContent = t("لا يوجد تسجيل بعد"); return; }

    if (!optedIn()) {
        const ok = await confirmDownload();
        if (!ok) return;
        setOptedIn(true);
    }

    m.btn.disabled = true;
    clearMarks();
    try {
        await ensureReady((p) => setProgress(p.pct, (STAGE_TEXT[p.stage] || p.stage) + (p.detail ? ` · ${p.detail}` : "")));
        const done = once("findings", (p) => setProgress(p.pct, STAGE_TEXT[p.stage] || p.stage));
        /* The PCM is TRANSFERRED, not copied: a 90 s recording is ~5.8 MB and
         * structured-cloning it would double peak memory next to a 570 MB
         * model. The caller re-derives it from the recording if needed. */
        const buf = pcm.slice();
        spawn().postMessage({ type: "check", pcm: buf, range, options: m.ctx.options || {} }, [buf.buffer]);
        const res = await done;
        clearProgress();
        _findings = res.findings || [];
        paint(_findings, res.stats);
        cue(_findings.length ? "stopped" : "perfect");
    } catch (e) {
        fail(e);
        return;
    }
    m.btn.disabled = false;
}

function confirmDownload() {
    return new Promise((resolve) => {
        const el = document.createElement("div");
        el.className = "ts-deep-sheet";
        el.setAttribute("dir", "rtl");
        el.innerHTML =
            '<div class="ts-deep-card">' +
            "<h3>" + t("التدقيق العميق") + "</h3>" +
            "<p>" + t("يقرأ تلاوتك حرفًا حرفًا وحركةً حركة، ويخبرك أين اختلف نطقك عن المصحف.") + "</p>" +
            '<p class="ts-deep-warn">' + t(`يحتاج تنزيل نموذج بحجم ${MODEL_MB} ميغابايت — مرة واحدة فقط، ثم يعمل بلا إنترنت.`) + "</p>" +
            '<div class="ts-deep-acts">' +
            '<button type="button" class="ts-deep-no">' + t("ليس الآن") + "</button>" +
            '<button type="button" class="ts-deep-yes">' + t("تنزيل وبدء التدقيق") + "</button>" +
            "</div></div>";
        const close = (v) => { el.remove(); resolve(v); };
        el.querySelector(".ts-deep-no").addEventListener("click", () => close(false));
        el.querySelector(".ts-deep-yes").addEventListener("click", () => close(true));
        el.addEventListener("click", (e) => { if (e.target === el) close(false); });
        document.body.appendChild(el);
        requestAnimationFrame(() => el.classList.add("ts-deep-sheet--in"));
    });
}

/* ---------- marks on the page ---------- */
function spanFor(loc) {
    const m = _mounted;
    if (!m || !loc || !m.ctx.spanAt) return null;
    return m.ctx.spanAt(loc.vk, loc.pos);
}

export function clearMarks() {
    _findings = [];
    _pcmCache = null;
    document.querySelectorAll(".ts-deep-har, .ts-deep-con").forEach((n) => {
        n.classList.remove("ts-deep-har", "ts-deep-con");
        delete n.dataset.tsDeep;
    });
    closeCard();
}

function paint(findings, stats) {
    const m = _mounted;
    let marked = 0, unnamed = 0;
    findings.forEach((f, i) => {
        /* Some ayat cannot be attributed to a page word with confidence — the
         * Uthmani and page word numberings disagree there (the vocative joins,
         * the sajda markers). Marking the wrong word sends the reciter to
         * re-read something they said correctly, so nothing is marked and the
         * count is reported instead. */
        if (f.loc && f.loc.unreliable) { unnamed++; return; }
        const span = spanFor(f.loc);
        if (!span) return;
        span.classList.add(f.kind === "har" ? "ts-deep-har" : "ts-deep-con");
        span.dataset.tsDeep = String(i);
        marked++;
    });
    if (!m) return;
    const har = findings.filter((f) => f.kind === "har").length;
    const con = findings.length - har;
    m.note.textContent = findings.length
        ? t(`${findings.length} ملاحظة — ${har} حركة، ${con} حرف · اضغط الكلمة لترى التفصيل`)
        : t(`لا ملاحظات — ${stats ? stats.words : ""} كلمة سليمة`);
    m.row.classList.toggle("ts-deep--clean", findings.length === 0);
    if (unnamed) m.note.textContent += t(` · و${unnamed} في آيات لا يمكن تحديد كلمتها بدقة`);
}

/* Tap routing — the caller hands us the tapped element; we answer whether
 * it was ours, so the mushaf's own tap handling is untouched otherwise. */
export function handleTap(target) {
    const span = target && target.closest && target.closest("[data-ts-deep]");
    if (!span) return false;
    const f = _findings[Number(span.dataset.tsDeep)];
    if (!f) return false;
    openCard(span, f);
    return true;
}

const HARAKA = { "َ": "فتحة", "ِ": "كسرة", "ُ": "ضمة" };

function openCard(span, f) {
    closeCard();
    cue("reviewOpen");
    const el = document.createElement("div");
    el.className = "ts-deep-pop";
    el.setAttribute("dir", "rtl");
    const isHar = f.kind === "har";
    const exp = isHar ? (HARAKA[f.expected] || f.expected) : f.expected;
    const got = isHar ? (HARAKA[f.heard] || f.heard) : f.heard;
    el.innerHTML =
        '<div class="ts-deep-pop-kind">' + t(isHar ? "الحركة" : "الحرف") + "</div>" +
        '<div class="ts-deep-pop-row"><span class="ts-deep-ok">' + exp + "</span>" +
        '<span class="ts-deep-arrow">←</span>' +
        '<span class="ts-deep-bad">' + got + "</span></div>" +
        '<div class="ts-deep-pop-foot">' + t("الصواب") + " · " + t("ما سمعته") + "</div>" +
        (f.atS != null ? '<button type="button" class="ts-deep-play">' + PLAY + "<span>" + t("اسمع نفسك") + "</span></button>" : "");
    document.body.appendChild(el);
    _card = el;
    const play = el.querySelector(".ts-deep-play");
    if (play) play.addEventListener("click", (ev) => { ev.stopPropagation(); playAt(f.atS, play); });
    place(el, span);
    /* NOT {once:true}: a tap INSIDE the card would consume the listener and
     * leave the card permanently unclosable. The handler stays until it
     * actually closes something. */
    const off = (e) => { if (!el.contains(e.target)) closeCard(); };
    _cardOff = off;
    setTimeout(() => document.addEventListener("pointerdown", off), 0);
    requestAnimationFrame(() => el.classList.add("ts-deep-pop--in"));
}

export function closeCard() {
    if (_cardOff) { document.removeEventListener("pointerdown", _cardOff); _cardOff = null; }
    if (_player) { try { _player.stop(); } catch { } _player = null; }
    if (_card) { _card.remove(); _card = null; }
}

const PLAY = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>';

/* HEAR YOURSELF. Being told your ل came out as ر is instruction; hearing
 * it is learning, and it is the one thing no other app does. The position
 * is derived from the phoneme's rank in its 8 s window, not a real
 * alignment, so the span is padded generously on both sides rather than
 * cut exactly — a clip that starts a syllable late teaches nothing. */
const PLAY_PAD = 1.2;

async function playAt(atS, btn) {
    const m = _mounted;
    if (!m || !m.ctx.getPcm16k) return;
    try {
        if (_player) { try { _player.stop(); } catch { } _player = null; }
        // resampling a 90 s recording on every tap is a visible stall; the
        // check already produced this exact array, so hold on to it
        const pcm = _pcmCache || (_pcmCache = m.ctx.getPcm16k());
        if (!pcm || !pcm.length) return;
        const SR = 16000;
        const a = Math.max(0, Math.floor((atS - PLAY_PAD) * SR));
        const b = Math.min(pcm.length, Math.ceil((atS + PLAY_PAD) * SR));
        if (b - a < SR * 0.1) return;
        /* Built on demand and never while the mic is open — this only ever
         * runs after a session, so it cannot disturb a capture session (see
         * tasmee-sfx.js for why that matters on WKWebView). */
        if (!_actx) _actx = new (window.AudioContext || window.webkitAudioContext)();
        if (_actx.state === "suspended") await _actx.resume();
        const buf = _actx.createBuffer(1, b - a, SR);
        buf.copyToChannel(pcm.subarray(a, b), 0);
        const src = _actx.createBufferSource();
        src.buffer = buf;
        src.connect(_actx.destination);
        btn && btn.classList.add("ts-deep-play--on");
        src.onended = () => { btn && btn.classList.remove("ts-deep-play--on"); _player = null; };
        src.start();
        _player = src;
    } catch (e) { console.warn("[deep] playback", e); }
}

/* Positioned from the target's LIVE rect and hosted at the root — a naive
 * position:fixed child lands in the wrong place on WKWebView once the page
 * has scrolled (CLAUDE.md). */
function place(el, span) {
    const r = span.getBoundingClientRect();
    const w = el.offsetWidth, h = el.offsetHeight;
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = r.top - h - 10;
    if (top < 8) top = r.bottom + 10;
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
}

export function findings() { return _findings.slice(); }
export function dispose() {
    clearMarks();
    if (_actx) { try { _actx.close(); } catch { } _actx = null; }
    if (_worker) { _worker.terminate(); _worker = null; _ready = null; }
    if (_mounted) { _mounted.row.remove(); _mounted = null; }
}
