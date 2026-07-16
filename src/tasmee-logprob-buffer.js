/* ============================================================
 * tasmee-logprob-buffer.js — session-scoped per-frame CTC logprob
 * retention (ADDITIVE side buffer; nothing in the live decode/match/
 * reveal path reads it yet).
 *
 * Purpose: the boundary-repair / acoustic-confidence layer needs the
 * model's raw per-frame log-probabilities, which decodeSlice currently
 * discards right after argmax. The worker stores every decoded frame's
 * [V]-length row here, keyed by ABSOLUTE frame index
 * (Math.round(segmentStartS / FRAME_S) + t). The incremental controller
 * re-decodes OVERLAPPING windows every 0.3 s step, so the same absolute
 * frame is written repeatedly — set() OVERWRITES (latest decode wins),
 * never appends. Anchor times can be VAD-snapped arbitrary floats, so
 * the index quantizes to the nearest frame (≤ 40 ms — half a frame).
 *
 * Storage: a fixed RING — one flat Float32Array(capacity × V) plus an
 * Int32Array slot→absIndex tag; slot = absIndex % capacity. Chosen over
 * a Map<index, Float32Array> because the decode path is hot (~12.5
 * rows/s × the incremental re-decode overlap factor ≈ 10 → ~125 set()
 * calls/s): the ring is ONE ~1.5 MB allocation for the whole session,
 * O(1) copy-in-place writes, zero per-row allocation/GC churn, and the
 * memory bound is structural (modulo wrap IS the eviction) rather than
 * enforced by bookkeeping. A stale slot (its frame aged out of the
 * window) is detected by the tag mismatch in get() and reads as null.
 * ============================================================ */

export function createLogprobBuffer({ vocabSize, frameS = 0.08, windowS = 30 } = {}) {
    if (!Number.isInteger(vocabSize) || vocabSize <= 0) {
        throw new Error("createLogprobBuffer: vocabSize (integer > 0) is required");
    }
    const capacity = Math.ceil(windowS / frameS);   // default 30 s / 0.08 s = 375 frames
    const V = vocabSize;
    const store = new Float32Array(capacity * V);   // ≈ 375 × 1025 × 4 B ≈ 1.54 MB
    const tag = new Int32Array(capacity).fill(-1);  // absIndex currently held by each slot
    let maxIdx = -1;

    /* Store/overwrite one frame's logprob row. `row` may be a subarray
     * VIEW into the ORT output tensor — the bytes are COPIED into the
     * ring here, so no reference into ORT's (reused) buffer is retained.
     * Returns false (drops) for a frame older than the retained window:
     * its slot may already hold a newer frame that must not be clobbered
     * by stale data. */
    function set(absIdx, row) {
        if (!Number.isInteger(absIdx) || absIdx < 0) return false;
        if (row.length !== V) throw new Error(`logprob row length ${row.length} ≠ vocabSize ${V}`);
        if (maxIdx >= 0 && absIdx <= maxIdx - capacity) return false;
        const slot = absIdx % capacity;
        tag[slot] = absIdx;
        store.set(row, slot * V);
        if (absIdx > maxIdx) maxIdx = absIdx;
        return true;
    }

    /* Row for an absolute frame, or null if never set / evicted.
     * Returns a COPY — a ring slot can be overwritten by a later decode
     * step, and callers (the future repair layer) may hold rows across
     * steps. */
    function get(absIdx) {
        if (!Number.isInteger(absIdx) || absIdx < 0) return null;
        const slot = absIdx % capacity;
        if (tag[slot] !== absIdx) return null;
        return store.slice(slot * V, slot * V + V);
    }

    /* Rows for [startFrame, endFrame] inclusive; null holes for frames
     * not retained. */
    function getRange(startFrame, endFrame) {
        const rows = [];
        for (let i = startFrame; i <= endFrame; i++) rows.push(get(i));
        return rows;
    }

    function reset() {
        tag.fill(-1);
        maxIdx = -1;
    }

    /* Introspection (debug/diagnostics only — nothing live reads this). */
    function stats() {
        let held = 0, minIdx = Infinity;
        for (let s = 0; s < capacity; s++) {
            if (tag[s] >= 0) { held++; if (tag[s] < minIdx) minIdx = tag[s]; }
        }
        return {
            capacity, vocabSize: V, frameS,
            held, minIdx: held ? minIdx : -1, maxIdx,
            bytes: store.byteLength,
        };
    }

    return { set, get, getRange, reset, stats, capacity, vocabSize: V, frameS };
}

/* ============================================================
 * createUnboundedLogprobSink — DEV-ONLY companion (tasmee-lab capture).
 * SAME contract as the ring (absolute-frame keying, latest-decode-wins
 * overwrite, rows copied out of the caller's view) but UNBOUNDED: it
 * retains every frame of a whole offline clip so replay/scoring can
 * reconstruct any decode window without ORT. Never used by the live
 * path (the worker only creates it when init carries the dev flag);
 * memory is a whole-clip concern (~51 KB/s), fine for dev captures.
 * ============================================================ */
export function createUnboundedLogprobSink({ vocabSize, frameS = 0.08 } = {}) {
    if (!Number.isInteger(vocabSize) || vocabSize <= 0) {
        throw new Error("createUnboundedLogprobSink: vocabSize (integer > 0) is required");
    }
    const V = vocabSize;
    const map = new Map();          // absIdx → Float32Array(V) (owned copies)
    let maxIdx = -1, setCalls = 0;

    function set(absIdx, row) {
        if (!Number.isInteger(absIdx) || absIdx < 0) return false;
        if (row.length !== V) throw new Error(`logprob row length ${row.length} ≠ vocabSize ${V}`);
        setCalls++;
        let dst = map.get(absIdx);
        if (!dst) { dst = new Float32Array(V); map.set(absIdx, dst); }
        dst.set(row);               // overwrite in place — latest decode wins
        if (absIdx > maxIdx) maxIdx = absIdx;
        return true;
    }

    function get(absIdx) {
        const r = map.get(absIdx);
        return r ? r.slice() : null;
    }

    function getRange(startFrame, endFrame) {
        const rows = [];
        for (let i = startFrame; i <= endFrame; i++) rows.push(get(i));
        return rows;
    }

    function reset() { map.clear(); maxIdx = -1; setCalls = 0; }

    function stats() {
        let minIdx = Infinity;
        for (const k of map.keys()) if (k < minIdx) minIdx = k;
        return {
            capacity: Infinity, vocabSize: V, frameS,
            held: map.size, setCalls,           // setCalls ≫ held proves overwrite-not-append
            minIdx: map.size ? minIdx : -1, maxIdx,
            bytes: map.size * V * 4,
        };
    }

    /* Flatten for postMessage transfer / persistence: ascending indices +
     * one contiguous Float32Array of rows. */
    function exportFrames() {
        const indices = Int32Array.from([...map.keys()].sort((a, b) => a - b));
        const data = new Float32Array(indices.length * V);
        indices.forEach((idx, i) => data.set(map.get(idx), i * V));
        return { indices, data, V, setCalls };
    }

    return { set, get, getRange, reset, stats, exportFrames, vocabSize: V, frameS };
}
