#!/usr/bin/env python3
"""Convert forced-alignment `NNN_ayah_timestamps.json` files (wav2vec2
aligner output, one per surah) into the compact per-surah timings format
the frontend engine fetches from GCS:

    {"surah": N, "ayahs": [{"ayah": k, "start": ms, "end": ms}, ...]}

Rules applied:
  - start/end come from the aligner's padded playback window
    (play_start_sec / play_end_sec), not the raw alignment bounds.
  - end is clamped to the NEXT ayah's start. The aligner's play windows
    can overlap the next ayah by up to 20ms (END_PAD vs START_LEADIN),
    and the engine's single-ayah stop check breaks if an ayah's end lies
    past the next ayah's start (the highlight advances before the stop
    fires — see tick() in src/surahAudio.js).
  - When the file has a separate `basmala` unit (surahs other than 1 and
    9), ayah 1's window is extended back to the basmala start, matching
    every other reciter on the site (their ayah-1 windows start at 0:00
    and include the basmala). The istiadhah stays excluded.

Usage:
    python3 scripts/convert-ayah-timestamps.py <input_dir> <output_dir>

Then upload:
    gsutil -m cp <output_dir>/*.json gs://m7mdiyat-tafsir-data/timings/<reciter>/
"""

import json
import re
import sys
from pathlib import Path

LEADIN_SEC = 0.05  # same lead-in the aligner uses for play_start


def convert(src: Path) -> dict:
    data = json.loads(src.read_text(encoding="utf-8"))
    surah = int(re.match(r"(\d+)", src.name).group(1))

    units = [u for u in data["units"] if u.get("is_ayah")]
    basmala = next(
        (u for u in data["units"] if not u.get("is_ayah") and u.get("label") == "basmala"),
        None,
    )

    # Phantom-basmala guard: when the recording has no basmala but the
    # aligner text included one, the basmala unit gets squeezed onto the
    # opening words of ayah 1 (qasim surah 4 is recorded without basmala).
    # The remaining boundaries still come out right — the aligner re-anchors
    # within the first ayah — but flag it for a by-ear check of ayah 1.
    if basmala is not None:
        spw = data.get("median_sec_per_word")
        bas_dur = basmala["end_sec"] - basmala["start_sec"]
        if spw and bas_dur < 0.5 * 4 * spw:
            print(
                f"  WARNING {src.name}: basmala unit is {bas_dur:.2f}s but ~{4 * spw:.1f}s "
                f"expected at this reciter's pace — recording may have no basmala; "
                f"verify ayah 1 by ear",
                file=sys.stderr,
            )

    ayahs = []
    for i, u in enumerate(units):
        start = u["play_start_sec"]
        end = u["play_end_sec"]
        if i + 1 < len(units):
            end = min(end, units[i + 1]["play_start_sec"])
        if i == 0 and basmala is not None:
            start = max(0.0, basmala["start_sec"] - LEADIN_SEC)
        ayahs.append(
            {
                "ayah": int(u["label"]),
                "start": int(round(start * 1000)),
                "end": int(round(end * 1000)),
            }
        )

    # Sanity: contiguous ayah numbers, monotonic non-overlapping windows.
    for i, a in enumerate(ayahs):
        assert a["ayah"] == i + 1, f"{src.name}: ayah numbering gap at {a['ayah']}"
        assert a["end"] > a["start"], f"{src.name}: empty window for ayah {a['ayah']}"
        if i + 1 < len(ayahs):
            assert a["end"] <= ayahs[i + 1]["start"], (
                f"{src.name}: ayah {a['ayah']} end overlaps ayah {a['ayah'] + 1} start"
            )

    integ = data.get("integrity", {})
    if integ and not integ.get("match"):
        print(f"  WARNING {src.name}: integrity.match is false", file=sys.stderr)

    return {"surah": surah, "ayahs": ayahs}


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    in_dir, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)

    sources = sorted(in_dir.glob("*_ayah_timestamps.json"))
    if not sources:
        sys.exit(f"no *_ayah_timestamps.json files in {in_dir}")

    for src in sources:
        converted = convert(src)
        dest = out_dir / f"{converted['surah']}.json"
        dest.write_text(json.dumps(converted, separators=(",", ":")), encoding="utf-8")
        n = len(converted["ayahs"])
        last = converted["ayahs"][-1]
        print(f"{src.name} -> {dest.name}  ({n} ayahs, last ends {last['end'] / 1000:.1f}s)")


if __name__ == "__main__":
    main()
