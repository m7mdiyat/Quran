/* ============================================================
 * ⚠️ THROWAWAY DIAGNOSTIC #3 — tasmee-lab-diag3.js — DELETE AFTER READING.
 * (rm this file + its <script> tag in dev/tasmee-lab.html)
 *
 * CLASS A vs CLASS B classification for cross-word IQLAB fusion
 * (tanwīn/نْ + ب): per instance × reciter —
 *   A. live verdict on the fusion words
 *   B. window census at the fusion region (separated / merged-matchable /
 *      blob-fail), judged by the REAL matcher (mini engine session)
 *   C. amendment simulation (would the proposed post-commit amendment
 *      bar have left the fusion words passing?)
 *   D. logprob fingerprint in fused windows (+ wrong-sound control)
 *   E. anchor/frontier wedging notes
 * Live-replay tracer machinery copied from diag2 (both throwaway).
 * Builds NO fix; touches NO live file.
 * ============================================================ */

import { getClip } from "./tasmee-lab-db.js";
import { capture } from "./tasmee-lab.js";
import { createTasmeeSession } from "../tasmee-engine.js";
import { createStreamController } from "../tasmee-stream.js";
import { buildVad, FRAME_S } from "../tasmee-pipeline.js";
import { tasmeeNorm } from "../tasmee-norm.js";
import { TASMEE_LIVE } from "../tasmee-live-config.js";

const MODEL_URL = "/models/tasmee/fastconformer_ar_ctc_q8pc-head.onnx";
const VOCAB_URL = "/models/tasmee/vocab.json";
const SR = TASMEE_LIVE.sr;

/* Instances (dataset-verified 2026-07-16 against public/tasmee-words.json):
 * 47:4  منا(13) بعد(14)   anchors فاما(12) / واما(15)   [+ اثخنتموهم(9) secondary]
 * 22:75 سميع(10) بصير(11) anchors الله(9) / ayah-end
 * 30:4  ومن(8) بعد(9)     anchors قبل(7) / ويوميذ(10) */
const INSTANCES = [
    { surah: 47, from: 4, to: 4, a: 13, b: 14, before: 12, after: 15, note: "مَنًّا بَعْدُ — THE founder case" },
    // anchor = الناس (pos 7): the form الله occurs at pos 1 AND 9 — the first
    // localization run matched pos-1's reading and censused the wrong region.
    { surah: 22, from: 75, to: 75, a: 10, b: 11, before: 7, after: null, note: "سَمِيعٌ بَصِيرٌ (ayah-final)" },
    { surah: 30, from: 4, to: 4, a: 8, b: 9, before: 7, after: 10, note: "وَمِنۢ بَعْدُ" },
];
const RECITERS = ["qasim", "ayoub"];

/* ---------- ORT worker + traced live replay (copied from diag2) ---------- */
let _w = null, _ready = null;
function ortWorker() {
    if (!_w) {
        _w = new Worker(new URL("../tasmee-worker.js", import.meta.url), { type: "module" });
        _ready = new Promise((res, rej) => {
            const h = (e) => {
                if (e.data?.type === "ready") { _w.removeEventListener("message", h); res(); }
                if (e.data?.type === "error") { _w.removeEventListener("message", h); rej(new Error(e.data.message)); }
            };
            _w.addEventListener("message", h);
            _w.postMessage({ type: "init", modelUrl: MODEL_URL, vocabUrl: VOCAB_URL });
        });
    }
    return _ready.then(() => _w);
}
let _q = Promise.resolve();
function makeOrtDecode(pcm16k, rawLog = null) {
    return (startS, endS) =>
        (_q = _q.then(async () => {
            const w = await ortWorker();
            const slice = pcm16k.slice(Math.floor(startS * SR), Math.floor(endS * SR));
            const words = await new Promise((res, rej) => {
                const h = (e) => {
                    const m = e.data || {};
                    if (m.type === "decoded") { w.removeEventListener("message", h); res(m.words); }
                    else if (m.type === "error") { w.removeEventListener("message", h); rej(new Error(m.message)); }
                };
                w.addEventListener("message", h);
                w.postMessage({ type: "decode", pcm: slice, startS }, [slice.buffer]);
            });
            if (rawLog) rawLog.push({ startS, endS, words });
            return words;
        }));
}
async function replayLiveTraced(clip) {
    const events = [];
    const session = createTasmeeSession({
        words: clip.ref.map((r) => ({ vk: r.vk, pos: r.pos, form: r.form })),
        onEvent: (e) => events.push(e),
    });
    const rawLog = [];
    const decode = makeOrtDecode(clip.pcm16k, rawLog);
    const trace = [];
    let vad = buildVad(clip.pcm16k.subarray(0, clip.pumpEndLen), { policy: TASMEE_LIVE.vadPolicy });
    const ctl = createStreamController({
        session, decode,
        isSpeech: (a, b) => vad.isSpeech(a, b),
        findSilenceBefore: (a, b) => vad.findSilenceBefore(a, b),
        norm: tasmeeNorm,
        ...TASMEE_LIVE.controller,
        debug: (chunkEnd, commitN, pending, anchorS) =>
            trace.push({ chunkEnd, anchorS, commitN, pending: pending.map((p) => ({ t: p.text, s: p.startS, e: p.endS })) }),
    });
    let next = TASMEE_LIVE.stepS;
    while (next <= clip.pumpEndLen / SR) { await ctl.step(next); next += TASMEE_LIVE.stepS; }
    vad = buildVad(clip.pcm16k, { policy: TASMEE_LIVE.vadPolicy });
    const endS = clip.pcm16k.length / SR;
    while (next < endS + TASMEE_LIVE.stepS) { await ctl.step(Math.min(next, endS)); next += TASMEE_LIVE.stepS; }
    ctl.flush(endS);
    session.stop(Math.round(endS * 1000));
    return { events, words: session.getWords(), committed: ctl.results().committed, trace, rawLog };
}

/* ---------- helpers ---------- */
const refWord = (clip, vk, pos) => clip.ref.find((r) => r.vk === vk && r.pos === pos);
function findReadingSpan(rawLog, normT) {
    let best = null;
    for (const win of rawLog) for (const w of win.words) {
        const n = tasmeeNorm(w.text);
        if (n === normT || n.includes(normT)) { if (!best) best = { s0: w.startS, s1: w.endS }; }
    }
    return best;
}
/* Judge a region reading with the REAL matcher: fresh 2-word session. */
function judgeReading(words, A, B) {
    const ev = [];
    const s = createTasmeeSession({ words: [A, B].map((r) => ({ vk: r.vk, pos: r.pos, form: r.form })), onEvent: (e) => ev.push(e) });
    let t = 1000;
    for (const w of words) s.feedToken(w.text, (t += 500));
    s.stop(t + 1000);
    const got = s.getWords();
    const okBoth = got[0].verdict === "correct" && got[1].verdict === "correct";
    const merged = ev.some((e) => e.type === "reveal" && e.merged);
    return { okBoth, merged, verdicts: got.map((g) => g.verdict || "∅").join("/"), nTok: words.length };
}
function topK(row, k) {
    const idx = [];
    for (let v = 0; v < row.length; v++) {
        if (idx.length < k) { idx.push(v); idx.sort((a, b) => row[b] - row[a]); }
        else if (row[v] > row[idx[k - 1]]) { idx[k - 1] = v; idx.sort((a, b) => row[b] - row[a]); }
    }
    return idx;
}
const rankOf = (row, id) => { let r = 1; for (let v = 0; v < row.length; v++) if (row[v] > row[id]) r++; return r; };
function bestFor(framesMap, vocab, f0, f1, pred) {
    let best = null;
    for (let f = f0; f <= f1; f++) {
        const row = framesMap.get(f);
        if (!row) continue;
        for (let v = 0; v < row.length; v++) {
            if (!pred(vocab[v] || "")) continue;
            if (!best || row[v] > best.lp) best = { f, tok: vocab[v], lp: row[v], id: v };
        }
    }
    if (best) best.rank = rankOf(framesMap.get(best.f), best.id);
    return best ? `«${best.tok.replace("▁", "‿")}» p=${Math.exp(best.lp).toFixed(3)} rank ${best.rank} @${(best.f * FRAME_S).toFixed(2)}s` : "—";
}

async function ensureClip(reciter, inst) {
    const id = `${reciter}-${inst.surah}-${inst.from}-${inst.to}-q8pc-head`;
    let clip = await getClip(id);
    if (!clip) clip = await capture({ reciter, surah: inst.surah, from: inst.from, to: inst.to }, MODEL_URL);
    return clip;
}

/* ---------- the run ---------- */
export async function runDiag3(onlySurah = null) {
    const out = [];
    const P = (s = "") => out.push(s);
    const vocabJson = await fetch(VOCAB_URL).then((r) => r.json());
    const vocab = []; for (const [i, t] of Object.entries(vocabJson)) vocab[Number(i)] = t;

    P("═════ THROWAWAY DIAGNOSTIC #3 — cross-word iqlab: CLASS A (amendment fixes) vs CLASS B (never separates) ═════");
    P("Matcher equivalences in force today (verified from tasmee-engine.js): per-word fuzzy ≥0.75;");
    P("merged 1c = ONE token vs plain concat(refA+refB) ≥0.75; idghām 1c2 = {بل هل قد اذ} fused forms only; NO iqlab table.");
    P("");

    for (const inst of INSTANCES) {
        if (onlySurah && inst.surah !== onlySurah) continue;
        for (const reciter of RECITERS) {
            const clip = await ensureClip(reciter, inst);
            await analyzeOne(P, inst, clip, vocab);
        }
    }
    P("(end diagnostic #3)");
    return out.join("\n");
}

/* Run the same A–E analysis on ONE existing clip (e.g. the founder's
 * ingested mic recording) — instance resolved from the clip's passage. */
export async function runDiag3Clip(clipId) {
    const out = [];
    const P = (s = "") => out.push(s);
    const vocabJson = await fetch(VOCAB_URL).then((r) => r.json());
    const vocab = []; for (const [i, t] of Object.entries(vocabJson)) vocab[Number(i)] = t;
    const clip = await getClip(clipId);
    if (!clip) throw new Error(`no clip ${clipId} — ingest it first (__lab.captureFromLocalWav)`);
    const inst = INSTANCES.find((i) => i.surah === clip.passage.surah && i.from === clip.passage.from && i.to === clip.passage.to);
    if (!inst) throw new Error(`no instance spec for surah ${clip.passage.surah}:${clip.passage.from}`);
    await analyzeOne(P, inst, clip, vocab);
    return out.join("\n");
}

async function analyzeOne(P, inst, clip, vocab) {
    {
        {
            const reciter = clip.passage?.reciter || clip.id;
            const A = refWord(clip, `${inst.surah}:${inst.from}`, inst.a);
            const B = refWord(clip, `${inst.surah}:${inst.from}`, inst.b);
            const beforeW = refWord(clip, `${inst.surah}:${inst.from}`, inst.before);
            const afterW = inst.after ? refWord(clip, `${inst.surah}:${inst.from}`, inst.after) : null;
            P(`──────── ${inst.note} — ${reciter} ${inst.surah}:${inst.from} · fusion «${A.form}»+«${B.form}» (pos ${inst.a},${inst.b})`);

            // A. live verdicts (capture event log)
            const lv = new Map();
            for (const e of clip.liveEvents || []) if (e.type === "reveal") lv.set(`${e.vk}:${e.pos}`, e.verdict);
            const vA = lv.get(`${A.vk}:${A.pos}`) || "∅never", vB = lv.get(`${B.vk}:${B.pos}`) || "∅never";
            const flagged = [...lv.entries()].filter(([, v]) => v !== "correct").map(([k, v]) => `${k}:${v}`);
            const unrevealed = clip.ref.filter((r) => !lv.has(`${r.vk}:${r.pos}`)).map((r) => `${r.vk}:${r.pos}(${r.form})`);
            const insN = (clip.liveEvents || []).filter((e) => e.type === "insertion").length;
            P(`  A. LIVE verdicts: «${A.form}»=${vA} · «${B.form}»=${vB} · other non-correct: ${flagged.filter((f) => !f.startsWith(`${A.vk}:${A.pos}`) && !f.startsWith(`${B.vk}:${B.pos}`)).join(", ") || "none"} · unrevealed: ${unrevealed.join(", ") || "none"} · insertions: ${insN}`);

            // B. traced replay + census
            const rep = await replayLiveTraced(clip);
            const same = rep.committed.map((w) => tasmeeNorm(w.text)).join(" ") === (clip.committedFull || []).map((w) => tasmeeNorm(w.text)).join(" ");
            P(`  B. replay reproduction: ${same ? "IDENTICAL" : "DIVERGED (traces self-consistent, noted)"}`);
            const sB = findReadingSpan(rep.rawLog, beforeW.form);
            const sAft = afterW ? findReadingSpan(rep.rawLog, afterW.form) : null;
            let r0, r1, how = "anchor-based";
            if (sB && (sAft || !afterW)) {
                r0 = sB.s1 + 0.02;
                // ayah-final fusion (no after-anchor): region runs to clip end —
                // a fixed +2.5s cap twice cut BEFORE the fusion words (slow reciters).
                r1 = sAft ? sAft.s0 - 0.02 : clip.pcm16k.length / SR;
            } else {
                // AMBIGUOUS — widen (guardrail): use any fused/partial hit on A or B
                const alt = findReadingSpan(rep.rawLog, A.form) || findReadingSpan(rep.rawLog, B.form);
                if (alt) { r0 = alt.s0 - 1.0; r1 = alt.s1 + 1.0; how = "WIDENED (anchor missing)"; }
                else { P("  ⚠ region NOT LOCALIZABLE (no anchor, no fusion-word reading anywhere) — census skipped, reported honestly"); P(""); return; }
            }
            P(`  region [${r0.toFixed(2)}–${r1.toFixed(2)}s] (${how})`);
            const census = [];
            for (const win of rep.rawLog) {
                if (win.endS < r0 + 1e-6 || win.startS > r1) continue;
                const cover = win.words.filter((w) => w.endS >= r0 && w.startS <= r1);
                if (!cover.length && win.endS < r1) continue;
                const j = judgeReading(cover, A, B);
                const cat = !cover.length ? "EMPTY"
                    : j.okBoth && j.merged ? "MERGED-OK"
                    : j.okBoth ? "SEP-OK"
                    : "BLOB-FAIL";
                census.push({ win, cover, cat, j });
            }
            const counts = census.reduce((m, c) => ((m[c.cat] = (m[c.cat] || 0) + 1), m), {});
            P(`  census (${census.length} covering windows): ${JSON.stringify(counts)}`);
            for (const c of census.slice(0, 18)) {
                P(`    ${c.win.startS.toFixed(2)}–${c.win.endS.toFixed(2)}: "${c.cover.map((w) => w.text).join(" ") || "∅"}" → ${c.cat}${c.cat === "BLOB-FAIL" ? ` (${c.j.verdicts})` : ""}`);
            }
            if (census.length > 18) P(`    … ${census.length - 18} more`);
            const committedRegion = rep.committed.filter((w) => w.endS >= r0 && w.startS <= r1);
            P(`  committed in region: "${committedRegion.map((w) => w.text).join(" ")}" (commitAt ${committedRegion.map((w) => w.commitAtS.toFixed(1)).join(",")})`);
            const rv = new Map();
            for (const e of rep.events) if (e.type === "reveal") rv.set(`${e.vk}:${e.pos}`, e.verdict);
            P(`  replay verdicts: «${A.form}»=${rv.get(`${A.vk}:${A.pos}`) || "∅"} · «${B.form}»=${rv.get(`${B.vk}:${B.pos}`) || "∅"}`);

            // C. amendment simulation
            const passLive = vA === "correct" && vB === "correct";
            if (passLive) P(`  C. AMENDMENT: not needed — passes live as-is`);
            else {
                const t0 = committedRegion.length ? Math.max(...committedRegion.map((w) => w.commitAtS)) : r0;
                // PER-WORD amendment bar (matches the proposed design: WORDS are
                // amended, not region strings): compare only tokens whose CENTER
                // lies inside the fusion region — an anchor-edge word flapping
                // (فإما/فَإِم) must not veto a stable fusion-word reading.
                const centerIn = (w) => { const c = (w.startS + w.endS) / 2; return c >= r0 && c <= r1; };
                const coreOf = (c) => c.cover.filter(centerIn);
                let fix = null;
                for (let i = 0; i < census.length - 1; i++) {
                    const c1 = census[i], c2 = census[i + 1];
                    if (c1.win.endS <= t0) continue;
                    if ((c1.cat === "SEP-OK" || c1.cat === "MERGED-OK") && (c2.cat === "SEP-OK" || c2.cat === "MERGED-OK")) {
                        const k1 = coreOf(c1), k2 = coreOf(c2);
                        const s1 = k1[0]?.startS, s2 = k2[0]?.startS;
                        const stable = s1 !== undefined && s2 !== undefined && Math.abs(s1 - s2) <= 2 * FRAME_S + 1e-6;
                        const sameRead = k1.length > 0 && k1.map((w) => tasmeeNorm(w.text)).join(" ") === k2.map((w) => tasmeeNorm(w.text)).join(" ");
                        if (stable && sameRead) { fix = { at: c2.win.endS, reading: k1.map((w) => w.text).join(" ") }; break; }
                    }
                }
                P(`  C. AMENDMENT SIM (per-word bar): ${fix ? `YES — stable matchable fusion reading "${fix.reading}" available at ${fix.at.toFixed(1)}s (post-commit ${t0.toFixed(1)}s → amendment lag ${(fix.at - t0).toFixed(1)}s)` : "NO — no stable matchable fusion reading ever appears after commit"}`);
            }

            // D. fingerprint (only when blobs dominate or live failed)
            if ((counts["BLOB-FAIL"] || 0) > 0 || !passLive) {
                const fm = new Map();
                for (let i = 0; i < clip.indices.length; i++) fm.set(clip.indices[i], clip.data.subarray(i * clip.V, (i + 1) * clip.V));
                const f0 = Math.round(r0 / FRAME_S), f1 = Math.round(r1 / FRAME_S);
                P(`  D. fingerprint (frozen rows, frames #${f0}–#${f1}):`);
                P(`     ${B.form}-bearing tokens: ${bestFor(fm, vocab, f0, f1, (t) => t.includes(B.form.slice(0, 3)))}`);
                P(`     ‿ب word-start: ${bestFor(fm, vocab, f0, f1, (t) => t === "▁ب" || t.startsWith("▁بَ") || t.startsWith("▁بِ") || t.startsWith("▁بع"))}`);
                P(`     م-realization (iqlab coda): ${bestFor(fm, vocab, f0, f1, (t) => { const n = t.replace("▁", ""); return n === "م" || n === "مْ" || n.startsWith("من"); })}`);
                P(`     «${A.form}»-bearing: ${bestFor(fm, vocab, f0, f1, (t) => tasmeeNorm(t).includes(A.form.replace("و", "").slice(0, 2)))}`);
                P(`     WRONG-SOUND CONTROL (ص): ${bestFor(fm, vocab, f0, f1, (t) => t.includes("ص"))}`);
                P(`     WRONG-SOUND CONTROL (ط): ${bestFor(fm, vocab, f0, f1, (t) => t.includes("ط"))}`);
            }

            // E. wedging
            const regionSteps = rep.trace.filter((t) => t.chunkEnd >= r0 && t.chunkEnd <= r1 + 3);
            const anchors = [...new Set(regionSteps.map((t) => t.anchorS.toFixed(2)))];
            let heldLong = null;
            for (const t of regionSteps) for (const p of t.pending) {
                if (p.s <= r1 && p.e >= r0) {
                    const key = tasmeeNorm(p.t) + "@" + p.s.toFixed(2);
                    heldLong = heldLong || {};
                    heldLong[key] = (heldLong[key] || 0) + 1;
                }
            }
            const wedges = heldLong ? Object.entries(heldLong).filter(([, n]) => n >= 6).map(([k, n]) => `${k} held ${(n * 0.3).toFixed(1)}s`) : [];
            P(`  E. wedging: anchors over region ${anchors.join("→")} · long-held pending: ${wedges.join(" · ") || "none ≥1.8s"}`);
            P("");
        }
    }
}

window.__labDiag3 = { runDiag3, runDiag3Clip };
