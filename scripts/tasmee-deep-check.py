"""tasmee-deep-check.py — Layer 2, on your own recitation, on the Mac.

    python scripts/tasmee-deep-check.py recording.wav --range 47:1-7
    python scripts/tasmee-deep-check.py recording.wav --page 507
    python scripts/tasmee-deep-check.py recording.wav --page 507 --chunk 8

This is the review screen, in the terminal — the product preview before a
line of plugin code is written. Record through the app (npm run dev →
tasmee → recite → `__tasmee._downloadRecording()` in the console), then
run this over the WAV and read what Layer 2 would have told you.

WHAT IT CHECKS, and the four rules it checks under — each grounded in a
measurement, not a preference (see TASMEE-PLAN / the M5 commits):

  1. ABSTAIN ON OMISSION. A unit the model did not emit is not evidence
     that it was said wrongly. Silence is not an accusation.
  2. CONFIDENT DISAGREEMENT ONLY. phonemes.probs carries the model's own
     confidence; a hesitant disagreement is the model being unsure, not
     the reciter being wrong.
  3. NEVER JUDGE A WORD EDGE. The final unit is altered by waqf and by
     idgham into the next word; the first is altered by idgham from the
     previous one. Measured on both our models: منهم's final م reads as
     ن by 2.84 nats and نزل's initial ن reads as absent by 1.44 — on
     words nobody got wrong.
  4. MADD LENGTH IS NOT IDENTITY. How long a vowel is held is a
     recitation choice; runs of a madd carrier collapse before comparing.

MEASURED at 8 s chunks (the shipping configuration): harakat 4/6 planted
mistakes at 0.40% false flags over 501 correct words; letters 6/7 at
3.79%. Whispering roughly doubles the LETTER false rate (it removes
voicing, the cue separating د/ت and ز/س) and leaves harakat untouched —
so --no-letters exists for whispered sessions.
"""
import argparse, difflib, json, os, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HARAKAT = set("َُِ")
MADD = set("اۥۦى")
# Acoustically plausible consonant confusions — the same map Layer 1 uses.
# A claimed substitution outside this set is treated as alignment drift.
CONFUSABLE = {
    "ر": "لن", "ل": "رنم", "د": "لذتط", "ن": "رلم", "ه": "كحء",
    "ك": "هقغ", "ت": "يثدط", "ي": "تبن", "م": "نبو", "ب": "تنم",
    "س": "شصز", "ح": "خهع", "ع": "غاح", "ق": "كفخ", "ط": "تظد",
    "ص": "سضظ", "ث": "تسذ", "ذ": "زظثد", "ز": "سذص", "ظ": "ذضط",
    "ض": "دظص", "خ": "غحق", "غ": "خعق", "ف": "ثق", "ج": "شيز",
    "ش": "سج", "و": "مب", "ا": "ءه",
}
HARAKA_NAME = {"َ": "فتحة", "ِ": "كسرة", "ُ": "ضمة"}
# The 28 letters plus the hamza seats. Deliberately excludes every QPS
# tajweed symbol — see is_con below.
ARABIC_LETTERS = set("ابتثجحخدذرزسشصضطظعغفقكلمنهوي") | set("ءأإآؤئة")
# SEAT EQUIVALENCE, carried over from Layer 1. The matcher there folds
# hamza seats, ta-marbuta and alef-maqsura together because Quran ASR and
# the mushaf's own spellings disagree on exactly those. Layer 2 was judging
# them as distinct letters, which is how a clean recitation of
# ٱلسَّمَـٰوَٰتِ came back as "expected ا, heard ء" — two spellings of one
# sound reported to the reciter as a mistake. The bare ء belongs in the alef
# class for the same reason: Layer 1 DROPS lone hamza outright, so a
# hamza/alef difference is already invisible to the matcher, and Layer 2
# reporting it would contradict the surface the reciter actually sees.
SEAT = {}
for _cls in ("اأإآٱء", "وؤ", "يئى", "ه\u0629"):
    for _c in _cls:
        SEAT[_c] = _cls[0]
fold = lambda ch: SEAT.get(ch, ch)

ap = argparse.ArgumentParser(description="Layer 2 deep check over one recording")
ap.add_argument("wav")
ap.add_argument("--range", dest="rng", help="e.g. 47:1-7")
ap.add_argument("--page", type=int, help="QCF4 page number, e.g. 507")
ap.add_argument("--chunk", type=float, default=8.0, help="seconds per window (0 = whole clip)")
ap.add_argument("--conf", type=float, default=0.90, help="confidence bar for a disagreement")
ap.add_argument("--no-letters", action="store_true", help="harakat only (use for whispered recitation)")
ap.add_argument("--no-harakat", action="store_true")
ap.add_argument("--json", help="also write findings here")
ap.add_argument("--dump-fixture", metavar="FILE",
                help="write the exact inputs AND findings, so the JS port can be held to this "
                     "output rather than to a description of it")
ap.add_argument("--clip", metavar="DIR", help="write a WAV of each flagged word so you can HEAR what the model heard")
ap.add_argument("--truth", metavar="LIST",
                help="comma-separated vk:pos you deliberately got wrong, e.g. 47:1:8,47:4:5 — "
                     "scores catches against extras instead of leaving it to the eye")
a = ap.parse_args()
if not a.rng and not a.page:
    sys.exit("give --range 47:1-7 or --page 507")

import numpy as np, torch
from librosa.core import load
from quran_transcript import Aya, quran_phonetizer, MoshafAttributes
from quran_muaalem import Muaalem

DATASET = json.load(open(f"{ROOT}/public/tasmee-words.json"))


def range_from_page(page):
    p = json.load(open(f"{ROOT}/public/data/qcf4/pages/{page:03d}.json"))
    vks = [w["verse_key"] for line in p.get("lines", []) for w in line.get("words", []) if w.get("verse_key")]
    if not vks:
        sys.exit(f"page {page}: no verses found")
    s0, a0 = map(int, vks[0].split(":"))
    s1, a1 = map(int, vks[-1].split(":"))
    if s0 != s1:
        print(f"  note: page {page} spans surah {s0}–{s1}; checking the {s0} part only", file=sys.stderr)
        a1 = max(int(v.split(":")[1]) for v in vks if v.startswith(f"{s0}:"))
    return s0, a0, a1


if a.rng:
    surah, rest = a.rng.split(":")
    surah = int(surah)
    a0, a1 = (int(x) for x in (rest.split("-") if "-" in rest else (rest, rest)))
else:
    surah, a0, a1 = range_from_page(a.page)

nwords = sum(len(DATASET["verses"][f"{surah}:{k}"]) for k in range(a0, a1 + 1))
moshaf = MoshafAttributes(rewaya="hafs", madd_mottasel_len=4, madd_monfasel_len=4,
                          madd_mottasel_waqf=4, madd_aared_len=4)
# USE THE SHIPPED REFERENCE, not a live phonetization of the whole range.
# They are NOT the same: phonetizing a multi-ayah span continuously applies
# tajweed ACROSS ayah boundaries (وَشِقَاقٍ + كَمْ merges with ikhfa, and the
# ayah-final vowel survives), while phonetizing per ayah treats each end as a
# WAQF (final vowel dropped, madd 'aarid lengthened). Both are legitimate —
# it depends whether the reciter stops at each ayah — but the app can only
# ship one, and the checker must be validated on whatever the app ships.
# Per-ayah is the right default: stopping at ayah ends is normal practice,
# and it keeps groups aligned to ayat so word attribution cannot drift
# across a boundary.
PH = json.load(open(f"{ROOT}/public/tasmee-phonemes.json"))["verses"]
groups, wpg = [], []
for _a in range(a0, a1 + 1):
    _row = PH.get(f"{surah}:{_a}")
    if not _row:
        sys.exit(f"no phoneme reference for {surah}:{_a} — rebuild with scripts/build-tasmee-phonemes.py")
    _g = _row["p"].split(" ")
    groups += _g
    wpg += _row["w"]
seg = Aya(surah, a0).get_by_imlaey_words(0, nwords)
nosp = quran_phonetizer(seg.uthmani, moshaf, remove_spaces=True)   # model input only
uth = []
for _a in range(a0, a1 + 1):
    uth += Aya(surah, _a).get().uthmani.split()

# The group→word alignment and its derived tables are needed by the
# FINDINGS loop (word-seam guard), not just by the report, so they are
# built here — right after the reference — rather than further down.

def map_groups_to_words(groups, words):
    wp = []
    for w in words:
        try:
            wp.append(str(quran_phonetizer(w, moshaf, remove_spaces=True).phonemes))
        except Exception:
            wp.append("")
    owners, wi = [], 0
    for g in groups:
        if wi >= len(wp):
            owners.append([])
            continue
        take, acc = [wi], wp[wi]
        best = difflib.SequenceMatcher(None, acc, g).ratio()
        k = wi + 1
        while k < len(wp):
            cand = acc + wp[k]
            r = difflib.SequenceMatcher(None, cand, g).ratio()
            if r <= best + 1e-9:
                break
            best, acc = r, cand
            take.append(k)
            k += 1
        owners.append(take)
        wi = take[-1] + 1
    return owners


# The group→word mapping ships WITH the reference (it cannot be recovered
# from the phonemes alone), so it is read rather than recomputed — one
# source of truth, and no chance of the app and the CLI disagreeing.
G2W, _wi = [], 0
for _n in wpg:
    G2W.append(list(range(_wi, _wi + _n)))
    _wi += _n

# Ordinal → verse-key:position. كَفَرُوا۟ occurs five times on page 507; a
# finding that names only the word leaves the reciter unable to tell WHICH
# one, which makes it unverifiable — and an unverifiable finding is one they
# have to take on faith.
_ORD2LOC = {}
_o = 0
for _a in range(a0, a1 + 1):
    for _p in range(1, len(DATASET["verses"][f"{surah}:{_a}"]) + 1):
        _ORD2LOC[_o] = f"{surah}:{_a}:{_p}"
        _o += 1


def loc_of(gi):
    ws = G2W[gi] if gi < len(G2W) else []
    return _ORD2LOC.get(ws[0], "?") if ws else "?"

# TAJWEED BOUNDARIES INSIDE A MERGED GROUP. The phonetizer merges words
# across idgham/ikhfa — بَل لَّمَّا and لَشَىْءٌۭ يُرَادُ each become ONE
# group — which turns a word boundary into an interior position and
# silently disables the word-edge exclusion at exactly the place it exists
# to protect. Mohammed spotted this from the output: the ي of يُرَادُ was
# reported as ن, and it IS nasal there — tanwin + ya is idgham with
# ghunna, so the model heard correctly and the checker called it a
# mistake. Positions within `mergeGuard` of an internal word seam are not
# judged, on either side.
MERGE_GUARD = 2
_seam = set()
for _gi, _ws in enumerate(G2W):
    if len(_ws) < 2:
        continue
    _pos = 0
    for _w in _ws[:-1]:
        try:
            _pos += len(str(quran_phonetizer(uth[_w], moshaf, remove_spaces=True).phonemes))
        except Exception:
            _pos = None
            break
        _seam.add((_gi, _pos))
    del _pos



SR = 16000
wave, _ = load(a.wav, sr=SR, mono=True)
dur = len(wave) / SR
dev = "mps" if torch.backends.mps.is_available() else "cpu"
print(f"\n  {os.path.basename(a.wav)} · {dur:.0f}s · {surah}:{a0}-{a1} · {len(groups)} words · {dev}", flush=True)

m = Muaalem(device=dev)
t0 = time.time()
times = []          # seconds, one per emitted phoneme (approximate — see above)
if a.chunk <= 0:
    r = m([wave], [nosp], sampling_rate=SR)[0]
    heard, probs = r.phonemes.text, r.phonemes.probs.tolist()
    n = max(len(heard), 1)
    times = [k / n * dur for k in range(len(heard))]
else:
    step = int(SR * a.chunk)
    heard, probs = "", []
    for st in range(0, len(wave), step):
        s2 = wave[st:st + step]
        if len(s2) < SR * 0.4:
            continue
        rr = m([s2], [nosp], sampling_rate=SR)[0]
        t_ch, d_ch = st / SR, len(s2) / SR
        n = max(len(rr.phonemes.text), 1)
        times += [t_ch + k / n * d_ch for k in range(len(rr.phonemes.text))]
        heard += rr.phonemes.text
        probs += rr.phonemes.probs.tolist()
el = time.time() - t0
print(f"  listened in {el:.1f}s (RTF {el/dur:.2f})\n", flush=True)

# reference stream + owner word, then rule 4 (collapse madd runs) on both sides
ref, owner = [], []
for gi, g in enumerate(groups):
    for ch in g:
        ref.append(ch); owner.append(gi)


def collapse(seq, tags):
    o, ot = [], []
    for ch, tg in zip(seq, tags):
        if o and ch == o[-1] and ch in MADD:
            continue
        o.append(ch); ot.append(tg)
    return o, ot


refC, ownerC = collapse(ref, owner)
hrdC, probC = collapse(list(heard), probs)
_, timeC = collapse(list(heard), times)

is_har = lambda ch: ch in HARAKAT
# ONLY REAL ARABIC LETTERS ARE JUDGED AS LETTERS. Quran Phonetic Script also
# carries tajweed SYMBOLS — ں for the ikhfa nun, ۾, ڇ, and the madd carriers
# ۦ ۥ — which encode how a sound is realised, not which letter it is. Scoring
# them as letters produced "الصواب ۾، وسمعتُ م" on مَنًّۢا بَعْدُ: a real
# tajweed distinction reported to the reciter as a spelling mistake. A
# whitelist, not a blacklist, so a symbol we have not seen yet cannot leak in.
is_con = lambda ch: ch in ARABIC_LETTERS

# rule 3: locate each word's first and last unit of each class
edges = {}
for i, ch in enumerate(refC):
    for kind, test in (("har", is_har), ("con", is_con)):
        if test(ch):
            e = edges.setdefault((ownerC[i], kind), [i, i])
            e[1] = i

findings = []
sm = difflib.SequenceMatcher(None, refC, hrdC, autojunk=False)
for tag, i1, i2, j1, j2 in sm.get_opcodes():
    if tag == "equal":
        continue
    for i in range(i1, i2):
        kind = "har" if is_har(refC[i]) else ("con" if is_con(refC[i]) else None)
        if kind is None:
            continue
        if kind == "har" and a.no_harakat:
            continue
        if kind == "con" and a.no_letters:
            continue
        e = edges.get((ownerC[i], kind))
        if not e:
            continue
        if i == e[1]:
            continue                                   # rule 3: word-final
        if kind == "con" and i == e[0]:
            continue                                   # rule 3: word-initial
        # rule 3 extended: a seam the phonetizer merged is still a word edge
        _gstart = next((k for k in range(i, -1, -1) if ownerC[k] != ownerC[i]), -1) + 1
        _off = i - _gstart
        if any(abs(_off - sp) <= MERGE_GUARD for (g, sp) in _seam if g == ownerC[i]):
            continue
        test = is_har if kind == "har" else is_con
        said = [(ch, p) for ch, p in zip(hrdC[j1:j2], probC[j1:j2]) if test(ch)]
        if not said:
            continue                                   # rule 1: abstain
        if any(fold(ch) == fold(refC[i]) for ch, _ in said):
            continue                                   # seat-equivalent ⇒ same letter
        conf = max(p for _, p in said)
        got_ = max(said, key=lambda x: x[1])[0]
        # ACOUSTICALLY IMPLAUSIBLE SUBSTITUTIONS ARE ALIGNMENT FAILURES, NOT
        # MISTAKES. No reciter turns ذ into ل and no acoustic model confuses
        # them; when the diff claims that, it has drifted and is blaming the
        # wrong position. Reporting it spends the reciter's trust on noise.
        if kind == "con" and fold(got_) not in CONFUSABLE.get(fold(refC[i]), ""):
            continue
        if conf < a.conf:
            continue                                   # rule 2
        got = max(said, key=lambda x: x[1])[0]
        span = timeC[j1:j2] or [0.0]
        findings.append({
            "word": ownerC[i], "kind": kind, "conf": round(conf, 3),
            "expected": refC[i], "heard": got,
            "atS": round(sum(span) / len(span), 2),
        })

# collapse to one line per word per kind (the loudest finding wins)
best = {}
for f in findings:
    k = (f["word"], f["kind"])
    if k not in best or f["conf"] > best[k]["conf"]:
        best[k] = f

# ---- report ----
by_word = {}
for (w, kind), f in best.items():
    by_word.setdefault(w, []).append(f)

# ---- GROUP → WORD, and this has to be right ----
# The phonetizer MERGES words across idgham/ikhfa (عن+سبيل → عَںںںسَبِۦۦلِ),
# so 47:1-7 is 87 phoneme groups covering 97 uthmani words. Indexing the word
# list by group number is therefore not "approximate at the boundaries" — it
# is systematically offset, and it labelled the founder's أَضَلَّ as
# ٱلصَّـٰلِحَـٰتِ. A finding that names the wrong word is worse than no
# finding, so the mapping is built by walking both sequences: phonetize each
# word once, then let each group consume words while doing so still improves
# its similarity to that group.
def show(gi):
    ws = G2W[gi] if gi < len(G2W) else []
    return " ".join(uth[w] for w in ws) if ws else f"[group {gi}]"

if not by_word:
    print("  ✓ لا ملاحظات — nothing flagged.\n")
else:
    print(f"  {len(by_word)} word(s) with a finding:\n")
    for gi in sorted(by_word):
        print(f"  ● {show(gi)}   [{loc_of(gi)}]")
        for f in sorted(by_word[gi], key=lambda x: -x["conf"]):
            if f["kind"] == "har":
                exp = HARAKA_NAME.get(f["expected"], f["expected"])
                got = HARAKA_NAME.get(f["heard"], f["heard"])
                print(f"      الحركة — الصواب {exp}، وسمعتُ {got}   (ثقة {f['conf']:.0%})")
            else:
                print(f"      الحرف  — الصواب {f['expected']}، وسمعتُ {f['heard']}   (ثقة {f['conf']:.0%})")
        print()

if a.truth:
    """Score against what the reciter MEANT to get wrong.

    Both halves matter and the second matters more: a checker that finds
    every planted mistake while also flagging correct recitation is not
    usable on someone's Quran. Extras are therefore reported as a rate over
    the words that were NOT planted, not as a raw count."""
    want = [t.strip() for t in a.truth.split(",") if t.strip()]
    # vk:pos → word ordinal → the phoneme group that covers it
    w2g = {}
    for gi, ws in enumerate(G2W):
        for w in ws:
            w2g.setdefault(w, gi)
    planted_groups, rows = set(), []
    for t in want:
        try:
            _s, _a, _p = (int(x) for x in t.split(":"))
            ordinal = sum(len(DATASET["verses"][f"{_s}:{k}"]) for k in range(a0, _a)) + _p - 1
        except Exception:
            rows.append((t, None, "unparseable")); continue
        gi = w2g.get(ordinal)
        if gi is None:
            rows.append((t, None, "outside this range")); continue
        planted_groups.add(gi)
        rows.append((t, gi, "CAUGHT" if gi in by_word else "missed"))
    hits = sum(1 for _, _, r in rows if r == "CAUGHT")
    extra = [gi for gi in by_word if gi not in planted_groups]
    clean_n = len(groups) - len(planted_groups)
    print("  ── scored against what you planted ──")
    for t, gi, r in rows:
        mark = "✓" if r == "CAUGHT" else ("·" if r == "missed" else "?")
        print(f"    {mark} {t:<10} {show(gi) if gi is not None else '':<22} {r}")
    print(f"\n    caught {hits}/{len(rows)}"
          f"   ·   extra flags {len(extra)}/{clean_n} unplanted words"
          f" ({len(extra)/max(clean_n,1)*100:.1f}%)")
    if extra:
        print(f"    extras: {', '.join(f'{show(gi)} [{loc_of(gi)}]' for gi in extra[:8])}")
    print()

n_har = sum(1 for f in best.values() if f["kind"] == "har")
n_con = sum(1 for f in best.values() if f["kind"] == "con")
print(f"  {len(groups)} words checked · {n_har} harakat · {n_con} letters · conf ≥ {a.conf:.0%}")
print("  (a word edge is never judged — waqf and idgham legitimately change it;")
print("   madd length is never judged — how long you hold a vowel is your choice)\n")

if a.dump_fixture:
    """Parity fixture. The JS rules must reproduce THIS, not an English
    summary of it — every guard here was settled by measurement, and a port
    that merely sounds equivalent will differ on exactly the cases that
    mattered enough to add a guard for."""
    json.dump({
        "range": f"{surah}:{a0}-{a1}",
        "groups": groups,
        "wordsPerGroup": [len(G2W[i]) if i < len(G2W) else 1 for i in range(len(groups))],
        "heardText": heard,
        "probs": [round(float(x), 6) for x in probs],
        "conf": a.conf,
        "findings": sorted(
            [{"group": f["word"], "kind": f["kind"], "expected": f["expected"],
              "heard": f["heard"], "conf": f["conf"]} for f in best.values()],
            key=lambda r: (r["group"], r["kind"])),
    }, open(a.dump_fixture, "w"), ensure_ascii=False)
    print(f"  wrote fixture {a.dump_fixture} ({len(best)} findings)\n")

if a.clip:
    import soundfile as sf
    os.makedirs(a.clip, exist_ok=True)
    PAD = 1.2      # generous: the position is derived, not a real alignment
    print("  clips (listen and judge for yourself):")
    for (gi, kind), f in sorted(best.items(), key=lambda kv: kv[1]["atS"]):
        s0 = max(0, int((f["atS"] - PAD) * SR))
        s1 = min(len(wave), int((f["atS"] + PAD) * SR))
        safe = "".join(c for c in show(gi) if c.isalnum() or c in "ـًٌٍَُِّْٰ")[:24] or f"g{gi}"
        out = os.path.join(a.clip, f"{f['atS']:07.2f}s-{kind}-{safe}.wav")
        sf.write(out, wave[s0:s1], SR)
        print(f"    {os.path.basename(out)}   [{loc_of(gi)}]  (~{f['atS']:.1f}s ± {PAD}s)")
    print()

if a.json:
    json.dump({"wav": a.wav, "range": f"{surah}:{a0}-{a1}", "rtf": el / dur,
               "findings": [{**f, "word": show(f["word"])} for f in best.values()]},
              open(a.json, "w"), ensure_ascii=False, indent=1)
    print(f"  wrote {a.json}\n")
