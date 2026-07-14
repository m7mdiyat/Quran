const n="m7MigrationImportedV1",o="m7_update_notice_ack";const i=`
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
`;function a(){try{if(!localStorage.getItem(n)||localStorage.getItem(o))return}catch{return}const e=document.createElement("style");e.textContent=i,document.head.appendChild(e);const t=document.createElement("div");t.className="m7-update-notice",t.setAttribute("dir","rtl"),t.setAttribute("role","status"),t.innerHTML=`
    <div class="m7-update-notice__title">قمنا بتحسينات كبيرة على التطبيق ✨</div>
    <div>ملاحظاتك ومحفوظاتك وموضع قراءتك انتقلت معك كما هي.
    المحتوى المحفوظ للاستخدام دون اتصال (التلاوات وصفحات المصحف والتفسير)
    يحتاج إلى إعادة تنزيل مرة واحدة من أماكنه المعتادة.</div>
    <button type="button" class="m7-update-notice__ok">حسناً، فهمت</button>`,t.querySelector(".m7-update-notice__ok").addEventListener("click",()=>{try{localStorage.setItem(o,"1")}catch{}t.classList.remove("m7-update-notice--in"),setTimeout(()=>{t.remove(),e.remove()},400)}),document.body.appendChild(t),setTimeout(()=>{t.offsetHeight,t.classList.add("m7-update-notice--in")},1400)}export{a as initUpdateNotice};
