/*
 * Personal ayah notes — APP ONLY.
 *
 * On-device note-taking, no login, no backend. The user long-presses an ayah
 * in the Mushaf and picks "ملاحظة" → editor sheet → text saved under
 * "m7_notes" in localStorage as { "S:A": { text, created, updated } }. A
 * second header button ("ملاحظاتي") opens a list of all notes with jump /
 * edit / delete actions per row.
 *
 * Two UI surfaces (both reuse the .offline-sheet* classes for visual parity
 * with the existing offline + feedback panels):
 *
 *   - Editor sheet  → openNoteEditor(s, a)  // one ayah's note
 *   - List sheet    → openNotesList()        // every saved note
 *
 * The data layer fires subscribers on every change so the Mushaf can refresh
 * its has-note dots without polling.
 */

"use strict";

import { isApp } from "./app.js";

const STORAGE_KEY = "m7_notes";
const NOTE_MAX_CHARS = 5000;

let _cache = null;                  // load-once map { "S:A": { text, created, updated } }
const _listeners = new Set();
let _deps = null;
let _editorSheetEl = null;
let _listSheetEl = null;
let _editorState = { surah: null, ayah: null }; // current editor target
let _editorOpen = false;
let _listOpen = false;

/* ----------------------------- Data layer ----------------------------- */

function readAll() {
    if (_cache) return _cache;
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) { _cache = {}; return _cache; }
        const obj = JSON.parse(raw);
        if (obj && typeof obj === "object") {
            _cache = obj;
            return _cache;
        }
    } catch { /* fall through */ }
    // Corrupt blob: log + treat as empty (don't wipe — leave it for inspection).
    console.warn("[notes] corrupt m7_notes payload; treating as empty");
    _cache = {};
    return _cache;
}

function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(_cache || {})); }
    catch { /* quota — ignore */ }
}

function notifyChange() {
    for (const fn of _listeners) { try { fn(); } catch { } }
}

export function hasNote(s, a) {
    return !!readAll()[`${s}:${a}`];
}

export function getNote(s, a) {
    return readAll()[`${s}:${a}`] || null;
}

export function getAllNotes() {
    return Object.entries(readAll())
        .map(([key, v]) => {
            const [s, a] = key.split(":").map(Number);
            return { surah: s, ayah: a, ...v };
        })
        .filter((n) => Number.isFinite(n.surah) && Number.isFinite(n.ayah))
        .sort((x, y) => (y.updated || 0) - (x.updated || 0));
}

export function getNoteKeysSet() {
    return new Set(Object.keys(readAll()));
}

export function saveNote(s, a, text) {
    const trimmed = (text || "").slice(0, NOTE_MAX_CHARS);
    const key = `${s}:${a}`;
    const now = Date.now();
    const all = readAll();
    if (!trimmed) {
        if (all[key]) {
            delete all[key];
            persist();
            notifyChange();
        }
        return;
    }
    const prev = all[key];
    all[key] = {
        text: trimmed,
        created: prev?.created || now,
        updated: now,
    };
    persist();
    notifyChange();
}

export function deleteNote(s, a) {
    const key = `${s}:${a}`;
    const all = readAll();
    if (all[key]) {
        delete all[key];
        persist();
        notifyChange();
    }
}

export function subscribeNotes(fn) {
    _listeners.add(fn);
    return () => _listeners.delete(fn);
}

/* ----------------------------- Editor sheet ----------------------------- */

function ensurePanelFont() {
    if (document.getElementById("offlinePanelFont")) return;
    const link = document.createElement("link");
    link.id = "offlinePanelFont";
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap";
    document.head.appendChild(link);
}

function buildEditorSheet() {
    if (_editorSheetEl) return _editorSheetEl;
    ensurePanelFont();
    const wrap = document.createElement("div");
    wrap.id = "notesEditorSheet";
    wrap.className = "offline-sheet";
    wrap.setAttribute("aria-hidden", "true");
    wrap.innerHTML = `
      <div class="offline-sheet__backdrop" data-note-close></div>
      <div class="offline-sheet__card" role="dialog" aria-modal="true" aria-labelledby="noteEditorTitle">
        <button type="button" class="offline-sheet__close" data-note-close aria-label="إغلاق">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
        <div class="offline-sheet__head">
          <div class="offline-sheet__icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M12 20h9"/><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
          </div>
          <h2 id="noteEditorTitle" class="offline-sheet__title">ملاحظة</h2>
          <p class="offline-sheet__desc" data-note-ref>—</p>
        </div>
        <div class="notes-editor">
          <div class="notes-editor__ayah" data-note-ayah-text></div>
          <textarea class="feedback-input feedback-textarea notes-editor__textarea"
                    placeholder="اكتب ملاحظتك على هذه الآية..." rows="6" maxlength="${NOTE_MAX_CHARS}"></textarea>
          <div class="notes-editor__counter" aria-live="polite">0 / ${NOTE_MAX_CHARS}</div>
          <div class="notes-editor__actions">
            <button type="button" class="offline-btn offline-btn--primary" data-note-save>حفظ</button>
            <button type="button" class="offline-btn offline-btn--ghost offline-btn--danger-text" data-note-delete style="display:none;">حذف</button>
            <button type="button" class="offline-btn offline-btn--ghost" data-note-close>إلغاء</button>
          </div>
          <div class="notes-editor__hint">تُحفظ ملاحظاتك على هذا الجهاز فقط.</div>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    _editorSheetEl = wrap;

    const ta = wrap.querySelector(".notes-editor__textarea");
    const counter = wrap.querySelector(".notes-editor__counter");
    ta.addEventListener("input", () => {
        counter.textContent = `${ta.value.length} / ${NOTE_MAX_CHARS}`;
    });

    wrap.addEventListener("click", (e) => {
        if (e.target.closest("[data-note-close]")) { closeEditor(); return; }
        if (e.target.closest("[data-note-save]")) { onEditorSave(); return; }
        if (e.target.closest("[data-note-delete]")) { onEditorDelete(); return; }
    });
    return wrap;
}

export function openNoteEditor(surah, ayah) {
    if (!isApp()) return;
    const s = Number(surah), a = Number(ayah);
    if (!s || !a) return;
    buildEditorSheet();
    _editorState = { surah: s, ayah: a };
    _editorOpen = true;

    const sheet = _editorSheetEl;
    const refEl = sheet.querySelector("[data-note-ref]");
    const ayahTextEl = sheet.querySelector("[data-note-ayah-text]");
    const ta = sheet.querySelector(".notes-editor__textarea");
    const counter = sheet.querySelector(".notes-editor__counter");
    const delBtn = sheet.querySelector("[data-note-delete]");

    if (refEl) refEl.textContent = `سورة ${surahName(s)} · آية ${a}`;
    if (ayahTextEl) {
        const text = _deps?.getAyahPlainText?.(s, a) || "";
        ayahTextEl.textContent = text;
        ayahTextEl.style.display = text ? "" : "none";
    }
    const existing = getNote(s, a);
    if (ta) ta.value = existing?.text || "";
    if (counter) counter.textContent = `${ta?.value.length || 0} / ${NOTE_MAX_CHARS}`;
    if (delBtn) delBtn.style.display = existing ? "" : "none";

    sheet.classList.add("offline-sheet--open");
    sheet.setAttribute("aria-hidden", "false");
    document.body.classList.add("offline-sheet-open");
    setTimeout(() => ta?.focus(), 60);
    document.addEventListener("keydown", onEditorKeydown);
}

function closeEditor() {
    _editorOpen = false;
    if (_editorSheetEl) {
        _editorSheetEl.classList.remove("offline-sheet--open");
        _editorSheetEl.setAttribute("aria-hidden", "true");
    }
    document.body.classList.remove("offline-sheet-open");
    document.removeEventListener("keydown", onEditorKeydown);
}

function onEditorKeydown(e) {
    if (e.key === "Escape" && _editorOpen) closeEditor();
}

function onEditorSave() {
    const { surah, ayah } = _editorState;
    if (!surah || !ayah) return;
    const ta = _editorSheetEl?.querySelector(".notes-editor__textarea");
    const text = (ta?.value || "").trim();
    if (!text) {
        deleteNote(surah, ayah);
        showSmallToast("تم الحذف");
    } else {
        saveNote(surah, ayah, text);
        showSmallToast("تم الحفظ");
    }
    closeEditor();
}

function onEditorDelete() {
    const { surah, ayah } = _editorState;
    if (!surah || !ayah) return;
    deleteNote(surah, ayah);
    showSmallToast("تم الحذف");
    closeEditor();
}

/* ----------------------------- List sheet ----------------------------- */

function buildListSheet() {
    if (_listSheetEl) return _listSheetEl;
    ensurePanelFont();
    const wrap = document.createElement("div");
    wrap.id = "notesListSheet";
    wrap.className = "offline-sheet";
    wrap.setAttribute("aria-hidden", "true");
    wrap.innerHTML = `
      <div class="offline-sheet__backdrop" data-notes-close></div>
      <div class="offline-sheet__card" role="dialog" aria-modal="true" aria-labelledby="notesListTitle">
        <button type="button" class="offline-sheet__close" data-notes-close aria-label="إغلاق">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
        <div class="offline-sheet__head">
          <div class="offline-sheet__icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4h12a4 4 0 0 1 4 4v12H8a4 4 0 0 1-4-4Z"/><path stroke-linecap="round" stroke-linejoin="round" d="M8 8h8M8 12h8M8 16h5"/></svg>
          </div>
          <h2 id="notesListTitle" class="offline-sheet__title">تدبرياتي</h2>
          <p class="offline-sheet__desc">جميع ملاحظاتك المحفوظة على هذا الجهاز.</p>
        </div>
        <div class="notes-list" data-notes-list></div>
      </div>`;
    document.body.appendChild(wrap);
    _listSheetEl = wrap;

    wrap.addEventListener("click", (e) => {
        if (e.target.closest("[data-notes-close]")) { closeList(); return; }
        const row = e.target.closest("[data-note-row]");
        if (!row) return;
        const s = Number(row.dataset.s);
        const a = Number(row.dataset.a);
        if (e.target.closest("[data-act-delete]")) {
            deleteNote(s, a);
            return;
        }
        if (e.target.closest("[data-act-edit]")) {
            closeList();
            openNoteEditor(s, a);
            return;
        }
        if (e.target.closest("[data-act-jump]")) {
            closeList();
            _deps?.jumpToAyah?.(s, a);
            return;
        }
        // Default (tap on the row outside any action button): also jump.
        closeList();
        _deps?.jumpToAyah?.(s, a);
    });
    return wrap;
}

function renderList() {
    if (!_listSheetEl) return;
    const slot = _listSheetEl.querySelector("[data-notes-list]");
    if (!slot) return;
    const notes = getAllNotes();
    if (!notes.length) {
        slot.innerHTML = `
          <div class="notes-list__empty">
            لا توجد ملاحظات بعد.<br/>اضغط مطولًا على آية في وضع التدبر ثم "ملاحظة" لإضافة واحدة.
          </div>`;
        return;
    }
    slot.innerHTML = notes.map((n) => {
        const preview = (n.text || "").slice(0, 80).replace(/\s+/g, " ").trim();
        const ts = formatDate(n.updated);
        return `
          <div class="notes-list__row" data-note-row data-s="${n.surah}" data-a="${n.ayah}" role="button" tabindex="0">
            <div class="notes-list__row-head">
              <span class="notes-list__row-ref">${surahName(n.surah)} · آية ${n.ayah}</span>
              <span class="notes-list__row-time">${ts}</span>
            </div>
            <div class="notes-list__row-preview">${escapeHtml(preview)}${n.text.length > 80 ? "…" : ""}</div>
            <div class="notes-list__row-actions">
              <button type="button" class="offline-btn offline-btn--primary" data-act-jump>اذهب للآية</button>
              <button type="button" class="offline-btn offline-btn--ghost" data-act-edit>تعديل</button>
              <button type="button" class="offline-btn offline-btn--ghost offline-btn--danger-text" data-act-delete>حذف</button>
            </div>
          </div>`;
    }).join("");
}

export function openNotesList() {
    if (!isApp()) return;
    buildListSheet();
    _listOpen = true;
    renderList();
    _listSheetEl.classList.add("offline-sheet--open");
    _listSheetEl.setAttribute("aria-hidden", "false");
    document.body.classList.add("offline-sheet-open");
    document.addEventListener("keydown", onListKeydown);
}

function closeList() {
    _listOpen = false;
    if (_listSheetEl) {
        _listSheetEl.classList.remove("offline-sheet--open");
        _listSheetEl.setAttribute("aria-hidden", "true");
    }
    document.body.classList.remove("offline-sheet-open");
    document.removeEventListener("keydown", onListKeydown);
}

function onListKeydown(e) {
    if (e.key === "Escape" && _listOpen) closeList();
}

// Re-render the list when notes change so a delete/save inside it updates
// the visible rows immediately.
subscribeNotes(() => {
    if (_listOpen) renderList();
});

/* ----------------------------- Init ----------------------------- */

export function initNotesPanel(deps) {
    if (!isApp()) return;
    _deps = deps || {};
    // Reveal the header "ملاحظاتي" button.
    const btn = document.getElementById("notesMenuBtn");
    if (btn) {
        btn.style.display = "";
        btn.addEventListener("click", () => {
            if (_listOpen) closeList(); else openNotesList();
        });
    }
}

/* ----------------------------- Helpers ----------------------------- */

const SURAH_NAMES_AR = [
    "", "الفاتحة","البقرة","آل عمران","النساء","المائدة","الأنعام","الأعراف","الأنفال","التوبة","يونس",
    "هود","يوسف","الرعد","إبراهيم","الحجر","النحل","الإسراء","الكهف","مريم","طه","الأنبياء","الحج",
    "المؤمنون","النور","الفرقان","الشعراء","النمل","القصص","العنكبوت","الروم","لقمان","السجدة",
    "الأحزاب","سبأ","فاطر","يس","الصافات","ص","الزمر","غافر","فصلت","الشورى","الزخرف","الدخان",
    "الجاثية","الأحقاف","محمد","الفتح","الحجرات","ق","الذاريات","الطور","النجم","القمر","الرحمن",
    "الواقعة","الحديد","المجادلة","الحشر","الممتحنة","الصف","الجمعة","المنافقون","التغابن","الطلاق",
    "التحريم","الملك","القلم","الحاقة","المعارج","نوح","الجن","المزمل","المدثر","القيامة","الإنسان",
    "المرسلات","النبأ","النازعات","عبس","التكوير","الانفطار","المطففين","الانشقاق","البروج","الطارق",
    "الأعلى","الغاشية","الفجر","البلد","الشمس","الليل","الضحى","الشرح","التين","العلق","القدر",
    "البينة","الزلزلة","العاديات","القارعة","التكاثر","العصر","الهمزة","الفيل","قريش","الماعون",
    "الكوثر","الكافرون","النصر","المسد","الإخلاص","الفلق","الناس",
];
function surahName(s) { return SURAH_NAMES_AR[s] || `سورة ${s}`; }

function escapeHtml(str = "") {
    return String(str).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
}

function formatDate(ms) {
    if (!ms) return "";
    try {
        return new Date(ms).toLocaleDateString("ar-EG-u-nu-latn", {
            year: "numeric", month: "short", day: "numeric",
        });
    } catch { return ""; }
}

/* Lightweight toast (reuses the .copy-toast element / class created by
 * mushaf.js — same visual treatment, same lifecycle, single shared DOM node). */
let _toastEl = null;
let _toastTimer = null;
function showSmallToast(msg) {
    if (!_toastEl) {
        _toastEl = document.querySelector(".copy-toast");
        if (!_toastEl) {
            _toastEl = document.createElement("div");
            _toastEl.className = "copy-toast";
            _toastEl.setAttribute("role", "status");
            _toastEl.setAttribute("aria-live", "polite");
            document.body.appendChild(_toastEl);
        }
    }
    _toastEl.textContent = msg;
    _toastEl.classList.remove("copy-toast--show");
    void _toastEl.offsetWidth;
    _toastEl.classList.add("copy-toast--show");
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => {
        _toastEl?.classList.remove("copy-toast--show");
    }, 1800);
}
