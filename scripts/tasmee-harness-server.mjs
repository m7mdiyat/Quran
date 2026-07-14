/* ============================================================
 * tasmee-harness-server.mjs — serves the Gate 3 dev harness.
 *
 *   node scripts/tasmee-harness-server.mjs   → http://<host>:8787/
 *
 * Zero-dep static server exposing exactly what the harness needs:
 * the page, /src/* shared ESM modules (browser-native, no bundler),
 * /ort/* (onnxruntime-web dist), /models/* (artifact-of-record),
 * /golden/* clips, and the word dataset. Listens on 0.0.0.0 and
 * prints LAN URLs for the iPhone Safari smoke. Dev-only — never
 * part of any build.
 * ============================================================ */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 8787);
/* --isolate → serve COOP/COEP so crossOriginIsolated flips true and
 * SharedArrayBuffer (→ ort-web threading via ?threads=N) becomes
 * available. C3.2 instrument (2026-07-11): the threaded-Safari test —
 * if xoi flips true and RTF drops materially, the WebKit gap is
 * threading-addressable and R9 recedes. All harness assets are
 * same-origin, so require-corp needs no CORP headers on resources. */
const ISOLATE = process.argv.includes("--isolate") || process.env.TASMEE_ISOLATE === "1";

const MOUNTS = [
    ["/harness/", path.join(ROOT, "harness")],
    ["/src/", path.join(ROOT, "src")],
    ["/ort/", path.join(ROOT, "node_modules", "onnxruntime-web", "dist")],
    ["/models/", path.join(ROOT, "models", "tasmee")],
    ["/candidate/", path.join(ROOT, "models", "candidate")], // post-Gate-3 A/B only
    ["/golden/", path.join(ROOT, "tests", "tasmee", "golden")],
    ["/qcf4/pages/", path.join(ROOT, "public", "data", "qcf4", "pages")],
];
const MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
    ".json": "application/json", ".wasm": "application/wasm", ".wav": "audio/wav",
    ".onnx": "application/octet-stream", ".txt": "text/plain",
};

/* Request log — every line is served-artifact evidence (the 27-min
 * iPhone run of 2026-07-10 left NO such evidence because nothing was
 * logged; the anomaly investigation needs exactly this). Tag clients
 * so phone vs desktop rows separate at a glance. */
const uaTag = (ua = "") =>
    /iP(hone|ad|od)/.test(ua) ? "ios" : /Android/.test(ua) ? "android" : /Chrome/.test(ua) ? "chrome" : /Safari/.test(ua) ? "safari" : "other";

http.createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const who = `${req.socket.remoteAddress} ${uaTag(req.headers["user-agent"])}`;
    console.log(`[req] ${new Date().toISOString()} ${who} ${req.method} ${url}`);
    let file = null;
    if (url === "/" || url === "/tasmee-harness.html") file = path.join(ROOT, "harness", "tasmee-harness.html");
    else if (url === "/data/tasmee-words.json") file = path.join(ROOT, "public", "tasmee-words.json");
    else for (const [prefix, dir] of MOUNTS) {
        if (url.startsWith(prefix)) { file = path.join(dir, url.slice(prefix.length)); break; }
    }
    if (!file || !file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404); res.end("404"); return;
    }
    const size = fs.statSync(file).size;
    const headers = {
        "content-type": MIME[path.extname(file)] || "application/octet-stream",
        "content-length": size,
        "cache-control": "no-store",
    };
    if (ISOLATE) {
        headers["Cross-Origin-Opener-Policy"] = "same-origin";
        headers["Cross-Origin-Embedder-Policy"] = "require-corp";
    }
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
}).listen(PORT, "0.0.0.0", () => {
    console.log(`tasmee harness on: (cross-origin isolation ${ISOLATE ? "ON — COOP/COEP served, xoi should read true" : "OFF — historical posture, xoi=false"})`);
    console.log(`  http://localhost:${PORT}/?clip=/golden/smoke114-p604.wav&range=114:1-6&autorun=1`);
    for (const ifs of Object.values(os.networkInterfaces())) {
        for (const i of ifs || []) {
            if (i.family === "IPv4" && !i.internal) console.log(`  http://${i.address}:${PORT}/  ← iPhone Safari (same Wi-Fi)`);
        }
    }
});
