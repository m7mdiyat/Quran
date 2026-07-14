/* Shared fixture helpers for the Gate 2 engine tests.
 * Reference sequences come from the REAL public/tasmee-words.json
 * (Gate 1 artifact) so the tests exercise the exact forms the
 * runtime will match against — no hand-typed approximations. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DATA = JSON.parse(
    fs.readFileSync(path.join(ROOT, "public", "tasmee-words.json"), "utf8")
);

/* refFor("2:6-10", "55:19", …) → [{vk, pos, form}] in recitation
 * order. Ranges are within one surah: "s:a" or "s:from-to".
 * Sajda nulls are skipped (the UI layer does the same). */
export function refFor(...ranges) {
    const out = [];
    for (const r of ranges) {
        const m = /^(\d+):(\d+)(?:-(\d+))?$/.exec(r);
        if (!m) throw new Error(`bad range ${r}`);
        const s = Number(m[1]), from = Number(m[2]), to = Number(m[3] || m[2]);
        for (let a = from; a <= to; a++) {
            const arr = DATA.verses[`${s}:${a}`];
            if (!arr) throw new Error(`missing verse ${s}:${a}`);
            arr.forEach((form, i) => {
                if (form) out.push({ vk: `${s}:${a}`, pos: i + 1, form });
            });
        }
    }
    return out;
}

/* The "perfect recitation" token stream: the forms themselves. */
export const tokensOf = (ref) => ref.map((w) => w.form);

/* Feed a token stream with a monotonically increasing clock. */
export function feed(session, tokens, { startMs = 0, stepMs = 400 } = {}) {
    let t = startMs;
    for (const tok of tokens) {
        session.feedToken(tok, t);
        t += stepMs;
    }
    return t;
}

/* verdict map "vk:pos" → verdict|null, for compact assertions. */
export function verdicts(session) {
    const m = {};
    for (const w of session.getWords()) m[`${w.vk}:${w.pos}`] = w.verdict;
    return m;
}

export const count = (session, type) =>
    session.getEvents().filter((e) => e.type === type).length;

export const mistakes = (session) => {
    const s = session.summary();
    return s.counts.substituted + s.counts.skipped + s.counts.insertions;
};

/* Deterministic PRNG (mulberry32) — engine tests must be
 * reproducible; no Math.random. */
export function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const AR = [..."ابتثجحخدذرزسشصضطظعغفقكلمنهوي"];

/* Corrupt a perfect token stream at ~wer rate with a 50/30/20 mix
 * of char-substitutions / dropped tokens / inserted garbage —
 * a crude but deterministic stand-in for ASR errors. */
export function corrupt(tokens, wer, seed) {
    const r = rng(seed);
    const out = [];
    for (const tok of tokens) {
        const roll = r();
        if (roll < wer * 0.5 && tok.length > 2) {
            const i = Math.floor(r() * tok.length);
            const c = AR[Math.floor(r() * AR.length)];
            out.push(tok.slice(0, i) + c + tok.slice(i + 1)); // char sub
        } else if (roll < wer * 0.8) {
            // dropped token (ASR missed the word entirely)
        } else if (roll < wer) {
            out.push(tok);
            out.push(AR.slice(0, 3 + Math.floor(r() * 3)).join("")); // garbage insert
        } else {
            out.push(tok);
        }
    }
    return out;
}
