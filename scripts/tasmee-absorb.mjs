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
} else if (cmd === "gop") {
    /* GOODNESS OF PRONUNCIATION — the standard mispronunciation-detection
     * measure, adapted to this CTC model. For each reference word:
     *
     *   GOP = [ logP(canonical | frames) − logP(free | frames) ] / nFrames
     *
     * The numerator is a CTC forced alignment of the canonical form; the
     * denominator is the unconstrained per-frame best path. Both run over
     * the SAME frames, so everything except "how well does the audio support
     * this exact word" cancels — including the segmentation uncertainty that
     * made the earlier candidate-vs-candidate scoring unreliable (Δ moved
     * 7–9 nats on a one-frame shift).
     *
     * Word boundaries come from a Viterbi forced alignment of the WHOLE
     * reference over the whole clip, so no span has to be guessed.
     *
     * Two lattices per word:
     *   letters — the skeleton, with harakat OPTIONAL (a u→u arc for each
     *             diacritic token). The model omits vowels 38–65% of the
     *             time; requiring them would punish correct recitation.
     *   full    — the vocalised form, harakat REQUIRED. The harakat test.
     */
    const range = argVal("--range") || "47:1-7";
    const plantSet = new Set((argVal("--plants") ? JSON.parse(fs.readFileSync(argVal("--plants"), "utf8")) : []).map((p) => p.loc));
    const ref = buildVocalisedRef(range);
    const { pcm, sess } = await loadAll(clipPath);
    const { lp, T, V } = await decodeAll(sess, pcm);

    const HAR_IDS = ["\u064e", "\u0650", "\u064f", "\u0652", "\u0651"].map((h) => TOKID.get(h)).filter((x) => x !== undefined);
    const strip = (w) => sanitize(w).kept.replace(/[\u064b-\u0670]/g, "");

    /* Position lattice for a whole word sequence, joined by the vocab's
     * word-initial marker. `optHar` adds zero-advance arcs so a diacritic
     * the model emits (or omits) costs nothing either way. */
    function lattice(words, optHar) {
        const bounds = [];
        let str = "";
        for (const w of words) { const st = str.length + 1; str += "\u2581" + w; bounds.push([st, str.length]); }
        const { arcs, out, inn, N } = buildArcs(str);
        if (optHar) {
            for (let u = 0; u <= N; u++) for (const id of HAR_IDS) {
                const a = { u, v: u, id, k: arcs.length };
                arcs.push(a); out[u].push(a); inn[u].push(a);
            }
        }
        return { arcs, out, inn, N, bounds };
    }

    /* Viterbi over the lattice; returns the per-frame (position, score). */
    function align(L, t0, t1) {
        const { arcs, out, inn, N } = L;
        const S = N + 1 + arcs.length;                 // 0..N = blank@pos, then arcs
        const NEGI = -Infinity;
        let cur = new Float64Array(S).fill(NEGI);
        const bp = [];
        cur[0] = lp[t0 * V + BLANK];
        for (const a of out[0]) cur[N + 1 + a.k] = lp[t0 * V + a.id];
        for (let t = t0 + 1; t <= t1; t++) {
            const nxt = new Float64Array(S).fill(NEGI);
            const back = new Int32Array(S).fill(-1);
            const r = t * V;
            for (let v = 0; v <= N; v++) {
                let best = cur[v], bi = v;
                for (const a of inn[v]) { const c = cur[N + 1 + a.k]; if (c > best) { best = c; bi = N + 1 + a.k; } }
                if (best > NEGI) { nxt[v] = best + lp[r + BLANK]; back[v] = bi; }
            }
            for (const a of arcs) {
                let best = cur[N + 1 + a.k], bi = N + 1 + a.k;
                if (cur[a.u] > best) { best = cur[a.u]; bi = a.u; }
                for (const p of inn[a.u]) if (p.id !== a.id) { const c = cur[N + 1 + p.k]; if (c > best) { best = c; bi = N + 1 + p.k; } }
                if (best > NEGI) { nxt[N + 1 + a.k] = best + lp[r + a.id]; back[N + 1 + a.k] = bi; }
            }
            bp.push(back); cur = nxt;
        }
        let end = N, bestv = cur[N];
        for (const a of inn[N]) { const c = cur[N + 1 + a.k]; if (c > bestv) { bestv = c; end = N + 1 + a.k; } }
        if (!isFinite(bestv)) return null;
        const path = new Int32Array(t1 - t0 + 1);
        let st = end;
        for (let i = bp.length - 1; i >= 0; i--) { path[i + 1] = st; st = bp[i][st]; }
        path[0] = st;
        const posOf = (state) => state <= N ? state : arcs[state - N - 1].v;
        const tokOf = (state) => state <= N ? BLANK : arcs[state - N - 1].id;
        return { score: bestv, pos: Array.from(path, posOf), tok: Array.from(path, tokOf) };
    }

    const freeAt = (t) => { let m = -Infinity; const r = t * V; for (let v = 0; v < V; v++) if (lp[r + v] > m) m = lp[r + v]; return m; };

    // 1) align the SKELETON of the whole clip → per-word frame spans
    const skel = ref.map((r) => strip(r.vocal) || "\u0627");   // never filter: index alignment with `ref` is load-bearing
    const L = lattice(skel, true);
    const A = align(L, 0, T - 1);
    if (!A) { console.error("alignment failed"); process.exit(1); }
    const spans = L.bounds.map(([cs, ce]) => {
        let f0 = -1, f1 = -1;
        for (let i = 0; i < A.pos.length; i++) { const p = A.pos[i]; if (p > cs && p <= ce) { if (f0 < 0) f0 = i; f1 = i; } }
        return [f0, f1];
    });

    // 2) per-word GOP, letters-only and letters+harakat
    const rows = [];
    for (let i = 0; i < ref.length && i < spans.length; i++) {
        const [f0, f1] = spans[i];
        if (f0 < 0 || f1 - f0 < 1) { rows.push({ loc: ref[i].loc, word: ref[i].vocal, skip: "no-span" }); continue; }
        let free = 0; for (let t = f0; t <= f1; t++) free += freeAt(t);
        const n = f1 - f0 + 1;
        /* Word-mean GOP dilutes a single bad letter across the whole word
         * (one wrong consonant is 1–2 frames out of ~25). The per-frame
         * MINIMUM and the mean of the worst three frames localise it, which
         * is why phone-level rather than word-level GOP is the standard. */
        const one = (w, opt) => {
            const l = lattice([w], opt);
            const a = align(l, f0, f1);
            if (!a) return null;
            const per = [];
            for (let t = f0; t <= f1; t++) per.push(lp[t * V + a.tok[t - f0]] - freeAt(t));
            const srt = [...per].sort((x, y) => x - y);
            return { mean: (a.score - free) / n, min: srt[0], w3: srt.slice(0, 3).reduce((x, y) => x + y, 0) / Math.min(3, srt.length) };
        };
        const L1 = one(strip(ref[i].vocal), true), F1 = one(sanitize(ref[i].vocal).kept, false);
        /* DISCRIMINATION TEST: can the model tell the true word from a
         * one-letter variant of it, on audio we KNOW is correct? Scores the
         * canonical against single-letter substitutions over the SAME frames
         * and reports the canonical's rank. If the canonical does not win,
         * the model cannot resolve single letters — independent of any
         * question about what a given reciter actually said. */
        if (args.includes("--variants")) {
            const sk = strip(ref[i].vocal);
            const CONF = { "ر": "لن", "ل": "رن", "د": "لذ", "ن": "رل", "ه": "كح", "ك": "هق", "ت": "يث", "ي": "تب",
                           "م": "نب", "ب": "تن", "س": "شص", "ح": "خه", "ع": "غا", "ق": "كف", "ط": "تظ", "ص": "سض" };
            const vs = [];
            for (let c = 0; c < sk.length; c++) for (const alt of (CONF[sk[c]] || "")) {
                const v = sk.slice(0, c) + alt + sk.slice(c + 1);
                const r = one(v, true);
                if (r) vs.push(r.w3);
            }
            const row = rows;   // appended below
            var _disc = vs.length ? { nVar: vs.length, best: Math.max(...vs), canon: L1 && L1.w3,
                                      rank: vs.filter((x) => x > (L1 ? L1.w3 : -Infinity)).length + 1 } : null;
            /* Same relative test for HARAKAT: change one vowel of the
             * vocalised form and see whether the audio prefers it. The
             * word-FINAL vowel is excluded — waqf legitimately changes it. */
            const voc = sanitize(ref[i].vocal).kept;
            const HARS = ["\u064e", "\u0650", "\u064f", "\u0652"];
            const letters = [...voc].map((ch, k) => ({ ch, k })).filter((x) => !/[\u064b-\u0670]/.test(x.ch));
            const lastLetterAt = letters.length ? letters[letters.length - 1].k : -1;
            const hv = [];
            for (let c = 0; c < voc.length; c++) {
                if (!HARS.includes(voc[c])) continue;
                if (c > lastLetterAt) continue;                  // final vowel: waqf, never judged
                for (const alt of HARS) {
                    if (alt === voc[c]) continue;
                    const r = one(voc.slice(0, c) + alt + voc.slice(c + 1), false);
                    if (r) hv.push(r.w3);
                }
            }
            var _hdisc = hv.length ? { nVar: hv.length, best: Math.max(...hv), canon: F1 && F1.w3 } : null;
        }
        rows.push({
            loc: ref[i].loc, word: ref[i].vocal, n,
            gopL: L1 && L1.mean, gopLmin: L1 && L1.min, gopLw3: L1 && L1.w3,
            gopF: F1 && F1.mean, gopFmin: F1 && F1.min, gopFw3: F1 && F1.w3,
            plant: plantSet.has(ref[i].loc),
            ...(args.includes("--variants") ? { disc: _disc, hdisc: _hdisc } : {}),
        });
    }
    console.log(JSON.stringify({ clip: path.basename(clipPath), frames: T, rows }, null, 0));
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
    const q = JSON.parse(fs.readFileSync(path.join(ROOT, "public", "quran.json"), "utf8").replace(/^\ufeff/, ""));
    const ds = JSON.parse(fs.readFileSync(path.join(ROOT, "public", "tasmee-words.json"), "utf8"));
    const sur = q.data.surahs.find((x) => x.number === sN);
    const out = [];
    for (let a = aFrom; a <= aTo; a++) {
        const skels = ds.verses[`${sN}:${a}`] || [];
        const toks = sur.ayahs.find((x) => x.numberInSurah === a).text.replace(/^\ufeff/, "")
            .split(/\s+/).filter((t) => tasmeeNorm(t));
        /* LCS-align quran.json tokens to the dataset skeletons rather than
         * scanning forward for the next equal form. The scan mis-consumed
         * ayah 1 of a surah, where quran.json carries the BASMALA that
         * tasmee-words.json omits: its اللَّهِ greedily claimed the ayah's
         * own الله six positions later, shifting every span after it. */
        const pairs = alignMonotonic(toks.map(tasmeeNorm), skels);
        for (const [ti, si] of pairs) out.push({ loc: `${sN}:${a}:${si + 1}`, skel: skels[si], vocal: toks[ti] });
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
