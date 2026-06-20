# Smoothness Cleanup — safe, invisible performance wins

**Scope:** Analysis only, no code changed. Hunt for **behavior-preserving + appearance-preserving**
changes that reduce lag and improve scroll/interaction smoothness on the Mushaf/Tafsir surfaces —
same pixels, same interactions, same timing. Anything with a visible or behavioral tradeoff is
quarantined in its own section.

**Honest headline:** this codebase is **already carefully optimized** on the paths I was asked to
check — the drags are rAF-batched with dims cached at grab, tap handlers are delegated (no per-word
listeners), scroll listeners are passive + debounced, the search-glow gradient is built once, and the
search index is chunked. So the genuinely-invisible wins are **few and mostly small**. One is a clean,
clear win on a real interaction hot path; the rest are micro. I am **not** padding the list — most of
what I checked is listed under "Checked and already optimal" precisely so you don't re-investigate it.

Each item is flagged **Certain** (clearly safe *and* clearly helps) or **Inferred** (safe, but the
magnitude needs a device trace to confirm it's worth doing).

---

## Ranked safe, invisible improvements

### 1. Wheel picker: cache `--aw-h` instead of `getComputedStyle` on every `pointermove`
- **What:** the iOS-style ayah wheel selector measures item height via
  `getComputedStyle(wheel).getPropertyValue("--aw-h")` on **every pointermove during a drag**.
- **Where:** `getWheelItemHeight()` — **`src/mushaf.js:2342–2348`** (the `getComputedStyle` is line
  **2345**); called per-move at **`src/mushaf.js:2481`** inside the `pointermove` handler, then
  immediately followed by `applyWheelTransform()` (a transform **write**) at line 2499.
- **Why it costs:** `getComputedStyle().getPropertyValue()` can force a synchronous **style recalc**,
  and here it's a **read → write (transform) → read → write** loop, ~60–120×/sec for the whole drag.
  `--aw-h` is a constant during a drag (it only changes on font-size/orientation change, which can't
  happen mid-drag).
- **Fix:** read `--aw-h` **once at `pointerdown`** (drag start), store it in the drag-local state, and
  reuse it in `pointermove` (and `endDrag`, line 2515). Optionally cache module-level and invalidate on
  `resize`/orientation. Math is byte-identical because the value is constant during the drag.
- **Benefit:** removes a forced style-flush per move on the wheel drag → smoother ayah-wheel scrubbing,
  most noticeably on weak Android. **Narrow** (only the ayah-jump wheel), but a clean win.
- **Flag:** **Certain** (the value cannot change mid-drag → behavior-identical). Magnitude **Inferred**.

### 2. `resume.js` scroll handler: mutate `scrollY` instead of allocating a new state object per scroll event
- **What:** the resume-position scroll listener rebuilds the whole state object on every scroll tick:
  `_state = { ..._state, scrollY: currentScrollY() }`.
- **Where:** **`src/resume.js:101`** (handler `onScroll`, lines 98–103); attached passively at
  `resume.js:95` / `:132`. Fires during **Tafsir scrolling** (the scroll source).
- **Why it costs:** a fresh object spread **per scroll event** = allocation churn → GC pressure during a
  fast scroll, the kind that shows up as occasional scroll hitches on low-end devices. (The write to
  `localStorage` is already debounced — good — this is only the per-event allocation.)
- **Fix:** mutate in place — `_state.scrollY = currentScrollY()` — instead of spreading. `_state` is
  module-private and nothing compares its identity, so this is behavior-identical.
- **Benefit:** removes per-scroll-tick allocation on the Tafsir scroll path. Small.
- **Flag:** **Certain-safe** (one assumption: nothing outside the module relies on `_state` being a new
  object each tick — verified it doesn't). Magnitude **Inferred / small**.

### 3. (Marginal) `mushaf:page-rendered` fan-out — each listener re-queries the new page
- **What:** on every page turn, 2–3 independent listeners fire and each walks the new page DOM
  (gharib decorate, fullscreen handler, app.js).
- **Where:** dispatch at **`src/mushaf.js:1619`**; listeners at **`src/gharib.js:860`**,
  **`src/page-fullscreen.js:90`**, and **`src/app.js:5741`** (region).
- **Why it costs:** redundant DOM traversal of ~150–300 spans per turn (each handler does its own
  queries). Per-page-turn, **not** per-frame, and bounded — so this is genuinely minor.
- **Fix:** could pass already-collected node refs in the event `detail` so handlers don't re-query.
  Behavior-identical, but the payoff is tiny.
- **Flag:** **Inferred / very small.** Listed for completeness; I would **not** prioritize it.

### 4. (Marginal) Gharib tooltip reads `getComputedStyle` twice per open
- **What:** opening a meaning tooltip reads `getComputedStyle` for safe-area inset and font-size.
- **Where:** **`src/gharib.js:765`** and **`:770`** (inside the tooltip-open path).
- **Why it costs:** two style reads per tap-to-open. **Per-interaction** (one tap), not per-frame — so
  effectively free; only noted because you asked for uncached reads.
- **Fix:** the safe-area inset can be cached/observed instead of read per open. Negligible.
- **Flag:** **Inferred / negligible.** Not worth doing on its own.

---

## Checked and already optimal — do NOT re-investigate (no change needed)
These are the paths you'd expect to be hot; I read them and they're already correct:

- **Mukhtasar card drag** (`src/mushaf.js:3491–3517`) — `pointermove` only stores coords + schedules a
  rAF; `applyDrag` uses **dims cached at grab** (`cachedW/VW/VH`) and writes **only** `transform:
  translate3d`. Textbook. The single `void offsetWidth` at drag-end (3535) is a deliberate one-time
  style flush. **No per-frame layout read.**
- **Long-press `pointermove`s** (`src/app.js:2008`, `src/mushaf.js:2908`) — pure distance arithmetic to
  cancel a long-press. No reads/writes.
- **Page-swipe `touchmove`** (`src/mushaf.js:1901`) — passive, arithmetic-only, no layout work.
- **Gharib scroll handler** (`src/gharib.js:891`) — passive; calls `closeTip()` /
  `hideLanternExplainer()`, both of which **early-return** when nothing is open. Free at rest.
- **Tafsir height FLIP** (`src/app.js:3750–3782`) — does two forced reflows (`offsetHeight` measure +
  `void offsetWidth` commit), but those are **inherent to a height FLIP** and run **per ayah-change**,
  not per-frame. Already reasonable.
- **`transitions.js`** — the FLIP/clear-glow reads are **batched** (all `getBoundingClientRect` reads,
  no interleaved writes — `buildGlowBackground` at 372–403), the gradient is **"built ONCE"** (438, not
  per-frame), and CSS-var durations are read once per transition into a cached config (`cssMs`/`cssNum`,
  not per-frame).
- **Scroll-lock guards** (`ddGuardTouchMove`/`ddGuardWheel`, `src/mushaf.js:~2790`) — `passive:false` is
  **required** (they `preventDefault` to lock background scroll), and they're **scoped** to the
  surah-dropdown-open state (`removeDdScrollGuards` tears them down). Correct.
- **Resume double-source** — `watchScroll` swaps the source listener cleanly; window + element sources
  don't double-fire for the same scroll.
- **Delegated Mushaf taps** (`src/mushaf.js:1814–1877`) + **page removal on turn** (1599–1607) — no
  per-word listeners, no DOM growth. The wheel wiring is guarded by `_wWired` (wired once).

---

## Investigated and NOT a safe win (so you don't try them)
- **`@property … inherits: true`** (`public/mushaf.css:3176–3177` for `--gh-on`/`--gw-x`;
  `index.html:2853–2871` for the 11 `--*-mukhtasar` beam props). The audit's general note was "flip
  unneeded `inherits:true` to `false`" — **but here they are all load-bearing**: each is **set on a
  parent/element and read by a child or pseudo-element** (`--gh-on`/`--gw-x` set on `.gharib-word`, read
  by `::before`/`::after`; the beam props set on `[data-beam]`, read by the beam layers). Changing them
  to `inherits:false` would **break** the gharib toggle/learn fade and the مختصر beam. **Not a safe
  hygiene fix.** Leave them.
- **Broad class toggles on hot paths** — I looked for body/html-level class toggles firing per-frame or
  per-page-turn that would cascade style recalc widely. The frequent toggles are **scoped** (page-turn
  classes on the pages container/page; ayah-active on `.mushaf-ayah`). The wide ones (`body.dark`,
  `body.gharib-off`) are **rare** (theme/feature switches). Nothing safe to "fix" here without measuring
  the stylesheet-recalc cost first (and that lever isn't invisible — see the tradeoff section).

---

## Has a visible/behavioral tradeoff — your call, one by one
Not purely invisible, so quarantined here:

- **Removing persistent `will-change`** (`.gharib-badge` `public/mushaf.css:3862`, `.gharib-digit`
  `:3927` incl. `filter`, `.mushaf-wheel__list` `:2321`, plus several in `index.html`). Removing them is
  **pixel-identical at rest** and frees a few small always-on compositor layers — *but* it can introduce
  a **brief hitch the first frame those elements next animate** (the browser promotes on-demand instead
  of ahead of time). So it's "invisible at rest, possibly a micro-stutter at animation start." The
  elements are tiny (lantern counter, badge), so the memory saved is negligible and the risk probably
  isn't worth it. **Decide per element; needs a trace to know if it even matters.**
- **Style-recalc cost from the ~350 KB stylesheet on class toggles** (audit #3). The real lever here is
  slimming/splitting the CSS or simplifying hot-path selectors — **not behavior-risky, but not reliably
  invisible either** (any selector change risks a cascade difference), and it's a larger effort with an
  uncertain payoff. Out of scope for a "guaranteed invisible" pass; revisit only if a trace shows
  **"Recalculate Style"** dominating during page turns.
- **Tafsir height FLIP reflows** (app.js:3750) — could be made cheaper by not animating `height`, but
  that **changes the visible animation**. Out of scope (visible).

> Explicitly **not touched** per your boundaries: gharib glow, audio highlight, pulse-beam, search
> internals, the text-stroke faux-bold, and any visible animation. (Items 2 and the marginal items above
> are in resume/wheel/tooltip plumbing, not those features.)

---

## What needs a device trace vs. what's safe to just apply

**Safe to apply now without a trace** (correctness-neutral, behavior-identical regardless of magnitude):
- **#1 wheel `--aw-h` cache** — the value is provably constant during a drag.
- **#2 resume `onScroll` in-place mutate** — `_state` is module-private.

These two can't make anything *worse*; the only open question is how much they help.

**Needs a device trace to decide if it's worth doing:**
- Whether the wheel `getComputedStyle` (#1) was actually causing visible wheel-drag jank (very likely on
  old Android, but the trace quantifies it). Capture: DevTools Performance, record an ayah-wheel drag,
  look for **"Recalculate Style"** spikes aligned to pointermove.
- The `will-change` removals (tradeoff section) — only a trace tells you if those layers cost anything;
  almost certainly negligible.

**Honest expectation-setting:** these invisible wins are **real but small/narrow**. They will *not*, by
themselves, resolve broad Mushaf interaction lag — per the earlier audit, the bigger lag levers are
**#2 text-stroke paint** and **#3 stylesheet style-recalc**, and *both of those carry visible or
non-trivial tradeoffs* and are therefore out of this pass. Apply #1 and #2 as free hygiene; use the
device trace from the prior analysis to decide whether the larger (non-invisible) levers are worth
opening up.
