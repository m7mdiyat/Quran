#!/usr/bin/env node
/**
 * build-app.js
 * Creates a lean app-specific build for the Capacitor wrapper.
 * Run from m7mdiyat-vite root: node scripts/build-app.js
 *
 * Bundled data files are shipped as plain .json (not gzipped). The Capacitor
 * iOS local-server bridge does NOT transparently remap foo.json → foo.json.gz
 * the way Android's WebViewLocalServer does, so gzipping in the bundle breaks
 * iOS while loadJson() always requests plain paths.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist');
const DIST_APP = path.join(ROOT, 'dist-app');

console.log('📦 Building m7mdiyat for app...\n');

// Step 1: Run normal Vite build
console.log('Step 1/3: Running Vite build...');
execSync('npm run build', { stdio: 'inherit' });
console.log('✅ Vite build complete\n');

// Step 2: Copy dist → dist-app
console.log('Step 2/3: Copying to dist-app...');
if (fs.existsSync(DIST_APP)) {
  fs.rmSync(DIST_APP, { recursive: true });
}
fs.cpSync(DIST, DIST_APP, { recursive: true });
console.log('✅ Copied\n');

// Step 3: Remove unnecessary files
console.log('Step 3/3: Removing unnecessary files...');

const toRemove = [
  // QCF4 Mushaf assets — fetched from GCS at runtime
  path.join(DIST_APP, 'fonts', 'qcf4'),
  path.join(DIST_APP, 'data', 'qcf4'),
  path.join(DIST_APP, 'Qayim'),

  // Pre-rendered SEO pages — zero value in app
  path.join(DIST_APP, 'read'),

  // Hadith collections — already on GCS, fetched on demand
  path.join(DIST_APP, 'Bukhari.json'),
  path.join(DIST_APP, 'Muslim.json'),

  // Tafsir books + comparisons summary — all served from the GCS bucket
  // (m7mdiyat-tafsir-data) via tafsirAssetFetch() and cached into the Cache API.
  // The runtime never loads these from the bundle, so they're dead weight (~150MB
  // plain / ~28MB gzipped) that just inflates the APK/IPA.
  path.join(DIST_APP, 'tafseer_muyassar.json'),
  path.join(DIST_APP, 'tafseer_saadi.json'),
  path.join(DIST_APP, 'tafseer_tabari.json'),
  path.join(DIST_APP, 'tafseer_ibn_kathir.json'),
  path.join(DIST_APP, 'tafseer_qurtubi.json'),
  path.join(DIST_APP, 'tafseer_baghawi.json'),
  path.join(DIST_APP, 'tafseer_ibn_ashur.json'),
  path.join(DIST_APP, 'comparisons.json'),

  // SEO files useless in app
  path.join(DIST_APP, 'sitemap.xml'),
  path.join(DIST_APP, 'og-image.png'),
  path.join(DIST_APP, 'robots.txt'),
];

// Also remove numbered folders (pre-rendered ayah pages)
const entries = fs.readdirSync(DIST_APP);
for (const entry of entries) {
  if (/^\d+$/.test(entry)) {
    toRemove.push(path.join(DIST_APP, entry));
  }
}

let savedMB = 0;
for (const target of toRemove) {
  if (fs.existsSync(target)) {
    const sizeMB = getDirSizeMB(target);
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`  🗑️  Removed ${path.relative(DIST_APP, target)} (${sizeMB}MB)`);
    savedMB += sizeMB;
  }
}

// Final size report
const finalMB = getDirSizeMB(DIST_APP);
console.log(`\n✅ Done!`);
console.log(`   Removed:    ~${savedMB}MB`);
console.log(`   Final size: ~${finalMB}MB`);
console.log(`   Output:     dist-app/`);
console.log(`\nNext step: npx cap sync ios && npx cap sync android (from the Capacitor wrapper)`);

function getDirSizeMB(dirPath) {
  try {
    const result = execSync(`du -sm "${dirPath}" 2>/dev/null | cut -f1`, {
      encoding: 'utf8'
    }).trim();
    return parseInt(result) || 0;
  } catch {
    return 0;
  }
}
