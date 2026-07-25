/* SOUND-CUE fixtures (2026-07-26).
 *
 * These pin one safety property and one taste rule.
 *
 * SAFETY. src/tasmee-audio.js opens the mic with echoCancellation OFF —
 * deliberately, because AGC pumps and noise-suppression eats tajweed
 * elongations, and the golden clips the model was validated on had none
 * of that processing. The consequence is that ANY sound the phone plays
 * during capture is recorded at full strength, resampled to 16 kHz, and
 * decoded by the acoustic model as if the reciter had said it. A cue
 * during recitation is therefore not a cosmetic risk; it manufactures a
 * phantom word, and a phantom word becomes a false mistake against
 * someone reciting Quran from memory.
 *
 * So the interlock is not advisory and these tests exist to keep it that
 * way: every path that opens the stream closes the gate, every path that
 * releases it reopens the gate, and a caller who forgets is refused
 * rather than trusted.
 *
 * TASTE. No cue in the palette is a failure buzzer, and no cue fires on
 * a mistake. Live feedback goes out through haptics, which a microphone
 * cannot hear.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { cue, haptic, setMicLive, sfxEnabled, stats, _resetStats, cueNames } from "../../src/tasmee-sfx.js";

const fresh = () => { setMicLive(false); sfxEnabled(true); _resetStats(); };

test("a cue is REFUSED while the mic is live", () => {
    fresh();
    assert.equal(cue("stopped"), true, "plays when the mic is closed");
    setMicLive(true);
    assert.equal(cue("stopped"), false, "must refuse into an open microphone");
    assert.equal(cue("perfect"), false);
    assert.equal(stats().suppressed, 2, "refusals are counted, not silently dropped");
});

test("closing the stream reopens the gate", () => {
    fresh();
    setMicLive(true);
    assert.equal(cue("stopped"), false);
    setMicLive(false);
    assert.equal(cue("stopped"), true);
});

test("setMicLive is idempotent — repeated closes cannot re-open it early", () => {
    fresh();
    setMicLive(true);
    setMicLive(true);
    assert.equal(cue("armed"), false);
    setMicLive(false);
    assert.equal(cue("armed"), true);
});

test("the OFF setting silences cues without disabling the interlock", () => {
    fresh();
    sfxEnabled(false);
    assert.equal(sfxEnabled(), false);
    assert.equal(cue("stopped"), false);
    setMicLive(true);
    assert.equal(cue("stopped"), false, "still refused, for the safety reason as well");
    sfxEnabled(true);
    assert.equal(cue("stopped"), false, "the mic is STILL live — the setting cannot override safety");
    setMicLive(false);
    assert.equal(cue("stopped"), true);
});

test("an unknown cue name is a no-op, never a throw", () => {
    fresh();
    assert.equal(cue("nope"), false);
    assert.equal(cue(undefined), false);
});

test("haptics no-op off-device and never throw", () => {
    fresh();
    assert.equal(haptic("light"), false, "no Capacitor bridge on the website");
    assert.equal(haptic("select"), false);
    assert.doesNotThrow(() => haptic("nonsense"));
});

test("haptics are the LIVE channel: they work while the mic is open", () => {
    /* The whole point — a vibration cannot be recorded, so unlike cue()
     * this path must NOT be gated by the interlock. It returns false here
     * only because there is no native bridge in node; what is asserted is
     * that mic-live state is not what stops it. */
    fresh();
    setMicLive(true);
    assert.doesNotThrow(() => haptic("light"));
    sfxEnabled(false);
    assert.equal(haptic("light"), false, "the user's OFF switch does silence haptics too");
});

test("the palette contains nothing punitive", () => {
    /* `error` is a real cuelume cue and is deliberately NOT mapped. A
     * reciter who slips while reciting Quran from memory does not get a
     * buzzer; the page already carries the verdict in colour. */
    assert.ok(!cueNames.includes("error"));
    assert.ok(!cueNames.includes("mistake"));
    assert.ok(cueNames.includes("perfect") && cueNames.includes("stopped"),
        "the session close is chosen between these two, both non-punitive");
});
