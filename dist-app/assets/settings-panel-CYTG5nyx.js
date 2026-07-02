import{s as se,a as ie,T as ae,Q as oe,i as T,b as B,c as R,d as J,e as re,f as le,g as ce,h as de,j as D,A as fe}from"./index-CauUYgU4.js";import{subscribeReciterDl as ue,loadReciterSizes as pe,getReciterList as F,isReciterReady as b,isReciterDownloadBusy as he,reciterSizeBytes as be,downloadReciters as O,deleteReciter as ve}from"./reciter-offline-CzqUnO6Z.js";let l=null,I=null,H=null,q=null,E=!1,w=null;const u={mushaf:null,tafsir:null},f=new Set,v={},g={},p={mushaf:{title:"وضع التدبّر",desc:"صفحات المصحف الكاملة وخطوطه.",sizeMb:oe,startDownload:()=>de(),deleteCache:()=>ce()},tafsir:{title:"وضع التفسير",desc:'سبعة تفاسير كاملة + ملخّص "مختصر التفاسير" لكل آية.',sizeMb:ae,startDownload:()=>le(),deleteCache:()=>re()}};function _e(){if(document.getElementById("offlinePanelFont"))return;const e=document.createElement("link");e.id="offlinePanelFont",e.rel="stylesheet",e.href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap",document.head.appendChild(e)}function Q(e){return`≈ ${e} ميجابايت`}function j(e){const n=Number(e)||0;return n<=0?"…":n>=1004857600?`${(n/1073741824).toFixed(1)} جيجابايت`:`${Math.round(n/1048576)} ميجابايت`}const U='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>';function V(e,n){const{id:t,name:s,bytes:a}=e,i=n?.status||"idle";if(v[t]==="delete"&&i==="done")return`
          <div class="reciter-pick reciter-pick--confirm" data-reciter-id="${t}">
            <span class="reciter-pick__name">حذف تلاوة ${s}؟</span>
            <div class="reciter-pick__actions">
              <button type="button" class="offline-btn offline-btn--danger" data-reciter-act="delete-confirm" data-reciter-id="${t}">حذف</button>
              <button type="button" class="offline-btn offline-btn--ghost" data-reciter-act="delete-cancel" data-reciter-id="${t}">إلغاء</button>
            </div>
          </div>`;if(i==="done")return`
          <div class="reciter-pick reciter-pick--done" data-reciter-id="${t}">
            <span class="reciter-pick__check" aria-hidden="true">${U}</span>
            <span class="reciter-pick__name">${s}</span>
            <button type="button" class="offline-btn offline-btn--ghost offline-btn--danger-text reciter-pick__del" data-reciter-act="delete" data-reciter-id="${t}">حذف</button>
          </div>`;if(i==="downloading"){const o=Math.max(0,Math.min(100,Number(n.pct)||0));return`
          <div class="reciter-pick reciter-pick--busy" data-reciter-id="${t}">
            <div class="reciter-pick__top">
              <span class="reciter-pick__name">${s}</span>
              <span class="reciter-pick__pct">${o}%</span>
            </div>
            <div class="mushaf-download__bar"><div class="mushaf-download__fill" style="width:${o}%"></div></div>
            <span class="reciter-pick__msg t-text-swap">${n.message||""}</span>
          </div>`}if(i==="queued")return`
          <div class="reciter-pick reciter-pick--busy" data-reciter-id="${t}">
            <span class="reciter-pick__name">${s}</span>
            <span class="reciter-pick__hint">بالانتظار…</span>
          </div>`;if(i==="offline")return`
          <div class="reciter-pick reciter-pick--warn" data-reciter-id="${t}">
            <span class="reciter-pick__name">${s}</span>
            <span class="reciter-pick__hint">بانتظار الاتصال</span>
          </div>`;if(i==="error")return`
          <div class="reciter-pick reciter-pick--err" data-reciter-id="${t}">
            <span class="reciter-pick__name">${s}</span>
            <button type="button" class="offline-btn offline-btn--ghost" data-reciter-act="download-one" data-reciter-id="${t}">إعادة المحاولة</button>
          </div>`;const r=f.has(t);return`
      <button type="button" class="reciter-pick reciter-pick--pick${r?" is-checked":""}" role="checkbox" aria-checked="${r}" data-reciter-toggle="${t}">
        <span class="reciter-pick__box" aria-hidden="true">${r?U:""}</span>
        <span class="reciter-pick__name">${s}</span>
        <span class="reciter-pick__size">${j(a)}</span>
      </button>`}function X(e,n){const t=l?.querySelector(".offline-reciters__list");if(!t)return;const s=e.id;let a=t.querySelector(`[data-reciter-row="${s}"]`);const i=n?.status||"idle",r=`${i}|${v[s]||""}|${f.has(s)}`;if(a&&g[s]===r){if(i==="downloading"){const o=Math.max(0,Math.min(100,Number(n.pct)||0)),m=a.querySelector(".mushaf-download__fill");m&&(m.style.width=`${o}%`);const P=a.querySelector(".reciter-pick__pct");P&&(P.textContent=`${o}%`),R(a.querySelector(".reciter-pick__msg"),n.message||"")}return}if(g[s]=r,!a){a=document.createElement("div"),a.className="reciter-pick-slot",a.setAttribute("data-reciter-row",s),t.appendChild(a),a.innerHTML=V(e,n);return}J(a,()=>{a.innerHTML=V(e,n)})}function K(){const e=l?.querySelector(".offline-reciters__foot");if(!e)return;const t=F().filter(o=>!b(o.id));if(he()||!t.length){e.innerHTML="";return}let a=0;for(const o of f)b(o)||(a+=be(o));const i=[...f].filter(o=>!b(o)).length,r=i?`تحميل المحدّد (${j(a)})`:"اختر قارئًا للتحميل";e.innerHTML=`
      <div class="offline-reciters__total">
        <span class="offline-reciters__total-cap">المساحة المطلوبة</span>
        <span class="offline-reciters__total-val">${i?j(a):"—"}</span>
      </div>
      <button type="button" class="offline-btn offline-btn--primary" data-reciter-act="download" ${i?"":"disabled"}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"/></svg>
        ${r}
      </button>`}function G(e){if(!l)return;const n=F();if(n.length){for(const t of n){const s=e&&e[t.id]||(b(t.id)?{status:"done"}:{status:"idle"});X(t,s)}K()}}function ke(e,n){const t=p[e],s=n?.status||"idle";if(u[e]==="delete"&&(s==="done"||s==="idle"))return`
          <div class="offline-row__confirm">
            <span class="offline-row__confirm-text">هل أنت متأكد؟ سيُحذف ${Q(t.sizeMb)} من جهازك.</span>
            <div class="offline-row__confirm-actions">
              <button type="button" class="offline-btn offline-btn--danger" data-offline-act="delete-confirm" data-offline-row="${e}">حذف</button>
              <button type="button" class="offline-btn offline-btn--ghost" data-offline-act="delete-cancel" data-offline-row="${e}">إلغاء</button>
            </div>
          </div>`;if(s==="downloading"){const a=Math.max(0,Math.min(100,Number(n.pct)||0)),i=n.message||"";return`
          <div class="offline-row__progress">
            <div class="mushaf-download__bar"><div class="mushaf-download__fill" style="width:${a}%"></div></div>
            <div class="offline-row__progress-row">
              <span class="offline-row__progress-msg t-text-swap">${i}</span>
              <span class="offline-row__progress-pct">${a}%</span>
            </div>
          </div>`}return s==="offline"?`
          <div class="offline-row__pill offline-row__pill--warn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M3 3l18 18M8.5 8.5A11 11 0 003 12m4.5-3.5a11 11 0 0113.5 3.5M12 20h.01"/></svg>
            <span>لا يوجد اتصال بالإنترنت — سيستأنف عند عودة الاتصال</span>
          </div>`:s==="error"?`
          <div class="offline-row__pill offline-row__pill--err">
            <span class="t-text-swap">${n.message||"تعذّر التحميل"}</span>
            <button type="button" class="offline-btn offline-btn--ghost" data-offline-act="download" data-offline-row="${e}">إعادة المحاولة</button>
          </div>`:s==="done"?`
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
        تحميل (${Q(t.sizeMb)})
      </button>`}function _(e,n){if(!l)return;const t=l.querySelector(`.offline-row[data-offline-row="${e}"] .offline-row__status`);if(!t)return;const s=n?.status||"idle",a=`${s}|${u[e]||""}`;if(t.dataset.sig===a){if(s==="downloading"){const i=Math.max(0,Math.min(100,Number(n.pct)||0)),r=t.querySelector(".mushaf-download__fill");r&&(r.style.width=`${i}%`),R(t.querySelector(".offline-row__progress-msg"),n.message||"");const o=t.querySelector(".offline-row__progress-pct");o&&(o.textContent=`${i}%`)}else s==="error"&&R(t.querySelector(".offline-row__pill--err .t-text-swap"),n.message||"تعذّر التحميل");return}t.dataset.sig=a,J(t,()=>{t.innerHTML=ke(e,n)})}function ge(){l&&(T()&&_("mushaf",{status:"done"}),B()&&_("tafsir",{status:"done"}))}function me(){if(l)return l;_e();const e=document.createElement("div");return e.id="offlineSheet",e.className="offline-sheet offline-sheet--smooth",e.setAttribute("aria-hidden","true"),e.innerHTML=`
      <div class="offline-sheet__backdrop" data-offline-close></div>
      <div class="offline-sheet__card" role="dialog" aria-modal="true" aria-labelledby="offlineSheetTitle">
        <div class="offline-sheet__pin">
          <button type="button" class="offline-sheet__close" data-offline-close aria-label="إغلاق">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>
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
              <div class="offline-row__title">${p.mushaf.title}</div>
            </div>
            <div class="offline-row__desc">${p.mushaf.desc}</div>
            <div class="offline-row__status"></div>
          </div>
          <div class="offline-row" data-offline-row="tafsir">
            <div class="offline-row__head">
              <div class="offline-row__title">${p.tafsir.title}</div>
            </div>
            <div class="offline-row__desc">${p.tafsir.desc}</div>
            <div class="offline-row__status"></div>
          </div>
          <div class="offline-row offline-row--reciters t-acc" data-offline-reciters data-open="false">
            <button type="button" class="t-acc-head" data-acc-toggle aria-expanded="false">
              <span class="t-acc-head__row">
                <span class="offline-row__title">القرّاء</span>
                <span class="t-acc-chevron" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5L8 10.5L12 6.5"/></svg></span>
              </span>
              <span class="offline-row__desc">تلاوات كاملة للاستماع بدون إنترنت.</span>
            </button>
            <div class="t-acc-cta">
              <div class="t-acc-cta__inner">
                <button type="button" class="offline-btn offline-btn--primary t-acc-cta__btn" data-acc-toggle>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 18v-5a9 9 0 0 1 18 0v5"/><path d="M21 19a2 2 0 0 1-2 2h-1a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3zM3 19a2 2 0 0 0 2 2h1a1 1 0 0 0 1-1v-4a1 1 0 0 0-1-1H3z"/></svg>
                  اضغط لاختيار القرّاء
                </button>
              </div>
            </div>
            <div class="t-acc-panel">
              <div class="t-acc-panel-inner">
                <div class="offline-reciters__list"></div>
                <div class="offline-reciters__foot"></div>
              </div>
            </div>
          </div>
        </div>
      </div>`,document.body.appendChild(e),l=e,e.addEventListener("click",ye),e}function $(e){const n=F().find(t=>t.id===e);n&&(X(n,b(e)?{status:"done"}:{status:"idle"}),K())}function we(e){const n=e.target.closest("[data-reciter-toggle]");if(n){const i=n.dataset.reciterToggle;return b(i)?void 0:(f.has(i)?f.delete(i):f.add(i),$(i),!0)}const t=e.target.closest("[data-reciter-act]");if(!t)return!1;const s=t.dataset.reciterAct,a=t.dataset.reciterId;if(s==="download"){const i=[...f].filter(r=>!b(r));return i.length&&(f.clear(),O(i)),!0}return s==="download-one"?(O([a]),!0):s==="delete"?(v[a]="delete",$(a),!0):s==="delete-cancel"?(delete v[a],$(a),!0):s==="delete-confirm"?(delete v[a],ve(a).then(()=>$(a)),!0):!1}function ye(e){if(e.target.closest("[data-offline-close]")){Z();return}const t=e.target.closest("[data-acc-toggle]");if(t){const r=t.closest(".t-acc"),o=r?.getAttribute("data-open")==="true";r?.setAttribute("data-open",o?"false":"true"),r?.querySelector(".t-acc-head")?.setAttribute("aria-expanded",o?"false":"true");return}if(we(e))return;const s=e.target.closest("[data-offline-act]");if(!s)return;const a=s.dataset.offlineAct,i=s.dataset.offlineRow;if(!(!i||!p[i])){if(a==="download"){u[i]=null,p[i].startDownload();return}if(a==="delete"){u[i]="delete",_(i,i==="mushaf"?T()?{status:"done"}:{status:"idle"}:B()?{status:"done"}:{status:"idle"});return}if(a==="delete-cancel"){u[i]=null,_(i,i==="mushaf"?T()?{status:"done"}:{status:"idle"}:B()?{status:"done"}:{status:"idle"});return}if(a==="delete-confirm"){u[i]=null,p[i].deleteCache().then(()=>{_(i,{status:"idle"})});return}}}function Y(e){e.key==="Escape"&&E&&Z()}function $e(){me(),E=!0,l.offsetWidth,l.classList.add("offline-sheet--open"),l.setAttribute("aria-hidden","false"),document.body.classList.add("offline-sheet-open"),ge(),I=se(e=>_("mushaf",e)),H=ie(e=>_("tafsir",e)),q=ue(e=>G(e)),pe().then(()=>{if(E){for(const e in g)delete g[e];G(null)}}),document.addEventListener("keydown",Y)}function Z(){E=!1,l&&(l.classList.remove("offline-sheet--open"),l.setAttribute("aria-hidden","true")),document.body.classList.remove("offline-sheet-open"),I?.(),I=null,H?.(),H=null,q?.(),q=null,document.removeEventListener("keydown",Y),u.mushaf=null,u.tafsir=null,f.clear();for(const n in v)delete v[n];for(const n in g)delete g[n];const e=w;w=null,e&&e()}const Se='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',Ee='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>';function Me(){const e=l?.querySelector(".offline-sheet__close");e&&(e.innerHTML=w?Se:Ee,e.setAttribute("aria-label",w?"العودة إلى الإعدادات":"إغلاق"))}function Ce(e){w=e?.onBack||null,$e(),Me()}const M=5e3,xe=[{value:"suggestion",label:"اقتراح"},{value:"bug",label:"خطأ / مشكلة"},{value:"other",label:"أخرى"}];let c=null,z=!1,A=!1,y=null;function Le(){if(document.getElementById("offlinePanelFont"))return;const e=document.createElement("link");e.id="offlinePanelFont",e.rel="stylesheet",e.href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap",document.head.appendChild(e)}function Ae(){return`
      <form class="feedback-form" novalidate>
        <label class="feedback-field">
          <span class="feedback-label">نوع الملاحظة</span>
          <select class="feedback-input" name="category">${xe.map((n,t)=>`<option value="${n.value}"${t===0?" selected":""}>${n.label}</option>`).join("")}</select>
        </label>
        <label class="feedback-field">
          <span class="feedback-label">رسالتك</span>
          <textarea class="feedback-input feedback-textarea" name="message" rows="4" maxlength="${M}" placeholder="اكتب ملاحظتك هنا..." required></textarea>
          <span class="feedback-counter" aria-live="polite">0 / ${M}</span>
        </label>
        <label class="feedback-field">
          <span class="feedback-label">البريد الإلكتروني <span class="feedback-optional">(اختياري)</span></span>
          <input class="feedback-input" type="email" name="email" autocomplete="email" placeholder="ضع ايميلك هنا..." />
        </label>
        <div class="feedback-honeypot" aria-hidden="true">
          <label>Website</label>
          <input type="text" name="website" tabindex="-1" autocomplete="off" />
        </div>
        <button type="submit" class="offline-btn offline-btn--primary feedback-submit">إرسال</button>
        <div class="feedback-status" role="status" aria-live="polite"></div>
      </form>`}function h(e,n,t){const s=e.querySelector(".feedback-status");if(s){if(!n){s.className="feedback-status",s.textContent="";return}s.className=`feedback-status feedback-status--${n}`,s.textContent=t||""}}function Te(e){const n=e.querySelector(".feedback-form");if(!n)return;const t=n.querySelector("textarea[name=message]"),s=n.querySelector(".feedback-counter");if(t&&s){const a=()=>{s.textContent=`${t.value.length} / ${M}`};t.addEventListener("input",a),a()}n.addEventListener("submit",a=>{a.preventDefault(),Be(n)})}async function Be(e){if(A||!D())return;const n=e.querySelector("select[name=category]")?.value||"other",t=(e.querySelector("textarea[name=message]")?.value||"").trim(),s=(e.querySelector("input[name=email]")?.value||"").trim(),a=e.querySelector("input[name=website]")?.value||"";if(!t){h(e,"err","اكتب رسالتك أولًا"),e.querySelector("textarea[name=message]")?.focus();return}const i=e.querySelector(".feedback-submit");A=!0,i&&(i.disabled=!0,i.dataset.originalText=i.dataset.originalText||i.textContent,i.textContent="جارٍ الإرسال..."),h(e,"info","جارٍ الإرسال...");try{const r=await fetch(`${fe}/feedback`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({category:n,message:t,email:s,source:"app",hp:a})});let o=null;try{o=await r.json()}catch{o=null}if(r.ok&&o&&o.ok===!0){e.reset();const m=e.querySelector(".feedback-counter");m&&(m.textContent=`0 / ${M}`),h(e,"ok","تم إرسال رسالتك، شكرًا لك")}else r.status===429?h(e,"err","حاول مرة أخرى بعد قليل"):h(e,"err","تعذّر الإرسال، حاول مرة أخرى")}catch{h(e,"err","تعذّر الإرسال، حاول مرة أخرى")}finally{A=!1,i&&(i.disabled=!1,i.textContent=i.dataset.originalText||"إرسال")}}function Re(){if(c)return c;Le();const e=document.createElement("div");return e.id="feedbackSheet",e.className="offline-sheet offline-sheet--smooth",e.setAttribute("aria-hidden","true"),e.innerHTML=`
      <div class="offline-sheet__backdrop" data-feedback-close></div>
      <div class="offline-sheet__card" role="dialog" aria-modal="true" aria-labelledby="feedbackSheetTitle">
        <button type="button" class="offline-sheet__close" data-feedback-close aria-label="إغلاق">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
        <div class="offline-sheet__head">
          <div class="offline-sheet__icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z"/></svg>
          </div>
          <h2 id="feedbackSheetTitle" class="offline-sheet__title">إرسال ملاحظة</h2>
          <p class="offline-sheet__desc">رأيك أو بلاغك يصلني مباشرة.</p>
        </div>
        ${Ae()}
      </div>`,document.body.appendChild(e),c=e,e.addEventListener("click",n=>{n.target.closest("[data-feedback-close]")&&te()}),Te(e),e}function ee(e){e.key==="Escape"&&z&&te()}function Ie(){Re(),z=!0,c.offsetWidth,c.classList.add("offline-sheet--open"),c.setAttribute("aria-hidden","false"),document.body.classList.add("offline-sheet-open");const e=c.querySelector(".feedback-form");e&&h(e,null),document.addEventListener("keydown",ee)}function te(){z=!1,c&&(c.classList.remove("offline-sheet--open"),c.setAttribute("aria-hidden","true")),document.body.classList.remove("offline-sheet-open"),document.removeEventListener("keydown",ee);const e=y;y=null,e&&e()}const He='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',qe='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>';function je(){const e=c?.querySelector(".offline-sheet__close");e&&(e.innerHTML=y?He:qe,e.setAttribute("aria-label",y?"العودة إلى الإعدادات":"إغلاق"))}function Ne(e){D()&&(y=e?.onBack||null,Ie(),je())}let d=null,S=null,L=!1,C=null;const k={cloud:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.25 15a4.5 4.5 0 004.5 4.5H18a3.75 3.75 0 001.332-7.257 3 3 0 00-3.758-3.848 5.25 5.25 0 00-10.233 2.33A4.502 4.502 0 002.25 15z"/><path d="M12 10.5v6m0 0l-2.25-2.25M12 16.5l2.25-2.25"/></svg>',chat:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z"/></svg>',moon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',gear:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9 1.65 1.65 0 0 0 4.27 7.18l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',chevron:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',close:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>'};function De(){if(document.getElementById("offlinePanelFont"))return;const e=document.createElement("link");e.id="offlinePanelFont",e.rel="stylesheet",e.href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap",document.head.appendChild(e)}function W(e,n,t,s,a=""){return`
      <button type="button" class="settings-row settings-row--link" data-settings-act="${e}">
        <span class="settings-row__icon${a}">${n}</span>
        <span class="settings-row__text">
          <span class="settings-row__title">${t}</span>
          <span class="settings-row__desc">${s}</span>
        </span>
        <span class="settings-row__chevron">${k.chevron}</span>
      </button>`}function Fe(e,n,t,s,a=""){return`
      <button type="button" class="settings-row settings-row--toggle" role="switch" aria-checked="false" data-settings-toggle="${e}">
        <span class="settings-row__icon${a}">${n}</span>
        <span class="settings-row__text">
          <span class="settings-row__title">${t}</span>
          <span class="settings-row__desc">${s}</span>
        </span>
        <span class="settings-switch" aria-hidden="true"><span class="settings-switch__thumb"></span></span>
      </button>`}function ze(){if(d)return d;De();const e=document.createElement("div");return e.id="settingsSheet",e.className="offline-sheet offline-sheet--smooth",e.setAttribute("aria-hidden","true"),e.innerHTML=`
      <div class="offline-sheet__backdrop" data-settings-close></div>
      <div class="offline-sheet__card" role="dialog" aria-modal="true" aria-labelledby="settingsSheetTitle">
        <button type="button" class="offline-sheet__close" data-settings-close aria-label="إغلاق">${k.close}</button>
        <div class="offline-sheet__head">
          <div class="offline-sheet__icon" aria-hidden="true">${k.gear}</div>
          <h2 id="settingsSheetTitle" class="offline-sheet__title">الإعدادات</h2>
          <p class="offline-sheet__desc">التحميل بدون إنترنت، ملاحظاتك، وخيارات العرض.</p>
        </div>
        <div class="settings-list">
          ${W("offline",k.cloud,"التحميل للاستخدام بدون إنترنت","المصحف والتفاسير على جهازك.")}
          ${W("feedback",k.chat,"إرسال ملاحظة","رأيك أو بلاغك يصلني مباشرة.")}
          ${Fe("dark",k.moon,"الوضع الليلي","مظهر داكن مريح للقراءة ليلًا.")}
        </div>
      </div>`,document.body.appendChild(e),d=e,e.addEventListener("click",Oe),e}function Pe(){if(!d)return;const e=d.querySelector('[data-settings-toggle="dark"]');e&&e.setAttribute("aria-checked",String(!!C?.isDark?.()))}function Oe(e){if(e.target.closest("[data-settings-close]")){x();return}const n=e.target.closest("[data-settings-act]");if(n){const s=n.dataset.settingsAct;x(),s==="offline"?Ce({onBack:N}):s==="feedback"&&Ne({onBack:N});return}const t=e.target.closest("[data-settings-toggle]");t&&t.dataset.settingsToggle==="dark"&&(C?.toggleDark?.(),t.setAttribute("aria-checked",String(!!C?.isDark?.())))}function ne(e){e.key==="Escape"&&L&&x()}function N(){ze(),L=!0,Pe(),d.offsetWidth,d.classList.add("offline-sheet--open"),d.setAttribute("aria-hidden","false"),document.body.classList.add("offline-sheet-open"),document.addEventListener("keydown",ne)}function x(){L=!1,d&&(d.classList.remove("offline-sheet--open"),d.setAttribute("aria-hidden","true")),document.body.classList.remove("offline-sheet-open"),document.removeEventListener("keydown",ne)}function Ve(e){D()&&(C=e||{},S=document.getElementById("settingsMenuBtn"),S&&(S.style.display="",S.addEventListener("click",()=>{L?x():N()})))}export{Ve as initSettingsPanel};
