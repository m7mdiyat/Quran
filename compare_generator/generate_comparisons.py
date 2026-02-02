import os
import json
import sqlite3
import time   # ⬅️ ADD THIS LINE
from datetime import datetime
from typing import Any, Dict, Optional, Iterator, Tuple

# Google Gen AI SDK (Vertex AI)
from google import genai
from google.genai.types import HttpOptions

# ----------------------------
# CONFIG (EDIT THIS)
# ----------------------------

TAFSIR_DIR = r"D:\Vite\m7mdiyat-vite\public"   # your tafsir JSON folder
OUTPUT_SQLITE = r".\comparisons.sqlite"       # in same folder as this script

# Pick model (Vertex AI). If this exact model name fails, we'll adjust after you test.
MODEL_ID = "gemini-3-flash-preview"

# NOTE:
# We no longer use TARGET_SURAH / TARGET_AYAHS for full-Quran generation.
# They are intentionally removed to avoid accidentally limiting the run.

TAFSIR_FILES = {
    "baghawi": "tafseer_baghawi.json",
    "ibn_ashur": "tafseer_ibn_ashur.json",
    "ibn_kathir": "tafseer_ibn_kathir.json",
    "muyassar": "tafseer_muyassar.json",
    "qurtubi": "tafseer_qurtubi.json",
    "saadi": "tafseer_saadi.json",
    "tabari": "tafseer_tabari.json",
}

# Optional: set these environment variables before running (recommended)
#   setx GOOGLE_CLOUD_PROJECT "YOUR_PROJECT_ID"
#   setx GOOGLE_CLOUD_REGION  "us-central1"
PROJECT_ID = os.environ.get("GOOGLE_CLOUD_PROJECT", "")
REGION = os.environ.get("GOOGLE_CLOUD_REGION", "global")

# ----------------------------
# Generation settings
# ----------------------------
# IMPORTANT: unchanged (prompt/results behavior)
TEMPERATURE = 0.2
MAX_OUTPUT_TOKENS = 3300   # ⬅️ increase this number for longer output
MAX_RETRIES = 3
RETRY_SLEEP_SECONDS = 2


# ----------------------------
# Qur'an verse counts (114 surahs)
# ----------------------------
# Used to iterate the full Qur'an safely without needing an extra Quran file.
# (Surah 1..114)
QURAN_VERSE_COUNTS = [
    7, 286, 200, 176, 120, 165, 206, 75, 129, 109,
    123, 111, 43, 52, 99, 128, 111, 110, 98, 135,
    112, 78, 118, 64, 77, 227, 93, 88, 69, 60,
    34, 30, 73, 54, 45, 83, 182, 88, 75, 85,
    54, 53, 89, 59, 37, 35, 38, 29, 18, 45,
    60, 49, 62, 55, 78, 96, 29, 22, 24, 13,
    14, 11, 11, 18, 12, 12, 30, 52, 52, 44,
    28, 28, 20, 56, 40, 31, 50, 40, 46, 42,
    29, 19, 36, 25, 22, 17, 19, 26, 30, 20,
    15, 21, 11, 8, 8, 19, 5, 8, 8, 11,
    11, 8, 3, 9, 5, 4, 7, 3, 6, 3,
    5, 4, 5, 6
]


def iter_all_surah_ayahs() -> Iterator[Tuple[int, int]]:
    """Yield (surah, ayah) for the entire Qur'an in order."""
    for idx, count in enumerate(QURAN_VERSE_COUNTS, start=1):
        for ayah in range(1, count + 1):
            yield idx, ayah


# ----------------------------
# JSON loading + extraction
# ----------------------------

def load_json(path: str) -> Any:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

def normalize_int(x) -> Optional[int]:
    try:
        return int(str(x).strip())
    except Exception:
        return None

def find_text_in_entry(entry: Dict[str, Any]) -> Optional[str]:
    for key in ["text", "tafseer", "tafsir", "content", "body", "meaning", "explanation"]:
        if key in entry and isinstance(entry[key], str) and entry[key].strip():
            return entry[key].strip()
    return None

def extract_from_list(data_list: list, surah: int, ayah: int) -> Optional[str]:
    for item in data_list:
        if not isinstance(item, dict):
            continue
        s = normalize_int(item.get("sura") or item.get("surah") or item.get("chapter"))
        a = normalize_int(item.get("aya") or item.get("ayah") or item.get("verse"))
        if s == surah and a == ayah:
            txt = find_text_in_entry(item)
            if txt:
                return txt
    return None

def extract_from_dict_keys(data_dict: dict, surah: int, ayah: int) -> Optional[str]:
    key1 = f"{surah}:{ayah}"
    if key1 in data_dict and isinstance(data_dict[key1], str):
        t = data_dict[key1].strip()
        if t:
            return t

    s_key = str(surah)
    a_key = str(ayah)
    if s_key in data_dict:
        sub = data_dict[s_key]
        if isinstance(sub, dict) and a_key in sub and isinstance(sub[a_key], str):
            t = sub[a_key].strip()
            if t:
                return t
        if isinstance(sub, list):
            t = extract_from_list(sub, surah, ayah)
            if t:
                return t

    return None

def deep_search(data: Any, surah: int, ayah: int) -> Optional[str]:
    if isinstance(data, list):
        t = extract_from_list(data, surah, ayah)
        if t:
            return t
        for x in data:
            t = deep_search(x, surah, ayah)
            if t:
                return t

    if isinstance(data, dict):
        t = extract_from_dict_keys(data, surah, ayah)
        if t:
            return t

        for wrapper_key in ["tafsir", "tafseer", "data", "result", "items", "verses"]:
            if wrapper_key in data:
                t = deep_search(data[wrapper_key], surah, ayah)
                if t:
                    return t

        for v in data.values():
            t = deep_search(v, surah, ayah)
            if t:
                return t

    return None

def get_tafsir_text(tafsir_name: str, tafsir_json: Any, surah: int, ayah: int) -> str:
    text = deep_search(tafsir_json, surah, ayah)
    if not text:
        return f"(Missing tafsir text for {tafsir_name} surah={surah} ayah={ayah})"
    return text


# ----------------------------
# Prompt builder
# ----------------------------
# IMPORTANT: kept exactly the same as your original prompt logic/text.

def build_prompt(surah: int, ayah: int, tafsir_texts: dict) -> str:
    def clip(t: str, n: int) -> str:
        t = (t or "").strip()
        return t[:n]

    max_chars = 3300
    blocks = []
    for name, text in (tafsir_texts or {}).items():
        label = (name or "مصدر").strip()
        txt = clip(text, max_chars)
        blocks.append(f"### {label}\n{txt}")

    tafsir_blocks = "\n\n".join(blocks) if blocks else "N/A"
    lang_instruction = "اكتب الجواب بالعربية الواضحة فقط."

    return f"""
You are an expert Islamic scholar assistant.

Task:
Analyze the differences and similarities between the provided Tafsir explanations for Qur'an {surah}:{ayah}.

HARD RULES:
 - Do NOT invent narrations, names, events, causes of revelation, or related ayahs.
 - Only mention them if they are supported by the provided tafsir texts.
 - If a tafsir explicitly mentions a person/event/related ayah, you MUST include it and attribute it to the mufassir by name.
 - Presentation-style openings are strictly forbidden.
  Do NOT use phrases such as:
  "Here is", "Below is", "Comparative analysis", "The scholars agreed",
  or any similar introductory wording.
 - Start the text directly with analysis or with a named mufassir’s opinion
  (e.g., "Al-Tabari explains that…" or "Ibn Kathir mentions that…").
 - If a mufassir mentions a linguistic detail, historical context,
  narrated report, or interpretive nuance, include it briefly without expansion.
 - Every provided tafsir MUST be mentioned at least once by NAME, and If a mufassir does not add a unique detail, mention their view briefly without repetition.
 -If a mufassir explicitly mentions a related Qur’anic ayah, you MUST include it
 - MAKE IT REALLY EASY TO UNDERSTAND, SIMPLE LANGUAGE

Guidelines for the Answer:
 - Begin with a summary for the Ayah meaning
 - **Do NOT just list** the tafsirs one by one (e.g., don't do "- Tabari said... - Ibn Kathir said...").
 - When multiple mufassirs share the same meaning, group them in one sentence
  (e.g., "Al-Muyassar and Al-Saʿdi explain that…" or
  "Al-Tabari and Al-Baghawi clarify that…").
  - Use varied analytical verbs such as:
  explains, clarifies, emphasizes, highlights, points out, elaborates, affirms.
 - Avoid repeating the same verb throughout the text.
 - **Synthesize** the information. Group similar opinions together and highlight the differences.
 - Example flow: "Most scholars like **Al-Tabari** and **Ibn Kathir** agree that X means Y, whereas **Al-Qurtubi** adds a linguistic nuance that..."
 - **Use Bold** (markdown like **text**) for Scholar Names and Key Terms.
 - Keep the tone respectful, clear, and easy to read.
 - Avoid vague phrases like "قال بعض المفسرين". Always name the mufassir (**tabari**, **ibn_kathir**, **qurtubi**, etc.) when stating an opinion.

Provided Tafsirs:
{tafsir_blocks}

Output requirements:
- Return the answer in plain text with Markdown formatting (**bold**).
- No JSON.
- Target length: 15–30 lines (rich, but readable)

Language Instructions:
{lang_instruction}
""".strip()


# ----------------------------
# SQLite helpers (resume-safe)
# ----------------------------

def init_db(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS comparisons (
            surah INTEGER NOT NULL,
            ayah INTEGER NOT NULL,
            comparison_text TEXT NOT NULL,
            model TEXT,
            created_at TEXT,
            PRIMARY KEY (surah, ayah)
        )
        """
    )
    # Helpful index for lookups (PRIMARY KEY already covers, but harmless)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_comparisons_model ON comparisons(model)")
    conn.commit()

def already_done(conn: sqlite3.Connection, surah: int, ayah: int) -> bool:
    cur = conn.cursor()
    cur.execute("SELECT 1 FROM comparisons WHERE surah=? AND ayah=? LIMIT 1", (surah, ayah))
    return cur.fetchone() is not None

def save_comparison_conn(conn: sqlite3.Connection, surah: int, ayah: int, comparison_text: str, model: str) -> None:
    cur = conn.cursor()
    cur.execute(
        """
        INSERT OR REPLACE INTO comparisons (surah, ayah, comparison_text, model, created_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (surah, ayah, comparison_text, model, datetime.utcnow().isoformat() + "Z")
    )


# ----------------------------
# Vertex AI client + generation
# ----------------------------

def make_vertex_client() -> genai.Client:
    if not PROJECT_ID:
        print("WARNING: GOOGLE_CLOUD_PROJECT is not set. If you get auth/project errors, set it.")
    return genai.Client(
        vertexai=True,
        project=PROJECT_ID if PROJECT_ID else None,
        location=REGION,
        http_options=HttpOptions(timeout=600000)  # 10 minutes
    )

def extract_text_from_response(resp) -> str:
    """
    Robust extraction for Gemini 3 responses.
    Tries:
    - candidates[0].content.parts[*].text
    - dict-like parts with ['text']
    - resp.text fallback
    """
    # 1) candidates -> parts
    cands = getattr(resp, "candidates", None)
    if cands:
        try:
            content = getattr(cands[0], "content", None)
            parts = getattr(content, "parts", None) if content else None

            if parts:
                texts = []
                for p in parts:
                    # Part object with .text
                    t = getattr(p, "text", None)
                    if t and str(t).strip():
                        texts.append(str(t).strip())
                        continue

                    # dict-like part with 'text'
                    if isinstance(p, dict) and p.get("text") and str(p["text"]).strip():
                        texts.append(str(p["text"]).strip())
                        continue

                if texts:
                    return "\n".join(texts).strip()
        except Exception:
            pass

    # 2) resp.text fallback
    t = getattr(resp, "text", None)
    if t and str(t).strip():
        return str(t).strip()

    return ""

def generate_comparison_text(client: genai.Client, prompt: str) -> str:
    last_err = None

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = client.models.generate_content(
                model=MODEL_ID,
                contents=prompt,
                config={
                    "temperature": TEMPERATURE,
                    "max_output_tokens": MAX_OUTPUT_TOKENS,
                },
            )

            text = extract_text_from_response(resp)

            # ✅ Good text
            if text and "sdk_http_response=" not in text and "HttpResponse(" not in text:
                return text.strip()

            # If empty/junk, show why (blocked / finish reason)
            prompt_fb = getattr(resp, "prompt_feedback", None)
            finish_reason = None
            try:
                cands = getattr(resp, "candidates", None)
                if cands and len(cands) > 0:
                    finish_reason = getattr(cands[0], "finish_reason", None)
            except Exception:
                pass

            raise RuntimeError(
                f"No clean text returned. finish_reason={finish_reason}, prompt_feedback={prompt_fb}"
            )

        except Exception as e:
            last_err = e
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_SLEEP_SECONDS * attempt)
            else:
                raise RuntimeError(f"Generation failed after {MAX_RETRIES} attempts: {e}") from e

    raise RuntimeError(f"Generation failed: {last_err}")


# ----------------------------
# Main
# ----------------------------

def main():
    # Sanity checks
    # Keep your original behavior: require the sqlite file path to exist.
    # However, we also initialize the table so it's run-ready.
    if not os.path.exists(OUTPUT_SQLITE):
        raise FileNotFoundError(f"SQLite not found: {OUTPUT_SQLITE}")

    if not os.path.isdir(TAFSIR_DIR):
        raise FileNotFoundError(f"TAFSIR_DIR not found: {TAFSIR_DIR}")

    # Load all tafsir JSONs once
    tafsir_data = {}
    for name, filename in TAFSIR_FILES.items():
        path = os.path.join(TAFSIR_DIR, filename)
        if not os.path.exists(path):
            raise FileNotFoundError(f"Missing file: {path}")
        print(f"Loading {name} from {filename} ...")
        tafsir_data[name] = load_json(path)

    client = make_vertex_client()

    # Open DB once (faster) + make resume safe
    conn = sqlite3.connect(OUTPUT_SQLITE)
    try:
        # Better crash-safety for long runs
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")

        init_db(conn)

        total_done = 0
        total_skipped = 0
        total_written = 0

        # Commit in batches so progress is saved regularly
        COMMIT_EVERY = 10

        for surah, ayah in iter_all_surah_ayahs():
            # Resume behavior: skip if already exists
            if already_done(conn, surah, ayah):
                total_skipped += 1
                continue

            total_done += 1
            print(f"\n=== Generating comparison: Surah {surah}, Ayah {ayah} ===")

            # Gather tafsir texts for this ayah
            tafsir_texts = {}
            for name, data in tafsir_data.items():
                tafsir_texts[name] = get_tafsir_text(name, data, surah, ayah)

            prompt = build_prompt(surah, ayah, tafsir_texts)

            # Call AI
            comparison = generate_comparison_text(client, prompt)

            # Save (no commit yet; batched)
            save_comparison_conn(conn, surah, ayah, comparison, MODEL_ID)
            total_written += 1

            if total_written % COMMIT_EVERY == 0:
                conn.commit()
                print(f"Committed ✅ (latest surah={surah}, ayah={ayah})")

            print(f"Saved to SQLite ✅ (surah={surah}, ayah={ayah})")
            print(f"Progress: written={total_written}, skipped(existing)={total_skipped}")

        # Final commit
        conn.commit()
        print("\nAll done ✅")
        print(f"Final totals: written={total_written}, skipped(existing)={total_skipped}")

    except KeyboardInterrupt:
        # Ensure we never lose the last batch if you stop it manually.
        conn.commit()
        print("\nStopped by user (Ctrl+C). Progress saved ✅")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
