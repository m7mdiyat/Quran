/* ============================================================
 * update-notice.js — one-time in-app notice after the iOS origin
 * migration (capacitor://localhost → http://localhost:17843, the
 * in-app HTTP server).
 *
 * The native wrapper migrates localStorage (notes, gharib learned,
 * resume position, repeat, tour, settings) across the origin change
 * and marks it with m7MigrationImportedV1. Cache API content (reciter
 * audio, QCF4 mushaf pages, tafsir) is deliberately NOT migrated —
 * re-downloadable by design (ruling 2026-07-12). This module tells
 * those users, once: the app got an upgrade, saved data came along,
 * offline content needs re-downloading.
 *
 * Gating: only when the wrapper's import flag exists (fresh installs
 * and website users never see it), shown each launch until explicitly
 * acknowledged once (m7_update_notice_ack), then never again.
 * ============================================================ */

const IMPORT_FLAG = "m7MigrationImportedV1"; // set by the wrapper's import WKUserScript
const ACK_KEY = "m7_update_notice_ack";
const REVEAL_DELAY_MS = 1400; // let the splash/first paint settle first

const CSS = `
.m7-update-notice {
  position: fixed;
  inset-inline: 12px;
  bottom: calc(12px + env(safe-area-inset-bottom));
  z-index: 9998;
  background: #ffffff;
  color: #14212e;
  border: 1px solid #c9d8ea;
  border-radius: 14px;
  box-shadow: 0 8px 28px rgba(10, 30, 55, .22);
  padding: 14px 16px;
  font-size: 14px;
  line-height: 1.7;
  transform: translateY(16px);
  opacity: 0;
  transition: transform .35s ease, opacity .35s ease;
}
.m7-update-notice--in { transform: none; opacity: 1; }
.m7-update-notice__title { font-weight: 700; margin-bottom: 4px; }
.m7-update-notice__ok {
  display: block;
  margin-top: 10px;
  margin-inline-start: auto;
  padding: 8px 22px;
  border: 0;
  border-radius: 9px;
  background: #1c5d8f;
  color: #fff;
  font-size: 14px;
  font-weight: 600;
}
html.dark .m7-update-notice {
  background: #16222e;
  color: #d7e3ee;
  border-color: #2b3d50;
}
`;

export function initUpdateNotice() {
  try {
    if (!localStorage.getItem(IMPORT_FLAG)) return;
    if (localStorage.getItem(ACK_KEY)) return;
  } catch { return; }

  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  const wrap = document.createElement("div");
  wrap.className = "m7-update-notice";
  wrap.setAttribute("dir", "rtl");
  wrap.setAttribute("role", "status");
  wrap.innerHTML = `
    <div class="m7-update-notice__title">قمنا بتحسينات كبيرة على التطبيق ✨</div>
    <div>ملاحظاتك ومحفوظاتك وموضع قراءتك انتقلت معك كما هي.
    المحتوى المحفوظ للاستخدام دون اتصال (التلاوات وصفحات المصحف والتفسير)
    يحتاج إلى إعادة تنزيل مرة واحدة من أماكنه المعتادة.</div>
    <button type="button" class="m7-update-notice__ok">حسناً، فهمت</button>`;

  wrap.querySelector(".m7-update-notice__ok").addEventListener("click", () => {
    try { localStorage.setItem(ACK_KEY, "1"); } catch { }
    wrap.classList.remove("m7-update-notice--in");
    setTimeout(() => { wrap.remove(); style.remove(); }, 400);
  });

  document.body.appendChild(wrap);
  setTimeout(() => {
    void wrap.offsetHeight; // force reflow so the entrance transition runs
    wrap.classList.add("m7-update-notice--in");
  }, REVEAL_DELAY_MS);
}
