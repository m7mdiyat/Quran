/*
 * Ayah-repeat preference + active-loop counter (shared website + app).
 *
 * Two layers:
 *   1. PREFERENCE: how many times to play the selected ayah (1 = off, 3, 5, ∞).
 *      Persisted in localStorage under "m7_ayah_repeat" and surfaced via the
 *      audio settings popovers. Listeners fire when the user changes it so the
 *      Tafsir and Mushaf settings chips stay in lockstep.
 *   2. ACTIVE LOOP: a per-playback counter bound to ONE ayah-key ("S:A").
 *      startLoopFor() seeds it from the preference at the start of playback,
 *      consumeOne() runs at the end-of-ayah hook to decide whether to replay
 *      or fall through to the existing stop logic. Switching ayah/reciter or
 *      pressing stop resets the counter so the loop never bleeds.
 *
 * The audio engine (surahAudio.js) and both per-ayah <audio> paths (Tafsir
 * tab in app.js, Mushaf in mushaf.js) all call the same consumeOne(); that's
 * the single integration point for the loop behaviour.
 */

"use strict";

const STORAGE_KEY = "m7_ayah_repeat";
// Two-state toggle: 1 = off (play once), Infinity = loop until user stops.
// The underlying counter still supports any positive integer, so older
// stored values (3, 5) are honoured for backward compatibility — but the
// UI only exposes Off/On.
export const REPEAT_OPTIONS = [1, Infinity];
const REPEAT_LEGACY = [3, 5]; // accepted on read, mapped to Infinity if encountered

const LISTENERS = new Set();

/* ----------------------------- Preference ----------------------------- */

function readPref() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw === "inf") return Infinity;
        const n = Number(raw);
        if (Number.isFinite(n)) {
            if (REPEAT_OPTIONS.includes(n)) return n;
            // Legacy value (3 / 5) from an earlier build — surface as Infinity
            // so the user still sees the loop they had enabled.
            if (REPEAT_LEGACY.includes(n)) return Infinity;
        }
    } catch { }
    return 1;
}

let _pref = readPref();

export function getRepeatPref() { return _pref; }

export function setRepeatPref(n) {
    const v = n === Infinity || n === "inf" ? Infinity : Number(n);
    if (!REPEAT_OPTIONS.includes(v)) return;
    if (v === _pref) return;
    _pref = v;
    try { localStorage.setItem(STORAGE_KEY, v === Infinity ? "inf" : String(v)); } catch { }
    for (const fn of LISTENERS) { try { fn(_pref); } catch { } }
}

export function subscribeRepeat(fn) {
    LISTENERS.add(fn);
    try { fn(_pref); } catch { }
    return () => LISTENERS.delete(fn);
}

/* ----------------------------- Active loop ----------------------------- */

let _activeKey = null;
let _remaining = 0; // additional plays still owed (0 = current play is the last)

/* Call when playback begins on a NEW ayah. `key` is "S:A". Seeds the counter
 * from the current preference: pref 1 → 0 remaining, pref 3 → 2 remaining,
 * ∞ → Infinity. */
export function startLoopFor(key) {
    _activeKey = key || null;
    _remaining = _pref === Infinity ? Infinity : Math.max(0, _pref - 1);
}

/* Called from the end-of-ayah hook. If the loop is still active for the
 * same key, decrement and return true (caller should replay the ayah).
 * Returns false otherwise — caller falls through to its existing stop /
 * next-ayah behaviour. */
export function consumeOne(key) {
    if (!_activeKey || _activeKey !== key) return false;
    if (_remaining <= 0) {
        _activeKey = null;
        return false;
    }
    if (_remaining !== Infinity) _remaining -= 1;
    return true;
}

/* Reset the active counter without touching the preference. Called by all
 * audio-teardown paths so the next playback starts a fresh loop. */
export function resetLoop() {
    _activeKey = null;
    _remaining = 0;
}

export function getActiveLoopKey() { return _activeKey; }
export function isLoopActive() { return _activeKey != null && _remaining > 0; }
