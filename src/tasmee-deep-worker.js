/* ============================================================
 * tasmee-deep-worker.js — Layer 2 (التدقيق العميق) in the browser.
 *
 * Layer 1 tracks WORDS live, at 0.3 s. This is the second pass: it reads
 * the audio at the PHONEME level and reports which letter or which
 * haraka was wrong. It cannot be live — the model needs 8-second
 * windows to resolve harakat at all — so it runs after the session,
 * over the audio already recorded.
 *
 * WHY A SEPARATE WORKER FROM tasmee-worker.js. Different model (605M vs
 * 115M), different lifecycle (on demand vs the whole session), and a
 * different failure posture: if this one cannot load, tasmee must carry
 * on exactly as before. Keeping them apart makes that guarantee
 * structural rather than something to remember.
 *
 * THE MODEL IS 570 MB AND IS NOT PART OF THE APP. It downloads once, on
 * an explicit opt-in, into the Cache API — the same place the QCF4 fonts
 * and tafsir books live — and is reused offline forever after. Progress
 * is reported for every stage, because a silent 570 MB is indistinguish-
 * able from a hang.
 *
 * Pipeline per check:
 *   PCM 16 kHz → 8 s windows → SeamlessM4T features (tasmee-muaalem-
 *   frontend.js, verified against Python to 5.4e-05) → ONNX int8 →
 *   greedy CTC on the phoneme head → judge (tasmee-deep-rules.js,
 *   verified to produce Python's exact findings) → findings.
 * ============================================================ */

import * as ort from "onnxruntime-web/wasm";
import { parseFrontendBlob, createMuaalemFrontend } from "./tasmee-muaalem-frontend.js";
import { judge } from "./tasmee-deep-rules.js";

const CACHE = "tasmee-deep-v1";
const BASE = "/models/muaalem/";
const MODEL_URL = BASE + "muaalem-int8.onnx";
const PHONEMES_URL = "/tasmee-phonemes.json";

/* 8 s windows. MEASURED: 8 s reproduces whole-clip accuracy exactly
 * (harakat 4/6 plants at 0.40% false flags, letters 6/7 at 3.79%), while
 * 4 s is worse on both (3/6 and 5/7 at 5.39%). Non-overlapping, because
 * the features are normalised per window and overlapping windows would
 * emit the same phonemes twice. */
const WINDOW_S = 8;
const SR = 16000;

ort.env.wasm.numThreads = self.crossOriginIsolated
    ? Math.max(1, Math.min(4, (self.navigator && navigator.hardwareConcurrency) || 4))
    : 1;

let session = null, frontend = null, meta = null, phonemes = null;
let phonemeIdx = 0, blankId = 0, vocab = null;

const post = (m) => self.postMessage(m);
const progress = (stage, pct, detail) => post({ type: "progress", stage, pct, detail });

/* Same blob-URL trick the Layer 1 worker uses: Vite rewrites a static URL
 * to ORT's Emscripten glue, so we fetch it and hand ORT a runtime blob:
 * specifier its import analysis cannot see. */
async function setupOrtWasm(base = "/ort/") {
    const glue = await fetch(base + "ort-wasm-simd-threaded.mjs").then((r) => {
        if (!r.ok) throw new Error(`ort glue ${r.status}`);
        return r.text();
    });
    ort.env.wasm.wasmPaths = {
        mjs: URL.createObjectURL(new Blob([glue], { type: "text/javascript" })),
        wasm: base + "ort-wasm-simd-threaded.wasm",
    };
}

/* Fetch with byte-level progress and cache the result. A 570 MB download
 * with no feedback reads as a frozen app, so every chunk is reported. */
async function fetchCached(url, stage) {
    let cache = null;
    try { cache = await caches.open(CACHE); } catch { /* private mode: proceed uncached */ }
    if (cache) {
        const hit = await cache.match(url);
        if (hit) {
            progress(stage, 100, "cached");
            return hit.arrayBuffer();
        }
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} → ${res.status}`);
    const total = Number(res.headers.get("content-length")) || 0;
    if (!res.body) {                                  // no streaming: still works, no progress
        const buf = await res.arrayBuffer();
        if (cache) await cache.put(url, new Response(buf));
        return buf;
    }
    const reader = res.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        progress(stage, total ? Math.round((got / total) * 100) : 0,
            `${(got / 2 ** 20).toFixed(0)} MB${total ? ` / ${(total / 2 ** 20).toFixed(0)} MB` : ""}`);
    }
    const buf = new Uint8Array(got);
    let off = 0;
    for (const p of parts) { buf.set(p, off); off += p.length; }
    /* Cache AFTER assembling, and verify rather than trust: a quota refusal
     * resolves without throwing on some engines, and a half-written entry
     * would be worse than none (same lesson as the tafsir offline cache). */
    if (cache) {
        try {
            await cache.put(url, new Response(buf.slice(0)));
            if (!(await cache.match(url))) throw new Error("cache.put did not stick");
        } catch (e) { post({ type: "warn", message: `not cached (${e.message}) — will re-download next time` }); }
    }
    return buf.buffer;
}

async function init() {
    progress("runtime", 0, "starting");
    await setupOrtWasm();

    progress("frontend", 0, "audio frontend");
    const [fbuf, metaRes] = await Promise.all([
        fetchCached(BASE + "frontend.bin", "frontend"),
        fetch(BASE + "muaalem-meta.json").then((r) => r.json()),
    ]);
    frontend = createMuaalemFrontend(parseFrontendBlob(fbuf));
    meta = metaRes;
    phonemeIdx = meta.levels.indexOf("phonemes");
    vocab = meta.vocabs.phonemes;
    blankId = Math.max(0, vocab.indexOf("[PAD]"));

    progress("model", 0, "570 MB — once, then offline forever");
    const mbuf = await fetchCached(MODEL_URL, "model");

    progress("session", 0, "preparing the model");
    session = await ort.InferenceSession.create(new Uint8Array(mbuf), { executionProviders: ["wasm"] });
    progress("ready", 100, "ready");
}

async function loadPhonemes() {
    if (phonemes) return phonemes;
    progress("reference", 0, "phoneme reference");
    const r = await fetch(PHONEMES_URL);
    if (!r.ok) throw new Error(`phoneme reference ${r.status}`);
    phonemes = (await r.json()).verses;
    return phonemes;
}

/* Greedy CTC on the phoneme head: argmax per frame, collapse repeats,
 * drop blanks. Emits the token AND the model's confidence in it, which is
 * what rule 2 (confident disagreement only) reads. */
function decodeWindow(logits, T, C) {
    let text = "";
    const probs = [];
    let prev = -1;
    for (let t = 0; t < T; t++) {
        const o = t * C;
        let best = 0, bestV = logits[o];
        for (let c = 1; c < C; c++) if (logits[o + c] > bestV) { bestV = logits[o + c]; best = c; }
        if (best !== prev && best !== blankId) {
            const tok = vocab[best];
            if (tok && tok !== "[PAD]" && !String(tok).startsWith("<")) {
                // softmax at this frame, for this class only
                let sum = 0;
                for (let c = 0; c < C; c++) sum += Math.exp(logits[o + c] - bestV);
                text += tok;
                probs.push(1 / sum);
            }
        }
        prev = best;
    }
    return { text, probs };
}

async function runWindows(pcm) {
    const step = SR * WINDOW_S;
    const nWin = Math.max(1, Math.ceil(pcm.length / step));
    let text = "";
    const probs = [];
    /* WHEN each phoneme happened, so a finding can be played back. The model
     * returns no frame times, so position is the phoneme's rank within its own
     * window. With 8 s windows that lands within about a second — enough to
     * listen to, not enough to trust as a boundary, which is why the card
     * plays a padded span rather than an exact cut. */
    const times = [];
    for (let w = 0, i = 0; i < pcm.length; i += step, w++) {
        const seg = pcm.subarray(i, Math.min(i + step, pcm.length));
        if (seg.length < SR * 0.4) continue;                 // too short to say anything
        const { data, frames, dim } = frontend.extract(seg);
        if (!frames) continue;
        const out = await session.run({
            input_features: new ort.Tensor("float32", data, [1, frames, dim]),
        });
        const lg = out[session.outputNames[phonemeIdx]];
        const r = decodeWindow(lg.data, lg.dims[1], lg.dims[2]);
        const t0w = i / SR, dW = seg.length / SR, n = Math.max(1, r.text.length);
        for (let k = 0; k < r.text.length; k++) times.push(t0w + (k / n) * dW);
        text += r.text;
        probs.push(...r.probs);
        progress("checking", Math.round(((w + 1) / nWin) * 100), `${w + 1} / ${nWin}`);
    }
    return { text, probs, times };
}

/* Reference for a verse range, assembled from the shipped file. Groups and
 * their word counts travel together — the phonetizer merges words across
 * idgham, so the mapping cannot be recovered from the phonemes alone. */
function buildRef(verses, surah, from, to) {
    const groups = [], wordsPerGroup = [], locs = [];
    let unreliable = false;
    for (let a = from; a <= to; a++) {
        const row = verses[`${surah}:${a}`];
        if (!row) throw new Error(`no phoneme reference for ${surah}:${a}`);
        if (row.x) unreliable = true;         // alignment marked unsafe — do not name words
        const g = row.p.split(" ");
        let w = 1;
        g.forEach((gr, i) => {
            groups.push(gr);
            wordsPerGroup.push(row.w[i] ?? 1);
            locs.push({ vk: `${surah}:${a}`, pos: w, unreliable: !!row.x });
            w += row.w[i] ?? 1;
        });
    }
    return { groups, wordsPerGroup, locs, unreliable };
}

self.onmessage = async (e) => {
    const m = e.data || {};
    try {
        if (m.type === "init") {
            await init();
            post({ type: "ready", threads: ort.env.wasm.numThreads });
        } else if (m.type === "check") {
            if (!session) throw new Error("not initialised");
            const verses = await loadPhonemes();
            const { surah, from, to } = m.range;
            const ref = buildRef(verses, surah, from, to);
            const t0 = performance.now();
            const heard = await runWindows(m.pcm);
            const findings = judge(ref, heard, m.options || {});
            /* Attach an approximate audio position. judge() deliberately knows
             * nothing about time — it is a pure decision over sequences — so the
             * mapping is done here, from the phoneme index it reports. */
            for (const f of findings) {
                if (typeof f.heardIndex === "number" && heard.times[f.heardIndex] != null) {
                    f.atS = +heard.times[f.heardIndex].toFixed(2);
                }
            }
            post({
                type: "findings",
                findings: findings.map((f) => {
                    const l = ref.locs[f.group];
                    // inside a merged group the finding belongs to the
                    // wordOffset-th word, not the group's first
                    return { ...f, loc: l ? { ...l, pos: l.pos + (f.wordOffset || 0) } : null };
                }),
                stats: {
                    words: ref.wordsPerGroup.reduce((a, b) => a + b, 0),
                    groups: ref.groups.length,
                    phonemes: heard.text.length,
                    ms: Math.round(performance.now() - t0),
                    seconds: +(m.pcm.length / SR).toFixed(1),
                    unreliable: ref.unreliable,
                },
            });
        } else if (m.type === "cached") {
            let hit = false;
            try { hit = !!(await (await caches.open(CACHE)).match(MODEL_URL)); } catch { }
            post({ type: "cached", cached: hit });
        } else if (m.type === "evict") {
            try { await (await caches.open(CACHE)).delete(MODEL_URL); } catch { }
            post({ type: "evicted" });
        }
    } catch (err) {
        post({ type: "error", where: m.type, message: String((err && err.message) || err) });
    }
};
