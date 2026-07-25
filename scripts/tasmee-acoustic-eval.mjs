/* ============================================================
 * tasmee-acoustic-eval.mjs — JOINT evidence table for the acoustic
 * channel (src/tasmee-acoustic.js), dev tooling only.
 *
 *   node scripts/tasmee-acoustic-eval.mjs <clip.wav> [--range 47:1-7]
 *        [--plants file.json] [--variant-set full|confusable]
 *        [--spans viterbi|greedy|both] [--json out.json]
 *
 * For every reference word it reports, side by side:
 *   - what the TEXT MATCHER decided (verdict + similarity), by running
 *     the real engine + streaming controller over the same audio
 *   - what the ACOUSTIC channel found (margin of the best near-miss
 *     over the canonical, using the same retained frames the live
 *     worker already keeps)
 *   - ground truth, when a plants file names the planted words
 *
 * That join is the point. The gate cannot be chosen from the acoustic
 * scores alone: what matters is which words the matcher ALREADY gets
 * right (there the channel can only do harm) versus the band where the
 * matcher is guessing (there it can only help). Running the channel
 * everywhere costs ~1 false flag per 90 correct words, which would
 * breach the 04/05 precision floor; the table says where to stand.
 *
 * SPAN SOURCE is a first-class variable, not a detail. Offline we can
 * Viterbi the whole clip and get exact word boundaries. LIVE we only
 * have the greedy decoder's spike-tight word timings. If the channel
 * only works on Viterbi spans it does not ship, so both are measured.
 * ============================================================ */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { tasmeeNorm } from "../src/tasmee-norm.js";
import { createTasmeeSession } from "../src/tasmee-engine.js";
import { createStreamController } from "../src/tasmee-stream.js";
import { createAcousticChecker } from "../src/tasmee-acoustic.js";
import { readWavMono, resampleTo16k, melFrontend, makeGreedyDecoder, NMEL, FRAME_S, buildVad } from "../src/tasmee-pipeline.js";
import { TASMEE_LIVE } from "../src/tasmee-live-config.js";

const require = createRequire(import.meta.url);
const ort = require("onnxruntime-node");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODEL_PATH = path.join(ROOT, "models", "tasmee", "fastconformer_ar_ctc_q8pc-head.onnx");
const VOCAB_PATH = path.join(ROOT, "public", "models", "tasmee", "vocab.json");
const DATASET = JSON.parse(fs.readFileSync(path.join(ROOT, "public", "tasmee-words.json"), "utf8"));

const args = process.argv.slice(2);
const clipPath = args.find((a) => !a.startsWith("--"));
const argVal = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
if (!clipPath) { console.error("usage: node scripts/tasmee-acoustic-eval.mjs <clip.wav> [--range s:a-b] [--plants f.json]"); process.exit(2); }

/* ---------- reference (same construction as the bench) ---------- */
function refFromRange(rangeStr) {
    const m = /^(\d+):(\d+)(?:-(\d+))?$/.exec(rangeStr);
    if (!m) throw new Error(`bad --range ${rangeStr}`);
    const s = Number(m[1]), from = Number(m[2]), to = Number(m[3] || m[2]);
    const out = [];
    for (let a = from; a <= to; a++) {
        const arr = DATASET.verses[`${s}:${a}`];
        if (!arr) throw new Error(`missing verse ${s}:${a}`);
        arr.forEach((f, i) => { if (f) out.push({ vk: `${s}:${a}`, pos: i + 1, form: f }); });
    }
    return out;
}
function refFromPage(pageNo) {
    const p = String(pageNo).padStart(3, "0");
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, "public", "data", "qcf4", "pages", `${p}.json`), "utf8"));
    const out = [];
    for (const line of d.lines || []) for (const w of line.words || []) {
        if (w.type !== "word" || String(w.text || "").startsWith("#")) continue;
        const form = DATASET.verses[w.verse_key]?.[w.position - 1];
        if (form) out.push({ vk: w.verse_key, pos: w.position, form });
    }
    return out;
}
const truthPath = argVal("--truth") ?? (fs.existsSync(clipPath.replace(/\.wav$/i, ".truth.json")) ? clipPath.replace(/\.wav$/i, ".truth.json") : null);
const truth = truthPath ? JSON.parse(fs.readFileSync(truthPath, "utf8")) : null;
let ref;
if (argVal("--range")) ref = refFromRange(argVal("--range"));
else if (truth?.range) {
    const [sF, aF] = truth.range.vkFrom.split(":").map(Number);
    const [, aT] = truth.range.vkTo.split(":").map(Number);
    ref = refFromRange(`${sF}:${aF}-${aT}`);
} else if (argVal("--page") || /-p(\d{3})\.wav$/i.test(clipPath)) {
    ref = refFromPage(argVal("--page") || /-p(\d{3})\.wav$/i.exec(clipPath)[1]);
} else { console.error("no reference: pass --range, --page, or a truth file"); process.exit(2); }

/* ---------- ground truth (planted mistakes), if supplied ---------- */
const plantArg = argVal("--plants");
const plantLocs = new Set();
if (plantArg) {
    const j = JSON.parse(fs.readFileSync(plantArg, "utf8"));
    const clipKey = path.basename(clipPath).replace(/\.wav$/i, "");
    const spec = Array.isArray(j) ? j : (j[clipKey] ? j[clipKey].plants : null);
    if (!spec) { console.error(`--plants: no entry for "${clipKey}" (keys: ${Object.keys(j).join(", ")})`); process.exit(2); }
    for (const p of spec) plantLocs.add(p.loc || `${p.vk}:${p.pos}`);
}

/* ---------- audio + model ---------- */
const fileBuf = fs.readFileSync(clipPath);
const { rate, pcm: raw } = readWavMono(fileBuf.buffer.slice(fileBuf.byteOffset, fileBuf.byteOffset + fileBuf.byteLength));
const pcmReal = resampleTo16k(raw, rate);
const pcm = new Float32Array(pcmReal.length + Math.round(TASMEE_LIVE.tailPadS * 16000));
pcm.set(pcmReal, 0);

const vocabJson = JSON.parse(fs.readFileSync(VOCAB_PATH, "utf8"));
const VOCAB = [];
for (const [id, tok] of Object.entries(vocabJson)) VOCAB[Number(id)] = tok;
const BLANK = VOCAB.indexOf("<blank>") >= 0 ? VOCAB.indexOf("<blank>") : VOCAB.length - 1;
const GREEDY = makeGreedyDecoder(VOCAB, BLANK);
const sess = await ort.InferenceSession.create(MODEL_PATH);

async function forward(a, startS = 0) {
    const { mel, T } = melFrontend(a);
    const out = await sess.run({
        audio_signal: new ort.Tensor("float32", mel, [1, NMEL, T]),
        length: new ort.Tensor("int64", BigInt64Array.from([BigInt(T)]), [1]),
    });
    const lp = out[sess.outputNames[0]];
    return { lp: lp.data, T: lp.dims[1], V: lp.dims[2], words: GREEDY(lp.data, lp.dims[1], lp.dims[2], startS).words };
}

/* ---------- 1) the TEXT MATCHER's decisions (real engine + controller) ---- */
const { isSpeech, findSilenceBefore } = buildVad(pcm, { policy: TASMEE_LIVE.vadPolicy });
const decisions = new Map();          // idx → {verdict, sim, heard}
const session = createTasmeeSession({
    words: ref,
    options: TASMEE_LIVE.engine,
    onEvent: (e) => {
        if (e.type === "reveal") decisions.set(e.idx, { verdict: e.verdict, sim: e.sim ?? null, heard: e.heard ?? null });
        else if (e.type === "amend") {
            const d = decisions.get(e.idx) || {};
            decisions.set(e.idx, { ...d, verdict: e.to, amended: true });
        }
    },
});
const ctl = createStreamController({
    session, decode: async (s, e) => (await forward(pcm.subarray(Math.floor(s * 16000), Math.floor(e * 16000)), s)).words,
    isSpeech, findSilenceBefore, norm: tasmeeNorm, ...TASMEE_LIVE.controller,
});
{
    const endS = pcm.length / 16000;
    for (let t = TASMEE_LIVE.stepS; t < endS + TASMEE_LIVE.stepS; t += TASMEE_LIVE.stepS) await ctl.step(Math.min(t, endS));
    ctl.flush(endS);
    session.stop(Math.round(endS * 1000));
}

/* ---------- 2) whole-clip frames, once ---------- */
const { lp, T, V, words: greedyWords } = await forward(pcmReal, 0);
const rows = new Array(T);
for (let t = 0; t < T; t++) rows[t] = lp.subarray(t * V, t * V + V);

const checker = createAcousticChecker({
    vocab: VOCAB, blank: BLANK,
    options: { variantSet: argVal("--variant-set") || "full" },
});

/* ---------- 3) spans, both ways ----------
 * viterbi: one forced alignment of the whole reference over the whole clip
 * greedy:  the decoder's own word timings, matched to reference words in
 *          pointer order over accepted matches — what a live caller has. */
const spanMode = argVal("--spans") || "both";
const viterbiSpans = (spanMode === "greedy") ? null
    : checker.alignSequence({ rows, V, t0: 0, t1: T - 1, forms: ref.map((r) => r.form) });

const greedySpans = new Array(ref.length).fill(null);
{
    /* Monotonic walk: advance the reference pointer on each greedy word
     * that matches the expected form well enough for the matcher to have
     * accepted it. Words the reciter got wrong get no greedy span, which
     * is itself informative — live, they would be flagged by the matcher. */
    let p = 0;
    const sim = (a, b) => {
        if (a === b) return 1;
        const m = Math.max(a.length, b.length);
        if (!m) return 0;
        const d = (() => {           // Levenshtein
            const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
            for (let i = 1; i <= a.length; i++) {
                let up = prev[0]; prev[0] = i;
                for (let j = 1; j <= b.length; j++) {
                    const t = prev[j];
                    prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, up + (a[i - 1] === b[j - 1] ? 0 : 1));
                    up = t;
                }
            }
            return prev[b.length];
        })();
        return 1 - d / m;
    };
    for (const w of greedyWords) {
        const t = tasmeeNorm(w.text || "");
        if (!t) continue;
        let hit = -1;
        for (let q = p; q < Math.min(p + 3, ref.length); q++) {
            if (sim(t, ref[q].form) >= 0.6) { hit = q; break; }
        }
        if (hit < 0) continue;
        greedySpans[hit] = [Math.max(0, Math.round(w.startS / FRAME_S)), Math.min(T - 1, Math.round(w.endS / FRAME_S))];
        p = hit + 1;
    }
}

/* LIVE spans — the faithful simulation of what the worker can do at
 * commit time. Greedy word timings are CTC spikes and their boundaries
 * are poor (measured: clean-word margin p99 3.40 on greedy vs 0.34 on a
 * whole-clip Viterbi — the spans, not the scoring, were the weak link).
 * But the worker does not need the whole clip: it holds the last 30 s of
 * frames and the recently committed words, so it can re-align a SHORT
 * window ending at the word just committed and read that word's span off
 * a real forced alignment. Cost is one Viterbi over ~4 words. */
const LIVE_BACK = Number(argVal("--live-back") || 2);    // words of LEFT context
const LIVE_FWD = Number(argVal("--live-fwd") || 1);      // words of RIGHT context
const liveSpans = new Array(ref.length).fill(null);
{
    /* RIGHT CONTEXT IS NOT OPTIONAL. A forced alignment that ends at the
     * target word has nothing to push its final boundary against, so the
     * last word absorbs whatever frames are left and its span is soft. The
     * tail guard already holds the frontier word until a successor settles,
     * and the flag deferral already waits up to 2 s before painting a
     * negative verdict — so scoring word i once word i+1 has committed
     * costs no latency the pipeline was not already spending. */
    for (let i = 0; i < ref.length; i++) {
        if (!greedySpans[i]) continue;
        const from = Math.max(0, i - LIVE_BACK), to = Math.min(ref.length - 1, i + LIVE_FWD);
        const forms = [], idxs = [];
        for (let q = from; q <= to; q++) {
            if (q > i && !greedySpans[q]) break;          // successor not committed → no right context
            forms.push(ref[q].form); idxs.push(q);
        }
        let a = greedySpans[i][0], b = greedySpans[i][1];
        for (const q of idxs) if (greedySpans[q]) {
            if (greedySpans[q][0] < a) a = greedySpans[q][0];
            if (greedySpans[q][1] > b) b = greedySpans[q][1];
        }
        const t0w = Math.max(0, a - 4), t1w = Math.min(T - 1, b + 4);
        if (t1w - t0w < 6) continue;
        const sp = checker.alignSequence({ rows, V, t0: t0w, t1: t1w, forms });
        const at = idxs.indexOf(i);
        if (sp && at >= 0 && sp[at][0] >= 0) liveSpans[i] = sp[at];
    }
}

/* ---------- 4) the joint table ---------- */
const t0 = performance.now();
const rowsOut = [];
for (let i = 0; i < ref.length; i++) {
    const loc = `${ref[i].vk}:${ref[i].pos}`;
    const d = decisions.get(i) || { verdict: "unrevealed", sim: null };
    const run = (span) => {
        if (!span || span[0] < 0) return null;
        return checker.check({ rows, V, f0: span[0], f1: span[1], form: ref[i].form });
    };
    const vit = viterbiSpans ? run(viterbiSpans[i]) : null;
    const grd = (spanMode === "viterbi") ? null : run(greedySpans[i]);
    const liv = (spanMode === "viterbi") ? null : run(liveSpans[i]);
    rowsOut.push({
        idx: i, loc, form: ref[i].form,
        verdict: d.verdict, sim: d.sim, heard: d.heard,
        plant: plantLocs.has(loc),
        vitMargin: vit ? +vit.margin.toFixed(3) : null, vitVariant: vit ? vit.variant : null,
        vitFrames: vit ? vit.frames : null, vitNVar: vit ? vit.nVariants : null,
        grdMargin: grd ? +grd.margin.toFixed(3) : null, grdVariant: grd ? grd.variant : null,
        grdFrames: grd ? grd.frames : null,
        livMargin: liv ? +liv.margin.toFixed(3) : null, livVariant: liv ? liv.variant : null,
        livFrames: liv ? liv.frames : null,
    });
}
const evalMs = performance.now() - t0;

/* ---------- 5) report ---------- */
const clip = path.basename(clipPath);
const scored = rowsOut.filter((r) => r.vitMargin != null || r.grdMargin != null);
const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(0)}%` : "—");
console.log(`\n=== ${clip}  ·  ${ref.length} ref words · ${T} frames · variant-set ${argVal("--variant-set") || "full"}`);
console.log(`    acoustic pass: ${evalMs.toFixed(0)} ms total, ${(evalMs / Math.max(scored.length, 1)).toFixed(1)} ms/word` +
    ` (${rowsOut.find((r) => r.vitNVar)?.vitNVar ?? "?"} variants/word)`);

const matcherFlagged = rowsOut.filter((r) => r.verdict === "substituted" || r.verdict === "skipped");
console.log(`    text matcher flagged ${matcherFlagged.length}/${ref.length}` +
    (plantLocs.size ? ` · caught ${matcherFlagged.filter((r) => r.plant).length}/${plantLocs.size} plants` : ""));

for (const key of (spanMode === "both" ? ["vit", "grd", "liv"] : spanMode === "viterbi" ? ["vit"] : ["grd", "liv"])) {
    const label = key === "vit" ? "VITERBI spans (offline upper bound)"
        : key === "grd" ? "GREEDY spans (raw decoder timings)"
            : `LIVE spans (local re-align, −${LIVE_BACK}/+${LIVE_FWD} words) — THE SHIPPABLE ONE`;
    const have = rowsOut.filter((r) => r[`${key}Margin`] != null);
    const plants = have.filter((r) => r.plant), clean = have.filter((r) => !r.plant);
    console.log(`\n  ${label} — scored ${have.length}/${ref.length}`);
    if (plantLocs.size) {
        const q = (a, f) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(f * (s.length - 1))]; };
        const pm = plants.map((r) => r[`${key}Margin`]), cm = clean.map((r) => r[`${key}Margin`]);
        console.log(`    plants  n=${pm.length}  median ${q(pm, 0.5).toFixed(2)}  max ${Math.max(...pm).toFixed(2)}`);
        console.log(`    clean   n=${cm.length}  median ${q(cm, 0.5).toFixed(2)}  p90 ${q(cm, 0.9).toFixed(2)}  p99 ${q(cm, 0.99).toFixed(2)}  max ${Math.max(...cm).toFixed(2)}`);
        console.log(`    ── margin sweep (flag when margin > m) ──`);
        for (const m of [0.0, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0]) {
            const tp = plants.filter((r) => r[`${key}Margin`] > m).length;
            const fp = clean.filter((r) => r[`${key}Margin`] > m).length;
            console.log(`      m=${m.toFixed(2)}  catches ${tp}/${plants.length} plants` +
                `  ·  ${fp} false on ${clean.length} clean (${pct(fp, clean.length)})`);
        }
    } else {
        const cm = clean.map((r) => r[`${key}Margin`]).sort((a, b) => a - b);
        console.log(`    NO PLANTS — this clip measures FALSE FLAGS only.`);
        for (const m of [0.0, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0]) {
            const fp = cm.filter((x) => x > m).length;
            console.log(`      m=${m.toFixed(2)}  ${fp} would flag / ${cm.length} words (${pct(fp, cm.length)})`);
        }
    }
}

if (plantLocs.size) {
    console.log(`\n  PLANTED WORDS (matcher verdict → acoustic margin):`);
    for (const r of rowsOut.filter((x) => x.plant)) {
        const caught = r.verdict === "substituted" || r.verdict === "skipped";
        console.log(`    ${r.loc.padEnd(9)} ${r.form.padEnd(12)} matcher=${String(r.verdict).padEnd(12)}` +
            `${caught ? "CAUGHT" : "missed"}  ·  vit ${r.vitMargin ?? "—"}` +
            `  grd ${r.grdMargin ?? "—"}  LIVE ${r.livMargin ?? "—"} (${r.livVariant || "—"})`);
    }
}

const outPath = argVal("--json");
if (outPath) {
    fs.writeFileSync(outPath, JSON.stringify({ clip, range: argVal("--range"), frames: T, rows: rowsOut }, null, 1));
    console.log(`\n  wrote ${outPath}`);
}
console.log();
