import{s as O,a as I,T as B,Q as P,i as g,b as T,c as L,d as N,e as R,f as D,g as F,h as q}from"./index-KqF0QFAN.js";let l=null,f=null,E=null,k=null,w=!1;const a={mushaf:null,tafsir:null},r={mushaf:{title:"وضع التدبّر",desc:"صفحات المصحف الكاملة وخطوطه.",sizeMb:P,startDownload:()=>q(),deleteCache:()=>F()},tafsir:{title:"وضع التفسير",desc:'سبعة تفاسير كاملة + ملخّص "مختصر التفاسير" لكل آية.',sizeMb:B,startDownload:()=>D(),deleteCache:()=>R()}};function z(){if(document.getElementById("offlinePanelFont"))return;const e=document.createElement("link");e.id="offlinePanelFont",e.rel="stylesheet",e.href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap",document.head.appendChild(e)}function S(e){return`≈ ${e} ميجابايت`}function j(e,i){const n=r[e],o=i?.status||"idle";if(a[e]==="delete"&&(o==="done"||o==="idle"))return`
          <div class="offline-row__confirm">
            <span class="offline-row__confirm-text">هل أنت متأكد؟ سيُحذف ${S(n.sizeMb)} من جهازك.</span>
            <div class="offline-row__confirm-actions">
              <button type="button" class="offline-btn offline-btn--danger" data-offline-act="delete-confirm" data-offline-row="${e}">حذف</button>
              <button type="button" class="offline-btn offline-btn--ghost" data-offline-act="delete-cancel" data-offline-row="${e}">إلغاء</button>
            </div>
          </div>`;if(o==="downloading"){const t=Math.max(0,Math.min(100,Number(i.pct)||0)),c=i.message||"";return`
          <div class="offline-row__progress">
            <div class="mushaf-download__bar"><div class="mushaf-download__fill" style="width:${t}%"></div></div>
            <div class="offline-row__progress-row">
              <span class="offline-row__progress-msg t-text-swap">${c}</span>
              <span class="offline-row__progress-pct">${t}%</span>
            </div>
          </div>`}return o==="offline"?`
          <div class="offline-row__pill offline-row__pill--warn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M3 3l18 18M8.5 8.5A11 11 0 003 12m4.5-3.5a11 11 0 0113.5 3.5M12 20h.01"/></svg>
            <span>لا يوجد اتصال بالإنترنت — سيستأنف عند عودة الاتصال</span>
          </div>`:o==="error"?`
          <div class="offline-row__pill offline-row__pill--err">
            <span class="t-text-swap">${i.message||"تعذّر التحميل"}</span>
            <button type="button" class="offline-btn offline-btn--ghost" data-offline-act="download" data-offline-row="${e}">إعادة المحاولة</button>
          </div>`:o==="done"?`
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
        تحميل (${S(n.sizeMb)})
      </button>`}function d(e,i){if(!l)return;const n=l.querySelector(`.offline-row[data-offline-row="${e}"] .offline-row__status`);if(!n)return;const o=i?.status||"idle",t=`${o}|${a[e]||""}`;if(n.dataset.sig===t){if(o==="downloading"){const c=Math.max(0,Math.min(100,Number(i.pct)||0)),h=n.querySelector(".mushaf-download__fill");h&&(h.style.width=`${c}%`),L(n.querySelector(".offline-row__progress-msg"),i.message||"");const u=n.querySelector(".offline-row__progress-pct");u&&(u.textContent=`${c}%`)}else o==="error"&&L(n.querySelector(".offline-row__pill--err .t-text-swap"),i.message||"تعذّر التحميل");return}n.dataset.sig=t,N(n,()=>{n.innerHTML=j(e,i)})}function H(){l&&(g()&&d("mushaf",{status:"done"}),T()&&d("tafsir",{status:"done"}))}function Q(){if(l)return l;z();const e=document.createElement("div");return e.id="offlineSheet",e.className="offline-sheet",e.setAttribute("aria-hidden","true"),e.innerHTML=`
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
              <div class="offline-row__title">${r.mushaf.title}</div>
            </div>
            <div class="offline-row__desc">${r.mushaf.desc}</div>
            <div class="offline-row__status"></div>
          </div>
          <div class="offline-row" data-offline-row="tafsir">
            <div class="offline-row__head">
              <div class="offline-row__title">${r.tafsir.title}</div>
            </div>
            <div class="offline-row__desc">${r.tafsir.desc}</div>
            <div class="offline-row__status"></div>
          </div>
        </div>
      </div>`,document.body.appendChild(e),l=e,e.addEventListener("click",U),e}function U(e){if(e.target.closest("[data-offline-close]")){M();return}const n=e.target.closest("[data-offline-act]");if(!n)return;const o=n.dataset.offlineAct,t=n.dataset.offlineRow;if(!(!t||!r[t])){if(o==="download"){a[t]=null,r[t].startDownload();return}if(o==="delete"){a[t]="delete",d(t,t==="mushaf"?g()?{status:"done"}:{status:"idle"}:T()?{status:"done"}:{status:"idle"});return}if(o==="delete-cancel"){a[t]=null,d(t,t==="mushaf"?g()?{status:"done"}:{status:"idle"}:T()?{status:"done"}:{status:"idle"});return}if(o==="delete-confirm"){a[t]=null,r[t].deleteCache().then(()=>{d(t,{status:"idle"})});return}}}function x(e){e.key==="Escape"&&w&&M()}function W(){Q(),w=!0,l.classList.add("offline-sheet--open"),l.setAttribute("aria-hidden","false"),document.body.classList.add("offline-sheet-open"),H(),E=O(e=>d("mushaf",e)),k=I(e=>d("tafsir",e)),document.addEventListener("keydown",x)}function M(){w=!1,l&&(l.classList.remove("offline-sheet--open"),l.setAttribute("aria-hidden","true")),document.body.classList.remove("offline-sheet-open"),E?.(),E=null,k?.(),k=null,document.removeEventListener("keydown",x),a.mushaf=null,a.tafsir=null}function Z(){if(f=document.getElementById("offlineMenuBtn"),!!f){f.style.display="",f.addEventListener("click",()=>{w?M():W(),v()});try{localStorage.getItem(A)||V()}catch{}}}const A="m7_offline_tooltip_seen",G=1e4,$=8;let s=null,p=null,_=null;function V(){p=setTimeout(()=>{p=null,X()},700)}function X(){if(!f||document.getElementById("m7OfflineTip"))return;const e=document.createElement("div");e.id="m7OfflineTip",e.className="m7-tip",e.setAttribute("role","status"),e.setAttribute("aria-live","polite"),e.innerHTML=`
      <div class="m7-tip__arrow"></div>
      <div class="m7-tip__text">للاستخدام بدون إنترنت</div>
      <button type="button" class="m7-tip__close" aria-label="إغلاق">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      </button>`,document.body.appendChild(e),s=e,requestAnimationFrame(()=>{m(),requestAnimationFrame(()=>{e.classList.add("m7-tip--show")})}),e.querySelector(".m7-tip__close")?.addEventListener("click",i=>{i.stopPropagation(),v()}),document.addEventListener("pointerdown",Y,{capture:!0,once:!0}),window.addEventListener("resize",m),window.addEventListener("scroll",m,{passive:!0}),_=setTimeout(()=>{_=null,v()},G)}function m(){if(!s||!f)return;const e=f.getBoundingClientRect(),i=e.left+e.width/2,n=s.offsetWidth||220,o=n/2,t=window.innerWidth||document.documentElement.clientWidth||360,c=$+o,h=t-$-o,u=Math.max(c,Math.min(h,i));s.style.top=`${e.bottom+12}px`,s.style.left=`${u}px`;const y=s.querySelector(".m7-tip__arrow");if(y){const C=u-o;let b=i-C;b=Math.max(14,Math.min(n-14,b)),y.style.left=`${b}px`}}function v(){p&&(clearTimeout(p),p=null),_&&(clearTimeout(_),_=null);try{localStorage.setItem(A,"1")}catch{}if(!s)return;s.classList.remove("m7-tip--show");const e=s;s=null,setTimeout(()=>{try{e.remove()}catch{}},240),window.removeEventListener("resize",m),window.removeEventListener("scroll",m)}function Y(e){s&&(e.target.closest("#m7OfflineTip")||v())}export{Z as initOfflinePanel};
