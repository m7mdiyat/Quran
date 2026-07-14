/* ============================================================
 * tasmee-report.js — the bench block builder, shared by
 * scripts/tasmee-bench.mjs and the dev-harness worker so the
 * printed block is BYTE-IDENTICAL across environments (ruled
 * 2026-07-10: the per-hesitation position + audio-gap lines double
 * as stability-stall telemetry for the WASM p50 profiling).
 * Truth scoring is bench-only and appended there.
 * ============================================================ */

function lev(a, b) {
    const m = a.length, n = b.length;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
        const cur = [i];
        for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = cur;
    }
    return prev[n];
}

/* Environment evidence lines (anomaly investigation, 2026-07-10):
 * "evidence lines, not vibes" — every block header states which ORT
 * backend + binary actually ran, the wasm flags, memory hints, and
 * the platform. Hosts supply raw values; THIS renderer owns the
 * format so bench and harness stay byte-identical. Unavailable
 * fields print n/a — never guessed. */
export function buildEnvLines({
    backend,        // "wasm (ort-web 1.27.0)" | "cpu (onnxruntime-node 1.27.0)"
    binary,         // exact artifact + how it was observed, e.g. "ort-wasm-simd-threaded.jsep.wasm (fetched)" | "native"
    flags,          // e.g. "numThreads=1 simd=n/a proxy=false" | "n/a"
    vad = "historical", // buildVad policy — a VAD change moves anchors/pauses/ticks, so it must be visible in evidence
    webgpu,         // "available" | "unavailable" | "n/a" — DATA ONLY (checkpoint ruling #3)
    mem,            // e.g. "deviceMemory=8GB jsHeapLimit=2144MB" | "n/a"
    platform,       // UA string or node/os line
    decode,         // e.g. "window (windowS=15 contextS=1.0 holdbackS=0.3)" — pinned params visible
}) {
    return [
        `env: backend ${backend} · binary ${binary}`,
        `env: flags ${flags} · vad ${vad} · webgpu ${webgpu} (data-only)`,
        `env: mem ${mem}`,
        `env: decode ${decode}`,
        `env: platform ${platform}`,
    ];
}

export function buildBenchBlock({
    clipName, modelName, modelSha, inputMode, rate, durS, onsetS,
    ref, committed, latencies, firstCommitAtS, computeMs, session, summary, norm, truthLoaded,
    feed = null, // {mode:'fast'|'realtime', maxBacklogS, endBacklogS} — ruling #3
    envLines = null, // buildEnvLines() output — evidence header
    computeSplit = null, // {melMs, ortMs} — C3 attribution: our DSP vs ORT kernels
}) {
    const L = [];
    const hyp = committed.map((w) => norm(w.text)).filter(Boolean);
    const refForms = ref.map((w) => w.form);
    const wer = lev(hyp, refForms) / refForms.length;
    const rtf = computeMs / 1000 / durS;
    const sortedLat = [...latencies].sort((a, b) => a - b);
    const p = (q) => sortedLat.length ? sortedLat[Math.min(sortedLat.length - 1, Math.floor(q * sortedLat.length))] : NaN;

    L.push(`\n== tasmee-bench: ${clipName} ==`);
    L.push(`model: ${modelName} (sha256 ${modelSha ? modelSha.slice(0, 12) + "…" : "UNRECORDED"} | input: ${inputMode})`);
    if (envLines) for (const l of envLines) L.push(l);
    L.push(`clip: ${durS.toFixed(1)}s @ ${rate} Hz → 16 kHz | speech onset ${onsetS.toFixed(2)}s | ref ${ref.length} words (${ref[0].vk} → ${ref[ref.length - 1].vk})`);
    L.push(`\ntranscript (${hyp.length} words):\n  ${committed.map((w) => w.text).join(" ")}`);
    L.push(`\nengine: correct ${summary.counts.correct}/${ref.length} · sub ${summary.counts.substituted} · skip ${summary.counts.skipped} · ins ${summary.counts.insertions} · rep ${summary.counts.repetitions} · hes ${summary.counts.hesitations} · completed ${summary.completed}`);
    L.push(`\nmetrics:`);
    L.push(`  WER                 ${(wer * 100).toFixed(1)}%`);
    L.push(`  RTF (compute/audio) ${rtf.toFixed(3)}`);
    if (computeSplit) {
        const tot = computeSplit.melMs + computeSplit.ortMs;
        L.push(`  compute split       mel ${(computeSplit.melMs / 1000).toFixed(1)}s (${tot ? Math.round(100 * computeSplit.melMs / tot) : 0}%) · ort ${(computeSplit.ortMs / 1000).toFixed(1)}s (${tot ? Math.round(100 * computeSplit.ortMs / tot) : 0}%)`);
    }
    L.push(`  stable-token latency p50 ${p(0.5).toFixed(2)}s · p95 ${p(0.95).toFixed(2)}s (ceiling 1.5s p50; aspiration <1s)`);
    L.push(`  first-event latency ${firstCommitAtS !== null ? (firstCommitAtS - onsetS).toFixed(2) + "s" : "n/a"} (limit 2.5s)`);

    const words = session.getWords();
    const lastWord = words[words.length - 1];
    const finalRevealed = lastWord && lastWord.verdict !== null;
    L.push(`  final-word check    ${finalRevealed ? "PASS" : "FAIL"} (${lastWord.vk}:${lastWord.pos} ${finalRevealed ? `revealed as ${lastWord.verdict}` : "NOT revealed"})`);
    L.push(`  spurious repetitions ${summary.counts.repetitions} on this clip${truthLoaded ? " (compare vs planted repeats in truth)" : " — none planted (report-only)"}`);
    if (feed) {
        L.push(`  live-feed backlog   max ${feed.maxBacklogS.toFixed(1)}s · end ${feed.endBacklogS.toFixed(1)}s (feed=${feed.mode}${feed.mode === "fast" ? ", virtual clock" : ""})`);
    }
    for (const h of session.getEvents().filter((e) => e.type === "hesitation")) {
        const before = committed.filter((w) => w.endS * 1000 <= h.t).pop();
        const after = committed.find((w) => w.startS * 1000 > h.t);
        const gap = before && after ? (after.startS - before.endS).toFixed(1) + "s" : "n/a";
        L.push(`  hesitation @ ${h.vk}:${h.pos} t=${(h.t / 1000).toFixed(1)}s — audio gap ${before ? before.text : "(start)"} → ${after ? after.text : "(end)"} ≈ ${gap}`);
    }
    return { text: L.join("\n"), wer, rtf, p50: p(0.5), p95: p(0.95) };
}
