/* ============================================================
 * tasmee-harness-worker.js — the Gate 3 browser worker.
 *
 * Runs the IDENTICAL pipeline bytes as scripts/tasmee-bench.mjs:
 *   /src/tasmee-pipeline.js   WAV / resample / mel / greedy
 *   /src/tasmee-stream.js     streaming controller + hesitation wiring
 *   /src/tasmee-report.js     byte-identical bench block
 * against onnxruntime-web WASM (numThreads 1 — the WebView
 * constraint). This block, produced in a real desktop browser and
 * in iPhone Safari, is the checkpoint-ruling measurement.
 * ============================================================ */

import { readWavMono, resampleTo16k, melFrontend, makeGreedyDecoder, NMEL, buildVad } from "/src/tasmee-pipeline.js";
import { createTasmeeSession } from "/src/tasmee-engine.js";
import { tasmeeNorm } from "/src/tasmee-norm.js";
import { createStreamController } from "/src/tasmee-stream.js";
import { buildBenchBlock, buildEnvLines } from "/src/tasmee-report.js";

/* ORT is imported INSIDE the run handler, not at module evaluation:
 * (a) pinned Gate 4/6 design rule (2026-07-10) — on iOS, heavy init
 * happens on/after the gesture path, never at page load (the autorun
 * finding: iOS Safari deferred/suspended a heavy module worker
 * spawned during page load); (b) the bundle is a run parameter now —
 * ?ort=wasm (default; ship-path wasm-only bundle → plain
 * simd-threaded binary, 13.5 MB) vs ?ort=all (the 2026-07-10
 * evidence-of-record bundle → jsep binary, 26.8 MB) for the
 * build-path A/B. onnxruntime-web 1.27.0 ships NO non-SIMD binary —
 * a silent non-SIMD fallback is impossible with this dist. */
const ORT_BUNDLES = { wasm: "/ort/ort.wasm.min.mjs", all: "/ort/ort.all.min.mjs" };

const CHUNK_S = 0.3, WINDOW_S = 15, TAIL_PAD_S = 1.2, CONTEXT_S = 1.0, HOLDBACK_S = 0.3, FRAME_S = 0.08;
/* Incremental-mode pinned parameters (mirror scripts/tasmee-bench.mjs). */
const INC_CONTEXT_S = 1.5, INC_EDGE_GUARD_S = 0.2;

/* Evidence lines for the block header (anomaly instrumentation).
 * The fetched-binary line reads worker-scope resource timing — the
 * EXACT artifact Safari/Chrome pulled, not an inference; falls back
 * honestly when the API is empty. */
function gatherEnv(ort, bundleKey, decodeMode, vadPolicy, ep = "wasm") {
    let fetched = null;
    try {
        fetched = (performance.getEntriesByType("resource") || [])
            .map((e) => e.name).filter((n) => n.endsWith(".wasm")).map((n) => n.split("/").pop()).join(",") || null;
    } catch { /* resource timing unavailable */ }
    const w = ort.env.wasm || {};
    let heap = "n/a";
    try { if (performance.memory) heap = `jsHeapLimit=${(performance.memory.jsHeapSizeLimit / 2 ** 20).toFixed(0)}MB used=${(performance.memory.usedJSHeapSize / 2 ** 20).toFixed(0)}MB`; } catch { }
    const dev = navigator.deviceMemory ? `deviceMemory=${navigator.deviceMemory}GB` : "deviceMemory=n/a";
    return buildEnvLines({
        backend: `${ep} (ort-web bundle=${bundleKey})`,
        binary: fetched ? `${fetched} (fetched)` : `${bundleKey === "all" ? "ort-wasm-simd-threaded.jsep.wasm" : "ort-wasm-simd-threaded.wasm"} (expected — resource timing empty)`,
        flags: `numThreads=${w.numThreads} simd=${w.simd ?? "n/a"} proxy=${w.proxy ?? "false"} xoi=${typeof crossOriginIsolated !== "undefined" ? crossOriginIsolated : "n/a"} sab=${typeof SharedArrayBuffer !== "undefined"}`,
        vad: vadPolicy,
        webgpu: typeof navigator !== "undefined" && "gpu" in navigator ? "available" : "unavailable",
        mem: `${dev} ${heap}`,
        platform: navigator.userAgent,
        decode: decodeMode === "incremental"
            ? `incremental (incContextS=${INC_CONTEXT_S} incEdgeGuardS=${INC_EDGE_GUARD_S} chunkS=${CHUNK_S} holdbackS=${HOLDBACK_S})`
            : `window (windowS=${WINDOW_S} contextS=${CONTEXT_S} chunkS=${CHUNK_S} holdbackS=${HOLDBACK_S})`,
    });
}

const status = (text) => postMessage({ type: "status", text });

/* β TIMELINE printer (2026-07-11): the per-window report the
 * session-length investigation is ruled on — "report a per-window
 * timeline, not just an aggregate; the SHAPE names the cause"
 * (flat-then-cliff vs linear climb vs sawtooth). Columns cover the
 * ruled suspects: ort (per-call session/arena growth if it climbs),
 * ctl = step wall − decode compute (our controller/glue if THAT climbs
 * while ort stays flat), pend/comm (unbounded controller state),
 * heapMB (Chrome only — Safari has no performance.memory), wasmGrow
 * (both engines, via the prototype hook). The retained-audio suspect
 * does not apply in file mode: the worker holds the whole clip by
 * construction. */
function betaTimelineBlock(timeline) {
    if (!timeline.length) return "";
    const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
    const L = [
        `== β timeline — ${timeline.length} decodes (one row per decode; VAD-skipped steps add no row) ==`,
        `  #  at(s)  span(s)          mel     ort     ctl  pend  comm  heapMB  wasmGrow`,
    ];
    for (let i = 0; i < timeline.length; i++) {
        const r = timeline[i];
        L.push([
            String(i + 1).padStart(3),
            (r.at ?? r.t1).toFixed(1).padStart(6),
            `${r.t0.toFixed(1)}-${r.t1.toFixed(1)}`.padEnd(13),
            r.mel.toFixed(0).padStart(6),
            r.ort.toFixed(0).padStart(7),
            (r.ctlMs ?? 0).toFixed(0).padStart(7),
            String(r.pend ?? "-").padStart(5),
            String(r.comm ?? "-").padStart(5),
            (r.heapMB == null ? "n/a" : r.heapMB.toFixed(0)).padStart(7),
            String(r.grows).padStart(9),
        ].join(" "));
    }
    const orts = timeline.map((r) => r.ort);
    const f = med(orts.slice(0, 10)), l = med(orts.slice(-10));
    const iMax = orts.indexOf(Math.max(...orts));
    const last = timeline[timeline.length - 1];
    L.push(`shape: ort median first-10 ${f.toFixed(0)}ms → last-10 ${l.toFixed(0)}ms (${(l / f).toFixed(2)}×) · max ${orts[iMax].toFixed(0)}ms at #${iMax + 1} · wasm grows ${last.grows}${last.wasmPeakMB ? ` (peak ${last.wasmPeakMB.toFixed(0)}MB)` : ""}`);
    /* β-incremental acceptance #2 (ruled 2026-07-11): steady-state
     * streaming RTF = flat per-decode cost / chunk. Printed two ways —
     * ort-only (the ruling's definition) and full step (mel+ort+ctl,
     * the honest per-chunk bill). Trustworthy only when the shape line
     * above is flat (~1.0×); under window mode's climb it just restates
     * the inflated tail. */
    const lTot = med(timeline.slice(-10).map((r) => r.mel + r.ort + (r.ctlMs ?? 0)));
    L.push(`steady-state (last-10 medians, per ${(CHUNK_S * 1000).toFixed(0)}ms chunk): ort ${l.toFixed(0)}ms → RTF ≈ ${(l / (CHUNK_S * 1000)).toFixed(2)} · full step ${lTot.toFixed(0)}ms → RTF ≈ ${(lTot / (CHUNK_S * 1000)).toFixed(2)} (meaningful only when shape ≈ flat)`);
    return "\n\n" + L.join("\n");
}

async function fetchWithProgress(url, label) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    const total = Number(res.headers.get("content-length") || 0);
    if (!total || !res.body) return await res.arrayBuffer();
    const reader = res.body.getReader();
    const buf = new Uint8Array(total);
    let got = 0;
    for (; ;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf.set(value, got);
        got += value.length;
        status(`${label}: ${(got / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} MB`);
    }
    return buf.buffer;
}

async function refFor({ range, page, wordsUrl }) {
    const DATASET = await (await fetch(wordsUrl)).json();
    const out = [];
    if (range) {
        const m = /^(\d+):(\d+)(?:-(\d+))?$/.exec(range);
        if (!m) throw new Error(`bad range ${range}`);
        const s = Number(m[1]), from = Number(m[2]), to = Number(m[3] || m[2]);
        for (let a = from; a <= to; a++) {
            const arr = DATASET.verses[`${s}:${a}`];
            if (!arr) throw new Error(`missing verse ${s}:${a}`);
            arr.forEach((f, i) => { if (f) out.push({ vk: `${s}:${a}`, pos: i + 1, form: f }); });
        }
        return out;
    }
    const d = await (await fetch(`/qcf4/pages/${String(page).padStart(3, "0")}.json`)).json();
    for (const line of d.lines || []) for (const w of line.words || []) {
        if (w.type !== "word" || String(w.text || "").startsWith("#")) continue;
        const form = DATASET.verses[w.verse_key]?.[w.position - 1];
        if (form) out.push({ vk: w.verse_key, pos: w.position, form });
    }
    return out;
}

onmessage = async (e) => {
    const msg = e.data;
    if (msg.type !== "run") return;
    try {
        const runT0 = performance.now();
        /* β INSTRUMENT (2026-07-11, session-length pathology): count wasm
         * memory.grow over the run. ORT's memory object is not reachable
         * through its API, so grow() is hooked at the PROTOTYPE before
         * the ORT import — every ort-web grow lands here, Safari and
         * Chrome alike (performance.memory in the timeline is
         * Chrome-only). The worker is fresh per run (main thread
         * terminates + respawns it), so the hook never stacks. */
        let wasmGrows = 0, wasmPeakMB = 0;
        const origGrow = WebAssembly.Memory.prototype.grow;
        WebAssembly.Memory.prototype.grow = function (delta) {
            const r = origGrow.call(this, delta);
            wasmGrows++;
            try { wasmPeakMB = Math.max(wasmPeakMB, this.buffer.byteLength / 2 ** 20); } catch { /* buffer edge case */ }
            return r;
        };
        /* ?ep=webgpu → GPU inference measurement (Finding 4a). The webgpu
         * EP exists only in the all/jsep bundle, so ep=webgpu forces it.
         * No silent fallback: session create is attempted with the
         * requested EP only — unavailability is an ERROR, not a quiet
         * wasm run masquerading as GPU numbers. */
        const ep = msg.ep === "webgpu" ? "webgpu" : "wasm";
        const bundleKey = ep === "webgpu" ? "all" : (ORT_BUNDLES[msg.ort] ? msg.ort : "wasm");
        status(`importing ort (${bundleKey})…`);
        const ort = await import(ORT_BUNDLES[bundleKey]);
        ort.env.wasm.wasmPaths = "/ort/";
        /* threads default 1 (the WebView-constraint posture every prior
         * measurement used). ?threads=N overrides for the C3.2
         * threaded-Safari test — meaningful ONLY when the server runs
         * --isolate (xoi=true, SAB present); without isolation ort-web
         * falls back to 1 regardless of the flag, and the env line's
         * xoi=/sab= fields tell the truth either way. */
        ort.env.wasm.numThreads = Number(msg.threads) >= 1 ? Number(msg.threads) : 1;
        const decodeMode = msg.decode === "incremental" ? "incremental" : "window";
        const vadPolicy = msg.vad === "v2" ? "v2" : msg.vad === "historical" ? "historical"
            : (decodeMode === "incremental" ? "v2" : "historical"); // v2 = incremental config of record (adopted 2026-07-11)

        const clipName = msg.clipUrl.split("/").pop();
        const pageFromName = /-p(\d{3})\.wav$/i.exec(clipName)?.[1];
        const ref = await refFor({
            range: msg.range || null,
            page: msg.page || pageFromName || null,
            wordsUrl: msg.wordsUrl,
        });

        status("loading vocab…");
        const vocabJson = await (await fetch(msg.vocabUrl)).json();
        const VOCAB = [];
        for (const [id, tok] of Object.entries(vocabJson)) VOCAB[Number(id)] = tok;
        const BLANK = VOCAB.indexOf("<blank>") >= 0 ? VOCAB.indexOf("<blank>") : VOCAB.length - 1;
        const GREEDY = makeGreedyDecoder(VOCAB, BLANK);
        let MODEL_SHA = null;
        try {
            const sums = await (await fetch(msg.checksumsUrl)).text();
            MODEL_SHA = (sums.split("\n").find((l) => l.includes(msg.modelUrl.split("/").pop())) || "").split(/\s+/)[0] || null;
        } catch { }

        const modelBuf = await fetchWithProgress(msg.modelUrl, "model");
        status("creating WASM session…");
        const t0 = performance.now();
        const sess = await ort.InferenceSession.create(modelBuf, { executionProviders: [ep] });
        const loadMs = performance.now() - t0;

        let RAW_INPUT = false;
        try {
            await sess.run({
                audio_signal: new ort.Tensor("float32", new Float32Array(1600), [1, 1600]),
                length: new ort.Tensor("int64", BigInt64Array.from([1600n]), [1]),
            });
            RAW_INPUT = true;
        } catch { RAW_INPUT = false; }

        status("loading clip…");
        const clipBuf = await fetchWithProgress(msg.clipUrl, "clip");
        const { rate, pcm: raw } = readWavMono(clipBuf);
        const pcmReal = resampleTo16k(raw, rate);
        const durS = pcmReal.length / 16000;
        const pcm = new Float32Array(pcmReal.length + Math.round(TAIL_PAD_S * 16000));
        pcm.set(pcmReal, 0);

        // VAD — shared implementation (src/tasmee-pipeline.js), same
        // bytes as the bench.
        const { onsetS, isSpeech, findSilenceBefore } = buildVad(pcm, { policy: vadPolicy });

        let computeMs = 0, melMs = 0, ortMs = 0; // C3 attribution split
        /* β timeline: one row per DECODE (VAD-gated steps that skip the
         * decode add no row) — the per-window record the session-length
         * investigation runs on. Collected always (a few numbers per
         * decode); printed by the streaming path only. */
        const timeline = [];
        async function decode(startS, endS) {
            const a = pcm.subarray(Math.floor(startS * 16000), Math.floor(endS * 16000));
            const t1 = performance.now();
            let feeds;
            if (RAW_INPUT) {
                feeds = {
                    audio_signal: new ort.Tensor("float32", a, [1, a.length]),
                    length: new ort.Tensor("int64", BigInt64Array.from([BigInt(a.length)]), [1]),
                };
            } else {
                const { mel, T } = melFrontend(a);
                feeds = {
                    audio_signal: new ort.Tensor("float32", mel, [1, NMEL, T]),
                    length: new ort.Tensor("int64", BigInt64Array.from([BigInt(T)]), [1]),
                };
            }
            const tMel = performance.now();
            const dMel = tMel - t1;
            const out = await sess.run(feeds);
            const dOrt = performance.now() - tMel;
            melMs += dMel;
            ortMs += dOrt;
            computeMs += performance.now() - t1;
            let heapMB = null;
            try { if (performance.memory) heapMB = performance.memory.usedJSHeapSize / 2 ** 20; } catch { /* Chrome-only */ }
            timeline.push({ t0: startS, t1: endS, mel: dMel, ort: dOrt, heapMB, grows: wasmGrows, wasmPeakMB });
            const lp = out[sess.outputNames[0]];
            return GREEDY(lp.data, lp.dims[1], lp.dims[2], startS).words;
        }

        /* ISOLATED-SPLIT MODE (C3.1 triangulation instrument, 2026-07-11):
         * the compute-split line is input #1; this mode is the INDEPENDENT
         * input #2 — time the mel/DSP path alone and the ORT inference
         * call alone on the SAME fixed buffer, N times each, plus a
         * combined-decode sanity set. Run in Safari AND Chrome; the three
         * numbers (split line, isolated-DSP, isolated-ORT) must tell the
         * same story per engine before C3 concludes anything. R9 requires
         * the three-gate condition in the plan, not one reading. */
        if (msg.mode === "isolate") {
            const CAP_MS = 180_000, N = 5, WIN_S = 6.0;
            const winStart = Math.min(onsetS, Math.max(0, durS - WIN_S));
            const a = pcm.subarray(Math.floor(winStart * 16000), Math.floor((winStart + WIN_S) * 16000));
            const capped = () => performance.now() - runT0 > CAP_MS;
            const med = (arr) => { const s2 = [...arr].sort((x, y) => x - y); return s2.length ? s2[Math.floor(s2.length / 2)] : NaN; };
            const dsp = [], ortP = [], comb = [];
            if (!RAW_INPUT) {
                for (let i = 0; i < N && !capped(); i++) {
                    const t1 = performance.now();
                    melFrontend(a);
                    dsp.push(performance.now() - t1);
                    status(`isolate: dsp ${i + 1}/${N} — ${dsp[i].toFixed(0)}ms`);
                }
            }
            {
                const { mel, T } = RAW_INPUT ? { mel: null, T: 0 } : melFrontend(a);
                const feeds = RAW_INPUT
                    ? { audio_signal: new ort.Tensor("float32", a, [1, a.length]), length: new ort.Tensor("int64", BigInt64Array.from([BigInt(a.length)]), [1]) }
                    : { audio_signal: new ort.Tensor("float32", mel, [1, NMEL, T]), length: new ort.Tensor("int64", BigInt64Array.from([BigInt(T)]), [1]) };
                const tw = performance.now();
                await sess.run(feeds); // warmup — JIT/shader compile lands here, excluded from the median
                var warmupMs = performance.now() - tw;
                status(`isolate: ort warmup — ${warmupMs.toFixed(0)}ms`);
                for (let i = 0; i < N && !capped(); i++) {
                    const t1 = performance.now();
                    await sess.run(feeds);
                    ortP.push(performance.now() - t1);
                    status(`isolate: ort ${i + 1}/${N} — ${ortP[i].toFixed(0)}ms`);
                }
            }
            for (let i = 0; i < 2 && !capped(); i++) {
                const t1 = performance.now();
                await decode(winStart, winStart + WIN_S);
                comb.push(performance.now() - t1);
                status(`isolate: combined ${i + 1}/2 — ${comb[i].toFixed(0)}ms`);
            }
            const L = [
                `\n== tasmee-isolate: ${clipName} ==`,
                `model: ${msg.modelUrl.split("/").pop()} (sha256 ${MODEL_SHA ? MODEL_SHA.slice(0, 12) + "…" : "UNRECORDED"} | input: ${RAW_INPUT ? "raw-waveform" : "mel (ours)"})`,
                ...gatherEnv(ort, bundleKey, decodeMode, vadPolicy, ep),
                `session load (cold)  ${loadMs.toFixed(0)}ms`,
                `fixed buffer         ${WIN_S.toFixed(1)}s from t=${winStart.toFixed(1)}s`,
                `isolated DSP (mel)   ${dsp.length ? `median ${med(dsp).toFixed(0)}ms × ${dsp.length} — [${dsp.map((p) => p.toFixed(0)).join(" / ")}]` : "n/a (raw-waveform model)"}`,
                `isolated ORT warmup ${typeof warmupMs === "number" ? warmupMs.toFixed(0) + "ms (excluded — JIT/shader compile)" : "n/a"}`,
                `isolated ORT (run)   ${ortP.length ? `median ${med(ortP).toFixed(0)}ms × ${ortP.length} — [${ortP.map((p) => p.toFixed(0)).join(" / ")}]` : "CAPPED before any pass"}`,
                `combined decode      ${comb.length ? `median ${med(comb).toFixed(0)}ms × ${comb.length}` : "capped"}`,
                `sanity               dsp+ort ${dsp.length && ortP.length ? (med(dsp) + med(ortP)).toFixed(0) + "ms" : "n/a"} vs combined ${comb.length ? med(comb).toFixed(0) + "ms" : "n/a"} (must roughly agree or the split is lying)`,
                `${performance.now() - runT0 > CAP_MS ? "(CAPPED at 180s — partial results)" : "(isolate mode: C3 triangulation — no streaming, no engine)"}`,
            ];
            postMessage({ type: "done", text: L.join("\n") });
            return;
        }

        /* MICRO-BENCH (phone re-test protocol, 2026-07-10; decode-mode
         * aware since 2026-07-11): N=5 single-pass decodes per window
         * size + session load, hard cap 3 minutes wall from message
         * receipt, progress visible, PARTIAL block on cap. No
         * streaming, no engine.
         * - decode=window: one set at 6.0 s (the original protocol).
         * - decode=incremental: two sets at the incremental sliding
         *   window's extremes — 2.1 s (incContextS + 2 chunks, the
         *   post-re-pin minimum) and 4.2 s (incMaxContextS + lag, the
         *   pre-re-pin maximum) — plus a PROJECTED per-chunk streaming
         *   RTF (median pass ms / 300 ms chunk) for each, bracketing
         *   what incremental streaming would cost on this device. */
        if (msg.mode === "micro") {
            const CAP_MS = 180_000, N = 5;
            const SETS = decodeMode === "incremental" ? [2.1, 4.2] : [6.0];
            const results = [];
            let capped = false;
            for (const WIN_S of SETS) {
                const winStart = Math.min(onsetS, Math.max(0, durS - WIN_S));
                const winEnd = Math.min(winStart + WIN_S, durS);
                const passes = [];
                for (let i = 0; i < N; i++) {
                    if (performance.now() - runT0 > CAP_MS) { capped = true; break; }
                    const t1 = performance.now();
                    await decode(winStart, winEnd);
                    passes.push(performance.now() - t1);
                    status(`micro[${WIN_S}s]: pass ${i + 1}/${N} — ${(passes[i] / 1000).toFixed(2)}s (${((performance.now() - runT0) / 1000).toFixed(0)}s / 180s cap)`);
                }
                results.push({ WIN_S, winStart, winEnd, passes });
                if (capped) break;
            }
            const L = [
                `\n== tasmee-micro: ${clipName} ==`,
                `model: ${msg.modelUrl.split("/").pop()} (sha256 ${MODEL_SHA ? MODEL_SHA.slice(0, 12) + "…" : "UNRECORDED"} | input: ${RAW_INPUT ? "raw-waveform" : "mel (ours)"})`,
                ...gatherEnv(ort, bundleKey, decodeMode, vadPolicy, ep),
                `session load (cold)  ${loadMs.toFixed(0)}ms`,
            ];
            for (const r of results) {
                const sorted = [...r.passes].sort((a, b) => a - b);
                const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN;
                const dur = r.winEnd - r.winStart;
                L.push(`single-pass window   ${dur.toFixed(1)}s from t=${r.winStart.toFixed(1)}s × ${r.passes.length}${capped ? ` (CAPPED at 180s — ${N} requested)` : ""}`);
                L.push(`passes (ms)          ${r.passes.map((p) => p.toFixed(0)).join(" / ") || "none completed"}`);
                L.push(`single-pass RTF      median ${(med / 1000 / dur).toFixed(3)} · min ${(sorted[0] / 1000 / dur).toFixed(3)} · max ${(sorted[sorted.length - 1] / 1000 / dur).toFixed(3)}`);
                if (decodeMode === "incremental" && r.passes.length) {
                    L.push(`projected streaming  RTF ≈ ${(med / (CHUNK_S * 1000)).toFixed(2)} at this window size (median pass / ${(CHUNK_S * 1000).toFixed(0)}ms chunk)`);
                }
            }
            L.push(`(micro mode: MEASURED single-pass RTF — replaces the ÷22.6 estimate; no streaming, no engine)`);
            postMessage({ type: "done", text: L.join("\n") });
            return;
        }

        const session = createTasmeeSession({ words: ref });
        // β: controller-growth counters — debug fires once per decode,
        // in the same step as the timeline row it annotates.
        let commTotal = 0, lastPendN = 0;
        const ctl = createStreamController({
            session, decode, isSpeech, findSilenceBefore, norm: tasmeeNorm,
            chunkS: CHUNK_S, windowS: WINDOW_S, contextS: CONTEXT_S, holdbackS: HOLDBACK_S, frameS: FRAME_S,
            mode: decodeMode, incContextS: INC_CONTEXT_S, incEdgeGuardS: INC_EDGE_GUARD_S,
            debug: (chunkEnd, commitN, pending) => { commTotal += commitN; lastPendN = pending.length; },
        });
        const FEED = msg.feed === "realtime" ? "realtime" : "fast";
        const loopEndS = durS + TAIL_PAD_S;
        let procFreeS = 0, maxBacklogS = 0, endBacklogS = 0;
        const wallT0 = performance.now();
        for (let endS = CHUNK_S; endS < loopEndS + CHUNK_S; endS += CHUNK_S) {
            const chunkEnd = Math.min(endS, loopEndS);
            if (FEED === "realtime") {
                const targetMs = chunkEnd * 1000 - (performance.now() - wallT0);
                if (targetMs > 0) await new Promise((r) => setTimeout(r, targetMs));
            }
            const t1 = performance.now();
            const rowsBefore = timeline.length;
            await ctl.step(chunkEnd);
            const stepS = (performance.now() - t1) / 1000;
            // β: annotate this step's decode row(s) — stream position,
            // controller state, and the step's controller-glue ms
            // (step wall minus decode compute → "ours vs ORT's" per row).
            for (let i = rowsBefore; i < timeline.length; i++) {
                const r = timeline[i];
                r.at = chunkEnd; r.pend = lastPendN; r.comm = commTotal;
            }
            if (timeline.length > rowsBefore) {
                const decMs = timeline.slice(rowsBefore).reduce((s, r) => s + r.mel + r.ort, 0);
                timeline[timeline.length - 1].ctlMs = Math.max(0, stepS * 1000 - decMs);
            }
            const startS = Math.max(chunkEnd, procFreeS);
            procFreeS = startS + stepS;
            endBacklogS = Math.max(0, procFreeS - chunkEnd);
            maxBacklogS = Math.max(maxBacklogS, endBacklogS);
            if (Math.round(endS * 10) % 30 === 0) {
                status(`streaming… ${chunkEnd.toFixed(1)} / ${loopEndS.toFixed(1)}s (wall ${(((performance.now() - wallT0)) / 1000).toFixed(0)}s, backlog ${endBacklogS.toFixed(1)}s)`);
            }
        }
        ctl.flush(loopEndS);
        const summary = session.stop(Math.round(loopEndS * 1000));
        const { committed, latencies, firstCommitAtS } = ctl.results();

        const block = buildBenchBlock({
            clipName,
            modelName: msg.modelUrl.split("/").pop(),
            modelSha: MODEL_SHA,
            inputMode: RAW_INPUT ? "raw-waveform" : "mel (ours)",
            rate, durS, onsetS, ref, committed, latencies, firstCommitAtS, computeMs,
            session, summary, norm: tasmeeNorm, truthLoaded: false,
            feed: { mode: FEED, maxBacklogS, endBacklogS },
            computeSplit: { melMs, ortMs },
            envLines: gatherEnv(ort, bundleKey, decodeMode, vadPolicy, ep),
        });
        const wallS = (performance.now() - wallT0) / 1000;
        postMessage({
            type: "done",
            text: block.text +
                betaTimelineBlock(timeline) +
                `\n\n[wasm] session load ${loadMs.toFixed(0)}ms · streaming wall ${wallS.toFixed(1)}s for ${durS.toFixed(1)}s audio (wall-RTF ${(wallS / durS).toFixed(2)})` +
                `\n(no truth file — harness mode: RTF/latency measurement; truth scoring runs in the node bench)`,
        });
    } catch (err) {
        postMessage({ type: "error", text: String(err?.stack || err) });
    }
};
