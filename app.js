/* Offline Quran Search + Context + Tafsir + English (Sahih)
   Offline files:
   - quran.json, surahs.json
   - tafseer_*.json (nested or other supported shapes)
   - en.sahih.json (array of {index,text} OR array of strings)
*/

const el = id => document.getElementById(id);

const textSearch = el("textSearch");
const resultsShell = el("resultsShell");
const results    = el("results");
const selectedChip = el("selectedChip");
const chipTitle = el("chipTitle");
const chipSnippet = el("chipSnippet");
const chipIcon = el("chipIcon");
const clearBtn = el("clearBtn");

const ayahContext   = el("ayahContext");
const contextHeader = el("contextHeader");
const contextBlock  = el("contextBlock");
const langSelect    = el("langSelect");

const tafsirHeader = el("tafsirHeader");
const tafsirSelect = el("tafsirSelect");
const tafsirTitle  = el("tafsirTitle");
const tafsirBox    = el("tafsirBox");
const tafsirMetaAyah = el("tafsirMetaAyah");
const tafsirMetaInterpreter = el("tafsirMetaInterpreter");
const tafsirAyahTag = el("tafsirAyahTag");
const tafsirSection = el("tafsirSection");
const themeToggle  = el("themeToggle");
const themeLabel   = el("themeLabel");

let SURAH_META = [];
let QURAN = null;
let INDEX = [];
let CURRENT = null;
let LAST_RESULTS = [];

// Context window state: keep list static until hitting edges
let CONTEXT_STATE = {
  surah: null,
  start: 1,
  end: 0
};

// Tafsir packs: { key: {label, data:{s:{a:text}} } }
let TAFSIRS = {};

// English map: { "s": { "a": "text" } }
let EN_MAP = null;

// Themes
const THEMES = [
  { id: "emerald", label: "Emerald • Gold" },
  { id: "aqua",    label: "Aqua Blue" }
];
let CURRENT_THEME = THEMES[0].id;

function applyTheme(themeId){
  const theme = THEMES.find(t => t.id === themeId) || THEMES[0];
  CURRENT_THEME = theme.id;
  document.body.dataset.theme = theme.id;
  if(themeLabel) themeLabel.textContent = theme.label;
  themeToggle?.setAttribute("aria-label", `تغيير الثيم (الحالي: ${theme.label})`);
  try{
    localStorage.setItem("theme", theme.id);
  }catch{}
}

function cycleTheme(){
  const idx = THEMES.findIndex(t => t.id === CURRENT_THEME);
  const next = THEMES[(idx + 1) % THEMES.length];
  applyTheme(next.id);
}

function initTheme(){
  let saved = null;
  try{
    saved = localStorage.getItem("theme");
  }catch{}
  applyTheme(saved || CURRENT_THEME);
  themeToggle?.addEventListener("click", cycleTheme);
}

function escapeHtml(str=""){
  return str
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;")
    .replace(/'/g,"&#039;");
}

function escapeRegex(str=""){
  return str.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
}

function normArabic(s){
  return (s||"")
    .replace(/[\u064B-\u065F\u0610-\u061A\u06D6-\u06ED]/g,"")
    .replace(/[ٱأإآ]/g,"ا")
    .replace(/ى/g,"ي")
    .replace(/ؤ/g,"و")
    .replace(/ئ/g,"ي")
    .replace(/ة/g,"ه")
    .replace(/[^\u0600-\u06FF0-9\s]/g," ")
    .replace(/\s+/g," ")
    .trim();
}

async function loadJson(path){
  const r = await fetch(path,{cache:"no-store"});
  if(!r.ok) throw new Error(path);
  return r.json();
}

function normalizeQuran(raw){
  const surahs = raw?.data?.surahs || raw?.surahs || raw;
  return {
    surahs: surahs.map(s=>({
      number:Number(s.number),
      name_ar:s.name_ar||s.name,
      ayahs:(s.ayahs||[]).map(a=>({
        numberInSurah:Number(a.numberInSurah),
        text:a.text
      }))
    }))
  };
}

function buildIndex(){
  INDEX = [];
  for(const s of QURAN.surahs){
    for(const a of s.ayahs){
      INDEX.push({
        s:s.number,
        a:a.numberInSurah,
        textRaw:a.text,
        textNorm:normArabic(a.text)
      });
    }
  }
}

/* ---- Tafsir normalizer (accepts many shapes) ---- */
function normalizeTafsir(raw){
  const out = {}; // {s:{a:text}}

  const put = (s, a, text) => {
    if (s == null || a == null) return;
    const ss = String(s).replace(/^0+/,"") || "0";
    const aa = String(a).replace(/^0+/,"") || "0";
    const tt = (text == null) ? "" : String(text).trim();
    if (!tt) return;
    out[ss] ??= {};
    out[ss][aa] = tt;
  };

  // 1) Array forms
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

  // 2) Object forms
  if (raw && typeof raw === "object") {
    const keys = Object.keys(raw);
    if (!keys.length) return out;

    // 2a) key "s:a" => "text"
    const sampleKey = keys[0];
    if (sampleKey.includes(":") && typeof raw[sampleKey] !== "object") {
      for (const k of keys) {
        const [s, a] = String(k).split(":");
        put(s, a, raw[k]);
      }
      return out;
    }

    // 2b) nested: {"s": {"a": "text"}} (with wrappers)
    const unwrap = (obj) => obj?.data ?? obj?.tafsir ?? obj?.result ?? obj?.results ?? obj;
    const candidate = unwrap(raw);

    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      for (const sKey of Object.keys(candidate)) {
        const inner = candidate[sKey];
        if (inner && typeof inner === "object" && !Array.isArray(inner)) {
          for (const aKey of Object.keys(inner)) {
            put(sKey, aKey, inner[aKey]);
          }
        }
      }
      if (Object.keys(out).length) return out;
    }

    // 2c) fallback: "s:a" but value is object with text field
    if (sampleKey.includes(":") && typeof raw[sampleKey] === "object") {
      for (const k of keys) {
        const [s, a] = String(k).split(":");
        const v = raw[k];
        const t = v?.text ?? v?.tafsir ?? v?.content ?? v?.value;
        put(s, a, t);
      }
      return out;
    }
  }

  return out;
}

function getTafsir(tafsirObj, surahNo, ayahNo){
  if(!tafsirObj) return null;
  return tafsirObj?.[String(surahNo)]?.[String(ayahNo)] || null;
}

/* ---- English mapping (order-based -> {s:{a:text}} ) ---- */
function buildEnglishMap(enRaw){
  const out = {};
  if(!enRaw || !QURAN) return out;

  // normalize to array of strings in order
  let arr = [];
  if(Array.isArray(enRaw)){
    if(enRaw.length && typeof enRaw[0] === "string"){
      arr = enRaw;
    } else {
      arr = enRaw.map(x => (x?.text ?? "").toString());
    }
  } else {
    return out;
  }

  let i = 0;
  for(const s of QURAN.surahs){
    const sKey = String(s.number);
    out[sKey] ??= {};
    for(const a of s.ayahs){
      const aKey = String(a.numberInSurah);
      out[sKey][aKey] = (arr[i] ?? "").toString().trim();
      i++;
    }
  }
  return out;
}

/* ---- Search ---- */
function searchText(q){
  if(!QURAN) return [];
  const nq = normArabic(q);
  if(nq.length < 2) return [];

  // 2-3 chars: direct includes (limit 25)
  if(nq.length <= 3){
    const out = [];
    for(const it of INDEX){
      if(it.textNorm.includes(nq)) out.push(it);
      if(out.length >= 25) break;
    }
    return out;
  }

  // 4+: scoring
  let terms = nq.split(" ").map(t=>t.trim()).filter(t=>t.length>1);
  terms = [...new Set(terms)];
  if(!terms.length) return [];

  const anchor = terms.reduce((a,b)=> (b.length>a.length? b : a), terms[0]);
  const scored = [];

  for(const it of INDEX){
    const text = it.textNorm;

    let hits = 0;
    for(const t of terms){
      if(text.includes(t)) hits++;
    }
    const ratio = hits/terms.length;

    if(terms.length >= 3){
      if(hits < 2) continue;
      if(!text.includes(anchor)) continue;
    } else {
      if(ratio < 0.5) continue;
    }

    let score = ratio;
    if(text.includes(nq)) score += 2.5;

    const noSpaceQ = nq.replace(/\s+/g,"");
    const noSpaceT = text.replace(/\s+/g,"");
    if(noSpaceT.includes(noSpaceQ)) score += 1.5;

    if(text.includes(anchor)) score += 0.3;

    scored.push({ ...it, score });
  }

  scored.sort((a,b)=> b.score - a.score);
  return scored.slice(0, 60);
}

/* ---- Primary selection ---- */
function setPrimaryAyah(surahNo, ayahNo){
  CURRENT = { s: surahNo, a: ayahNo };
  showAyahContext(surahNo, ayahNo);
  updateTafsirUI(surahNo, ayahNo);
  updateVisibilityState();
}

/* ---- Context window ---- */
function computeContextWindow(surah, ayahNo){
  const before = 2;
  const after = 7;
  const windowSize = before + after + 1;
  const len = surah.ayahs.length;

  let start = Math.max(1, ayahNo - before);
  let end   = start + windowSize - 1;

  if(end > len){
    end = len;
    start = Math.max(1, end - windowSize + 1);
  }
  return { start, end };
}

function showAyahContext(surahNo, ayahNo){
  const surah = QURAN.surahs.find(s=>s.number===surahNo);
  if(!surah) return;

  const surahName = SURAH_META.find(x=>x.number===surahNo)?.name_ar || surah.name_ar;
  const len = surah.ayahs.length;

  const sameSurah = CONTEXT_STATE.surah === surahNo;
  const withinWindow = sameSurah && ayahNo >= CONTEXT_STATE.start && ayahNo <= CONTEXT_STATE.end;
  const isFirst = withinWindow && ayahNo === CONTEXT_STATE.start && CONTEXT_STATE.start > 1;
  const isLast = withinWindow && ayahNo === CONTEXT_STATE.end && CONTEXT_STATE.end < len;

  let start, end;
  if(!withinWindow || !sameSurah || isFirst || isLast){
    ({ start, end } = computeContextWindow(surah, ayahNo));
  } else {
    start = CONTEXT_STATE.start;
    end = CONTEXT_STATE.end;
  }

  CONTEXT_STATE = { surah: surahNo, start, end };

  const mode = langSelect?.value || "ar";

  ayahContext.innerHTML = "";
  contextHeader.textContent = `${surahName} — الآيات ${start} إلى ${end}`;

  for(let i=start;i<=end;i++){
    const a = surah.ayahs.find(x=>x.numberInSurah===i);
    if(!a) continue;

    const numHtml = `<span class="num" dir="ltr">(${i})</span>`;
    const div = document.createElement("div");
    div.className = "ayah-line" + (i===ayahNo ? " active" : "");
    div.title = "اضغط لجعل هذه الآية هي الرئيسية";

    const enText = EN_MAP?.[String(surahNo)]?.[String(i)] || "";

    if(mode === "ar"){
      div.innerHTML = `${numHtml} ${a.text}`;
      div.style.direction = "rtl";
      div.style.textAlign = "right";
    } else if(mode === "en"){
      div.innerHTML = `${numHtml} ${escapeHtml(enText || "—")}`;
      div.style.direction = "ltr";
      div.style.textAlign = "left";
    } else {
      div.innerHTML = `${numHtml} ${a.text}<span class="en">${escapeHtml(enText || "—")}</span>`;
      div.style.direction = "rtl";
      div.style.textAlign = "right";
    }

    div.onclick = () => setPrimaryAyah(surahNo, i);
    ayahContext.appendChild(div);
  }
}

function getAyahTextFromQuran(surahNo, ayahNo){
  const surah = QURAN?.surahs?.find(s=>s.number === surahNo);
  if(!surah) return "";
  const ayah = surah.ayahs.find(a=>a.numberInSurah === ayahNo);
  return ayah?.text || "";
}

function formatTafsirText(text, surahNo, ayahNo){
  if(!text) return "";
  const ayahText = getAyahTextFromQuran(surahNo, ayahNo);

  const splitIntoParagraphs = (html) => {
    const normalized = html.replace(/\n+/g, " ").trim();
    const segments = normalized.match(/[^.]+(?:\.)?/g) || [];
    const cleaned = segments.map(s => s.trim()).filter(Boolean);
    return cleaned.length ? cleaned : [normalized];
  };

  let html = escapeHtml(text);
  html = html.replace(/\{([^{}]+)\}/g, `<span class="tafsir-brace">{$1}</span>`);
  html = html.replace(/\(([^()]+)\)/g, `<span class="tafsir-paren">($1)</span>`);
  if(ayahText){
    const escapedAyah = escapeHtml(ayahText);
    const regex = new RegExp(escapeRegex(escapedAyah), "g");
    html = html.replace(regex, `<span class="ayah-quote">${escapedAyah}</span>`);
  }

  const sentences = splitIntoParagraphs(html);

  if(sentences.length){
    return sentences.map(s => `<p class="tafsir-paragraph">${s}</p>`).join("");
  }

  return `<p class="tafsir-paragraph">${html.replace(/\n/g,"<br>")}</p>`;
}

function setTafsirVisibility(visible){
  if(!tafsirSection) return;
  tafsirSection.classList.toggle("empty", !visible);
  if(!visible){
    tafsirHeader.textContent = "اختر آية من نتائج البحث";
    tafsirTitle.textContent = "—";
    tafsirMetaInterpreter && (tafsirMetaInterpreter.innerHTML = `<span class=\"dot\"></span>نص التفسير`);
    tafsirMetaAyah && (tafsirMetaAyah.textContent = "—");
    tafsirAyahTag && (tafsirAyahTag.textContent = "—");
    tafsirBox.innerHTML = "—";
  }
}

function updateTafsirUI(surahNo, ayahNo){
  setTafsirVisibility(true);
  const surahName = SURAH_META.find(x=>x.number===surahNo)?.name_ar || `سورة ${surahNo}`;
  tafsirHeader.textContent = `${surahName} — الآية ${ayahNo}`;

  const key = tafsirSelect.value;
  const pack = TAFSIRS[key];

  const label = pack?.label || "التفسير";
  tafsirTitle.textContent = label;
  if(tafsirMetaInterpreter){
    tafsirMetaInterpreter.innerHTML = `<span class="dot"></span>${label}`;
  }
  if(tafsirMetaAyah){
    tafsirMetaAyah.textContent = `${surahName} • الآية ${ayahNo}`;
  }
  if(tafsirAyahTag){
    tafsirAyahTag.textContent = getAyahTextFromQuran(surahNo, ayahNo) || "—";
  }

  const text = getTafsir(pack?.data, surahNo, ayahNo);
  if(text){
    tafsirBox.innerHTML = formatTafsirText(text, surahNo, ayahNo);
  } else {
    tafsirBox.innerHTML = `<div class="tafsir-empty">— (لم يتم العثور على ${label} لهذه الآية داخل الملف)</div>`;
  }
}

function makeSnippet(text=""){
  const clean = (text || "").replace(/\s+/g," ").trim();
  return clean.length > 140 ? `${clean.slice(0, 140)}…` : clean;
}

function updateSelectedChip(it){
  if(!selectedChip || !chipTitle || !chipSnippet || !chipIcon) return;
  const surahName = SURAH_META.find(s=>s.number===it.s)?.name_ar || `سورة ${it.s}`;
  chipTitle.textContent = `${surahName} — الآية ${it.a}`;
  chipSnippet.textContent = makeSnippet(it.textRaw);
  chipIcon.textContent = String(it.a).padStart(3,"0");
  selectedChip.setAttribute("aria-label", `تم اختيار ${surahName} الآية ${it.a}. اضغط لتغيير الاختيار`);
}

function collapseResultsToChip(it){
  if(!resultsShell || !results) return;
  updateSelectedChip(it);
  results.classList.add("collapsed");
  resultsShell.classList.add("collapsed");
  results.style.maxHeight = "";
}

function expandResultsList(){
  if(!resultsShell || !results) return;
  resultsShell.classList.remove("collapsed");
  results.classList.remove("collapsed");
  results.style.maxHeight = "";
}

function updateVisibilityState(){
  if(contextBlock){
    contextBlock.classList.remove("is-hidden");
  }
  if(tafsirSection){
    tafsirSection.classList.remove("is-hidden");
  }
}

function resetPrimaryPanels(){
  CURRENT = null;
  contextHeader.textContent = "اختر آية من نتائج البحث";
  ayahContext.innerHTML = "";
  tafsirHeader.textContent = "اختر آية من نتائج البحث";
  tafsirTitle.textContent = "—";
  tafsirBox.textContent = "—";
  tafsirMetaAyah.textContent = "—";
  tafsirAyahTag.textContent = "—";
  if(tafsirMetaInterpreter){
    tafsirMetaInterpreter.innerHTML = `<span class="dot"></span> نص التفسير`;
  }
}

/* ---- Highlight matches (visual niceness) ---- */
function highlightText(rawText, query){
  const nq = normArabic(query);
  if(nq.length < 2) return escapeHtml(rawText);

  // highlight each term (>=2 chars)
  const terms = [...new Set(nq.split(" ").map(t=>t.trim()).filter(t=>t.length>=2))];
  if(!terms.length) return escapeHtml(rawText);

  // naive highlight on ORIGINAL rawText by trying exact terms (best effort)
  let html = escapeHtml(rawText);

  // Sort by length to avoid partial overlaps
  terms.sort((a,b)=>b.length-a.length);

  for(const t of terms){
    // We can’t perfectly map normalized term to original with harakat,
    // so we highlight only if the plain term exists in html.
    const safe = escapeRegex(escapeHtml(t));
    const re = new RegExp(safe, "g");
    html = html.replace(re, `<mark>${escapeHtml(t)}</mark>`);
  }
  return html;
}

/* ---- Render results ---- */
function renderResults(items, query){
  LAST_RESULTS = items;
  results.classList.remove("collapsed");
  resultsShell?.classList.remove("collapsed");
  results.style.maxHeight = "";
  results.innerHTML = "";

  if(!items.length){
    results.innerHTML = `
      <div class="item" style="cursor:default;">
        <div class="line1">لا توجد نتائج</div>
        <div class="line2">جرّب كلمة أخرى أو اكتب جزءًا أطول من الآية.</div>
      </div>
    `;
    return;
  }

  for(const it of items){
    const surahName = SURAH_META.find(s=>s.number===it.s)?.name_ar || `سورة ${it.s}`;

    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <div class="line1">${escapeHtml(surahName)} — الآية ${it.a}</div>
      <div class="line2">${highlightText(it.textRaw, query)}</div>
    `;

    // Hover: update panels immediately
    div.onmouseenter = () => setPrimaryAyah(it.s, it.a);

    // Click: primary selection + collapse to chip
    div.onclick = () => {
      setPrimaryAyah(it.s, it.a);
      collapseResultsToChip(it);
    };

    results.appendChild(div);
  }
}

/* ---- Events ---- */
tafsirSelect.onchange = () => {
  if(CURRENT) updateTafsirUI(CURRENT.s, CURRENT.a);
};

langSelect.onchange = () => {
  if(CURRENT) showAyahContext(CURRENT.s, CURRENT.a);
};

/* ---- Tiny debounce ---- */
function debounce(fn, ms=120){
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(()=>fn(...args), ms);
  };
}

/* ---- Init ---- */
async function loadOne(key, file, label){
  try{
    const raw = await loadJson(file);
    const norm = normalizeTafsir(raw);
    if(Object.keys(norm).length){
      TAFSIRS[key] = { label, data: norm };
      return true;
    }
  }catch{}
  return false;
}

async function init(){
  SURAH_META = await loadJson("surahs.json");
  QURAN = normalizeQuran(await loadJson("quran.json"));
  buildIndex();

  // Load english translation (optional)
  try{
    const enRaw = await loadJson("en.sahih.json");
    EN_MAP = buildEnglishMap(enRaw);
  }catch{
    EN_MAP = null;
  }

  // Load tafsir packs (silent)
  await loadOne("muyassar",   "tafseer_muyassar.json",   "التفسير الميسّر");
  await loadOne("saadi",      "tafseer_saadi.json",      "تفسير السعدي");
  await loadOne("tabari",     "tafseer_tabari.json",     "تفسير الطبري");
  await loadOne("ibn_kathir", "tafseer_ibn_kathir.json", "تفسير ابن كثير");
  await loadOne("qurtubi",    "tafseer_qurtubi.json",    "تفسير القرطبي");
  await loadOne("baghawi",    "tafseer_baghawi.json",    "تفسير البغوي");
  await loadOne("ibn_ashur",  "tafseer_ibn_ashur.json",  "تفسير ابن عاشور");

  const runSearch = () => {
    const q = textSearch.value;
    const found = searchText(q);
    renderResults(found, q);
    expandResultsList();
    updateVisibilityState();
  };

  textSearch.oninput = debounce(runSearch, 120);

  // Enter selects first result
  textSearch.addEventListener("keydown", (e) => {
    if(e.key === "Enter"){
      if(LAST_RESULTS?.length){
        const it = LAST_RESULTS[0];
        setPrimaryAyah(it.s, it.a);
        collapseResultsToChip(it);
      }
    }
    if(e.key === "Escape"){
      expandResultsList();
      textSearch.blur();
    }
  });

  selectedChip.onclick = () => {
    expandResultsList();
    textSearch?.focus();
  };

  clearBtn?.addEventListener("click", () => {
    textSearch.value = "";
    LAST_RESULTS = [];
    resetPrimaryPanels();
    results.innerHTML = "";
    expandResultsList();
    setTafsirVisibility(false);
    ayahContext.innerHTML = "";
    contextHeader.textContent = "اختر آية من نتائج البحث";
    CURRENT = null;
    textSearch.focus();
    updateVisibilityState();
  });

  // First nice empty state
  results.innerHTML = `
    <div class="item" style="cursor:default;">
      <div class="line1">ابدأ بالبحث</div>
      <div class="line2">اكتب حرفين فأكثر لعرض النتائج هنا.</div>
    </div>
  `;

  updateVisibilityState();
}

initTheme();
setTafsirVisibility(false);
init().catch(err => console.error(err));
