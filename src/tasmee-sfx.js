/* ============================================================
 * tasmee-sfx.js — interaction cues for وضع التسميع.
 *
 * Sound comes from `cuelume` (MIT, ~5 kB, zero dependencies): every cue
 * is SYNTHESIZED live through Web Audio, so nothing is fetched and the
 * app stays fully offline — the same rule the bundled fonts follow.
 *
 * ---- THE MIC INTERLOCK (the reason this module exists at all) ----
 * A cue MUST NEVER play while the microphone is live. This is not a
 * matter of taste; it is a correctness bug waiting to happen:
 *
 *   src/tasmee-audio.js opens the mic with echoCancellation OFF, and
 *   deliberately so — AGC pumps, noise-suppression eats tajweed
 *   elongations, and the golden clips the model was validated on had
 *   none of that processing. With AEC off, ANY sound the phone plays is
 *   recorded at full strength, resampled to 16 kHz, and handed to the
 *   acoustic model, which will dutifully decode it as speech. A chime
 *   during recitation becomes a phantom word, and a phantom word
 *   becomes a false mistake against the reciter.
 *
 * There is a second, iOS-specific reason: creating or resuming an
 * AudioContext while a capture session is running can make WKWebView
 * re-negotiate the audio session and reroute or drop the mic. cuelume
 * builds its context lazily on the first play(), so the interlock also
 * guarantees that construction happens BEFORE recording, never during.
 *
 * So: `setMicLive(true)` hard-gates every cue, and live feedback goes
 * out through HAPTICS instead, which cannot be heard by a microphone.
 *
 * ---- ADAB ----
 * No cue fires on a mistake during recitation, and the end-of-session
 * cue is never a failure buzzer. Someone reciting Quran from memory and
 * slipping does not need a game-over sound; the visual language already
 * carries the verdict. Cues mark TRANSITIONS (armed, finished, opened),
 * not judgements.
 * ============================================================ */

import { play as cuePlay, setEnabled as cueSetEnabled } from "cuelume";

/* Semantic layer: call sites say WHAT HAPPENED, never which waveform.
 * Keeps the palette swappable in one place and keeps the sharper cues
 * (error, sparkle) out of a Quran surface entirely. */
const CUES = {
    enter: "ready",        // tasmee mode opened — also warms the AudioContext
    armed: "tick",         // mic about to open (fires BEFORE getUserMedia)
    stopped: "chime",      // session ended, neutral regardless of result
    perfect: "success",    // ended with nothing flagged
    reviewOpen: "droplet", // a mistake card opened in review
    reviewPlay: "tick",    // playing back the reciter's own audio
    toggle: "toggle",      // a setting flipped
    panelOpen: "press",
    panelClose: "release",
};

const KEY = "m7_tasmee_sfx";
let _on = (() => {
    try { return localStorage.getItem(KEY) !== "off"; } catch { return true; }
})();
let _micLive = false;
let _suppressed = 0;       // cues the interlock refused — surfaced by stats()

/* The mic lifecycle owns this. Called with true the moment capture is
 * requested and false only once the stream is fully closed. Erring
 * toward "live" is always the safe direction. */
export function setMicLive(on) {
    _micLive = !!on;
    // Belt and braces: cuelume's own gate, so even a direct cuePlay()
    // from anywhere else in the app cannot leak into the recording.
    cueSetEnabled(_on && !_micLive);
}

export function sfxEnabled(on) {
    if (on === undefined) return _on;
    _on = !!on;
    try { localStorage.setItem(KEY, _on ? "on" : "off"); } catch { }
    cueSetEnabled(_on && !_micLive);
    return _on;
}

/* Play a semantic cue. Silently refuses while the mic is live — callers
 * are not expected to check, which is the whole point: the guarantee
 * lives here, not scattered across call sites. */
export function cue(name) {
    if (!_on) return false;
    if (_micLive) { _suppressed++; return false; }
    const sound = CUES[name];
    if (!sound) return false;
    try { cuePlay(sound); } catch { /* audio unavailable — never fatal */ }
    return true;
}

/* ---- HAPTICS: the live-feedback channel ----
 * A microphone cannot hear a vibration, so this is the ONE feedback path
 * that stays open during recitation. App-only; `isApp()` is evaluated at
 * CALL time because window.Capacitor is injected by the native bridge
 * after modules evaluate (see CLAUDE.md). No-op on the website. */
const HAPTIC_STYLES = { light: "LIGHT", medium: "MEDIUM", heavy: "HEAVY" };

export function haptic(kind = "light") {
    if (!_on) return false;
    const H = typeof window !== "undefined" && window.Capacitor
        && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics;
    if (!H) return false;
    try {
        if (kind === "select" && H.selectionChanged) H.selectionChanged();
        else if (H.impact) H.impact({ style: HAPTIC_STYLES[kind] || "LIGHT" });
    } catch { /* plugin absent on this build — never fatal */ }
    return true;
}

/* Diagnostics only. A non-zero `suppressed` after a clean session means
 * something tried to make noise into an open microphone — a bug in the
 * caller, not in the interlock. */
export function stats() { return { enabled: _on, micLive: _micLive, suppressed: _suppressed }; }
export function _resetStats() { _suppressed = 0; }

/* Cue names, for the settings UI and for tests to assert the palette
 * contains nothing punitive. */
export const cueNames = Object.keys(CUES);
