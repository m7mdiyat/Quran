import{j as h,A as y}from"./index-KqF0QFAN.js";const d=5e3,v=[{value:"suggestion",label:"اقتراح"},{value:"bug",label:"خطأ / مشكلة"},{value:"other",label:"أخرى"}];let l=null,r=null,u=!1,b=!1;function g(){if(document.getElementById("offlinePanelFont"))return;const e=document.createElement("link");e.id="offlinePanelFont",e.rel="stylesheet",e.href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap",document.head.appendChild(e)}function S(){return`
      <form class="feedback-form" novalidate>
        <label class="feedback-field">
          <span class="feedback-label">نوع الملاحظة</span>
          <select class="feedback-input" name="category">${v.map((t,a)=>`<option value="${t.value}"${a===0?" selected":""}>${t.label}</option>`).join("")}</select>
        </label>
        <label class="feedback-field">
          <span class="feedback-label">رسالتك</span>
          <textarea class="feedback-input feedback-textarea" name="message" rows="4" maxlength="${d}" placeholder="اكتب ملاحظتك هنا..." required></textarea>
          <span class="feedback-counter" aria-live="polite">0 / ${d}</span>
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
      </form>`}function i(e,t,a){const n=e.querySelector(".feedback-status");if(n){if(!t){n.className="feedback-status",n.textContent="";return}n.className=`feedback-status feedback-status--${t}`,n.textContent=a||""}}function x(e){const t=e.querySelector(".feedback-form");if(!t)return;const a=t.querySelector("textarea[name=message]"),n=t.querySelector(".feedback-counter");if(a&&n){const o=()=>{n.textContent=`${a.value.length} / ${d}`};a.addEventListener("input",o),o()}t.addEventListener("submit",o=>{o.preventDefault(),E(t)})}async function E(e){if(b||!h())return;const t=e.querySelector("select[name=category]")?.value||"other",a=(e.querySelector("textarea[name=message]")?.value||"").trim(),n=(e.querySelector("input[name=email]")?.value||"").trim(),o=e.querySelector("input[name=website]")?.value||"";if(!a){i(e,"err","اكتب رسالتك أولًا"),e.querySelector("textarea[name=message]")?.focus();return}const s=e.querySelector(".feedback-submit");b=!0,s&&(s.disabled=!0,s.dataset.originalText=s.dataset.originalText||s.textContent,s.textContent="جارٍ الإرسال..."),i(e,"info","جارٍ الإرسال...");try{const f=await fetch(`${y}/feedback`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({category:t,message:a,email:n,source:"app",hp:o})});let c=null;try{c=await f.json()}catch{c=null}if(f.ok&&c&&c.ok===!0){e.reset();const m=e.querySelector(".feedback-counter");m&&(m.textContent=`0 / ${d}`),i(e,"ok","تم إرسال رسالتك، شكرًا لك")}else f.status===429?i(e,"err","حاول مرة أخرى بعد قليل"):i(e,"err","تعذّر الإرسال، حاول مرة أخرى")}catch{i(e,"err","تعذّر الإرسال، حاول مرة أخرى")}finally{b=!1,s&&(s.disabled=!1,s.textContent=s.dataset.originalText||"إرسال")}}function _(){if(l)return l;g();const e=document.createElement("div");return e.id="feedbackSheet",e.className="offline-sheet",e.setAttribute("aria-hidden","true"),e.innerHTML=`
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
        ${S()}
      </div>`,document.body.appendChild(e),l=e,e.addEventListener("click",t=>{t.target.closest("[data-feedback-close]")&&p()}),x(e),e}function k(e){e.key==="Escape"&&u&&p()}function C(){_(),u=!0,l.classList.add("offline-sheet--open"),l.setAttribute("aria-hidden","false"),document.body.classList.add("offline-sheet-open");const e=l.querySelector(".feedback-form");e&&i(e,null),document.addEventListener("keydown",k)}function p(){u=!1,l&&(l.classList.remove("offline-sheet--open"),l.setAttribute("aria-hidden","true")),document.body.classList.remove("offline-sheet-open"),document.removeEventListener("keydown",k)}function T(){h()&&(r=document.getElementById("feedbackMenuBtn"),r&&(r.style.display="",r.addEventListener("click",()=>{u?p():C()})))}export{T as initFeedbackPanel};
