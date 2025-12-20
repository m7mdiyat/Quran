/* Offline Quran Search + Context + Tafsir + English (Sahih)
   Offline files:
   - quran.json, surahs.json
   - tafseer_*.json (nested or other supported shapes)
   - en.sahih.json (array of {index,text} OR array of strings)
*/

const el = id => document.getElementById(id);

const textSearch = el("textSearch");
const results    = el("results");

const ayahContext   = el("ayahContext");
const contextHeader = el("contextHeader");
const langSelect    = el("langSelect");

const tafsirHeader = el("tafsirHeader");
const tafsirSelect = el("tafsirSelect");
const tafsirTitle  = el("tafsirTitle");
const tafsirBox    = el("tafsirBox");

let SURAH_META = [];
let QURAN = null;
let INDEX = [];
let CURRENT = null;

// Tafsir packs: { key: {label, data:{s:{a:text}} } }
let TAFSIRS = {};

// English map: { "s": { "a": "text" } }
let EN_MAP = null;

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

/* ---- Primary selection (used by results hover AND context click) ---- */
function setPrimaryAyah(surahNo, ayahNo){
  CURRENT = { s: surahNo, a: ayahNo };
  showAyahContext(surahNo, ayahNo);
  updateTafsirUI(surahNo, ayahNo);
}

/* ---- Context (2 before + 7 after) ---- */
function showAyahContext(surahNo, ayahNo){
  const surah = QURAN.surahs.find(s=>s.number===surahNo);
  if(!surah) return;

  const surahName = SURAH_META.find(x=>x.number===surahNo)?.name_ar || surah.name_ar;
  const before = 2;
  const after  = 7;

  const start = Math.max(1, ayahNo - before);
  const end   = Math.min(surah.ayahs.length, ayahNo + after);

  const mode = langSelect?.value || "ar";

  ayahContext.classList.remove("animate");
  // force reflow for animation restart
  void ayahContext.offsetWidth;

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
      div.innerHTML = `${numHtml} ${enText || "—"}`;
      div.style.direction = "ltr";
      div.style.textAlign = "left";
    } else {
      div.innerHTML = `${numHtml} ${a.text}<span class="en">${enText || "—"}</span>`;
      div.style.direction = "rtl";
      div.style.textAlign = "right";
    }

    // ✅ Click in context: make it the primary ayah + update everything
    div.onclick = () => setPrimaryAyah(surahNo, i);

    ayahContext.appendChild(div);
  }

  const activeEl = ayahContext.querySelector(".ayah-line.active");
  if(activeEl){
    activeEl.scrollIntoView({ behavior:"smooth", block:"center" });
  }

  ayahContext.classList.add("animate");
}

function updateTafsirUI(surahNo, ayahNo){
  const surahName = SURAH_META.find(x=>x.number===surahNo)?.name_ar || `سورة ${surahNo}`;
  tafsirHeader.textContent = `${surahName} — الآية ${ayahNo}`;

  const key = tafsirSelect.value;
  const pack = TAFSIRS[key];

  const label = pack?.label || "التفسير";
  tafsirTitle.textContent = label;

  const text = getTafsir(pack?.data, surahNo, ayahNo);
  tafsirBox.textContent = text ? text : `— (لم يتم العثور على ${label} لهذه الآية داخل الملف)`;
}

/* ---- Render results ---- */
function renderResults(items){
  results.innerHTML = "";
  for(const it of items){
    const surahName = SURAH_META.find(s=>s.number===it.s)?.name_ar || `سورة ${it.s}`;

    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <div class="line1">${surahName} — الآية ${it.a}</div>
      <div class="line2">${it.textRaw}</div>
    `;

    // Hover: update panels immediately
    div.onmouseenter = () => setPrimaryAyah(it.s, it.a);

    // Click: make it the primary selection without opening external links
    div.onclick = () => setPrimaryAyah(it.s, it.a);

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

  textSearch.oninput = () => renderResults(searchText(textSearch.value));
}

init().catch(err => {
  // صامت قدر الإمكان (ممكن تطبع بالكونسول لو تبغى)
  console.error(err);
});
