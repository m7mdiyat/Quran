/* Measure the QCF4 "density ratio" ρ = (widest non-bismillah line width ÷ font-size)
 * for every one of the 604 Mushaf pages, and report the GLOBAL maximum.
 *
 * Why: the Mushaf renders every page at a UNIFORM font-size = container ÷ ρ_global.
 * Pinning ρ_global as a constant (instead of a session-accumulated running max)
 * makes the size identical on every page regardless of navigation order, and lets
 * autoFit run synchronously (no measure-then-resize flash). ρ is container- and
 * size-independent (a pure property of the page's glyphs), so we measure once here
 * and hardcode the max into src/mushaf.js.
 *
 * Requires the dev server on :5173. Run: node scripts/measure-mushaf-density.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://localhost:5173', PORT = 9357;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE_PX = 20;          // measure near the real render size (~19px) for hinting fidelity
const udd = mkdtempSync(join(tmpdir(), 'mdens-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${udd}`, 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function tgt() { for (let i = 0; i < 100; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json`); const l = await r.json(); const t = l.find(x => x.type === 'page' && x.webSocketDebuggerUrl); if (t) return t.webSocketDebuggerUrl; } catch {} await sleep(100); } throw new Error('no target'); }
const ws = new WebSocket(await tgt()); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let _id = 0; const pend = new Map(); ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (m, p = {}) => new Promise(res => { const id = ++_id; pend.set(id, res); ws.send(JSON.stringify({ id, method: m, params: p })); });
const ev = async (x, aw = false) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: aw }); return r.result?.result?.value ?? null; };
await send('Page.enable'); await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.Capacitor={isNativePlatform:()=>true,getPlatform:()=>'ios',Plugins:new Proxy({},{get:()=>new Proxy(()=>Promise.resolve({}),{get:()=>()=>Promise.resolve({})})})};` });
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

const rows = [];
for (let pg = 1; pg <= 604; pg++) {
  await send('Page.navigate', { url: `${BASE}/read/page/${pg}` });
  let ready = false;
  for (let i = 0; i < 120; i++) {
    await sleep(50);
    ready = await ev(`(async()=>{await(document.fonts?document.fonts.ready:0);const p=document.querySelector('#mushafPages .mushaf-page');return !!(p&&p.querySelector('.mushaf-line'));})()`, true);
    if (ready) break;
  }
  const r = await ev(`(()=>{const page=document.querySelector('#mushafPages .mushaf-page');if(!page)return null;
    page.style.setProperty('--font-size','${BASE_PX}px');
    const lines=[...page.querySelectorAll('.mushaf-line:not(.mushaf-line--bismillah)')];
    let max=0;for(const l of lines){const rr=document.createRange();rr.selectNodeContents(l);const w=rr.getBoundingClientRect().width;if(w>max)max=w;}
    // Natural PAGE HEIGHT measured in APP layout (is-app): footer hidden, surah
    // header/label/bismillah scaled with --font-size, header margins trimmed — i.e.
    // exactly what autoFitFontSize() must fit. Force block flow + natural spacing
    // (line-height 1.85, 6px line-gap), unconstrained, and read full content height.
    // Ratio h/font is scale-invariant (a glyph-metric property), like rho.
    document.documentElement.classList.add('is-app');
    page.style.display='block'; page.style.height='auto'; page.style.maxHeight='none'; page.style.minHeight='0'; page.style.overflow='visible';
    for(const l of page.querySelectorAll('.mushaf-line')){ l.style.lineHeight='1.85'; l.style.marginBottom='6px'; }
    void page.offsetHeight;
    const h = page.scrollHeight;
    return {w:+max.toFixed(1),h,font:page.querySelector('.mushaf-word')?.style.fontFamily.replace(/[",]/g,'').replace(' serif','')||'?',n:lines.length};})()`);
  if (r && r.w > 0) { const rho = +(r.w / BASE_PX).toFixed(3); const hr = +(r.h / BASE_PX).toFixed(3); rows.push({ pg, rho, hr, h: r.h, font: r.font, n: r.n }); }
  else rows.push({ pg, rho: null, hr: null, font: '?', n: 0 });
  if (pg % 50 === 0) process.stderr.write(`  …${pg}/604\n`);
}
ws.close(); chrome.kill('SIGKILL');

const valid = rows.filter(r => r.rho != null);
valid.sort((a, b) => b.rho - a.rho);
const top = valid.slice(0, 15);
const max = valid[0];
const vals = valid.map(r => r.rho).sort((a, b) => a - b);
const pct = p => vals[Math.floor((vals.length - 1) * p)];
// Height ratio: max natural (page height ÷ font-size) across all pages — the
// height analogue of rho. Used by autoFitFontSize() to cap the font so the
// densest 15-line page fits the box HEIGHT (not just width).
const validH = rows.filter(r => r.hr != null);
const maxH = validH.slice().sort((a, b) => b.hr - a.hr)[0];
const hvals = validH.map(r => r.hr).sort((a, b) => a - b);
const hpct = p => hvals[Math.floor((hvals.length - 1) * p)];

console.log(`\nmeasured ${valid.length}/604 pages @ ${BASE_PX}px base`);
console.log(`GLOBAL MAX ρ (width)  = ${max.rho}  (page ${max.pg}, font ${max.font}, ${max.n} lines)`);
console.log(`GLOBAL MAX height-ρ   = ${maxH.hr}  (page ${maxH.pg}, ${maxH.n} lines, ${maxH.h}px @ ${BASE_PX}px)`);
console.log(`distribution ρ:        min ${vals[0]}  p50 ${pct(0.5)}  p90 ${pct(0.9)}  p99 ${pct(0.99)}  max ${vals[vals.length - 1]}`);
console.log(`distribution height-ρ: min ${hvals[0]}  p50 ${hpct(0.5)}  p90 ${hpct(0.9)}  p99 ${hpct(0.99)}  max ${hvals[hvals.length - 1]}`);
console.log('top 15 densest (width):');
for (const r of top) console.log(`  page ${String(r.pg).padStart(3)}  ρ=${r.rho}  ${r.font}  (${r.n} lines)`);
console.log('top 10 tallest (height):');
for (const r of validH.slice().sort((a, b) => b.hr - a.hr).slice(0, 10)) console.log(`  page ${String(r.pg).padStart(3)}  height-ρ=${r.hr}  (${r.n} lines, ${r.h}px)`);
writeFileSync(join(process.cwd(), 'scripts', 'mushaf-density.json'), JSON.stringify({ base_px: BASE_PX, global_max_rho: max.rho, densest_page: max.pg, global_max_height_ratio: maxH.hr, densest_height_page: maxH.pg, top, per_page: rows }, null, 0));
console.log('\nwrote scripts/mushaf-density.json');
process.exit(0);
