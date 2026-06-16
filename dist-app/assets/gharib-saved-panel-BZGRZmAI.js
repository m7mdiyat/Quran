import{j as b,k as l,l as m,m as _,n as y,o as M,p as k}from"./index-Dc8giRqb.js";let a=null,d=null,o=!1,s=!1;const w=()=>{try{return window.matchMedia("(prefers-reduced-motion: reduce)").matches}catch{return!1}},L=`
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M10.7 3.2a1.55 1.55 0 0 1 2.6 0"/>
    <path d="M9.1 6.6c.3-1.7 1.4-2.6 2.9-2.6s2.6.9 2.9 2.6"/>
    <path d="M8.3 6.6h7.4"/>
    <path d="M9.2 6.6l-.5 7.2a1.3 1.3 0 0 0 1.3 1.4h4a1.3 1.3 0 0 0 1.3-1.4l-.5-7.2"/>
    <path class="gharib-saved-btn__flame" d="M12.4 7.4c-1.4 1.7-2.4 2.9-2.4 4.4a2 2 0 0 0 4 0c0-1-.4-1.9-1-2.9.2.7.1 1.2-.2 1.6.5-1.2.3-2.3-.4-3.1z"/>
    <path d="M10.4 15.2l-.6 2.9M13.6 15.2l.6 2.9"/>
    <path d="M9.6 18.1h4.8"/>
  </svg>`,S='<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3c2.6 3.1 4.4 5.5 4.4 8.6a4.4 4.4 0 0 1-8.8 0c0-1.2.4-2.3 1.1-3.4.4.6.9 1 1.6 1.1C9.6 7.6 10 5.2 12 3z"/></svg>',H='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7"/><path d="M10 11v6M14 11v6"/></svg>';function T(e){const t=Number(e).toLocaleString("ar-EG");return e===1?"كلمة واحدة":e===2?"كلمتان":e>=3&&e<=10?`${t} كلمات`:`${t} كلمة`}function E(){if(document.getElementById("offlinePanelFont"))return;const e=document.createElement("link");e.id="offlinePanelFont",e.rel="stylesheet",e.href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap",document.head.appendChild(e)}function u(e=""){return String(e).replace(/[&<>"']/g,t=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[t])}function x(e){return String(e).replace(/\.{2,}|…/g," … ").replace(/\s+/g," ").trim()}function B(){if(a)return a;E();const e=document.createElement("div");return e.id="gharibSavedSheet",e.className="offline-sheet",e.setAttribute("aria-hidden","true"),e.innerHTML=`
      <div class="offline-sheet__backdrop" data-gh-close></div>
      <div class="offline-sheet__card" role="dialog" aria-modal="true" aria-labelledby="gharibSavedTitle">
        <button type="button" class="offline-sheet__close" data-gh-close aria-label="إغلاق">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
        <div class="offline-sheet__head">
          <div class="offline-sheet__icon" aria-hidden="true">${L}</div>
          <h2 id="gharibSavedTitle" class="offline-sheet__title">غريب القرآن</h2>
          <p class="offline-sheet__desc">ستجد في هذه القائمة حصيلتك من ألفاظ القرآن التي تعلمتها من خانة <span class="gharib-saved-tadabbur">تدبّر</span></p>
          <div class="gharib-saved-meta" data-gh-meta></div>
        </div>
        <div class="gharib-saved-list" data-gh-list></div>
      </div>`,document.body.appendChild(e),a=e,e.addEventListener("click",A),e}function h(){return""}function C(e){const t=u(x(e.w)),n=e.m?u(M(e.m)):"";return`
      <div class="gharib-saved-row" data-gh-row data-key="${u(e.key)}">
        <div class="gharib-saved-row__gloss">
          <span class="gharib-saved-row__word">${t}</span>
          ${n?`<span class="gharib-saved-row__sep" aria-hidden="true">›</span><span class="gharib-saved-row__meaning">${n}</span>`:""}
        </div>
        <button type="button" class="gharib-saved-row__remove" data-gh-remove aria-label="إزالة الكلمة">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
      </div>`}function i(e){const t=a?.querySelector("[data-gh-meta]");if(t){if(e<=0){t.innerHTML="",s=!1;return}if(s){t.innerHTML=`
          <div class="gharib-saved-confirm">
            <span class="gharib-saved-confirm__text">مسح كل الكلمات المحفوظة؟</span>
            <div class="gharib-saved-confirm__actions">
              <button type="button" class="offline-btn offline-btn--danger" data-gh-reset-confirm>نعم، امسح الكل</button>
              <button type="button" class="offline-btn offline-btn--ghost" data-gh-reset-cancel>إلغاء</button>
            </div>
          </div>`;return}t.innerHTML=`
      <span class="gharib-saved-count">${S}<span>${T(e)}</span></span>
      <button type="button" class="gharib-saved-reset" data-gh-reset aria-label="مسح كل الكلمات">
        ${H}<span>مسح الكل</span>
      </button>`}}async function v(){if(!a)return;const e=a.querySelector("[data-gh-list]");if(!e)return;if(l()===0){e.innerHTML=h(),i(0);return}if(e.innerHTML='<div class="gharib-saved-loading">…جارٍ جمع كلماتك</div>',await m(),!o)return;const t=_();i(t.length),e.innerHTML=t.length?t.map(C).join(""):h()}function $(e,t){if(!k(t)){e.remove();return}i(l());const n=()=>{e.remove();const r=a?.querySelector("[data-gh-list]");r&&!r.querySelector(".gharib-saved-row")&&(r.innerHTML=h())};if(w()){n();return}e.style.maxHeight=`${e.scrollHeight}px`,e.offsetHeight,e.classList.add("gharib-saved-row--removing");let g=!1;const c=r=>{r&&r.target!==e||g||(g=!0,e.removeEventListener("transitionend",c),n())};e.addEventListener("transitionend",c),setTimeout(c,420)}function A(e){if(e.target.closest("[data-gh-close]")){f();return}if(e.target.closest("[data-gh-reset]")){s=!0,i(l());return}if(e.target.closest("[data-gh-reset-cancel]")){s=!1,i(l());return}if(e.target.closest("[data-gh-reset-confirm]")){y(),s=!1,v();return}const t=e.target.closest("[data-gh-remove]");if(t){const n=t.closest("[data-gh-row]");n&&$(n,n.dataset.key)}}function p(e){e.key==="Escape"&&o&&f()}function P(){B(),o=!0,s=!1,a.classList.add("offline-sheet--open"),a.setAttribute("aria-hidden","false"),document.body.classList.add("offline-sheet-open"),v(),document.addEventListener("keydown",p)}function f(){o=!1,a&&(a.classList.remove("offline-sheet--open"),a.setAttribute("aria-hidden","true")),document.body.classList.remove("offline-sheet-open"),document.removeEventListener("keydown",p)}function F(){b()&&(d=document.getElementById("gharibSavedBtn"),d&&(d.style.display="",d.addEventListener("click",()=>{o?f():P()})))}export{F as initGharibSavedPanel};
