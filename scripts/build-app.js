#!/usr/bin/env node
/**
 * build-app.js
 * Creates a lean app-specific build targeting ~45MB.
 * Run from m7mdiyat-vite root: node scripts/build-app.js
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist');
const DIST_APP = path.join(ROOT, 'dist-app');

console.log('📦 Building m7mdiyat for app...\n');

// Step 1: Run normal Vite build
console.log('Step 1/4: Running Vite build...');
execSync('npm run build', { stdio: 'inherit' });
console.log('✅ Vite build complete\n');

// Step 2: Copy dist → dist-app
console.log('Step 2/4: Copying to dist-app...');
if (fs.existsSync(DIST_APP)) {
  fs.rmSync(DIST_APP, { recursive: true });
}
fs.cpSync(DIST, DIST_APP, { recursive: true });
console.log('✅ Copied\n');

// Step 3: Remove unnecessary files
console.log('Step 3/4: Removing unnecessary files...');

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

// Step 4: Compress all JSON files in place
console.log('\nStep 4/4: Compressing JSON files...');

const jsonFiles = findJsonFiles(DIST_APP);
let compressedCount = 0;
let compressionSavedMB = 0;

for (const jsonFile of jsonFiles) {
  const original = fs.readFileSync(jsonFile);
  const originalSize = original.length;

  // Skip tiny files (under 100KB) — not worth compressing
  if (originalSize < 100 * 1024) continue;

  const compressed = zlib.gzipSync(original, { level: 9 });
  const compressedSize = compressed.length;
  const savedBytes = originalSize - compressedSize;
  const savedFileMB = savedBytes / (1024 * 1024);

  // Write compressed file alongside original
  fs.writeFileSync(jsonFile + '.gz', compressed);
  fs.unlinkSync(jsonFile); // remove original

  const ratio = Math.round((1 - compressedSize / originalSize) * 100);
  console.log(`  📦 ${path.relative(DIST_APP, jsonFile)}: ${(originalSize/1024/1024).toFixed(1)}MB → ${(compressedSize/1024/1024).toFixed(1)}MB (${ratio}% smaller)`);
  compressedCount++;
  compressionSavedMB += savedFileMB;
}

// Final size report
const finalMB = getDirSizeMB(DIST_APP);
console.log(`\n✅ Done!`);
console.log(`   Removed:    ~${savedMB}MB`);
console.log(`   Compressed: ~${Math.round(compressionSavedMB)}MB saved from ${compressedCount} JSON files`);
console.log(`   Final size: ~${finalMB}MB`);
console.log(`   Output:     dist-app/`);
console.log(`\n⚠️  IMPORTANT: Your app's JS code must request .json.gz files`);
console.log(`   OR add this to your Android web server config to serve .gz transparently.`);
console.log(`   See README for details.`);
console.log(`\nNext step: Update capacitor.config.json webDir to dist-app, then run: npx cap sync android`);

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

function findJsonFiles(dir) {
  const results = [];
  const items = fs.readdirSync(dir);
  for (const item of items) {
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      results.push(...findJsonFiles(fullPath));
    } else if (item.endsWith('.json')) {
      results.push(fullPath);
    }
  }
  return results;
}
