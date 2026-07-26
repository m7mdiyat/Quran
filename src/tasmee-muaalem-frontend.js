/* ============================================================
 * tasmee-muaalem-frontend.js — SeamlessM4T log-mel features, in JS.
 *
 * Layer 2's model does not take audio. It takes a very specific
 * feature matrix, and a frontend that is subtly wrong does NOT fail
 * loudly — the model accepts the input and returns confident nonsense,
 * which for a tool that marks someone's Quran recitation is the worst
 * failure mode available. So this is a transcription of
 * transformers/audio_utils.py::spectrogram + SeamlessM4TFeatureExtractor,
 * verified numerically against Python (see tests/tasmee/frontend.test.mjs).
 *
 * THE CONSTANTS ARE NOT REIMPLEMENTED, THEY ARE SHIPPED. The povey
 * window (400 taps) and the Kaldi-style mel bank (257×80) are exported
 * verbatim from the Python extractor into public/models/muaalem/
 * frontend.bin — 82 KB. Rebuilding a mel bank from fmin/fmax/mel-scale
 * conventions is exactly where these ports go quietly wrong, and 82 KB
 * is a cheap way to make that class of bug impossible.
 *
 * Pipeline, in this order (order matters, see the notes inline):
 *   waveform × 2^15          Kaldi compliance — 16-bit signed scale
 *   frame 400 / hop 160, center=false
 *   remove DC offset          per frame, before preemphasis
 *   preemphasis 0.97          reads ORIGINAL samples — see below
 *   × povey window
 *   FFT 512 → 257 power bins  (|X|², i.e. power=2.0)
 *   × mel bank → 80
 *   log, floored at 1.1920929e-07
 *   normalise PER MEL BIN     zero-mean unit-variance, var ddof=1
 *   stack pairs of frames     stride 2 → 160 features per output frame
 * ============================================================ */

const FRAME = 400, HOP = 160, NFFT = 512, NBINS = NFFT / 2 + 1;   // 257
const PREEMPH = 0.97;
const MEL_FLOOR = 1.192092955078125e-07;
const WAV_SCALE = 32768;          // 2**15
const STRIDE = 2;
const NORM_EPS = 1e-7;

/* ---- radix-2 FFT, in place, on split real/imag arrays ---- */
function fftInPlace(re, im, n) {
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            let t = re[i]; re[i] = re[j]; re[j] = t;
            t = im[i]; im[i] = im[j]; im[j] = t;
        }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = -2 * Math.PI / len;
        const wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let cr = 1, ci = 0;
            for (let k = 0; k < len / 2; k++) {
                const ur = re[i + k], ui = im[i + k];
                const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
                const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
                re[i + k] = ur + vr; im[i + k] = ui + vi;
                re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
                const ncr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr; cr = ncr;
            }
        }
    }
}

/* Parse the exported constants blob: "MFE1" | winLen | melRows | melCols
 * | window f32[winLen] | melFilters f32[melRows*melCols] (row-major). */
export function parseFrontendBlob(buf) {
    const dv = new DataView(buf);
    const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    if (magic !== "MFE1") throw new Error(`frontend.bin: bad magic ${JSON.stringify(magic)}`);
    const winLen = dv.getUint32(4, true), melRows = dv.getUint32(8, true), melCols = dv.getUint32(12, true);
    if (winLen !== FRAME) throw new Error(`frontend.bin: window ${winLen} ≠ ${FRAME}`);
    if (melRows !== NBINS) throw new Error(`frontend.bin: mel rows ${melRows} ≠ ${NBINS}`);
    let off = 16;
    const window = new Float32Array(buf, off, winLen); off += winLen * 4;
    const mel = new Float32Array(buf, off, melRows * melCols);
    return { window, mel, nMel: melCols };
}

export function createMuaalemFrontend({ window, mel, nMel }) {
    if (!window || !mel) throw new Error("createMuaalemFrontend: constants required (see parseFrontendBlob)");

    /* pcm: Float32Array at 16 kHz. Returns { data, frames, dim } where
     * data is [frames × dim] row-major, dim = nMel × STRIDE. */
    function extract(pcm) {
        const nFrames = pcm.length >= FRAME ? Math.floor((pcm.length - FRAME) / HOP) + 1 : 0;
        if (nFrames <= 0) return { data: new Float32Array(0), frames: 0, dim: nMel * STRIDE };

        const logMel = new Float32Array(nFrames * nMel);
        const re = new Float64Array(NFFT), im = new Float64Array(NFFT);
        const buf = new Float64Array(FRAME);

        for (let f = 0; f < nFrames; f++) {
            const t0 = f * HOP;
            let sum = 0;
            for (let i = 0; i < FRAME; i++) { const v = pcm[t0 + i] * WAV_SCALE; buf[i] = v; sum += v; }
            // remove DC offset — per frame, and BEFORE preemphasis
            const mean = sum / FRAME;
            for (let i = 0; i < FRAME; i++) buf[i] -= mean;
            /* Preemphasis. NumPy evaluates `buf[1:] -= p * buf[:-1]` by
             * materialising the right-hand side first, so every tap reads the
             * ORIGINAL sample. Iterating forwards in JS would feed each
             * already-modified value into the next tap — a quiet corruption
             * that still produces plausible-looking features. Backwards is
             * equivalent to NumPy's temporary. */
            for (let i = FRAME - 1; i >= 1; i--) buf[i] -= PREEMPH * buf[i - 1];
            buf[0] *= 1 - PREEMPH;

            re.fill(0); im.fill(0);
            for (let i = 0; i < FRAME; i++) re[i] = buf[i] * window[i];
            fftInPlace(re, im, NFFT);

            // power spectrum (power = 2.0) → mel → log(max(x, floor))
            for (let m = 0; m < nMel; m++) {
                let acc = 0;
                for (let k = 0; k < NBINS; k++) {
                    const w = mel[k * nMel + m];
                    if (w !== 0) acc += (re[k] * re[k] + im[k] * im[k]) * w;
                }
                logMel[f * nMel + m] = Math.log(acc < MEL_FLOOR ? MEL_FLOOR : acc);
            }
        }

        /* Normalise PER MEL BIN across frames, with the SAMPLE variance
         * (ddof=1) the extractor uses. Population variance would be close
         * enough to look right and wrong enough to matter on short windows. */
        for (let m = 0; m < nMel; m++) {
            let s = 0;
            for (let f = 0; f < nFrames; f++) s += logMel[f * nMel + m];
            const mu = s / nFrames;
            let v = 0;
            for (let f = 0; f < nFrames; f++) { const d = logMel[f * nMel + m] - mu; v += d * d; }
            v = nFrames > 1 ? v / (nFrames - 1) : 0;
            const inv = 1 / Math.sqrt(v + NORM_EPS);
            for (let f = 0; f < nFrames; f++) logMel[f * nMel + m] = (logMel[f * nMel + m] - mu) * inv;
        }

        // stack consecutive pairs; a trailing odd frame is dropped, as upstream
        const outFrames = Math.floor(nFrames / STRIDE), dim = nMel * STRIDE;
        const data = new Float32Array(outFrames * dim);
        for (let o = 0; o < outFrames; o++) {
            for (let s = 0; s < STRIDE; s++) {
                const src = (o * STRIDE + s) * nMel;
                data.set(logMel.subarray(src, src + nMel), o * dim + s * nMel);
            }
        }
        return { data, frames: outFrames, dim };
    }

    return { extract, nMel, framesPerSecond: 16000 / HOP / STRIDE };
}

export const FRONTEND_SPEC = { FRAME, HOP, NFFT, NBINS, PREEMPH, MEL_FLOOR, WAV_SCALE, STRIDE, NORM_EPS };
