/* ============================================================
 * tasmee-absorb.mjs — DEV-ONLY diagnostic instrument (never a build
 * input, never imported by the app). Answers ONE question:
 *
 *   When the reciter deliberately alters a word (a swapped letter, a
 *   changed haraka), does the model's ACOUSTIC evidence track the
 *   change — or does it decode the canonical reference regardless
 *   ("absorption")?
 *
 * Method — CTC lattice forced-alignment scoring. For a frame span we
 * compute logP(candidate string | frames) under the model's per-frame
 * logprobs, marginalising over EVERY tokenisation of the string that
 * the subword vocab admits (word-initial "▁" handled by prepending it
 * to the string). Two candidates that differ in exactly one character
 * therefore differ ONLY by that character's acoustics — tokenisation
 * fragmentation bias cancels.
 *
 *   Δ_said    = logP(what he said)     − logP(reference)
 *   Δ_control = logP(a wrong-sound ctl) − logP(reference)
 *
 *   Δ_said ≳ 0                    → the audio favours HIS form  → DETECTABLE
 *   Δ_said ≪ 0 and ≈ Δ_control    → no trace of his change      → ABSORBED
 *   in between                    → partial evidence            → AMBIGUOUS
 *
 * Host: onnxruntime-node over the SAME shared modules the browser
 * worker runs (src/tasmee-pipeline.js), i.e. the bench's parity host
 * (scripts/tasmee-bench.mjs §"ORT backend"). Full-context decode: the
 * whole clip in one window, so this measures the model's best case —
 * if the evidence is absent HERE it is absent everywhere.
 *
 *   node scripts/tasmee-absorb.mjs transcribe <clip.wav>
 *   node scripts/tasmee-absorb.mjs probe <clip.wav> --plants <plants.json>
 * ============================================================ */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { readWavMono, resampleTo16k, melFrontend, makeGreedyDecoder, NMEL, FRAME_S } from "../src/tasmee-pipeline.js";
import { tasmeeNorm } from "../src/tasmee-norm.js";

const require = createRequire(import.meta.url);
const ort = require("onnxruntime-node");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const MODEL_PATH = path.join(ROOT, "models", "tasmee", "fastconformer_ar_ctc_q8pc-head.onnx");
const VOCAB_PATH = path.join(ROOT, "public", "models", "tasmee", "vocab.json");

const args = process.argv.slice(2);
const cmd = args[0];
const clipPath = args[1];
const argVal = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };

/* ---------- vocab ---------- */
const vocabJson = JSON.parse(fs.readFileSync(VOCAB_PATH, "utf8"));
const VOCAB = [];
for (const [id, tok] of Object.entries(vocabJson)) VOCAB[Number(id)] = tok;
const BLANK = VOCAB.indexOf("<blank>") >= 0 ? VOCAB.indexOf("<blank>") : VOCAB.length - 1;
const GREEDY = makeGreedyDecoder(VOCAB, BLANK);
const TOKID = new Map();
for (let i = 0; i < VOCAB.length; i++) if (VOCAB[i] && i !== BLANK) TOKID.set(VOCAB[i], i);
const MAXTOK = Math.max(...VOCAB.filter(Boolean).map((t) => t.length));
/* Characters the vocab can actually spell — anything else in a candidate
 * (Quranic annotation marks, dagger alef …) is unrepresentable and is
 * dropped, with the drop reported. */
const VOCAB_CHARS = new Set();
for (const t of VOCAB) if (t && !/^<.*>$/.test(t)) for (const ch of t) VOCAB_CHARS.add(ch);

export function sanitize(s) {
    const kept = [...String(s)].filter((ch) => VOCAB_CHARS.has(ch)).join("");
    const dropped = [...String(s)].filter((ch) => !VOCAB_CHARS.has(ch));
    return { kept, dropped };
}

/* ---------- CTC lattice forced-alignment (full sum over tokenisations) ---- */
const NEG = -Infinity;
function lse(a, b) {
    if (a === NEG) return b;
    if (b === NEG) return a;
    const m = a > b ? a : b;
    return m + Math.log1p(Math.exp(-Math.abs(a - b)));
}

/* Arcs: substring [i,j) of `s` that the vocab can emit as one token. */
function buildArcs(s) {
    const N = s.length;
    const arcs = [];
    const out = Array.from({ length: N + 1 }, () => []);
    const inn = Array.from({ length: N + 1 }, () => []);
    for (let i = 0; i < N; i++) {
        for (let L = 1; L <= MAXTOK && i + L <= N; L++) {
            const id = TOKID.get(s.slice(i, i + L));
            if (id === undefined) continue;
            const a = { u: i, v: i + L, id, k: arcs.length };
            arcs.push(a); out[i].push(a); inn[i + L].push(a);
        }
    }
    return { arcs, out, inn, N };
}

/* logP(string | logprobs[t0..t1]) — CTC forward, blanks between tokens,
 * repeats collapse, token→token only when the ids differ. */
export function ctcScore(lp, V, t0, t1, str) {
    const s = "▁" + str;                       // word-initial marker
    const { arcs, out, inn, N } = buildArcs(s);
    if (!arcs.length) return { logp: NEG, reachable: false, arcs: 0 };
    // reachability check: is position N reachable from 0 at all?
    const seen = new Uint8Array(N + 1); seen[0] = 1;
    for (let i = 0; i <= N; i++) if (seen[i]) for (const a of out[i]) seen[a.v] = 1;
    if (!seen[N]) return { logp: NEG, reachable: false, arcs: arcs.length };

    let A = new Float64Array(arcs.length).fill(NEG);
    let B = new Float64Array(N + 1).fill(NEG);
    const row = (t) => t * V;
    B[0] = lp[row(t0) + BLANK];
    for (const a of out[0]) A[a.k] = lp[row(t0) + a.id];

    for (let t = t0 + 1; t <= t1; t++) {
        const r = row(t);
        const nA = new Float64Array(arcs.length).fill(NEG);
        const nB = new Float64Array(N + 1).fill(NEG);
        // blank at v: stay in blank, or the token(s) ending at v just finished
        for (let v = 0; v <= N; v++) {
            let acc = B[v];
            for (const a of inn[v]) acc = lse(acc, A[a.k]);
            nB[v] = acc === NEG ? NEG : acc + lp[r + BLANK];
        }
        // token arc a=(u→v,x): repeat x, enter from blank@u, or from a
        // different-id arc ending at u
        for (const a of arcs) {
            let acc = A[a.k];
            acc = lse(acc, B[a.u]);
            for (const p of inn[a.u]) if (p.id !== a.id) acc = lse(acc, A[p.k]);
            nA[a.k] = acc === NEG ? NEG : acc + lp[r + a.id];
        }
        A = nA; B = nB;
    }
    let fin = B[N];
    for (const a of inn[N]) fin = lse(fin, A[a.k]);
    return { logp: fin, reachable: true, arcs: arcs.length, frames: t1 - t0 + 1 };
}

/* ---------- audio + model ---------- */
async function loadAll(wavPath) {
    const { rate, pcm: raw } = readWavMono(fs.readFileSync(wavPath).buffer);
    const pcm = resampleTo16k(raw, rate);
    const sess = await ort.InferenceSession.create(MODEL_PATH);
    return { pcm, sess, rate };
}

async function decodeAll(sess, pcm, startS = 0) {
    const { mel, T } = melFrontend(pcm);
    const out = await sess.run({
        audio_signal: new ort.Tensor("float32", mel, [1, NMEL, T]),
        length: new ort.Tensor("int64", BigInt64Array.from([BigInt(T)]), [1]),
    });
    const lpT = out[sess.outputNames[0]];
    const words = GREEDY(lpT.data, lpT.dims[1], lpT.dims[2], startS).words;
    return { lp: lpT.data, T: lpT.dims[1], V: lpT.dims[2], words };
}

/* ---------- commands ---------- */
if (cmd === "transcribe") {
    const { pcm, sess } = await loadAll(clipPath);
    const { words, T } = await decodeAll(sess, pcm);
    console.log(`# ${path.basename(clipPath)} — ${(pcm.length / 16000).toFixed(2)}s, ${T} frames, ${words.length} words (full-context single window)`);
    console.log(words.map((w) => `${w.text}[${w.startS.toFixed(2)}]`).join(" "));
    console.log("\n# plain:");
    console.log(words.map((w) => w.text).join(" "));
} else if (cmd === "probe") {
    const plants = JSON.parse(fs.readFileSync(argVal("--plants"), "utf8"));
    const { pcm, sess } = await loadAll(clipPath);
    const { lp, T, V, words } = await decodeAll(sess, pcm);
    const norm = words.map((w) => ({ ...w, n: tasmeeNorm(w.text) }));
    const results = [];
    for (const p of plants) {
        /* Locate by TIME first (hintS is read off this clip's own
         * full-context transcript), then break ties by closeness to any
         * candidate form. The reference timeline is never consulted. */
        const forms = Object.values(p.forms).map((f) => tasmeeNorm(f)).filter(Boolean);
        const tol = p.hintTol ?? 0.5;
        const inWin = norm.map((w, i) => ({ i, t: w.text, n: w.n, s: w.startS, e: w.endS }))
            .filter((c) => Math.abs(c.s - p.hintS) <= tol);
        if (!inWin.length) { results.push({ id: p.id, loc: p.loc, error: `no decoded word within ${tol}s of ${p.hintS}` }); continue; }
        const near = inWin.map((c) => ({ ...c, d: Math.min(...forms.map((f) => editDist(c.n, f))) }))
            .sort((a, b) => a.d - b.d || Math.abs(a.s - p.hintS) - Math.abs(b.s - p.hintS))[0];
        /* Span: from the word's first emitting frame to just before the NEXT
         * word starts — the greedy decoder's endS is the last NEW token, not
         * the acoustic end, so a neighbour-bounded span is required or the
         * word's tail (and its final haraka) falls outside the frames. */
        const nxt = norm[near.i + 1];
        const f0 = Math.max(0, Math.round(near.s / FRAME_S) - (p.pad ?? 1));
        const f1 = Math.min(T - 1, nxt ? Math.round(nxt.startS / FRAME_S) - 1
            : Math.round(near.e / FRAME_S) + 6);
        const row = { id: p.id, loc: p.loc, decoded: near.t, at: +near.s.toFixed(2), frames: [f0, f1], nFrames: f1 - f0 + 1, scores: {} };
        for (const [k, form] of Object.entries(p.forms)) {
            const { kept, dropped } = sanitize(form);
            const r = ctcScore(lp, V, f0, f1, kept);
            row.scores[k] = { form, scored: kept, dropped: dropped.join("") || null, logp: +r.logp.toFixed(3), reachable: r.reachable };
        }
        results.push(row);
    }
    console.log(JSON.stringify({ clip: path.basename(clipPath), frames: T, results }, null, 1));
} else if (cmd === "sweep") {
    /* NULL DISTRIBUTION for an acoustic haraka verifier.
     *
     * For every word the reciter got RIGHT (decoded skeleton == reference
     * skeleton), perturb ONE haraka of the canonical vocalised reference and
     * score both over that word's frames. Δ = logP(perturbed) − logP(correct)
     * is what a verifier would see on correct recitation — i.e. its
     * false-flag cost. The plants' Δ (measured separately) is the signal. */
    const range = argVal("--range") || "47:1-7";
    const exclude = new Set((argVal("--exclude") || "").split(",").filter(Boolean));
    const ref = buildVocalisedRef(range);
    const { pcm, sess } = await loadAll(clipPath);
    const { lp, T, V, words } = await decodeAll(sess, pcm);
    const pairs = alignMonotonic(words.map((w) => tasmeeNorm(w.text)), ref.map((r) => r.skel));
    const HARAKAT = ["َ", "ِ", "ُ", "ْ"];   // fatha kasra damma sukun
    /* CONTEXT SCORING (default). A word's frame span is only fuzzily known —
     * measured directly, Δ moved 7–9 nats when the span shifted by ONE frame,
     * which is larger than the effect being measured. So score the target word
     * INSIDE its neighbours ("prev▁cur▁next") over a generous span: both
     * candidates then share identical boundary conditions and the ambiguity
     * cancels. `--isolated` restores the naive single-word span. */
    const isolated = args.includes("--isolated");
    const rows = [];
    const byWordIdx = new Map(pairs.map(([wi, ri]) => [wi, ri]));
    for (const [wi, ri] of pairs) {
        const r = ref[ri];
        if (exclude.has(r.loc)) continue;
        if (tasmeeNorm(words[wi].text) !== r.skel) continue;      // recited+heard correctly
        const base = sanitize(r.vocal).kept;
        if (!base) continue;
        let pre = "", post = "", f0, f1;
        if (isolated) {
            f0 = Math.max(0, Math.round(words[wi].startS / FRAME_S) - 1);
            f1 = Math.min(T - 1, words[wi + 1] ? Math.round(words[wi + 1].startS / FRAME_S) - 1
                : Math.round(words[wi].endS / FRAME_S) + 6);
        } else {
            const pIdx = wi - 1, nIdx = wi + 1;
            pre = pIdx >= 0 && byWordIdx.has(pIdx) ? sanitize(ref[byWordIdx.get(pIdx)].vocal).kept : "";
            post = byWordIdx.has(nIdx) ? sanitize(ref[byWordIdx.get(nIdx)].vocal).kept : "";
            const startW = pre ? words[pIdx] : words[wi];
            const endNext = post ? words[nIdx + 1] : words[wi + 1];
            f0 = Math.max(0, Math.round(startW.startS / FRAME_S) - 1);
            f1 = Math.min(T - 1, endNext ? Math.round(endNext.startS / FRAME_S) - 1
                : Math.round((post ? words[nIdx] : words[wi]).endS / FRAME_S) + 6);
        }
        if (f1 - f0 < 2) continue;
        const wrap = (w) => [pre, w, post].filter(Boolean).join("▁");
        /* Span jitter: the same Δ recomputed over a family of nearby spans.
         * The MEDIAN is the robust statistic; the spread is the honest error
         * bar on every number this instrument produces. */
        const JIT = args.includes("--nojitter") ? [[0, 0]]
            : [[0, 0], [-2, 0], [2, 0], [0, -2], [0, 2], [-2, 2], [2, -2]];
        const spans = JIT.map(([d0, d1]) => [Math.max(0, f0 + d0), Math.min(T - 1, f1 + d1)])
            .filter(([x, y]) => y - x >= 2);
        const bases = spans.map(([x, y]) => ctcScore(lp, V, x, y, wrap(base)).logp);
        if (!bases.every(isFinite)) continue;
        for (let ci = 0; ci < base.length; ci++) {
            if (!HARAKAT.includes(base[ci])) continue;
            for (const h of HARAKAT) {
                if (h === base[ci]) continue;
                const variant = base.slice(0, ci) + h + base.slice(ci + 1);
                const ds = spans.map(([x, y], k) => ctcScore(lp, V, x, y, wrap(variant)).logp - bases[k])
                    .filter(isFinite).sort((p, q) => p - q);
                if (!ds.length) continue;
                rows.push({
                    loc: r.loc, word: base, pos: ci, from: base[ci], to: h,
                    d: +ds[Math.floor(ds.length / 2)].toFixed(2),
                    dMin: +ds[0].toFixed(2), dMax: +ds[ds.length - 1].toFixed(2),
                });
            }
        }
    }
    console.log(JSON.stringify({ clip: path.basename(clipPath), range, words: pairs.length, rows }, null, 0));
} else if (cmd === "tashkeel") {
    /* Instrument-free bound on ANY text-level haraka check: on words the
     * reciter got RIGHT, how often does the model's own decoded tashkeel
     * agree with the canonical? Whatever a text-level checker could do is
     * capped by this. */
    const range = argVal("--range") || "47:1-7";
    const ref = buildVocalisedRef(range);
    const { pcm, sess } = await loadAll(clipPath);
    const { words } = await decodeAll(sess, pcm);
    const pairs = alignMonotonic(words.map((w) => tasmeeNorm(w.text)), ref.map((r) => r.skel));
    const MARK = /[ً-ْٰ]/;
    const HAR = new Set(["َ", "ِ", "ُ", "ْ"]);
    const split = (s) => {                       // → [{c, h}] letters with their haraka
        const out = [];
        for (const ch of s) {
            if (MARK.test(ch)) { if (out.length && HAR.has(ch) && !out[out.length - 1].h) out[out.length - 1].h = ch; }
            else out.push({ c: ch, h: "" });
        }
        return out;
    };
    let words_ok = 0, cmp = 0, same = 0, missing = 0, differ = 0, extra = 0;
    let cmpI = 0, sameI = 0, missingI = 0, differI = 0;      // word-INTERNAL only (final vowel excluded)
    const wrongs = [];
    for (const [wi, ri] of pairs) {
        if (tasmeeNorm(words[wi].text) !== ref[ri].skel) continue;
        const a = split(sanitize(words[wi].text).kept), b = split(sanitize(ref[ri].vocal).kept);
        if (a.length !== b.length || a.some((x, i) => x.c !== b[i].c)) continue;  // letter strings must align
        words_ok++;
        for (let i = 0; i < b.length; i++) {
            const isFinal = i >= b.length - 1;   // case vowel: waqf legitimately drops/changes it
            if (!b[i].h) { if (a[i].h) extra++; continue; }
            cmp++;
            if (!isFinal) cmpI++;
            if (!a[i].h) { missing++; if (!isFinal) missingI++; }
            else if (a[i].h === b[i].h) { same++; if (!isFinal) sameI++; }
            else {
                differ++;
                if (!isFinal) { differI++; wrongs.push(`${ref[ri].loc} ${ref[ri].vocal}→${words[wi].text} @${i}(${b[i].h}→${a[i].h})`); }
            }
        }
    }
    console.log(JSON.stringify({
        clip: path.basename(clipPath), wordsCompared: words_ok,
        all: { positions: cmp, agree: same, omitted: missing, wrong: differ, spurious: extra, wrongRate: +(differ / cmp).toFixed(4) },
        internalOnly: { positions: cmpI, agree: sameI, omitted: missingI, wrong: differI, wrongRate: +(differI / cmpI).toFixed(4) },
        internalWrongCases: wrongs,
    }, null, 1));
} else if (cmd === "census") {
    /* Per-frame token ranks over each plant's span — the raw evidence behind
     * a lattice score, for the cases where the marginal is close. */
    const plants = JSON.parse(fs.readFileSync(argVal("--plants"), "utf8"));
    const K = Number(argVal("--top") || 5);
    const { pcm, sess } = await loadAll(clipPath);
    const { lp, T, V, words } = await decodeAll(sess, pcm);
    for (const p of plants) {
        const tol = p.hintTol ?? 0.5;
        const idx = words.findIndex((w) => Math.abs(w.startS - p.hintS) <= tol);
        if (idx < 0) { console.log(`${p.id}: not located`); continue; }
        const nxt = words[idx + 1];
        const f0 = Math.max(0, Math.round(words[idx].startS / FRAME_S) - (p.pad ?? 1));
        const f1 = Math.min(T - 1, nxt ? Math.round(nxt.startS / FRAME_S) - 1 : Math.round(words[idx].endS / FRAME_S) + 6);
        console.log(`\n### ${p.id} ${p.loc} — decoded "${words[idx].text}" @${words[idx].startS.toFixed(2)}s, frames ${f0}–${f1}`);
        for (let t = f0; t <= f1; t++) {
            const r = t * V;
            const top = [];
            for (let v = 0; v < V; v++) top.push([v, lp[r + v]]);
            top.sort((a, b) => b[1] - a[1]);
            const cells = top.slice(0, K).map(([v, x]) =>
                `${v === BLANK ? "∅" : JSON.stringify(VOCAB[v])}:${Math.exp(x).toFixed(3)}`);
            console.log(`  f${String(t).padStart(4)} (${(t * FRAME_S).toFixed(2)}s)  ${cells.join("  ")}`);
        }
    }
} else {
    console.error("usage: node scripts/tasmee-absorb.mjs transcribe|probe <clip.wav> [--plants f.json]");
    process.exit(2);
}

/* Canonical VOCALISED reference for a range, paired with the matcher's
 * skeleton dataset. quran.json carries pause marks and (in ayah 1) the
 * basmala that tasmee-words.json omits, so the two are aligned by
 * tasmeeNorm rather than by index. */
function buildVocalisedRef(range) {
    const m = /^(\d+):(\d+)-(\d+)$/.exec(range);
    if (!m) throw new Error(`bad --range ${range}`);
    const [, sN, aFrom, aTo] = m.map(Number);
    const q = JSON.parse(fs.readFileSync(path.join(ROOT, "public", "quran.json"), "utf8").replace(/^﻿/, ""));
    const ds = JSON.parse(fs.readFileSync(path.join(ROOT, "public", "tasmee-words.json"), "utf8"));
    const sur = q.data.surahs.find((x) => x.number === sN);
    const out = [];
    for (let a = aFrom; a <= aTo; a++) {
        const skels = ds.verses[`${sN}:${a}`] || [];
        const toks = sur.ayahs.find((x) => x.numberInSurah === a).text.replace(/^﻿/, "").split(/\s+/);
        let si = 0;
        for (const t of toks) {
            const n = tasmeeNorm(t);
            if (!n) continue;                                   // pause marks
            while (si < skels.length && skels[si] !== n) si++;   // skip basmala etc.
            if (si >= skels.length) { si = skels.findIndex((s) => s === n); if (si < 0) continue; }
            out.push({ loc: `${sN}:${a}:${si + 1}`, skel: skels[si], vocal: t });
            si++;
        }
    }
    return out;
}

/* Monotonic alignment of two token sequences on exact equality (LCS). */
function alignMonotonic(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const pairs = [];
    let i = 0, j = 0;
    while (i < m && j < n) {
        if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
        else j++;
    }
    return pairs;
}

function editDist(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
        const cur = [i];
        for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = cur;
    }
    return prev[n];
}
