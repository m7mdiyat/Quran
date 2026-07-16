/* ============================================================
 * tasmee-lab-db.js — DEV ONLY (tasmee-lab). IndexedDB persistence for
 * captured clips (per-frame logprobs + PCM + event logs) so re-scoring
 * needs no re-decode, plus JSON export (typed arrays as base64).
 * Dumps are DEV ARTIFACTS: they live in IndexedDB / the user's
 * Downloads — never in the repo, never shipped.
 * ============================================================ */

const DB_NAME = "tasmee-lab", STORE = "clips";

function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function tx(mode, fn) {
    const db = await openDb();
    try {
        return await new Promise((resolve, reject) => {
            const t = db.transaction(STORE, mode);
            const out = fn(t.objectStore(STORE));
            t.oncomplete = () => resolve(out && "result" in out ? out.result : undefined);
            t.onerror = () => reject(t.error);
        });
    } finally { db.close(); }
}

export const putClip = (clip) => tx("readwrite", (s) => s.put(clip));
export const getClip = (id) => tx("readonly", (s) => s.get(id));
export const deleteClip = (id) => tx("readwrite", (s) => s.delete(id));

export async function listClips() {
    const all = await tx("readonly", (s) => s.getAll());
    return (all || []).map((c) => ({
        id: c.id, label: c.label, reciter: c.passage?.reciter, modelUrl: c.modelUrl,
        passage: c.passage, frames: c.indices?.length || 0, refWords: c.ref?.length || 0,
        durS: c.pcm16k ? c.pcm16k.length / 16000 : 0,
    }));
}

/* ---------- JSON export (base64 typed arrays, lossless) ---------- */

function b64(bytes) {
    let s = "";
    const u8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
}

export function clipToJson(clip) {
    return JSON.stringify({
        format: "tasmee-lab-clip-v1",
        id: clip.id, label: clip.label, passage: clip.passage, modelUrl: clip.modelUrl,
        V: clip.V, blank: clip.blank, pumpEndLen: clip.pumpEndLen, setCalls: clip.setCalls,
        ref: clip.ref, windows: clip.windows,
        liveEvents: clip.liveEvents, committedFull: clip.committedFull, summary: clip.summary,
        indices_i32_b64: b64(clip.indices),
        frames_f32_b64: b64(clip.data),
        pcm16k_f32_b64: b64(clip.pcm16k),
    });
}

export function downloadClipJson(clip) {
    const blob = new Blob([clipToJson(clip)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${clip.id}.tasmee-lab.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
