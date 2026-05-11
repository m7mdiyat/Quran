/**
 * Pre-render Script for M7mdiyat
 * Generates individual HTML pages for each ayah with:
 * 1. Proper canonical tags (Head SEO)
 * 2. Injected Ayah & Tafsir content (Body SEO)
 * 
 * This enables Google to index the ACTUAL content of the verses.
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

// -------------------------------------------------------------
// 1. DATA LOADING
// -------------------------------------------------------------
console.log("📥 Loading Quran & Tafsir data...");

// Helper to read JSON with BOM strip
function readJsonSafe(filePath) {
    try {
        let content = fs.readFileSync(filePath, 'utf-8');
        // Strip BOM if present
        if (content.charCodeAt(0) === 0xFEFF) {
            content = content.slice(1);
        }
        return JSON.parse(content);
    } catch (e) {
        throw new Error(`Failed to read/parse ${path.basename(filePath)}: ${e.message}`);
    }
}

// Load Surahs metadata
let surahsData = [];
try {
    surahsData = readJsonSafe(path.join(PUBLIC_DIR, 'surahs.json'));
} catch (e) {
    console.error("❌ Critical: " + e.message);
    process.exit(1);
}

// Load Quran Text
let quranIndex = {}; // keys: "s-a" => "text"

try {
    const quranRaw = readJsonSafe(path.join(PUBLIC_DIR, 'quran.json'));

    // Inspect structure
    let surahsList = [];
    if (Array.isArray(quranRaw)) {
        surahsList = quranRaw;
    } else if (quranRaw.data && Array.isArray(quranRaw.data.surahs)) {
        surahsList = quranRaw.data.surahs;
    } else if (quranRaw.surahs && Array.isArray(quranRaw.surahs)) {
        surahsList = quranRaw.surahs;
    } else if (quranRaw.quran && Array.isArray(quranRaw.quran)) {
        surahsList = quranRaw.quran;
    }

    if (surahsList.length > 0) {
        surahsList.forEach(s => {
            const sNum = s.number || s.id;
            const ayahs = s.ayahs || s.verses || [];
            ayahs.forEach(a => {
                const aNum = a.numberInSurah || a.number || a.id;
                quranIndex[`${sNum}-${aNum}`] = a.text || a.content || a.verse;
            });
        });
        console.log(`✅ Indexed Quran: ${Object.keys(quranIndex).length} ayahs.`);
    } else {
        console.error("❌ Quran structure unrecognized. First key:", Object.keys(quranRaw)[0]);
    }
} catch (e) {
    console.error("❌ Failed to load quran.json:", e.message);
}

// Load Tafsir (Muyassar)
let tafsirIndex = {}; // keys: "s-a" => "text"
try {
    const tafsirRaw = readJsonSafe(path.join(PUBLIC_DIR, 'tafseer_muyassar.json'));

    // Detect if array or object
    if (Array.isArray(tafsirRaw)) {
        tafsirRaw.forEach(item => {
            // Check for s/a/text structure
            const s = item.s || item.surah || item.surah_number;
            const a = item.a || item.ayah || item.ayah_number;
            const t = item.t || item.text || item.tafsir;
            if (s && a && t) {
                tafsirIndex[`${s}-${a}`] = t;
            }
        });
    } else {
        // Object map handling
        // Support for Nested { "1": { "1": "text" } } OR Flat { "1-1": "text" }
        for (const [sKey, sVal] of Object.entries(tafsirRaw)) {
            if (typeof sVal === 'object' && sVal !== null) {
                // Nested Structure
                // sKey is Surah Number
                for (const [aKey, aText] of Object.entries(sVal)) {
                    // aKey is Ayah Number
                    tafsirIndex[`${sKey}-${aKey}`] = aText;
                }
            } else {
                // Flat value - check if key is compound
                const parts = sKey.split(/[-:]/);
                if (parts.length === 2) {
                    tafsirIndex[`${Number(parts[0])}-${Number(parts[1])}`] = sVal;
                }
            }
        }
    }
    console.log(`✅ Indexed Tafsir: ${Object.keys(tafsirIndex).length} entries.`);
} catch (e) {
    console.error("⚠️ Failed to load tafseer_muyassar.json:", e.message);
}


// Read the base index.html template
let baseTemplate = fs.readFileSync(path.join(DIST_DIR, 'index.html'), 'utf-8');


// -------------------------------------------------------------
// 2. GENERATION LOGIC
// -------------------------------------------------------------

/**
 * Generate SEO meta tags for a specific ayah
 */
function generateMetaTags(surah, ayah, surahName, tafsirText) {
    const canonicalUrl = `${SITE_URL}/${surah}/${ayah}`;
    const title = `تفسير سورة ${surahName} آية ${ayah} | محمديات`;

    // Improved Description: Include start of Tafsir for uniqueness
    let description = `تفسير الآية ${ayah} من سورة ${surahName}`;
    if (tafsirText) {
        // truncate to ~120 chars
        const snippet = tafsirText.length > 120 ? tafsirText.substring(0, 117) + "..." : tafsirText;
        description += `: ${snippet}`;
    } else {
        description += ` - محمديات: بحث عن الآية مع السياق والتفسير`;
    }

    return { canonicalUrl, title, description };
}

/**
 * Generate Schema Markup for Ayah Page
 */
function generateSchemaMarkup(surah, ayah, surahName, canonicalUrl, description) {
    // 1. WebSite Schema (Already in base template, but we can enhance it if needed)
    // We focus on WebPage and BreadcrumbList here.

    const webPageSchema = {
        "@type": "WebPage",
        "@id": `${canonicalUrl}`,
        "url": canonicalUrl,
        "name": `تفسير سورة ${surahName} آية ${ayah} | محمديات`,
        "isPartOf": { "@id": `${SITE_URL}/#website` },
        "inLanguage": "ar",
        "description": description,
        "breadcrumb": { "@id": `${canonicalUrl}#breadcrumb` }
    };

    const breadcrumbSchema = {
        "@type": "BreadcrumbList",
        "@id": `${canonicalUrl}#breadcrumb`,
        "itemListElement": [
            {
                "@type": "ListItem",
                "position": 1,
                "name": "محمديات",
                "item": SITE_URL
            },
            {
                "@type": "ListItem",
                "position": 2,
                "name": `سورة ${surahName}`,
                "item": `${SITE_URL}/${surah}`
            },
            {
                "@type": "ListItem",
                "position": 3,
                "name": `آية ${ayah}`
            }
        ]
    };

    return [webPageSchema, breadcrumbSchema];
}

/**
 * Generate Surah Landing Page HTML (Table of Contents)
 */
function generateSurahPageHtml(surah, surahName, ayahsCount) {
    const canonicalUrl = `${SITE_URL}/${surah}`;
    const title = `سورة ${surahName} مكتوبة كاملة بالتشكيل | محمديات`;
    const description = `اقرأ سورة ${surahName} مكتوبة كاملة بالتشكيل مع تفسير كل آية، عدد آياتها ${ayahsCount}. تصفح فهرس الآيات للوصول السريع للتفسير.`;

    let html = baseTemplate;

    // --- METADATA ---
    html = html.replace(/<title[^>]*>.*?<\/title>/i, `<title>${title}</title>`);

    // Canonicals & OG
    const canonTag = `<link id="canonicalLink" rel="canonical" href="${canonicalUrl}" />`;
    html = html.replace(/<link[^>]*id="canonicalLink"[^>]*\/?>/i, canonTag);
    html = html.replace(/<meta[^>]*id="ogUrl"[^>]*content="[^"]*"[^>]*\/?>/i, `<meta id="ogUrl" property="og:url" content="${canonicalUrl}" />`);
    html = html.replace(/<meta[^>]*id="ogTitle"[^>]*content="[^"]*"[^>]*\/?>/i, `<meta id="ogTitle" property="og:title" content="${title}" />`);
    html = html.replace(/<meta[^>]*id="metaDescription"[^>]*content="[^"]*"[^>]*\/?>/i, `<meta id="metaDescription" name="description" content="${description}" />`);
    html = html.replace(/<meta[^>]*id="ogDesc"[^>]*content="[^"]*"[^>]*\/?>/i, `<meta properties="og:description" content="${description}" />`);
    html = html.replace(/<meta property="og:site_name" content="[^"]*" \/>/i, `<meta property="og:site_name" content="محمديات" />`); // Fix site name
    html = html.replace(/<meta[^>]*id="twTitle"[^>]*content="[^"]*"[^>]*\/?>/i, `<meta id="twTitle" name="twitter:title" content="${title}" />`);
    html = html.replace(/<meta[^>]*id="twDesc"[^>]*content="[^"]*"[^>]*\/?>/i, `<meta id="twDesc" name="twitter:description" content="${description}" />`);

    // Schema
    const breadcrumbSchema = {
        "@type": "BreadcrumbList",
        "@id": `${canonicalUrl}#breadcrumb`,
        "itemListElement": [
            { "@type": "ListItem", "position": 1, "name": "محمديات", "item": SITE_URL },
            { "@type": "ListItem", "position": 2, "name": `سورة ${surahName}` }
        ]
    };

    // Inject Schema
    const schemaScript = `<script type="application/ld+json">${JSON.stringify(breadcrumbSchema)}</script>`;
    html = html.replace('</head>', `${schemaScript}\n</head>`);


    // --- BODY CONTENT (Grid of Links) ---
    // We replace the main hero/search section content with our grid

    // Generate Grid Items - themed borders via CSS
    let gridItems = '';
    for (let i = 1; i <= ayahsCount; i++) {
        gridItems += `
            <a href="/${surah}/${i}" class="ayah-grid-btn group flex items-center justify-center px-3 py-3 rounded-xl bg-white shadow-sm hover:shadow-lg hover:bg-blue-50 transition-all duration-200 text-center" style="border: 1px solid #93c5fd;">
                <span class="text-base font-bold text-slate-700 group-hover:text-blue-600 transition-colors">${i}</span>
            </a>
        `;
    }

    const surahContent = `
        <div class="mt-6 mb-12 animate-fade-in-up">
            <!-- Compact Header Bar -->
            <div class="glass rounded-2xl px-4 py-3 mx-auto relative" style="margin-bottom: 50px; max-width: 320px;">
                <div class="text-center">
                    <span class="quran-font text-xl text-slate-900">سورة ${surahName}</span>
                </div>
                <span class="text-slate-500 font-medium absolute" style="left: 16px; bottom: 6px; font-size: 10px;">عدد الآيات: ${ayahsCount}</span>
            </div>

            <!-- Ayah Grid -->
            <div class="grid grid-cols-5 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 gap-2 max-w-4xl mx-auto px-4">
                ${gridItems}
            </div>
        </div>
    `;

    // Replace the main hero section to show our content
    // Find <section class="pt-14 pb-10 text-center"> ... </section>
    // This is bold regex, but effective for this template
    html = html.replace(
        /<section class="pt-14 pb-10 text-center">[\s\S]*?<\/section>/,
        surahContent
    );

    // Hide AI section
    html = html.replace('<section class="pb-10">', '<section class="pb-10 hidden">');

    return html;
}

/**
 * Inject content and replace tags
 */
function generatePageHtml(surah, ayah, surahName) {
    const ayahText = quranIndex[`${surah}-${ayah}`] || "";
    const tafsirText = tafsirIndex[`${surah}-${ayah}`] || "";

    const { canonicalUrl, title, description } = generateMetaTags(surah, ayah, surahName, tafsirText);

    let html = baseTemplate;

    // --- A. HEAD METADATA INJECTION ---

    // Replace title
    html = html.replace(/<title[^>]*>.*?<\/title>/i, `<title>${title}</title>`);

    // Replace canonical link
    const canonTag = `<link id="canonicalLink" rel="canonical" href="${canonicalUrl}" />`;
    if (html.includes('id="canonicalLink"')) {
        html = html.replace(/<link[^>]*id="canonicalLink"[^>]*\/?>/i, canonTag);
    } else {
        // fallback insert
        html = html.replace('</head>', `${canonTag}\n</head>`);
    }

    // Replace og:url
    html = html.replace(/<meta[^>]*id="ogUrl"[^>]*content="[^"]*"[^>]*\/?>/i, `<meta id="ogUrl" property="og:url" content="${canonicalUrl}" />`);

    // Replace og:title
    html = html.replace(/<meta[^>]*id="ogTitle"[^>]*content="[^"]*"[^>]*\/?>/i, `<meta id="ogTitle" property="og:title" content="${title}" />`);

    // Replace meta description
    html = html.replace(/<meta[^>]*id="metaDescription"[^>]*content="[^"]*"[^>]*\/?>/i, `<meta id="metaDescription" name="description" content="${description}" />`);

    // Replace og:description
    html = html.replace(/<meta[^>]*id="ogDesc"[^>]*content="[^"]*"[^>]*\/?>/i, `<meta properties="og:description" content="${description}" />`);

    // Fix og:site_name (SEO Audit Fix)
    html = html.replace(/<meta property="og:site_name" content="[^"]*" \/>/i, `<meta property="og:site_name" content="محمديات" />`);

    // Replace twitter tags
    html = html.replace(/<meta[^>]*id="twTitle"[^>]*content="[^"]*"[^>]*\/?>/i, `<meta id="twTitle" name="twitter:title" content="${title}" />`);
    html = html.replace(/<meta[^>]*id="twDesc"[^>]*content="[^"]*"[^>]*\/?>/i, `<meta id="twDesc" name="twitter:description" content="${description}" />`);

    // Add data attribute for hydration
    html = html.replace(
        '<html lang="ar" dir="rtl">',
        `<html lang="ar" dir="rtl" data-surah="${surah}" data-ayah="${ayah}">`
    );

    // JSON-LD Update & Injection (SEO Audit Fix)
    html = html.replace(/"url": "https:\/\/www\.m7mdiyat\.com\/"/g, `"url": "${canonicalUrl}"`);

    // Inject Schema Markup
    const schemaData = generateSchemaMarkup(surah, ayah, surahName, canonicalUrl, description);
    const schemaScript = `<script type="application/ld+json">${JSON.stringify(schemaData)}</script>`;
    html = html.replace('</head>', `${schemaScript}\n</head>`);


    // --- B. BODY CONTENT INJECTION (The "Content SEO" Fix) ---

    // 1. Un-hide the Tafsir Section container
    // Find: <div id="tafsirSection" class="glass hidden rounded-3xl p-6">
    html = html.replace(
        'id="tafsirSection" class="glass hidden rounded-3xl p-6"',
        'id="tafsirSection" class="glass rounded-3xl p-6" style="opacity:1; transform:none;"'
    );

    // 2. Inject Ayah Text into #ayahContext (Keep parent #versePanel hidden for UX, content remains for SEO)
    // We do NOT unhide propery here anymore to avoid visual bugs on load.

    // Inject Ayah Text

    // Inject Ayah Text
    // Find: <div id="ayahContext" ...></div>
    if (ayahText) {
        const ayahHtml = `
            <div class="result-card p-6 mb-4">
                <div class="text-right">
                    <span class="inline-block px-3 py-1 rounded-full bg-blue-50 text-blue-600 text-xs font-bold mb-3">
                        سورة ${surahName} - آية ${ayah}
                    </span>
                    <h2 class="quran-font text-3xl leading-[2.2] text-slate-900 mb-2">
                        ${ayahText}
                    </h2>
                </div>
            </div>
        `;
        html = html.replace(
            /<div id="ayahContext"[^>]*><\/div>/,
            `<div id="ayahContext" class="text-[18px] leading-[2.2]">${ayahHtml}</div>`
        );
    }

    // 3. Inject Tafsir Text into #tafsirBox
    if (tafsirText) {
        // Find <div id="tafsirBox" ...>—</div>
        // Warning: The template might have newlines or attributes. Regex match needed.
        const tafsirReplacement = `<div id="tafsirBox" class="mt-6 rounded-3xl border border-slate-900/10 bg-white/65 p-5 leading-[2.2] text-[18px] text-slate-900" style="max-height:520px; overflow:auto;">${tafsirText}</div>`;
        html = html.replace(
            /<div id="tafsirBox"[^>]*>.*?<\/div>/s,
            tafsirReplacement
        );

        // Also update headers to look "alive"
        html = html.replace('id="tafsirTitle" class="mt-2 text-xl font-extrabold tracking-tight">&mdash;', `id="tafsirTitle" class="mt-2 text-xl font-extrabold tracking-tight">تفسير سورة ${surahName}`);
        html = html.replace('id="tafsirDesc" class="mt-2 text-xs font-semibold text-slate-500">&mdash;', `id="tafsirDesc" class="mt-2 text-xs font-semibold text-slate-500">التفسير الميسر`);
    }

    // 4. Force visibility of #resultsShell to avoid massive layout shift?
    // Actually, hiding resultsShell is fine if we are showing TafsirSection directly.

    return html;
}

// -------------------------------------------------------------
// 3. EXECUTION
// -------------------------------------------------------------

/**
 * Generate Mushaf page HTML — minimal SEO shell for /read/page/N. The actual
 * Mushaf rendering is client-side via mushaf.js, but we still emit a small
 * HTML file per page so Google can index the URL with a meaningful title
 * + canonical and the user lands on the right page without any redirects.
 */
let mushafChapters = [];
let mushafFontMap = {};
try {
    const idxRaw = readJsonSafe(path.join(PUBLIC_DIR, 'data', 'qcf4', 'index.json'));
    mushafChapters = idxRaw?.chapters || [];
    mushafFontMap = readJsonSafe(path.join(PUBLIC_DIR, 'data', 'qcf4', 'font-map.json')) || {};
} catch (e) {
    console.error('⚠️ Mushaf metadata not found — Mushaf prerender will be skipped:', e.message);
}

function surahNamesForPage(pageNo) {
    return mushafChapters
        .filter((c) => c.pages?.[0] <= pageNo && pageNo <= c.pages?.[1])
        .map((c) => c.name_arabic);
}

function generateMushafPageHtml(pageNo) {
    const canonicalUrl = `${SITE_URL}/read/page/${pageNo}`;
    const names = surahNamesForPage(pageNo);
    const surahDesc = names.length
        ? `يحتوي على سور: ${names.join('، ')}`
        : '';
    const title = `قراءة المصحف — صفحة ${pageNo} | محمديات`;
    const description = `صفحة ${pageNo} من المصحف الشريف برسم مصحف المدينة. ${surahDesc} اقرأ بخط عثمان طه مع إمكانية اختيار الآيات وتشغيل التلاوة.`;

    let html = baseTemplate;
    html = html.replace(/<title[^>]*>.*?<\/title>/i, `<title>${title}</title>`);
    const canonTag = `<link id="canonicalLink" rel="canonical" href="${canonicalUrl}" />`;
    html = html.replace(/<link[^>]*id="canonicalLink"[^>]*\/?>/i, canonTag);
    html = html.replace(/<meta[^>]*id="ogUrl"[^>]*content="[^"]*"[^>]*\/?>/i, `<meta id="ogUrl" property="og:url" content="${canonicalUrl}" />`);
    html = html.replace(/<meta[^>]*id="ogTitle"[^>]*content="[^"]*"[^>]*\/?>/i, `<meta id="ogTitle" property="og:title" content="${title}" />`);
    html = html.replace(/<meta[^>]*id="metaDescription"[^>]*content="[^"]*"[^>]*\/?>/i, `<meta id="metaDescription" name="description" content="${description}" />`);
    html = html.replace(/<meta[^>]*id="ogDesc"[^>]*content="[^"]*"[^>]*\/?>/i, `<meta id="ogDesc" property="og:description" content="${description}" />`);
    html = html.replace(/<meta[^>]*id="twTitle"[^>]*content="[^"]*"[^>]*\/?>/i, `<meta id="twTitle" name="twitter:title" content="${title}" />`);
    html = html.replace(/<meta[^>]*id="twDesc"[^>]*content="[^"]*"[^>]*\/?>/i, `<meta id="twDesc" name="twitter:description" content="${description}" />`);

    // Tag the <html> so the early-routing script knows the target page.
    html = html.replace(
        '<html lang="ar" dir="rtl">',
        `<html lang="ar" dir="rtl" data-app-mode="mushaf" data-mushaf-page="${pageNo}">`
    );

    // Preload the font for this page so it's ready by the time mushaf.js renders.
    const fontName = mushafFontMap[String(pageNo)];
    if (fontName) {
        const fontFile = `${fontName}_W.woff2`;
        const preload = `<link rel="preload" as="font" type="font/woff2" crossorigin href="/fonts/qcf4/${fontFile}">`;
        html = html.replace('</head>', `${preload}\n</head>`);
    }

    // Schema
    const breadcrumbSchema = {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            { "@type": "ListItem", "position": 1, "name": "محمديات", "item": SITE_URL },
            { "@type": "ListItem", "position": 2, "name": "المصحف", "item": `${SITE_URL}/read/page/1` },
            { "@type": "ListItem", "position": 3, "name": `صفحة ${pageNo}` },
        ],
    };
    const schemaScript = `<script type="application/ld+json">${JSON.stringify(breadcrumbSchema)}</script>`;
    html = html.replace('</head>', `${schemaScript}\n</head>`);

    return html;
}

async function prerender() {
    console.log('🚀 Starting pre-render process...');
    console.log(`📁 Output directory: ${DIST_DIR}`);

    let totalPages = 0;
    const startTime = Date.now();

    // Process each surah
    for (const surah of surahsData) {
        const surahDir = path.join(DIST_DIR, String(surah.number));
        if (!fs.existsSync(surahDir)) fs.mkdirSync(surahDir, { recursive: true });

        // 1. Generate Surah Landing Page (/surah/index.html)
        const surahHtml = generateSurahPageHtml(surah.number, surah.name_ar, surah.ayahs);
        fs.writeFileSync(path.join(surahDir, 'index.html'), surahHtml);
        totalPages++;

        // 2. Generate page for each ayah
        for (let ayah = 1; ayah <= surah.ayahs; ayah++) {
            const ayahDir = path.join(surahDir, String(ayah));
            if (!fs.existsSync(ayahDir)) fs.mkdirSync(ayahDir, { recursive: true });

            const html = generatePageHtml(surah.number, ayah, surah.name_ar);
            fs.writeFileSync(path.join(ayahDir, 'index.html'), html);
            totalPages++;
        }

        if (surah.number % 10 === 0) {
            console.log(`  ✓ Processed surah ${surah.number}/114 (${surah.name_ar})`);
        }
    }

    // 3. Generate Mushaf reading pages /read/page/N
    if (mushafChapters.length) {
        console.log('📖 Generating Mushaf pages /read/page/1..604 ...');
        const mushafRoot = path.join(DIST_DIR, 'read', 'page');
        if (!fs.existsSync(mushafRoot)) fs.mkdirSync(mushafRoot, { recursive: true });
        for (let p = 1; p <= 604; p++) {
            const dir = path.join(mushafRoot, String(p));
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'index.html'), generateMushafPageHtml(p));
            totalPages++;
            if (p % 100 === 0) console.log(`  ✓ Mushaf page ${p}/604`);
        }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\n✅ Pre-render complete!`);
    console.log(`   📄 Generated ${totalPages} pages with content injection.`);
    console.log(`   ⏱️ Duration: ${duration}s`);
}

prerender().catch(console.error);
