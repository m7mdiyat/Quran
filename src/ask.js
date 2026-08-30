/* سؤال الذكاء الاصطناعي — the grounded ask experience, ported from the native
 * app (m7mdiyat-native: src/lib/intent.ts, src/lib/citations.ts, state/ask.ts,
 * AnswerSheet.tsx). The port keeps the native contract exactly:
 *
 *   - POST /ai/stream {question, scope:"quran_tafsir", blocks:true, format:"json"}
 *     → SSE events `citations` (first), `field` (per COMPLETED field), `done`,
 *     `error`. `meta`/`final` are server narration and are dropped.
 *   - Every citation resolves through the local guard (bounds vs surahs.json,
 *     7-book whitelist). Zero resolvable citations → the answer NEVER renders;
 *     the honest no-evidence state does.
 *   - Verse text renders from the LOCAL corpus only — a verse marker carries
 *     two numbers, never text. quote_ar is kept for TAFSIR citations only.
 *   - [SRC:…] markers become pills, an unresolvable reference strikes its
 *     SENTENCE, and half-streamed marker syntax is held back so it never
 *     flashes on screen.
 */

"use strict";

/* ---------------- Deps (injected by app.js via initAsk) ---------------- */

let DEPS = {
  apiRoot: "",
  isValidRef: () => false,
  getBookLabel: () => "",
  getSurahName: () => "",
  getAyahText: () => "",
  getBasmala: () => "",
  openAyah: () => { },
  els: {},
};

const escapeHtml = (s = "") =>
  String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

/* ---------------- Digits ---------------- */

const ARABIC_INDIC = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"];

export function toArabicDigits(n) {
  return String(n).replace(/\d/g, (d) => ARABIC_INDIC[Number(d)]);
}

/* Both Arabic-Indic families: U+0660-0669 (what the app prints) AND
 * U+06F0-06F9 (what an Urdu/Persian keyboard types). */
export function toLatinDigits(s) {
  return String(s)
    .replace(/[٠-٩]/g, (d) => String(ARABIC_INDIC.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/* ---------------- Intent (search vs ask) ---------------- */

export const INTENT_MIN_CHARS = 2;

/* Arabic harakat + tatweel, stripped before matching so "لِمَ" matches "لم". */
const DIACRITICS = /[ً-ْٰـ]/g;

const INTERROGATIVES = new Set([
  "هل", "ما", "ماذا", "لماذا", "لم", "كيف", "أين", "اين", "متى", "كم",
  "أي", "اي", "أية", "اية", "من", "علام", "فيم", "بم", "عم", "أليس", "اليس",
]);

const QUESTION_MARK = /[?؟]/;

/* A verse reference like `2:255` / `٢:٢٥٥` is navigation — never an ask. */
const REFERENCE = /^\s*[\d٠-٩۰-۹]{1,3}\s*[:：]\s*[\d٠-٩۰-۹]{1,3}\s*$/;

export function isReference(text) {
  return REFERENCE.test(String(text || ""));
}

/* Question mark → ask; FRONTED interrogative → ask; everything else →
 * search. First-token only: «من» mid-sentence is "from", «ما» is a negation
 * particle — firing on them anywhere would read «آيات من البقرة» as a
 * question. The zero-results empty state carries the correction path. */
export function inferIntent(text) {
  const raw = String(text || "");
  const t = raw.replace(DIACRITICS, "").trim();
  if (isReference(raw)) return "search";
  if (t.length < INTENT_MIN_CHARS) return "search";
  if (QUESTION_MARK.test(t)) return "ask";
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > 0 && INTERROGATIVES.has(words[0])) return "ask";
  return "search";
}

/* ---------------- Citation guard ---------------- */

const QURAN_RE = /^QURAN:(\d{1,3}):(\d{1,3})$/i;
const TAFSIR_RE = /^TAFSIR:([a-z_]+):(\d{1,3}):(\d{1,3})$/i;

/* Digits folded first: the model writes Arabic prose, and «QURAN:٢:٢٥٥» names
 * a real ayah. Folding cannot weaken the guard — isValidRef against the local
 * corpus stays the sole authority (٢:٣٠٠ is still rejected). */
export function resolveCitations(raw) {
  const resolved = [];
  const rejected = [];
  const seen = new Set();

  if (!Array.isArray(raw)) return { resolved, rejected };

  for (const entry of raw) {
    const sourceId =
      typeof entry === "string" ? entry :
        typeof entry?.source_id === "string" ? entry.source_id : "";

    if (!sourceId) { rejected.push({ sourceId: "", reason: "no source_id" }); continue; }
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);

    const note = typeof entry?.note === "string" ? entry.note : undefined;
    const quoteAr =
      typeof entry?.quote_ar === "string" && entry.quote_ar.trim() !== ""
        ? entry.quote_ar : undefined;

    const id = toLatinDigits(sourceId);

    const q = QURAN_RE.exec(id);
    if (q) {
      const surah = Number(q[1]);
      const ayah = Number(q[2]);
      if (!DEPS.isValidRef(surah, ayah)) {
        rejected.push({ sourceId, reason: `out of bounds (${surah}:${ayah})` });
        continue;
      }
      // quote_ar deliberately NOT carried — verse text renders only from the
      // local corpus, never out of the model's mouth.
      resolved.push({ sourceId, kind: "quran", surah, ayah, note });
      continue;
    }

    const t = TAFSIR_RE.exec(id);
    if (t) {
      const bookKey = t[1].toLowerCase();
      const surah = Number(t[2]);
      const ayah = Number(t[3]);
      const bookLabel = DEPS.getBookLabel(bookKey);
      if (!bookLabel) {
        rejected.push({ sourceId, reason: `unknown tafsir book "${bookKey}"` });
        continue;
      }
      if (!DEPS.isValidRef(surah, ayah)) {
        rejected.push({ sourceId, reason: `out of bounds (${surah}:${ayah})` });
        continue;
      }
      resolved.push({ sourceId, kind: "tafsir", surah, ayah, bookKey, bookLabel, note, quoteAr });
      continue;
    }

    if (/^(HADITH|BOOK):/i.test(id)) {
      // Recognised and refused: with scope:"quran_tafsir" this is a scope
      // failure worth seeing in the console, not a parse failure to shrug at.
      rejected.push({ sourceId, reason: "out of scope (quran + tafsir only)" });
      continue;
    }

    rejected.push({ sourceId, reason: "unrecognised source_id shape" });
  }

  return { resolved, rejected };
}

export function hasEvidence(result) {
  return result.resolved.length > 0;
}

/* Maximal digit runs either side of a colon, all three digit systems — no
 * boundaries on purpose ("234:567" inside "1234:5678" must NOT pill), length
 * is validated after the match instead of via lookbehind. */
const INLINE_REF_RE = /[\d٠-٩۰-۹]+:[\d٠-٩۰-۹]+/g;

function findInlineRefs(prose) {
  const out = [];
  for (const m of prose.matchAll(INLINE_REF_RE)) {
    const [left, right] = m[0].split(":");
    if (left.length < 1 || left.length > 3 || right.length < 1 || right.length > 3) continue;
    const surah = Number(toLatinDigits(left));
    const ayah = Number(toLatinDigits(right));
    out.push({
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      surah, ayah,
      valid: DEPS.isValidRef(surah, ayah),
    });
  }
  return out;
}

/* Terminators Arabic prose actually ends on. «؛» is NOT one — it joins
 * clauses, and dimming half a sentence would read as a rendering bug. */
const SENTENCE_END = /[.!?؟۔…\n]/;

function sentenceRange(text, at) {
  let start = 0;
  for (let i = Math.min(at, text.length) - 1; i >= 0; i--) {
    if (SENTENCE_END.test(text[i])) { start = i + 1; break; }
  }
  while (start < text.length && /\s/.test(text[start])) start++;
  let end = text.length;
  for (let i = at; i < text.length; i++) {
    if (SENTENCE_END.test(text[i])) { end = i + 1; break; }
  }
  return { start, end: Math.max(end, Math.min(at + 1, text.length)) };
}

const SRC_MARKER_RE = /\[SRC:(QURAN|TAFSIR)(?::([a-z_]+))?:([\d٠-٩۰-۹]{1,3}):([\d٠-٩۰-۹]{1,3})\]/gi;
/* The coarse net — any bracketed SRC blob, so a malformed one is still FOUND
 * (and stripped) rather than left raw because the precise regex refused it. */
const SRC_ANY_RE = /\[SRC:[^\]\n]{0,80}\]/gi;
/* A trailing, still-streaming marker — held back so raw syntax never flashes.
 * Charset is the marker alphabet only, so a legitimate bracket opening Arabic
 * prose does not match. */
const PARTIAL_SRC_RE = /\[(?:S(?:R(?:C(?::[A-Za-z_:\d٠-٩۰-۹]{0,60})?)?)?)?$/;

function findSrcMarkers(text) {
  const out = [];
  for (const m of text.matchAll(SRC_ANY_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    SRC_MARKER_RE.lastIndex = 0;
    const p = SRC_MARKER_RE.exec(m[0]);
    if (!p || p.index !== 0 || p[0].length !== m[0].length) {
      out.push({ start, end, kind: "strip" });
      continue;
    }
    const family = p[1].toUpperCase();
    const bookKey = p[2] ? p[2].toLowerCase() : undefined;
    const surah = Number(toLatinDigits(p[3]));
    const ayah = Number(toLatinDigits(p[4]));
    if (family === "TAFSIR" && !bookKey) { out.push({ start, end, kind: "strip" }); continue; }
    if (!DEPS.isValidRef(surah, ayah)) { out.push({ start, end, kind: "badref" }); continue; }
    const label = bookKey ? DEPS.getBookLabel(bookKey) || undefined : undefined;
    out.push({ start, end, kind: "pill", surah, ayah, label });
  }
  return out;
}

/* slice with every marker's syntax cut out — struck sentences and plain text
 * must never carry `[SRC:…]` verbatim. */
function scrub(text, a, b, markers) {
  let s = "";
  let at = a;
  for (const m of markers) {
    if (m.end <= a || m.start >= b) continue;
    s += text.slice(at, Math.max(m.start, a));
    at = Math.min(m.end, b);
  }
  s += text.slice(at, b);
  return s.replace(/[ \t]{2,}/g, " ").replace(/ ([.،؛؟!])/g, "$1");
}

/* The last line of defence for text that is NOT rendered as prose (quote
 * cards, labels): whatever the model wrote, no marker syntax survives. */
export function stripSrcMarkers(input) {
  if (!input) return "";
  const partial = PARTIAL_SRC_RE.exec(input);
  const held = partial ? input.slice(0, partial.index) : input;
  return held
    .replace(SRC_ANY_RE, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ ([.،؛؟!])/g, "$1")
    .trim();
}

export function proseSpans(input) {
  const partial = PARTIAL_SRC_RE.exec(input);
  const text = partial ? input.slice(0, partial.index) : input;

  const markers = findSrcMarkers(text);
  const inMarker = (i) => markers.some((m) => i >= m.start && i < m.end);
  // Bare references INSIDE a marker are the marker's own tail, not a second
  // citation.
  const refs = findInlineRefs(text).filter((r) => !inMarker(r.start));

  if (!markers.length && !refs.length) return [{ kind: "text", text }];

  // Every sentence carrying an unresolvable reference, merged — two bad
  // references in one sentence strike it once.
  const badAt = [
    ...refs.filter((r) => !r.valid).map((r) => r.start),
    ...markers.filter((mk) => mk.kind === "badref").map((mk) => mk.start),
  ].sort((x, y) => x - y);
  const struck = [];
  for (const at of badAt) {
    const s = sentenceRange(text, at);
    const last = struck[struck.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else struck.push({ ...s });
  }
  const inStruck = (i) => struck.some((s) => i >= s.start && i < s.end);

  const marks = [
    ...struck.map((s) => ({
      start: s.start, end: s.end,
      span: { kind: "struck", text: scrub(text, s.start, s.end, markers) },
    })),
    // A VALID pill inside a struck sentence is deliberately not a pill: an
    // accent capsule would be the brightest thing in the one paragraph the
    // reader is being told not to rely on.
    ...refs
      .filter((r) => r.valid && !inStruck(r.start))
      .map((r) => ({
        start: r.start, end: r.end,
        span: { kind: "pill", text: text.slice(r.start, r.end), surah: r.surah, ayah: r.ayah },
      })),
    ...markers
      .filter((mk) => mk.kind === "pill" && !inStruck(mk.start))
      .map((mk) => ({
        start: mk.start, end: mk.end,
        span: {
          kind: "pill",
          // The DISPLAY form, never the raw slice — no span leaving this
          // function carries `[SRC:` syntax.
          text: mk.label ? `${mk.label} ${mk.surah}:${mk.ayah}` : `${mk.surah}:${mk.ayah}`,
          surah: mk.surah, ayah: mk.ayah, label: mk.label,
        },
      })),
    ...markers
      .filter((mk) => mk.kind === "strip" && !inStruck(mk.start))
      .map((mk) => ({ start: mk.start, end: mk.end, span: { kind: "text", text: "" } })),
  ].sort((a, b) => a.start - b.start);

  const out = [];
  let at = 0;
  for (const m of marks) {
    if (m.start > at) out.push({ kind: "text", text: scrub(text, at, m.start, markers) });
    if (!(m.span.kind === "text" && m.span.text === "")) out.push(m.span);
    at = m.end;
  }
  if (at < text.length) out.push({ kind: "text", text: scrub(text, at, text.length, markers) });
  return out;
}

/* Prose/verse alternation: `[[VERSE:QURAN:2:153]]` on its own line marks
 * where a verse renders — two numbers, never text. A partial trailing marker
 * is held back (`pending`) so raw syntax never flashes mid-stream. */
const VERSE_MARKER_RE = /\[\[VERSE:QURAN:(\d{1,3}):(\d{1,3})\]\]/g;
const PARTIAL_MARKER_RE = /\[\[(?:V(?:E(?:R(?:S(?:E)?)?)?)?)?(?::(?:Q(?:U(?:R(?:A(?:N)?)?)?)?)?(?::[\d]{0,3}(?::[\d]{0,3})?)?)?$/;

export function splitBlocks(prose) {
  const partial = prose.match(PARTIAL_MARKER_RE);
  const pending = !!partial;
  const text = pending ? prose.slice(0, partial.index) : prose;

  const blocks = [];
  let at = 0;
  for (const m of text.matchAll(VERSE_MARKER_RE)) {
    const start = m.index ?? 0;
    const before = text.slice(at, start).trim();
    if (before) blocks.push({ kind: "prose", text: before });
    blocks.push({ kind: "verse", surah: Number(m[1]), ayah: Number(m[2]) });
    at = start + m[0].length;
  }
  const tail = text.slice(at).trim();
  if (tail) blocks.push({ kind: "prose", text: tail });

  return { blocks, pending };
}

/* ---------------- SSE transport ---------------- */

/* fetch + getReader (the site already streams /compare this way). Frames are
 * separated by a blank line; anything after the last "\n\n" is a partial
 * frame and stays in the buffer — parsing it would hand the UI half a JSON
 * object. `meta`/`final` are dropped: the client's event union stays exactly
 * the set of things that change what is on screen. */
async function askStream(question, { onEvent, signal }) {
  const response = await fetch(`${DEPS.apiRoot}/ai/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
    body: JSON.stringify({
      question,
      // The three flags the backend patches added. `scope` keeps retrieval to
      // Quran + the 7 tafsir books; `blocks` places verses inline; `format:
      // "json"` selects the streaming path that carries citations at all.
      scope: "quran_tafsir",
      blocks: true,
      format: "json",
    }),
    signal,
  });
  if (!response.ok) throw new Error(`ask: HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("ask: no stream body");

  const decoder = new TextDecoder();
  let buffer = "";
  for (; ;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let name = "";
      const dataLines = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) name = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (name !== "citations" && name !== "field" && name !== "done" && name !== "error") continue;
      try {
        onEvent({ type: name, ...JSON.parse(dataLines.join("\n")) });
      } catch {
        // A frame that will not parse is one frame lost, not a dead stream.
      }
    }
  }
}

/* ---------------- Answer cache (localStorage, MRU cap 30) ---------------- */

const CACHE_PREFIX = "ai:ans:";
const CACHE_INDEX_KEY = "ai:ans:index";
const CACHE_CAP = 30;

const cacheKey = (q) => CACHE_PREFIX + String(q).trim().replace(/\s+/g, " ");

function getCachedAnswer(question) {
  try {
    const raw = localStorage.getItem(cacheKey(question));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && parsed.v && typeof parsed.v.prose === "string" ? parsed.v : null;
  } catch { return null; }
}

/* `sources` are the RAW citation shapes — never resolved objects and never
 * verse text. A cached answer re-enters through resolveCitations exactly like
 * a live one, so the guard is in the path both times. */
function saveCachedAnswer(question, answer) {
  try {
    const key = cacheKey(question);
    localStorage.setItem(key, JSON.stringify({ t: Date.now(), v: answer }));
    let index = [];
    try { index = JSON.parse(localStorage.getItem(CACHE_INDEX_KEY) || "[]"); } catch { }
    if (!Array.isArray(index)) index = [];
    index = index.filter((k) => k !== key);
    index.push(key);
    while (index.length > CACHE_CAP) {
      const evict = index.shift();
      try { localStorage.removeItem(evict); } catch { }
    }
    localStorage.setItem(CACHE_INDEX_KEY, JSON.stringify(index));
  } catch { }
}

/* ---------------- State machine ---------------- */

/* idle → sending → (slow @4s: only the beam slows) → streaming →
 * done | error | no-evidence. A new ask cancels the previous one. */
const SLOW_AFTER_MS = 4000;

const S = {
  phase: "idle",
  question: "",
  citations: [],
  rejected: [],
  prose: "",
  keyPoints: [],
  differences: [],
  error: null,
  fromCache: false,
  copied: false,
};

let controller = null;
let slowTimer = null;
let rawSources = [];

function clearSlowTimer() {
  if (slowTimer) { clearTimeout(slowTimer); slowTimer = null; }
}

function setState(patch) {
  Object.assign(S, patch);
  render();
}

function cancelAsk() {
  clearSlowTimer();
  controller?.abort();
  controller = null;
}

export function askQuestion(rawQuestion, { bypassCache = false } = {}) {
  const question = String(rawQuestion || "").trim();
  const els = DEPS.els;
  if (!question) {
    if (els.status) els.status.textContent = "اكتب سؤالك أولاً";
    els.question?.focus();
    return;
  }
  if (els.status) els.status.textContent = "";
  if (els.question && els.question.value !== question) els.question.value = question;

  cancelAsk();

  if (!bypassCache) {
    const cached = getCachedAnswer(question);
    if (cached) { restoreAnswer(question, cached); return; }
  }

  controller = new AbortController();
  const signal = controller.signal;
  rawSources = [];

  Object.assign(S, {
    phase: "sending", question,
    citations: [], rejected: [], prose: "", keyPoints: [], differences: [],
    error: null, fromCache: false, copied: false,
  });
  render();

  // The 4-second mark: exactly one thing changes — the beam slows. No copy,
  // no retry, no cancel band.
  slowTimer = setTimeout(() => {
    if (S.phase === "sending") setState({ phase: "slow" });
  }, SLOW_AFTER_MS);

  const onEvent = (e) => {
    if (signal.aborted) return;
    switch (e.type) {
      case "citations": {
        rawSources = Array.isArray(e.citations) ? e.citations : [];
        const r = resolveCitations(rawSources);
        clearSlowTimer();
        if (r.rejected.length) console.warn("ask: rejected citations", r.rejected);
        if (!hasEvidence(r)) {
          // Zero resolvable citations → the answer never enters the view —
          // even though prose is still on its way. The decision is about
          // evidence, not about whether text arrived.
          setState({ phase: "no-evidence", citations: [], rejected: r.rejected });
          controller?.abort();
          return;
        }
        setState({ phase: "streaming", citations: r.resolved, rejected: r.rejected });
        return;
      }
      case "field": {
        if (S.phase === "no-evidence") return;
        if (e.name === "arabic_answer" && typeof e.value === "string") {
          setState({ prose: e.value, phase: "streaming" });
        } else if (e.name === "key_points_ar" && Array.isArray(e.value)) {
          setState({ keyPoints: e.value.filter((x) => typeof x === "string") });
        } else if (e.name === "tafsir_differences_ar" && Array.isArray(e.value)) {
          setState({ differences: e.value.filter((x) => typeof x === "string") });
        }
        return;
      }
      case "done": {
        clearSlowTimer();
        if (S.phase === "no-evidence") return;
        // The done payload's citation list is the authoritative, re-checked
        // set — prefer it for the cache so a restore resolves what shipped.
        if (Array.isArray(e.ai?.citations) && e.ai.citations.length) rawSources = e.ai.citations;
        setState({ phase: "done" });
        saveCachedAnswer(S.question, {
          prose: S.prose,
          keyPoints: S.keyPoints,
          differences: S.differences,
          sources: rawSources,
        });
        return;
      }
      case "error": {
        clearSlowTimer();
        setState({ phase: "error", error: String(e.error || "") });
        return;
      }
    }
  };

  askStream(question, { onEvent, signal })
    .then(() => {
      if (signal.aborted) return;
      // Stream ended without a done and without citations: retrieval failed
      // server-side. Nothing resolvable arrived — the honest state.
      if (S.phase === "sending" || S.phase === "slow") {
        clearSlowTimer();
        setState({ phase: "no-evidence" });
      }
    })
    .catch((err) => {
      if (signal.aborted) return;
      clearSlowTimer();
      console.error("ask:", err);
      setState({ phase: "error", error: String(err) });
    });
}

/* Re-open a SAVED answer — no network, straight to done (or to no-evidence,
 * if the cached sources no longer resolve; the guard holds for the cache
 * too). */
function restoreAnswer(question, answer) {
  rawSources = Array.isArray(answer.sources) ? answer.sources : [];
  const r = resolveCitations(rawSources);
  if (!hasEvidence(r)) {
    Object.assign(S, {
      phase: "no-evidence", question,
      citations: [], rejected: r.rejected, prose: "", keyPoints: [], differences: [],
      error: null, fromCache: true, copied: false,
    });
  } else {
    Object.assign(S, {
      phase: "done", question,
      citations: r.resolved, rejected: r.rejected,
      prose: answer.prose,
      keyPoints: Array.isArray(answer.keyPoints) ? answer.keyPoints : [],
      differences: Array.isArray(answer.differences) ? answer.differences : [],
      error: null, fromCache: true, copied: false,
    });
  }
  render();
}

/* ---------------- Renderer (owns #aiResults) ---------------- */

const beamLive = () => S.phase === "sending" || S.phase === "slow" || S.phase === "streaming";

function pillHtml(span) {
  return `<button type="button" class="ai-ref-pill" data-ai-open data-s="${span.surah}" data-a="${span.ayah}">${escapeHtml(span.text)}</button>`;
}

function proseHtml(text) {
  return proseSpans(text)
    .map((sp) => {
      if (sp.kind === "pill") return pillHtml(sp);
      if (sp.kind === "struck") return `<span class="ai-struck">${escapeHtml(sp.text)}</span>`;
      return escapeHtml(sp.text);
    })
    .join("");
}

function verseCardHtml(surah, ayah) {
  const text = DEPS.isValidRef(surah, ayah) ? DEPS.getAyahText(surah, ayah) : "";
  if (!text) {
    // An unresolvable verse marker is a VISIBLE failure, not a silent drop.
    return `<div class="ai-verse-missing">مرجع غير موجود في المصحف · ${escapeHtml(`${surah}:${ayah}`)}</div>`;
  }
  const basmala = DEPS.getBasmala(surah, ayah);
  const full = basmala ? `${basmala} ${text}` : text;
  const surahName = DEPS.getSurahName(surah);
  return `
    <button type="button" class="ai-verse-card2" data-ai-open data-s="${surah}" data-a="${ayah}"
      aria-label="افتح الآية ${escapeHtml(surahName)} ${ayah}">
      <div class="ai-verse-text quran-font">${escapeHtml(full)}</div>
      <div class="ai-open-band">
        <span class="ai-verse-ref">${toArabicDigits(surah)}:${toArabicDigits(ayah)}</span>
        <span class="ai-verse-surah">${escapeHtml(surahName)}</span>
        <span class="ai-open-spacer"></span>
        <span class="ai-open-label">افتح الآية</span>
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5"
          stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>
      </div>
    </button>`;
}

/* The copy payload: prose with verse markers resolved back to plain
 * references, the deduped refs under it — never the rendered scripture. The
 * local corpus holds the only copy of an ayah's text this app trusts. */
function buildCopyText() {
  const body = splitBlocks(S.prose)
    .blocks.map((b) => (b.kind === "verse" ? `[${b.surah}:${b.ayah}]` : b.text))
    .join("\n")
    .trim();
  const cited = [...new Map(S.citations.map((c) => [`${c.surah}:${c.ayah}`, c])).values()];
  const refs = cited.map((c) => `${c.surah}:${c.ayah}`).join(" · ");
  return [S.question, "", body, refs ? `\n${refs}` : "", "يُجيب من القرآن، ولا يُفتي."]
    .join("\n")
    .trim();
}

function render() {
  const root = DEPS.els.results;
  if (!root) return;

  if (S.phase === "idle") { root.innerHTML = ""; return; }

  const parts = [];

  if (S.phase === "error") {
    parts.push(`<div class="ai-noev"><div class="ai-noev-title">تعذّر إكمال الإجابة</div></div>`);
  } else if (S.phase === "no-evidence") {
    parts.push(`
      <div class="ai-noev">
        <div class="ai-noev-title">لم نجد آيات تسند هذه الإجابة</div>
        <div class="ai-noev-sub">لا نعرض إجابة لا تستند إلى المصحف</div>
      </div>`);
  } else {
    const waiting = (S.phase === "sending" || S.phase === "slow") && !S.prose;
    if (waiting) {
      // Three static bars — no shimmer ("a shimmer is a spinner that has
      // learned to pulse").
      parts.push(`
        <div class="ai-skel" aria-hidden="true">
          <div class="ai-skel-bar" style="width:100%"></div>
          <div class="ai-skel-bar" style="width:92%"></div>
          <div class="ai-skel-bar ai-skel-bar--dim" style="width:64%"></div>
        </div>`);
    }

    if (S.prose) {
      for (const b of splitBlocks(S.prose).blocks) {
        if (b.kind === "verse") parts.push(verseCardHtml(b.surah, b.ayah));
        else parts.push(`<p class="ai-prose" dir="rtl">${proseHtml(b.text)}</p>`);
      }
    } else if (S.citations.length) {
      // Citations arrive long before prose — render the cited verses from the
      // local corpus now, so the wait becomes reading time.
      const seen = new Set();
      for (const c of S.citations) {
        const key = `${c.surah}:${c.ayah}`;
        if (seen.has(key)) continue;
        seen.add(key);
        parts.push(verseCardHtml(c.surah, c.ayah));
      }
    }

    for (const k of S.keyPoints) {
      parts.push(`<p class="ai-prose ai-keypoint" dir="rtl">${proseHtml(k)}</p>`);
    }

    // من التفاسير — the scholars' exact words (verbatim-checked server-side).
    // A quote card is not prose and must not grow pills: scrubbed, not parsed.
    const quoted = S.citations.filter((c) => c.kind === "tafsir" && c.quoteAr);
    if (quoted.length) {
      parts.push(`<div class="ai-eyebrow">من التفاسير</div>`);
      for (const c of quoted) {
        parts.push(`
          <div class="ai-quote-card">
            <div class="ai-quote-head">
              <span class="ai-quote-book">${escapeHtml(c.bookLabel)}</span>
              <span class="ai-open-spacer"></span>
              <button type="button" class="ai-ref-pill" data-ai-open data-s="${c.surah}" data-a="${c.ayah}">${c.surah}:${c.ayah}</button>
            </div>
            <div class="ai-quote-row">
              <span class="ai-quote-rule" aria-hidden="true"></span>
              <span class="ai-quote-text">«${escapeHtml(stripSrcMarkers(c.quoteAr))}»</span>
            </div>
          </div>`);
      }
    }

    if (S.differences.length) {
      parts.push(`<div class="ai-eyebrow">بين التفاسير</div>`);
      for (const d of S.differences) {
        parts.push(`<p class="ai-prose ai-diff" dir="rtl">· ${proseHtml(d)}</p>`);
      }
    }

    if (beamLive()) {
      // The streaming tell. The caret does not blink — a blinking caret in a
      // reading surface is noise.
      parts.push(`
        <div class="ai-typing" aria-hidden="true">
          <span class="ai-caret"></span>
          <span>يكتب…</span>
        </div>`);
    }
  }

  const footerActions = [];
  if (S.phase === "done" && S.prose) {
    footerActions.push(`
      <button type="button" class="ai-footer-action" data-ai-copy
        aria-label="${S.copied ? "نُسخت الإجابة" : "نسخ الإجابة"}">
        ${S.copied
        ? `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>`
        : `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`}
      </button>`);
  }
  if (S.fromCache) {
    footerActions.push(`
      <button type="button" class="ai-footer-retry" data-ai-retry>إجابة محفوظة · إعادة السؤال</button>`);
  }

  const beamAttrs = beamLive()
    ? ` data-active${S.phase === "slow" ? " data-slow" : ""}`
    : "";

  root.innerHTML = `
    <div class="border-beam ai-beam"${beamAttrs}>
      <div class="ai-answer-card glass rounded-2xl" dir="rtl">
        <div class="ai-answer-head">
          <div class="ai-eyebrow">جلسة تدبرية</div>
          <div class="ai-answer-question">${escapeHtml(S.question)}</div>
        </div>
        <div class="ai-answer-body">${parts.join("")}</div>
        <div class="ai-answer-footer">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
          <span>يُجيب من القرآن، ولا يُفتي.</span>
          <span class="ai-open-spacer"></span>
          ${footerActions.join("")}
        </div>
      </div>
      <div data-beam-bloom aria-hidden="true"></div>
    </div>`;
}

/* ---------------- Panel plumbing ---------------- */

function openPanel() {
  const { panel, toggleBtn } = DEPS.els;
  if (panel && panel.dataset.open !== "1") toggleBtn?.click();
}

export function openAskPanelWith(question) {
  const els = DEPS.els;
  if (els.question) els.question.value = String(question || "");
  openPanel();
  try { els.panel?.scrollIntoView({ behavior: "smooth", block: "start" }); } catch { }
  askQuestion(question);
}

export function initAsk(deps) {
  DEPS = { ...DEPS, ...deps, els: { ...(deps.els || {}) } };
  const els = DEPS.els;

  els.askBtn?.addEventListener("click", () => askQuestion(els.question?.value));
  els.question?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      askQuestion(els.question.value);
    }
  });
  els.clearBtn?.addEventListener("click", () => {
    cancelAsk();
    if (els.question) els.question.value = "";
    if (els.status) els.status.textContent = "";
    setState({ phase: "idle" });
    els.question?.focus();
  });

  // The container re-renders per event, so clicks are delegated once here.
  els.results?.addEventListener("click", (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const open = target.closest("[data-ai-open]");
    if (open) {
      const s = Number(open.getAttribute("data-s"));
      const a = Number(open.getAttribute("data-a"));
      if (Number.isFinite(s) && Number.isFinite(a)) DEPS.openAyah(s, a);
      return;
    }
    if (target.closest("[data-ai-copy]")) {
      try { navigator.clipboard?.writeText(buildCopyText()); } catch { }
      setState({ copied: true });
      return;
    }
    if (target.closest("[data-ai-retry]")) {
      askQuestion(S.question, { bypassCache: true });
    }
  });
}
