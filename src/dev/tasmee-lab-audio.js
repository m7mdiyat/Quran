/* ============================================================
 * tasmee-lab-audio.js — DEV ONLY (tasmee-lab). Fetch a reciter's
 * surah MP3 + per-ayah timings, slice an ayah range, and produce the
 * SAME input shape the live mic path consumes: 48 kHz mono PCM,
 * delivered to the worker as a 16-bit WAV via its streamWav path (the
 * worker then runs the real makeStreamResampler16k → controller →
 * engine — no DSP is reimplemented here; this module only performs
 * source acquisition, which the mic does in live use).
 *
 * URL patterns + timings normalization mirror src/surahAudio.js
 * (AUDIO_BASE/TIMINGS_BASE at :21-22, audioUrl/timingsUrl at :83-87,
 * normalizeTimings at :95-111) — kept as small lockstep copies rather
 * than importing that module, which pulls the app's repeat/loop state.
 * ============================================================ */

const AUDIO_BASE = "https://storage.googleapis.com/m7mdiyat-tafsir-data/audio/surah";
const TIMINGS_BASE = "https://storage.googleapis.com/m7mdiyat-tafsir-data/timings";

export const audioUrl = (reciter, surah) => `${AUDIO_BASE}/${reciter}/${String(surah).padStart(3, "0")}.mp3`;
export const timingsUrl = (reciter, surah) => `${TIMINGS_BASE}/${reciter}/${surah}.json`;

/* Lockstep copy of surahAudio.js normalizeTimings — two upstream formats:
 *   qasim → { surah, ayahs: [{ayah,start,end}] } (ms)
 *   others → [endMs0, endMs1, …] (cumulative end-of-ayah ms)          */
function normalizeTimings(raw) {
    if (raw && Array.isArray(raw.ayahs)) {
        return raw.ayahs.map((a) => ({ ayah: Number(a.ayah), start: Number(a.start) || 0, end: Number(a.end) || 0 }));
    }
    if (Array.isArray(raw)) {
        return raw.map((end, i) => ({ ayah: i + 1, start: i === 0 ? 0 : Number(raw[i - 1]) || 0, end: Number(end) || 0 }));
    }
    throw new Error("tasmee-lab: unknown timings format");
}

async function fetchJson(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`fetch ${url} → HTTP ${r.status}`);
    return r.json();
}

/* Passage {reciter, surah, from, to} → { pcm48k: Float32Array, meta }.
 * Decode path: MP3 bytes → decodeAudioData (native rate) → slice the ayah
 * span → OfflineAudioContext render at 48 000 Hz mono (mirrors the mic's
 * 48 kHz hardware capture rate; the worker's own resampler takes it to
 * 16 kHz exactly as in live use). */
export async function fetchPassagePcm48k({ reciter, surah, from, to }) {
    const timings = normalizeTimings(await fetchJson(timingsUrl(reciter, surah)));
    const a = timings.find((t) => t.ayah === Number(from));
    const b = timings.find((t) => t.ayah === Number(to));
    if (!a || !b) throw new Error(`tasmee-lab: ayah ${from}/${to} not in timings (${timings.length} ayahs)`);
    const startMs = a.start, endMs = b.end;

    const mp3 = await fetch(audioUrl(reciter, surah));
    if (!mp3.ok) throw new Error(`fetch audio → HTTP ${mp3.status}`);
    const bytes = await mp3.arrayBuffer();

    const probe = new OfflineAudioContext(1, 8, 48000);
    const decoded = await probe.decodeAudioData(bytes);

    // Mono mixdown at the native rate, sliced to the passage.
    const rate = decoded.sampleRate;
    const s0 = Math.max(0, Math.floor((startMs / 1000) * rate));
    const s1 = Math.min(decoded.length, Math.ceil((endMs / 1000) * rate));
    const n = s1 - s0;
    const mono = new Float32Array(n);
    const chs = decoded.numberOfChannels;
    for (let c = 0; c < chs; c++) {
        const d = decoded.getChannelData(c);
        for (let i = 0; i < n; i++) mono[i] += d[s0 + i] / chs;
    }

    const pcm48k = await renderTo48kMono(mono, rate);

    return {
        pcm48k,
        meta: { reciter, surah: Number(surah), from: Number(from), to: Number(to), startMs, endMs, srcRate: rate, durS: pcm48k.length / 48000 },
    };
}

/* Render mono PCM at any rate to 48 kHz mono (browser-quality resample —
 * the same class of conversion the OS applies before the mic worklet sees
 * 48 kHz). Shared by the GCS passage path and local-file ingestion. */
export async function renderTo48kMono(mono, rate) {
    if (rate === 48000) return mono instanceof Float32Array ? mono : Float32Array.from(mono);
    const out48 = Math.ceil((mono.length / rate) * 48000);
    const oac = new OfflineAudioContext(1, out48, 48000);
    const buf = oac.createBuffer(1, mono.length, rate);
    buf.copyToChannel(mono, 0);
    const src = oac.createBufferSource();
    src.buffer = buf;
    src.connect(oac.destination);
    src.start(0);
    const rendered = await oac.startRendering();
    return rendered.getChannelData(0).slice();
}

/* PERMANENT lab capability: a local audio file (founder-mic WAV from
 * __tasmee._downloadRecording, or any m4a/mp3 Safari can decode) →
 * 48 kHz mono Float32, ready for the standard capture flow. */
export async function localFileToPcm48k(arrayBuffer) {
    const probe = new OfflineAudioContext(1, 8, 48000);
    const decoded = await probe.decodeAudioData(arrayBuffer);
    const n = decoded.length, chs = decoded.numberOfChannels;
    const mono = new Float32Array(n);
    for (let c = 0; c < chs; c++) {
        const d = decoded.getChannelData(c);
        for (let i = 0; i < n; i++) mono[i] += d[i] / chs;
    }
    const pcm48k = await renderTo48kMono(mono, decoded.sampleRate);
    return { pcm48k, srcRate: decoded.sampleRate, durS: pcm48k.length / 48000 };
}

/* Float32 PCM → 16-bit mono WAV ArrayBuffer (what worker streamWav's
 * readWavMono parses — the same s16 container the golden clips use). */
export function encodeWav16(pcm, rate) {
    const n = pcm.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE");
    w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, "data"); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
        const s = Math.max(-1, Math.min(1, pcm[i]));
        v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buf;
}
