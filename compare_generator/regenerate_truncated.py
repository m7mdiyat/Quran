#!/usr/bin/env python3
"""
Regenerate the truncated مختصر التفاسير entries — SAFELY.

Matches the ORIGINAL generator exactly for auth/model/prompt (so the regenerated
text reads consistently with the other ~6,000 entries):
  - new google-genai SDK, Vertex AI + ADC (no API key)
  - project handy-digit-482820-m6, location "global"
  - model "gemini-3-flash-preview"
  - byte-identical build_prompt() + deep_search() (copied from generate_comparisons.py)

What it FIXES vs the original (the whole point of this job):
  - The original saved whatever came back with NO completeness check, and used
    max_output_tokens=3300. gemini-3-flash-preview is a *thinking* model, so the
    reasoning tokens ate into that 3300 budget → answers cut mid-word (finish
    reason MAX_TOKENS) and stored anyway. Here we (a) give a generous, escalating
    token budget, and (b) VALIDATE every output and RETRY until it's complete;
    anything that still fails is written to needs_review.json, never to the DB.

SAFETY:
  - Reads from SOURCE_DB read-only; writes ONLY to WORK_DB (a copy).
  - SOURCE_DB and the live GCS/backend are never touched by this script.

Usage:
  python3 regenerate_truncated.py --sample            # 3:118, 3:7, 100:2 (checkpoint)
  python3 regenerate_truncated.py --only 3:118,3:7    # specific ayahs
  python3 regenerate_truncated.py --all               # all detected truncated entries
  (add --write to persist into WORK_DB; --sample prints by default)
"""
import os
import re
import sys
import json
import time
import shutil
import sqlite3
import argparse
from datetime import datetime
from typing import Any, Dict, Optional, List, Tuple

from google import genai
from google.genai.types import HttpOptions

# ---------------------------- CONFIG (matches original) ----------------------------
TAFSIR_DIR = "../public"
SOURCE_DB  = "./comparisons.sqlite"          # MASTER — opened read-only, never written
WORK_DB    = "./comparisons.fixed.sqlite"    # the COPY we write to
NEEDS_REVIEW = "./needs_review.json"

MODEL_ID   = "gemini-3-flash-preview"
PROJECT_ID = "handy-digit-482820-m6"
REGION     = "global"
TEMPERATURE = 0.2

# FIX: escalating output budget (thinking model — 3300 was too small). Each retry
# steps up so a MAX_TOKENS cut gets more room rather than being saved truncated.
TOKEN_LADDER = [8000, 12000, 16000, 20000, 24000]
RETRY_SLEEP_SECONDS = 2

TAFSIR_FILES = {
    "baghawi": "tafseer_baghawi.json",
    "ibn_ashur": "tafseer_ibn_ashur.json",
    "ibn_kathir": "tafseer_ibn_kathir.json",
    "muyassar": "tafseer_muyassar.json",
    "qurtubi": "tafseer_qurtubi.json",
    "saadi": "tafseer_saadi.json",
    "tabari": "tafseer_tabari.json",
}

# ---------------------------- tafsir extraction (copied verbatim) ----------------------------
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
    s_key, a_key = str(surah), str(ayah)
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

def get_tafsir_text(name: str, tafsir_json: Any, surah: int, ayah: int) -> str:
    text = deep_search(tafsir_json, surah, ayah)
    if not text:
        return f"(Missing tafsir text for {name} surah={surah} ayah={ayah})"
    return text

# ---------------------------- prompt (BYTE-IDENTICAL to generate_comparisons.py) ----------------------------
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

# ---------------------------- completeness validation ----------------------------
TERMINAL_RE = re.compile(r'[.!؟…]["»”\)\]\}]*\s*$')

def validate(text: str) -> Tuple[bool, List[str]]:
    """Return (ok, problems). ok == True only when the text looks complete."""
    problems = []
    t = (text or "").strip()
    if not t:
        return False, ["empty"]
    if t.count("**") % 2 != 0:
        problems.append("unclosed-bold")
    if not TERMINAL_RE.search(t):
        problems.append("no-terminal-punctuation")
    if len(t) < 400:
        problems.append(f"too-short({len(t)})")
    # soft warnings (do not fail the gate)
    warns = []
    if len(t) < 800:
        warns.append(f"short({len(t)})")
    named = sum(1 for k in TAFSIR_FILES if k in t.lower())
    if named < 7:
        warns.append(f"named-{named}/7")
    return (len(problems) == 0), problems + [f"warn:{w}" for w in warns]

# ---------------------------- generation with retry ----------------------------
def extract_text(resp) -> str:
    try:
        if resp.text and str(resp.text).strip():
            return str(resp.text).strip()
    except Exception:
        pass
    out = []
    try:
        for p in resp.candidates[0].content.parts:
            t = getattr(p, "text", None)
            if t and not getattr(p, "thought", False):
                out.append(str(t))
    except Exception:
        pass
    return "\n".join(out).strip()

def finish_reason(resp) -> str:
    try:
        return str(resp.candidates[0].finish_reason)
    except Exception:
        return "?"

def usage(resp):
    u = getattr(resp, "usage_metadata", None)
    if not u:
        return {}
    return {
        "prompt": getattr(u, "prompt_token_count", None),
        "answer": getattr(u, "candidates_token_count", None),
        "thoughts": getattr(u, "thoughts_token_count", None),
        "total": getattr(u, "total_token_count", None),
    }

def generate_validated(client, surah, ayah, prompt) -> Dict[str, Any]:
    last = {"text": "", "finish": "?", "problems": ["never-ran"], "usage": {}, "tokens": None}
    for attempt, max_tokens in enumerate(TOKEN_LADDER, start=1):
        try:
            resp = client.models.generate_content(
                model=MODEL_ID,
                contents=prompt,
                config={"temperature": TEMPERATURE, "max_output_tokens": max_tokens},
            )
        except Exception as e:
            last = {"text": "", "finish": "EXC", "problems": [f"exc:{type(e).__name__}:{str(e)[:120]}"], "usage": {}, "tokens": max_tokens}
            time.sleep(RETRY_SLEEP_SECONDS * attempt)
            continue
        text = extract_text(resp)
        fr = finish_reason(resp)
        ok, problems = validate(text)
        last = {"text": text, "finish": fr, "problems": problems, "usage": usage(resp), "tokens": max_tokens}
        hard_ok = ok and fr.endswith("STOP")
        print(f"    attempt {attempt} (max_tokens={max_tokens}): finish={fr} len={len(text)} "
              f"usage={last['usage']} -> {'OK' if hard_ok else 'REJECT '+str(problems)}")
        if hard_ok:
            last["accepted"] = True
            last["attempts"] = attempt
            return last
        time.sleep(RETRY_SLEEP_SECONDS * attempt)
    last["accepted"] = False
    last["attempts"] = len(TOKEN_LADDER)
    return last

# ---------------------------- detection (same signatures as the scan) ----------------------------
def is_truncated(text: str) -> Optional[str]:
    t = (text or "").strip()
    if not t:
        return "empty"
    if t.count("**") % 2 != 0:
        return "unclosed-bold"
    if re.search(r'\*\*\s*$', t):
        return "dangling-book"
    if re.search(r'[}\]]\s*$', t):
        return None
    if TERMINAL_RE.search(t):
        return None
    last = t[-1]
    return "ends-comma" if last in "،," else "ends-midword"

def list_truncated(db) -> List[Tuple[int, int]]:
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    rows = con.execute("SELECT surah, ayah, comparison_text FROM comparisons").fetchall()
    con.close()
    out = [(s, a) for (s, a, txt) in rows if is_truncated(txt)]
    out.sort()
    return out

def read_one(db, s, a) -> Optional[str]:
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    row = con.execute("SELECT comparison_text FROM comparisons WHERE surah=? AND ayah=?", (s, a)).fetchone()
    con.close()
    return row[0] if row else None

# ---------------------------- main ----------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", action="store_true", help="regenerate 3:118, 3:7, 100:2")
    ap.add_argument("--only", type=str, help="comma list of S:A")
    ap.add_argument("--all", action="store_true", help="all detected truncated entries")
    ap.add_argument("--write", action="store_true", help="persist results into WORK_DB (the copy)")
    args = ap.parse_args()

    if not os.path.exists(SOURCE_DB):
        sys.exit(f"SOURCE_DB not found: {SOURCE_DB}")

    if args.sample:
        targets = [(3, 118), (3, 7), (100, 2)]
        write = args.write  # samples: print-only unless --write
    elif args.only:
        targets = [tuple(int(x) for x in p.split(":")) for p in args.only.split(",")]
        write = True
    elif args.all:
        targets = list_truncated(SOURCE_DB)
        write = True
        print(f"Detected {len(targets)} truncated entries.")
    else:
        sys.exit("pick one of --sample / --only / --all")

    # Load tafsir books once
    tafsir_data = {n: load_json(os.path.join(TAFSIR_DIR, f)) for n, f in TAFSIR_FILES.items()}
    client = genai.Client(vertexai=True, project=PROJECT_ID, location=REGION,
                          http_options=HttpOptions(timeout=600000))

    work_con = None
    if write:
        if not os.path.exists(WORK_DB):
            shutil.copy(SOURCE_DB, WORK_DB)
            print(f"Copied {SOURCE_DB} -> {WORK_DB} (working copy)")
        work_con = sqlite3.connect(WORK_DB)

    needs_review = []
    stats = {"first_try": 0, "after_retry": 0, "failed": 0, "skipped": 0}
    n = len(targets)
    for i, (s, a) in enumerate(targets, start=1):
        old = read_one(SOURCE_DB, s, a) or ""
        # Resume: skip if the copy already holds a complete, regenerated version.
        if write and work_con:
            cur = read_one(WORK_DB, s, a)
            if cur and cur != old and is_truncated(cur) is None:
                stats["skipped"] += 1
                print(f"[{i}/{n}] {s}:{a} already fixed in copy — skip")
                continue
        print(f"\n[{i}/{n}] === {s}:{a}  (old: {len(old)} chars, flag={is_truncated(old)}) ===")
        tafsir_texts = {nm: get_tafsir_text(nm, d, s, a) for nm, d in tafsir_data.items()}
        prompt = build_prompt(s, a, tafsir_texts)
        res = generate_validated(client, s, a, prompt)
        if res.get("accepted"):
            stats["first_try" if res.get("attempts", 1) == 1 else "after_retry"] += 1
            print(f"  ✅ accepted in {res.get('attempts')} attempt(s): {len(res['text'])} chars (was {len(old)})")
            if write and work_con:
                work_con.execute(
                    "INSERT OR REPLACE INTO comparisons (surah, ayah, comparison_text, model, created_at) VALUES (?,?,?,?,?)",
                    (s, a, res["text"], MODEL_ID, datetime.utcnow().isoformat() + "Z"))
                work_con.commit()
        else:
            stats["failed"] += 1
            print(f"  ❌ still failing after {len(TOKEN_LADDER)} attempts: {res['problems']}")
            needs_review.append({"surah": s, "ayah": a, "problems": res["problems"],
                                 "finish": res["finish"], "last_len": len(res.get("text") or "")})

    if work_con:
        work_con.close()
    json.dump(needs_review, open(NEEDS_REVIEW, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    summary = {"targets": n, **stats, "needs_review": len(needs_review)}
    json.dump(summary, open("./run_summary.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print("\n================ SUMMARY ================")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if needs_review:
        print(f"⚠️  {len(needs_review)} need manual review -> {NEEDS_REVIEW}")
    print("Done.")

if __name__ == "__main__":
    main()
