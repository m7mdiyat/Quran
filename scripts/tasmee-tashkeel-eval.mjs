/* Does the LIVE harakat check actually catch mistakes?
 *
 * It is free — it reads the diacritics the FastConformer already emits in
 * the live path, so it costs no model, no download and no heat. Its own
 * notes claim 0.10–0.47% error when it speaks, and silence 38–65% of the
 * time. Neither number has been checked against a recitation with KNOWN
 * harakat mistakes in it, which is the only question that matters for
 * making it the live layer.
 *
 *   node scripts/tasmee-tashkeel-eval.mjs <clip.wav> --page NNN [--truth a:b:c,...]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { tasmeeNorm } from "../src/tasmee-norm.js";
import { createTasmeeSession } from "../src/tasmee-engine.js";
import { createStreamController } from "../src/tasmee-stream.js";
import { checkTashkeel } from "../src/tasmee-tashkeel.js";
import { readWavMono, resampleTo16k, melFrontend, makeGreedyDecoder, NMEL, buildVad } from "../src/tasmee-pipeline.js";
import { TASMEE_LIVE } from "../src/tasmee-live-config.js";

const require = createRequire(import.meta.url);
const ort = require("onnxruntime-node");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const clip = args.find((a) => !a.startsWith("--"));
const argVal = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const page = Number(argVal("--page"));
const truth = new Set((argVal("--truth") || "").split(",").filter(Boolean));

const DATA = JSON.parse(fs.readFileSync(`${ROOT}/public/tasmee-words.json`, "utf8"));
const pd = JSON.parse(fs.readFileSync(`${ROOT}/public/data/qcf4/pages/${String(page).padStart(3, "0")}.json`, "utf8"));
const ref = [];
for (const line of pd.lines || []) for (const w of line.words || []) {
    if (w.type !== "word" || String(w.text || "").startsWith("#")) continue;
    const form = DATA.verses[w.verse_key]?.[w.position - 1];
    if (form) ref.push({ vk: w.verse_key, pos: w.position, form, vocal: String(w.text || "") });
}

const buf = fs.readFileSync(clip);
const { rate, pcm: raw } = readWavMono(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const real = resampleTo16k(raw, rate);
const pcm = new Float32Array(real.length + Math.round(TASMEE_LIVE.tailPadS * 16000));
pcm.set(real, 0);
const vocabJson = JSON.parse(fs.readFileSync(`${ROOT}/public/models/tasmee/vocab.json`, "utf8"));
const VOCAB = []; for (const [id, tok] of Object.entries(vocabJson)) VOCAB[Number(id)] = tok;
const BLANK = VOCAB.indexOf("<blank>") >= 0 ? VOCAB.indexOf("<blank>") : VOCAB.length - 1;
const GREEDY = makeGreedyDecoder(VOCAB, BLANK);
const sess = await ort.InferenceSession.create(`${ROOT}/models/tasmee/fastconformer_ar_ctc_q8pc-head.onnx`);
const { isSpeech, findSilenceBefore } = buildVad(pcm, { policy: TASMEE_LIVE.vadPolicy });

const results = [];
const session = createTasmeeSession({
    words: ref, options: TASMEE_LIVE.engine,
    onEvent: (e) => {
        if (e.type !== "reveal" || e.verdict !== "correct") return;
        const r = ref[e.idx];
        // EXACTLY what the live UI does: compare only what the model volunteered
        const v = checkTashkeel(r.vocal, e.heardRaw);
        results.push({ loc: `${r.vk}:${r.pos}`, word: r.vocal, state: v && v.state, detail: v });
    },
});
const ctl = createStreamController({
    session,
    decode: async (s, e) => {
        const a = pcm.subarray(Math.floor(s * 16000), Math.floor(e * 16000));
        const { mel, T } = melFrontend(a);
        const out = await sess.run({
            audio_signal: new ort.Tensor("float32", mel, [1, NMEL, T]),
            length: new ort.Tensor("int64", BigInt64Array.from([BigInt(T)]), [1]),
        });
        const lp = out[sess.outputNames[0]];
        return GREEDY(lp.data, lp.dims[1], lp.dims[2], s).words;
    },
    isSpeech, findSilenceBefore, norm: tasmeeNorm, ...TASMEE_LIVE.controller,
});
const endS = pcm.length / 16000;
for (let t = TASMEE_LIVE.stepS; t < endS + TASMEE_LIVE.stepS; t += TASMEE_LIVE.stepS) await ctl.step(Math.min(t, endS));
ctl.flush(endS); session.stop(Math.round(endS * 1000));

const by = (s) => results.filter((r) => r.state === s);
const bad = by("mismatch"), ok = by("match"), quiet = results.filter((r) => r.state !== "mismatch" && r.state !== "match");
console.log(`\n  ${path.basename(clip)} · page ${page} · ${ref.length} ref words · ${results.length} revealed correct`);
console.log(`  the check SPOKE on ${ok.length + bad.length} (${((ok.length + bad.length) / Math.max(results.length, 1) * 100).toFixed(0)}%) · stayed silent on ${quiet.length}`);
console.log(`  said MATCH ${ok.length} · said MISMATCH ${bad.length}\n`);
if (bad.length) {
    console.log("  flagged:");
    for (const r of bad) {
        const hit = truth.size ? (truth.has(r.loc) ? "  ← PLANTED" : "  ← not planted") : "";
        console.log(`    ${r.loc.padEnd(10)} ${r.word}${hit}`);
    }
}
if (truth.size) {
    const caught = [...truth].filter((t) => bad.some((b) => b.loc === t));
    const missed = [...truth].filter((t) => !bad.some((b) => b.loc === t));
    const extra = bad.filter((b) => !truth.has(b.loc));
    console.log(`\n  caught ${caught.length}/${truth.size} planted · ${extra.length} extra on ${results.length - truth.size} other words`);
    if (missed.length) console.log(`  missed: ${missed.join(", ")}`);
}
