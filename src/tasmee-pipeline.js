/* ============================================================
 * tasmee-pipeline.js — shared, environment-agnostic DSP for the
 * tasmee acoustic pipeline: WAV parsing (DataView — browser-safe),
 * 48→16 kHz FIR resample (A4), the mel frontend (independent
 * implementation of NeMo's AudioToMelSpectrogramPreprocessor
 * parameters — nothing vendored), and greedy CTC word decoding.
 *
 * Consumed by scripts/tasmee-bench.mjs (onnxruntime-node),
 * scripts/tasmee-parity.mjs (node vs WASM backends), and the Gate 3
 * dev-harness worker (onnxruntime-web). ONE implementation — the
 * WASM parity checksum is only meaningful because every backend
 * runs these exact bytes around the ONNX session.
 * ============================================================ */

/* ---------- WAV (PCM16, any channel count → mono) ---------- */
export function readWavMono(arrayBuffer) {
    const dv = new DataView(arrayBuffer);
    const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
    if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a WAV");
    let off = 12, fmt = null, dataOff = -1, dataLen = 0;
    while (off + 8 <= dv.byteLength) {
        const id = tag(off);
        const sz = dv.getUint32(off + 4, true);
        if (id === "fmt ") fmt = {
            audioFormat: dv.getUint16(off + 8, true),
            channels: dv.getUint16(off + 10, true),
            rate: dv.getUint32(off + 12, true),
            bits: dv.getUint16(off + 22, true),
        };
        if (id === "data") { dataOff = off + 8; dataLen = sz; }
        off += 8 + sz + (sz % 2);
    }
    if (!fmt || dataOff < 0) throw new Error("missing fmt/data chunk");
    if (fmt.audioFormat !== 1 || fmt.bits !== 16) throw new Error(`need PCM16, got fmt=${fmt.audioFormat} bits=${fmt.bits}`);
    const n = Math.floor(dataLen / 2 / fmt.channels);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        let acc = 0;
        for (let c = 0; c < fmt.channels; c++) acc += dv.getInt16(dataOff + (i * fmt.channels + c) * 2, true);
        out[i] = acc / fmt.channels / 32768;
    }
    return { rate: fmt.rate, pcm: out };
}

/* ---------- 48 k → 16 k (windowed-sinc FIR + decimate 3) ----------
 * The 63-tap Hamming-windowed-sinc kernel (7.2 kHz cutoff, DC-normalized),
 * shared by resampleTo16k (whole-buffer — the bench) and makeStreamResampler16k
 * (live streaming — the worker) so both emit the SAME samples. The browser↔node
 * decode parity depends on this being ONE kernel. */
export function fir16kTaps() {
    const TAPS = 63, FC = 7200 / 48000, mid = (TAPS - 1) / 2;
    const h = new Float32Array(TAPS);
    let sum = 0;
    for (let i = 0; i < TAPS; i++) {
        const x = i - mid;
        const sinc = x === 0 ? 2 * FC : Math.sin(2 * Math.PI * FC * x) / (Math.PI * x);
        const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (TAPS - 1)); // Hamming
        h[i] = sinc * w; sum += sinc * w;
    }
    for (let i = 0; i < TAPS; i++) h[i] /= sum;
    return { h, TAPS, mid };
}

export function resampleTo16k(pcm, rate) {
    if (rate === 16000) return pcm;
    if (rate !== 48000) throw new Error(`unsupported rate ${rate} (record 48 kHz per TASMEE-PLAN §6.5)`);
    const { h, TAPS, mid } = fir16kTaps();
    const outN = Math.floor(pcm.length / 3);
    const out = new Float32Array(outN);
    for (let o = 0; o < outN; o++) {
        const center = o * 3;
        let acc = 0;
        for (let k = 0; k < TAPS; k++) {
            const idx = center + k - mid;
            if (idx >= 0 && idx < pcm.length) acc += pcm[idx] * h[k];
        }
        out[o] = acc;
    }
    return out;
}

/* Streaming 48 k→16 k for the live worker: push() raw 48 k blocks; pull() the
 * 16 k samples that NOW have full FIR context (byte-equal to resampleTo16k at
 * those indices); flush() the truncated-edge tail at end-of-session. Raw is
 * compacted behind the read frontier so memory stays bounded across a session. */
export function makeStreamResampler16k(rate) {
    if (rate !== 48000) throw new Error(`unsupported rate ${rate} (record 48 kHz)`);
    const { h, TAPS, mid } = fir16kTaps();
    const EMPTY = new Float32Array(0);
    let raw = new Float32Array(1 << 15), rawLen = 0, base = 0, outDone = 0;
    const ensure = (n) => {
        if (rawLen + n > raw.length) {
            const g = new Float32Array(Math.max(raw.length * 2, rawLen + n));
            g.set(raw.subarray(0, rawLen)); raw = g;
        }
    };
    const sampleAt = (o) => {                       // global 16k index o → FIR output (base-relative)
        const center = o * 3; let acc = 0;
        for (let k = 0; k < TAPS; k++) { const bi = center + k - mid - base; if (bi >= 0 && bi < rawLen) acc += raw[bi] * h[k]; }
        return acc;
    };
    return {
        push(chunk) { ensure(chunk.length); raw.set(chunk, rawLen); rawLen += chunk.length; },
        pull() {
            const end = base + rawLen;                          // global raw index one-past-end
            const maxO = Math.floor((end - 1 - mid) / 3);       // last o with full right context
            if (maxO < outDone) return EMPTY;
            const out = new Float32Array(maxO - outDone + 1);
            for (let o = outDone; o <= maxO; o++) out[o - outDone] = sampleAt(o);
            outDone = maxO + 1;
            const keep = Math.max(0, outDone * 3 - mid - base); // compact raw behind the frontier
            if (keep > 0) { raw.copyWithin(0, keep, rawLen); rawLen -= keep; base += keep; }
            return out;
        },
        flush() {                                               // truncated-edge tail (matches resampleTo16k)
            const total = Math.floor((base + rawLen) / 3);
            if (total <= outDone) return EMPTY;
            const out = new Float32Array(total - outDone);
            for (let o = outDone; o < total; o++) out[o - outDone] = sampleAt(o);
            outDone = total;
            return out;
        },
    };
}

/* ---------- mel frontend (NeMo preprocessor parameters) ----------
 * preemph 0.97 · STFT n_fft 512 / hop 160 / hann 400 center-reflect ·
 * |X|² · 80 slaney mels 0–8 kHz · log(x + 2⁻²⁴) · per-feature
 * mean/std normalization over valid frames. */
export const NFFT = 512, HOP = 160, WIN = 400, NMEL = 80;
export const FRAME_S = 0.08; // FastConformer 8× subsampling on 10 ms hops

function fftRadix2(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) { [re[i], re[j]] = [re[j], re[i]];[im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let cr = 1, ci = 0;
            for (let k = 0; k < len / 2; k++) {
                const ur = re[i + k], ui = im[i + k];
                const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
                const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
                re[i + k] = ur + vr; im[i + k] = ui + vi;
                re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
                const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
            }
        }
    }
}

const MEL_FILTERS = (() => { // slaney scale + slaney norm, fmin 0 fmax 8000
    const hzToMel = (f) => (f < 1000 ? f / (200 / 3) : 15 + (27 * Math.log(f / 1000)) / Math.log(6.4));
    const melToHz = (m) => (m < 15 ? m * (200 / 3) : 1000 * Math.exp((Math.log(6.4) * (m - 15)) / 27));
    const maxMel = hzToMel(8000);
    const pts = Array.from({ length: NMEL + 2 }, (_, i) => melToHz((i * maxMel) / (NMEL + 1)));
    const nBins = NFFT / 2 + 1;
    const filters = new Float32Array(NMEL * nBins);
    for (let m = 0; m < NMEL; m++) {
        const [lo, mid, hi] = [pts[m], pts[m + 1], pts[m + 2]];
        const norm = 2 / (hi - lo);
        for (let k = 0; k < nBins; k++) {
            const f = (k * 16000) / NFFT;
            let w = 0;
            if (f > lo && f < hi) w = f <= mid ? (f - lo) / (mid - lo) : (hi - f) / (hi - mid);
            filters[m * nBins + k] = w * norm;
        }
    }
    return filters;
})();

const HANN = (() => { // periodic hann(400), centered in the 512 frame
    const w = new Float32Array(NFFT);
    const off = (NFFT - WIN) >> 1;
    for (let i = 0; i < WIN; i++) w[off + i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / WIN));
    return w;
})();

/* MEL FRAME CACHE (2026-07-26). The incremental controller re-decodes a
 * sliding 3–8 s window every 0.3 s, so each second of audio has its mel
 * recomputed 10–25 times — 20% of total compute, measured, spent producing
 * numbers we already had. On the ship path (onnxruntime-web, RTF 0.9–1.2)
 * that 20% is the difference between keeping up and not.
 *
 * A frame is reusable only if it cannot see a slice boundary:
 *   · the FFT window [t*HOP, t*HOP+NFFT) must lie inside the real samples,
 *     clear of the NFFT/2 reflect padding at each end
 *   · it must not include padded[PADH], the one sample whose preemphasis
 *     differs (pre[0] has no predecessor)
 * which gives t ≥ 2 and t*HOP + NFFT ≤ PADH + n. Frames outside that band
 * are always recomputed.
 *
 * Slice starts are quantised to the chunk grid (0.3 s = 4800 samples = 30
 * hops exactly), so absolute frame indices line up across calls. Byte
 * equality against the uncached path is asserted in the fixtures — a cache
 * that returns ALMOST the same numbers would change decodes silently. */
export function createMelCache() {
    const cols = new Map();          // absolute frame index → Float32Array(NMEL)
    return {
        get: (i) => cols.get(i),
        set: (i, v) => cols.set(i, v),
        /* Drop everything before `i` — the controller never decodes backwards,
         * so older columns are dead weight for the rest of the session. */
        prune(i) { for (const k of cols.keys()) if (k < i) cols.delete(k); },
        get size() { return cols.size; },
    };
}

export function melFrontend(pcmSlice, cache = null, baseFrame = 0) {
    const n = pcmSlice.length;
    const pre = new Float32Array(n);
    pre[0] = pcmSlice[0];
    for (let i = 1; i < n; i++) pre[i] = pcmSlice[i] - 0.97 * pcmSlice[i - 1];
    const PADH = NFFT / 2;
    const padded = new Float32Array(n + 2 * PADH);
    padded.set(pre, PADH);
    for (let i = 0; i < PADH; i++) { // reflect
        padded[PADH - 1 - i] = pre[Math.min(i + 1, n - 1)];
        padded[PADH + n + i] = pre[Math.max(n - 2 - i, 0)];
    }
    const T = 1 + Math.floor(n / HOP);
    const nBins = NFFT / 2 + 1;
    const mel = new Float32Array(NMEL * T);
    const re = new Float32Array(NFFT), im = new Float32Array(NFFT);
    const power = new Float32Array(nBins);
    // frames that cannot see a slice edge (see createMelCache)
    const safeLo = 2, safeHi = Math.floor((n - PADH) / HOP);
    for (let t = 0; t < T; t++) {
        const base = t * HOP;
        const reusable = cache && t >= safeLo && t <= safeHi;
        if (reusable) {
            const hit = cache.get(baseFrame + t);
            // NB: the buffer is CHANNEL-major (mel[m*T + t]), so a column is
            // strided, not contiguous — a flat set() here would be silently
            // wrong in a way no shape check would catch.
            if (hit) { for (let m = 0; m < NMEL; m++) mel[m * T + t] = hit[m]; continue; }
        }
        for (let i = 0; i < NFFT; i++) { re[i] = (padded[base + i] || 0) * HANN[i]; im[i] = 0; }
        fftRadix2(re, im);
        for (let k = 0; k < nBins; k++) power[k] = re[k] * re[k] + im[k] * im[k];
        let col = null;
        if (reusable) col = new Float32Array(NMEL);
        for (let m = 0; m < NMEL; m++) {
            let acc = 0;
            const row = m * nBins;
            for (let k = 0; k < nBins; k++) acc += MEL_FILTERS[row + k] * power[k];
            const v = Math.log(acc + Math.pow(2, -24));
            mel[m * T + t] = v;
            if (col) col[m] = v;
        }
        if (col) cache.set(baseFrame + t, col);
    }
    for (let m = 0; m < NMEL; m++) { // per-feature normalization
        let mean = 0;
        for (let t = 0; t < T; t++) mean += mel[m * T + t];
        mean /= T;
        let varAcc = 0;
        for (let t = 0; t < T; t++) { const d = mel[m * T + t] - mean; varAcc += d * d; }
        const std = Math.sqrt(varAcc / Math.max(1, T - 1)) + 1e-5;
        for (let t = 0; t < T; t++) mel[m * T + t] = (mel[m * T + t] - mean) / std;
    }
    return { mel, T };
}

/* ---------- greedy CTC → words (SentencePiece ▁ boundaries) ---------- */
export function makeGreedyDecoder(vocabArr, blankId) {
    return function greedyWords(logprobs, T, V, windowStartS) {
        const words = [];
        const ids = new Int32Array(T);
        let prev = -1, cur = null;
        const pushCur = () => { if (cur && cur.text) words.push(cur); cur = null; };
        for (let t = 0; t < T; t++) {
            let best = 0, bestV = -Infinity;
            const row = t * V;
            for (let v = 0; v < V; v++) { const x = logprobs[row + v]; if (x > bestV) { bestV = x; best = v; } }
            ids[t] = best;
            if (best !== prev && best !== blankId) {
                const tok = vocabArr[best] ?? "";
                const timeS = windowStartS + t * FRAME_S;
                if (tok.startsWith("▁")) {
                    pushCur();
                    cur = { text: tok.slice(1), startS: timeS, endS: timeS };
                } else if (cur) { cur.text += tok; cur.endS = timeS; }
                else cur = { text: tok, startS: timeS, endS: timeS };
            }
            prev = best;
        }
        pushCur();
        return { words, frameIds: ids };
    };
}

/* ============================================================
 * Shared VAD (consolidated 2026-07-11 — was triplicated in bench /
 * harness worker / flags with drift risk). Behavior is the
 * HISTORICAL single-threshold policy, byte-equivalent to the
 * triplicated blocks: thresh = max(0.006, p10 × 4).
 *
 * ⚠ The historical policy is KNOWN-DEFICIENT on
 * compressed-dynamic-range audio (2026-07-11 diagnosis, TASMEE-PLAN
 * Gate 3 status): on golden 02 (whisper, p90/p10 = 3.9× vs 21×
 * clean) the threshold sits ABOVE median speech RMS — 90% of real
 * speech reads as silence (false pause-release → fragment commits,
 * skipped decodes, false hesitation ticks); on golden 06 (loud
 * noise floor) the closing words drop below it (final-word FAIL in
 * both modes). Two rejected single-split policies are documented in
 * the plan as dead ends (strict-cap-only broke the pinned smoke
 * window baseline; generous-snap/strict-speech split un-fixed 02).
 * The v2 candidate below (policy: "v2") is CONDITIONALLY APPROVED
 * for full measurement (2026-07-11) — NOT adopted; historical stays
 * the default until the 6-clip × 2-mode table + hesitation
 * regression suite rules it in, with any budget rebaselines
 * documented in the plan.
 * ============================================================ */
export function buildVad(pcm, { frame = 1600, floor = 0.006, policy = "historical" } = {}) {
    const rmsArr = [];
    for (let i = 0; i + frame <= pcm.length; i += frame) {
        let acc = 0;
        for (let j = i; j < i + frame; j++) acc += pcm[j] * pcm[j];
        rmsArr.push(Math.sqrt(acc / frame));
    }
    const sorted = [...rmsArr].sort((a, b) => a - b);
    const q = (p) => sorted[Math.floor(p * sorted.length)] || 0;

    if (policy === "v2") {
        /* VAD v2 CANDIDATE (conditionally approved 2026-07-11 — full
         * 6-clip × 2-mode measurement required before any adoption):
         * - speech question (isSpeech / onset): STRICT capped
         *   threshold min(p10×4, 0.75·p50) — real whisper speech must
         *   never read as silence (the 90%-misclassification finding).
         * - snap question (findSilenceBefore): nearest TRUE silence
         *   first; else the nearest NEAR-QUIETEST 2-slot dip (within
         *   15% of the range's global minimum) — relative and
         *   threshold-free, so it serves both the smoke (no true
         *   silence exists; quiet inter-word dips are the only
         *   boundaries) and whisper (the quietest dip is the best
         *   available boundary even if technically speech). */
        const speechThresh = Math.max(0.002, Math.min(q(0.1) * 4, q(0.5) * 0.75));
        const onsetS = (rmsArr.findIndex((r) => r > speechThresh) * frame) / 16000;
        const isSpeech = (fromS, toS) => {
            const a = Math.max(0, Math.floor(fromS * 10)), b = Math.min(rmsArr.length - 1, Math.floor(toS * 10));
            for (let i = a; i <= b; i++) if (rmsArr[i] > speechThresh) return true;
            return false;
        };
        const findSilenceBefore = (fromS, minS) => {
            const from = Math.min(Math.floor(fromS * 10), rmsArr.length - 2), min = Math.max(0, Math.floor(minS * 10));
            if (from < min) return null;
            for (let i = from; i >= min; i--) if (rmsArr[i] <= speechThresh && rmsArr[i + 1] <= speechThresh) return i / 10;
            let g = Infinity;
            for (let i = from; i >= min; i--) g = Math.min(g, rmsArr[i] + rmsArr[i + 1]);
            for (let i = from; i >= min; i--) if (rmsArr[i] + rmsArr[i + 1] <= g * 1.15 + 1e-12) return i / 10;
            return null;
        };
        return { rmsArr, thresh: speechThresh, onsetS, isSpeech, findSilenceBefore, policy };
    }

    const thresh = Math.max(floor, q(0.1) * 4);
    const onsetS = (rmsArr.findIndex((r) => r > thresh) * frame) / 16000;
    const isSpeech = (fromS, toS) => {
        const a = Math.max(0, Math.floor(fromS * 10)), b = Math.min(rmsArr.length - 1, Math.floor(toS * 10));
        for (let i = a; i <= b; i++) if (rmsArr[i] > thresh) return true;
        return false;
    };
    const findSilenceBefore = (fromS, minS) => {
        const from = Math.min(Math.floor(fromS * 10), rmsArr.length - 2), min = Math.floor(minS * 10);
        for (let i = from; i >= min; i--) if (rmsArr[i] <= thresh && rmsArr[i + 1] <= thresh) return i / 10;
        return null;
    };
    return { rmsArr, thresh, onsetS, isSpeech, findSilenceBefore, policy };
}
