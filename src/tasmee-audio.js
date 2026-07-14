/* ============================================================
 * tasmee-audio.js — mic capture controller for وضع التسميع
 * (TASMEE-PLAN §"tasmee-audio.js", §0.4).
 *
 * getUserMedia → AudioContext (HARDWARE rate — never 16 kHz, §0.4)
 * → the `tasmee-capture` AudioWorklet (resamples to 16 kHz mono
 * Float32, computes RMS) → callbacks:
 *   onLevel({ rms, peak, level, vad })  — every ~32 ms, for the meter
 *   onChunk(pcm16k, { rms, peak, vad }) — the 16 kHz frames (Piece 4
 *                                         forwards these to the worker)
 *   onState(state, detail)              — idle | requesting | listening | error
 *
 * VAD is an RMS gate with hysteresis (ON/OFF thresholds) on a
 * smoothed level, so it latches "speaking" cleanly instead of
 * chattering at the threshold.
 *
 * PIECE 3 scope: capture + resample + VAD/meter only — NO model.
 * The point is to SEE recitation register. onChunk is wired but
 * unused until Piece 4 plugs in the worker.
 * ============================================================ */

"use strict";

const WORKLET_URL = "/tasmee-audio-worklet.js";

/* Browser speech-processing on the mic. FALSE = raw audio (matches the golden
 * clips the model was validated on). Set true only to A/B the distortion. */
const AUDIO_PROCESSING = false;

/* Tunable VAD gates (on the smoothed 16 kHz RMS). Speech RMS with AGC on sits
 * around 0.02–0.1; room tone well under 0.005. ON>OFF gives hysteresis. */
const VAD_ON = 0.012;
const VAD_OFF = 0.006;

export function createMic({ onChunk, onLevel, onState } = {}) {
    let ctx = null, stream = null, node = null, srcNode = null;
    let state = "idle";
    let smooth = 0, speaking = false;

    const setState = (s, detail) => { state = s; onState && onState(s, detail); };

    async function start() {
        if (state === "listening" || state === "requesting") return;
        setState("requesting");

        // 1) Permission + stream. A denied/absent mic is the common failure —
        //    surface the DOMException name so the UI can explain it.
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    // OFF by default — the golden clips (the ONLY audio the model was
                    // validated on) had NONE of this call-tuned processing, and it
                    // distorts recitation: AGC pumps, noise-suppression eats tajweed
                    // elongations, echo-cancel isn't needed (no playback in tasmee).
                    // Flip AUDIO_PROCESSING to compare. (§ live-mic accuracy, 2026-07-13)
                    echoCancellation: AUDIO_PROCESSING,
                    noiseSuppression: AUDIO_PROCESSING,
                    autoGainControl: AUDIO_PROCESSING,
                },
            });
        } catch (err) {
            setState("error", (err && err.name) || "getUserMedia");
            return;
        }

        // 2) Graph: mic → capture worklet. Hardware-rate context; the worklet
        //    resamples to 16 kHz (never request a 16 kHz context — §0.4).
        try {
            const AC = window.AudioContext || window.webkitAudioContext;
            // Request 48 kHz — the worker's resampleTo16k FIR is defined for 48 k
            // (the record rate, §6.5). Never 16 k (WKWebView). Most hardware is 48 k;
            // if the browser overrides to 44.1 k the worker surfaces it as an error.
            ctx = new AC({ sampleRate: 48000 });
            if (ctx.state === "suspended") await ctx.resume();
            await ctx.audioWorklet.addModule(WORKLET_URL);
            node = new AudioWorkletNode(ctx, "tasmee-capture", { numberOfInputs: 1, numberOfOutputs: 0 });
            node.port.onmessage = (e) => {
                const { pcm, rms, peak } = e.data;
                smooth = smooth * 0.6 + rms * 0.4;                     // calm the meter
                if (!speaking && smooth > VAD_ON) speaking = true;      // hysteresis latch
                else if (speaking && smooth < VAD_OFF) speaking = false;
                onLevel && onLevel({ rms, peak, level: smooth, vad: speaking });
                onChunk && onChunk(pcm, { rms, peak, vad: speaking });
            };
            srcNode = ctx.createMediaStreamSource(stream);
            srcNode.connect(node);                                     // NOT → destination (don't echo the mic)
            setState("listening", { sampleRate: ctx.sampleRate });
        } catch (err) {
            stop();
            setState("error", (err && err.message) || "worklet");
        }
    }

    function stop() {
        try { node && node.port.postMessage("stop"); } catch (e) { /* closing */ }
        try { srcNode && srcNode.disconnect(); } catch (e) { /* closing */ }
        try { node && node.disconnect(); } catch (e) { /* closing */ }
        try { stream && stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* closing */ }
        try { ctx && ctx.close(); } catch (e) { /* closing */ }
        srcNode = node = stream = ctx = null;
        smooth = 0; speaking = false;
        if (state !== "error") setState("idle");
    }

    return { start, stop, getState: () => state };
}
