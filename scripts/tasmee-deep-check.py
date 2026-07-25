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
HARAKA_NAME = {"َ": "فتحة", "ِ": "كسرة", "ُ": "ضمة"}
# The 28 letters plus the hamza seats. Deliberately excludes every QPS
# tajweed symbol — see is_con below.
ARABIC_LETTERS = set("ابتثجحخدذرزسشصضطظعغفقكلمنهوي") | set("ءأإآؤئة")

ap = argparse.ArgumentParser(description="Layer 2 deep check over one recording")
ap.add_argument("wav")
ap.add_argument("--range", dest="rng", help="e.g. 47:1-7")
ap.add_argument("--page", type=int, help="QCF4 page number, e.g. 507")
ap.add_argument("--chunk", type=float, default=8.0, help="seconds per window (0 = whole clip)")
ap.add_argument("--conf", type=float, default=0.90, help="confidence bar for a disagreement")
ap.add_argument("--no-letters", action="store_true", help="harakat only (use for whispered recitation)")
ap.add_argument("--no-harakat", action="store_true")
ap.add_argument("--json", help="also write findings here")
ap.add_argument("--clip", metavar="DIR", help="write a WAV of each flagged word so you can HEAR what the model heard")
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
seg = Aya(surah, a0).get_by_imlaey_words(0, nwords)
sp = quran_phonetizer(seg.uthmani, moshaf, remove_spaces=False)
nosp = quran_phonetizer(seg.uthmani, moshaf, remove_spaces=True)
groups = sp.phonemes.split(" ")
uth = seg.uthmani.split()

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
        test = is_har if kind == "har" else is_con
        said = [(ch, p) for ch, p in zip(hrdC[j1:j2], probC[j1:j2]) if test(ch)]
        if not said:
            continue                                   # rule 1: abstain
        if any(ch == refC[i] for ch, _ in said):
            continue
        conf = max(p for _, p in said)
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


G2W = map_groups_to_words(groups, uth)


def show(gi):
    ws = G2W[gi] if gi < len(G2W) else []
    return " ".join(uth[w] for w in ws) if ws else f"[group {gi}]"

if not by_word:
    print("  ✓ لا ملاحظات — nothing flagged.\n")
else:
    print(f"  {len(by_word)} word(s) with a finding:\n")
    for gi in sorted(by_word):
        print(f"  ● {show(gi)}")
        for f in sorted(by_word[gi], key=lambda x: -x["conf"]):
            if f["kind"] == "har":
                exp = HARAKA_NAME.get(f["expected"], f["expected"])
                got = HARAKA_NAME.get(f["heard"], f["heard"])
                print(f"      الحركة — الصواب {exp}، وسمعتُ {got}   (ثقة {f['conf']:.0%})")
            else:
                print(f"      الحرف  — الصواب {f['expected']}، وسمعتُ {f['heard']}   (ثقة {f['conf']:.0%})")
        print()

n_har = sum(1 for f in best.values() if f["kind"] == "har")
n_con = sum(1 for f in best.values() if f["kind"] == "con")
print(f"  {len(groups)} words checked · {n_har} harakat · {n_con} letters · conf ≥ {a.conf:.0%}")
print("  (a word edge is never judged — waqf and idgham legitimately change it;")
print("   madd length is never judged — how long you hold a vowel is your choice)\n")

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
        print(f"    {os.path.basename(out)}   (~{f['atS']:.1f}s ± {PAD}s)")
    print()

if a.json:
    json.dump({"wav": a.wav, "range": f"{surah}:{a0}-{a1}", "rtf": el / dur,
               "findings": [{**f, "word": show(f["word"])} for f in best.values()]},
              open(a.json, "w"), ensure_ascii=False, indent=1)
    print(f"  wrote {a.json}\n")
