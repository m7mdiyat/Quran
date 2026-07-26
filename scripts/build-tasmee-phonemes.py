"""build-tasmee-phonemes.py — the Quran Phonetic Script reference, precomputed.

    ./.venv-muaalem/bin/python scripts/build-tasmee-phonemes.py

Writes public/tasmee-phonemes.json.

WHY THIS EXISTS. Layer 2 compares what the reciter said against the
phonemes the reference REQUIRES, and those come from
`quran_transcript.quran_phonetizer` — which is Python. The app is
JavaScript. Rather than port a tajweed engine (and own every future
divergence between two implementations of the same rules), the reference
is computed once, offline, by the authoritative implementation, and
shipped as data. Same pattern as public/tasmee-words.json.

WHAT IS IN IT, per ayah:
    p    the phoneme groups, space-separated exactly as the phonetizer
         emits them
    w    for each group, how many uthmani words it covers

`w` is not bookkeeping, it is load-bearing. The phonetizer MERGES words
across idgham and ikhfa — عن + سبيل becomes the single group عَںںںسَبِۦۦلِ
— so groups and words are not 1:1 and the app cannot recover the mapping
on its own. Without it a finding cannot name the word it belongs to, and
a finding that names the wrong word is worse than no finding: it sends
the reciter to re-read something they said correctly. (Measured while
building the CLI: indexing words by group number labelled أَضَلَّ as
ٱلصَّـٰلِحَـٰتِ.)

The same `w` also lets the app rebuild the internal word SEAMS inside a
merged group, which is where the tajweed guard applies — the boundary a
merge hides is exactly where idgham lives, and judging it produced false
flags on correct recitation (لَشَىْءٌۭ يُرَادُ reported as ي→ن, which is
idgham with ghunna doing what it should).
"""
import json, os, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "tasmee-phonemes.json")

from quran_transcript import Aya, quran_phonetizer, MoshafAttributes
import difflib

# Hafs, the recitation the app is built on. madd lengths are the standard
# 4-count; they affect how long a vowel is HELD, which Layer 2 never judges
# (length is a recitation choice), so the exact value here cannot change a
# verdict — it only changes the reference's own spelling of a long vowel.
MOSHAF = MoshafAttributes(rewaya="hafs", madd_mottasel_len=4, madd_monfasel_len=4,
                          madd_mottasel_waqf=4, madd_aared_len=4)

DATASET = json.load(open(os.path.join(ROOT, "public", "tasmee-words.json")))
VERSES = DATASET["verses"]


def words_per_group(groups, words):
    """How many uthmani words each phoneme group covers.

    Walks both sequences: phonetize each word once, then let each group
    consume words while doing so still improves its similarity to that
    group. Greedy and left-to-right, which is sound because both sequences
    are in reading order.
    """
    wp = []
    for w in words:
        try:
            wp.append(str(quran_phonetizer(w, MOSHAF, remove_spaces=True).phonemes))
        except Exception:
            wp.append("")
    counts, wi = [], 0
    for g in groups:
        if wi >= len(wp):
            counts.append(0)
            continue
        take, acc = 1, wp[wi]
        best = difflib.SequenceMatcher(None, acc, g).ratio()
        k = wi + 1
        while k < len(wp):
            cand = acc + wp[k]
            r = difflib.SequenceMatcher(None, cand, g).ratio()
            if r <= best + 1e-9:
                break
            best, acc = r, cand
            take += 1
            k += 1
        counts.append(take)
        wi += take
    # every word must be accounted for, or the app's word attribution silently
    # drifts for the rest of the ayah
    return counts, wi


def main():
    out, t0 = {}, time.time()
    total_ayat = 0
    mismatched = []
    for surah in range(1, 115):
        a = 1
        while True:
            vk = f"{surah}:{a}"
            if vk not in VERSES:
                break
            try:
                # Take the WHOLE ayah, not a word span. get_by_imlaey_words() counts
                # IMLAEY words, and the vocative joins in Uthmani script — يا موسى
                # is two Imlaey words but one Uthmani word (يَـٰمُوسَىٰ) — so asking
                # for the app's word count splits an Uthmani word and throws. That
                # cost 11 ayat of surah طه, الأنبياء and الصافات on the first run.
                uthmani = Aya(surah, a).get().uthmani
                sp = quran_phonetizer(uthmani, MOSHAF, remove_spaces=False)
                groups = str(sp.phonemes).split(" ")
                words = uthmani.split()
                counts, consumed = words_per_group(groups, words)
                if consumed != len(words):
                    mismatched.append((vk, consumed, len(words)))
                row = {"p": " ".join(groups), "w": counts}
                if consumed != len(words):
                    # MARK, DO NOT GUESS. The greedy walk did not account for every
                    # word here, so group→word attribution is unreliable in this
                    # ayah. The app must still CHECK it, but must not NAME a word
                    # — a finding pointing at the wrong word sends the reciter to
                    # re-read something they said correctly, which is worse than
                    # saying "somewhere in this ayah".
                    row["x"] = 1
                out[vk] = row
                total_ayat += 1
            except Exception as e:
                print(f"  !! {vk}: {e}", file=sys.stderr)
            a += 1
        if surah % 10 == 0:
            print(f"  surah {surah:>3} · {total_ayat} ayat · {time.time()-t0:.0f}s", flush=True)

    payload = {"version": 1, "script": "QPS", "rewaya": "hafs",
               "counts": {"ayat": total_ayat}, "verses": out}
    json.dump(payload, open(OUT, "w"), ensure_ascii=False, separators=(",", ":"))
    mb = os.path.getsize(OUT) / 2**20
    print(f"\nwrote {OUT}  ({mb:.1f} MB, {total_ayat} ayat, {time.time()-t0:.0f}s)")
    if mismatched:
        print(f"\n{len(mismatched)} ayah(s) where the group→word walk did not consume every word.")
        print("These are the ones whose findings could name the wrong word — inspect before shipping:")
        for vk, got, want in mismatched[:20]:
            print(f"    {vk}: consumed {got} of {want}")
    else:
        print("group→word alignment accounts for every word in every ayah.")


if __name__ == "__main__":
    main()
