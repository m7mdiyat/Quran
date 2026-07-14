/* tasmee #11 prototype worker — the measurement half. Receives the
 * model bytes (zero-copy transfer), spins ORT with the requested
 * thread count, and prints the isolated-ORT protocol (warmup excluded,
 * 5 timed passes on a fixed 6.0 s buffer) — directly comparable to the
 * desktop four-cell table (Mac single-threaded 352–356 ms · 4-threaded
 * 124–125 ms, 2026-07-11). The WORKER scope's xoi/sab lines are the
 * ones that matter: ort-web threads live here. */

import { readWavMono, resampleTo16k, melFrontend, NMEL } from "./tasmee-pipeline.js";

const line = (text) => postMessage({ type: "line", text });

onmessage = async (e) => {
    try {
        const { threads, ep, modelBuf } = e.data;
        const useGpu = ep === "webgpu";
        line("worker scope: xoi=" + (typeof crossOriginIsolated !== "undefined" ? crossOriginIsolated : "undefined") +
            " · sab=" + (typeof SharedArrayBuffer !== "undefined") +
            " · cores=" + navigator.hardwareConcurrency);

        if (useGpu) {
            /* #11c leg — navigator.gpu printed PRESENT on iOS 18.7 (2026-07-11),
             * contradicting the public record (WKWebView WebGPU documented as
             * iOS-26-only). Adapter probe decides present-vs-functional; the EP
             * is forced with NO wasm fallback so a webgpu number can never
             * silently be a wasm number. */
            line("worker navigator.gpu: " + ("gpu" in navigator ? "present" : "ABSENT"));
            const adapter = "gpu" in navigator ? await navigator.gpu.requestAdapter() : null;
            if (!adapter) {
                line("WEBGPU: requestAdapter() → null — interface PRESENT-BUT-NONFUNCTIONAL in this WebView. Hard stop, no silent wasm fallback.");
                postMessage({ type: "done" });
                return;
            }
            const info = adapter.info || {};
            line("adapter: " + ([info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(" · ") || "present (no info exposed)"));
        }

        const ort = await import(useGpu ? "./ort.webgpu.min.mjs" : "./ort.wasm.min.mjs");
        ort.env.wasm.wasmPaths = "./";
        if (!useGpu) {
            ort.env.wasm.numThreads = threads;
            line("requested numThreads=" + threads + " (flag; execution truth = xoi/sab above + the scaling below)");
        }

        const t0 = performance.now();
        let sess;
        try {
            sess = await ort.InferenceSession.create(new Uint8Array(modelBuf), { executionProviders: useGpu ? ["webgpu"] : ["wasm"] });
        } catch (err) {
            if (useGpu) {
                line("WEBGPU session create FAILED — EP unusable on this WebKit: " + String(err && err.message || err));
                postMessage({ type: "done" });
                return;
            }
            throw err;
        }
        line("session load (cold): " + (performance.now() - t0).toFixed(0) + "ms · " +
            (useGpu ? "ep=webgpu" : "numThreads flag post-init=" + ort.env.wasm.numThreads));
        line("inputs: " + sess.inputNames.join(",") + " → " + sess.outputNames.join(","));

        // Fixed 6.0 s buffer from the bundled smoke clip → OUR mel — the
        // exact desktop isolate-mode protocol.
        const clip = await (await fetch("./smoke.wav")).arrayBuffer();
        const { rate, pcm: raw } = readWavMono(clip);
        const pcm = resampleTo16k(raw, rate);
        const a = pcm.subarray(0, 6 * 16000);
        const { mel, T } = melFrontend(a);
        const feeds = {
            audio_signal: new ort.Tensor("float32", mel, [1, NMEL, T]),
            length: new ort.Tensor("int64", BigInt64Array.from([BigInt(T)]), [1]),
        };

        const tw = performance.now();
        await sess.run(feeds);
        line("warmup: " + (performance.now() - tw).toFixed(0) + "ms (excluded — JIT/first-run)");

        const passes = [];
        for (let i = 0; i < 5; i++) {
            const t1 = performance.now();
            await sess.run(feeds);
            passes.push(performance.now() - t1);
            line("  pass " + (i + 1) + "/5: " + passes[i].toFixed(0) + "ms");
        }
        const med = [...passes].sort((x, y) => x - y)[2];
        line("");
        line("ISOLATED ORT (6.0s buffer, " + (useGpu ? "ep=webgpu" : "wasm threads=" + threads) + "): median " + med.toFixed(0) + "ms — [" + passes.map((p) => p.toFixed(0)).join(" / ") + "]");
        line("desktop reference (2026-07-11): 352–356ms single-threaded · 124–125ms 4-threaded (Mac Safari≈Chrome)");
        // Incremental spans run 2.1–4.2 s; per-decode cost scales ~linearly
        // with audio length (β timeline). Steady-state RTF = span-scaled
        // cost / 300 ms chunk.
        const lo = (med * (2.1 / 6) / 300).toFixed(2);
        const hi = (med * (4.2 / 6) / 300).toFixed(2);
        line("projected incremental steady-state RTF on THIS device: ≈ " + lo + " (2.1s spans) – " + hi + " (4.2s spans)  [must be comfortably < 1.0]");
        postMessage({ type: "done" });
    } catch (err) {
        line("WORKER RUN ERROR: " + String(err && err.stack || err));
        postMessage({ type: "done" });
    }
};
