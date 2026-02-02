// Script to extract Shuraim and Ayoub audio zips and reorganize audio folders
// Run with: node scripts/extract-reciters.js

import { execSync } from 'child_process';
import { existsSync, mkdirSync, renameSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const RECITERS = [
    { name: 'Shuraim', source: 'Shuraim', dest: 'public/audio/shuraim' },
    { name: 'Ayoub', source: 'Ayoub', dest: 'public/audio/ayoub' }
];

// Step 1: Rename current audio folder to alijaber
const currentAudio = join(ROOT, 'public/audio');
const alijaberAudio = join(ROOT, 'public/audio_alijaber_temp');

if (existsSync(currentAudio) && !existsSync(join(ROOT, 'public/audio/alijaber'))) {
    console.log('Step 1: Reorganizing existing audio to alijaber...');
    renameSync(currentAudio, alijaberAudio);
    mkdirSync(currentAudio);
    renameSync(alijaberAudio, join(currentAudio, 'alijaber'));
    console.log('✓ Moved existing audio to public/audio/alijaber/');
}

// Step 2: Extract each reciter's zips
for (const reciter of RECITERS) {
    const sourceDir = join(ROOT, reciter.source);
    const destDir = join(ROOT, reciter.dest);

    if (!existsSync(sourceDir)) {
        console.log(`⚠ Skipping ${reciter.name}: source folder not found`);
        continue;
    }

    console.log(`\nStep 2: Extracting ${reciter.name}...`);

    // Create destination directory
    if (!existsSync(destDir)) {
        mkdirSync(destDir, { recursive: true });
    }

    // Get all zip files
    const zips = readdirSync(sourceDir).filter(f => f.endsWith('.zip'));
    let extracted = 0;

    for (const zip of zips) {
        // Extract surah number from filename (e.g., "001.zip" -> "001")
        const surahMatch = zip.match(/^(\d{3})/);
        if (!surahMatch) continue;

        const surahNum = surahMatch[1];
        const surahDir = join(destDir, surahNum);

        // Skip if already extracted
        if (existsSync(surahDir) && readdirSync(surahDir).length > 1) {
            continue;
        }

        // Create surah directory
        if (!existsSync(surahDir)) {
            mkdirSync(surahDir, { recursive: true });
        }

        // Extract zip using PowerShell
        const zipPath = join(sourceDir, zip);
        try {
            execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${surahDir}' -Force"`, { stdio: 'pipe' });
            extracted++;
            process.stdout.write(`\r  Extracted: ${extracted}/${zips.length}`);
        } catch (err) {
            console.error(`\n  ⚠ Failed to extract ${zip}:`, err.message);
        }
    }

    console.log(`\n✓ Extracted ${extracted} zips for ${reciter.name}`);
}

console.log('\n✅ Audio extraction complete!');
console.log('Audio folders now at:');
console.log('  - public/audio/alijaber/');
console.log('  - public/audio/shuraim/');
console.log('  - public/audio/ayoub/');
