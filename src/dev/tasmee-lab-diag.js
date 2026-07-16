/* ============================================================
 * ⚠️ THROWAWAY DIAGNOSTIC — tasmee-lab-diag.js — DELETE AFTER READING.
 * (rm this file + its <script> tag in dev/tasmee-lab.html)
 *
 * READ-ONLY inspection of the frozen per-frame logprobs captured by the
 * dev lab: for each false-flag spot of the 2026-07-16 smoke run, was the
 * missing/mis-split reference sound a strong NEAR-MISS in the model's
 * numbers (fingerprint present, lost the argmax) or genuinely absent?
 * Builds nothing, repairs nothing, touches no live/lab core logic.
 * ============================================================ */

import { getClip } from "./tasmee-lab-db.js";
import { capture, SMOKE_PASSAGES } from "./tasmee-lab.js";
import { tasmeeNorm } from "../tasmee-norm.js";
import { makeGreedyDecoder, FRAME_S } from "../tasmee-pipeline.js";

const VOCAB_URL = "/models/tasmee/vocab.json";
const MODEL_URL = "/models/tasmee/fastconformer_ar_ctc_q8pc-head.onnx";

async function loadVocab() {
    const j = await fetch(VOCAB_URL).then((r) => r.json());
    const vocab = [];
    for (const [id, tok] of Object.entries(j)) vocab[Number(id)] = tok;
    const blank = vocab.indexOf("<blank>");
    return { vocab, blank };
}

const disp = (tok) => (tok === "<blank>" ? "∅" : tok.replace("▁", "‿"));

/* Decode the WHOLE frozen clip once with the REAL greedy decoder over a
 * flat [T,V] matrix rebuilt from the sink, keeping per-frame argmax
 * (frameIds) and per-word frame spans. */
function frozenDecode(clip, vocab, blank) {
    const V = clip.V, N = clip.indices.length;
    // sanity: indices contiguous? (capture covers every frame; report if not)
    let holes = 0;
    for (let i = 1; i < N; i++) if (clip.indices[i] !== clip.indices[i - 1] + 1) holes++;
    const flat = new Float32Array(N * V);
    for (let i = 0; i < N; i++) flat.set(clip.data.subarray(i * V, (i + 1) * V), i * V);
    const GREEDY = makeGreedyDecoder(vocab, blank);
    const startS = clip.indices[0] * FRAME_S;
    const g = GREEDY(flat, N, V, startS);
    const words = g.words.map((w) => ({
        ...w,
        norm: tasmeeNorm(w.text),
        f0: Math.round(w.startS / FRAME_S),
        f1: Math.round(w.endS / FRAME_S),
    }));
    const rowAt = (absIdx) => {
        const i = absIdx - clip.indices[0];
        return i >= 0 && i < N ? clip.data.subarray(i * V, (i + 1) * V) : null;
    };
    const pickAt = (absIdx) => {
        const i = absIdx - clip.indices[0];
        return i >= 0 && i < N ? g.frameIds[i] : -1;
    };
    return { words, rowAt, pickAt, holes, first: clip.indices[0], last: clip.indices[N - 1] };
}

function topK(row, k) {
    const idx = [];
    for (let v = 0; v < row.length; v++) {
        if (idx.length < k) { idx.push(v); idx.sort((a, b) => row[b] - row[a]); }
        else if (row[v] > row[idx[k - 1]]) { idx[k - 1] = v; idx.sort((a, b) => row[b] - row[a]); }
    }
    return idx;
}
const rankOf = (row, tokId) => { let r = 1; for (let v = 0; v < row.length; v++) if (row[v] > row[tokId]) r++; return r; };

/* Best score achieved in [f0..f1] by any vocab token satisfying pred. */
function bestForPredicate(dec, vocab, f0, f1, pred) {
    let best = null;
    for (let f = f0; f <= f1; f++) {
        const row = dec.rowAt(f);
        if (!row) continue;
        for (let v = 0; v < row.length; v++) {
            if (!pred(vocab[v] || "")) continue;
            if (!best || row[v] > best.lp) best = { f, tok: vocab[v], lp: row[v], rank: 0, id: v };
        }
    }
    if (best) best.rank = rankOf(dec.rowAt(best.f), best.id);
    return best;
}
const fmtBest = (b) =>
    b ? `«${disp(b.tok)}» p=${Math.exp(b.lp).toFixed(3)} (logp ${b.lp.toFixed(2)}, rank ${b.rank}) @ frame ${b.f} (${(b.f * FRAME_S).toFixed(2)}s)`
      : "— no matching token in region";

function frameTable(dec, vocab, blank, f0, f1) {
    const lines = [];
    for (let f = f0; f <= f1; f++) {
        const row = dec.rowAt(f);
        if (!row) { lines.push(`  #${f} — (outside capture)`); continue; }
        const pick = dec.pickAt(f);
        const tops = topK(row, 5)
            .map((v) => `${disp(vocab[v])} ${Math.exp(row[v]).toFixed(2)}`)
            .join(" · ");
        lines.push(`  #${f} ${(f * FRAME_S).toFixed(2).padStart(6)}s │ ${tops} │ pick: ${disp(vocab[pick] ?? "?")}`);
    }
    return lines.join("\n");
}

/* Find the frozen word matching a reference form (tasmeeNorm space);
 * fall back to inclusion either way; null if nothing plausible. */
function findFrozen(words, refForm, fromI = 0) {
    for (let i = fromI; i < words.length; i++) if (words[i].norm === refForm) return { i, w: words[i], exact: true };
    for (let i = fromI; i < words.length; i++) {
        if (words[i].norm.includes(refForm) || refForm.includes(words[i].norm)) return { i, w: words[i], exact: false };
    }
    return null;
}
const refFormOf = (clip, vk, pos) => clip.ref.find((r) => r.vk === vk && r.pos === pos)?.form;

/* ---------- the spot specs (from the 2026-07-16 smoke run) ---------- */
const SPOTS = [
    {
        clipKey: "qasim-97-3-5",
        title: "SPOT 1 — qasim 97:4 cluster: false_wrong والروح(97:4:3) · false_skip فيها(97:4:4) بإذن(97:4:5); artifact: spurious «في» before «فيها»",
        anchorStart: ["97:4", 2],   // الملائكة
        anchorEnd: ["97:4", 6],     // ربهم
        pad: 4,
        probes: [
            { label: "فيها-bearing tokens (contains «فيها»)", pred: (t) => t.includes("فيها") },
            { label: "«ها» tokens (the split's missing tail)", pred: (t) => t.replace("▁", "") === "ها" },
            { label: "الروح pieces (contains «روح» or «رو»)", pred: (t) => t.includes("روح") || t.includes("رو") },
        ],
        control: { label: "ROUGH WRONG-SOUND CONTROL: tokens containing «ص»", pred: (t) => t.includes("ص") },
    },
    {
        clipKey: "ayoub-105-3-5",
        title: "SPOT 2 — ayoub 105:3: «أبابيل» decoded «أبابي» (final ل dropped)",
        anchorStart: ["105:3", 4],  // أبابيل itself
        anchorEnd: ["105:4", 1],    // ترميهم
        pad: 3,
        probes: [
            { label: "ل-bearing tokens (contains «ل»)", pred: (t) => t.includes("ل") },
            { label: "bare «ل» / «يل» piece", pred: (t) => ["ل", "يل", "▁ل"].includes(t) },
        ],
        control: { label: "ROUGH WRONG-SOUND CONTROL: tokens containing «ص»", pred: (t) => t.includes("ص") },
    },
    {
        clipKey: "ayoub-105-3-5",
        title: "SPOT 3 — ayoub 105:4: false_skip بحجارة(105:4:2)",
        anchorStart: ["105:4", 1],  // ترميهم
        anchorEnd: ["105:4", 3],    // من
        pad: 4,
        probes: [
            { label: "بحجارة pieces (contains «حجار»/«جار»/«حج»)", pred: (t) => t.includes("حجار") || t.includes("جار") || t.includes("حج") },
            { label: "opening «ب» pieces (▁ب / ▁بح)", pred: (t) => t === "▁ب" || t === "▁بح" },
        ],
        control: { label: "ROUGH WRONG-SOUND CONTROL: tokens containing «ش»", pred: (t) => t.includes("ش") },
    },
    {
        clipKey: "ayoub-105-3-5",
        title: "SPOT 4 — ayoub 105:5: «فجعلهم» decoded «فجلهم» (ع dropped)",
        anchorStart: ["105:5", 1],  // فجعلهم
        anchorEnd: ["105:5", 2],    // كعصف
        pad: 3,
        probes: [
            { label: "ع-bearing tokens (contains «ع»)", pred: (t) => t.includes("ع") },
            { label: "«عل»/«جع» pieces", pred: (t) => t.includes("عل") || t.includes("جع") },
        ],
        control: { label: "ROUGH WRONG-SOUND CONTROL: tokens containing «ش»", pred: (t) => t.includes("ش") },
    },
];

const YARDSTICK = {
    clipKey: "qasim-99-6-8",
    title: "YARDSTICK — qasim 99:7 (CLEAN clip): correctly-decoded «يعمل» and «مثقال»",
    words: [["99:7", 2], ["99:7", 3]],   // يعمل · مثقال
    pad: 1,
};

/* ---------- runner ---------- */
async function ensureClip(clipKey) {
    const id = `${clipKey}-q8pc-head`;
    let clip = await getClip(id);
    if (!clip) {
        const [reciter, surah, from, to] = clipKey.split("-");
        const passage = SMOKE_PASSAGES.find((p) => p.reciter === reciter && p.surah === +surah && p.from === +from && p.to === +to)
            || { reciter, surah: +surah, from: +from, to: +to };
        clip = await capture(passage, MODEL_URL);
    }
    return clip;
}

export async function runDiag() {
    const out = [];
    const P = (s = "") => out.push(s);
    const { vocab, blank } = await loadVocab();
    const decCache = new Map();
    async function decoded(clipKey) {
        if (!decCache.has(clipKey)) {
            const clip = await ensureClip(clipKey);
            const dec = frozenDecode(clip, vocab, blank);
            decCache.set(clipKey, { clip, dec });
        }
        return decCache.get(clipKey);
    }

    P("═════════ THROWAWAY LOGPROB DIAGNOSTIC (frozen dumps, q8pc-head) ═════════");
    P("Note: frames/picks below are the FROZEN (latest-decode-wins) surface — the same");
    P("deterministic surface Phase-2 scoring flags on. p = exp(logprob). ‿ marks a ▁ word-start token, ∅ = blank.");
    P("");

    for (const spot of SPOTS) {
        const { clip, dec } = await decoded(spot.clipKey);
        P(`──────── ${spot.title}`);
        if (dec.holes) P(`  ⚠ capture has ${dec.holes} frame holes — tables may skip frames`);

        const fs = refFormOf(clip, ...spot.anchorStart), fe = refFormOf(clip, ...spot.anchorEnd);
        const a = findFrozen(dec.words, fs);
        const b = a ? findFrozen(dec.words, fe, a.i) : findFrozen(dec.words, fe);
        let f0, f1, how;
        if (a && b) {
            f0 = Math.max(dec.first, a.w.f0 - spot.pad);
            f1 = Math.min(dec.last, b.w.f1 + spot.pad);
            how = `anchors ${a.exact ? "exact" : "fuzzy"} «${a.w.text}»[#${a.w.f0}-${a.w.f1}] … ${b.exact ? "exact" : "fuzzy"} «${b.w.text}»[#${b.w.f0}-${b.w.f1}]`;
        } else {
            // AMBIGUOUS localization — widen rather than guess (guardrail).
            const any = a || b;
            if (any) { f0 = Math.max(dec.first, any.w.f0 - 15); f1 = Math.min(dec.last, any.w.f1 + 15); how = `ONLY ONE ANCHOR FOUND (${any.w.text}) — WIDENED ±15 frames`; }
            else { f0 = dec.first; f1 = Math.min(dec.last, dec.first + 80); how = "NO ANCHOR FOUND — showing clip head (ambiguous localization, stated per guardrail)"; }
        }
        const iS = clip.ref.findIndex((r) => r.vk === spot.anchorStart[0] && r.pos === spot.anchorStart[1]);
        const iE = clip.ref.findIndex((r) => r.vk === spot.anchorEnd[0] && r.pos === spot.anchorEnd[1]);
        const refWords = (iS >= 0 && iE >= iS ? clip.ref.slice(iS, iE + 1) : []).map((r) => r.form).join(" ");
        const gotWords = dec.words.filter((w) => w.f1 >= f0 && w.f0 <= f1).map((w) => w.text).join(" ");
        P(`  localization: ${how}`);
        P(`  REFERENCE (region): ${refWords}`);
        P(`  GREEDY DECODE (region): ${gotWords}`);
        P(`  frames #${f0}–#${f1} (${(f0 * FRAME_S).toFixed(2)}–${(f1 * FRAME_S).toFixed(2)}s):`);
        P(frameTable(dec, vocab, blank, f0, f1));
        for (const pr of spot.probes) P(`  ▸ best in region — ${pr.label}: ${fmtBest(bestForPredicate(dec, vocab, f0, f1, pr.pred))}`);
        P(`  ▸ ${spot.control.label}: ${fmtBest(bestForPredicate(dec, vocab, f0, f1, spot.control.pred))}`);
        P("");
    }

    // Yardstick
    const { clip, dec } = await decoded(YARDSTICK.clipKey);
    P(`──────── ${YARDSTICK.title}`);
    for (const [vk, pos] of YARDSTICK.words) {
        const form = refFormOf(clip, vk, pos);
        const m = findFrozen(dec.words, form);
        if (!m) { P(`  «${form}» (${vk}:${pos}) — NOT FOUND in frozen decode (unexpected)`); continue; }
        const f0 = Math.max(dec.first, m.w.f0 - YARDSTICK.pad), f1 = Math.min(dec.last, m.w.f1 + YARDSTICK.pad);
        P(`  «${m.w.text}» (${vk}:${pos}) frames #${f0}–#${f1}:`);
        P(frameTable(dec, vocab, blank, f0, f1));
    }
    P("");
    P("(end of diagnostic — interpretation left to the reader by design)");
    return out.join("\n");
}

window.__labDiag = { runDiag };
