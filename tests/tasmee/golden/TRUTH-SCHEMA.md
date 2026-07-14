# tasmee-truth-v1 — ground-truth schema for golden clips

Finalized 2026-07-10, BEFORE recording (re-recording is the expensive part — schema
changes after clips exist require re-scripting, not re-recording, as long as the acts
below stay expressive enough; that is why skips/repeats support ranges from day one).

One `.truth.json` per planted-error clip (clips 04/05; optional for others), same
basename as the WAV: `05-skips-repeats-p604.wav` ↔ `05-skips-repeats-p604.truth.json`.
Write the script FIRST, then recite from it. Gate 3 measures the detector's
precision/recall against these files.

## Rules

- `pos` values are **1-based QCF4 word positions** — the same numbering as
  `public/tasmee-words.json` (open it and count along the ayah when scripting; sajda ۩
  positions are never referenced and never recited).
- `events` are in **chronological recitation order**.
- Everything NOT listed = recited correctly, exactly once.
- `times` = TOTAL utterances including the first (2 = said twice).
- `said` = what was actually said, plain Arabic, any spelling (it gets normalized).

## Acts

| act | shape | meaning |
|---|---|---|
| `sub` | `{act, vk, pos, said}` | wrong word said in place of `vk:pos` |
| `skip` | `{act, vk, pos}` | one word omitted |
| `skip` | `{act, vk, from, to}` | word span within one ayah omitted (inclusive) |
| `skip` | `{act, vk}` | whole ayah omitted |
| `skip` | `{act, vkFrom, vkTo}` | consecutive whole ayahs omitted (inclusive) |
| `repeat` | `{act, vk, times}` | whole ayah recited `times` times in a row |
| `repeat` | `{act, vk, from, to, times}` | phrase within one ayah repeated |
| `repeat` | `{act, vkFrom, fromPos, vkTo, toPos, times}` | cross-ayah range re-recited (the "go back and run through again" case); `fromPos`/`toPos` optional, default full ayahs |
| `insert` | `{act, vk, afterPos, said}` | non-reference utterance inserted after `vk:afterPos` (`afterPos: 0` = before the ayah's first word) |
| `hesitate` | `{act, vk, pos, sec}` | deliberate silent pause ≥ `sec` seconds BEFORE saying `vk:pos` |

Optional `note` on any event (free text, ignored by the harness).

## Complete worked example

Page 2 (2:1–2:5). The reciter: repeats the opening phrase of 2:2, omits ويقيمون in
2:3, goes back to the start of 2:3 mid-2:4 and re-runs through, substitutes the last
word of 2:4, says استغفر الله inside 2:5, and hesitates ~6 s before ربهم.

```json
{
  "schema": "tasmee-truth-v1",
  "clip": "05-skips-repeats-p002.wav",
  "page": 2,
  "range": { "vkFrom": "2:1", "vkTo": "2:5" },
  "events": [
    { "act": "repeat", "vk": "2:2", "from": 1, "to": 4, "times": 2,
      "note": "ذلك الكتاب لا ريب said twice, then continue from فيه" },
    { "act": "skip", "vk": "2:3", "pos": 4,
      "note": "ويقيمون omitted — jump from بالغيب to الصلاة" },
    { "act": "repeat", "vkFrom": "2:3", "fromPos": 1, "vkTo": "2:4", "toPos": 3, "times": 2,
      "note": "reached بما (2:4:3), went back to start of 2:3, ran through again" },
    { "act": "sub", "vk": "2:4", "pos": 12, "said": "يؤمنون",
      "note": "said يؤمنون instead of يوقنون" },
    { "act": "insert", "vk": "2:5", "afterPos": 2, "said": "استغفر الله" },
    { "act": "hesitate", "vk": "2:5", "pos": 5, "sec": 6 }
  ]
}
```

Expected detector outcome for this clip (what Gate 3 scores against): 2:3:4 flagged
skipped; 2:4:12 flagged substituted; the استغفر الله tokens flagged as insertions (or
repetition-echo — both count as non-mistake-non-derail); ONE hesitation before 2:5:5;
the two repeat events produce repetition events only — ZERO additional mistakes.
