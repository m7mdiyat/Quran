/* ============================================================
 * tasmee-audio-worklet.js — AudioWorkletProcessor for وضع التسميع
 * mic capture (TASMEE-PLAN §0.4).
 *
 * Runs on the audio render thread. Captures mono at the HARDWARE
 * rate (`sampleRate`, requested = 48 kHz — never a 16 kHz context,
 * WKWebView mishandles it) and forwards RAW 48 kHz blocks to the
 * main thread, plus an RMS/peak for the live meter. The RESAMPLE to
 * 16 kHz happens in the WORKER via the shared `resampleTo16k`
 * (63-tap FIR) so device audio and the offline bench hit the model
 * through the SAME kernel — that identity is the decode parity.
 * (Piece 3 resampled here; Piece 4 moved it to the worker so the
 * bench's exact FIR is reused instead of a second resampler.)
 *
 * No allocation in process() beyond the per-block post (~every
 * 32 ms). Blocks are 1536 samples @48 k = 32 ms.
 * ============================================================ */

class TasmeeCapture extends AudioWorkletProcessor {
    constructor() {
        super();
        this.block = new Float32Array(1536);   // 32 ms @48 kHz
        this.fill = 0;
        this.running = true;
        this.port.onmessage = (e) => { if (e.data === "stop") this.running = false; };
    }

    process(inputs) {
        if (!this.running) return false;
        const input = inputs[0];
        if (!input || !input.length || !input[0]) return true;
        const n = input[0].length, chans = input.length;
        for (let i = 0; i < n; i++) {
            let s = input[0][i];
            for (let c = 1; c < chans; c++) s += input[c][i];
            this.block[this.fill++] = chans > 1 ? s / chans : s;
            if (this.fill === this.block.length) this._flush();
        }
        return true;
    }

    _flush() {
        const pcm = this.block.slice(0, this.fill);   // raw 48 kHz mono block (transferable copy)
        let sum = 0, peak = 0;
        for (let i = 0; i < pcm.length; i++) {
            const a = pcm[i] < 0 ? -pcm[i] : pcm[i];
            sum += pcm[i] * pcm[i];
            if (a > peak) peak = a;
        }
        this.port.postMessage({ pcm, rms: Math.sqrt(sum / pcm.length), peak, rate: sampleRate }, [pcm.buffer]);
        this.fill = 0;
    }
}

registerProcessor("tasmee-capture", TasmeeCapture);
