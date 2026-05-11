/**
 * Download the QCF4 Madinah Mushaf dataset into public/.
 *
 * Sources from https://github.com/MohamadHajjRabee/quran-qcf4 (raw.githubusercontent.com).
 * Idempotent: skips files that already exist with non-zero size.
 *
 * Outputs:
 *   public/fonts/qcf4/QCF4_Hafs_01_W.woff2 ... QCF4_Hafs_47_W.woff2, QCF4_QBSML.woff2
 *   public/data/qcf4/index.json
 *   public/data/qcf4/verses.json
 *   public/data/qcf4/font-map.json
 *   public/data/qcf4/pages/001.json ... 604.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const FONT_DIR = path.join(PUBLIC, 'fonts', 'qcf4');
const DATA_DIR = path.join(PUBLIC, 'data', 'qcf4');
const PAGES_DIR = path.join(DATA_DIR, 'pages');

const RAW = 'https://raw.githubusercontent.com/MohamadHajjRabee/quran-qcf4/main';

const CONCURRENCY = 16;

fs.mkdirSync(FONT_DIR, { recursive: true });
fs.mkdirSync(PAGES_DIR, { recursive: true });

async function downloadOne(url, destPath) {
    if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
        return { skipped: true };
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const tmp = destPath + '.part';
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, destPath);
    return { bytes: buf.length };
}

async function runPool(tasks, concurrency) {
    let i = 0;
    let done = 0;
    let skipped = 0;
    let failed = 0;
    const total = tasks.length;
    async function worker() {
        while (i < tasks.length) {
            const idx = i++;
            const t = tasks[idx];
            try {
                const r = await downloadOne(t.url, t.dest);
                if (r.skipped) skipped++; else done++;
                if ((done + skipped) % 50 === 0 || done + skipped === total) {
                    process.stdout.write(`\r  ${done + skipped}/${total} (downloaded ${done}, skipped ${skipped})`);
                }
            } catch (e) {
                failed++;
                process.stderr.write(`\n  FAIL ${t.url}: ${e.message}\n`);
            }
        }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    process.stdout.write('\n');
    return { done, skipped, failed };
}

async function main() {
    // 1. Fonts (47 hafs + QBSML)
    console.log('Fonts:');
    const fontTasks = [];
    for (let i = 1; i <= 47; i++) {
        const name = `QCF4_Hafs_${String(i).padStart(2, '0')}_W.woff2`;
        fontTasks.push({ url: `${RAW}/fonts-woff2/${name}`, dest: path.join(FONT_DIR, name) });
    }
    fontTasks.push({ url: `${RAW}/fonts-woff2/QCF4_QBSML.woff2`, dest: path.join(FONT_DIR, 'QCF4_QBSML.woff2') });
    const fontRes = await runPool(fontTasks, CONCURRENCY);
    console.log(`  fonts: downloaded=${fontRes.done} skipped=${fontRes.skipped} failed=${fontRes.failed}`);

    // 2. Index / verses / font-map
    console.log('Index files:');
    const indexTasks = [
        { url: `${RAW}/index.json`, dest: path.join(DATA_DIR, 'index.json') },
        { url: `${RAW}/verses.json`, dest: path.join(DATA_DIR, 'verses.json') },
        { url: `${RAW}/font-map.json`, dest: path.join(DATA_DIR, 'font-map.json') },
    ];
    const idxRes = await runPool(indexTasks, 3);
    console.log(`  index: downloaded=${idxRes.done} skipped=${idxRes.skipped} failed=${idxRes.failed}`);

    // 3. Pages 001-604
    console.log('Pages:');
    const pageTasks = [];
    for (let p = 1; p <= 604; p++) {
        const name = `${String(p).padStart(3, '0')}.json`;
        pageTasks.push({ url: `${RAW}/pages/${name}`, dest: path.join(PAGES_DIR, name) });
    }
    const pageRes = await runPool(pageTasks, CONCURRENCY);
    console.log(`  pages: downloaded=${pageRes.done} skipped=${pageRes.skipped} failed=${pageRes.failed}`);

    if (fontRes.failed + idxRes.failed + pageRes.failed > 0) {
        console.error('Some downloads failed. Re-run to retry.');
        process.exit(1);
    }
    console.log('Done.');
}

main().catch((e) => { console.error(e); process.exit(1); });
