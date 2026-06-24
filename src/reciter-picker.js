"use strict";

/*
 * Shared reciter picker — 4 default reciters shown as chips + a "+ المزيد" chip
 * (the SAME .mushaf-settings__chip pill style) that smoothly reveals the rest as
 * more identical chips. One consistent chip family, no separate panel/morph.
 *
 * Used identically by the Tafsir (app.js), Mushaf (mushaf.js), and fullscreen
 * (page-fullscreen.js) audio-settings panels. The reveal CSS lives in
 * public/mushaf.css (loaded globally); this module emits the markup and toggles
 * data-open / aria-expanded — CSS does the grow + fade.
 *
 * Defaults render in this EXACT order: سعود الشريم، علي جابر، عبدالمحسن القاسم،
 * محمد أيوب. Everything else is revealed by the toggle. The toggle carries no
 * data-val, so the existing per-surface click delegation (switchReciter, which
 * guards unknown keys) and the document-wide aria-checked sync keep working with
 * no changes — the selected reciter highlights wherever it lives, and the group
 * starts expanded when the active reciter is in the revealed set.
 */

// Change 3 — exact display order for the 4 defaults.
const DEFAULT_KEYS = ["shuraim", "alijaber", "qasim", "ayoub"];

function chipHtml(key, name) {
    return `<button type="button" class="mushaf-settings__chip" data-val="${key}">${name}</button>`;
}

export function buildReciterPickerHtml(orderedKeys, recitersMap, currentReciter) {
    if (!recitersMap) return "";
    const defaults = DEFAULT_KEYS.filter((k) => recitersMap[k]);
    const defaultSet = new Set(defaults);
    const rest = (orderedKeys || []).filter((k) => recitersMap[k] && !defaultSet.has(k));
    const defaultChips = defaults.map((k) => chipHtml(k, recitersMap[k].name)).join("");
    if (!rest.length) return defaultChips;

    const restChips = rest.map((k) => chipHtml(k, recitersMap[k].name)).join("");
    // Start expanded if the chosen reciter is in the revealed set, so its
    // highlight is visible immediately.
    const open = rest.includes(currentReciter);
    // Two toggle chips so the control always flows tightly WITH its chips: the
    // green "+ المزيد" sits after the 4 defaults (collapsed view); the red
    // "− أقل" sits at the end of the revealed chips (expanded view, inside the
    // collapsible so it's hidden when collapsed). Exactly one shows per state.
    const moreChip = `<button type="button" class="mushaf-settings__chip reciter-more reciter-more--more" data-reciter-more aria-expanded="${open ? "true" : "false"}">+ المزيد</button>`;
    const lessChip = `<button type="button" class="mushaf-settings__chip reciter-more reciter-more--less" data-reciter-more aria-expanded="${open ? "true" : "false"}">− أقل</button>`;
    return (
        `<div class="reciter-pick-group" data-open="${open ? "true" : "false"}">` +
            `<div class="reciter-pick-group__chips">${defaultChips}${moreChip}</div>` +
            `<div class="reciter-pick-group__rest"><div class="reciter-pick-group__rest-inner">${restChips}${lessChip}</div></div>` +
        `</div>`
    );
}

let _wired = false;
/* One document-level delegate toggles every reciter picker on every surface
 * (Tafsir, Mushaf, fullscreen), including lazily-built ones. Idempotent. The
 * toggle chip also bubbles to the surface's own chip handler, but that calls
 * switchReciter(undefined) → a guarded no-op. */
export function initReciterPicker() {
    if (_wired) return;
    _wired = true;
    document.addEventListener("click", (e) => {
        const toggle = e.target.closest("[data-reciter-more]");
        if (!toggle) return;
        const group = toggle.closest(".reciter-pick-group");
        if (!group) return;
        const open = group.getAttribute("data-open") === "true";
        group.setAttribute("data-open", open ? "false" : "true");
        toggle.setAttribute("aria-expanded", open ? "false" : "true");
    });
}
