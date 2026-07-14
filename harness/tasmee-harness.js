/* Main thread of the Gate 3 dev harness: UI + worker lifecycle.
 * All pipeline work happens in the module worker (WASM, numThreads 1
 * — the WebView constraint). Query params: ?clip= &range= | &page=
 * &autorun=1. File mode only (golden clips + smoke); live mic is a
 * Gate 4 integration concern. */

const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);
if (q.get("clip")) $("clip").value = q.get("clip");
if (q.get("range")) $("range").value = q.get("range");
if (q.get("page")) $("page").value = q.get("page");

let worker = null;

function run() {
    $("run").disabled = true;
    $("out").textContent = "—";
    $("status").textContent = "starting worker…";
    worker?.terminate();
    worker = new Worker("/harness/tasmee-harness-worker.js", { type: "module" });
    worker.onerror = (e) => {
        $("status").textContent = "WORKER ERROR: " + (e.message || "spawn/parse failure");
        $("run").disabled = false;
    };
    worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === "status") $("status").textContent = m.text;
        else if (m.type === "done") {
            $("status").textContent = `done — ua: ${navigator.userAgent}`;
            $("out").textContent = m.text + "\n\n(browser: " + navigator.userAgent + ")";
            $("run").disabled = false;
            document.title = "tasmee harness — DONE";
        } else if (m.type === "error") {
            $("status").textContent = "ERROR: " + m.text;
            $("out").textContent = "ERROR: " + m.text;
            $("run").disabled = false;
            document.title = "tasmee harness — ERROR";
        }
    };
    worker.postMessage({
        type: "run",
        clipUrl: $("clip").value.trim(),
        range: $("range").value.trim() || null,
        page: $("page").value.trim() || null,
        feed: q.get("feed") === "realtime" ? "realtime" : "fast",
        /* anomaly-investigation params (2026-07-10/11):
         * ?ort=wasm|all — bundle A/B (default wasm, the ship path)
         * ?decode=window|incremental — dual-mode redesign (micro honors it)
         * ?mode=micro — phone micro-bench (≤3 min, no streaming)
         * ?mode=isolate — C3 triangulation: isolated DSP vs isolated ORT
         * ?threads=N — ort-web threadpool size (needs server --isolate)
         * ?ep=webgpu — GPU inference measurement (Finding 4a)
         * ?vad=v2|historical — override; default is per decode mode (incremental→v2 ADOPTED 2026-07-11, window→historical) */
        ort: q.get("ort") || "wasm",
        decode: q.get("decode") || "window",
        mode: q.get("mode") || null,
        threads: q.get("threads") || null, // C3.2: meaningful only when the server runs --isolate
        ep: q.get("ep") || "wasm", // Finding 4a: ?ep=webgpu (forces the all/jsep bundle; hard error if unavailable)
        vad: q.get("vad") || null, // per-mode default in the worker (incremental→v2)
        modelUrl: "/models/fastconformer_ar_ctc_q8pc-head.onnx", // record artifact since 2026-07-11 (old q8 stays served as fallback)
        vocabUrl: "/models/vocab.json",
        checksumsUrl: "/models/checksums.txt",
        wordsUrl: "/data/tasmee-words.json",
    });
}

/* Operator protocol for the phone micro-bench — printed ON the page
 * so the operator (Mohammed) doesn't need the plan open. */
if (q.get("mode") === "isolate") {
    const p = document.createElement("div");
    p.style.cssText = "border:1px solid #1e5c7a;background:#101d24;color:#77c8e8;border-radius:8px;padding:10px 12px;margin-bottom:10px;";
    p.textContent = "C3 ISOLATE MODE: isolated DSP ×5 + isolated ORT ×5 + combined ×2 on a fixed 6s buffer · cap 3 min · run the SAME URL in Safari AND Chrome; add &threads=4 only when the server was started with --isolate (check xoi=true in the env line)";
    document.body.insertBefore(p, document.getElementById("status"));
}
if (q.get("mode") === "micro") {
    const p = document.createElement("div");
    p.id = "protocol";
    p.style.cssText = "border:1px solid #7a5c1e;background:#241d10;color:#e8c877;border-radius:8px;padding:10px 12px;margin-bottom:10px;";
    p.textContent = "MICRO-BENCH PROTOCOL: phone COOL (not fresh off a charge/case) · Low Power Mode OFF · screen stays ON · N=5 single-pass decodes + session load · hard cap 3 min (partial results print on cap)";
    document.body.insertBefore(p, document.getElementById("status"));
}

$("run").addEventListener("click", run);
/* iPhone Safari smoke finding (2026-07-10): autorun=1 did not start
 * the run on iOS — even though the pipeline uses NO gesture-gated
 * API by construction (no AudioContext/decodeAudioData/getUserMedia;
 * WAV parsed manually, fetch+Worker+WASM are gesture-free). The
 * suspected mechanism is iOS Safari deferring/suspending a heavy
 * module-worker spawned at script-evaluation time during page load —
 * not a user-activation rule we can name. Per the Gate 3 ruling the
 * harness renders an ARMED state on iOS instead of silently not
 * running; the real app is unaffected (session start is the mic tap,
 * and getUserMedia is gesture-gated on iOS anyway). */
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
if (q.get("autorun") === "1") {
    if (isIOS) {
        $("run").textContent = "tap to start (armed)";
        $("status").textContent = "autorun armed — iOS needs a tap (see Gate 3 note)";
    } else {
        addEventListener("load", () => requestAnimationFrame(run));
    }
}
