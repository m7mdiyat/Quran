/* ============================================================
 * build-tasmee-proto.mjs — assembles the TASK #11 iOS threading
 * prototype as dist-app/ so the EXISTING wrapper flow ships it
 * unchanged:  node scripts/build-tasmee-proto.mjs
 *             → (in the wrapper) npx cap sync ios → Xcode ▶
 *
 * ⚠ OVERWRITES dist-app/ with the PROTOTYPE (the real app bundle is
 * a build artifact — regenerate it afterwards with
 * `node scripts/build-app.js`). The prototype bundle is ~150 MB
 * (record model + ort wasm) and is SIDELOAD-ONLY — never ship it.
 * ============================================================ */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "dist-app");

const COPIES = [
    ["proto/tasmee-ios/index.html", "index.html"],
    ["proto/tasmee-ios/proto-worker.js", "proto-worker.js"],
    ["src/tasmee-pipeline.js", "tasmee-pipeline.js"],
    ["node_modules/onnxruntime-web/dist/ort.wasm.min.mjs", "ort.wasm.min.mjs"],
    ["node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.mjs"],
    ["node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.wasm"],
    // #11c webgpu leg — navigator.gpu printed PRESENT on iOS 18.7; EP run decides usable-vs-stub.
    // ort 1.27's ort.webgpu.min.mjs imports the ASYNCIFY artifact (not jsep — shipping
    // jsep here caused the first #11c run's "Importing a module script failed" 404).
    ["node_modules/onnxruntime-web/dist/ort.webgpu.min.mjs", "ort.webgpu.min.mjs"],
    ["node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.mjs"],
    ["node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm", "ort-wasm-simd-threaded.asyncify.wasm"],
    ["models/tasmee/fastconformer_ar_ctc_q8pc-head.onnx", "model.onnx"], // record artifact (sha e2dfe38c…)
    ["tests/tasmee/golden/smoke114-p604.wav", "smoke.wav"],
];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
let total = 0;
for (const [src, dst] of COPIES) {
    const from = path.join(ROOT, src);
    fs.copyFileSync(from, path.join(OUT, dst));
    const size = fs.statSync(from).size;
    total += size;
    console.log(`  ${dst.padEnd(30)} ${(size / 1048576).toFixed(1).padStart(7)} MB`);
}
console.log(`\ndist-app/ = #11 PROTOTYPE (${(total / 1048576).toFixed(0)} MB, sideload-only)`);
console.log(`next: in the WRAPPER project → apply the COOP/COEP patch (see the`);
console.log(`      #11 task / TASMEE-PLAN), then 'npx cap sync ios', then Xcode ▶ on a`);
console.log(`      PHYSICAL iPhone (simulator invalid for the perf number).`);
console.log(`restore the real app afterwards: node scripts/build-app.js`);
