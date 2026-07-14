export default {
  build: {
    outDir: "dist",
  },
  // Pre-bundle the ONNX runtime so Vite doesn't discover it lazily inside the
  // tasmee worker and force a one-time full-page reload on the first mic-tap
  // (dev-only behaviour; production bundles everything ahead of time).
  optimizeDeps: {
    include: ["onnxruntime-web/wasm"],
  },
  worker: {
    format: "es",
  },
  server: {
    // DEV ONLY — cross-origin isolation so onnxruntime-web can use SharedArrayBuffer
    // threads on localhost (RTF ~1.0 single-thread → ~0.4 threaded), matching the
    // in-app FlyingFox COOP/COEP path. MUST be `require-corp`, NOT `credentialless`:
    // WebKit/Safari (the ship target) does not grant crossOriginIsolated for
    // credentialless — only Chromium does. The QCF4 mushaf assets are same-origin
    // on the web (getQCF4Base()==="") so require-corp doesn't break rendering; the
    // cross-origin extras it blocks on dev (Google-Fonts panels, tafsir/audio GCS,
    // analytics) are outside the tasmee reciting path.
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
}
