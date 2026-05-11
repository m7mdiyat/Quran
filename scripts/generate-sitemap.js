/**
 * Sitemap Generator for M7mdiyat
 * Generates sitemap.xml with clean URLs for all ayah pages
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

const SITE_URL = 'https://www.m7mdiyat.com';
const TODAY = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format

// Read surahs data
const surahsData = JSON.parse(
    fs.readFileSync(path.join(PUBLIC_DIR, 'surahs.json'), 'utf-8')
);

/**
 * Generate sitemap XML
 */
function generateSitemap() {
    console.log('🗺️ Generating sitemap...');

    let urls = [];

    // Add homepage
    urls.push({
        loc: SITE_URL + '/',
        lastmod: TODAY,
        priority: '1.0',
        changefreq: 'weekly'
    });

    // Add privacy page
    urls.push({
        loc: SITE_URL + '/privacy.html',
        lastmod: TODAY,
        priority: '0.3',
        changefreq: 'monthly'
    });

    // Add all ayah pages
    for (const surah of surahsData) {
        for (let ayah = 1; ayah <= surah.ayahs; ayah++) {
            urls.push({
                loc: `${SITE_URL}/${surah.number}/${ayah}`,
                lastmod: TODAY,
                priority: '0.7',
                changefreq: 'monthly'
            });
        }
    }

    // Add Mushaf reading pages /read/page/1..604
    for (let p = 1; p <= 604; p++) {
        urls.push({
            loc: `${SITE_URL}/read/page/${p}`,
            lastmod: TODAY,
            priority: '0.6',
            changefreq: 'monthly'
        });
    }

    // Build XML
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

    for (const url of urls) {
        xml += '  <url>\n';
        xml += `    <loc>${url.loc}</loc>\n`;
        xml += `    <lastmod>${url.lastmod}</lastmod>\n`;
        if (url.changefreq) {
            xml += `    <changefreq>${url.changefreq}</changefreq>\n`;
        }
        if (url.priority) {
            xml += `    <priority>${url.priority}</priority>\n`;
        }
        xml += '  </url>\n';
    }

    xml += '</urlset>\n';

    return { xml, count: urls.length };
}

/**
 * Main function
 */
function main() {
    const { xml, count } = generateSitemap();

    // Write to dist directory (for production)
    const distSitemapPath = path.join(DIST_DIR, 'sitemap.xml');
    fs.writeFileSync(distSitemapPath, xml);

    console.log(`✅ Sitemap generated!`);
    console.log(`   📍 Location: ${distSitemapPath}`);
    console.log(`   📊 Total URLs: ${count}`);

    // Show sample entries
    console.log('\n📋 Sample entries:');
    console.log(`   • ${SITE_URL}/`);
    console.log(`   • ${SITE_URL}/1/1`);
    console.log(`   • ${SITE_URL}/2/255`);
    console.log(`   • ${SITE_URL}/114/6`);
    console.log(`   • ${SITE_URL}/read/page/1`);
    console.log(`   • ${SITE_URL}/read/page/604`);
}

main();
