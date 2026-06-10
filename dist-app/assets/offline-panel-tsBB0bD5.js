import{s as $,a as I,T as x,Q as B,i as w,b,d as P,c as R,e as D,f as F}from"./index-BRlEudUn.js";let l=null,r=null,g=null,T=null,p=!1;const f={mushaf:null,tafsir:null},a={mushaf:{title:"وضع التدبّر",desc:"صفحات المصحف الكاملة وخطوطه.",sizeMb:B,startDownload:()=>F(),deleteCache:()=>D()},tafsir:{title:"وضع التفسير",desc:'سبعة تفاسير كاملة + ملخّص "مختصر التفاسير" لكل آية.',sizeMb:x,startDownload:()=>R(),deleteCache:()=>P()}};function N(){if(document.getElementById("offlinePanelFont"))return;const e=document.createElement("link");e.id="offlinePanelFont",e.rel="stylesheet",e.href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap",document.head.appendChild(e)}function L(e){return`≈ ${e} ميجابايت`}function z(e,o){const i=a[e],n=o?.status||"idle";if(f[e]==="delete"&&(n==="done"||n==="idle"))return`
          <div class="offline-row__confirm">
            <span class="offline-row__confirm-text">هل أنت متأكد؟ سيُحذف ${L(i.sizeMb)} من جهازك.</span>
            <div class="offline-row__confirm-actions">
              <button type="button" class="offline-btn offline-btn--danger" data-offline-act="delete-confirm" data-offline-row="${e}">حذف</button>
              <button type="button" class="offline-btn offline-btn--ghost" data-offline-act="delete-cancel" data-offline-row="${e}">إلغاء</button>
            </div>
          </div>`;if(n==="downloading"){const t=Math.max(0,Math.min(100,Number(o.pct)||0)),h=o.message||"";return`
          <div class="offline-row__progress">
            <div class="mushaf-download__bar"><div class="mushaf-download__fill" style="width:${t}%"></div></div>
            <div class="offline-row__progress-row">
              <span class="offline-row__progress-msg">${h}</span>
              <span class="offline-row__progress-pct">${t}%</span>
            </div>
          </div>`}return n==="offline"?`
          <div class="offline-row__pill offline-row__pill--warn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M3 3l18 18M8.5 8.5A11 11 0 003 12m4.5-3.5a11 11 0 0113.5 3.5M12 20h.01"/></svg>
            <span>لا يوجد اتصال بالإنترنت — سيستأنف عند عودة الاتصال</span>
          </div>`:n==="error"?`
          <div class="offline-row__pill offline-row__pill--err">
            <span>${o.message||"تعذّر التحميل"}</span>
            <button type="button" class="offline-btn offline-btn--ghost" data-offline-act="download" data-offline-row="${e}">إعادة المحاولة</button>
          </div>`:n==="done"?`
          <div class="offline-row__done">
            <span class="offline-row__badge">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
              متاح بدون إنترنت
            </span>
            <div class="offline-row__done-actions">
              <button type="button" class="offline-btn offline-btn--ghost" data-offline-act="download" data-offline-row="${e}">إعادة التحميل</button>
              <button type="button" class="offline-btn offline-btn--ghost offline-btn--danger-text" data-offline-act="delete" data-offline-row="${e}">حذف لتحرير المساحة</button>
            </div>
          </div>`:`
      <button type="button" class="offline-btn offline-btn--primary" data-offline-act="download" data-offline-row="${e}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"/></svg>
        تحميل (${L(i.sizeMb)})
      </button>`}function d(e,o){if(!l)return;const i=l.querySelector(`.offline-row[data-offline-row="${e}"] .offline-row__status`);i&&(i.innerHTML=z(e,o))}function j(){l&&(w()&&d("mushaf",{status:"done"}),b()&&d("tafsir",{status:"done"}))}function H(){if(l)return l;N();const e=document.createElement("div");return e.id="offlineSheet",e.className="offline-sheet",e.setAttribute("aria-hidden","true"),e.innerHTML=`
      <div class="offline-sheet__backdrop" data-offline-close></div>
      <div class="offline-sheet__card" role="dialog" aria-modal="true" aria-labelledby="offlineSheetTitle">
        <button type="button" class="offline-sheet__close" data-offline-close aria-label="إغلاق">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
        <div class="offline-sheet__head">
          <div class="offline-sheet__icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 15a4.5 4.5 0 004.5 4.5H18a3.75 3.75 0 001.332-7.257 3 3 0 00-3.758-3.848 5.25 5.25 0 00-10.233 2.33A4.502 4.502 0 002.25 15z"/><path stroke-linecap="round" stroke-linejoin="round" d="M12 10.5v6m0 0l-2.25-2.25M12 16.5l2.25-2.25"/></svg>
          </div>
          <h2 id="offlineSheetTitle" class="offline-sheet__title">استخدام التطبيق بدون إنترنت</h2>
          <p class="offline-sheet__desc">للتدبر بدون انترنت، حمّل البيانات اللازمة لكل وضع.</p>
        </div>
        <div class="offline-sheet__rows">
          <div class="offline-row" data-offline-row="mushaf">
            <div class="offline-row__head">
              <div class="offline-row__title">${a.mushaf.title}</div>
            </div>
            <div class="offline-row__desc">${a.mushaf.desc}</div>
            <div class="offline-row__status"></div>
          </div>
          <div class="offline-row" data-offline-row="tafsir">
            <div class="offline-row__head">
              <div class="offline-row__title">${a.tafsir.title}</div>
            </div>
            <div class="offline-row__desc">${a.tafsir.desc}</div>
            <div class="offline-row__status"></div>
          </div>
        </div>
      </div>`,document.body.appendChild(e),l=e,e.addEventListener("click",Q),e}function Q(e){if(e.target.closest("[data-offline-close]")){E();return}const i=e.target.closest("[data-offline-act]");if(!i)return;const n=i.dataset.offlineAct,t=i.dataset.offlineRow;if(!(!t||!a[t])){if(n==="download"){f[t]=null,a[t].startDownload();return}if(n==="delete"){f[t]="delete",d(t,t==="mushaf"?w()?{status:"done"}:{status:"idle"}:b()?{status:"done"}:{status:"idle"});return}if(n==="delete-cancel"){f[t]=null,d(t,t==="mushaf"?w()?{status:"done"}:{status:"idle"}:b()?{status:"done"}:{status:"idle"});return}if(n==="delete-confirm"){f[t]=null,a[t].deleteCache().then(()=>{d(t,{status:"idle"})});return}}}function S(e){e.key==="Escape"&&p&&E()}function U(){H(),p=!0,l.classList.add("offline-sheet--open"),l.setAttribute("aria-hidden","false"),document.body.classList.add("offline-sheet-open"),j(),g=$(e=>d("mushaf",e)),T=I(e=>d("tafsir",e)),document.addEventListener("keydown",S)}function E(){p=!1,l&&(l.classList.remove("offline-sheet--open"),l.setAttribute("aria-hidden","true")),document.body.classList.remove("offline-sheet-open"),g?.(),g=null,T?.(),T=null,document.removeEventListener("keydown",S),f.mushaf=null,f.tafsir=null}function Y(){if(r=document.getElementById("offlineMenuBtn"),!!r){r.style.display="",r.addEventListener("click",()=>{p?E():U(),m()});try{localStorage.getItem(A)||W()}catch{}}}const A="m7_offline_tooltip_seen",q=1e4,y=8;let s=null,c=null,u=null;function W(){c=setTimeout(()=>{c=null,G()},700)}function G(){if(!r||document.getElementById("m7OfflineTip"))return;const e=document.createElement("div");e.id="m7OfflineTip",e.className="m7-tip",e.setAttribute("role","status"),e.setAttribute("aria-live","polite"),e.innerHTML=`
      <div class="m7-tip__arrow"></div>
      <div class="m7-tip__text">للاستخدام بدون إنترنت</div>
      <button type="button" class="m7-tip__close" aria-label="إغلاق">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      </button>`,document.body.appendChild(e),s=e,requestAnimationFrame(()=>{_(),requestAnimationFrame(()=>{e.classList.add("m7-tip--show")})}),e.querySelector(".m7-tip__close")?.addEventListener("click",o=>{o.stopPropagation(),m()}),document.addEventListener("pointerdown",V,{capture:!0,once:!0}),window.addEventListener("resize",_),window.addEventListener("scroll",_,{passive:!0}),u=setTimeout(()=>{u=null,m()},q)}function _(){if(!s||!r)return;const e=r.getBoundingClientRect(),o=e.left+e.width/2,i=s.offsetWidth||220,n=i/2,t=window.innerWidth||document.documentElement.clientWidth||360,h=y+n,C=t-y-n,k=Math.max(h,Math.min(C,o));s.style.top=`${e.bottom+12}px`,s.style.left=`${k}px`;const M=s.querySelector(".m7-tip__arrow");if(M){const O=k-n;let v=o-O;v=Math.max(14,Math.min(i-14,v)),M.style.left=`${v}px`}}function m(){c&&(clearTimeout(c),c=null),u&&(clearTimeout(u),u=null);try{localStorage.setItem(A,"1")}catch{}if(!s)return;s.classList.remove("m7-tip--show");const e=s;s=null,setTimeout(()=>{try{e.remove()}catch{}},240),window.removeEventListener("resize",_),window.removeEventListener("scroll",_)}function V(e){s&&(e.target.closest("#m7OfflineTip")||m())}export{Y as initOfflinePanel};
