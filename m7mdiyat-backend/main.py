import os
import json
import re
import hashlib
import time
from flask import Flask, Response, stream_with_context, request, jsonify
from flask_cors import CORS
from google.cloud import storage

# Create Flask app
app = Flask(__name__)
CORS(app)

# Gemini (Vertex AI) using Google Gen AI SDK
from google import genai
from google.genai.types import HttpOptions

try:
    import sqlite3
except Exception:
    import pysqlite3 as sqlite3
import threading

# SQLite DB Globals - Tafsir
DB_PATH = "/tmp/tafsir.db"
DB_CONN = None
DB_LOCK = threading.Lock()

# SQLite DB Globals - Comparisons
COMPARE_DB_PATH = "/tmp/comparisons.sqlite"
COMPARE_DB_CONN = None
COMPARE_DB_LOCK = threading.Lock()

# ---------------------------------------------------------
# CONFIG
# ---------------------------------------------------------
BUCKET_NAME = os.environ.get("BUCKET_NAME", "m7mdiyat-tafsir-data")

FILES_MAP = {
    "quran": os.environ.get("QURAN_FILE", "quran.json"),
    "ibn_kathir": os.environ.get("TAFSIR_IBN_KATHIR_FILE", "tafseer_ibn_kathir.json"),
    "ibn_ashur": os.environ.get("TAFSIR_IBN_ASHUR_FILE", "tafseer_ibn_ashur.json"),
    "muyassar": os.environ.get("TAFSIR_MUYASSAR_FILE", "tafseer_muyassar.json"),
    "saadi": os.environ.get("TAFSIR_SAADI_FILE", "tafseer_saadi.json"),
    "tabari": os.environ.get("TAFSIR_TABARI_FILE", "tafseer_tabari.json"),
    "qurtubi": os.environ.get("TAFSIR_QURTUBI_FILE", "tafseer_qurtubi.json"),
    "baghawi": os.environ.get("TAFSIR_BAGHAWI_FILE", "tafseer_baghawi.json"),
    "bukhari": os.environ.get("BUKHARI_FILE", "Bukhari.json"),
    "muslim": os.environ.get("MUSLIM_FILE", "Muslim.json"),
}

# Books JSONL folder/prefix (your "Qayim/" folder now contains many JSONL books)
BOOKS_PREFIX = os.environ.get("BOOKS_PREFIX", os.environ.get("QAYIM_PREFIX", "Qayim/"))

# Models
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
ROUTER_MODEL = os.environ.get("ROUTER_MODEL", "gemini-2.5-flash")

# Retrieval tuning
TAFSIR_TOP_K = int(os.environ.get("TAFSIR_TOP_K", "6"))
HADITH_TOP_K = int(os.environ.get("HADITH_TOP_K", "4"))
QURAN_TOP_K = int(os.environ.get("QURAN_TOP_K", "5"))
BOOKS_TOP_K = int(os.environ.get("BOOKS_TOP_K", "6"))

# Chunking (only affects book entries that have long text fields)
BOOK_CHUNK_SIZE = int(os.environ.get("BOOK_CHUNK_SIZE", "1400"))
BOOK_CHUNK_OVERLAP = int(os.environ.get("BOOK_CHUNK_OVERLAP", "200"))

# To prevent cold-start / memory blowups if JSONL is huge, you can cap lines per file.
# Set to 0 to load all lines.
BOOKS_MAX_LINES_PER_FILE = int(os.environ.get("BOOKS_MAX_LINES_PER_FILE", "5000"))

# Strictness (raise these to reduce irrelevant results)
BOOKS_MIN_HITS_AR = int(os.environ.get("BOOKS_MIN_HITS_AR", "2"))
TAFSIR_MIN_HITS_AR = int(os.environ.get("TAFSIR_MIN_HITS_AR", "1"))
HADITH_MIN_HITS_AR = int(os.environ.get("HADITH_MIN_HITS_AR", "2"))
HADITH_MIN_HITS_EN = int(os.environ.get("HADITH_MIN_HITS_EN", "2"))

# Threshold to avoid random ayah selection
QURAN_CONFIDENCE_THRESHOLD = int(os.environ.get("QURAN_CONF_THRESHOLD", "120"))

# Safety limits to keep response clean + fast
# (Lower defaults = cheaper + more "relevant only")
MAX_EVIDENCE_BLOCKS = int(os.environ.get("MAX_EVIDENCE_BLOCKS", "10"))
MAX_EVIDENCE_CHARS_PER_BLOCK = int(os.environ.get("MAX_EVIDENCE_CHARS_PER_BLOCK", "1200"))

# ---------------------------------------------------------
# GLOBAL CACHE (per instance / cold start)
# ---------------------------------------------------------
GLOBAL_DATA = {
    "loaded": False,

    # Quran
    "quran_index": [],  # list[{s,a,txt,norm}]

    # Tafsir
    "tafsir": {},       # dict[source_key][surah][ayah]=text
    "tafsir_flat": [],  # list[{source,surah,ayah,text,norm,tokens_ar,source_id,loc,label}]
    "tafsir_inv_ar": {},# token -> [idx,...]

    # Hadith
    "hadith": [],       # list[{..., tokens_ar,tokens_en,...}]
    "hadith_inv_ar": {},
    "hadith_inv_en": {},

    # Books JSONL
    "books_chunks": [], # list[{..., tokens_ar,tokens_en, ...}]
    "books_inv_ar": {},
    "books_inv_en": {},
    "books_files": [],
}

_storage_client = None

# ---------------------------------------------------------
# NORMALIZATION + TOKENIZATION
# ---------------------------------------------------------
AR_DIACRITICS_RE = re.compile(r"[\u064B-\u065F\u06D6-\u06ED]")
AR_WS_RE = re.compile(r"\s+")
EN_PUNCT_RE = re.compile(r"[^\w\s]", re.UNICODE)
AR_CHARS_RE = re.compile(r"[\u0600-\u06FF]")
AR_PUNCT_RE = re.compile(r"[^\u0600-\u06FF0-9\s]")

def normalize_arabic(text: str) -> str:
    if not text:
        return ""
    text = AR_DIACRITICS_RE.sub("", text)
    text = re.sub(r"[أإآ]", "ا", text)
    text = re.sub(r"[ى]", "ي", text)
    text = re.sub(r"ة", "ه", text)

    # NEW: remove punctuation/symbols (keeps Arabic letters + digits + spaces)
    text = AR_PUNCT_RE.sub(" ", text)

    return AR_WS_RE.sub(" ", text).strip()

def normalize_english(text: str) -> str:
    if not text:
        return ""
    text = text.lower()
    text = EN_PUNCT_RE.sub("", text)
    return AR_WS_RE.sub(" ", text).strip()

def is_arabic_text(text: str) -> bool:
    return bool(AR_CHARS_RE.search(text or ""))

def _short_hash(s: str, n: int = 10) -> str:
    h = hashlib.sha1((s or "").encode("utf-8", errors="ignore")).hexdigest()
    return h[:n]

def _safe_id_piece(s: str) -> str:
    s = (s or "").strip()
    s = re.sub(r"\s+", "_", s)
    s = re.sub(r"[^A-Za-z0-9_\-.:/#]", "", s)
    return s[:120]

# Stopwords (kept small-ish; you can extend)
AR_STOPWORDS = {
    "هل","ما","ماذا","لماذا","كيف","متى","اين","أين","وين","عن","في","على","من","الى","إلى",
    "هذا","هذه","ذلك","تلك","هناك","هنا","انا","أانا","انت","أنت","هو","هي","هم","هن",
    # IMPORTANT: removed fiqh/ruling words from stopwords so retrieval can use them
    "اريد","أريد","ابغى","وش","ايش","اي","لكن","لان","لأن","مع","بدون","اذا","إذ","ان","إن",
    "قد","لقد","ثم","او","أو","و","ب","ك","ل","ال"
}
# Words that strongly indicate fiqh/ruling intent (KEEP them, do not add to stopwords)
FIQH_ANCHORS = {
    "واجب","فرض","سنة","سنه","مستحب","مندوب","مكروه","حرام","حلال",
    "يجوز","لايجوز","جائز","غيرجائز","يباح","مباح","رخصة","عزيمة",
    "شرط","ركن","صحيح","باطل","فساد","كفارة","نذر"
}
EN_STOPWORDS = {
    "the","a","an","is","are","was","were","to","of","in","on","for","and","or","but","with",
    "what","why","how","when","where","which","about","can","could","should","would","does","do","did",
    "explain","tell","me","please"
}


# ---------------------------------------------------------
# LOCAL ARABIC SYNONYM / INTENT EXPANSION (broadens retrieval)
# ---------------------------------------------------------
# This is a lightweight, deterministic synonym expander to handle modern phrasing
# (e.g., "العادة السرية") vs classical terms (e.g., "الاستمناء").
# You can extend this list safely over time.
AR_SYNONYM_PHRASES = [
    # modern -> classical / related
    ("العادة السرية", ["الاستمناء", "استمناء", "اخراج المني", "مني", "شهوة"]),
    ("عادة سرية", ["الاستمناء", "استمناء", "اخراج المني", "مني", "شهوة"]),
    ("العاده السريه", ["الاستمناء", "استمناء", "اخراج المني", "مني", "شهوة"]),
    ("اباحية", ["فاحشة", "زنا", "شهوة", "نظر", "غض البصر"]),
    ("افلام اباحية", ["فاحشة", "نظر", "غض البصر", "شهوة"]),
    ("موسيقى", ["غناء", "معازف", "لهو"]),
    ("دخان", ["تدخين", "تبغ", "سيجارة", "ضرر"]),
    ("فيب", ["تدخين", "تبغ", "ضرر"]),
    ("ربا", ["الربا", "فوائد", "قرض", "زيادة"]),
    ("حجاب", ["ستر", "خمار", "جلباب", "عورة"]),
]

def expand_ar_terms_local(user_text: str, base_terms: list, max_terms: int = 14) -> list:
    """Add synonyms + intent anchors (fiqh words) to Arabic keyword list."""
    norm = normalize_arabic(user_text or "")
    terms = []
    seen = set()

    def add(w):
        w = (w or "").strip()
        if len(w) < 3 or w in AR_STOPWORDS:
            return
        if w not in seen:
            seen.add(w)
            terms.append(w)

    # original
    for w in (base_terms or []):
        add(w)

    # fiqh anchors (keep if user asked حكم/حرام/مباح...)
    for w in (FIQH_ANCHORS or []):
        if w and w in norm:
            add(w)
    # also add generic intent words if it's a ruling-like question
    if any(x in norm for x in ["حكم", "حكمه", "حلال", "حرام", "يجوز", "لا يجوز", "مكروه", "واجب", "فرض", "سنة", "سنه"]):
        for w in ["حكم", "فقه", "قول", "العلماء"]:
            add(w)

    # phrase-based synonyms
    for phrase, syns in AR_SYNONYM_PHRASES:
        if phrase and phrase in norm:
            for s in syns:
                for w in normalize_arabic(s).split():
                    add(w)

    # cap
    return terms[:max_terms]

def arabic_keywords(text: str, limit: int = 10):
    t = normalize_arabic(text)
    print("DEBUG_AR_NORM =", t)
    
    out = []
    seen = set()
    for w in t.split():
        if len(w) < 3 or w in AR_STOPWORDS:
            continue
        if w not in seen:
            seen.add(w)
            out.append(w)
        if len(out) >= limit:
            break
            
    print("DEBUG_AR_KWS_OUT =", out)
    return out

def english_keywords(text: str, limit: int = 10):
    t = normalize_english(text)
    out = []
    seen = set()
    for w in t.split():
        if len(w) < 3 or w in EN_STOPWORDS:
            continue
        if w not in seen:
            seen.add(w)
            out.append(w)
        if len(out) >= limit:
            break
    return out

def make_tokens_ar(norm_ar: str):
    if not norm_ar:
        return []
    toks = []
    seen = set()
    for w in norm_ar.split():
        if len(w) < 3 or w in AR_STOPWORDS:
            continue
        if w not in seen:
            seen.add(w)
            toks.append(w)
    return toks

def make_tokens_en(norm_en: str):
    if not norm_en:
        return []
    toks = []
    seen = set()
    for w in norm_en.split():
        if len(w) < 3 or w in EN_STOPWORDS:
            continue
        if w not in seen:
            seen.add(w)
            toks.append(w)
    return toks

def count_hits(tokens_list, query_kws) -> int:
    if not tokens_list or not query_kws:
        return 0
    tset = set(tokens_list)
    return sum(1 for w in query_kws if w in tset)

# ---------------------------------------------------------
# GCS HELPERS
# ---------------------------------------------------------
def _get_storage_client():
    global _storage_client
    if _storage_client is None:
        _storage_client = storage.Client()
    return _storage_client

def load_gcs_text(filename: str) -> str:
    try:
        client = _get_storage_client()
        bucket = client.bucket(BUCKET_NAME)
        blob = bucket.blob(filename)
        return blob.download_as_text(encoding="utf-8-sig")
    except Exception as e:
        print(f"❌ Error loading text {filename}: {e}")
        return ""

def load_gcs_json(filename: str):
    try:
        raw = load_gcs_text(filename)
        if not raw:
            return {} if filename.lower().endswith(".json") else []
        return json.loads(raw)
    except Exception as e:
        print(f"❌ Error loading json {filename}: {e}")
        return {} if filename.lower().endswith(".json") else []

def download_db_if_needed():
    """Lazy download of SQLite DB from GCS to /tmp. Safe and cached."""
    # Check if already exists and has content
    if os.path.exists(DB_PATH):
        size = os.path.getsize(DB_PATH)
        if size > 0:
            print(f"📁 tafsir.db already exists, size={size}")
            return True
    
    print("📥 downloading tafsir.db...")
    t0 = time.time()
    try:
        storage_client = storage.Client()
        bucket = storage_client.bucket(BUCKET_NAME)
        blob = bucket.blob("tafsir.db")
        blob.download_to_filename(DB_PATH)
        size = os.path.getsize(DB_PATH)
        elapsed = int((time.time() - t0) * 1000)
        print(f"✅ downloaded tafsir.db size={size} in {elapsed}ms")
        return True
    except Exception as e:
        print(f"❌ download failed: {e}")
        return False

def get_db_connection():
    """Returns a thread-safe reusable SQLite connection for tafsir.db"""
    global DB_CONN
    with DB_LOCK:
        if DB_CONN is None:
            success = download_db_if_needed()
            if not success:
                return None

            if os.path.exists(DB_PATH):
                try:
                    DB_CONN = sqlite3.connect(DB_PATH, check_same_thread=False)
                    DB_CONN.execute("PRAGMA journal_mode=WAL;")
                    DB_CONN.execute("PRAGMA synchronous=NORMAL;")
                    print("✅ SQLite connection established (tafsir.db)")
                except Exception as e:
                    print(f"❌ SQLite Connection Error: {e}")
                    return None
    return DB_CONN

# ---------------------------------------------------------
# COMPARISONS DB HELPERS
# ---------------------------------------------------------
def download_compare_db_if_needed():
    """Lazy download of comparisons.sqlite from GCS to /tmp. Safe and cached."""
    if os.path.exists(COMPARE_DB_PATH):
        size = os.path.getsize(COMPARE_DB_PATH)
        if size > 0:
            print(f"📁 comparisons.sqlite already exists, size={size}")
            return True
    
    print("📥 downloading comparisons.sqlite...")
    t0 = time.time()
    try:
        storage_client = storage.Client()
        bucket = storage_client.bucket(BUCKET_NAME)
        blob = bucket.blob("comparisons.sqlite")
        blob.download_to_filename(COMPARE_DB_PATH)
        size = os.path.getsize(COMPARE_DB_PATH)
        elapsed = int((time.time() - t0) * 1000)
        print(f"✅ downloaded comparisons.sqlite size={size} in {elapsed}ms")
        return True
    except Exception as e:
        print(f"❌ comparisons.sqlite download failed: {e}")
        return False

def get_compare_db_connection():
    """Returns a thread-safe reusable SQLite connection for comparisons.sqlite"""
    global COMPARE_DB_CONN
    with COMPARE_DB_LOCK:
        if COMPARE_DB_CONN is None:
            success = download_compare_db_if_needed()
            if not success:
                return None

            if os.path.exists(COMPARE_DB_PATH):
                try:
                    COMPARE_DB_CONN = sqlite3.connect(COMPARE_DB_PATH, check_same_thread=False)
                    COMPARE_DB_CONN.execute("PRAGMA journal_mode=WAL;")
                    COMPARE_DB_CONN.execute("PRAGMA synchronous=NORMAL;")
                    print("✅ SQLite connection established (comparisons.sqlite)")
                except Exception as e:
                    print(f"❌ comparisons.sqlite Connection Error: {e}")
                    return None
    return COMPARE_DB_CONN

def load_gcs_jsonl(filename: str, max_lines: int = 0):
    raw = load_gcs_text(filename)
    if not raw:
        return []
    out = []
    for i, line in enumerate(raw.splitlines()):
        if max_lines and i >= max_lines:
            break
        line = (line or "").strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
            if isinstance(obj, dict):
                out.append(obj)
        except Exception:
            continue
    return out

def list_gcs_files(prefix: str):
    client = _get_storage_client()
    bucket = client.bucket(BUCKET_NAME)
    return [b.name for b in bucket.list_blobs(prefix=prefix)]

def chunk_text(text: str, size: int, overlap: int):
    text = (text or "").strip()
    if not text:
        return []
    if len(text) <= size:
        return [text]
    chunks = []
    start = 0
    n = len(text)
    step = max(1, size - overlap)
    while start < n:
        end = min(n, start + size)
        ch = text[start:end].strip()
        if ch:
            chunks.append(ch)
        start += step
    return chunks

# ---------------------------------------------------------
# BOOKS JSONL PARSING (robust)
# ---------------------------------------------------------
AUTHOR_AR_MAP = {
    "IbnAlQayyim": "ابن القيم",
    "IbnUthaymeen": "ابن عثيمين",
    "AlBayhaqi": "البيهقي",
    "IbnHajar": "ابن حجر",
    "ImamMalik": "الإمام مالك",
    "AlNawawi": "النووي",
    "IbnBaz": "ابن باز",
}

def infer_author_book_from_filename(fname: str):
    base = (fname or "").split("/")[-1]
    base = re.sub(r"\.jsonl$", "", base, flags=re.IGNORECASE)
    parts = [p for p in base.split("_") if p]
    author = None
    book = base
    if len(parts) >= 2:
        author_candidate = parts[-1]
        book_candidate = "_".join(parts[:-1])
        if len(author_candidate) >= 3:
            author = author_candidate
            book = book_candidate or base
    return author, book, base

def author_display(author: str):
    if not author:
        return {"en": "", "ar": ""}
    return {"en": author, "ar": AUTHOR_AR_MAP.get(author, author)}

BOOK_TEXT_KEYS = ["text", "content", "body", "arabic", "ar", "matn", "paragraph", "passage", "snippet"]
BOOK_META_KEYS = ["title", "book", "book_title", "chapter", "section", "bab", "page", "ref", "source"]

def extract_book_text_and_meta(obj: dict):
    if not isinstance(obj, dict):
        return "", {}

    # 1) direct keys
    text_val = ""
    for k in BOOK_TEXT_KEYS:
        v = obj.get(k)
        if isinstance(v, str) and v.strip():
            text_val = v.strip()
            break

    # 2) nested dict (common patterns)
    if not text_val:
        for k in ["data", "item", "record"]:
            v = obj.get(k)
            if isinstance(v, dict):
                for kk in BOOK_TEXT_KEYS:
                    vv = v.get(kk)
                    if isinstance(vv, str) and vv.strip():
                        text_val = vv.strip()
                        break
            if text_val:
                break

    meta = {}
    for mk in BOOK_META_KEYS:
        v = obj.get(mk)
        if isinstance(v, (str, int, float)) and str(v).strip():
            meta[mk] = str(v).strip()

    author = obj.get("author") or obj.get("scholar") or obj.get("sheikh")
    if isinstance(author, str) and author.strip():
        meta["author"] = author.strip()

    return text_val, meta

# ---------------------------------------------------------
# INVERTED INDEX HELPERS
# ---------------------------------------------------------
def inv_add(inv: dict, token: str, idx: int):
    if not token:
        return
    lst = inv.get(token)
    if lst is None:
        inv[token] = [idx]
    else:
        lst.append(idx)

def build_candidates(inv: dict, kws: list, cap: int = 5000):
    """Return a set of candidate indices from posting lists, capped to avoid huge unions."""
    if not kws:
        return set()
    cand = set()
    for w in kws:
        for idx in inv.get(w, []):
            cand.add(idx)
            if len(cand) >= cap:
                return cand
    return cand

# ---------------------------------------------------------
# HADITH STRUCTURE
# ---------------------------------------------------------
def structure_hadith(raw_data, source_name: str):
    if raw_data is None:
        return []

    if isinstance(raw_data, list):
        items = raw_data
    elif isinstance(raw_data, dict):
        items = raw_data.get("hadiths") or raw_data.get("data") or list(raw_data.values())
    else:
        items = []

    clean = []
    for item in items:
        if not isinstance(item, dict):
            continue

        arabic = (
            item.get("Arabic_Text") or item.get("Arabic")
            or item.get("arab") or item.get("arabic") or item.get("ar") or ""
        )
        english = (
            item.get("English_Text") or item.get("English")
            or item.get("english") or item.get("en") or ""
        )
        number = (
            item.get("In-book reference") or item.get("Reference")
            or item.get("Hadith_ID") or item.get("hadithnumber")
            or item.get("number") or item.get("id") or ""
        )
        book = item.get("Book") or item.get("book") or ""

        if not (arabic or english):
            continue

        number_s = str(number).strip()
        book_s = str(book).strip()

        base_for_hash = f"{source_name}|{book_s}|{number_s}|{str(arabic)[:120]}|{str(english)[:120]}"
        hid = _short_hash(base_for_hash, 10)

        source_id = f"HADITH:{_safe_id_piece(source_name)}:{_safe_id_piece(book_s) or 'book'}:{_safe_id_piece(number_s) or hid}"
        loc = f"{book_s or 'Hadith'} — Ref: {number_s or hid}"
        label = f"{source_name} — {loc}"

        norm_ar = normalize_arabic(str(arabic))
        norm_en = normalize_english(str(english))

        tok_ar = make_tokens_ar(norm_ar)
        tok_en = make_tokens_en(norm_en)

        clean.append({
            "source": source_name,
            "arabic": str(arabic).strip(),
            "english": str(english).strip(),
            "number": number_s,
            "book": book_s,
            "norm_ar": norm_ar,
            "norm_en": norm_en,
            "tokens_ar": tok_ar,
            "tokens_en": tok_en,
            "source_id": source_id,
            "loc": loc,
            "label": label,
        })

    return clean

# ---------------------------------------------------------
# INITIALIZE / LOAD ALL DATA ONCE PER INSTANCE
# ---------------------------------------------------------
def initialize_data():
    if GLOBAL_DATA.get("loaded"):
        return

    print("📥 Loading data...")

    # Quran
    raw_quran = load_gcs_json(FILES_MAP["quran"])
    surahs_list = []
    if isinstance(raw_quran, dict):
        if "data" in raw_quran and isinstance(raw_quran["data"], dict) and "surahs" in raw_quran["data"]:
            surahs_list = raw_quran["data"]["surahs"]
        elif "surahs" in raw_quran:
            surahs_list = raw_quran["surahs"]

    q_index = []
    for surah in surahs_list or []:
        s_num = surah.get("number")
        for ayah in surah.get("ayahs", []) or []:
            a_num = ayah.get("numberInSurah") or ayah.get("number")
            txt = ayah.get("text", "")
            try:
                q_index.append({
                    "s": int(s_num),
                    "a": int(a_num),
                    "txt": txt,
                    "norm": normalize_arabic(txt),
                })
            except Exception:
                pass
    GLOBAL_DATA["quran_index"] = q_index

    # Tafsir dict (all 7 sources)
    GLOBAL_DATA["quran_index"] = q_index
    
    # Tafsir loading REMOVED in favor of SQLite (tafsir.db) to fix OOM.
    # Tafsirs are now accessed via get_db_connection() in the /tafsir endpoint.
    GLOBAL_DATA["tafsir"] = {} 
    GLOBAL_DATA["tafsir_flat"] = [] 
    GLOBAL_DATA["tafsir_inv_ar"] = {}
    
    # Download DB on startup (optional, or lazy)
    # threading.Thread(target=download_db_if_needed).start()

    # Hadith + inverted indexes
    hadith = []
    hadith_inv_ar = {}
    hadith_inv_en = {}
    try:
        bukhari = load_gcs_json(FILES_MAP["bukhari"])
        muslim = load_gcs_json(FILES_MAP["muslim"])
        hadith.extend(structure_hadith(bukhari, "Sahih Bukhari"))
        hadith.extend(structure_hadith(muslim, "Sahih Muslim"))
    except Exception as e:
        print("⚠️ Hadith load error:", e)

    for i, h in enumerate(hadith):
        for w in h.get("tokens_ar", []):
            inv_add(hadith_inv_ar, w, i)
        for w in h.get("tokens_en", []):
            inv_add(hadith_inv_en, w, i)

    GLOBAL_DATA["hadith"] = hadith
    GLOBAL_DATA["hadith_inv_ar"] = hadith_inv_ar
    GLOBAL_DATA["hadith_inv_en"] = hadith_inv_en

    # Books JSONL + inverted indexes
    books_chunks = []
    books_inv_ar = {}
    books_inv_en = {}
    books_files = []
    try:
        books_files = [name for name in list_gcs_files(BOOKS_PREFIX) if name.lower().endswith(".jsonl")]
        GLOBAL_DATA["books_files"] = books_files[:]

        for fname in books_files:
            author_guess, book_guess, base_name = infer_author_book_from_filename(fname)
            records = load_gcs_jsonl(fname, max_lines=BOOKS_MAX_LINES_PER_FILE)
            if not records:
                continue

            total_lines = len(records)
            for line_idx, obj in enumerate(records):
                text, meta = extract_book_text_and_meta(obj)
                if not text or len(text) < 25:
                    continue

                pieces = chunk_text(text, BOOK_CHUNK_SIZE, BOOK_CHUNK_OVERLAP)

                author_final = meta.get("author") or author_guess or ""
                disp = author_display(author_final)
                book_title = meta.get("book_title") or meta.get("book") or meta.get("title") or book_guess or base_name

                loc_parts = [book_title] if book_title else []
                for k, lbl in [("chapter","chapter"),("section","section"),("bab","bab"),("page","p."),("ref","ref")]:
                    if meta.get(k):
                        loc_parts.append(f"{lbl} {meta[k]}")
                loc_parts.append(f"line {line_idx+1}/{total_lines}")
                loc = " — ".join(loc_parts)

                for ci, ch in enumerate(pieces):
                    norm_ar = normalize_arabic(ch)
                    norm_en = normalize_english(ch)
                    tok_ar = make_tokens_ar(norm_ar)
                    tok_en = make_tokens_en(norm_en)

                    # Skip chunks with no meaningful tokens (helps relevance + saves index noise)
                    if not tok_ar and not tok_en:
                        continue

                    sid = f"BOOK:{_safe_id_piece(BOOKS_PREFIX)}:{_safe_id_piece(base_name)}:ln{line_idx+1}:c{ci}"
                    label = (disp.get("ar") or disp.get("en") or "").strip()
                    if label:
                        label = f"{label} — {book_title}"
                    else:
                        label = book_title

                    idx = len(books_chunks)
                    books_chunks.append({
                        "source": "books_jsonl",
                        "folder": BOOKS_PREFIX,
                        "file": base_name,
                        "author": author_final,
                        "author_ar": disp.get("ar", ""),
                        "book_title": book_title,
                        "chunk_id": f"{line_idx+1}:{ci}",
                        "loc": loc,
                        "source_id": sid,
                        "label": label,
                        "text": ch,
                        "norm_ar": norm_ar,
                        "norm_en": norm_en,
                        "tokens_ar": tok_ar,
                        "tokens_en": tok_en,
                    })

                    for w in tok_ar:
                        inv_add(books_inv_ar, w, idx)
                    for w in tok_en:
                        inv_add(books_inv_en, w, idx)

        GLOBAL_DATA["books_chunks"] = books_chunks
        GLOBAL_DATA["books_inv_ar"] = books_inv_ar
        GLOBAL_DATA["books_inv_en"] = books_inv_en

        print(f"✅ Loaded BOOKS JSONL chunks={len(books_chunks)} from files={len(books_files)} prefix={BOOKS_PREFIX}")
    except Exception as e:
        print("❌ Books JSONL load error:", e)
        GLOBAL_DATA["books_chunks"] = []
        GLOBAL_DATA["books_inv_ar"] = {}
        GLOBAL_DATA["books_inv_en"] = {}
        GLOBAL_DATA["books_files"] = []

    GLOBAL_DATA["loaded"] = True
    print(f"✅ Loaded Quran={len(q_index)} | TafsirFlat={len(tafsir_flat)} | Hadith={len(hadith)} | BooksChunks={len(GLOBAL_DATA['books_chunks'])}")

# ---------------------------------------------------------
# AYAH REFS
# ---------------------------------------------------------
AYAH_REF_RE = re.compile(r"(?<!\d)(\d{1,3})\s*[:\-]\s*(\d{1,3})(?!\d)")
AYAH_RANGE_RE = re.compile(r"(?<!\d)(\d{1,3})\s*[:\-]\s*(\d{1,3})\s*[-–]\s*(\d{1,3})(?!\d)")

def parse_ayah_refs(text: str):
    t = (text or "").strip()
    ranges = []
    refs = []

    for m in AYAH_RANGE_RE.finditer(t):
        s = int(m.group(1))
        a1 = int(m.group(2))
        a2 = int(m.group(3))
        if a1 > a2:
            a1, a2 = a2, a1
        ranges.append((s, a1, a2))

    for m in AYAH_REF_RE.finditer(t):
        s = int(m.group(1))
        a = int(m.group(2))
        refs.append((s, a))

    if ranges:
        filtered = []
        for s, a in refs:
            inside = False
            for rs, a1, a2 in ranges:
                if rs == s and a1 <= a <= a2:
                    inside = True
                    break
            if not inside:
                filtered.append((s, a))
        refs = filtered

    return refs, ranges

def get_quran_item(surah: int, ayah: int):
    return next((x for x in GLOBAL_DATA["quran_index"] if x["s"] == surah and x["a"] == ayah), None)

# ---------------------------------------------------------
# INTENT ROUTER
# ---------------------------------------------------------
INTENTS = [
    "SUMMARY",
    "EXPLAIN_SIMPLE",
    "COMPARE_TAFSIRS",
    "DIFFERENCES",
    "KEY_POINTS",
    "GENERAL_QA",
    "FIND_AYAH",
]

def genai_client():
    # keep explicit; some envs require v1
    return genai.Client(http_options=HttpOptions(api_version="v1"))

def safe_json_from_text(text: str):
    text = (text or "").strip()
    if not text:
        return None
    try:
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end != -1 and end > start:
            return json.loads(text[start:end+1])
    except Exception:
        return None
    return None


def clean_model_text(text: str) -> str:
    """Lightweight cleanup for model text (remove code fences, trim, strip obvious HTML tags)."""
    t = (text or "").strip()
    if not t:
        return ""
    t = re.sub(r"^```[a-zA-Z0-9_-]*\s*", "", t)
    t = re.sub(r"\s*```\s*$", "", t)
    t = t.replace("```", "")
    t = re.sub(r"</?[^>]+>", "", t)
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()


def _ends_with_terminal_punct(text: str) -> bool:
    t = (text or "").strip()
    if not t:
        return True
    # Arabic + English terminal punctuation
    return t.endswith(("۔", "؟", "!", ".", "…", ")", "»", "”", '"', "'", "ـ"))

def _needs_continuation(text: str) -> bool:
    # If model stopped mid-sentence or mid-list, ask it to continue once.
    t = (text or "").strip()
    if not t:
        return False
    if len(t) < 60:
        return False
    # common "cut" signals
    cut_signals = ["نق", "للا", "الخلاص", "…", "—"]



    if any(t.endswith(s) for s in cut_signals):
        return True
    return not _ends_with_terminal_punct(t)




def parse_model_json(text: str) -> dict:
    """Parse model output into expected schema. If parsing fails, fall back to cleaned raw text."""
    raw = (text or "").strip()
    if not raw:
        return {
            "arabic_answer": "تعذر استخراج إجابة دقيقة من المصادر المتاحة.",
            "english_answer": "Could not extract a precise answer from the available sources.",
            "key_points_ar": [],
            "key_points_en": [],
            "tafsir_differences_ar": [],
            "tafsir_differences_en": [],
            "citations": [],
            "raw_text": "",
        }

    parsed = safe_json_from_text(raw)
    if isinstance(parsed, dict):
        parsed.setdefault("arabic_answer", "")
        parsed.setdefault("english_answer", "")
        parsed.setdefault("key_points_ar", [])
        parsed.setdefault("key_points_en", [])
        parsed.setdefault("tafsir_differences_ar", [])
        parsed.setdefault("tafsir_differences_en", [])
        parsed.setdefault("citations", [])
        parsed.setdefault("raw_text", raw[:2000])
        parsed["arabic_answer"] = clean_model_text(parsed.get("arabic_answer", ""))
        parsed["english_answer"] = clean_model_text(parsed.get("english_answer", ""))
        return parsed

    cleaned = clean_model_text(raw)
    is_ar = is_arabic_text(cleaned)
    return {
        "arabic_answer": cleaned if is_ar else "",
        "english_answer": cleaned if not is_ar else "",
        "key_points_ar": [],
        "key_points_en": [],
        "tafsir_differences_ar": [],
        "tafsir_differences_en": [],
        "citations": [],
        "raw_text": raw[:2000],
    }


def route_by_rules(prompt: str) -> dict:
    p_en = normalize_english(prompt)
    p_ar = normalize_arabic(prompt)

    if any(k in p_ar for k in ["حديث","البخاري","مسلم","رواه","قال رسول","صحيح"]):
        return {"intent": "GENERAL_QA", "confidence": 0.8, "language": "both", "style": "normal", "include_hadith": True}

    if any(k in p_en for k in ["compare", "versus", "vs", "difference", "differences", "contrast"]):
        if "difference" in p_en or "differences" in p_en:
            return {"intent": "DIFFERENCES", "confidence": 0.9, "language": "both", "style": "normal", "include_hadith": False}
        return {"intent": "COMPARE_TAFSIRS", "confidence": 0.9, "language": "both", "style": "normal", "include_hadith": False}

    if any(k in p_ar for k in ["قارن", "مقارنة", "الفرق", "اختلاف", "اوجه الاختلاف"]):
        if "اختلاف" in p_ar or "الفرق" in p_ar:
            return {"intent": "DIFFERENCES", "confidence": 0.9, "language": "both", "style": "normal", "include_hadith": False}
        return {"intent": "COMPARE_TAFSIRS", "confidence": 0.85, "language": "both", "style": "normal", "include_hadith": False}

    if any(k in p_en for k in ["summarize", "summary", "tldr", "brief", "short version"]):
        return {"intent": "SUMMARY", "confidence": 0.9, "language": "both", "style": "concise", "include_hadith": False}
    if any(k in p_ar for k in ["لخص", "تلخيص", "مختصر", "باختصار"]):
        return {"intent": "SUMMARY", "confidence": 0.85, "language": "both", "style": "concise", "include_hadith": False}

    if any(k in p_en for k in ["simple", "beginner", "eli5", "explain like", "in simple terms"]):
        return {"intent": "EXPLAIN_SIMPLE", "confidence": 0.9, "language": "both", "style": "simple", "include_hadith": False}
    if any(k in p_ar for k in ["ببساطه", "ببساطة", "باسلوب بسيط", "للمبتدئين", "اشرح ببساطه", "اشرح ببساطة"]):
        return {"intent": "EXPLAIN_SIMPLE", "confidence": 0.85, "language": "both", "style": "simple", "include_hadith": False}

    if any(k in p_en for k in ["key points", "bullet", "bullets", "main points", "takeaways", "list points"]):
        return {"intent": "KEY_POINTS", "confidence": 0.85, "language": "both", "style": "concise", "include_hadith": False}
    if any(k in p_ar for k in ["نقاط", "اهم النقاط", "النقاط الرئيسيه", "خلاصة نقاط", "قائمة"]):
        return {"intent": "KEY_POINTS", "confidence": 0.8, "language": "both", "style": "concise", "include_hadith": False}

    if any(k in p_en for k in ["find the verse", "find ayah", "which verse", "what ayah", "locate verse", "search for ayah"]):
        return {"intent": "FIND_AYAH", "confidence": 0.85, "language": "both", "style": "concise", "include_hadith": False}
    if any(k in p_ar for k in ["ابحث عن ايه", "ابحث عن آيه", "ما هي الايه", "ايه تتكلم", "اين الايه", "حدد الايه"]):
        return {"intent": "FIND_AYAH", "confidence": 0.8, "language": "both", "style": "concise", "include_hadith": False}

    return {"intent": "UNKNOWN", "confidence": 0.2, "language": "both", "style": "normal", "include_hadith": False}

def route_by_small_llm(prompt: str) -> dict:
    client = genai_client()
    router_prompt = f"""
You are an intent router for a Quran + Tafsir + Hadith + Books RAG app.

Choose exactly ONE intent from:
{", ".join(INTENTS)}

Return STRICT JSON ONLY with this schema:
{{
  "intent": "SUMMARY|EXPLAIN_SIMPLE|COMPARE_TAFSIRS|DIFFERENCES|KEY_POINTS|GENERAL_QA|FIND_AYAH",
  "language": "en|ar|both",
  "style": "simple|normal|concise|detailed",
  "include_hadith": true|false
}}

Rules:
- If user asks for summary => SUMMARY
- If user asks for differences/disagreements => DIFFERENCES
- If user asks to compare tafsirs => COMPARE_TAFSIRS
- If user asks for bullet points/key takeaways => KEY_POINTS
- If user asks to find/locate the verse => FIND_AYAH
- Otherwise => GENERAL_QA
- Default language=both, style=normal
- include_hadith=true if user mentions hadith/books OR the question is Islamic ruling/fiqh-like.

User prompt:
{prompt}
""".strip()

    resp = client.models.generate_content(model=ROUTER_MODEL, contents=router_prompt)
    plan = safe_json_from_text(resp.text or "")
    if not isinstance(plan, dict):
        return {"intent": "GENERAL_QA", "language": "both", "style": "normal", "include_hadith": False}

    intent = plan.get("intent", "GENERAL_QA")
    if intent not in INTENTS:
        intent = "GENERAL_QA"

    language = plan.get("language", "both")
    if language not in ["en", "ar", "both"]:
        language = "both"

    style = plan.get("style", "normal")
    if style not in ["simple", "normal", "concise", "detailed"]:
        style = "normal"

    include_hadith = bool(plan.get("include_hadith", False))
    return {"intent": intent, "language": language, "style": style, "include_hadith": include_hadith}

def route_intent(prompt: str) -> dict:
    plan = route_by_rules(prompt)
    if plan.get("confidence", 0) >= 0.6 and plan.get("intent") != "UNKNOWN":
        plan.pop("confidence", None)
    else:
        plan = route_by_small_llm(prompt)

    # If Arabic question, include hadith by default + prefer Arabic output
    if is_arabic_text(prompt or ""):
        if plan.get("intent") in ["GENERAL_QA", "FIND_AYAH", "SUMMARY", "EXPLAIN_SIMPLE", "KEY_POINTS"]:
            plan["include_hadith"] = True
        # IMPORTANT: ensure Arabic answer is filled
        plan["language"] = "ar"

    return plan

# ---------------------------------------------------------
# SEARCH (FAST + STRICT via inverted index)
# ---------------------------------------------------------
def search_tafsir(kws_ar: list, phrase_ar: str, limit: int):
    if not kws_ar:
        return []
    inv = GLOBAL_DATA["tafsir_inv_ar"]
    flat = GLOBAL_DATA["tafsir_flat"]
    cand = build_candidates(inv, kws_ar, cap=3000)
    scored = []
    for idx in cand:
        it = flat[idx]
        hits = count_hits(it.get("tokens_ar", []), kws_ar)
        if hits < TAFSIR_MIN_HITS_AR:
            continue
        sc = hits * 140
        if phrase_ar and phrase_ar in it.get("norm", ""):
            sc += 200
        scored.append((sc, it))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [it for _, it in scored[:limit]]

def search_hadith(kws_ar: list, kws_en: list, limit: int):
    hadith = GLOBAL_DATA["hadith"]
    cand = set()
    if kws_ar:
        cand |= build_candidates(GLOBAL_DATA["hadith_inv_ar"], kws_ar, cap=4000)
    if kws_en:
        cand |= build_candidates(GLOBAL_DATA["hadith_inv_en"], kws_en, cap=4000)

    scored = []
    for idx in cand:
        h = hadith[idx]
        hits_ar = count_hits(h.get("tokens_ar", []), kws_ar) if kws_ar else 0
        hits_en = count_hits(h.get("tokens_en", []), kws_en) if kws_en else 0

        sc = 0
        if hits_ar >= HADITH_MIN_HITS_AR:
            sc += hits_ar * 120
        if hits_en >= HADITH_MIN_HITS_EN:
            sc += hits_en * 90
        if sc <= 0:
            continue
        scored.append((sc, h))

    scored.sort(key=lambda x: x[0], reverse=True)
    return [it for _, it in scored[:limit]]

def search_books(kws_ar: list, kws_en: list, phrase_ar: str, limit: int):
    if not kws_ar and not kws_en:
        return []
    chunks = GLOBAL_DATA["books_chunks"]

    cand = set()
    if kws_ar:
        cand |= build_candidates(GLOBAL_DATA["books_inv_ar"], kws_ar, cap=8000)
    if kws_en:
        cand |= build_candidates(GLOBAL_DATA["books_inv_en"], kws_en, cap=8000)

    scored = []
    for idx in cand:
        b = chunks[idx]
        hits_ar = count_hits(b.get("tokens_ar", []), kws_ar) if kws_ar else 0
        hits_en = count_hits(b.get("tokens_en", []), kws_en) if kws_en else 0

        # Strict: if Arabic keywords exist, require multiple hits
        if kws_ar and hits_ar < BOOKS_MIN_HITS_AR:
            continue

        sc = hits_ar * 120 + hits_en * 70
        if phrase_ar and phrase_ar in (b.get("norm_ar") or ""):
            sc += 220
        if hits_ar > 0 and hits_en > 0:
            sc += 60
        scored.append((sc, b))

    scored.sort(key=lambda x: x[0], reverse=True)
    return [it for _, it in scored[:limit]]

# Quran scan is only ~6236 ayat, safe to keep simple
def score_quran_match(query_norm: str, ayah_norm: str) -> int:
    if not query_norm or not ayah_norm:
        return 0
    if query_norm in ayah_norm:
        return 800 + min(len(query_norm), 250)
    q_words = [w for w in query_norm.split() if len(w) >= 3 and w not in AR_STOPWORDS]
    if not q_words:
        return 0
    hits = sum(1 for w in q_words if w in ayah_norm)
    if hits == 0:
        return 0
    return hits * 60

def search_quran_top(query_norm: str, limit: int = 5):
    if not query_norm:
        return []
    scored = []
    for item in GLOBAL_DATA["quran_index"]:
        sc = score_quran_match(query_norm, item.get("norm", ""))
        if sc > 0:
            scored.append((sc, item))
    scored.sort(key=lambda x: x[0], reverse=True)
    return scored[:limit]

def get_tafsir_for_ayah(surah: int, ayah: int):
    out = []
    s_str, a_str = str(surah), str(ayah)
    for key, data in GLOBAL_DATA["tafsir"].items():
        t = "N/A"
        try:
            if isinstance(data, dict) and s_str in data and isinstance(data[s_str], dict) and a_str in data[s_str]:
                t = data[s_str][a_str]
        except Exception:
            pass

        out.append({
            "tafsir": key,
            "text": t,
            "source_id": f"TAFSIR:{_safe_id_piece(key)}:{surah}:{ayah}:PRIMARY",
            "loc": f"{surah}:{ayah}",
            "label": f"{key} (primary {surah}:{ayah})",
        })
    return out

# ---------------------------------------------------------
# AI QUERY EXPANDER ("think again")
# ---------------------------------------------------------
def expand_query_with_ai(user_input: str, plan: dict) -> dict:
    client = genai_client()
    intent = plan.get("intent", "GENERAL_QA")

    exp_prompt = f"""
You help a retrieval system find relevant Quran/tafsir/hadith/books passages.

Return STRICT JSON ONLY:
{{
  "terms_ar": ["..."],
  "terms_en": ["..."],
  "ayah_refs": ["2:177","9:60"]
}}

Rules:
- Keep each list short (max 10 terms).
- Include synonyms and closely related terms.
- If you are not confident about ayah refs, return an empty list.
- Intent: {intent}

User question:
{user_input}
""".strip()

    resp = client.models.generate_content(model=ROUTER_MODEL, contents=exp_prompt)
    j = safe_json_from_text(resp.text or "")
    if not isinstance(j, dict):
        return {"terms_ar": [], "terms_en": [], "ayah_refs": []}

    terms_ar = [normalize_arabic(x) for x in (j.get("terms_ar") or []) if isinstance(x, str)]
    terms_en = [normalize_english(x) for x in (j.get("terms_en") or []) if isinstance(x, str)]
    ayah_refs = [str(x).strip() for x in (j.get("ayah_refs") or []) if isinstance(x, str)]

    ar_tokens = []
    for t in terms_ar:
        for w in t.split():
            if len(w) >= 3 and w not in AR_STOPWORDS:
                ar_tokens.append(w)

    en_tokens = []
    for t in terms_en:
        for w in t.split():
            if len(w) >= 3 and w not in EN_STOPWORDS:
                en_tokens.append(w)

    ar_tokens = list(dict.fromkeys(ar_tokens))[:12]
    en_tokens = list(dict.fromkeys(en_tokens))[:12]
    return {"terms_ar": ar_tokens, "terms_en": en_tokens, "ayah_refs": ayah_refs[:6]}

# ---------------------------------------------------------
# RETRIEVAL PIPELINE (multi-source, strict, fast)
# ---------------------------------------------------------
def build_evidence_pack(user_input: str, plan: dict):
    user_input = str(user_input).strip()
    refs, ranges = parse_ayah_refs(user_input)

    kws_ar = arabic_keywords(user_input, limit=10)
    kws_ar = expand_ar_terms_local(user_input, kws_ar)
    kws_en = english_keywords(user_input, limit=10)
    query_norm_ar = normalize_arabic(user_input)
    phrase_ar = query_norm_ar if len(query_norm_ar.split()) >= 3 else ""

    evidence = {
        "quran_candidates": [],
        "tafsir_passages": [],
        "hadith_passages": [],
        "book_passages": [],
    }

    # 1) explicit ayah refs/ranges
    if ranges:
        for s, a1, a2 in ranges[:2]:
            for a in range(a1, a2 + 1):
                item = get_quran_item(s, a)
                if item:
                    evidence["quran_candidates"].append({
                        "surah": item["s"], "ayah": item["a"],
                        "quran_text": item["txt"], "score": 9999,
                        "source_id": f"QURAN:{s}:{a}", "loc": f"{s}:{a}", "label": f"Quran {s}:{a}"
                    })

    if refs:
        for s, a in refs[:6]:
            item = get_quran_item(s, a)
            if item:
                evidence["quran_candidates"].append({
                    "surah": item["s"], "ayah": item["a"],
                    "quran_text": item["txt"], "score": 9999,
                    "source_id": f"QURAN:{s}:{a}", "loc": f"{s}:{a}", "label": f"Quran {s}:{a}"
                })

    # 2) Quran search
    if not evidence["quran_candidates"] and query_norm_ar:
        for sc, it in search_quran_top(query_norm_ar, limit=QURAN_TOP_K):
            s = it["s"]; a = it["a"]
            evidence["quran_candidates"].append({
                "surah": s, "ayah": a, "quran_text": it["txt"], "score": sc,
                "source_id": f"QURAN:{s}:{a}", "loc": f"{s}:{a}", "label": f"Quran {s}:{a}"
            })

    # 3) Tafsir
    for it in search_tafsir(kws_ar, phrase_ar, limit=TAFSIR_TOP_K):
        hits = count_hits(it.get("tokens_ar", []), kws_ar)
        sc = hits * 140 + (200 if phrase_ar and phrase_ar in it.get("norm","") else 0)
        evidence["tafsir_passages"].append({
            "source": it["source"], "surah": it["surah"], "ayah": it["ayah"],
            "text": it["text"], "score": sc,
            "source_id": it["source_id"], "loc": it["loc"], "label": it["label"],
        })

    # 4) Hadith (only if enabled)
    if plan.get("include_hadith", False):
        for h in search_hadith(kws_ar, kws_en, limit=HADITH_TOP_K):
            hits_ar = count_hits(h.get("tokens_ar", []), kws_ar) if kws_ar else 0
            hits_en = count_hits(h.get("tokens_en", []), kws_en) if kws_en else 0
            sc = hits_ar * 120 + hits_en * 90
            evidence["hadith_passages"].append({
                "source": h["source"], "arabic": h["arabic"], "english": h["english"],
                "number": h["number"], "book": h["book"],
                "score": sc,
                "source_id": h["source_id"], "loc": h["loc"], "label": h["label"],
            })

    # 5) Books
    for b in search_books(kws_ar, kws_en, phrase_ar, limit=BOOKS_TOP_K):
        hits_ar = count_hits(b.get("tokens_ar", []), kws_ar) if kws_ar else 0
        hits_en = count_hits(b.get("tokens_en", []), kws_en) if kws_en else 0
        sc = hits_ar * 120 + hits_en * 70 + (220 if phrase_ar and phrase_ar in (b.get("norm_ar") or "") else 0)
        evidence["book_passages"].append({
            "file": b.get("file", ""),
            "author": b.get("author", ""),
            "author_ar": b.get("author_ar", ""),
            "book_title": b.get("book_title", ""),
            "chunk_id": b.get("chunk_id", ""),
            "loc": b.get("loc", ""),
            "text": b.get("text", ""),
            "score": sc,
            "source_id": b.get("source_id", ""),
            "label": b.get("label", "Book"),
        })

    # Strength heuristic
    def evidence_strength(ev):
        strong_quran = any(c.get("score", 0) >= QURAN_CONFIDENCE_THRESHOLD or c.get("score", 0) == 9999 for c in ev["quran_candidates"])
        strong_tafsir = len(ev["tafsir_passages"]) >= 1
        strong_hadith = len(ev["hadith_passages"]) >= 1
        strong_books = len(ev["book_passages"]) >= 1
        return strong_quran or strong_tafsir or strong_hadith or strong_books

    # Retry once with AI term expansion if weak
    if not evidence_strength(evidence):
        exp = expand_query_with_ai(user_input, plan)
        kws_ar2 = list(dict.fromkeys([*kws_ar, *(exp.get("terms_ar", []) or [])]))[:12]
        kws_en2 = list(dict.fromkeys([*kws_en, *(exp.get("terms_en", []) or [])]))[:12]
        phrase_ar2 = normalize_arabic(user_input) if len(normalize_arabic(user_input).split()) >= 3 else ""

        if exp.get("ayah_refs"):
            for ref in exp["ayah_refs"]:
                m = AYAH_REF_RE.search(ref)
                if m:
                    s = int(m.group(1)); a = int(m.group(2))
                    item = get_quran_item(s, a)
                    if item:
                        evidence["quran_candidates"].append({
                            "surah": item["s"], "ayah": item["a"],
                            "quran_text": item["txt"], "score": 9999,
                            "source_id": f"QURAN:{s}:{a}", "loc": f"{s}:{a}", "label": f"Quran {s}:{a}"
                        })

        evidence["tafsir_passages"] = []
        for it in search_tafsir(kws_ar2, phrase_ar2, limit=TAFSIR_TOP_K):
            hits = count_hits(it.get("tokens_ar", []), kws_ar2)
            if hits < TAFSIR_MIN_HITS_AR:
                continue
            sc = hits * 140 + (200 if phrase_ar2 and phrase_ar2 in it.get("norm","") else 0)
            evidence["tafsir_passages"].append({
                "source": it["source"], "surah": it["surah"], "ayah": it["ayah"],
                "text": it["text"], "score": sc,
                "source_id": it["source_id"], "loc": it["loc"], "label": it["label"],
            })

        if plan.get("include_hadith", False):
            evidence["hadith_passages"] = []
            for h in search_hadith(kws_ar2, kws_en2, limit=HADITH_TOP_K):
                hits_ar = count_hits(h.get("tokens_ar", []), kws_ar2) if kws_ar2 else 0
                hits_en = count_hits(h.get("tokens_en", []), kws_en2) if kws_en2 else 0
                sc = hits_ar * 120 + hits_en * 90
                evidence["hadith_passages"].append({
                    "source": h["source"], "arabic": h["arabic"], "english": h["english"],
                    "number": h["number"], "book": h["book"],
                    "score": sc,
                    "source_id": h["source_id"], "loc": h["loc"], "label": h["label"],
                })

        evidence["book_passages"] = []
        for b in search_books(kws_ar2, kws_en2, phrase_ar2, limit=BOOKS_TOP_K):
            hits_ar = count_hits(b.get("tokens_ar", []), kws_ar2) if kws_ar2 else 0
            if kws_ar2 and hits_ar < BOOKS_MIN_HITS_AR:
                continue
            hits_en = count_hits(b.get("tokens_en", []), kws_en2) if kws_en2 else 0
            sc = hits_ar * 120 + hits_en * 70 + (220 if phrase_ar2 and phrase_ar2 in (b.get("norm_ar") or "") else 0)
            evidence["book_passages"].append({
                "file": b.get("file", ""),
                "author": b.get("author", ""),
                "author_ar": b.get("author_ar", ""),
                "book_title": b.get("book_title", ""),
                "chunk_id": b.get("chunk_id", ""),
                "loc": b.get("loc", ""),
                "text": b.get("text", ""),
                "score": sc,
                "source_id": b.get("source_id", ""),
                "label": b.get("label", "Book"),
            })

        kws_ar, kws_en = kws_ar2, kws_en2

    # Pick primary ayah only if confident
    primary = None
    q_sorted = sorted(evidence["quran_candidates"], key=lambda x: x.get("score", 0), reverse=True)
    if q_sorted:
        best = q_sorted[0]
        if best.get("score", 0) == 9999 or best.get("score", 0) >= QURAN_CONFIDENCE_THRESHOLD:
            primary = best

    return evidence, primary, kws_ar, kws_en

def build_retrieval(user_input: str, plan: dict):
    evidence, primary, kws_ar, kws_en = build_evidence_pack(user_input, plan)

    results = []

    # Quran candidates (top 3)
    candidates_out = []
    for c in sorted(evidence["quran_candidates"], key=lambda x: x.get("score", 0), reverse=True)[:3]:
        candidates_out.append({
            "surah": c["surah"], "ayah": c["ayah"], "quran_text": c["quran_text"], "score": c["score"],
            "source_id": c.get("source_id"), "loc": c.get("loc"), "label": c.get("label"),
        })

    # Tafsir passages
    for t in sorted(evidence["tafsir_passages"], key=lambda x: x.get("score", 0), reverse=True)[:TAFSIR_TOP_K]:
        results.append({
            "type": "tafsir_passage",
            "tafsir": t["source"],
            "surah": t["surah"],
            "ayah": t["ayah"],
            "source_id": t.get("source_id"),
            "loc": t.get("loc"),
            "label_override": t.get("label") or f"{t['source']} ({t['surah']}:{t['ayah']})",
            "text": t["text"],
        })

    # IMPORTANT CHANGE:
    # Full tafsir for primary ayah ONLY when user explicitly wants compare/differences.
    if primary and plan.get("intent") in ["COMPARE_TAFSIRS", "DIFFERENCES"]:
        for it in get_tafsir_for_ayah(primary["surah"], primary["ayah"]):
            results.append({
                "type": "tafsir_full_for_primary",
                "tafsir": it["tafsir"],
                "surah": primary["surah"],
                "ayah": primary["ayah"],
                "source_id": it.get("source_id"),
                "loc": it.get("loc"),
                "label_override": it.get("label") or f"{it['tafsir']} (primary {primary['surah']}:{primary['ayah']})",
                "text": it["text"],
            })

    # Hadith passages
    for h in sorted(evidence["hadith_passages"], key=lambda x: x.get("score", 0), reverse=True)[:HADITH_TOP_K]:
        parts = []
        if h.get("arabic"):
            parts.append(h["arabic"])
        if h.get("english"):
            parts.append(h["english"])
        meta = []
        if h.get("book"):
            meta.append(f"Book: {h['book']}")
        if h.get("number"):
            meta.append(f"Ref: {h['number']}")
        if meta:
            parts.append(" | ".join(meta))

        results.append({
            "type": "hadith_passage",
            "tafsir": "hadith",
            "source_id": h.get("source_id"),
            "loc": h.get("loc"),
            "label_override": h.get("label") or h.get("source", "Hadith"),
            "text": "\n\n".join(parts).strip()
        })

    # Books passages
    for b in sorted(evidence["book_passages"], key=lambda x: x.get("score", 0), reverse=True)[:BOOKS_TOP_K]:
        author_ar = b.get("author_ar") or ""
        author_en = b.get("author") or ""
        book_title = b.get("book_title") or b.get("file") or "Book"
        title = (author_ar + " — " + book_title).strip(" —") if author_ar else ((author_en + " — " + book_title).strip(" —") if author_en else book_title)

        results.append({
            "type": "book_passage",
            "tafsir": "books",
            "source_type": "book",
            "source_title": title or "Books",
            "author": b.get("author", ""),
            "book_title": book_title,
            "file": b.get("file", ""),
            "chunk_id": b.get("chunk_id", ""),
            "loc": b.get("loc", ""),
            "source_id": b.get("source_id", ""),
            "label_override": title or b.get("label", "Book"),
            "text": b.get("text", ""),
        })

    evidence_counts = {
        "quran_candidates": len(evidence["quran_candidates"]),
        "tafsir_passages": len(evidence["tafsir_passages"]),
        "hadith_passages": len(evidence["hadith_passages"]),
        "book_passages": len(evidence["book_passages"]),
    }

    if not results and not candidates_out:
        # Do NOT hard-fail. Return a "success" payload with empty evidence so the model can:
        # (1) explain limitations, (2) answer best-effort, (3) ask a follow-up.
        return {
            "status": "success",
            "surah": None,
            "ayah": None,
            "quran_text": "",
            "results": [],
            "candidates": [],
            "intent_plan": plan,
            "evidence_counts": evidence_counts,
            "retrieval_keywords": {"ar": kws_ar, "en": kws_en},
            "message": "No direct evidence was retrieved. The assistant will answer with limitations and a follow-up question.",
        }

    return {
        "status": "success",
        "surah": primary["surah"] if primary else None,
        "ayah": primary["ayah"] if primary else None,
        "quran_text": primary["quran_text"] if primary else "",
        "results": results,
        "candidates": candidates_out,
        "intent_plan": plan,
        "evidence_counts": evidence_counts,
        "retrieval_keywords": {"ar": kws_ar, "en": kws_en},
    }

# ---------------------------------------------------------
# GEMINI PROMPT (strict JSON + clean fallback)
# ---------------------------------------------------------
def clip(txt: str, n: int = MAX_EVIDENCE_CHARS_PER_BLOCK) -> str:
    txt = (txt or "").strip()
    return txt[:n]

def best_snippet(text: str, kws_ar: list, max_len: int = MAX_EVIDENCE_CHARS_PER_BLOCK) -> str:
    """
    Returns the most relevant paragraph/sentence chunk from a long text,
    using simple keyword hits. Keeps the prompt small + relevant.
    """
    text = (text or "").strip()
    if not text:
        return ""
    if len(text) <= max_len:
        return text

    # Split by paragraphs first
    parts = re.split(r"\n{2,}", text)
    if len(parts) <= 1:
        # fallback split by sentence-ish punctuation
        parts = re.split(r"[\.!\?؟]\s+", text)

    best = ""
    best_score = -1

    kws_ar = [w for w in (kws_ar or []) if isinstance(w, str) and w.strip()]
    for p in parts:
        p2 = (p or "").strip()
        if len(p2) < 30:
            continue
        norm = normalize_arabic(p2)
        score = sum(1 for w in kws_ar if w in norm)
        if score > best_score:
            best_score = score
            best = p2

    if best:
        return best[:max_len]
    return text[:max_len]

def build_intent_instructions(plan: dict) -> str:
    intent = plan.get("intent", "GENERAL_QA")
    style = plan.get("style", "normal")

    if intent == "SUMMARY":
        return "Provide a concise summary based only on the evidence."
    if intent == "EXPLAIN_SIMPLE":
        return "Explain in simple beginner-friendly language. Short sentences. Clear logic."
    if intent == "COMPARE_TAFSIRS":
        return "Compare tafsir viewpoints across sources. Summarize agreements and differences."
    if intent == "DIFFERENCES":
        return "Focus on differences across tafsir sources. Only mention differences supported by evidence."
    if intent == "KEY_POINTS":
        return "Return key takeaways as bullet points. Keep each point short."
    if intent == "FIND_AYAH":
        return "Identify the most relevant ayah(s) and explain why they match the user’s question using the evidence."
    if style == "detailed":
        return "Answer thoroughly, but do not add anything not supported by the evidence."
    return "Answer clearly and directly based only on the evidence."

def build_prompt(retrieval: dict, user_question: str, plan: dict) -> str:
    intent = plan.get("intent", "GENERAL_QA")
    language = plan.get("language", "both")
    style = plan.get("style", "normal")

    lang_instruction = "Return both Arabic and English fields."
    if language == "en":
        lang_instruction = "Fill English fields. Arabic fields may be empty strings."
    elif language == "ar":
        lang_instruction = "Fill Arabic fields. English fields may be empty strings."

    # Keywords for snippet extraction
    kws_ar = (retrieval.get("retrieval_keywords") or {}).get("ar") or []

    evidence_lines = []

    for c in (retrieval.get("candidates") or [])[:3]:
        sid = c.get("source_id") or f"QURAN:{c.get('surah')}:{c.get('ayah')}"
        label = c.get("label") or f"Quran {c.get('surah')}:{c.get('ayah')}"
        evidence_lines.append(f"[SRC:{sid}] {label}\n{clip(c.get('quran_text',''))}")

    for r in (retrieval.get("results") or [])[:MAX_EVIDENCE_BLOCKS]:
        sid = r.get("source_id") or _safe_id_piece(r.get("label_override") or r.get("tafsir") or r.get("type") or "SRC")
        label = r.get("label_override") or r.get("tafsir") or r.get("type") or "source"

        # IMPORTANT CHANGE: use snippet-only text to keep it relevant + cheaper
        raw_text = r.get("text", "")
        snippet = best_snippet(raw_text, kws_ar, max_len=MAX_EVIDENCE_CHARS_PER_BLOCK)
        evidence_lines.append(f"[SRC:{sid}] {label}\n{snippet}")

    evidence_block = "\n\n".join(evidence_lines) if evidence_lines else "N/A"
    intent_instructions = build_intent_instructions(plan)

    return f"""
You are a careful Islamic studies assistant.
You MUST NOT invent sources or claim that a source said something it did not. Use the evidence provided below. If evidence is missing or indirect, you may give a brief general clarification (not attributed to sources) and clearly label it as general guidance.
If evidence is insufficient to answer *directly*, do NOT stop.
Instead: (1) clearly state the limitation, (2) give the best-evidence-based guidance you can from what is available,
(3) suggest what evidence would be needed for a more direct answer.

Task type (intent): {intent}
Style: {style}
{intent_instructions}
{lang_instruction}

User question:
{user_question}

EVIDENCE:
Each evidence block starts with [SRC:<source_id>]. You MUST cite using these exact source_id values.
{evidence_block}

Return STRICT JSON ONLY with exactly these keys:
{{
  "arabic_answer": "string",
  "english_answer": "string",
  "key_points_ar": ["string"],
  "key_points_en": ["string"],
  "tafsir_differences_ar": ["string"],
  "tafsir_differences_en": ["string"],
  "citations": [
    {{"source_id":"string","note":"what you used"}}
  ]
}}

Citation rules:
- Every citation MUST use a source_id that appears exactly in EVIDENCE as [SRC:...].
- Include ONLY sources you actually used in the answer.
- If you used multiple evidence blocks, include multiple citations (max 8).
- Do not output anything outside JSON.
""".strip()

def run_gemini(retrieval: dict, user_question: str, plan: dict) -> dict:
    """
    Non-streaming call that returns a STRUCTURED JSON object for the frontend.
    Uses strict JSON prompting + response_mime_type, with a single repair retry if JSON parsing fails.
    """
    client = genai_client()
    prompt = build_prompt(retrieval, user_question, plan)

    # Debug (safe)
    try:
        results_count = len(retrieval.get("results") or [])
        candidates_count = len(retrieval.get("candidates") or [])
        print("DEBUG_PROMPT_CHARS =", len(prompt))
        print("DEBUG_EVIDENCE_RESULTS_COUNT =", results_count)
        print("DEBUG_EVIDENCE_CANDIDATES_COUNT =", candidates_count)
        print("DEBUG_PROMPT_PREVIEW =", prompt[:500])
    except Exception as e:
        print("DEBUG_PRINT_FAILED:", str(e))

    def _call(p: str):
        return client.models.generate_content(
            model=GEMINI_MODEL,
            contents=p,
            config={
                # Give enough room so the model can close JSON properly
                "max_output_tokens": int(os.environ.get("GEMINI_MAX_TOKENS_JSON", "1400")),
                "temperature": 0.15,
                "response_mime_type": "application/json",
            },
        )

    resp = _call(prompt)
    text = (resp.text or "").strip()
    print("DEBUG_GEMINI_RAW_START =", text[:1200])

    parsed = safe_json_from_text(text)
    print("DEBUG_PARSE_OK =", isinstance(parsed, dict))

    # If parsing failed, do ONE repair retry with extra constraints
    if not isinstance(parsed, dict):
        print("DEBUG_GEMINI_RAW_END =", text[-400:])
        repair_prompt = prompt + "\n\nIMPORTANT: Your previous output was not valid JSON. Return ONLY valid JSON and make sure it ends with a closing '}' and matches the required keys exactly."
        resp2 = _call(repair_prompt)
        text2 = (resp2.text or "").strip()
        print("DEBUG_GEMINI_RETRY_RAW_START =", text2[:1200])
        parsed = safe_json_from_text(text2)
        print("DEBUG_RETRY_PARSE_OK =", isinstance(parsed, dict))
        if isinstance(parsed, dict):
            text = text2
        else:
            text = text2 or text

    if isinstance(parsed, dict):
        parsed.setdefault("arabic_answer", "")
        parsed.setdefault("english_answer", "")
        parsed.setdefault("key_points_ar", [])
        parsed.setdefault("key_points_en", [])
        parsed.setdefault("tafsir_differences_ar", [])
        parsed.setdefault("tafsir_differences_en", [])
        parsed.setdefault("citations", [])
        return {
            "arabic_answer": clean_model_text(parsed.get("arabic_answer", "")),
            "english_answer": clean_model_text(parsed.get("english_answer", "")),
            "key_points_ar": parsed.get("key_points_ar") or [],
            "key_points_en": parsed.get("key_points_en") or [],
            "tafsir_differences_ar": parsed.get("tafsir_differences_ar") or [],
            "tafsir_differences_en": parsed.get("tafsir_differences_en") or [],
            "citations": parsed.get("citations") or [],
        }

    # Clean fallback (prevents "buggy texts" in frontend)
    cleaned = clean_model_text(text)
    return {
        "arabic_answer": cleaned if is_arabic_text(cleaned) else "",
        "english_answer": cleaned if not is_arabic_text(cleaned) else "",
        "key_points_ar": [],
        "key_points_en": [],
        "tafsir_differences_ar": [],
        "tafsir_differences_en": [],
        "citations": [],
        "raw_text": (text or "")[:2000],
    }

# ---------------------------------------------------------
# COMPARE BETWEEN TAFSIRS (structured request, no retrieval)
# ---------------------------------------------------------
def _coerce_tafsir_items(tafsirs):
    """
    Accepts:
      - list of {key,label?,text}
      - dict {key: text} or {key: {label,text}}
    Returns a normalized list of {key,label,text}.
    """
    out = []
    if isinstance(tafsirs, list):
        for it in tafsirs:
            if not isinstance(it, dict):
                continue
            key = str(it.get("key") or it.get("id") or it.get("name") or "").strip()
            text = str(it.get("text") or it.get("content") or "").strip()
            if not (key and text):
                continue
            label = str(it.get("label") or it.get("title") or key).strip()
            out.append({"key": key, "label": label, "text": text})
        return out

    if isinstance(tafsirs, dict):
        for k, v in tafsirs.items():
            key = str(k).strip()
            label = key
            text = ""
            if isinstance(v, str):
                text = v.strip()
            elif isinstance(v, dict):
                label = str(v.get("label") or v.get("title") or key).strip()
                text = str(v.get("text") or v.get("content") or "").strip()
            if key and text:
                out.append({"key": key, "label": label, "text": text})
        return out

    return out


def build_compare_prompt(surah: int, ayah: int, quran_text: str, tafsir_items: list, language: str = "ar") -> str:
    """
    Compare tafsir texts with a natural, analytical flow using Markdown formatting.
    """
    # Arabic by default
    lang = (language or "").lower().strip()
    if lang.startswith("en"):
        lang_instruction = (
            "Write in English.\n"
            "Use a clear, analytical style."
        )
    else:
        lang_instruction = (
            "اكتب بالعربية.\n"
            "استخدم أسلوباً تحليلياً مترابطاً، وليس مجرد سرد."
        )

    # Keep prompt size controlled
    blocks = []
    for it in (tafsir_items or [])[:12]:
        label = (it.get("label") or it.get("key") or "مصدر").strip()
        txt = clip(it.get("text", ""), n=int(os.environ.get("COMPARE_MAX_CHARS_PER_TAFSIR", "1200")))
        blocks.append(f"### {label}\n{txt}")

    joined = "\n\n".join(blocks) if blocks else "N/A"
    ay = f"{surah}:{ayah}" if (surah and ayah) else "—"
    qtxt = clip(quran_text or "", n=700)

    return f"""
You are an expert Islamic scholar assistant.

Task:
Analyze the differences and similarities between the provided Tafsir explanations for Ayah {ay}.

Guidelines for the Answer:
1. **Do NOT just list** the tafsirs one by one (e.g., don't do "- Tabari said... - Ibn Kathir said...").
2. **Synthesize** the information. Group similar opinions together and highlight the differences.
3. Example flow: "Most scholars like **Al-Tabari** and **Ibn Kathir** agree that X means Y, whereas **Al-Qurtubi** adds a linguistic nuance that..."
4. **Use Bold** (markdown like **text**) for Scholar Names and Key Terms to make the text beautiful and readable.
5. Keep the tone respectful, clear, and easy to read.

Context:
- Quran text: {qtxt}

Provided Tafsirs:
{joined}

Output requirements:
- Return the answer in plain text with Markdown formatting (**bold**).
- No JSON.
- Keep it concise (approx 8-12 lines).

Language Instructions:
{lang_instruction}
""".strip()
    return router_prompt

def run_compare_model(surah: int, ayah: int, quran_text: str, tafsir_items: list, language: str = "ar") -> str:
    """Run the LLM to produce a short bullet comparison for the provided tafsir texts."""
    client = genai_client()
    prompt = build_compare_prompt(surah, ayah, quran_text, tafsir_items, language=language)

    # FIX: Use 4000 tokens for plenty of space
    max_total = int(os.environ.get("GEMINI_MAX_TOKENS_COMPARE", "4000"))

    try:
        # Generate content
        # Note: Removed 'response_mime_type' as it defaults to text/plain and explicit assignment can sometimes cause 500s.
        resp = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=prompt,
            config={
                "temperature": 0.2,
                "max_output_tokens": max_total,
            },
        )
        
        # Safety Check: Ensure we actually got a response text
        if not resp.text:
            print("WARNING: Gemini returned empty text for compare.")
            return "عذراً، لم أتمكن من توليد المقارنة في الوقت الحالي." if language != "en" else "Sorry, could not generate comparison at this time."
            
        return clean_model_text(resp.text.strip())

    except Exception as e:
        print(f"ERROR in run_compare_model: {e}")
        # Return a polite error string instead of crashing the HTTP request
        return "حدث خطأ أثناء معالجة المقارنة." if language != "en" else "An error occurred while processing the comparison."

    out1 = call_model(prompt, first_budget)

    # If it looks cut off, continue once and stitch.
    if _needs_continuation(out1) and cont_budget >= 120:
        cont_prompt = (
            "Continue the SAME answer from exactly where you stopped. "
            "Do NOT repeat earlier text. "
            "Finish any remaining sections and end with a punctuation mark.\n\n"
            "LAST OUTPUT (tail):\n"
            + out1[-800:]
        )
        out2 = call_model(cont_prompt, cont_budget)
        # Avoid accidental duplication
        if out2:
            stitched = (out1 + "\n" + out2).strip()
        else:
            stitched = out1.strip()
        return stitched

    return out1.strip()


# ---------------------------------------------------------
# STREAMING (SSE)
# ---------------------------------------------------------
def _sse(event: str, data) -> str:
    """Server-Sent Events helper."""
    return f"event: {event}\n" + f"data: {json.dumps(data, ensure_ascii=False)}\n\n"

def build_prompt_stream(retrieval: dict, user_question: str, plan: dict) -> str:
    """Prompt for streaming: plain-text answer (no JSON) so UI shows real-time typing."""
    language = plan.get("language", "both")
    if language == "en":
        lang_instruction = "Write the answer in English only."
    else:
        lang_instruction = "اكتب الجواب بالعربية فقط."

    intent_instr = build_intent_instructions(plan)

    kws_ar = (retrieval.get("retrieval_keywords") or {}).get("ar") or []
    evidence_lines = []

    for c in (retrieval.get("candidates") or [])[:3]:
        sid = c.get("source_id") or f"QURAN:{c.get('surah')}:{c.get('ayah')}"
        label = c.get("label") or f"Quran {c.get('surah')}:{c.get('ayah')}"
        evidence_lines.append(f"[SRC:{sid}] {label}\n{clip(c.get('quran_text',''))}")

    for it in (retrieval.get("results") or [])[:MAX_EVIDENCE_BLOCKS]:
        sid = it.get("source_id") or it.get("loc") or it.get("label_override") or "SRC"
        label = it.get("label_override") or it.get("source_title") or it.get("tafsir") or "Source"
        txt = best_snippet(it.get("text",""), kws_ar, max_len=MAX_EVIDENCE_CHARS_PER_BLOCK)
        evidence_lines.append(f"[SRC:{sid}] {label}\n{clip(txt)}")

    evidence = "\n\n---\n\n".join(evidence_lines)

    return f"""
You are a Quran/Tafsir/Hadith/Islamic books assistant.

Rules:
- Use the evidence below. If evidence is missing/indirect, give brief general clarification (not attributed to sources) and clearly state the limitation.
- If evidence is insufficient to answer directly, say what is missing, give the best guidance you can from what is available, and suggest 1 follow-up question.
- No HTML. No markdown. No code fences.
- Keep it clean and readable.

Task:
{intent_instr}
{lang_instruction}

User question:
{user_question}

Evidence:
{evidence}
""".strip()


def run_gemini_stream(retrieval: dict, user_question: str, plan: dict):
    """Streams a plain-text answer in real time, then sends a final structured object."""
    client = genai_client()
    prompt = build_prompt_stream(retrieval, user_question, plan)

    try:
        print("DEBUG_STREAM_PROMPT_CHARS =", len(prompt))
        print("DEBUG_STREAM_EVIDENCE_RESULTS_COUNT =", len(retrieval.get("results") or []))
        print("DEBUG_STREAM_EVIDENCE_CANDIDATES_COUNT =", len(retrieval.get("candidates") or []))
    except Exception:
        pass

    buf = []
    try:
        stream = client.models.generate_content_stream(
            model=GEMINI_MODEL,
            contents=prompt,
            config={
                "temperature": 0.2,
                "max_output_tokens": 1400,
            },
        )
        for part in stream:
            chunk = getattr(part, "text", None)
            if not chunk:
                try:
                    chunk = part.candidates[0].content.parts[0].text
                except Exception:
                    chunk = ""
            if chunk:
                buf.append(chunk)
                yield ("chunk", {"text": chunk})
    except Exception as e:
        yield ("error", {"error": str(e)})
        return

    full_text = clean_model_text("".join(buf))
    is_ar = is_arabic_text(user_question or "") or is_arabic_text(full_text)
    ai = {
        "arabic_answer": full_text if is_ar else "",
        "english_answer": full_text if not is_ar else "",
        "key_points_ar": [],
        "key_points_en": [],
        "tafsir_differences_ar": [],
        "tafsir_differences_en": [],
        "citations": [],
    }
    yield ("done", {"ai": ai, "raw_text": (full_text or "")[:4000]})




# ---------------------------------------------------------
# HTTP ENTRY
# ---------------------------------------------------------
def get_cors_headers(request, base_headers=None):
    """
    Returns headers dict with proper CORS (Allow-Origin) if Origin is allowed.
    Allowed: http://localhost:5173, https://m7mdiyat.com, plus env var.
    """
    h = base_headers.copy() if base_headers else {}
    
    # Remove default wildcard if present to enforce strict whitelist
    h.pop("Access-Control-Allow-Origin", None)
    
    # Common CORS headers
    h["Access-Control-Allow-Methods"] = "POST, OPTIONS"
    h["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    h["Access-Control-Max-Age"] = "86400"
    h["Vary"] = "Origin" # Important for caching proxies

    # Whitelist
    whitelist = [
        "http://localhost:5173",
        "https://m7mdiyat.com",
    ]
    env_domain = os.environ.get("FRONTEND_DOMAIN")
    if env_domain:
        whitelist.append(env_domain)

    origin = request.headers.get("Origin")
    
    # If Origin is present and allowed, reflect it.
    # If Origin is invalid, we do NOT return ACAO (effectively blocking it in browser)
    # If no Origin (curl), we mostly strictly valid browsers matter.
    if origin and (origin in whitelist or origin.rstrip("/") in whitelist):
        h["Access-Control-Allow-Origin"] = origin
    
    return h

# Flask routes
@app.before_request
def handle_options():
    """Handle OPTIONS preflight for all routes"""
    if request.method == "OPTIONS":
        headers = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
        }
        try:
            headers = get_cors_headers(request, headers)
        except Exception:
            pass
        return ("", 204, headers)

@app.get("/health")
def health_check():
    """Health check endpoint - lightweight, no heavy logic"""
    return jsonify({"status": "ok"}), 200

# ---------------------------------------------------------
# TAFSIR ENDPOINT - SQLite only, no initialize_data()
# ---------------------------------------------------------
@app.route("/tafsir", methods=["OPTIONS"])
def tafsir_options():
    """Handle OPTIONS for /tafsir - no DB access"""
    headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
    }
    try:
        headers = get_cors_headers(request, headers)
    except Exception:
        pass
    return ("", 204, headers)

@app.post("/tafsir")
def tafsir_post():
    """POST /tafsir - SQLite query with minimal logging"""
    import traceback
    t_start = time.time()
    DEBUG = os.environ.get("DEBUG_TAFSIR") == "1"
    
    headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Content-Type": "application/json",
    }
    try:
        headers = get_cors_headers(request, headers)
    except Exception:
        pass
    
    try:
        # STEP 1: Parse and validate input
        print(f"STEP 1: parse input @ {int((time.time()-t_start)*1000)}ms")
        
        # Parse JSON
        body = request.get_json(silent=True)
        if body is None:
            body = request.get_json(force=True, silent=True)
        if body is None:
            raw_data = request.get_data(as_text=True)
            if raw_data:
                try:
                    body = json.loads(raw_data)
                except Exception:
                    pass
        
        if not body or not isinstance(body, dict):
            return (json.dumps({"status": "error", "message": "Could not parse JSON body"}, ensure_ascii=False), 400, headers)
        
        # Extract and validate
        raw_surah = body.get("surah")
        raw_ayah = body.get("ayah")
        raw_tafsirs = body.get("tafsirs")
        
        if DEBUG:
            print(f"DEBUG: body={body}")
        
        try:
            surah = int(raw_surah) if raw_surah is not None else 0
        except (ValueError, TypeError):
            return (json.dumps({"status": "error", "message": f"Invalid surah value: {raw_surah}"}, ensure_ascii=False), 400, headers)
        
        try:
            ayah = int(raw_ayah) if raw_ayah is not None else 0
        except (ValueError, TypeError):
            return (json.dumps({"status": "error", "message": f"Invalid ayah value: {raw_ayah}"}, ensure_ascii=False), 400, headers)
        
        if surah < 1 or surah > 114:
            return (json.dumps({"status": "error", "message": f"Surah must be 1-114, got: {surah}"}, ensure_ascii=False), 400, headers)
        
        if ayah < 1:
            return (json.dumps({"status": "error", "message": f"Ayah must be >= 1, got: {ayah}"}, ensure_ascii=False), 400, headers)
        
        requested_keys = raw_tafsirs if isinstance(raw_tafsirs, list) else []
        if not requested_keys:
            return (json.dumps({"status": "error", "message": "tafsirs must be a non-empty list"}, ensure_ascii=False), 400, headers)
        
        # STEP 2: Get DB connection
        print(f"STEP 2: get db @ {int((time.time()-t_start)*1000)}ms")
        
        conn = get_db_connection()
        if not conn:
            return (json.dumps({"status": "error", "message": "Database unavailable"}, ensure_ascii=False), 500, headers)
        
        cursor = conn.cursor()
        
        # Verify tafsir table exists
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='tafsir';")
        if not cursor.fetchone():
            return (json.dumps({"status": "error", "message": "'tafsir' table not found"}, ensure_ascii=False), 500, headers)
        
        # STEP 3: Query
        print(f"STEP 3: query @ {int((time.time()-t_start)*1000)}ms")
        out_data = {}
        
        for key in requested_keys:
            k = key.lower().strip()
            cursor.execute("SELECT text FROM tafsir WHERE source=? AND surah=? AND ayah=?", (k, surah, ayah))
            row = cursor.fetchone()
            text_val = row[0] if row else "N/A"
            if not text_val:
                text_val = "N/A"
            out_data[k] = text_val
        
        # STEP 4: Build response
        print(f"STEP 4: response @ {int((time.time()-t_start)*1000)}ms")
        
        return (json.dumps({
            "status": "ok",
            "surah": surah,
            "ayah": ayah,
            "tafsirs": out_data
        }, ensure_ascii=False), 200, headers)
    
    except Exception as e:
        print(f"❌ TAFSIR ERROR: {e}")
        print(traceback.format_exc())
        return (json.dumps({"status": "error", "message": "Internal Server Error", "debug": str(e)}, ensure_ascii=False), 500, headers)

# ---------------------------------------------------------
# COMPARE-TEXT ENDPOINT - Pre-computed comparisons from SQLite
# ---------------------------------------------------------
@app.route("/compare-text", methods=["OPTIONS"])
def compare_text_options():
    """Handle OPTIONS for /compare-text - no DB access"""
    headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
    }
    try:
        headers = get_cors_headers(request, headers)
    except Exception:
        pass
    return ("", 204, headers)

@app.post("/compare-text")
def compare_text_post():
    """POST /compare-text - Fetch pre-computed comparison from SQLite"""
    import traceback
    t_start = time.time()
    
    headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Content-Type": "application/json",
    }
    try:
        headers = get_cors_headers(request, headers)
    except Exception:
        pass
    
    try:
        print(f"COMPARE-TEXT: start @ {int((time.time()-t_start)*1000)}ms")
        
        # Parse JSON
        body = request.get_json(silent=True)
        if body is None:
            body = request.get_json(force=True, silent=True)
        if not body or not isinstance(body, dict):
            return (json.dumps({"status": "error", "message": "Could not parse JSON body"}, ensure_ascii=False), 400, headers)
        
        # Extract surah and ayah
        raw_surah = body.get("surah")
        raw_ayah = body.get("ayah")
        
        try:
            surah = int(raw_surah) if raw_surah is not None else 0
            ayah = int(raw_ayah) if raw_ayah is not None else 0
        except (ValueError, TypeError):
            return (json.dumps({"status": "error", "message": "Invalid surah/ayah values"}, ensure_ascii=False), 400, headers)
        
        if surah < 1 or surah > 114 or ayah < 1:
            return (json.dumps({"status": "error", "message": f"Invalid surah ({surah}) or ayah ({ayah})"}, ensure_ascii=False), 400, headers)
        
        print(f"COMPARE-TEXT: query surah={surah}, ayah={ayah} @ {int((time.time()-t_start)*1000)}ms")
        
        # Get DB connection
        conn = get_compare_db_connection()
        if not conn:
            return (json.dumps({"status": "error", "message": "Comparisons database unavailable"}, ensure_ascii=False), 500, headers)
        
        cursor = conn.cursor()
        
        # Query for comparison text
        # Schema: surah, ayah, comparison_text
        cursor.execute("SELECT comparison_text FROM comparisons WHERE surah=? AND ayah=?", (surah, ayah))
        row = cursor.fetchone()
        
        print(f"COMPARE-TEXT: done @ {int((time.time()-t_start)*1000)}ms")
        
        if row and row[0]:
            return (json.dumps({
                "status": "ok",
                "surah": surah,
                "ayah": ayah,
                "comparison_text": row[0]
            }, ensure_ascii=False), 200, headers)
        else:
            return (json.dumps({
                "status": "not_found",
                "surah": surah,
                "ayah": ayah,
                "message": "المقارنة غير متوفرة لهذه الآية"
            }, ensure_ascii=False), 200, headers)
    
    except Exception as e:
        print(f"❌ COMPARE-TEXT ERROR: {e}")
        print(traceback.format_exc())
        return (json.dumps({"status": "error", "message": "Internal Server Error", "debug": str(e)}, ensure_ascii=False), 500, headers)


@app.route("/", defaults={"path": ""}, methods=["GET", "POST"])
@app.route("/<path:path>", methods=["GET", "POST"])
def catch_all(path):
    """Catch-all route for other endpoints (AI, compare, etc.)"""
    # Skip paths handled by dedicated routes
    if path == "health" or path.startswith("tafsir") or path.startswith("compare-text"):
        return jsonify({"status": "error", "message": "Route not found"}), 404
    
    try:
        return _hello_http_logic(request)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"status": "error", "error": "Internal Server Error", "details": str(e)}), 500

def _hello_http_logic(req):
    # 1. Headers & CORS
    headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Content-Type": "application/json",
    }
    try:
        headers = get_cors_headers(req, headers)
    except Exception:
        pass

    # 2. Request Metadata
    path = (req.path or "/").lower()

    # 5. Core Application Logic
    body = {}
    args = req.args or {}

    if req.method == "GET":
        user_input = args.get("message") or args.get("question") or ""
    else:
        body = req.get_json(silent=True) or {}
        user_input = body.get("message") or body.get("question") or ""


    # -----------------------------------------------------
    # COMPARE MODE (structured request)
    # Supports:
    #   POST /compare  {surah, ayah, quran_text?, tafsirs: [...] , language?}
    #   POST /ai       with the same payload and mode/intent flags
    # -----------------------------------------------------
    compare_mode = False
    if req.method != "GET":
        try:
            mode = str(body.get("mode") or "").lower().strip()
            intent = str(body.get("intent") or "").upper().strip()
            if mode in ["compare", "compare_tafsirs"] or intent == "COMPARE_TAFSIRS":
                compare_mode = True
            if body.get("tafsirs") is not None and (body.get("surah") or body.get("ayah")):
                # If tafsirs are present, treat as compare (even if flags missing)
                compare_mode = True
        except Exception:
            compare_mode = False

    if path.startswith("/compare") or (path.startswith("/ai") and compare_mode):
        try:
            surah = int(body.get("surah") or 0)
            ayah = int(body.get("ayah") or 0)
        except Exception:
            surah, ayah = 0, 0

        language = str(body.get("language") or body.get("lang") or "ar").strip().lower()
        quran_text = str(body.get("quran_text") or body.get("ayah_text") or "").strip()
        tafsir_items = _coerce_tafsir_items(body.get("tafsirs"))

        if not tafsir_items:
            return (json.dumps({"status": "error", "error": "No tafsir texts provided for compare."}, ensure_ascii=False), 400, headers)

        try:
            t0 = time.time()
            comparison = run_compare_model(surah, ayah, quran_text, tafsir_items, language=language)
            return (json.dumps({
                "status": "ok",
                "surah": surah or None,
                "ayah": ayah or None,
                "comparison": comparison,
                "total_ms": int((time.time()-t0)*1000),
            }, ensure_ascii=False), 200, headers)
        except Exception as e:
            return (json.dumps({"status": "error", "error": str(e)}, ensure_ascii=False), 500, headers)

    # Normal Q/A mode (message-based)
    user_input = str(user_input).strip()
    if not user_input:
        return (json.dumps({"status": "error", "error": "No input"}, ensure_ascii=False), 400, headers)

    if user_input == "DEBUG_STATS":
        return (json.dumps({
            "status": "ok",
            "stats": {
                "loaded": True,
                "quran_ayahs": len(GLOBAL_DATA["quran_index"]),
                "tafsir_flat": len(GLOBAL_DATA["tafsir_flat"]),
                "hadith_count": len(GLOBAL_DATA["hadith"]),
                "books_chunks": len(GLOBAL_DATA.get("books_chunks", [])),
                "books_prefix": BOOKS_PREFIX,
                "books_files_count": len(GLOBAL_DATA.get("books_files", [])),
                "books_files_sample": [x.split("/")[-1] for x in (GLOBAL_DATA.get("books_files", [])[:12])],
                "strictness": {
                    "BOOKS_MIN_HITS_AR": BOOKS_MIN_HITS_AR,
                    "TAFSIR_MIN_HITS_AR": TAFSIR_MIN_HITS_AR,
                    "HADITH_MIN_HITS_AR": HADITH_MIN_HITS_AR,
                    "HADITH_MIN_HITS_EN": HADITH_MIN_HITS_EN,
                },
                "models": {
                    "gemini": GEMINI_MODEL,
                    "router": ROUTER_MODEL,
                },
                "limits": {
                    "MAX_EVIDENCE_BLOCKS": MAX_EVIDENCE_BLOCKS,
                    "MAX_EVIDENCE_CHARS_PER_BLOCK": MAX_EVIDENCE_CHARS_PER_BLOCK,
                },
                "path": path,
            }
        }, ensure_ascii=False), 200, headers)

    # AI endpoint
    if path.startswith("/ai"):

        # SSE streaming: use /ai/stream OR ?stream=1 OR Accept: text/event-stream
        wants_stream = False
        try:
            if path.startswith("/ai/stream"):
                wants_stream = True
            else:
                args = req.args or {}
                if str(args.get("stream", "")).strip() == "1":
                    wants_stream = True
                accept = req.headers.get("Accept", "")
                if "text/event-stream" in (accept or ""):
                    wants_stream = True
        except Exception:
            wants_stream = False

        if wants_stream:
            def event_gen():
                try:
                    t0 = time.time()
                    # Send something immediately so the browser shows streaming is alive
                    yield _sse("meta", {"stage": "boot", "ms": 0})

                    if not GLOBAL_DATA.get("loaded"):
                        t_load = time.time()
                        yield _sse("meta", {"stage": "loading_data"})
                        initialize_data()
                        yield _sse("meta", {"stage": "loaded_data", "ms": int((time.time()-t_load)*1000)})

                    t_route = time.time()
                    plan = route_intent(user_input)
                    yield _sse("meta", {"stage": "routed", "ms": int((time.time()-t_route)*1000), "plan": plan})

                    t_ret = time.time()
                    retrieval = build_retrieval(user_input, plan)
                    yield _sse("meta", {"stage": "retrieval", "ms": int((time.time()-t_ret)*1000), "retrieval": retrieval})

                    if retrieval.get("status") != "success":
                        yield _sse("final", {"status": retrieval.get("status"), "retrieval": retrieval})
                        return

                    # Stream model output
                    for ev, payload in run_gemini_stream(retrieval, user_input, plan):
                        yield _sse(ev, payload)

                    yield _sse("final", {"status": "ok", "total_ms": int((time.time()-t0)*1000)})
                except Exception as e:
                    yield _sse("error", {"error": str(e)})

            stream_headers = {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, Accept",
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-cache, no-transform",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            }
            return Response(stream_with_context(event_gen()), headers=stream_headers)
        try:
            t0 = time.time()

            if not GLOBAL_DATA.get("loaded"):
                initialize_data()

            t_route = time.time()
            plan = route_intent(user_input)
            print("T_ROUTE_MS =", int((time.time() - t_route) * 1000))

            t_ret = time.time()
            retrieval = build_retrieval(user_input, plan)
            print("T_RETRIEVAL_MS =", int((time.time() - t_ret) * 1000))

            if retrieval.get("status") != "success":
                print("T_TOTAL_MS =", int((time.time() - t0) * 1000))
                return (json.dumps(retrieval, ensure_ascii=False), 200, headers)

            t_gem = time.time()
            ai = run_gemini(retrieval, user_input, plan)
            print("T_GEMINI_MS =", int((time.time() - t_gem) * 1000))

            print("T_TOTAL_MS =", int((time.time() - t0) * 1000))
            return (json.dumps({**retrieval, "ai": ai}, ensure_ascii=False), 200, headers)

        except Exception as e:
            return (json.dumps({
                "status": "error",
                "error": str(e),
                "hint": "If this is a timeout, reduce BOOKS_MAX_LINES_PER_FILE or raise strictness thresholds.",
            }, ensure_ascii=False), 500, headers)

    # Non-AI endpoint (retrieval only)
    try:
        if not GLOBAL_DATA.get("loaded"):
            initialize_data()

        plan = {"intent": "FIND_AYAH", "language": "both", "style": "concise", "include_hadith": False}
        retrieval = build_retrieval(user_input, plan)
        return (json.dumps(retrieval, ensure_ascii=False), 200, headers)
    except Exception as e:
        return (json.dumps({"status": "error", "error": str(e)}, ensure_ascii=False), 500, headers)