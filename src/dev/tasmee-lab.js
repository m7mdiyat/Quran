/* ============================================================
 * tasmee-lab.js — DEV ONLY test harness (dev/tasmee-lab.html; never a
 * build input, never shipped). Replays saved reciter audio through the
 * EXACT live tasmee pipeline and grades the result.
 *
 * Phase 1 CAPTURE (ORT, faithful): passage → GCS MP3 + ayah timings →
 * 48 kHz mono WAV → the REAL src/tasmee-worker.js via its streamWav
 * path (real resampler, VAD v2, incremental controller, engine, real
 * stability/commit policy — the live pipeline minus the microphone),
 * with the worker's dev capture flag on: per-frame logprobs into an
 * unbounded sink (absolute-frame keyed, latest-decode-wins).
 *
 * Phase 2 SCORE (no ORT, deterministic): tasmee-lab-score.js replays
 * the frozen logprobs through the same controller+engine and grades
 * against the CORRECT-pile expectation (zero flags, all revealed).
 * ============================================================ */

import { fetchPassagePcm48k, encodeWav16, localFileToPcm48k } from "./tasmee-lab-audio.js";
import { putClip, getClip, listClips, deleteClip, downloadClipJson } from "./tasmee-lab-db.js";
import { replayClip, scoreCorrectPile, validateWindows } from "./tasmee-lab-score.js";
import { scoreLiveClip } from "./tasmee-lab-replay.js";

const VOCAB_URL = "/models/tasmee/vocab.json";

/* ---------- TEMPORARY SMOKE SET — replace with a curated corpus. ----------
 * Short passages dense in cross-word tajweed fusion (idghām/ikhfā/tanwīn
 * contact), mid-surah starts so no basmala/isti'ādha enters the slice:
 *  99:6-8  يومئذٍ يصدر · أشتاتًا لِّيُروا · مَن يعمل ×2 · خيرًا/شرًّا يره (idghām bi-ghunnah + bilā)
 *  97:3-5  ربِّهِم مِّن (idghām mīm) · مِّن كلِّ (ikhfā) · أمرٍ سلامٌ
 * 105:3-5  ةٍ مِّن + عصفٍ مَّأكول (tanwīn idghām م) · ترميهِم بِـ (ikhfā shafawī)
 * NOTE: no cross-word iqlāb (نْ/tanwīn + ب) instance fits a short slice
 * here — the curated list must add one (e.g. سميعٌ بصير / مِنۢ بعد). */
export const SMOKE_PASSAGES = [
    { reciter: "qasim", surah: 99, from: 6, to: 8 },
    { reciter: "qasim", surah: 97, from: 3, to: 5 },
    { reciter: "ayoub", surah: 105, from: 3, to: 5 },
];

/* ---------- reference words for a passage (same dataset the live UI uses:
 * tasmee-ui.js buildRef reads DATASET.verses[vk][pos-1]) ---------- */
let _wordsP = null;
const loadWords = () => (_wordsP ||= fetch("/tasmee-words.json").then((r) => r.json()));

export async function buildPassageRef(surah, from, to) {
    const ds = await loadWords();
    const ref = [];
    for (let a = Number(from); a <= Number(to); a++) {
        const vk = `${surah}:${a}`;
        const arr = ds?.verses?.[vk];
        if (!arr) throw new Error(`tasmee-lab: no dataset entry for ${vk}`);
        arr.forEach((form, i) => { if (form) ref.push({ vk, pos: i + 1, form }); });
    }
    return ref;
}

/* ---------- logging / UI ---------- */
const logEl = document.getElementById("log");
function log(msg, cls = "") {
    console.log("[lab]", msg);
    if (!logEl) return;
    const s = document.createElement("span");
    if (cls) s.className = cls;
    s.textContent = msg + "\n";
    logEl.appendChild(s);
    logEl.scrollTop = logEl.scrollHeight;
}

/* ---------- Phase 1: capture ---------- */
function waitMsg(worker, type, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
        const to = setTimeout(() => { cleanup(); reject(new Error(`timeout waiting for "${type}"`)); }, timeoutMs);
        const h = (e) => {
            const m = e.data || {};
            if (m.type === type) { cleanup(); resolve(m); }
            else if (m.type === "error") { cleanup(); reject(new Error(`${m.where}: ${m.message}`)); }
        };
        const he = (e) => { cleanup(); reject(new Error(`worker error: ${e.message || e}`)); };
        const cleanup = () => { clearTimeout(to); worker.removeEventListener("message", h); worker.removeEventListener("error", he); };
        worker.addEventListener("message", h);
        worker.addEventListener("error", he);
    });
}

/* ONE reused worker (same lifetime pattern as tasmee-ui.js `_worker`) —
 * WebKit rejects a SECOND module-worker spawn of the same Vite-served
 * script with an access-control error, so spawn once, re-init per
 * capture (the worker's init path fully rebuilds model + live state). */
let _labWorker = null;
function labWorker() {
    if (!_labWorker) _labWorker = new Worker(new URL("../tasmee-worker.js", import.meta.url), { type: "module" });
    return _labWorker;
}

export async function capture(passage, modelUrl) {
    const { reciter, surah, from, to } = passage;
    const id = `${reciter}-${surah}-${from}-${to}-${/q8pc/.test(modelUrl) ? "q8pc-head" : "q8"}`;
    log(`── capture ${id}`);

    const ref = await buildPassageRef(surah, from, to);
    log(`ref: ${ref.length} words (${surah}:${from} → ${surah}:${to})`);

    const { pcm48k, meta } = await fetchPassagePcm48k(passage);
    log(`audio: ${meta.durS.toFixed(1)}s @48k (src ${meta.srcRate} Hz, ${meta.startMs}–${meta.endMs} ms)`);
    return captureRun({ id, passage, modelUrl, pcm48k, ref, label: "correct" });
}

/* PERMANENT: ingest a LOCAL audio file (founder-mic WAV etc.) as a lab clip.
 * `info` = { name, surah, from, to, label } — name becomes the clip-id stem;
 * label records whether the recitation was correct or contains planted
 * mistakes. Same worker capture flow as GCS passages. */
export async function captureFromLocalWav(arrayBuffer, info, modelUrl = "/models/tasmee/fastconformer_ar_ctc_q8pc-head.onnx") {
    const { name, surah, from, to, label = "correct" } = info;
    const id = `${name}-${surah}-${from}-${to}-${/q8pc/.test(modelUrl) ? "q8pc-head" : "q8"}`;
    log(`── capture(local) ${id} [label: ${label}]`);
    const ref = await buildPassageRef(surah, from, to);
    log(`ref: ${ref.length} words (${surah}:${from} → ${surah}:${to})`);
    const { pcm48k, srcRate, durS } = await localFileToPcm48k(arrayBuffer);
    log(`audio: ${durS.toFixed(1)}s @48k (local file, src ${srcRate} Hz)`);
    return captureRun({ id, passage: { reciter: name, surah, from, to, local: true }, modelUrl, pcm48k, ref, label });
}

/* Shared worker capture flow (GCS passage + local-file paths). */
async function captureRun({ id, passage, modelUrl, pcm48k, ref, label }) {
    const wav = encodeWav16(pcm48k, 48000);

    // The REAL live worker — same construction as tasmee-ui.js:369, reused
    // across captures (see labWorker note).
    const worker = labWorker();
    const events = [];
    const onEv = (e) => {
        const m = e.data || {};
        if (m.type === "event") events.push(m.event);
    };
    worker.addEventListener("message", onEv);
    try {

        const readyP = waitMsg(worker, "ready");
        worker.postMessage({
            type: "init", modelUrl, vocabUrl: VOCAB_URL,
            ref: ref.map((r) => ({ vk: r.vk, pos: r.pos, form: r.form })),
            dev: { capture: true },                        // ← dev-only worker seam
        });
        const ready = await readyP;
        log(`worker ready: threads ${ready.numThreads} (xoi ${ready.crossOriginIsolated}), load ${ready.loadMs}ms`);

        const stoppedP = waitMsg(worker, "stopped");
        worker.postMessage({ type: "streamWav", buf: wav }, [wav]);
        const stopped = await stoppedP;
        log(`streamed: ${stopped.committed} committed words in ${stopped.ms}ms — "${(stopped.committedText || "").slice(0, 120)}…"`);

        const exportedP = waitMsg(worker, "devExported");
        worker.postMessage({ type: "devExport" });
        const ex = await exportedP;
        if (ex.error) throw new Error(ex.error);

        // Overwrite proof: setCalls ≫ held frames (latest-decode-wins).
        log(`frames: held ${ex.indices.length} · set() calls ${ex.setCalls} ` +
            `(overlap factor ×${(ex.setCalls / ex.indices.length).toFixed(1)} — overwritten, not duplicated)`,
            ex.setCalls > ex.indices.length ? "good" : "bad");
        const badWin = validateWindows(ex.windows);
        log(`window log: ${ex.windows.length} decodes; frameCountFor mismatches: ${badWin.length}`, badWin.length ? "bad" : "good");

        const clip = {
            id, label, passage: { ...passage }, modelUrl, capturedAt: new Date().toISOString(),
            ref, V: ex.V, blank: ex.blank, setCalls: ex.setCalls,
            indices: ex.indices, data: ex.data, windows: ex.windows,
            pcm16k: ex.pcm16k, pumpEndLen: ex.pumpEndLen,
            liveEvents: events, committedFull: ex.committedFull || stopped.committedFull, summary: stopped.summary,
        };
        await putClip(clip);
        log(`saved to IndexedDB: ${id} (${((ex.data.byteLength + ex.pcm16k.byteLength) / 1048576).toFixed(1)} MB)`);
        await renderClips();
        return clip;
    } finally {
        worker.removeEventListener("message", onEv);
    }
}

/* ---------- Phase 2: score ---------- */
async function loadVocab() {
    const vocabJson = await fetch(VOCAB_URL).then((r) => r.json());
    const vocabArr = [];
    for (const [id, tok] of Object.entries(vocabJson)) vocabArr[Number(id)] = tok;
    const blank = vocabArr.indexOf("<blank>") >= 0 ? vocabArr.indexOf("<blank>") : vocabArr.length - 1;
    return { vocabArr, blank };
}

function framesMapOf(clip) {
    const map = new Map();
    const { indices, data, V } = clip;
    for (let i = 0; i < indices.length; i++) map.set(indices[i], data.subarray(i * V, (i + 1) * V));
    return map;
}

/* PERMANENT: LIVE-FAITHFUL scoring (the verdict surface — real ORT
 * re-decode through the real controller+engine; see tasmee-lab-replay.js).
 * `overrides` flips controller options, e.g. {amend:null} for baselines. */
export async function scoreLive(id, overrides = {}) {
    log(`── scoreLive ${id} (live-faithful surface)`);
    const { rep, score: s } = await scoreLiveClip(id, { controllerOverrides: overrides });
    log(`reproduction vs capture: ${rep.reproduction ? "IDENTICAL" : "differs (expected under overrides)"}`);
    log(`verdicts: skip[${s.false_skip.join(",") || "—"}] wrong[${s.false_wrong.join(",") || "—"}] ` +
        `unrev[${s.unrevealed.join(",") || "—"}] · ins ${s.insertions} · amends ${s.amends} ` +
        `· exact-heard ${s.exactHeard.exact}/${s.exactHeard.correct}`,
        s.flags === 0 ? "good" : "warn");
    return { rep, score: s };
}

/* Frozen-logprob replay — LOGPROB-INSPECTION ONLY, never a verdict
 * surface (latest-decode-wins rows manufacture phantom flags). */
export async function score(id, { detection = null, runs = 2 } = {}) {
    const clip = await getClip(id);
    if (!clip) throw new Error(`no clip ${id}`);
    const { vocabArr } = await loadVocab();
    const rc = { ...clip, framesMap: framesMapOf(clip), vocabArr };

    log(`── score ${id} (${clip.ref.length} ref words, ${clip.indices.length} frames)`);
    const results = [];
    for (let i = 0; i < runs; i++) results.push(await replayClip(rc, { detection }));
    const deterministic = results.every((r) =>
        JSON.stringify({ e: r.events, w: r.words }) === JSON.stringify({ e: results[0].events, w: results[0].words }));
    const r0 = results[0];
    const s = scoreCorrectPile(r0);

    log(`replay: ${r0.committed.length} committed · missing frames ${r0.missingFrames} · deterministic ×${runs}: ${deterministic}`,
        deterministic ? "good" : "bad");
    log(`score: false_skip ${s.totals.false_skip} · false_wrong ${s.totals.false_wrong} · unrevealed ${s.totals.unrevealed} ` +
        `· insertions ${s.totals.insertions} · repetitions ${s.totals.repetitions} → ${s.clean ? "CLEAN" : "DEVIATIONS"}`,
        s.clean ? "good" : "warn");
    for (const k of ["false_skip", "false_wrong", "unrevealed"]) {
        if (s.locations[k].length) log(`  ${k} @ ${s.locations[k].join(", ")}`, "bad");
    }

    // Phase1-vs-Phase2 fidelity note (honest): latest-wins frozen rows are
    // not byte-identical to each live window's own decode, so marginal
    // words can differ. Report the verdict-level diff.
    if (clip.liveEvents?.length) {
        const liveWords = clip.liveEvents.filter((e) => e.type === "reveal").map((e) => `${e.vk}:${e.pos}:${e.verdict}`);
        const repWords = r0.events.filter((e) => e.type === "reveal").map((e) => `${e.vk}:${e.pos}:${e.verdict}`);
        const same = JSON.stringify(liveWords) === JSON.stringify(repWords);
        log(`phase1↔phase2 reveal-sequence identical: ${same}${same ? "" : ` (live ${liveWords.length} vs replay ${repWords.length} reveals — latest-wins approximation)`}`,
            same ? "good" : "warn");
    }
    return { score: s, deterministic, replay: r0 };
}

/* ---------- corpus aggregate ---------- */
export async function scoreAll({ detection = null } = {}) {
    const clips = await listClips();
    const agg = { clips: 0, refWords: 0, false_skip: [], false_wrong: [], unrevealed: [], insertions: 0 };
    for (const c of clips) {
        const { score: s } = await score(c.id, { detection });
        agg.clips++;
        agg.refWords += s.totals.refWords;
        agg.insertions += s.totals.insertions;
        for (const k of ["false_skip", "false_wrong", "unrevealed"]) agg[k].push(...s.locations[k].map((l) => `${c.id} ${l}`));
    }
    log(`══ CORPUS (${agg.clips} clips, ${agg.refWords} ref words): ` +
        `false_skip ${agg.false_skip.length} · false_wrong ${agg.false_wrong.length} · unrevealed ${agg.unrevealed.length} · insertions ${agg.insertions}`);
    for (const k of ["false_skip", "false_wrong", "unrevealed"]) {
        for (const loc of agg[k]) log(`  ${k}: ${loc}`, "bad");
    }
    return agg;
}

export async function runSmoke() {
    const modelUrl = document.getElementById("model")?.value || "/models/tasmee/fastconformer_ar_ctc_q8pc-head.onnx";
    log("═══ TEMPORARY smoke set (see SMOKE_PASSAGES note) ═══");
    for (const p of SMOKE_PASSAGES) {
        try { await capture(p, modelUrl); } catch (e) { log(`capture failed ${p.reciter} ${p.surah}:${p.from}-${p.to}: ${e.message}`, "bad"); }
    }
    return scoreAll();
}

/* ---------- clip table ---------- */
async function renderClips() {
    const host = document.getElementById("clips");
    if (!host) return;
    const clips = await listClips();
    host.innerHTML = clips.length ? "" : "<i>none captured yet</i>";
    if (!clips.length) return;
    const t = document.createElement("table");
    t.innerHTML = "<tr><th>id</th><th>frames</th><th>ref</th><th>dur</th><th></th></tr>";
    for (const c of clips) {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td>${c.id}</td><td>${c.frames}</td><td>${c.refWords}</td><td>${c.durS.toFixed(1)}s</td>`;
        const td = document.createElement("td");
        for (const [txt, fn] of [
            ["score·live", () => scoreLive(c.id)],
            ["inspect·frozen", () => score(c.id)],
            ["export", async () => downloadClipJson(await getClip(c.id))],
            ["✕", async () => { await deleteClip(c.id); renderClips(); }],
        ]) {
            const b = document.createElement("button");
            b.textContent = txt;
            b.onclick = () => fn().catch((e) => log(String(e), "bad"));
            td.appendChild(b);
        }
        tr.appendChild(td);
        t.appendChild(tr);
    }
    host.appendChild(t);
}

/* ---------- wire UI + scriptable API ---------- */
document.getElementById("btnCapture")?.addEventListener("click", () => {
    const p = {
        reciter: document.getElementById("reciter").value,
        surah: Number(document.getElementById("surah").value),
        from: Number(document.getElementById("from").value),
        to: Number(document.getElementById("to").value),
    };
    capture(p, document.getElementById("model").value).catch((e) => log(String(e), "bad"));
});
document.getElementById("btnSmoke")?.addEventListener("click", () => runSmoke().catch((e) => log(String(e), "bad")));
// PERMANENT: local-file ingestion (founder mic recordings → lab clips).
document.getElementById("btnLocal")?.addEventListener("click", async () => {
    const f = document.getElementById("localWav")?.files?.[0];
    if (!f) { log("pick an audio file first", "bad"); return; }
    const info = {
        name: (document.getElementById("localName").value || "founder").trim().replace(/\s+/g, "_"),
        surah: Number(document.getElementById("surah").value),
        from: Number(document.getElementById("from").value),
        to: Number(document.getElementById("to").value),
        label: document.getElementById("localLabel").value,
    };
    captureFromLocalWav(await f.arrayBuffer(), info, document.getElementById("model").value)
        .catch((e) => log(String(e), "bad"));
});
renderClips();

window.__lab = { capture, captureFromLocalWav, score, scoreLive, scoreAll, runSmoke, listClips, getClip, deleteClip, SMOKE_PASSAGES };
log("tasmee-lab ready. Ship target is Safari/WebKit — run REAL captures there so numbers reflect the target engine.");
