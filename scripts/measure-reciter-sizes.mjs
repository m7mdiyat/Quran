// Measures the on-GCS byte size of every reciter's full per-surah engine assets
// (114 surah MP3s + 114 timings JSONs) and writes public/reciter-audio-sizes.json.
//
// This manifest powers the offline "download reciters" section's live total-size
// calculation (instant + accurate, vs 114 HEAD requests per reciter at runtime).
// Ships in the app bundle (small JSON) so sizes are known even offline.
//
// Run after adding/changing a reciter's audio:  node scripts/measure-reciter-sizes.mjs
// Requires Node >= 18 (global fetch).

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "public", "reciter-audio-sizes.json");

const AUDIO_BASE = "https://storage.googleapis.com/m7mdiyat-tafsir-data/audio/surah";
const TIMINGS_BASE = "https://storage.googleapis.com/m7mdiyat-tafsir-data/timings";

// Keep in sync with RECITERS / RECITER_ORDER in src/app.js.
const RECITERS = ["alijaber", "shuraim", "ayoub", "qasim", "dosari", "luhaidan"];
const SURAHS = Array.from({ length: 114 }, (_, i) => i + 1);
const CONCURRENCY = 24;

async function headLen(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { method: "HEAD" });
      if (!res.ok) return { ok: false, len: 0, status: res.status };
      const len = Number(res.headers.get("content-length") || 0);
      return { ok: true, len, status: 200 };
    } catch {
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  return { ok: false, len: 0, status: 0 };
}

async function pool(items, worker) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await worker(items[idx], idx);
      }
    }),
  );
  return out;
}

async function measureReciter(reciter) {
  const urls = [];
  for (const s of SURAHS) {
    urls.push({ kind: "audio", url: `${AUDIO_BASE}/${reciter}/${String(s).padStart(3, "0")}.mp3` });
    urls.push({ kind: "timings", url: `${TIMINGS_BASE}/${reciter}/${s}.json` });
  }
  const results = await pool(urls, async (u) => ({ ...u, ...(await headLen(u.url)) }));
  let audio = 0, timings = 0, missing = 0;
  for (const r of results) {
    if (!r.ok) { missing++; continue; }
    if (r.kind === "audio") audio += r.len;
    else timings += r.len;
  }
  return { audio, timings, total: audio + timings, files: results.length, missing };
}

async function main() {
  const manifest = {};
  for (const reciter of RECITERS) {
    process.stdout.write(`measuring ${reciter}… `);
    const m = await measureReciter(reciter);
    manifest[reciter] = m;
    console.log(
      `${(m.total / 1073741824).toFixed(2)} GB  (audio ${(m.audio / 1048576).toFixed(0)} MB, timings ${(m.timings / 1024).toFixed(0)} KB, missing ${m.missing})`,
    );
  }
  const payload = { generated: "static", base: AUDIO_BASE, reciters: manifest };
  await writeFile(OUT, JSON.stringify(payload, null, 2) + "\n");
  console.log(`\nWrote ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
