#!/usr/bin/env python3
"""
Export the fixed مختصر التفاسير entries from the copy sqlite into comparisons.json,
byte-matching the LIVE file's structure (same key order + serialization) and
changing ONLY the truncated keys.

Strategy: load the live comparisons.json (preserves its exact key order, incl.
77:33 / 2:284 appended at the end), take the set of keys that are truncated in
it, and overwrite ONLY those with the regenerated text from comparisons.fixed
.sqlite. Everything else stays byte-identical. A self-check re-serialises the
untouched live dict and asserts it reproduces the live file byte-for-byte, which
proves our serializer settings match live exactly.

Reads only (live JSON ref + both sqlite DBs); writes one local file. No live touch.
"""
import json, sqlite3, re, sys

LIVE_JSON = "/tmp/live_comparisons.json"   # current live, downloaded read-only
COPY_DB   = "comparisons.fixed.sqlite"     # the approved regenerated copy
MASTER_DB = "comparisons.sqlite"           # local master (== live, cross-check)
OUT       = "comparisons.fixed.json"

TERM = re.compile(r'[.!؟…]["»”\)\]\}]*\s*$')
def trunc(t):
    t = (t or "").strip()
    if not t: return True
    if t.count("**") % 2: return True
    if re.search(r'\*\*\s*$', t): return True
    if re.search(r'[}\]]\s*$', t): return False
    return not bool(TERM.search(t))

def sqlite_dict(db):
    c = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
    d = {f"{s}:{a}": t for s, a, t in c.execute("SELECT surah,ayah,comparison_text FROM comparisons")}
    c.close(); return d

raw_live = open(LIVE_JSON, "rb").read()
live = json.loads(raw_live.decode("utf-8"))

# Proof our serializer == live's exact format (only then is "byte-match" meaningful)
redump = json.dumps(live, ensure_ascii=False).encode("utf-8")
serializer_ok = (redump == raw_live)
print(f"[fmt] serializer byte-reproduces live: {serializer_ok}")
if not serializer_ok:
    print(f"      live={len(raw_live)}B redump={len(redump)}B  live_ends_nl={raw_live[-1:]==chr(10).encode()}")
    for i in range(min(len(raw_live), len(redump))):
        if raw_live[i] != redump[i]:
            print(f"      first diff @byte {i}: live={raw_live[i-8:i+8]!r} redump={redump[i-8:i+8]!r}"); break
    sys.exit("ABORT: serializer does not match live format — fix before exporting.")

fixed  = sqlite_dict(COPY_DB)
master = sqlite_dict(MASTER_DB)
print(f"[keys] live={len(live)} copy={len(fixed)} master={len(master)} | "
      f"live==copy keyset:{set(live)==set(fixed)} | live==master keyset:{set(live)==set(master)}")
print(f"[xcheck] live JSON values == master sqlite values (live is master serialized): "
      f"{set(live)==set(master) and all(live[k]==master.get(k) for k in live)}")

target = [k for k in live if trunc(live[k])]
missing = [k for k in target if k not in fixed or trunc(fixed[k])]
print(f"[target] truncated keys in live: {len(target)} | still-bad in copy: {len(missing)} {missing[:5]}")
if missing:
    sys.exit("ABORT: some target keys have no complete replacement in the copy.")

# Patch only the target keys; preserve live order + every other byte.
new = dict(live)
for k in target:
    new[k] = fixed[k]
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(new, f, ensure_ascii=False)

# Validate output
raw_out = open(OUT, "rb").read()
out = json.loads(raw_out.decode("utf-8"))
diff = [k for k in live if live[k] != out.get(k)]
nontarget_ok = all(out[k] == live[k] for k in live if k not in set(target))
remaining_trunc = [k for k in out if trunc(out[k])]
print("\n=== VALIDATION ===")
print(f"entries:                  {len(out)}  (expect 6236)")
print(f"keys identical to live (set+ORDER): {list(out.keys()) == list(live.keys())}")
print(f"values changed vs live:   {len(diff)}  (expect 304)")
print(f"changed set == target set:{set(diff) == set(target)}")
print(f"non-target bytes untouched:{nontarget_ok}")
print(f"truncated remaining:      {len(remaining_trunc)}  {remaining_trunc[:5]}")
print(f"output size: {len(raw_out)}B   live size: {len(raw_live)}B   (delta {len(raw_out)-len(raw_live):+d}B from the 304 longer texts)")
print(f"md5(out)={__import__('hashlib').md5(raw_out).hexdigest()}")
